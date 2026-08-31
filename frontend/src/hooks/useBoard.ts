import { useEffect, useMemo, useState, useCallback } from "react";
import type { BoardState, PixelState, PendingIntentState } from "../types";
// import type { EventItem } from "../types"; // (commented original)
import { subscribe, getLastInit } from "./eventBus";
import { API_BASE } from "../api";

/** A pixel that's locked by someone's in-flight purchase. Keyed `${x},${y}`. */
export interface PendingIntent extends PendingIntentState {
  expiresAt: number;
}

/** Map an init/cells-payload intent (expiresAtSec is seconds-from-now) into time-absolute form. */
function hydrateIntent(i: PendingIntentState): PendingIntent {
  return { ...i, expiresAt: Date.now() + Math.max(1, i.expiresAtSec) * 1000 };
}

const API = API_BASE;

export function useBoard() {
  const [board, setBoard] = useState<BoardState | null>(null);
  // rawCells: STORED (undecayed) mults straight from the backend. Storing decay here
  // and re-applying it every second would cascade 4x → 2x → 1x, and the 30s cells_snapshot
  // heartbeat would restore the stored value, causing oscillation.
  // That's why we never write a DECAYED mult into state — decay is derived.
  const [rawCells, setRawCells] = useState<PixelState[]>([]);
  // A tick counter incremented every second — re-runs the useMemo.
  const [tick, setTick] = useState(0);
  // Pixels locked by an in-flight purchase (intent_locked → cell_patch / expiry).
  const [pendingIntents, setPendingIntents] = useState<Record<string, PendingIntent>>({});

  // Freeze guard: while the board is in maintenance, the 1s tick that drives the decay
  // spreadsheet is paused. The cells, once the pin goes ON, keep their last-computed
  // (stored-frozen) mult — no further decay, no jump. When it flips OFF the tick resumes
  // exactly as it was (tick is unchanged → cells useMemo re-fires with the now-current now).
  const maintenanceOn = Boolean(board?.isMaintenance);

  // SSE / cache seed: only stored (undecayed) data enters state.
  useEffect(() => {
    let hydrated = false;
    const cached = getLastInit();
    if (cached) {
      hydrated = true;
      setBoard(cached.board);
      setRawCells(cached.cells);
      setPendingIntents((cached.intents || []).map(hydrateIntent).reduce(indexByXY, {}));
    }
    const unsub = subscribe((ev) => {
      if (ev.type === "init") {
        hydrated = true;
        setBoard(ev.board);
        setRawCells(ev.cells);
        // Re-seed pending locks from the snapshot — this is what makes a freshly
        // opened tab show pixels that are already mid-purchase.
        setPendingIntents((ev.intents || []).map(hydrateIntent).reduce(indexByXY, {}));
      } else if (!hydrated) {
        return; // ignore global snapshots before init (reconnect race)
      } else if (ev.type === "board_snapshot") {
        setBoard(ev.board);
      } else if (ev.type === "cells_snapshot") {
        setRawCells(ev.cells);
      } else if (ev.type === "cell_patch") {
        setRawCells((prev) => upsertByXY(prev, ev.cell));
        // Purchase confirmed — clear the loading overlay for this pixel.
        setPendingIntents((prev) => {
          const k = `${ev.cell.x},${ev.cell.y}`;
          if (!prev[k]) return prev;
          const { [k]: _drop, ...rest } = prev;
          return rest;
        });
      } else if (ev.type === "intent_locked") {
        const k = `${ev.x},${ev.y}`;
        setPendingIntents((prev) => ({
          ...prev,
          [k]: hydrateIntent(ev),
        }));
      } else if (ev.type === "intent_unlocked") {
        // The buyer cancelled (or the lock resolved) — drop the overlay immediately
        // so the pixel is buyable again without waiting for the local TTL prune.
        const k = `${ev.x},${ev.y}`;
        setPendingIntents((prev) => {
          if (!prev[k]) return prev;
          const { [k]: _drop, ...rest } = prev;
          return rest;
        });
      }
    });
    return unsub;
  }, []);

  // Freeze the intent-overlay expiry: while maintenance is ON, time stands still — a lock
  // in-flight when the pin went ON must not race against a paused game. We re-hydrate each
  // lock's TTL every second from the board-freeze boundary: if the game froze at T, a lock
  // that had S sec left keeps S-left-of-T (its deadline becomes maintenanceStartedAt + TTL),
  // and if an entry points at a deadline BEFORE the freeze began (hard TTL elapse), it
  // expires with the rest of the game when the pin flips OFF.
  useEffect(() => {
    if (!maintenanceOn) return;
    const boundary = board?.maintenanceStartedAtMs ?? Date.now();
    setPendingIntents((prev) => {
      const next: Record<string, PendingIntent> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (v.expiresAt > boundary) next[k] = { ...v, expiresAt: boundary + 30000 };
        else next[k] = v;
      }
      return next;
    });
    // no interval: recompute on every board change (incl. boundary updates)
  }, [maintenanceOn, board?.maintenanceStartedAtMs, board?.isMaintenance, maintenanceOn === true ? Date.now() : 0]);

  // Prune expired locks locally (matches backend intent TTL — QUEUE_TTL_SEC).
  // If /confirm succeeds first, the cell_patch handler above clears the overlay
  // sooner; this timer is the safety net for signature-drop / user-abandon cases.
  // Threaded through the maintenance release (game.released) so a kept lock doesn't
  // expire early while the canvas is frozen.
  useEffect(() => {
    if (maintenanceOn) return; // frozen — no pruning while paused
    const t = setInterval(() => {
      setPendingIntents((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, PendingIntent> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v.expiresAt > now) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [maintenanceOn]);

  // Live heatmap tick: bumping the counter every second makes the useMemo recompute
  // decay from STORED values. No state mutation, no oscillation. Paused during maintenance.
  useEffect(() => {
    if (!board || maintenanceOn) return;
    const t = setInterval(() => setTick((n) => (n + 1) & 0xffff), 1000);
    return () => clearInterval(t);
  }, [board?.cooldownSeconds, board?.multDecayFactor, maintenanceOn, board?.isMaintenance]);

  // Derived cells: every tick maps stored → decayed mult (consumed by canvas/clients).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cells = useMemo(() => {
    if (!board) return rawCells;
    const cd = board.cooldownSeconds ?? 600;
    const factor = board.multDecayFactor ?? 0.5;
    const now = Date.now();
    return rawCells.map((c) => decayedMultNow(c, cd, factor, now));
  }, [rawCells, board, tick]);

  // Live expansion countdown: the backend sends the ABSOLUTE deadline (expandDeadlineMs)
  // so we tick down locally on our 1s clock. Without this, the shown countdown only
  // refreshed on each 30s board_snapshot — appearing frozen (worse in background tabs).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveBoard = useMemo(() => {
    if (!board) return board;
    if (board.expanding && board.expandDeadlineMs != null) {
      const left = Math.max(0, Math.ceil((board.expandDeadlineMs - Date.now()) / 1000));
      return { ...board, expandDeadlineSec: left };
    }
    return board;
  }, [board, tick]);

  // REST fallback — for invalidation/manual refresh (no bootstrap polling).
  const refresh = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([
        fetch(`${API}/board`).then((r) => r.json()),
        fetch(`${API}/cells`).then((r) => r.json()),
      ]);
      setBoard(b);
      setRawCells((c.cells || []) as PixelState[]);
      setPendingIntents(((c.intents || []) as PendingIntentState[]).map(hydrateIntent).reduce(indexByXY, {}));
    } catch { /* ignore */ }
  }, []);

  return { board, cells, liveBoard, refresh, pendingIntents };
}

/**
 * Exactly the same formula as backend pricing.decayedMult — the single decay source here.
 * MUST always be called with the stored mult (rawCells); an already-decayed output must
 * never be fed back in, or it compounds (4→2→1).
 */
function decayedMultNow(c: PixelState, cooldownSeconds: number, factor: number, now: number): PixelState {
  if (c.is_gold) return c;
  if (c.mult <= 1) return c;
  const last = c.last_buy_ts ? new Date(c.last_buy_ts).getTime() : 0;
  if (!last) return c;
  const elapsed = Math.max(0, (now - last) / 1000);
  const cycles = Math.floor(elapsed / Math.max(1, cooldownSeconds));
  if (cycles === 0) return c;
  const decayed = Math.max(1, c.mult * Math.pow(factor, cycles));
  if (decayed === c.mult) return c;
  return { ...c, mult: decayed };
}

function upsertByXY(arr: PixelState[], cell: PixelState): PixelState[] {
  const i = arr.findIndex((c) => c.x === cell.x && c.y === cell.y);
  if (i === -1) return [...arr, cell];
  const next = arr.slice();
  next[i] = cell;
  return next;
}

function indexByXY(
  acc: Record<string, PendingIntent>,
  pi: PendingIntent
): Record<string, PendingIntent> {
  acc[`${pi.x},${pi.y}`] = pi;
  return acc;
}
