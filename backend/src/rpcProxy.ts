// JSON-RPC proxy — the ONLY place the Helius/chain RPC URL lives in the client
// path. The wallet sends every on-chain request (getLatestBlockhash,
// sendRawTransaction, getSignatureStatuses, ...) to `POST /api/rpc`; this handler
// forwards the raw JSON-RPC envelope to the shared Connection's URL we already
// use internally, so the API key stays server-side and never leaks into the bundle.
//
// Reads and wallet sends are forwarded verbatim (the wallet's sendRawTransaction is a
// single user action; the paranoid per-purchase queue lives in rpc.ts's internal path).
//
// We restrict to the methods the built-in wallet adapter actually needs, so the
// proxy can't be abused as a free Helius endpoint. Everything else → 400.

import { FastifyInstance } from "fastify";
import { PRIMARY_RPC_URL } from "./rpc";

const ALLOWED: Record<string, boolean> = {
  getLatestBlockhash: true,
  isBlockhashValid: true,
  getSignatureStatuses: true,
  getSignatureStatus: true,
  sendTransaction: true,
  sendRawTransaction: true,
  getTransaction: true,
  getParsedTransaction: true,
  getBalance: true,
  getSignaturesForAddress: true,
  getSlot: true,
  getEpochInfo: true,
  getHealth: true,
  getVersion: true,
  getFeeForMessage: true,
  getAccountInfo: true,
  getMultipleAccounts: true,
  getTokenAccountsByOwner: true,
  getProgramAccounts: true,
  simulateTransaction: true,
};

const PROXY_TARGET: string = PRIMARY_RPC_URL;

// Blockhash cache for the client path. Every open tab warms a blockhash ~every 30s
// (useWarmBlockhash in App.tsx) and every sendTransaction requests a fresh one, so at
// 1000 concurrent tabs this alone is ~30 RPS against Helius. A blockhash lives ~60s/150
// slots, so a 5s cache is plenty for the wallet: it reads blockhash + lastValidBlockHeight
// together, so we cache the *verbatim upstream result* and replay it as-is.
const BH_CACHE_TTL_MS = 5000;
let bhCache: { json: any; at: number } | null = null;

function serveBlockhash(req: any, reply: any): boolean {
  const body = req.body as { method?: string; params?: any[]; id?: any } | null;
  const p0 = (body?.params as any)?.[0];
  // web3.js sends `[{ commitment: "confirmed" }]` (object) or a bare string.
  const commit = typeof p0 === "string" ? p0 : p0?.commitment;
  // Only cache the default / finalized+confirmed forms the wallet actually uses.
  if (commit != null && commit !== "confirmed" && commit !== "finalized") {
    return false; // passthrough — nonstandard commitment
  }
  if (bhCache && Date.now() - bhCache.at < BH_CACHE_TTL_MS) {
    const hit = bhCache.json;
    reply.header("content-type", "application/json");
    reply.send({ ...hit, id: body?.id });
    return true;
  }
  return false;
}

export async function rpcProxyRoutes(app: FastifyInstance) {
  app.post("/rpc", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = req.body as { method?: string } | null;
    const method = body?.method;
    if (!method) {
      return reply.code(400).send({ error: { code: -32600, message: "missing method" } });
    }

    let methodOnly = method;
    if (method.startsWith("sol_")) {
      // JSON-RPC 2.0 fully-qualified form the wallet may send after web3.js updates.
      methodOnly = method.slice(4);
    }
    if (!ALLOWED[methodOnly]) {
      return reply.code(400).send({ error: { code: -32601, message: `method not allowed: ${method}` } });
    }

    // Serve getLatestBlockhash from the short cache when fresh (cuts ~30 RPS at
    // 1000 tabs); write through on a cache miss below.
    if (methodOnly === "getLatestBlockhash" && serveBlockhash(req, reply)) {
      return;
    }

    let upstream: Response;
    try {
      upstream = await fetch(PROXY_TARGET, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      req.log.warn({ err: e }, "rpc proxy upstream error");
      return reply.code(502).send({ error: { code: -32000, message: "upstream unreachable" } });
    }

    const text = await upstream.text();
    // Cache getLatestBlockhash misses verbatim so subsequent tabs get the replay.
    if (methodOnly === "getLatestBlockhash" && upstream.ok) {
      try {
        bhCache = { json: JSON.parse(text), at: Date.now() };
      } catch { /* non-JSON upstream — don't cache */ }
    }
    reply.code(upstream.status);
    reply.header("content-type", "application/json");
    return text;
  });
}