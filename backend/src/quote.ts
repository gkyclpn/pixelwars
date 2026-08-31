import { FastifyInstance } from "fastify";
import { z } from "zod";
import pool from "./db";
import { config } from "./config";
import { priceForCell, decayedMult, cooldownLeftSec, nukeProb, dropProb } from "./pricing";
import { liveBoard } from "./board";
import { SYMBOLS } from "./symbols";

/**
 * Single-pixel purchase quote + lock.
 * The buyer sends SOL to the escrow (memo = quoteId); confirmation does an atomic claim.
 */
export async function quoteRoutes(app: FastifyInstance) {
  const QuoteSchema = z.object({
    owner: z.string().min(32).max(48),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  });

  app.post("/quote", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = QuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { owner, x, y } = parsed.data;

    const board = await liveBoard();
    // Maintenance lock: the game is paused — no new purchases until the admin flips it off.
    // /confirm stays reachable (funds already in escrow must still resolve).
    if (board.isMaintenance) {
      return reply.code(503).send({
        error: "maintenance",
        message: "The board is under maintenance — purchases are paused. We'll be back shortly.",
        isMaintenance: true,
      });
    }
    if (x >= board.size || y >= board.size) {
      return reply.code(400).send({
        error: "off_board",
        message: `The board is currently ${board.size}x${board.size}. (${x},${y}) is outside it.`,
      });
    }

    // Golden pixel check — it can never be bought again
    const cell = await pool.query(
      `SELECT owner, mult, last_buy_ts, buy_count, is_kol, is_gold FROM cells WHERE x=$1 AND y=$2`,
      [x, y]
    );
    const row = cell.rows[0];
    if (row?.is_gold) {
      return reply.code(423).send({
        error: "golden_pixel",
        message: "This pixel is golden — it can no longer be bought.",
      });
    }

    // Block buying your own pixel (a user can't buy a cell they already own)
    if (row && row.owner === owner) {
      return reply.code(403).send({
        error: "already_owned",
        message: "This pixel is already yours — you can't buy your own pixel.",
      });
    }

    // Intent lock — atomic: delete expired, then INSERT ON CONFLICT DO NOTHING.
    // Two concurrent requests → one inserts, the other gets "already_locked".
    await pool.query(`DELETE FROM intents WHERE x=$1 AND y=$2 AND expires_at <= now()`, [x, y]);
    // Anti-bot: one active intent per owner (whole board — enforces uq_intents_owner_active).
    // Pre-check gives a clear "you already have a purchase in flight" message instead of
    // the generic already_locked; the partial unique index is the race-safe backstop.
    const ownerOpen = await pool.query(
      `SELECT 1 FROM intents WHERE owner=$1 AND expires_at > now() LIMIT 1`,
      [owner]
    );
    if (ownerOpen.rows.length > 0) {
      return reply.code(409).send({
        error: "intent_limit",
        message: "You already have a pending purchase — complete or cancel it first.",
      });
    }
    const quoteId = crypto.randomUUID();
    const expires = new Date(Date.now() + config.QUEUE_TTL_SEC * 1000);
    const claim = await pool.query(
      `INSERT INTO intents (quote_id, x, y, owner, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (x, y) DO NOTHING
       RETURNING quote_id`,
      [quoteId, x, y, owner, expires]
    );
    if ((claim.rowCount ?? 0) === 0) {
      return reply.code(409).send({
        error: "already_locked",
        message: "Someone bought this pixel before you.",
      });
    }

    // Surface the DB-level intent lock to EVERY client over SSE, so when a user
    // signs a purchase the pixel enters a loading/locked state visible to all —
    // nobody else buys it until the intent resolves (cell_patch) or expires
    // (clients clear the overlay locally on expiresAtSec, matching QUEUE_TTL_SEC).
    try {
      const { publish } = await import("./views");
      publish({
        type: "intent_locked",
        x,
        y,
        owner,
        quoteId,
        expiresAtSec: config.QUEUE_TTL_SEC,
      });
    } catch {
      // SSE is best-effort — a lost lock event only delays the overlay, never a purchase.
    }

    const priorOwner = row?.owner ?? null;
    const isKOL = Boolean(row?.is_kol);
    // Heat model: the stored mult decays over cooldown. Price is tied 1:1 to the
    // visible mult — when a pixel cools to 1x the price also returns to base×2
    // (as if freshly bought). After a gasp newMult = current × 2 (in verify.ts),
    // so a gasp is cheap while cold and expensive while hot — the next step is
    // current × 2.
    const currentMult = decayedMult(Number(row?.mult ?? 1), row?.last_buy_ts ?? null, Date.now(), Boolean(row?.is_gold));
    const price = priceForCell(currentMult, board.level, Boolean(priorOwner));
    // Nuke drop chance: based on current heat — the chance drops as it cools.
    const nProb = nukeProb(currentMult);
    // Next buy multiplier: empty → 1 (newly owned), owned → current × 2.
    const nextMult = priorOwner
      ? Math.min(config.MULT_CAP, currentMult * 2)
      : 1;

    return {
      quoteId,
      x,
      y,
      priceSol: price.sol,
      solPerPx: board.perPxSol,
      level: board.level,
      multiplier: currentMult,
      multiplierNext: nextMult,
      hasOwner: Boolean(priorOwner),
      priorOwner,
      isKOL,
      cooldownLeftSec: row?.last_buy_ts ? cooldownLeftSec(row.last_buy_ts, currentMult, Boolean(row?.is_gold)) : 0,
      nukeProb: nProb, // backwards-compatible
      probabilities: Object.fromEntries(SYMBOLS.map((s) => [s, dropProb(s, currentMult, board.level)])) as Record<string, number>,
      expiresInSec: config.QUEUE_TTL_SEC,
      instructions: {
        memo: `pixelwars:${quoteId}`,
      },
    };
  });

  app.post("/quote/:id/cancel", async (req, reply) => {
    const id = String((req.params as any).id);
    // Only the quote owner can cancel: quote_id knowledge must not let someone else
    // waste / ruin another person's 30s lock. owner comes in the body.
    const body = (req.body ?? {}) as { owner?: string };
    const owner = body.owner ?? "";
    if (!owner) return reply.code(422).send({ error: "owner_required" });
    const res = await pool.query(
      `DELETE FROM intents WHERE quote_id=$1 AND owner=$2 RETURNING x, y`,
      [id, owner]
    );
    if ((res.rowCount ?? 0) > 0) {
      // The lock is gone — broadcast an unlock so EVERY client (including the buyer
      // and any other window) drops the loading overlay right away instead of waiting
      // for the local 20s TTL prune.
      const { x, y } = res.rows[0];
      try {
        const { publish } = await import("./views");
        publish({ type: "intent_unlocked", x: Number(x), y: Number(y) });
      } catch {
        // SSE is best-effort — an unlock delay only risks a stale overlay, never a purchase.
      }
    }
    return reply.send({ ok: true, deleted: (res.rowCount ?? 0) > 0 });
  });

  // The user's held symbol counts (3 symbols).
  // Stock limits (MAX_<SYMBOL>_PER_PERSON) and the global stock pool (nuke_config.available)
  // are NOT shown in this public response — the user only sees their own count. Limits
  // are applied silently in the backend only (verify.ts maybeDropSymbol).
  app.get("/nukes/:owner", async (req, reply) => {
    const owner = String((req.params as any).owner);
    const { rows } = await pool.query(`SELECT symbol, count FROM nuke_holders WHERE owner=$1`, [owner]);
    const bySymbol = new Map(rows.map((r: any) => [r.symbol, Number(r.count)]));
    const counts = Object.fromEntries(
      SYMBOLS.map((s) => [s, { count: bySymbol.get(s) ?? 0 }])
    ) as Record<string, { count: number }>;
    return reply.send({
      owner,
      counts,
      count: bySymbol.get("nuke") ?? 0,
      cost: config.CLAIM_COST,
    });
  });
}

/**
 * Backend-authoritative intent-expiry sweep. Runs on the 30s board tick. An intent
 * that reaches its TTL is deleted unilaterally (no matching /confirm or /cancel) and
 * an `intent_unlocked` is broadcast — so EVERY tab (including tabs other than the one
 * that ran the purchase) drops its loading overlay deterministically, instead of
 * relying on each tab's local prune timer firing at its own skew. Without this, a
 * stale "Processing…" could persist on some viewers.
 */
export async function sweepExpiredIntents(): Promise<void> {
  const res = await pool.query(
    `DELETE FROM intents WHERE expires_at <= now() RETURNING x, y`
  );
  if ((res.rowCount ?? 0) === 0) return;
  try {
    const { publish } = await import("./views");
    for (const r of res.rows) {
      publish({ type: "intent_unlocked", x: Number(r.x), y: Number(r.y) });
    }
  } catch {
    // best-effort — the local prune timer still bounds a stale overlay
  }
}
