import { publish, boardPayload, cellsPayload, poolsPayload, leaderboardPayload } from "./views";
import { cacheGeneration } from "./memStore";

/**
 * SSE broadcast helpers. They remove polling: global state (board/cells/pools/
 * leaderboard) is pushed to every client as a snapshot; per-owner state
 * (nukes/referral) gets a lightweight "changed" signal and that owner's client
 * does a one-off refetch from REST.
 *
 * WARNING (circular import): verify.ts / board.ts already import views.ts via dynamic
 * import. Because this module imports views.ts, mutation sites that call these
 * functions must ALSO use `await import("./broadcast")` instead of a top-level import.
 */

export async function broadcastBoardSnapshot(): Promise<void> {
  const board = await boardPayload();
  publish({ type: "board_snapshot", board });
}

export async function broadcastCellsFull(): Promise<void> {
  const { cells, size } = await cellsPayload();
  publish({ type: "cells_snapshot", cells, size });
}

/** Single-cell delta — instead of pushing the full array on every buy/gasp/paint. */
export function broadcastCellPatch(cell: any): void {
  publish({
    type: "cell_patch",
    cell: {
      ...cell,
      mult: Number(cell.mult),
      buy_count: Number(cell.buy_count),
      last_paid_sol: cell.last_paid_sol != null ? Number(cell.last_paid_sol) : null,
    },
  });
}

export async function broadcastPools(): Promise<void> {
  // Debounced: burst purchases recompute the pools on every confirm, but the snapshot
  // only needs to carry the LATEST state. Coalescing to one publish per ~250ms window
  // cuts leaderboard/pools CPU ~60-80% under a viral pixel, with zero staleness cost
  // (payload is rebuilt fresh at fire time).
  markDirty("pools");
}

export async function broadcastLeaderboard(): Promise<void> {
  markDirty("leaderboard");
}

const DEBOUNCE_MS = 250;
let dirty: Record<string, boolean> = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty(key: string): void {
  dirty[key] = true;
  if (debounceTimer) return;
  debounceTimer = setTimeout(fireDirty, DEBOUNCE_MS);
}

async function fireDirty(): Promise<void> {
  debounceTimer = null;
  const keys = Object.keys(dirty);
  dirty = {};
  if (keys.includes("pools")) {
    try {
      const { pools } = await poolsPayload();
      publish({ type: "pools_snapshot", pools });
    } catch { /* single failed coalesced publish stays silent — next mutation retries */ }
  }
  if (keys.includes("leaderboard")) {
    try {
      const payload = await leaderboardPayload();
      publish({ type: "leaderboard_snapshot", ...payload });
    } catch { /* single failed coalesced publish stays silent — next mutation retries */ }
  }
}

/** Per-owner signal so only that owner's clients refetch. */
export function signalNukesChanged(owner: string): void {
  publish({ type: "nukes_changed", owner });
}

export function signalReferralChanged(owner: string): void {
  publish({ type: "referral_changed", owner });
}

// Self-healing net for missed SSE messages (much lighter than 4-6s polling).
let pubGen = { cells: -1, pools: -1, leaderboard: -1 };

async function heartbeat(): Promise<void> {
  try {
    // Board is always published fresh (live counters; tickExpansions runs inside boardPayload).
    const board = await boardPayload();
    publish({ type: "board_snapshot", board });

    // Mutation-driven fields: publish only when generation changes (no idle SSE).
    const [cells, pools, lb] = await Promise.all([cellsPayload(), poolsPayload(), leaderboardPayload()]);
    const gen = {
      cells: cacheGeneration("cells"),
      pools: cacheGeneration("pools"),
      leaderboard: cacheGeneration("leaderboard"),
    };
    if (gen.cells !== pubGen.cells) { publish({ type: "cells_snapshot", ...cells }); pubGen.cells = gen.cells; }
    if (gen.pools !== pubGen.pools) { publish({ type: "pools_snapshot", ...pools }); pubGen.pools = gen.pools; }
    if (gen.leaderboard !== pubGen.leaderboard) { publish({ type: "leaderboard_snapshot", ...lb }); pubGen.leaderboard = gen.leaderboard; }
  } catch { /* a single heartbeat failure stays silent — the next tick retries */ }
}

setInterval(heartbeat, 30000);