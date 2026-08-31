import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import pool from "./db";
import { config } from "./config";
import { ensureBoard, liveBoard, tickExpansions } from "./board";
import { perPxSolForLevel, decayedMult } from "./pricing";
import { POOL_SYMBOL, SYMBOL_EMOJI } from "./symbols";
import { cachedValue, commitCache, cacheVersion } from "./memStore";

// Syncs the static KOL list from config into the DB (on every startup).
export async function syncKolList(): Promise<void> {
  for (const k of config.KOL_LIST) {
    await pool.query(
      `INSERT INTO kol_list (addr, name, avatar, x_handle) VALUES ($1,$2,$3,$4)
       ON CONFLICT (addr) DO UPDATE SET name=EXCLUDED.name, avatar=EXCLUDED.avatar, x_handle=EXCLUDED.x_handle`,
      [k.addr, k.name, k.avatar ?? null, k.xHandle ?? null]
    );
  }
}

/**
 * Public view routes: /board, /cells, /leaderboard, /events (SSE), /config.
 */

// Events SSE bus (in-memory). Board ticks and purchases publish to it.
type Subscriber = (ev: any) => void;
interface SubscriberRecord {
  send: Subscriber;
  lastPingAt: number;
  drop: () => void;
}
// Map keyed by a per-connection UUID (sent to the client in the init frame, echoed
// back on /events/ping and /events/close). The record also carries lastPingAt so a
// reaper can evict clients that vanished without tearing down TCP (see PING_TIMEOUT_MS).
const subscribers = new Map<string, SubscriberRecord>();

export function publish(ev: any): void {
  for (const s of subscribers.values()) s.send(ev);
}

// Cap concurrent SSE clients so an unbounded fanout can't exhaust memory/FDs.
// New connections evict the oldest subscriber (LRU-ish) — resilient under a firehose.
const MAX_SUBSCRIBERS = Number(process.env.MAX_SSE_SUBSCRIBERS ?? 2000);
// How often (ms) the OS sends a TCP keepalive probe. Client gone without FIN/RST
// (WiFi sleep, lid close, NAT timeout) → OS destroys the socket after the first few
// unanswered probes → our close/error handler runs drop() → users_count stays real.
// NOTE: TCP keepalive alone is NOT enough when an intermediate proxy (Vite dev, a NAT
// box, mobile network) stays alive and ACKs the probes on the client's behalf — the
// socket looks healthy to us forever even though the browser is gone. The application
// heartbeat below (client pings every 20s, reaper evicts after 45s of silence) is the
// definitive guard; keepalive is the fast-path for clean TCP teardowns.
const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS ?? 5000);

// A client must send POST /events/ping at least this often or it gets reaped. The
// client pings every HEARTBEAT_PING_MS (10s) — twice inside this 20s window, so a
// briefly-throttled tab (foreground → background) won't false-reap but a dead one is
// evicted fast. Tuned: old ghosts disappear ~20s after the browser is gone.
const PING_TIMEOUT_MS = Number(process.env.SSE_PING_TIMEOUT_MS ?? 20000);

// Reaper: evict SSE subscribers that stopped pinging (browser closed / device slept /
// proxy held the socket open). Runs independently of TCP close events so a half-open
// socket can't leave a ghost subscriber inflating users_count forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of subscribers) {
    if (now - rec.lastPingAt > PING_TIMEOUT_MS) {
      rec.drop();
    }
  }
}, 10_000).unref();

export function subscriberCount(): number {
  return subscribers.size;
}

// --- Live "active players" count --------------------------------------------
// Each open SSE connection ≈ one active tab/wallet. We broadcast the connection
// count to every client whenever it changes so the UI can show a live player count.
let lastUserCount = -1;
export function publishUserCount(): void {
  const n = subscribers.size;
  if (n === lastUserCount) return; // no-op unless it actually changed (avoid SSE noise)
  lastUserCount = n;
  publish({ type: "users_count", count: n });
}

// Shared payload builders — both REST routes and SSE broadcasts use the same shape.
export async function boardPayload() {
  const board = await tickExpansions();
  const [topCount, topVolume] = await Promise.all([topByCount(5), topByVolumeSol(5)]);
  return {
    ...board,
    tokenMint: config.TOKEN_MINT,
    // So the frontend heatmap decay stays in sync with the backend (live cooldown):
    // cells render-time decay the mult. Carried in the SSE init/snapshot, single
    // source is config — no hardcoded constants.
    cooldownSeconds: config.COOLDOWN_SECONDS,
    multDecayFactor: config.MULT_DECAY_FACTOR,
    // For frontend client-side pricing: since /price is gone, the gasp share and
    // multiplier cap come over SSE (used in the panel derivation).
    gaspSplitPriorPct: config.GASP_SPLIT_PRIOR_PCT,
    multCap: config.MULT_CAP,
    // Symbol drop chance formula p = base + step*log2(mult) — the frontend derives each
    // cell's hover/panel chances from the SSE payload (no dropProb oracle/DB).
    chance: {
      grenade: { base: config.GRENADE_BASE_PROB, step: config.GRENADE_MULT_STEP },
      missile: { base: config.MISSILE_BASE_PROB, step: config.MISSILE_MULT_STEP },
      nuke: { base: config.NUKE_BASE_PROB, step: config.NUKE_MULT_STEP },
    },
    leaderboardTopCount: topCount,
    leaderboardTopVolume: topVolume,
  };
}

export async function cellsPayload() {
  const hit = cachedValue<{ cells: any[]; size: number }>("cells");
  if (hit) return hit;
  const version = cacheVersion("cells");
  const board = await liveBoard();
  const { rows } = await pool.query(
    `SELECT c.x, c.y, c.owner, c.mult, c.buy_count, c.is_kol, c.is_gold, c.last_buy_ts,
            (SELECT p.amount_sol FROM purchases p WHERE p.x=c.x AND p.y=c.y ORDER BY p.ts DESC LIMIT 1) AS last_paid_sol,
            EXISTS(SELECT 1 FROM nuke_events ne WHERE ne.kind='drop' AND ne.x=c.x AND ne.y=c.y) AS nuke_dropped
     FROM cells c
     WHERE c.owner IS NOT NULL AND c.x<$1 AND c.y<$2`,
    [board.size, board.size]
  );
  const cells = rows.map((r: any) => ({
    ...r,
    // Send the STORED (non-decayed) mult. Cooldown decay now lives in one place — the
    // frontend useBoard applies it on its own 1s tick (for the live heatmap fade; no
    // gaps between init/heartbeat/patch). This keeps patch and snapshot consistent.
    mult: Number(r.mult),
    // pg numeric (last_paid_sol subquery) comes back as a string — the frontend calls
    // toFixed without a guard, so coerce to a number (a string would throw there).
    last_paid_sol: r.last_paid_sol != null ? Number(r.last_paid_sol) : null,
  }));
  const payload = { cells, size: board.size };
  commitCache("cells", payload, version);
  return payload;
}

/** Non-expired intent locks — so a newly-opened tab can seed its pending overlay. */
export async function intentsPayload() {
  const { rows } = await pool.query(
    `SELECT x, y, owner, quote_id, expires_at FROM intents WHERE expires_at > now()`
  );
  return rows.map((r: any) => ({
    x: Number(r.x),
    y: Number(r.y),
    owner: r.owner,
    quoteId: r.quote_id,
    expiresAtSec: Math.max(1, Math.round((new Date(r.expires_at).getTime() - Date.now()) / 1000)),
  }));
}

export interface LeaderboardPayload {
  byCount: { owner: string; count: number }[];
  byVolume: { owner: string; volumeSol: number }[];
  byValue: { x: number; y: number; owner: string; buyCount: number; mult: number; valueSol: number }[];
}

export async function leaderboardPayload(): Promise<LeaderboardPayload> {
  // byValue.mult is produced server-side by decayedMult() (time-dependent) → the 30s TTL recompute keeps it fresh.
  const hit = cachedValue<LeaderboardPayload>("leaderboard", 30_000);
  if (hit) return hit;
  const version = cacheVersion("leaderboard");
  const [byCount, byVolume, byValueRows] = await Promise.all([
    topByCount(50),
    topByVolumeSol(50),
    pool.query(
      `SELECT c.x, c.y, c.mult, c.buy_count, c.owner, c.is_gold, c.last_buy_ts
       FROM cells c
       WHERE c.owner IS NOT NULL AND c.owner NOT LIKE 'dev:%'
       ORDER BY c.mult DESC
       LIMIT 50`
    ),
  ]);
  // value: from the current (decayed) heat — consistent with the pricing model
  const board = await liveBoard();
  const perPx = perPxSolForLevel(board.level);
  const rows = byValueRows.rows.map((r) => {
    const mult = decayedMult(Number(r.mult), r.last_buy_ts, Date.now(), Boolean(r.is_gold));
    return { x: r.x, y: r.y, owner: r.owner, buyCount: Number(r.buy_count), mult, valueSol: perPx * mult };
  });
  const payload = { byCount, byVolume, byValue: rows };
  commitCache("leaderboard", payload, version);
  return payload;
}

export async function poolsPayload() {
  const hit = cachedValue<{ pools: any[] }>("pools");
  if (hit) return hit;
  const version = cacheVersion("pools");
  const poolsRes = await pool.query(`SELECT id, balance_sol, updated_at FROM prize_pools ORDER BY id`);
  const wSum = config.POOL_WEIGHT_SMALL + config.POOL_WEIGHT_MID + config.POOL_WEIGHT_BIG || 1;
  const items = poolsRes.rows.map((r: any) => {
    const claimSymbol = POOL_SYMBOL[r.id as "small" | "mid" | "big"];
    return {
      id: r.id,
      balanceSol: Number(r.balance_sol),
      updatedAt: r.updated_at,
      claimSymbol,
      claimSymbolEmoji: SYMBOL_EMOJI[claimSymbol],
      claimCost: (config as any).CLAIM_COST[r.id],
      weightPct: Math.round(((config as any)[`POOL_WEIGHT_${String(r.id).toUpperCase()}`] / wSum) * 100),
    };
  });
  const payload = { pools: items };
  commitCache("pools", payload, version);
  return payload;
}

export async function viewsRoutes(app: FastifyInstance) {
  // Board state (front canvas initial render)
  app.get("/board", async (_req) => {
    return boardPayload();
  });

  // Canvas cell data (owned + KOL). Returns a DECAYED multiplier —
  // so a cooled-off pixel's multiplier looks realistic second by second.
  app.get("/cells", async (_req) => {
    return { ...(await cellsPayload()), intents: await intentsPayload() };
  });

  // Leaderboard, 3 tabs
  app.get("/leaderboard", async (_req) => {
    return leaderboardPayload();
  });

  // SSE live events — global snapshots (board/cells/pools/leaderboard) + event feed.
  app.get("/events", async (_req, reply) => {
    reply.hijack();
    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    };
    reply.raw.writeHead(200, headers);
    reply.raw.write(`retry: 3000\n\n`);

    let closed = false;
    // Deregister on error/close/finish so a dead client's writer can't throw on
    // later publish. Attached IMMEDIATELY (before the async snapshot build below):
    // a client that disconnects during init leaves before `subscribers.add` runs, and
    // had a close handler already registered (so it stays deregistered). Registering
    // the close listener only AFTER the await let a fast disconnect slip through — the
    // `close` event fired during the await window, `drop` never ran, and that stale
    // subscriber was never removed → the live count grew forever.
    //
    // A client that vanishes WITHOUT tearing down TCP (WiFi sleep, lid close, NAT
    // timeout) leaves a half-open socket: the `close` event never fires and the 15s
    // `:ping` write just buffers into the dead peer, so the subscriber survives
    // indefinitely → `users_count` climbs past real players. Two defenses:
    //   1. Aggressive TCP keepalive → the OS probes the peer and destroys the socket
    //      once it stops ACKing → our `close`/`error` handler runs drop().
    //   2. On every heartbeat, bail if the socket is already destroyed/write-ended.
    const sock = reply.raw.socket;
    sock?.setKeepAlive(true, SSE_KEEPALIVE_MS);
    const subscriberId = randomUUID();
    // Fresh-connection heartbeat baseline. Any client that fails to ping within
    // PING_TIMEOUT_MS is reaped, so the very first ping must not be judged stale.
    let lastPingAt = Date.now();
    const drop = () => {
      if (closed) return;
      closed = true;
      if (subscribers.delete(subscriberId)) {
        publishUserCount(); // a player left — broadcast the new live count
      }
      if (keepalive) clearInterval(keepalive);
      // Forcibly close the TCP socket. Removing the subscriber from the map alone
      // makes users_count correct, but the orphaned ESTABLISHED socket (held open by
      // a dead peer's proxy ACKing keepalive) would otherwise leak a file descriptor
      // forever. Without destroy(), launch-day churn across mobile networks exhausts
      // the ulimit (1024) and new connections start getting refused.
      sock?.destroy();
    };
    const sub: Subscriber = (ev) => send(ev);
    const rec: SubscriberRecord = { send: sub, lastPingAt, drop };
    const send = (ev: any) => {
      if (closed) return;
      // Half-open guard: socket destroyed (keepalive/timeout tore it down, or client
      // RST'd) without the close/error handlers having run yet → drop now so this
      // subscriber can't linger and inflate users_count.
      if (sock?.destroyed) { drop(); return; }
      try {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch (e) {
        drop();
      }
    };
    reply.raw.on("close", drop);
    reply.raw.on("error", drop);
    reply.raw.on("finish", drop);

    // Full snapshot of global state for the newly connected client (initial render bootstrap).
    const [board, cells, pools, recentRes] = await Promise.all([
      boardPayload(),
      cellsPayload(),
      poolsPayload(),
      pool.query(`SELECT * FROM events ORDER BY id DESC LIMIT 60`),
    ]);
    const [leaderboard, intents] = await Promise.all([leaderboardPayload(), intentsPayload()]);
    send({
      type: "init",
      subscriberId,
      board,
      cells: cells.cells,
      size: cells.size,
      pools: pools.pools,
      leaderboard,
      recent: (recentRes.rows as any[]).reverse(),
      intents,
      activeCount: subscribers.size,
    });

    // Only register once the snapshot writes succeed — a client that dies during init
    // already had `closed` set by the close handler, so this is a no-op. Evict under
    // the subscription cap — oldest first, so a flood of zombies releases.
    if (closed) return;
    if (subscribers.size >= MAX_SUBSCRIBERS) {
      const oldest = subscribers.keys().next().value as string | undefined;
      if (oldest && oldest !== subscriberId) {
        const rec = subscribers.get(oldest);
        if (rec) rec.drop();
      }
    }
    subscribers.set(subscriberId, rec);
    publishUserCount(); // a player arrived — broadcast the new live count

    // Prevent proxy idle-timeout — a comment line every 15s (doesn't trigger onmessage).
    // Also the backstop for a half-open socket that keepalive already destroyed.
    let keepalive: NodeJS.Timeout | null = setInterval(() => {
      if (closed) return;
      if (sock?.destroyed) { drop(); return; }
      try {
        reply.raw.write(":ping\n\n");
      } catch {
        drop();
      }
    }, 15000);
    return; // hijacked — consume edilir
  });

  // App-level heartbeat. The SSE client pings every 20s; if one stops (browser closed
  // with the TCP socket still held open by a proxy) the reaper evicts it after
  // PING_TIMEOUT_MS. This is the definitive fix for users_count inflation that pure TCP
  // keepalive can't catch. The body carries { subscriberId } as JSON.
  //
  // The ping is IDEMPOTENT: an unknown subscriberId means the subscriber was already
  // reaped (e.g. the tab was backgrounded and the connection dropped), not a client error.
  // Returning 404 for that benign case just spams the console (sendBeacon responses are
  // invisible to the client anyway) and doesn't help the reaper — it only renews
  // lastPingAt for a *registered* id, so unknown ids are never kept alive. 200 keeps
  // the guard intact and silences the noise.
  app.post("/events/ping", async (req, reply) => {
    const id = (req.body as any)?.subscriberId;
    const rec = typeof id === "string" ? subscribers.get(id) : undefined;
    if (rec) rec.lastPingAt = Date.now();
    return reply.send({ ok: rec != null });
  });

  // Explicit close: the client fires a sendBeacon on beforeunload so a tab close that
  // WOULD have been a clean FIN (but may also race a reconnect) releases immediately.
  app.post("/events/close", async (req, reply) => {
    const id = (req.body as any)?.subscriberId;
    const rec = typeof id === "string" ? subscribers.get(id) : undefined;
    if (rec) rec.drop();
    return reply.send({ ok: true });
  });

  // Readable config (the token address is shown at the top of the page).
  // Internal limits (boardSizes, MAX_<SYMBOL>_PER_PERSON, stock pool) do NOT leak to the public.
  app.get("/config/public", async () => ({
    tokenMint: config.TOKEN_MINT,
    tokenDecimals: config.TOKEN_DECIMALS,
    baseSol: config.BASE_SOL,
    perPxMult: config.PER_PX_MULT,
    cooldownSeconds: config.COOLDOWN_SECONDS,
    multDecayFactor: config.MULT_DECAY_FACTOR,
    maxBoardSize: (config as any).BOARD_SIZES?.length ? Math.max(...(config as any).BOARD_SIZES) : 5,
    isMaintenance: (await liveBoard()).isMaintenance,
  }));

  // KOL list (UI avatar + X links)
  app.get("/kols", async (_req, reply) => {
    const { rows } = await pool.query(`SELECT addr, name, avatar, x_handle FROM kol_list`);
    return reply.send({ kols: rows });
  });

  // 3 jackpot pool balances (SOL)
  app.get("/pools", async () => {
    return poolsPayload();
  });
}

async function topByCount(limit: number) {
  const { rows } = await pool.query(
    `SELECT owner, count(*) AS count
     FROM cells
     WHERE owner IS NOT NULL AND owner NOT LIKE 'dev:%'
     GROUP BY owner ORDER BY count DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ owner: r.owner, count: Number(r.count) }));
}

async function topByVolumeSol(limit: number) {
  const { rows } = await pool.query(
    `SELECT payer, sum(amount_sol) AS volume_sol
     FROM purchases
     GROUP BY payer ORDER BY volume_sol DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ owner: r.payer, volumeSol: Number(r.volume_sol) }));
}
