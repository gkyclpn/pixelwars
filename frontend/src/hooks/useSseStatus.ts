import { useEffect, useRef, useState } from "react";
import { subscribeStatus, getSseState, getLastMessageAt, hasOpenedOnce, type SseState } from "./eventBus";

/**
 * Reports whether the live SSE stream is stale: the tab HAD a connection, then lost it
 * and stayed disconnected for `graceMs`. The first page-load ("connecting" before the
 * first open) is NOT a drop — that's just the initial handshake.
 *
 * The App uses this to block purchases with a "connection lost — refresh" overlay when
 * true, because a disconnected tab is showing a stale canvas.
 */
export function useSseStatus(graceMs = 6000): { sse: SseState; stale: boolean } {
  const [sse, setSse] = useState<SseState>(getSseState);
  const [stale, setStale] = useState(false);
  const everOpened = useRef(hasOpenedOnce());

  useEffect(() => {
    const off = subscribeStatus((s) => {
      setSse(s);
      if (s === "open") everOpened.current = true;
    });
    return off;
  }, []);

  useEffect(() => {
    if (sse === "open" || !everOpened.current) {
      setStale(false);
      return;
    }
    // Disconnected and this tab had a live connection → after the grace window, block.
    const t = setTimeout(() => setStale(true), graceMs);
    return () => clearTimeout(t);
  }, [sse, graceMs]);

  // Tab return is the trap: browsers throttle timers in background, so the grace
  // window above may not have elapsed while hidden, AND EventSource reconnects the
  // instant the tab is visible again — setting sse back to "open" and erasing the
  // pending timeout before it can fire. So on visibility return we check the actual
  // freshness: stream not open, or no frame in ~35s (backend heartbeats every 30s, so
  // any longer without a frame is a zombie-reconnect that looks healthy for the split
  // second before it errors) → stale immediately.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !everOpened.current) return;
      const last = getLastMessageAt();
      if (getSseState() !== "open" || (last > 0 && Date.now() - last > 35_000)) {
        setStale(true);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { sse, stale };
}
