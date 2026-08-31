import type { SSEEvent } from "../types";
import { API_BASE } from "../api";

const API = API_BASE;

type Handler = (ev: SSEEvent) => void;

/**
 * Single EventSource singleton — only one SSE connection per tab, and every hook
 * subscribes to it. Eliminates polling loops: global state (board/cells/pools/
 * leaderboard) flows here as snapshots, and per-owner signals (nukes_changed/
 * referral_changed) trigger the hook's on-demand REST refetch.
 *
 * EventSource auto-reconnects with a built-in 3s `retry:`; on every reconnect the
 * backend sends a full `init` snapshot → self-heal.
 */

let source: EventSource | null = null;
let lastInit: SSEEvent & { type: "init" } | null = null;
let subscriberId: string | null = null;
// Wall-clock of the last SSE frame we received. Used by useSseStatus when the tab
// returns from background: if the tab was hidden long enough that no heartbeat has
// landed, the on-screen state is stale even if the browser reports the connection
// as "open" (a zombie reconnect can look healthy for the split second before it errors).
let lastMessageAt = 0;
const handlers = new Set<Handler>();

// SSE connection lifecycle. App shows a blocking "connection lost — refresh" overlay
// when the tab has been disconnected for a while, so a user who's behind on the live
// board can't buy pixels based on stale state.
export type SseState = "open" | "connecting" | "closed";
let sseState: SseState = "connecting";
let openedOnce = false;
const statusHandlers = new Set<(s: SseState) => void>();

function setSseState(s: SseState): void {
  if (s === sseState) return;
  sseState = s;
  for (const h of statusHandlers) h(s);
}

// App-level heartbeat: ping the server so it can prove this tab is alive. This is the
// definitive guard against users_count inflation — EventSource auto-reconnect respawns
// the connection, but a tab that closed while a proxy (Vite dev, a NAT box) held the TCP
// socket open would otherwise leave a ghost subscriber forever. The server reaps any
// subscriber silent for PING_TIMEOUT_MS (20s); we ping every 10s — twice inside that
// window — so a dead tab is evicted ~20s after it's gone, but a briefly-throttled one
// (backgrounded) survives.
const PING_INTERVAL_MS = 10_000;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// sendBeacon with a plain string sends Content-Type: text/plain; Fastify then leaves
// req.body as an unparsed string and the handler's `req.body?.subscriberId` is undefined
// → every ping/close returns 404, the reaper reaps live tabs, EventSource reconnect-storms,
// and the console fills with `POST /api/events/ping 404`. Wrapping in a Blob with an
// explicit application/json type lets Fastify's JSON parser see it as JSON.
function beaconJson(url: string, body: unknown): void {
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  navigator.sendBeacon(url, blob);
}

function startHeartbeat() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    const id = subscriberId;
    if (!id) return;
    beaconJson(`${API}/events/ping`, { subscriberId: id });
  }, PING_INTERVAL_MS);
}

// On a real tab close, tell the server immediately so that connection is released even
// before the reaper notices. sendBeacon is best-effort and fire-and-forget; if the tab is
// killed hard this simply doesn't run and the 45s reaper covers us instead.
function notifyClose() {
  const id = subscriberId;
  if (id) beaconJson(`${API}/events/close`, { subscriberId: id });
}
if (typeof window !== "undefined") window.addEventListener("beforeunload", notifyClose);

function ensureSource(): EventSource {
  if (source) return source;
  source = new EventSource(`${API}/events`);
  source.onopen = () => {
    openedOnce = true;
    setSseState("open");
  };
  source.onmessage = (msg) => {
    // A live event proves the stream is healthy even if onopen raced away.
    openedOnce = true;
    lastMessageAt = Date.now();
    setSseState("open");
    let ev: SSEEvent;
    try {
      ev = JSON.parse(msg.data);
    } catch { return; }
    if (ev.type === "init") {
      lastInit = ev;
      // (ev as any) — subscriberId is an init-frame field not part of the SSEEvent union.
      subscriberId = (ev as any).subscriberId ?? null;
      startHeartbeat();
    }
    for (const h of handlers) h(ev);
  };
  source.onerror = () => {
    // EventSource auto-reconnects; readyState tells us whether we're retrying
    // (CONNECTING) or permanently dead (CLOSED).
    setSseState(source?.readyState === EventSource.CLOSED ? "closed" : "connecting");
  };
  return source;
}

/** Start receiving messages once a hook subscribes; the return value is the unsubscribe fn. */
export function subscribe(h: Handler): () => void {
  handlers.add(h);
  ensureSource();
  return () => { handlers.delete(h); };
}

/** The latest init snapshot — used to filter snapshots arriving before init. */
export function getLastInit(): (SSEEvent & { type: "init" }) | null {
  return lastInit;
}

/** Respond to transport-level state changes. Returns the unsubscribe fn. */
export function subscribeStatus(h: (s: SseState) => void): () => void {
  statusHandlers.add(h);
  h(sseState);
  return () => { statusHandlers.delete(h); };
}

/** Current transport state. Always "connecting" until the first successful open. */
export function getSseState(): SseState {
  return sseState;
}

/** Whether the tab has ever held a live SSE connection (first-load isn't a drop). */
export function hasOpenedOnce(): boolean {
  return openedOnce;
}

/** Wall-clock (Date.now) of the last SSE frame received. 0 = never got one. */
export function getLastMessageAt(): number {
  return lastMessageAt;
}