import { randomBytes } from "node:crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import pool from "./db";
import { config } from "./config";
import { ensureBoard, logEvent, tickExpansions } from "./board";
import { perPxSolForLevel, indexOfSize, sizeAtIndex } from "./pricing";
import { payoutFromPool } from "./verify";
import { requireAdmin, adminAuthRoutes } from "./adminAuth";
import { getAdminWallets, refreshConfig, updateConfigKey } from "./configStore";
import { publish } from "./views";
import { validateConfigChanges } from "./configValidation";
import { POOL_SYMBOL, SYMBOLS, SYMBOL_EMOJI, isSymbol } from "./symbols";
import { bumpCache } from "./memStore";

// Dev/whitelist management: free pixel placement (dev purchase, leaderboard-exempt),
// config, manual expansion, KOL list updates + the Admin Config UI.
// Every admin route requires an ed25519-verified JWT (requireAdmin).

const PaintSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  color: z.number().int().min(0).max(0xffffff),
  free: z.boolean().optional().default(true),
});

// --- Signed claim (anti-forgery) --------------------------------------------
// The bodies of the routes that release a game payout (prize_pools → SOL from
// escrow to an owner) can't be trusted: they require a nonce escrow + an ed25519
// wallet signature. The message binds the claim's exact parameters (pool + nonce)
// — the signer can only claim with their own wallet and can't block someone else's.
const CLAIM_NONCE_TTL_MS = 10 * 60 * 1000;

function claimMessage(owner: string, pool: string, nonce: string): string {
  return `PixelWars claim\nowner: ${owner}\npool: ${pool}\nnonce: ${nonce}`;
}

/** Full config for the UI panel (secret keypairs NEVER). Symbol stock is read live from the DB. */
async function fullConfigSnapshot() {
  const cfg = config as any;
  const boardRow = await ensureBoard();
  const stockRes = await pool.query(`SELECT symbol, available FROM nuke_config`);
  const stock = new Map(stockRes.rows.map((r: any) => [r.symbol, Number(r.available)]));
  const chance = Object.fromEntries(
    SYMBOLS.map((s) => {
      const K = s.toUpperCase();
      return [s, {
        baseProb: cfg[`${K}_BASE_PROB`],
        multStep: cfg[`${K}_MULT_STEP`],
        maxPerPerson: cfg[`MAX_${K}_PER_PERSON`],
        available: stock.get(s) ?? 0,
      }];
    })
  );
  return {
    boardSizes: (config as any).BOARD_SIZES ?? [],
    econ: {
      BASE_SOL: cfg.BASE_SOL,
      PER_PX_MULT: cfg.PER_PX_MULT,
      FILL_EXPAND_THRESHOLD: cfg.FILL_EXPAND_THRESHOLD,
      FILL_EXPAND_SECONDS: cfg.FILL_EXPAND_SECONDS,
      COOLDOWN_SECONDS: cfg.COOLDOWN_SECONDS,
      MULT_DECAY_FACTOR: cfg.MULT_DECAY_FACTOR,
      MULT_CAP: cfg.MULT_CAP,
    },
    wallets: {
      BURN_WALLET: cfg.BURN_WALLET ?? "",
      DEAD_WALLET: cfg.DEAD_WALLET ?? "",
      TREASURY_WALLET: cfg.TREASURY_WALLET ?? "",
      POOL_WALLET: cfg.POOL_WALLET ?? "",
    },
    // Secret keypairs: burn/treasury are destination addresses only (the escrow signs
    // their legs), so they have no keypair. Only escrow + pool hold secrets.
    hasSecret: {
      escrow: !!process.env.ESCROW_KEYPAIR,
      pool: !!process.env.POOL_KEYPAIR,
    },
    splits: {
      EMPTY_SPLIT_BURN_PCT: cfg.EMPTY_SPLIT_BURN_PCT,
      EMPTY_SPLIT_POOL_PCT: cfg.EMPTY_SPLIT_POOL_PCT,
      EMPTY_SPLIT_TREASURY_PCT: cfg.EMPTY_SPLIT_TREASURY_PCT,
      GASP_SPLIT_PRIOR_PCT: cfg.GASP_SPLIT_PRIOR_PCT,
      GASP_SPLIT_POOL_PCT: cfg.GASP_SPLIT_POOL_PCT,
      GASP_SPLIT_BURN_PCT: cfg.GASP_SPLIT_BURN_PCT,
      GASP_SPLIT_TREASURY_PCT: cfg.GASP_SPLIT_TREASURY_PCT,
    },
    pools: {
      POOL_WEIGHT_SMALL: cfg.POOL_WEIGHT_SMALL,
      POOL_WEIGHT_MID: cfg.POOL_WEIGHT_MID,
      POOL_WEIGHT_BIG: cfg.POOL_WEIGHT_BIG,
    },
    chance,
    // Global (all-symbol) drop-chance modifier — rises with board level, so later
    // boards give better odds. Applied on top of each symbol's base+step curve.
    chanceGlobal: {
      DROP_PRICE_STEP: cfg.DROP_PRICE_STEP,
    },
    CLAIM_COST: cfg.CLAIM_COST,
    refer: {
      REFER_VOLUME_THRESHOLD_SOL: cfg.REFER_VOLUME_THRESHOLD_SOL,
      REFER_POINTS_FOR_GRENADE: cfg.REFER_POINTS_FOR_GRENADE,
      REFER_GRENADE_REWARD: cfg.REFER_GRENADE_REWARD,
      REFER_POINTS_FOR_MISSILE: cfg.REFER_POINTS_FOR_MISSILE,
      REFER_MISSILE_REWARD: cfg.REFER_MISSILE_REWARD,
      REFER_POINTS_FOR_NUKE: cfg.REFER_POINTS_FOR_NUKE,
      REFER_NUKE_REWARD: cfg.REFER_NUKE_REWARD,
      symbols: Object.fromEntries(SYMBOLS.map((s) => {
        const K = s.toUpperCase();
        return [s, {
          points: cfg[`REFER_POINTS_FOR_${K}`],
          reward: cfg[`REFER_${K}_REWARD`],
          emoji: SYMBOL_EMOJI[s],
        }];
      })),
    },
    token: {
      TOKEN_MINT: cfg.TOKEN_MINT ?? "",
      TOKEN_DECIMALS: cfg.TOKEN_DECIMALS,
      DEFAULT_TOKEN_USD: cfg.DEFAULT_TOKEN_USD,
      DEFAULT_SOL_USD: cfg.DEFAULT_SOL_USD,
    },
    // Maintenance mode state (live from board_state) — NOT cached in config.
    maintenance: {
      isMaintenance: Boolean(boardRow.is_maintenance),
      maintenanceStartedAtMs:
        boardRow.maintenance_started_at != null
          ? new Date(boardRow.maintenance_started_at).getTime()
          : null,
    },
    sla: {
      QUEUE_TTL_SEC: cfg.QUEUE_TTL_SEC,
      SOL_TOLERANCE: cfg.SOL_TOLERANCE,
    },
    admins: getAdminWallets(),
  };
}

export async function adminRoutes(app: FastifyInstance) {
  // Admin auth routes: /admin/nonce, /admin/login, /admin/logout, /admin/me
  await app.register(adminAuthRoutes);

  // Dev free-paint: an admin places a pixel without paying.
  app.post("/paint", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const parsed = PaintSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const signer = (req as any).adminWallet as string;
    const { x, y } = parsed.data;
    const board = await ensureBoard();
    if (x >= board.size || y >= board.size) {
      return reply.code(400).send({ error: "off_board" });
    }
    const markedOwner = `dev:${signer}`;
    await pool.query(
      `INSERT INTO cells (x, y, owner, mult, last_buy_ts, buy_count, is_kol)
       VALUES ($1,$2,$3,1,NULL,0,false)
       ON CONFLICT (x,y) DO UPDATE SET owner=EXCLUDED.owner, mult=1, last_buy_ts=NULL, buy_count=0`,
      [x, y, markedOwner]
    );
    bumpCache(["cells", "leaderboard"]);
    {
      const { broadcastCellPatch, broadcastLeaderboard } = await import("./broadcast");
      broadcastCellPatch({ x, y, owner: markedOwner, mult: 1, buy_count: 0, is_kol: false, is_gold: false, last_buy_ts: null, last_paid_sol: null, nuke_dropped: false });
      await broadcastLeaderboard();
    }
    return reply.send({ ok: true, x, y, owner: markedOwner });
  });

  // Manual board resize (optional — ticks auto-grow). The BOARD_SIZES list INDEX is
  // authoritative: it both grows and shrinks. When the target index is unknown it's
  // resolved via a shadow level: > current → the first bigger, < current → the last
  // smaller, == current → no-op.
  app.post("/admin/expand", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const body = (req.body ?? {}) as { toLevel?: number; toIndex?: number; toSize?: number };
    const board = await ensureBoard();
    const sizes = (config as any).BOARD_SIZES as number[];
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return reply.code(500).send({ error: "no_board_sizes" });
    }
    const curIndexRaw = indexOfSize(board.size);
    // Position resolution: if the size is in the list use the exact index, otherwise
    // (legacy DB state) slide to the nearest bigger index — otherwise level/price
    // drift apart from the index. An ID that exactly matches the list.
    const curSize = board.size;
    const curIndex = curIndexRaw ?? sizes.findIndex((s) => s >= curSize);
    // Legacy anchor-heal: the old tick state mixed level with size (e.g. size 9 →
    // level 9, but 9's index in the list is 4). When switching to index-authority,
    // make the stored level/price index-consistent — otherwise a grow looks like it
    // "got cheaper".
    const healedLevel = Math.max(0, curIndex);
    if (Number(board.level) !== healedLevel) {
      const healedSol = perPxSolForLevel(healedLevel);
      await pool.query(
        `UPDATE board_state SET level=$1, per_px_sol=$2 WHERE id=1 AND size=$3`,
        [healedLevel, healedSol, curSize]
      );
      board.level = healedLevel;
      (board as any).per_px_sol = String(healedSol);
    }
    let targetIndex: number;
    if (typeof body.toSize === "number" && Number.isInteger(body.toSize)) {
      // Direct target size — must be in the list (otherwise the nearest threshold is meaningless, reject).
      targetIndex = indexOfSize(body.toSize) ?? -1;
      if (targetIndex < 0) {
        return reply.code(400).send({ error: "invalid_size", sizes });
      }
    } else if (typeof body.toIndex === "number" && Number.isInteger(body.toIndex)) {
      targetIndex = body.toIndex;
    } else if (typeof body.toLevel === "number" && Number.isInteger(body.toLevel)) {
      const lv = body.toLevel;
      // Shadow-level resolution: if the target size is in the list use the exact
      // index, otherwise the first index at the threshold.
      targetIndex = indexOfSize(lv) ?? -1;
      if (targetIndex < 0) {
        const above = sizes.findIndex((s) => s > curSize);
        if (lv > curSize) {
          targetIndex = above >= 0 ? above : sizes.length;
        } else {
          const below = sizes.findIndex((s) => s >= lv && s < curSize);
          targetIndex = below >= 0 ? below : sizes.length;
        }
      }
    } else {
      const above = sizes.findIndex((s) => s > curSize);
      targetIndex = above >= 0 ? above : sizes.length;
    }
    if (targetIndex >= sizes.length) {
      return reply.send({ ok: true, alreadyMax: true, level: curSize, size: curSize, perPxSol: Number(board.per_px_sol), index: curIndex });
    }
    const idx = Math.max(0, targetIndex);
    const targetSize = sizes[idx];
    const level = Math.max(0, idx);
    const perPxSol = perPxSolForLevel(level);
    if (targetSize === curSize) {
      return reply.send({ ok: true, alreadyMax: true, level, size: curSize, perPxSol: Number(board.per_px_sol), index: idx });
    }
    const shrinking = targetSize < curSize;
    await pool.query(
      `UPDATE board_state SET level=$1, size=$2, per_px_sol=$3, expanding=false, expand_deadline=NULL, shrink_deadline=NULL WHERE id=1`,
      [level, targetSize, perPxSol]
    );
    bumpCache(["cells", "leaderboard"]);
    await logEvent({
      type: "shrink",
      x: targetSize,
      y: level,
      owner: null,
      amount_sol: null,
      amount_usd: null,
      prior_owner: null,
      meta: { newLevel: level, size: targetSize, direction: shrinking ? "shrink" : "expand" },
    });
    {
      const { publish } = await import("./views");
      publish({ type: shrinking ? "shrink" : "expansion", x: targetSize, y: level, owner: null, meta: { newLevel: level, size: targetSize, direction: shrinking ? "shrink" : "expand" } });
    }
    {
      const { broadcastBoardSnapshot, broadcastCellsFull } = await import("./broadcast");
      await Promise.all([broadcastBoardSnapshot(), broadcastCellsFull()]);
    }
    return reply.send({ ok: true, level, size: targetSize, perPxSol, index: idx, shrinking });
  });

  // KOL list: view / upsert
  app.get("/admin/kols", { preHandler: requireAdmin(app) }, async (_req, reply) => {
    const { rows } = await pool.query(`SELECT addr, name, avatar, x_handle FROM kol_list ORDER BY name`);
    return reply.send({ kols: rows });
  });
  app.post("/admin/kol", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const body = (req.body ?? {}) as { addr?: string; name?: string; avatar?: string; x?: string };
    if (!body.addr || !body.name) {
      return reply.code(400).send({ error: "invalid" });
    }
    await pool.query(
      `INSERT INTO kol_list (addr, name, avatar, x_handle) VALUES ($1,$2,$3,$4)
       ON CONFLICT (addr) DO UPDATE SET name=EXCLUDED.name, avatar=EXCLUDED.avatar, x_handle=EXCLUDED.x_handle`,
      [body.addr, body.name, body.avatar ?? null, body.x ?? null]
    );
    return reply.send({ ok: true });
  });

  // Symbol drop stock (admin, per-symbol)
  app.post("/admin/nuke-pool", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const b = (req.body ?? {}) as { symbol?: string; set?: number; delta?: number };
    const symbol = b.symbol ?? "nuke";
    if (!isSymbol(symbol)) return reply.code(400).send({ error: "invalid_symbol" });
    if (typeof b.set === "number") {
      const s = Math.max(0, Math.floor(b.set));
      await pool.query(`UPDATE nuke_config SET available=$1, updated_at=now() WHERE symbol=$2`, [s, symbol]);
    } else if (typeof b.delta === "number") {
      const d = Math.floor(b.delta);
      await pool.query(`UPDATE nuke_config SET available = GREATEST(0, available + $1), updated_at=now() WHERE symbol=$2`, [d, symbol]);
    } else {
      return reply.code(400).send({ error: "need_set_or_delta" });
    }
    const { rows } = await pool.query(`SELECT available FROM nuke_config WHERE symbol=$1`, [symbol]);
    return reply.send({ ok: true, symbol, available: Number(rows[0]?.available ?? 0) });
  });

  // --- Maintenance mode toggle (launch ops) -----------------------------------
  // ON  → is_maintenance=true, maintenance_started_at=now() (freeze boundary). The board
  //       broadcasts a snapshot so every tab locks with the "Under maintenance" overlay;
  //       /quote returns 503 (new purchases closed) while /confirm stays open (escrow funds).
  // OFF → is_maintenance=false, maintenance_started_at=NULL (kickoff).
  //
  // LAUNCH NOTE: the cooldown RESET (every cell last_buy_ts → now()) is intentionally NOT
  // done here — it's a single admin SQL statement run at launch gate, so it happens inside
  // the same transaction as the final config column/board-size set, not a one-off broadcast
  // that a crash could split into "flag off but cells still cooling". After the SQL runs,
  // fire this route with on:false (resets the flag + broadcasts) and the board is live.
  app.post("/admin/maintenance", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const b = (req.body ?? {}) as { on?: boolean; kickoff?: boolean };
    const desired = b.on ?? !(await ensureBoard()).is_maintenance; // toggle mode: no `on` → flip
    const kickoff = b.kickoff ?? true;
    const adminWallet = (req as any).adminWallet as string;
    const prev = await pool.query(`SELECT is_maintenance, maintenance_started_at FROM board_state WHERE id=1`);
    const wasOn = Boolean(prev.rows[0]?.is_maintenance);
    const anyChange = desired !== wasOn || Boolean(kickoff);

    if (desired && !wasOn) {
      await pool.query(
        `UPDATE board_state SET is_maintenance=true, maintenance_started_at=now() WHERE id=1`
      );
    } else if (!desired && wasOn) {
      if (kickoff) {
        // Full reset: every cell re-enters its cooldown from scratch as the game reopens.
        await pool.query(`UPDATE cells SET last_buy_ts=now()`);
      }
      await pool.query(`UPDATE board_state SET is_maintenance=false, maintenance_started_at=NULL WHERE id=1`);
    } else {
      // no actual flag flip → cooldown kickoff (broadcast the new start time to clients)
    }
    await logEvent({
      type: "maintenance",
      x: null,
      y: null,
      owner: adminWallet,
      amount_sol: null,
      amount_usd: null,
      prior_owner: null,
      meta: { on: desired, kickoff: desired ? false : kickoff },
    });

    // Cache: size is unchanged but every client must see the new freeze state immediately.
    bumpCache(["leaderboard"]);
    {
      const { publish } = await import("./views");
      publish({ type: "maintenance", on: desired, at: Date.now() });
    }
    {
      const { broadcastBoardSnapshot, broadcastCellsFull } = await import("./broadcast");
      // The snapshot is pushed even when the flag didn't flip — a kickoff run still wants
      // the board visible to all tabs the moment it happens (they'll show updated cooldown).
      await Promise.all([broadcastBoardSnapshot(), broadcastCellsFull()]);
    }
    {
      const fresh = await pool.query(`SELECT is_maintenance, maintenance_started_at FROM board_state WHERE id=1`);
      const row = fresh.rows[0];
      return reply.send({
        ok: true,
        changed: anyChange,
        isMaintenance: Boolean(row?.is_maintenance),
        maintenanceStartedAtMs: row?.maintenance_started_at ? new Date(row.maintenance_started_at).getTime() : null,
      });
    }
  });

  // --- Canvas-only reset (dev/test) ------------------------------------------
  // Wipes the game state but keeps the economy: cells (canvas), purchases (tx log),
  // events (live feed history) and intents (in-flight locks). Prize pools, nuke stock,
  // board_size/level, referrals and admins are ALL preserved. Meant for re-running
  // browser testing on a clean canvas without losing pool balances you funded manually.
  // Boşalma yayını, clientların 'purchase' overlay'lerini düşürmesi için intent_unlocked;
  // ve her tab'ın yeni boş boardu görmesi için (metrics + fill % güncellensin diye
  // leaderboard da bump'lanır) broadcast yapar. Üretimde KULLANMA — geri alınamaz.
  app.post("/admin/reset", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const board = await ensureBoard();
    if (board.is_maintenance) {
      return reply.code(409).send({ error: "maintenance", message: "Reset sırasında bakım kapalı olmalı." });
    }
    // Capture who held symbols BEFORE wiping — after the COMMIT we signal each of
    // them so their clients' symbol badges drop to 0 immediately (useNukes only
    // refetches on `nukes_changed`, there is no periodic poll).
    let holdersRows: { owner: string }[] = [];
    await pool.query("BEGIN");
    try {
      // Full game-data wipe. Config & wallet-adjacent tables stay: app_config,
      // admin_wallets, admin_nonces, nuke_config (symbol drop stock), kol_list,
      // board_state, prize_pools. Anything the player can "hold, claim or regret"
      // is cleared — canvas, purchase/event logs, symbol inventory, referral codes
      // + their claims — INCLUDING in-flight distribution legs (pending/unconfirmed/
      // confirmed): those belong to the pre-reset canvas and firing them after the
      // wipe would drain escrow for positions that no longer exist. referral_codes
      // must go LAST (referrals + referral_claims FK-reference it).
      await pool.query(`DELETE FROM intents`);
      await pool.query(`DELETE FROM purchases`);
      await pool.query(`DELETE FROM events`);
      await pool.query(`DELETE FROM cells`);
      await pool.query(`DELETE FROM pending_distributions`);
      const holders = await pool.query(`DELETE FROM nuke_holders RETURNING owner`);
      holdersRows = holders.rows;
      await pool.query(`DELETE FROM nuke_events`);
      await pool.query(`DELETE FROM claim_nonces`);
      await pool.query(`DELETE FROM refer_claim_nonces`);
      await pool.query(`DELETE FROM referral_claims`);
      await pool.query(`DELETE FROM referrals`);
      await pool.query(`DELETE FROM referral_bind_nonces`);
      await pool.query(`DELETE FROM referral_codes`);
      await pool.query("COMMIT");
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
    // Invalidate EVERY mutation-driven cache. The cells cache in particular: if we
    // don't bump it, broadcastCellsFull (and the 30s heartbeat) serve the pre-reset
    // cells from memStore and the canvas stays populated even though the DB is empty.
    bumpCache(["cells", "leaderboard"]);
    // NOTE: no logEvent here. /events is wiped by this route — inserting a "reset"
    // row right after would put it into the live feed, which we don't want. The
    // reset itself is not a game event.
    {
      const { broadcastBoardSnapshot, broadcastCellsFull, signalNukesChanged } = await import("./broadcast");
      await Promise.all([
        broadcastBoardSnapshot(),
        broadcastCellsFull(),
        // Every owner whose symbols just got wiped gets `nukes_changed` so their
        // client refetches /quote and shows 0 — otherwise a stale badge lingers even
        // though the backend already returned their inventory.
        ...holdersRows.map((r) => signalNukesChanged(r.owner)),
      ]);
    }
    return reply.send({ ok: true, size: board.size, level: board.level });
  });

  // Prize pool manual top-up (admin)
  app.post("/admin/pool-topup", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; sol?: number };
    if (!b.id || !["small", "mid", "big"].includes(b.id) || typeof b.sol !== "number") {
      return reply.code(400).send({ error: "invalid" });
    }
    await pool.query(
      `UPDATE prize_pools SET balance_sol = balance_sol + $1, updated_at=now() WHERE id=$2`,
      [b.sol, b.id]
    );
    const { rows } = await pool.query(`SELECT id, balance_sol FROM prize_pools WHERE id=$1`, [b.id]);
    bumpCache(["pools"]);
    {
      const { broadcastPools } = await import("./broadcast");
      await broadcastPools();
    }
    return reply.send({ ok: true, pool: rows[0] });
  });

  // --- User claim (public — the user takes their own payout) ------------------
  // Each pool requires its own symbol (small→grenade, mid→missile, big→nuke),
  // CLAIM_COST each. Two steps: /claim-propose escrows a nonce → the wallet signs
  // → /claim verifies. Previously a plain {owner,pool} body rerouted a payout to an
  // arbitrary address (pool drain).
  app.post("/claim-propose", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = (req.body ?? {}) as { owner?: string; pool?: string };
    const owner = b.owner ?? "";
    const poolId = b.pool ?? "";
    if (!owner || !["small", "mid", "big"].includes(poolId)) {
      return reply.code(400).send({ error: "invalid" });
    }
    let _pk: PublicKey;
    try { _pk = new PublicKey(owner); } catch { return reply.code(400).send({ error: "invalid_owner" }); }
    // A single active escrow per owner (prevents double-claim at the nonce level).
    await pool.query(`DELETE FROM claim_nonces WHERE owner=$1`, [owner]);
    const nonce = randomBytes(32).toString("hex");
    const created = await pool.query(
      `INSERT INTO claim_nonces (owner, pool, nonce, expires_at) VALUES ($1,$2,$3, now() + $4::interval) RETURNING created_at`,
      [owner, poolId, nonce, `${CLAIM_NONCE_TTL_MS} milliseconds`]
    );
    return reply.send({
      ok: true,
      nonce,
      proposedAt: created.rows[0].created_at.toISOString(),
      expiredAt: new Date(Date.now() + CLAIM_NONCE_TTL_MS).toISOString(),
      message: claimMessage(owner, poolId, nonce),
    });
  });

  app.post("/claim", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = (req.body ?? {}) as { owner?: string; pool?: string; proposedAt?: string; signature?: string };
    const owner = b.owner ?? "";
    const poolId = b.pool ?? "";
    const { proposedAt, signature } = b;
    if (!owner || !["small", "mid", "big"].includes(poolId)) {
      return reply.code(400).send({ error: "invalid" });
    }
    if (!proposedAt || !signature) {
      return reply.code(422).send({ error: "signature_required", message: "Sign the claim attempt first." });
    }
    const escrow = await pool.query(
      `SELECT nonce, pool, created_at FROM claim_nonces WHERE owner=$1 AND pool=$2 ORDER BY created_at DESC LIMIT 1`,
      [owner, poolId]
    );
    const row = escrow.rows[0];
    if (!row) {
      return reply.code(409).send({ error: "propose_required", message: "Start a claim attempt first." });
    }
    const expected = claimMessage(owner, poolId, row.nonce);
    if (proposedAt !== row.created_at.toISOString()) {
      return reply.code(409).send({ error: "stale_proposal", message: "This claim attempt is stale — start over." });
    }
    let pubBytes: Uint8Array;
    try { pubBytes = new PublicKey(owner).toBytes(); }
    catch { return reply.code(400).send({ error: "invalid_owner" }); }
    let sigBytes: Uint8Array;
    try { sigBytes = bs58.decode(signature); }
    catch { return reply.code(401).send({ error: "bad_signature" }); }
    const valid = nacl.sign.detached.verify(Buffer.from(expected, "utf8"), sigBytes, pubBytes);
    if (!valid) {
      return reply.code(401).send({ error: "bad_signature", message: "Signature could not be verified — you're not the wallet owner." });
    }
    // Signature verified; consume the nonce single-use. Then the payout.
    const symbol = POOL_SYMBOL[poolId as "small" | "mid" | "big"];
    const cost = (config.CLAIM_COST as any)[poolId] as number;
    const client = await pool.connect();
    let payoutSol = 0;
    try {
      await client.query("BEGIN");
      const readLock = await client.query(
        `SELECT balance_sol FROM prize_pools WHERE id=$1 FOR UPDATE`,
        [poolId]
      );
      payoutSol = Number(readLock.rows[0]?.balance_sol ?? 0);
      if (payoutSol <= 0) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "pool_empty" });
      }
      const dec = await client.query(
        `UPDATE nuke_holders SET count = count - $1
         WHERE owner=$2 AND symbol=$3 AND count >= $1 RETURNING count`,
        [cost, owner, symbol]
      );
      if ((dec.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "not_enough_nukes", need: cost, symbol });
      }
      // Zero the balance BEFORE committing, then let the reconciler pay. payoutFromPool
      // only enqueues a pool_payout leg (DB write, NO RPC inside this txn) — so the
      // atomic pool-zeroing + this commit can never be rolled back by a failed send.
      // If the reconciler's send later fails, the pending_distributions row retries
      // and the balance is never drained twice (idempotent by status='pending').
      await client.query(
        `UPDATE prize_pools SET balance_sol = 0, updated_at=now() WHERE id=$1`,
        [poolId]
      );
      await payoutFromPool(owner, payoutSol);
      await client.query(
        `INSERT INTO nuke_events (kind, owner, pool, symbol, nukes, sol, tx_sig) VALUES ('claim',$1,$2,$3,$4,$5,NULL)`,
        [owner, poolId, symbol, cost, payoutSol]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await pool.query(`DELETE FROM claim_nonces WHERE owner=$1`, [owner]);
    const claimEv = { type: "claim", x: null, y: null, owner, amount_sol: payoutSol, amount_usd: null, prior_owner: null, meta: { symbolsSpent: cost, pool: poolId } };
    await logEvent(claimEv as any);
    publish(claimEv);
    bumpCache(["pools"]);
    {
      const { broadcastPools, signalNukesChanged } = await import("./broadcast");
      await broadcastPools();
      signalNukesChanged(owner);
    }
    return reply.send({ ok: true, payoutSol, txSig: null, payoutQueued: true, pool: poolId, symbolsSpent: cost, symbol });
  });

  // --- Admin Config UI --------------------------------------------------------
  // SECURED: it used to be unauthenticated and leaked deadWallet/treasury/admins.
  app.get("/admin/config", { preHandler: requireAdmin(app) }, async (_req, reply) => {
    const board = await ensureBoard();
    return reply.send({
      ...(await fullConfigSnapshot()),
      current: { level: board.level, size: board.size, perPxSol: Number(board.per_px_sol) },
    });
  });

  // Batch config update. If validation fails, the whole batch is rejected (400).
  app.patch("/admin/config", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const body = (req.body ?? {}) as { changes?: Record<string, unknown> };
    const changes = body.changes ?? {};
    if (Object.keys(changes).length === 0) {
      return reply.code(400).send({ error: "no_changes" });
    }
    const errors = validateConfigChanges(changes);
    if (errors.length > 0) {
      return reply.code(400).send({ error: "validation_failed", errors });
    }
    // Reject POOL_WALLET changes: new keypairs (except modern 64-byte cosigner
    // schemes — those are derivable via Keypair.of) use 47-byte transaction
    // signatures; if the changed address no longer matches the backend's POOL_KEYPAIR,
    // your market payout falls back to escrow (payoutFromPool → escrow fallback).
    // The address already comes from env; changing it via the DB creates that
    // mismatch — so it's locked.
    if (Object.prototype.hasOwnProperty.call(changes, "POOL_WALLET")) {
      return reply.code(400).send({
        error: "POOL_WALLET_locked",
        message: "POOL_WALLET is locked — it's set via env (POOL_WALLET); it must match the keypair.",
      });
    }
    const adminWallet = (req as any).adminWallet as string;
    for (const [key, value] of Object.entries(changes)) {
      await updateConfigKey(key, value, adminWallet);
    }
    await refreshConfig();
    bumpCache(["leaderboard", "pools"]);
    const board = await ensureBoard();
    // When BASE_SOL / PER_PX_MULT change, recompute the per-pixel price and persist
    // it — otherwise board_state.per_px_sol stays stale until the next expansion and
    // /board, /price, TopBar, PixelPanel all show the old price.
    const freshSol = perPxSolForLevel(board.level);
    if (Math.abs(Number(board.per_px_sol) - freshSol) > 1e-12) {
      await pool.query(`UPDATE board_state SET per_px_sol=$1 WHERE id=1`, [freshSol]);
    }
    // NOTE: changing POOL_WEIGHT_* doesn't touch existing balances. Jackpot logic:
    // a pool zeroed after a claim — or an existing balance — stays as-is; the weight
    // only affects the split of future pool shares. The initial split is configured
    // before the game starts (while pools are empty).
    const refreshed = await ensureBoard();
    return reply.send({
      ...(await fullConfigSnapshot()),
      current: { level: refreshed.level, size: refreshed.size, perPxSol: Number(refreshed.per_px_sol) },
    });
  });

  // Admin list: add / remove
  app.post("/admin/admins", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const b = (req.body ?? {}) as { wallet?: string; label?: string };
    if (!b.wallet) return reply.code(400).send({ error: "missing_wallet" });
    try { new PublicKey(b.wallet); } catch { return reply.code(400).send({ error: "invalid_wallet" }); }
    const adminWallet = (req as any).adminWallet as string;
    try {
      await pool.query(
        `INSERT INTO admin_wallets (wallet, label, added_by) VALUES ($1,$2,$3)
         ON CONFLICT (wallet) DO UPDATE SET label=EXCLUDED.label`,
        [b.wallet, b.label ?? null, adminWallet]
      );
    } catch (e) {
      return reply.code(409).send({ error: "add_failed" });
    }
    await refreshConfig();
    return reply.send({ ok: true, admins: getAdminWallets() });
  });

  app.delete("/admin/admins/:wallet", { preHandler: requireAdmin(app) }, async (req, reply) => {
    const wallet = (req.params as any).wallet as string;
    if (!wallet) return reply.code(400).send({ error: "missing_wallet" });
    const adminWallet = (req as any).adminWallet as string;
    if (wallet === adminWallet) {
      return reply.code(400).send({ error: "cannot_remove_self" });
    }
    const count = await pool.query(`SELECT count(*)::int AS n FROM admin_wallets`);
    if (Number(count.rows[0]?.n ?? 0) <= 1) {
      return reply.code(400).send({ error: "cannot_remove_last_admin" });
    }
    await pool.query(`DELETE FROM admin_wallets WHERE wallet=$1`, [wallet]);
    await refreshConfig();
    return reply.send({ ok: true, admins: getAdminWallets() });
  });
}