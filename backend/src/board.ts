import pool from "./db";
import { config } from "./config";
import { nextBoardSize, perPxSolForLevel, boardCeiling, indexOfSize, roundSol } from "./pricing";
import { refreshConfig } from "./configStore";
import { bumpCache } from "./memStore";

export interface BoardState {
  level: number;
  size: number;
  per_px_sol: number;
  expanding: boolean;
  expand_deadline: string | null;
  shrink_deadline: string | null;
  is_maintenance: boolean;
  maintenance_started_at: string | null;
}

export interface LiveBoard {
  level: number;
  size: number;
  perPxSol: number;
  fillPercent: number;
  occupied: number;
  expanding: boolean;
  expandDeadlineSec: number | null;
  /** Absolute expiry (epoch ms) — lets the frontend tick the countdown locally between
   *  heartbeats instead of freezing on the last remaining-seconds value. */
  expandDeadlineMs: number | null;
  shrinkDeadlineSec: number | null;
  shrink_state: "none" | "countdown" | null;
  /** Maintenance freeze: when true, time stands still (game paused).
   *  Next buy-up court is closed (quote → 503) until it flips OFF. */
  isMaintenance: boolean;
  /** Maintenance started (epoch ms) — the freeze boundary + "when did it start" for the admin. */
  maintenanceStartedAtMs: number | null;
}

let boardCache: BoardState | null = null;

/** Seed board_state if it's missing from the DB + migrate missing columns from older schemas. */
export async function ensureBoard(): Promise<BoardState> {
  // shrink_deadline was added in V2.2 — old rows lack the column. Idempotent migrate
  // on every call (the column gets added on the first call, no-op afterwards). Keep it in the same race as the INSERT.
  // Maintenance freeze columns landed in V2.4 (launch ops) — same idempotent ADD.
  await pool.query(
    `ALTER TABLE board_state ADD COLUMN IF NOT EXISTS shrink_deadline TIMESTAMPTZ`
  );
  await pool.query(
    `ALTER TABLE board_state ADD COLUMN IF NOT EXISTS is_maintenance BOOLEAN NOT NULL DEFAULT false`
  );
  await pool.query(
    `ALTER TABLE board_state ADD COLUMN IF NOT EXISTS maintenance_started_at TIMESTAMPTZ`
  );
  const { rows } = await pool.query("SELECT * FROM board_state WHERE id = 1");
  if (rows.length > 0) {
    boardCache = rows[0];
    return rows[0] as BoardState;
  }
  await pool.query(
    `INSERT INTO board_state (id, level, size, per_px_sol, expanding)
     VALUES (1, 0, $1, $2, false)
     ON CONFLICT (id) DO NOTHING`,
    [config.BOARD_SIZES[0] ?? 5, perPxSolForLevel(0)]
  );
  const again = await pool.query("SELECT * FROM board_state WHERE id = 1");
  boardCache = again.rows[0];
  return again.rows[0] as BoardState;
}

export async function liveBoard(): Promise<LiveBoard> {
  const board = await ensureBoard();
  const size = board.size;
  const occupied = Number(
    (await pool.query("SELECT count(*) AS n FROM cells WHERE owner IS NOT NULL")).rows[0].n
  );
  const fillPercent = Math.min(1, occupied / boardCeiling(size));
  return {
    level: board.level,
    size,
    perPxSol: roundSol(Number(board.per_px_sol)),
    fillPercent,
    occupied,
    expanding: board.expanding,
    expandDeadlineSec:
      board.expand_deadline && board.expanding
        ? Math.max(0, Math.floor((new Date(board.expand_deadline).getTime() - Date.now()) / 1000))
        : null,
    expandDeadlineMs:
      board.expand_deadline && board.expanding
        ? new Date(board.expand_deadline).getTime()
        : null,
    shrinkDeadlineSec:
      board.shrink_deadline != null
        ? Math.max(0, Math.floor((new Date(board.shrink_deadline).getTime() - Date.now()) / 1000))
        : null,
    shrink_state:
      board.shrink_deadline != null && new Date(board.shrink_deadline).getTime() > Date.now()
        ? "countdown"
        : null,
    isMaintenance: Boolean(board.is_maintenance),
    maintenanceStartedAtMs: board.maintenance_started_at
      ? new Date(board.maintenance_started_at).getTime()
      : null,
  };
}

/**
 * Expansion controller. If fill reaches %FILL_EXPAND_THRESHOLD and an expand hasn't
 * started yet, arm the deadline and start it.
 * Once the deadline passes, move the board to the next level and double the per-pixel price.
 * Returns the latest state on every call.
 */
export async function tickExpansions(): Promise<LiveBoard> {
  // Multi-instance drift protection: refresh live config on every tick (cheap DB read).
  await refreshConfig();
  const board = await ensureBoard();
  const now = Date.now();
  const deadline = board.expand_deadline ? new Date(board.expand_deadline).getTime() : null;
  const deadlinePassed = deadline !== null && now >= deadline;

  if (deadlinePassed && board.expanding) {
    const next = nextBoardSize(board.size);
    if (next == null) {
      // Size list exhausted — the board stays at its current size (never shrinks),
      // clear the expansion state (don't re-trigger / deadlock).
      await pool.query(`UPDATE board_state SET expanding=false, expand_deadline=NULL WHERE id=1`);
      boardCache = null;
      return liveBoard();
    }
    // Index-fit: when growing to a size already in the list, use the exact index —
    // so level/price stay consistent with re-growths after a shrink.
    // (We're growing to a size already in the list — indexOfSize never returns null.)
    const level = indexOfSize(next) ?? Math.max(board.level + 1, next);
    await pool.query(
      `UPDATE board_state SET level=$1, size=$2, per_px_sol=$3, expanding=false, expand_deadline=NULL, shrink_deadline=NULL
       WHERE id=1`,
      [level, next, perPxSolForLevel(level)]
    );
    boardCache = null;
    await logEvent({
      type: "expansion",
      x: next,
      y: level,
      owner: null,
      amount_sol: null,
      amount_usd: null,
      prior_owner: null,
      meta: { newLevel: level, size: next },
    });
    {
      const { publish } = await import("./views");
      publish({ type: "expansion", x: next, y: level, owner: null, meta: { newLevel: level, size: next } });
    }
    // Size changed → push the global board + cells snapshots (clients re-measure).
    // Cache: cells outside the new size invalid + level changed → valueSol refreshes.
    bumpCache(["cells", "leaderboard"]);
    {
      const { broadcastBoardSnapshot, broadcastCellsFull } = await import("./broadcast");
      await Promise.all([broadcastBoardSnapshot(), broadcastCellsFull()]);
    }
    return liveBoard();
  }

  if (!board.expanding && !deadlinePassed && !board.shrink_deadline) {
    const live = await liveBoard();
    if (live.fillPercent >= config.FILL_EXPAND_THRESHOLD && nextBoardSize(live.size) != null) {
      const started = new Date();
      const dead = new Date(started.getTime() + config.FILL_EXPAND_SECONDS * 1000);
      await pool.query(
        `UPDATE board_state SET expanding=true, expand_started=$1, expand_deadline=$2 WHERE id=1`,
        [started, dead]
      );
      boardCache = null;
      await logEvent({
        type: "expansion_start",
        x: live.size,
        y: live.level,
        owner: null,
        amount_sol: null,
        amount_usd: null,
        prior_owner: null,
        meta: { seconds: config.FILL_EXPAND_SECONDS },
      });
      {
        const { publish } = await import("./views");
        publish({
          type: "expansion_start",
          x: live.size,
          y: live.level,
          owner: null,
          meta: { seconds: config.FILL_EXPAND_SECONDS },
        });
      }
      return liveBoard();
    }
  }

  return liveBoard();
}

// --- Event log (SSE bus) ------------------------------------------------------

export interface LogEvent {
  type: string;
  x: number | null;
  y: number | null;
  owner: string | null;
  amount_sol: number | null;
  amount_usd: number | null;
  prior_owner: string | null;
  meta?: Record<string, any> | null;
}

export async function logEvent(e: LogEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO events (type, x, y, owner, amount_sol, amount_usd, prior_owner, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.type, e.x, e.y, e.owner, e.amount_sol, e.amount_usd, e.prior_owner, e.meta ?? null]
    );
  } catch {
    // the event log queue must never block a purchase
  }
}
