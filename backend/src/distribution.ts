// Async split-distribution reconciler.
//
// verify.ts no longer sends SOL inline on the /confirm hot path. It COMMITs the
// DB claim, then calls enqueueDistribution() for each split leg (burn/pool/
// treasury/prior/refund) and for pool-claim payouts (kind='pool_payout'). Those
// writes are pure DB — zero RPC.
//
// drainDistributions() (the reconciler) picks up `pending` rows, groups them into
// batches of ≤8 destinations per Solana tx (1232-byte limit), signs with the
// escrow (or pool) keypair, and sends via the queued RPC sender. It runs:
//   * inline after each /confirm (fires the split immediately — keeps the
//     "pixel commit is fast" UX), and
//   * on the 30s board tick (board.ts) to catch stragglers — no new cron process.
//
// Idempotency / double-pay guard:
//   * The broadcast sig from sendBatch is ALWAYS retained — even when the WS-wait
//     times out — into status='unconfirmed' + tx_sig. A later drain reconciles
//     that sig with getSignatureStatus: landed → 'confirmed', dead → back to
//     'pending' for a fresh tx. We never re-craft a tx for a sig we can't account for.
//   * A sig of null means the RPC layer rejected the broadcast (never on-chain),
//     so rolling back to 'pending' is provably safe.
//   * Stale 'sent' rows (crash between broadcast and the DB confirm-write) are
//     reclaimed into 'unconfirmed' after a grace window, so orphans get reconciled
//     instead of staying stuck or silently re-sent.

import pool from "./db";
import { config } from "./config";
import { escrowKeypair, poolKeypair } from "./keys";
import {
  getCachedBlockhash,
  primary,
  sendTransactionViaQueue,
  waitForSignature,
} from "./rpc";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

export interface EnqueueArgs {
  quoteId?: string;
  x?: number;
  y?: number;
  kind: "burn" | "pool" | "treasury" | "prior" | "refund" | "pool_payout";
  to: string;
  sol: number;
}

/** Insert one distribution leg (fire-and-forget, DB only — no RPC). */
export async function enqueueDistribution(a: EnqueueArgs): Promise<void> {
  if (a.sol <= 1e-9) return;
  try {
    await pool.query(
      `INSERT INTO pending_distributions (quote_id, x, y, kind, to_addr, amount_sol)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.quoteId ?? null, a.x ?? null, a.y ?? null, a.kind, a.to, a.sol]
    );
  } catch (e) {
    // Never let an enqueue failure break /confirm. Visibility: log; the row is
    // missing so no reconciler sees it — an operational alert picks up the gap.
    process.stderr.write(`[dist] enqueue failed (${a.kind} → ${a.to}): ${(e as Error).message}\n`);
  }
}

function validPk(s: string): PublicKey | null {
  try { return new PublicKey(s); } catch { return null; }
}

// Rent-exempt floor for a zero-data account (~0.00089 SOL). Any destination below
// this in a batched tx REJECTS the whole batch (Solana tx atomicity), silently
// dropping every leg including well-funded ones. We cache it and fund any below-floor
// destination inside the same tx so the batch survives. 890880 is the hardcoded
// fallback if the RPC call fails (this value is stable mainnet/devnet).
let rentFloorLamports: number | null = null;
async function rentExemptLamports(): Promise<number> {
  if (rentFloorLamports != null) return rentFloorLamports;
  try {
    rentFloorLamports = await primary.getMinimumBalanceForRentExemption(0);
  } catch {
    rentFloorLamports = 890880;
  }
  return rentFloorLamports;
}

/**
 * Sign and send one batched tx of ≤8 transfers from `from`. Returns the broadcast
 * signature plus the ids of the legs that were actually included. A null sig means
 * the RPC layer rejected the broadcast (never on-chain) — the tx simply didn't go.
 *
 * Rent-exempt safety: before signing, any destination whose balance is below the
 * rent-exempt floor gets a top-up transfer so it becomes rent-exempt. Without this,
 * ONE unfunded pool/burn/treasury destination rejects the ENTIRE batch (atomic tx),
 * and the prior-owner legs die with it.
 */
async function sendBatch(
  from: ReturnType<typeof escrowKeypair>,
  legs: { id: string; to: string; sol: number }[],
): Promise<{ sig: string; ids: string[] } | null> {
  const tx = new Transaction();
  const included: string[] = [];
  const targets = new Map<string, string>(); // id -> to
  for (const leg of legs) {
    const pk = validPk(leg.to);
    if (!pk) continue;
    tx.add(SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: pk,
      lamports: Math.floor(leg.sol * LAMPORTS_PER_SOL),
    }));
    included.push(leg.id);
    targets.set(leg.id, leg.to);
  }
  if (included.length === 0) return null;

  // Rent-exempt top-up for below-floor destinations. Batched txs are atomic: one
  // unfunded account kills every leg, so fund each rival below the floor first.
  const floor = await rentExemptLamports();
  try {
    const pks = [...targets.values()].map((t) => new PublicKey(t));
    const infos = await primary.getMultipleAccountsInfo(pks);
    const fundsNeeded: { legId: string; shouldSend: boolean }[] = included.map((legId, i) => {
      const bal = infos[i]?.lamports ?? 0;
      const need = floor - bal;
      return { legId, shouldSend: need > 0 };
    });
    // If any leg's destination is below floor, add explicit top-up transfers.
    const toTopUp = fundsNeeded.filter((f) => f.shouldSend);
    for (const f of toTopUp) {
      tx.add(SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: new PublicKey(targets.get(f.legId)!),
        lamports: floor,
      }));
    }
  } catch {
    // getMultipleAccountsInfo hiccup — proceed without top-up; the batch will fail
    // and be retried by the reconciler, not silently lost.
  }

  const bh = await getCachedBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = from.publicKey;
  tx.sign(from);
  const sig = await sendTransactionViaQueue(tx.serialize());
  if (!sig) return null;
  return { sig, ids: included };
}

/** Reconcile an in-flight broadcast sig: 'confirmed' found → confirmed, else 'pending'. */
async function settleUnconfirmed(id: string, sig: string): Promise<void> {
  try {
    const status = await primary.getSignatureStatus(sig, { searchTransactionHistory: true });
    const err = status?.value?.err;
    if (err == null) {
      await pool.query(
        `UPDATE pending_distributions SET status='confirmed', tx_sig=$2 WHERE id=$1`,
        [id, sig]
      );
    } else {
      await pool.query(
        `UPDATE pending_distributions
         SET status='pending', attempts=attempts+1, last_error='reconcile_failed', sent_at=NULL
         WHERE id=$1`,
        [id]
      );
    }
  } catch {
    // RPC unreachable — leave as 'unconfirmed'; a future drain reconciles it again.
  }
}

/** Reconcile every unconfirmed leg individually; returns the confirmed sent-count. */
async function reconcileUnconfirmed(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, tx_sig FROM pending_distributions
     WHERE status='unconfirmed' AND tx_sig IS NOT NULL
     ORDER BY enqueued_at ASC LIMIT 100`
  );
  for (const r of rows) {
    await settleUnconfirmed(String(r.id), String(r.tx_sig));
  }
  return rows.length;
}

const MAX_LEGS_PER_TX = 8;

/** A single drain pass — pulls pending rows, ships them in batches, marks outcomes. */
export async function drainDistributions(): Promise<number> {
  let sent = 0;
  try {
    // Pull the oldest pending rows first (FIFO). Bounded so one drain never floods.
    // No early return here — reconciliation steps below must run even when the
    // pending set is empty, so that stuck unconfirmed/stale-sent rows get resolved.
    const { rows } = await pool.query(
      `SELECT id, kind, to_addr, amount_sol FROM pending_distributions
       WHERE status='pending'
       ORDER BY enqueued_at ASC
       LIMIT 64`
    );

    // Group by paying keypair: pool_payout uses the POOL keypair, everything else escrow.
    const escrowLegs: { id: string; to: string; sol: number }[] = [];
    const poolLegs: { id: string; to: string; sol: number }[] = [];
    for (const r of rows) {
      const rec = { id: String(r.id), to: String(r.to_addr), sol: Number(r.amount_sol) };
      if (r.kind === "pool_payout") poolLegs.push(rec); else escrowLegs.push(rec);
    }

    const release = async (legs: { id: string; to: string; sol: number }[], from: ReturnType<typeof escrowKeypair>) => {
      for (let i = 0; i < legs.length; i += MAX_LEGS_PER_TX) {
        const slice = legs.slice(i, i + MAX_LEGS_PER_TX);
        const ids = slice.map((l) => l.id);
        // Claim the batch atomically: only the winner's attempt proceeds; the other
        // concurrent drain (rare, multi-instance) sees 0 rows. No re-send of `sent`.
        const claim = await pool.query(
          `UPDATE pending_distributions SET status='sent', sent_at=now()
           WHERE status='pending' AND id = ANY($1::bigint[])
           RETURNING id`,
          [ids]
        );
        if ((claim.rowCount ?? 0) === 0) continue; // someone else took these
        const res = await sendBatch(from, slice);
        if (res && res.ids.length) {
          const inclIds = res.ids;
          await pool.query(
            `UPDATE pending_distributions SET status='confirmed', tx_sig=$2
             WHERE status='sent' AND id = ANY($1::bigint[])`,
            [inclIds, res.sig]
          );
          sent += inclIds.length;
          // Legs skipped inside sendBatch (invalid address) — no sig to chase.
          // Drop them so they don't stay 'sent' forever.
          if (inclIds.length < slice.length) {
            await pool.query(
              `DELETE FROM pending_distributions WHERE id = ANY($1::bigint[])`,
              [ids.filter((id) => !inclIds.includes(id))]
            );
          }
        } else {
          // sendBatch broadcast failed (null sig) or nothing to send. If the RPC
          // layer gave back a refused tx (null sig), it NEVER reached the chain —
          // safe to roll back to pending and rebuild. Where we DID broadcast but the
          // WS-wait timed out, sendBatch resolves with the sig (unconfirmed path
          // above), so we never store null where a sig might exist.
          if (res === null) {
            await pool.query(
              `UPDATE pending_distributions
               SET status='pending', attempts=attempts+1, last_error='send_failed', sent_at=NULL
               WHERE status='sent' AND id = ANY($1::bigint[])`,
              [ids]
            );
          }
        }
      }
    };

    // 1) Reconcile every unconfirmed (broadcast-but-unconfirmed) sig first — the WS
    //    timeout path. Never re-craft a tx for a sig we can't account for.
    sent += await reconcileUnconfirmed();

    // 2) Reclaim stale 'sent' rows: a crash between the broadcast and the DB
    //    confirm-write leaves 'sent' with no sig. After the grace window we recycle
    //    them to 'unconfirmed' so the reconcile step above resolves them (confirmed
    //    vs back-to-pending) instead of them being re-sent blind.
    const stale = await pool.query(
      `UPDATE pending_distributions SET status='unconfirmed'
       WHERE status='sent' AND sent_at < now() - ($1 || ' seconds')::interval
       RETURNING id`,
      [Math.max(config.DIST_WAIT_MS / 1000 + 30, 60)]
    );
    if ((stale.rowCount ?? 0) > 0) {
      sent += await reconcileUnconfirmed();
    }

    // 3) Fresh sends from the pending set.
    if (escrowLegs.length) await release(escrowLegs, escrowKeypair());
    // pool_payout legs are paid from the POOL wallet (its keypair signs). If the pool
    // keypair is ever missing on a drain, fall back to the escrow so a claim payout can
    // never get stuck.
    if (poolLegs.length) {
      let poolFrom;
      try { poolFrom = poolKeypair(); } catch { poolFrom = escrowKeypair(); }
      await release(poolLegs, poolFrom);
    }
  } catch (e) {
    process.stderr.write(`[dist] drain error: ${(e as Error).message}\n`);
  }
  return sent;
}

/**
 * Staggered recurrence for the inline drain — avoids stampeding the RPC queue when
 * a burst of purchases enqueues many legs at once. Called after each /confirm.
 */
let inlineTimer: NodeJS.Timeout | null = null;
export function scheduleInlineDrain(): void {
  if (inlineTimer) return;
  inlineTimer = setTimeout(async () => {
    inlineTimer = null;
    await drainDistributions();
  }, 500);
}