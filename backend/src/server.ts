import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { quoteRoutes, sweepExpiredIntents } from "./quote";
import { registerConfirmRoutes } from "./verify";
import { adminRoutes } from "./admin";
import { viewsRoutes, syncKolList } from "./views";
import { referRoutes } from "./refer";
import { rpcProxyRoutes } from "./rpcProxy";
import { tickExpansions } from "./board";
import { logEvent } from "./board";
import { seedConfigIfEmpty, refreshConfig } from "./configStore";
import { drainDistributions } from "./distribution";

// TLS terminates at the proxy (Caddy/nginx) in production, and local dev uses plain
// http from Vite's https dev server proxying to the backend. No TLS here.
const app = Fastify({ logger: true, trustProxy: true });

// Explicitly state the allowed method list so preflight works for non-simple methods like PATCH/DELETE.
await app.register(cors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

// Global rate limit: caps a single IP's total request pressure (bot/DoS match).
// Relatively generous — normal users get the feed over SSE so the REST load is low;
// it stops malicious attacks. Stricter per-route limits are applied separately below
// via route `config` (the `rateLimit` config key). `trustProxy: true` (set above)
// lets Fastify see the real client IP behind a proxy.
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
  errorResponseBuilder: (req, ctx) => ({
    statusCode: 429,
    error: "too_many_requests",
    message: `Too many requests — please wait a moment and try again (${ctx.max} / ${ctx.after}).`,
  }),
});

// Seed the DB-backed config from env defaults, then refresh in-place with live values.
await seedConfigIfEmpty();
await refreshConfig();

await app.register(quoteRoutes);
await app.register(registerConfirmRoutes);
await app.register(adminRoutes);
await app.register(viewsRoutes);
await app.register(referRoutes);
await app.register(rpcProxyRoutes);

app.get("/health", async () => ({ ok: true }));

// Board expansion + distribution reconciler tick (30s).
// drainDistributions() ships any pending SOL split legs in batches — the inline
// drain after each /confirm covers the steady state; this periodic run catches
// stragglers and retries rows that failed during a send/WS-wait.
const TICK_MS = 30_000;
setInterval(async () => {
  try {
    await tickExpansions();
  } catch (e) {
    console.error("board tick error", e);
  }
  try {
    await drainDistributions();
  } catch (e) {
    console.error("distribution drain error", e);
  }
  try {
    // Expired purchase locks release the pixel — broadcast `intent_unlocked` so
    // every tab drops its loading overlay (backend is the authority, not per-tab timers).
    await sweepExpiredIntents();
  } catch (e) {
    console.error("intent sweep error", e);
  }
}, TICK_MS);

// C2 — crash containment. tsx watch does NOT restart a dead process, so a single
// unguarded rejection (e.g. an RPC 429 escaping a promise chain) used to take the
// whole backend down. Log the full stack, then exit(1) — the orchestrator (pm2/
// systemd/supervisor) restarts a clean process. We do NOT swallow silently: the
// stack is the only trail for diagnosis.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err?.stack ?? err);
  process.exit(1);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[fatal] unhandledRejection", reason);
  process.exit(1);
});

// Seed the board + sync the KOL list on startup
try {
  await tickExpansions();
  await syncKolList();
} catch (e) {
  console.error("init error", e);
}

const port = Number(process.env.PORT ?? 8787);
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
