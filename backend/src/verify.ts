import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import pool from "./db";
import { config } from "./config";
import { ensureBoard, logEvent } from "./board";
import { priceForCell, decayedMult, dropProb, maxPerPerson } from "./pricing";
import { SYMBOLS, type Symbol } from "./symbols";
import { bumpCache } from "./memStore";
import { primary as conn, waitForSignature } from "./rpc"; // single shared Connection (RPC_REDUX)
import { enqueueDistribution, scheduleInlineDrain } from "./distribution";
import { escrowKeypair } from "./keys";

const ConfirmSchema = z.object({
  quoteId: z.string().uuid(),
  txSig: z.string().min(32).max(128),
});

// --- txSig parse cache (launch hardening) -----------------------------------
// /confirm is called twice per purchase (client confirm + retry paths). getParsedTransaction
// is the single most expensive Helius call (full CU decode), and hitting it twice for the
// SAME tx is pure waste. Cache the parsed tx by signature for CONFIRM_CACHE_TTL_MS — a
// duplicate /confirm (exact retry) then re-validates + re-claims against the cached parse
// instead of re-billing the RPC. The DB atomic claim makes re-claim safe (second one is a
// no-op/refund path). A short TTL is plenty: the memo/transfer lives on a finalized tx.
const CONFIRM_CACHE_TTL_MS = 30_000;
const confirmCache = new Map<string, { tx: any; at: number }>();

function cachedTx(txSig: string): any | undefined {
  const hit = confirmCache.get(txSig);
  if (hit && Date.now() - hit.at < CONFIRM_CACHE_TTL_MS) return hit.tx;
  if (hit) confirmCache.delete(txSig);
  return undefined;
}

/**
 * Escrow confirm flow (V2.1).
 * 1) read the intent (quoteId→x,y,buyer)
 * 2) parse tx, verify SOL to the escrow + memo=quoteId, fee-payer=buyer
 * 3) is_gold rejection
 * 4) ATOMIC claim: cells INSERT ON CONFLICT — one winner. Loser gets refunded.
 * 5) Split:
 *    - Empty: 70% dead / 20% pool / 10% treasury
 *    - Gasp: 60% prior / 20% pool / 10% dead / 10% treasury
 *    - Pool share split into 3 by weight (small/mid/big).
 * 6) Nuke drop RNG (guarded: nuke_config.available>0 + owner<max)
 * 7) mult ×2 (cap MULT_CAP); a gasp reaching the cap sets is_gold=true
 * 8) events + purchases + intents cleanup, distribution from escrow
 */
export async function registerConfirmRoutes(app: FastifyInstance): Promise<void> {
  app.post("/confirm", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const res = await confirmPurchase({ quoteId: parsed.data.quoteId, txSig: parsed.data.txSig });
    return reply.code(res.code).send(res.body);
  });
}

export async function confirmPurchase(payload: { quoteId: string; txSig: string }): Promise<any> {
  const { quoteId, txSig } = payload;

  const intentRows = await pool.query(
    `SELECT quote_id, x, y, owner AS buyer FROM intents WHERE quote_id=$1`,
    [quoteId]
  );
  if (intentRows.rows.length === 0) {
    return { code: 404, body: { error: "intent_not_found", message: "Quote/intent not found." } };
  }
  const { x, y, buyer } = intentRows.rows[0];

  // tx parse
  let tx = cachedTx(txSig);
  try {
    if (!tx) {
      // The client sends /confirm immediately after `sendTransaction` submits (no client
      // confirmTransaction — "backend is truth"). The tx may not be indexed by the RPC yet,
      // so first wait via WebSocket `signatureSubscribe` (NOT billed against RPS). If the
      // WS doesn't fire in time (timeout), fall back to a bounded HTTP getParsedTransaction
      // anyway — the tx may still have landed. Only if it truly isn't found do we return
      // `pending` (keep the intent locked; the backend retries via the pixel-lock UX) rather
      // than a hard 422 that makes the client think the purchase failed.
      //
      // Cheap preflight first: getSignatureStatuses is a single lightweight status row (no
      // full CU decode). If it's already confirmed we skip the WS wait entirely — the parse
      // below is the only expensive call, and it's cached for a duplicate /confirm.
      const landed = await waitForSignature(txSig, config.DIST_WAIT_MS);
      let preflightConfirmed = false;
      if (landed) {
        preflightConfirmed = true;
      } else {
        try {
          const st = await conn.getSignatureStatuses([txSig]);
          preflightConfirmed = st?.value?.[0]?.confirmationStatus != null || st?.value?.[0]?.err == null;
        } catch { /* ignore — the WS result already told us */ }
      }
      if (preflightConfirmed) {
        tx = await conn.getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0 });
        if (tx && tx.meta) confirmCache.set(txSig, { tx, at: Date.now() });
      } else if (!landed) {
        // Timed out AND not indexed → the tx may still be propagating (or dropped).
        // Keep the pixel locked: return `pending`, the intent stays until TTL expiry.
        return { code: 202, body: { error: "pending", message: "Transaction not yet confirmed. The pixel stays locked — retry shortly." } };
      }
    }
  } catch (e: any) {
    return { code: 502, body: { error: "rpc_failed", message: e?.message ?? "rpc" } };
  }
  if (!tx || !tx.meta) return { code: 422, body: { error: "tx_not_found" } };

  const feePayer = (tx.transaction.message.accountKeys[0] as any)?.pubkey?.toBase58() ?? "";
  if (buyer && feePayer && feePayer !== buyer) {
    return { code: 422, body: { error: "payer_mismatch", message: "The signer does not match the buyer on the quote." } };
  }

  const escrow = escrowKeypair();
  let solReceived = 0;
  let memo = "";
  const pushTx = tx as any;
  for (const ix of pushTx.transaction.message.instructions) {
    const parsed = ix.parsed;
    if (ix.program === "system" && parsed?.type === "transfer") {
      const info = parsed.info as { destination: string; lamports: number };
      if (info.destination === escrow.publicKey.toBase58()) {
        solReceived += Number(info.lamports) / LAMPORTS_PER_SOL;
      }
    }
    if (ix.program === "spl-memo" && ix.parsed) {
      memo = String(ix.parsed);
    } else if (ix.programId?.toBase58?.() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" && ix.data) {
      try { memo = Buffer.from(ix.data, "base64").toString(); } catch {}
    }
  }
  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const idetail of inner.instructions as any[]) {
      const parsed = idetail.parsed;
      if (idetail.program === "system" && parsed?.type === "transfer") {
        const info = parsed.info as { destination: string; lamports: number };
        if (info.destination === escrow.publicKey.toBase58()) {
          solReceived += Number(info.lamports) / LAMPORTS_PER_SOL;
        }
      }
    }
  }

  const expectedMemo = `pixelwars:${quoteId}`;
  if (memo !== expectedMemo) {
    return { code: 422, body: { error: "memo_mismatch", message: `Memo mismatch (got: ${memo})` } };
  }
  if (solReceived <= 0) {
    return { code: 422, body: { error: "no_escrow_transfer", message: "No SOL transfer to the escrow found." } };
  }

  // Golden pixel check (again — may fire after a race)
  const cell = await pool.query(
    `SELECT owner, mult, last_buy_ts, buy_count, is_kol, is_gold FROM cells WHERE x=$1 AND y=$2`,
    [x, y]
  );
  const prev = cell.rows[0];
  if (prev?.is_gold) {
    await refundToBuyer(buyer, solReceived);
    await pool.query(`DELETE FROM intents WHERE quote_id=$1`, [quoteId]);
    return { code: 423, body: { error: "golden_pixel", message: "This pixel is golden — it can no longer be bought. Your payment was refunded.", refundedSol: solReceived } };
  }

  // Price + tolerance
  const board = await ensureBoard();
  // Heat model: price from the current (decayed) multiplier — same base as the quote.
  const currentMult = decayedMult(Number(prev?.mult ?? 1), prev?.last_buy_ts ?? null, Date.now(), Boolean(prev?.is_gold));
  const price = priceForCell(currentMult, board.level, Boolean(prev?.owner));
  if (solReceived < price.sol * (1 - config.SOL_TOLERANCE)) {
    return {
      code: 422,
      body: {
        error: "underpaid",
        message: `Insufficient SOL: received ${solReceived.toFixed(6)}, expected ≥ ${price.sol.toFixed(6)}`,
      },
    };
  }

  // ATOMIC claim
  const client = await pool.connect();
  let burnSol = 0, poolSol = 0, treasurySol = 0, priorSol = 0;
  let priorOwner: string | null = null;
  let newMult = 1;
  let becomingGold = false;
  const dropped: Record<Symbol, boolean> = { grenade: false, missile: false, nuke: false };
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO cells (x, y, owner, mult, last_buy_ts, buy_count, is_kol, is_gold)
       VALUES ($1,$2,$3,1,now(),1,false,false)
       ON CONFLICT (x,y) DO NOTHING
       RETURNING owner`,
      [x, y, buyer]
    );
    if ((claim.rowCount ?? 0) === 0 && prev?.owner && prev.owner !== buyer) {
      // gasp path: ×2 from the current (decayed) heat — a cooled pixel is cheap, a hot one expensive.
      // The price step uses the same base as the price → consistent UX (visible × and price match 1:1).
      priorOwner = prev.owner;
      const nextRaw = currentMult * 2;
      becomingGold = nextRaw > config.MULT_CAP;
      newMult = becomingGold ? config.MULT_CAP : nextRaw;

      // Gasp split: prior 60% → the previous owner, pool 20% → the reward pool,
      // burn 10% → BURN_WALLET (escrow signs — NO burn keypair), the remainder
      // (10%) → TREASURY_WALLET.
      priorSol = (solReceived * config.GASP_SPLIT_PRIOR_PCT) / 100;
      poolSol = (solReceived * config.GASP_SPLIT_POOL_PCT) / 100;
      burnSol = (solReceived * config.GASP_SPLIT_BURN_PCT) / 100;
      treasurySol = solReceived - priorSol - poolSol - burnSol;

      await client.query(
        `UPDATE cells SET owner=$1, mult=$2, last_buy_ts=now(), buy_count=buy_count+1, is_kol=$3, is_gold=$4
         WHERE x=$5 AND y=$6`,
        [buyer, newMult, isKolAddr(buyer), becomingGold, x, y]
      );
    } else if ((claim.rowCount ?? 0) === 1) {
      // empty pixel purchase: burn 70% → BURN_WALLET, pool 20% → the reward pool,
      // the remainder (10%) → TREASURY_WALLET.
      newMult = 1;
      burnSol = (solReceived * config.EMPTY_SPLIT_BURN_PCT) / 100;
      poolSol = (solReceived * config.EMPTY_SPLIT_POOL_PCT) / 100;
      treasurySol = solReceived - burnSol - poolSol;
      // Insert already happened; just update is_kol
      if (isKolAddr(buyer)) {
        await client.query(`UPDATE cells SET is_kol=true WHERE x=$1 AND y=$2`, [x, y]);
      }
    } else {
      // the same buyer already owns it: this isn't a gasp, likely caught in a race → refund
      await client.query("ROLLBACK");
      await refundToBuyer(buyer, solReceived);
      await pool.query(`DELETE FROM intents WHERE quote_id=$1`, [quoteId]);
      return {
        code: 409,
        body: {
          error: "already_owned",
          message: "You already own this pixel. Your payment was refunded.",
          refundedSol: solReceived,
        },
      };
    }

    // Prize pool topup (3 pools by weight): the fresh pool share is distributed per the
    // config POOL_WEIGHT_*. Existing balances are untouched — jackpot logic: a pool zeroed
    // after a claim naturally re-accumulates from later purchases at this ratio.
    const wSum = config.POOL_WEIGHT_SMALL + config.POOL_WEIGHT_MID + config.POOL_WEIGHT_BIG || 1;
    const poolSmall = (poolSol * config.POOL_WEIGHT_SMALL) / wSum;
    const poolMid = (poolSol * config.POOL_WEIGHT_MID) / wSum;
    const poolBig = poolSol - poolSmall - poolMid;
    if (poolSmall > 0) await client.query(`UPDATE prize_pools SET balance_sol = balance_sol + $1, updated_at=now() WHERE id='small'`, [poolSmall]);
    if (poolMid > 0) await client.query(`UPDATE prize_pools SET balance_sol = balance_sol + $1, updated_at=now() WHERE id='mid'`, [poolMid]);
    if (poolBig > 0) await client.query(`UPDATE prize_pools SET balance_sol = balance_sol + $1, updated_at=now() WHERE id='big'`, [poolBig]);

    // Symbol drop RNG — all three symbols are tried independently (stock + max guarded).
    // Pass the board level so drop chances rise with the (price-growing) board (DROP_PRICE_STEP).
    for (const s of SYMBOLS) {
      dropped[s] = await maybeDropSymbol(client, buyer, s, newMult, board.level);
    }

    await client.query(
      `INSERT INTO purchases (tx_sig, quote_id, x, y, payer, amount_sol, split, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())`,
      [
        txSig, quoteId, x, y, buyer, solReceived,
        JSON.stringify({ burn: burnSol, pool: poolSol, treasury: treasurySol, prior: priorSol, priorOwner, isGasp: !!priorOwner }),
      ]
    );
    // Referral volume: accumulates the invitee's pixel purchases in SOL (no oracle cross —
    // exactly the player's real SOL volume). 0 rows when not linked.
    await client.query(
      `UPDATE referrals SET volume_sol = volume_sol + $1, last_activity_at = now() WHERE referee=$2`,
      [solReceived, buyer]
    );
    await client.query(`DELETE FROM intents WHERE quote_id=$1`, [quoteId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    // NOTE: SOL stays in the escrow → an operational refund is needed
    throw e;
  } finally {
    client.release();
  }

  // Distribution from the escrow — NO RPC on the /confirm hot path. Enqueue each
  // split leg for the reconciler (batch-sent ≤8/tx, drained inline + on the 30s
  // tick). prize_pools.balance_sol stays the virtual balance; the real SOL flows
  // through pending_distributions into the pool wallet.
  enqueueEscrowSplit({
    burn: burnSol,
    pool: poolSol,
    treasury: treasurySol,
    prior: priorOwner ? { owner: priorOwner, amount: priorSol } : null,
    quoteId,
    x,
    y,
  });
  scheduleInlineDrain();

  const { publish } = await import("./views");

  // Feed rule: on a gasp, "gasped" is enough — no "bought" event is emitted.
  // Only the first purchase of an empty pixel shows up as "bought".
  if (priorOwner) {
    const gaspEv = {
      type: "gasp",
      x, y,
      owner: buyer,
      prior_owner: priorOwner,
      amount_sol: solReceived,
      amount_usd: null,
      meta: { newMult, priorPct: config.GASP_SPLIT_PRIOR_PCT },
    };
    await logEvent(gaspEv as any);
    publish(gaspEv);
  } else {
    const ev = {
      type: "purchase",
      x, y,
      owner: buyer,
      amount_sol: solReceived,
      amount_usd: null,
      prior_owner: null,
      meta: { newMult, isGold: becomingGold, dropped, split: { burn: burnSol, pool: poolSol, treasury: treasurySol } },
    };
    await logEvent(ev as any);
    publish(ev);
  }

  for (const s of SYMBOLS) {
    if (!dropped[s]) continue;
    const dropEv = { type: `${s}_drop`, owner: buyer, x, y, amount_sol: 0, amount_usd: null, prior_owner: null };
    await logEvent(dropEv as any);
    publish(dropEv);
  }
  if (becomingGold) {
    const goldEv = { type: "gold", x, y, owner: buyer, amount_sol: 0, amount_usd: null, prior_owner: null };
    await logEvent(goldEv as any);
    publish(goldEv);
  }

  // SSE broadcast: update global state (polling clients gather it in one request).
  // Cache: DB committed → invalidate all global payloads (broadcast reads fresh first).
  bumpCache(["cells", "pools", "leaderboard"]);
  const { broadcastBoardSnapshot, broadcastCellPatch, broadcastPools, broadcastLeaderboard, signalNukesChanged } = await import("./broadcast");
  broadcastCellPatch({
    x, y,
    owner: buyer,
    mult: newMult,
    // gasp = a prior multiplier owner buying once more; empty purchase = first ownership (1).
    buy_count: priorOwner ? (Number(prev?.buy_count) ?? 0) + 1 : 1,
    is_kol: isKolAddr(buyer),
    is_gold: becomingGold,
    last_buy_ts: new Date().toISOString(),
    last_paid_sol: solReceived,
    nuke_dropped: SYMBOLS.some((s) => dropped[s]),
  });
  await broadcastPools();
  await broadcastLeaderboard();
  // Board fill/occupied must refresh immediately on purchase — not wait for the 30s
  // heartbeat. Otherwise the FillBar shows a stale % for up to half a minute.
  await broadcastBoardSnapshot();
  for (const s of SYMBOLS) {
    if (dropped[s]) signalNukesChanged(buyer);
  }

  return {
    code: 200,
    body: {
      ok: true,
      x, y,
      winner: buyer,
      amountSol: solReceived,
      split: { burn: burnSol, pool: poolSol, treasury: treasurySol, prior: priorSol, priorOwner },
      multiplier: newMult,
      isGold: becomingGold,
      dropped,
    },
  };
}

// --- Symbol drop RNG --------------------------------------------------------
// Guarded: nuke_config.available (per-symbol) > 0 AND the buyer's count of that
// symbol is under its max. On success: nuke_holders.count++, nuke_config.available--,
// nuke_events insert. The referral channel (refer.ts) bypasses these guards LATER.
async function maybeDropSymbol(
  client: any,
  buyer: string,
  symbol: Symbol,
  mult: number,
  level = 0
): Promise<boolean> {
  const p = dropProb(symbol, mult, level);
  if (p <= 0) return false;
  if (Math.random() >= p) return false; // the roll didn't hit

  // Guard: pool stock + owner max
  const stock = await client.query(`SELECT available FROM nuke_config WHERE symbol=$1`, [symbol]);
  const available = Number(stock.rows[0]?.available ?? 0);
  if (available <= 0) return false; // admin closed the stock

  const owned = await client.query(`SELECT count FROM nuke_holders WHERE owner=$1 AND symbol=$2`, [buyer, symbol]);
  const cur = Number(owned.rows[0]?.count ?? 0);
  if (cur >= maxPerPerson(symbol)) return false;

  // Atomic decrement + upsert
  const dec = await client.query(
    `UPDATE nuke_config SET available = available - 1, updated_at=now() WHERE symbol=$1 AND available > 0 RETURNING available`,
    [symbol]
  );
  if ((dec.rowCount ?? 0) === 0) return false;

  await client.query(
    `INSERT INTO nuke_holders (owner, symbol, count) VALUES ($1, $2, 1)
     ON CONFLICT (owner, symbol) DO UPDATE SET count = nuke_holders.count + 1`,
    [buyer, symbol]
  );
  await client.query(
    `INSERT INTO nuke_events (kind, owner, symbol, ts) VALUES ('drop', $1, $2, now())`,
    [buyer, symbol]
  );
  return true;
}

// --- Escrow helpers --------------------------------------------------------

// escrowKeypair() and poolKeypair() now live in ./keys (leaf module, shared with
// distribution.ts — avoids a verify<->distribution ESM circular import).

/** Re-exported for callers that still import from verify.ts. */
export { escrowKeypair, poolKeypair } from "./keys";

function isKolAddr(addr: string): boolean {
  return config.KOL_LIST.some((k) => k.addr === addr);
}

/**
 * Mark one escrow distribution leg for the reconciler (batch-sent, fire-and-forget).
 * Burn → BURN_WALLET (address only — the escrow signs; no burn keypair, the SOL
 * accumulates in BURN_WALLET and is moved to the Incinerator manually as a one-off).
 * Pool → POOL_WALLET (the real SOL behind prize_pools.balance_sol). Treasury →
 * TREASURY_WALLET (address only — the escrow signs). Prior → prior owner.
 * If a destination wallet isn't configured the leg is skipped by the reconciler's
 * validPk guard — the virtual balance stays correct (see drainDistributions).
 */
function enqueueEscrowSplit(args: {
  burn: number;
  pool: number;
  treasury: number;
  prior: { owner: string; amount: number } | null;
  quoteId?: string;
  x?: number;
  y?: number;
}) {
  const legs: { kind: "burn" | "pool" | "treasury" | "prior"; to: string; sol: number }[] = [];
  if (args.burn > 1e-9 && config.BURN_WALLET) legs.push({ kind: "burn", to: config.BURN_WALLET, sol: args.burn });
  if (args.pool > 1e-9 && config.POOL_WALLET) legs.push({ kind: "pool", to: config.POOL_WALLET, sol: args.pool });
  if (args.treasury > 1e-9 && config.TREASURY_WALLET) legs.push({ kind: "treasury", to: config.TREASURY_WALLET, sol: args.treasury });
  if (args.prior && args.prior.amount > 1e-9) legs.push({ kind: "prior", to: args.prior.owner, sol: args.prior.amount });
  for (const leg of legs) {
    enqueueDistribution({ quoteId: args.quoteId, x: args.x, y: args.y, ...leg });
  }
}

/** Refund the buyer (golden-pixel / already-owned rejection) — via the reconciler. */
export function refundToBuyer(buyer: string, sol: number): Promise<void> {
  return enqueueDistribution({ kind: "refund", to: buyer, sol });
}

/** Reward-pool claim payout — enqueues a pool_payout leg (POOL keypair pays it). */
export async function payoutFromPool(toOwner: string, sol: number): Promise<string | null> {
  await enqueueDistribution({ kind: "pool_payout", to: toOwner, sol });
  // The reconciler produces the real signature asynchronously; callers that need the
  // tx_sig for nuke_events should read it after the leg confirms (see admin /claim).
  return null;
}

/** Alias for compatibility — escrow refund payout (was payoutFromEscrow). */
export async function payoutFromEscrow(toOwner: string, sol: number): Promise<string | null> {
  await enqueueDistribution({ kind: "refund", to: toOwner, sol });
  return null;
}

function validPk(s: string): PublicKey | null {
  try { return new PublicKey(s); } catch { return null; }
}
