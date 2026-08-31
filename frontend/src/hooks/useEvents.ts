import { useCallback, useEffect, useState } from "react";
import type { EventItem } from "../types";
import { subscribe, getLastInit } from "./eventBus";

export interface EventStreamOpts {
  /** max events kept in memory */
  max?: number;
  /** Your own wallet address — used to match gasps where you're the victim (prior_owner). */
  myOwner?: string | null;
}

/** Observer gasp-bubble threshold — gasps below this multiplier are feed lines only, not bubbles. */
const OBSERVER_GASP_MULT = 8;

export interface NotifItem extends EventItem {
  uid: string;
}

let uidCounter = 0;

/**
 * Collects real-time events from the SSE stream (via the eventBus singleton —
 * a single EventSource per tab).
 * `notifs` only surfaces important events: nuke_drop, gold, expansion,
 * expansion_start, claim. Gasp rule: if the pixel is YOURS (prior_owner ===
 * myOwner) every gasp is notified (you're the victim); for spectators only gasps
 * above OBSERVER_GASP_MULT bubble. Not every purchase is notified.
 */
export function useEvents(opts: EventStreamOpts = {}) {
  const max = opts.max ?? 40;
  const myOwner = opts.myOwner ?? null;
  const [recent, setRecent] = useState<EventItem[]>([]);
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  // Live SSE-connection count ≈ "active players". Seeded from init, refreshed on
  // every users_count broadcast (backend sends it only when the count changes).
  const [activeCount, setActiveCount] = useState<number | null>(null);

  useEffect(() => {
    // On mount, backfill the feed from the init snapshot (if present).
    const init = getLastInit();
    if (init) {
      setRecent((init.recent ?? []).slice(-max));
      if (typeof init.activeCount === "number") setActiveCount(init.activeCount);
    }

    const unsub = subscribe((parsed) => {
      if (parsed.type === "users_count") {
        setActiveCount(parsed.count);
        return;
      }
      if (parsed.type === "init" && Array.isArray(parsed.recent)) {
        setRecent(parsed.recent.slice(-max));
        if (typeof parsed.activeCount === "number") setActiveCount(parsed.activeCount);
        return;
      }
      // Only real user events enter the feed/channel. The control messages pushed by
      // the SSE heartbeat (board_snapshot / cells_snapshot / pools_snapshot /
      // leaderboard_snapshot / cell_patch / nukes_changed / referral_changed) must not
      // land in the feed, or they'd render as "json" rows.
      if (!isFeedEvent(parsed)) return;
      const ev = parsed as EventItem;
      if (!ev.ts) ev.ts = new Date().toISOString();
      setRecent((prev) => [...prev.slice(-(max - 1)), ev]);
      const isMineGasp = ev.type === "gasp" && myOwner != null && ev.prior_owner === myOwner;
      const isBig =
        ev.type === "grenade_drop" ||
        ev.type === "missile_drop" ||
        ev.type === "nuke_drop" ||
        ev.type === "gold" ||
        ev.type === "expansion" ||
        ev.type === "expansion_start" ||
        ev.type === "shrink" ||
        ev.type === "claim" ||
        ev.type === "gasp" && (isMineGasp || (ev.meta?.newMult ?? 0) >= OBSERVER_GASP_MULT);
      if (isBig) setNotifs((n) => [{ ...ev, uid: `n${++uidCounter}` }, ...n].slice(0, 15));
    });
    return unsub;
  }, [max, myOwner]);

  const dismiss = useCallback((uid: string) => {
    setNotifs((n) => n.filter((x) => x.uid !== uid));
  }, []);

  const clear = useCallback(() => setNotifs([]), []);
  return { recent, notifs, dismiss, clear, activeCount };
}

/** User events shown in the live feed. Others (snapshot/signal/control) never enter recent. */
const FEED_TYPES = new Set([
  "purchase", "gasp",
  "grenade_drop", "missile_drop", "nuke_drop",
  "gold", "expansion", "expansion_start", "shrink", "claim", "lost",
]);

function isFeedEvent(ev: { type: string }): boolean {
  return FEED_TYPES.has(ev.type);
}