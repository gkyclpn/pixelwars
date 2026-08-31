// Shared Solana RPC layer — the single entry point for every on-chain call in the
// hot path (verify.ts, distribution.ts, admin.ts).
//
// Why this exists (launch hardening): Helius Developer RPC rate-limits hard at
// ~100–200 RPS. The old /confirm path made 8–18 RPC calls per purchase and an
// unguarded 429 could crash the whole process (tsx watch does NOT restart). This
// module:
//   * owns ONE Connection per RPC URL (failover via RPC_URLS),
//   * caches getLatestBlockhash (15s TTL — blockhash lives ~60s/150 slots),
//   * serializes every sendRawTransaction through a p-queue (concurrency + backoff)
//     so a 429/5xx is retried instead of thrown as an uncaught rejection,
//   * replaces confirmTransaction polling (the RPC-hungry call) with a WebSocket
//     `signatureSubscribe` wait, which does NOT count against Helius RPS.
// Every production module must import THIS singleton — never construct a raw Connection.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import PQueue from "p-queue";
import { config } from "./config";

const COMMITMENT = "confirmed";

function urls(): string[] {
  const raw = (process.env.RPC_URLS || process.env.RPC_URL || "").split(",").map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : [clusterApiUrl("devnet")];
}

const connUrls: string[] = urls();
const conns: Connection[] = connUrls.map((u, i) => {
  // log via process.stdout.write to avoid pino field-name confusion at import time
  if (i > 0) process.stderr.write(`[rpc] failover RPC #${i}: ${u}\n`);
  return new Connection(u, COMMITMENT);
});
const primary: Connection = conns[0];
// Exposed for the JSON-RPC proxy (rpcProxy.ts) so it forwards to the same URL the
// internal Connection uses — single source of truth for the target endpoint.
export const PRIMARY_RPC_URL: string = connUrls[0];

// --- Blockhash cache (cuts 3–5 getLatestBlockhash/purchase → ~0) -------------
let cached: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;

export async function getCachedBlockhash(commitment = "finalized" as "finalized" | "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const ttl = config.BLOCKHASH_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached;
  let latest;
  try {
    latest = await primary.getLatestBlockhash(commitment);
  } catch (e) {
    // graceful failover: a fresh call only when the cached one has expired
    latest = await primary.getLatestBlockhash(commitment);
    if (e instanceof Error) process.stderr.write(`[rpc] getLatestBlockhash retry: ${e.message}\n`);
  }
  cached = { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, at: Date.now() };
  return cached;
}

// --- Queued sender (serialize + backoff on 429/5xx) --------------------------
// Serialized to a small concurrency so a purchase burst never spikes RPS; each
// send gets a few exponential-backoff retries before surfacing as a failure.
const sendQueue = new PQueue({ concurrency: Number(process.env.RPC_SEND_CONCURRENCY ?? 4) });

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function isRetryable(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  if (/429|too many request|rate.?limit|503|502|Slow down|timed out/i.test(msg)) return true;
  return false;
}

/**
 * Broadcast a signed transaction through the queue. Retries on 429/5xx with
 * exponential backoff (jittered). Resolves to the tx signature on success,
 * or null when the retries are exhausted (callers enqueue a pending_distribution).
 */
export function sendTransactionViaQueue(ser: Buffer | Uint8Array): Promise<string | null> {
  return sendQueue.add(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await primary.sendRawTransaction(ser, { skipPreflight: true });
      } catch (e: any) {
        const retryable = isRetryable(e);
        if (!retryable || attempt === 2) {
          if (e instanceof Error) process.stderr.write(`[rpc] send failed: ${e.message}\n`);
          return null;
        }
        await sleep(200 * Math.pow(2, attempt) + Math.floor(Math.random() * 150));
      }
    }
    return null;
  });
}

// --- WebSocket signature wait (replaces confirmTransaction polling) ----------
// `onSignature` is a WS subscription — NOT an RPS-billed HTTP call.
const sigWaitQueue = new PQueue({ concurrency: Number(process.env.RPC_SIG_WAIT_CONCURRENCY ?? 40) });

export function waitForSignature(sig: string, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let subId: number | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (subId != null) {
        try { primary.removeSignatureListener(subId); } catch { /* best-effort */ }
      }
      resolve(ok);
    };
    // `onSignature` returns ClientSubscriptionId (number) synchronously in web3.js;
    // the callback fires on the tx's confirmation. WS does NOT count against the
    // HTTP RPS budget. If the WS subscription itself fails, we fall through to the
    // single bounded HTTP poll below.
    try {
      subId = primary.onSignature(sig, (result: any) => {
        // result.err === null → the tx committed
        if (result?.err == null) finish(true);
      }, COMMITMENT);
    } catch {
      // WS subscription failed — fall through to the HTTP poll below.
    }

    const timer = setTimeout(async () => {
      // WS never fired in time → one bounded HTTP poll (SearchTransactionHistory).
      try {
        const status = await primary.getSignatureStatus(sig, { searchTransactionHistory: true });
        const s = status?.value;
        finish(s?.err == null);
      } catch {
        finish(false);
      }
    }, timeoutMs);
    timer.unref?.();
  });
}

// --- High-level transfer + wait (used by distribution reconciler / refunds) --
export async function sendAndWait(from: Keypair, toPk: PublicKey, lamports: number): Promise<string | null> {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: toPk, lamports }));
  const bh = await getCachedBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = from.publicKey;
  tx.sign(from);
  const sig = await sendTransactionViaQueue(tx.serialize());
  if (!sig) return null;
  // Best-effort wait — never re-throw: WS failure just means the reconciler
  // marks idempotently-vs-account (status stays pending) and a later drain re-sends.
  const ok = await waitForSignature(sig, config.DIST_WAIT_MS);
  return ok ? sig : null;
}

export { Connection, primary, conns };