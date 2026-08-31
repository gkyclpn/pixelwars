import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventItem } from "../types";
import { fmtSol } from "../pricing";

/** Content-based uid: the same ts+type+coords represent the same event. */
export function eventUid(e: EventItem): string {
  const t = typeof e.ts === "string" ? e.ts : "";
  return `${e.type}|${t}|${e.x ?? ""}|${e.y ?? ""}|${e.owner ?? ""}|${e.prior_owner ?? ""}|${e.amount_sol ?? ""}`;
}

/**
 * The scrolling list of all live activity. Events arrive both from SSE (live)
 * and, on init, from the DB (history); the uid keeps precise timing.
 *
 * Memoized: App re-renders every second (useBoard's decay tick rebuilds `cells`),
 * but this panel only cares about `recent`. Without memo this re-ran the sort and
 * reconciled every row 1×/s — visible as timestamps ticking (now→3s→6s) during
 * scroll, overlapping the compositor and causing the site-wide jank. Memo skips
 * the work entirely unless a real SSE event (or the 15s timestamp clock) fires.
 */
export const LiveFeed = memo(function LiveFeed({ recent }: { recent: EventItem[] }) {
  // Sort descending by ts — the arrival order in recent isn't reliable (init comes
  // from the DB, live events from SSE, and they can interleave out of order).
  // Stable across App's 1s re-renders because recent's reference only changes on
  // a real feed event.
  const items = useMemo(
    () =>
      recent
        .map((e) => ({ e, uid: eventUid(e), t: Date.parse(e.ts ?? "") || 0 }))
        .sort((a, b) => b.t - a.t),
    [recent]
  );

  // Relative timestamps ("now", "5s", "3m") update once per 15s — NOT on every
  // render. This is the only thing that makes the rows change between events.
  // One `now` is computed per render and shared by all rows, so the whole list
  // ticks together instead of each row calling Date.now() independently.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) & 0xffff), 15000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();

  return (
    <div className="feed-list">
      {items.length === 0 && <div className="panel-empty">No activity yet — make the first purchase!</div>}
      {items.map(({ e: ev, uid }) => (
        <FeedRow key={uid} ev={ev} now={now} />
      ))}
    </div>
  );
});

/**
 * Mobile floating ticker — cycles the latest events on a single line.
 * Jumping straight to a new event as it arrives; tapping opens the full feed sheet.
 */
export function LiveTicker({ recent, onOpen }: { recent: EventItem[]; onOpen: () => void }) {
  const items = useMemo(
    () => [...recent].sort((a, b) => (Date.parse(b.ts ?? "") || 0) - (Date.parse(a.ts ?? "") || 0)).slice(0, 8),
    [recent]
  );
  const [idx, setIdx] = useState(0);
  const newestUid = items.length ? eventUid(items[0]) : "";

  // New event → the ticker shows it immediately
  useEffect(() => { setIdx(0); }, [newestUid]);

  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 4000);
    return () => clearInterval(t);
  }, [items.length]);

  if (!items.length) return null;
  const ev = items[Math.min(idx, items.length - 1)];

  return (
    <button className="live-ticker" onClick={onOpen} aria-label="Open live feed">
      <span className="live-dot" aria-hidden="true" />
      <span className="lt-item" key={eventUid(ev)}>
        <span className="lt-icon">{iconFor(ev.type)}</span>
        <span className="lt-text">{textFor(ev)}</span>
        <span className="lt-time">{ago(ev.ts)}</span>
      </span>
    </button>
  );
}

function FeedRowImpl({ ev, now }: { ev: EventItem; now: number }) {
  const mult = ev.meta?.newMult ?? 0;
  const hot = mult >= 8;
  return (
    <div className={"feed-item feed-" + ev.type + (hot ? " hot" : "")}>
      <span className="fi-icon">{iconFor(ev.type)}</span>
      <span className="fi-body">
        {textFor(ev)}
        {ev.type === "gasp" && (
          <span className={"fi-mult" + (hot ? " fi-hot" : "")}>
            {" — "}×{mult}
            {hot ? "🔥" : ""}
          </span>
        )}
      </span>
      <span className="fi-time">{ago(ev.ts, now)}</span>
    </div>
  );
}

/** Memoized: a row's content only changes when its event changes or the shared 15s
 *  timestamp clock fires — NOT on App's 1s re-renders. This is what removes the
 *  per-second reconciliation of every feed row. */
const FeedRow = memo(FeedRowImpl);

function iconFor(type: string): string {
  switch (type) {
    case "purchase": return "🎯";
    case "gasp": return "💥";
    case "grenade_drop": return "🧨";
    case "missile_drop": return "🚀";
    case "nuke_drop": return "☢️";
    case "gold": return "👑";
    case "expansion": return "🌱";
    case "expansion_start": return "🪴";
    case "shrink": return "🪓";
    case "claim": return "💰";
    default: return "🔔";
  }
}

function textFor(ev: EventItem): ReactNode {
  switch (ev.type) {
    case "purchase":
      return (
        <><b>{short(ev.owner ?? "")}</b> bought ({ev.x},{ev.y}) — <b>{fmtSol(num(ev.amount_sol))} SOL</b></>
      );
    case "gasp":
      return (
        <><b>{short(ev.owner ?? "")}</b> gasped the pixel ({ev.x},{ev.y}) — <b>{fmtSol(num(ev.amount_sol))} SOL</b></>
      );
    case "nuke_drop":
      return (
        <><b>{short(ev.owner ?? "")}</b> ☢️ won a NUKE ({ev.x},{ev.y})</>
      );
    case "grenade_drop":
      return (
        <><b>{short(ev.owner ?? "")}</b> 🧨 won a GRENADE ({ev.x},{ev.y})</>
      );
    case "missile_drop":
      return (
        <><b>{short(ev.owner ?? "")}</b> 🚀 won a MISSILE ({ev.x},{ev.y})</>
      );
    case "gold":
      return (
        <><b>{short(ev.owner ?? "")}</b> 👑 made a GOLDEN ({ev.x},{ev.y})</>
      );
    case "expansion":
      return <>Board expanded {ev.meta?.newLevel != null ? `→ Level ${ev.meta.newLevel}` : ""} ({ev.meta?.size ?? ""}×{ev.meta?.size ?? ""})</>;
    case "shrink":
      return <>Board shrunk {ev.meta?.newLevel != null ? `→ Level ${ev.meta.newLevel}` : ""} ({ev.meta?.size ?? ""}×{ev.meta?.size ?? ""})</>;
    case "expansion_start":
      return <>Board will expand — {ev.meta?.seconds != null ? `in ${ev.meta.seconds}s` : "soon"}</>;
    case "claim":
      return (
        <><b>{short(ev.owner ?? "")}</b> claimed — {fmtSol(num(ev.amount_sol))} SOL</>
      );
    default:
      return <>{ev.type}: {JSON.stringify(ev.meta ?? ev)}</>;
  }
}

/** DB NUMERIC columns can arrive as strings — coerce to a safe number. */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function ago(ts?: string, now: number = Date.now()): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function short(a?: string): string {
  if (!a) return "?";
  return a.length <= 9 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}
