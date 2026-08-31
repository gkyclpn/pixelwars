import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { NotifItem } from "../hooks/useEvents";
import { fmtSol } from "../pricing";

interface Props {
  notifs: NotifItem[];
  onDismiss: (uid: string) => void;
  myOwner?: string | null;
}

/** Short wallet address */
function short(a?: string | null): string {
  if (!a) return "?";
  return a.length <= 9 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/**
 * Fixed top-center bubble notification queue.
 * Surface notable moments (nuke drop, claim, 32x+ gasp, golden pixel, expansion)
 * as auto-dismissing bubbles. Events tied to your own wallet (your nuke, a gasp
 * on your pixel) are highlighted.
 */
export function BubbleNotifications({ notifs, onDismiss, myOwner }: Props) {
  // Render the bubbles directly (no wrapper div) — inside the .notif-stack above
  // they flow stacked together with the other stacks (toasts) instead of overlapping.
  const my = myOwner ?? null;
  return (
    <>{notifs.map((n) => (
      <Bubble key={n.uid} n={n} onDismiss={onDismiss} myOwner={my} />
    ))}</>
  );
}

const AUTO_DISMISS_MS = 6500;
const AUTO_DISMISS_MS_PERSIST = 12000; // personal events linger a bit longer

/**
 * "Is this event about me?" — on a gasp, the admin (_prior_owner_id) is the
 * victim and `owner` holds the attacker. For every other event type, `owner`
 * is the actor themselves.
 */
function isMineEvent(n: NotifItem, myOwner: string | null): boolean {
  if (myOwner == null) return false;
  return n.type === "gasp" ? n.prior_owner === myOwner : n.owner === myOwner;
}

function Bubble({ n, onDismiss, myOwner }: { n: NotifItem; onDismiss: (uid: string) => void; myOwner: string | null }) {
  const isMine = isMineEvent(n, myOwner);
  const persist = isMine || n.type === "gold" || n.type === "expansion";
  const dismissMs = persist ? AUTO_DISMISS_MS_PERSIST : AUTO_DISMISS_MS;
  useAutoDismiss(n.uid, dismissMs, () => onDismiss(n.uid));

  // For toasts the kind class also lands on the bubble itself, coloring the
  // border by type (ok=green, warn=orange, err=red).
  const kindCls = n.type === "toast" ? ` toast-${n.meta?.kind ?? "err"}` : "";
  return (
    <div className={"bubble bubble-" + n.type + kindCls + (isMine ? " mine" : "")}>
      <button className="bubble-x" onClick={() => onDismiss(n.uid)} aria-label="Close" title="Close">×</button>
      <div className="bubble-body">{bodyFor(n, isMine)}</div>
    </div>
  );
}

export function bubbleBody(n: NotifItem, isMine: boolean = false): JSX.Element {
  return bodyFor(n, isMine);
}

function bodyFor(n: NotifItem, isMine: boolean): JSX.Element {
  switch (n.type) {
    case "purchase": {
      const newMult = n.meta?.newMult;
      const hot = (n.meta?.newMult ?? 0) >= 8;
      return (
        <>
          🎯 <b>{short(n.owner)}</b> bought ({n.x},{n.y}) {hot ? "🔥" : ""} —{" "}
          <b>{fmtSol(n.amount_sol ?? 0)} SOL</b>
          {hot && <em className="bubble-hot"> ×{newMult}</em>}
        </>
      );
    }
    case "grenade_drop":
      return (
        <>
          {isMine ? "🎉 YOU" : ""} 🧨 <b>{short(n.owner)}</b> won a GRENADE! ({n.x},{n.y})
        </>
      );
    case "missile_drop":
      return (
        <>
          {isMine ? "🎉 YOU" : ""} 🚀 <b>{short(n.owner)}</b> won a MISSILE! ({n.x},{n.y})
        </>
      );
    case "nuke_drop":
      return (
        <>
          {isMine ? "🎉 YOU" : ""} ☢️ <b>{short(n.owner)}</b> won a NUKE! ({n.x},{n.y})
        </>
      );
    case "gold":
      return (
        <>
          👑 GOLDEN PIXEL! ({n.x},{n.y}) — <b>{short(n.owner)}</b>
        </>
      );
    case "expansion":
      return (
        <>
          🌱 Board expanded! {n.meta?.newLevel != null ? `→ Level ${n.meta.newLevel}` : ""}
          {n.meta?.size != null ? <> ({n.meta.size}×{n.meta.size})</> : null}
        </>
      );
    case "shrink":
      return (
        <>
          🪓 Board shrunk! {n.meta?.newLevel != null ? `→ Level ${n.meta.newLevel}` : ""}
          {n.meta?.size != null ? <> ({n.meta.size}×{n.meta.size})</> : null}
        </>
      );
    case "expansion_start":
      return (
        <>
          🪴 Board will expand! {n.meta?.seconds != null ? `in ${n.meta.seconds}s` : "Soon"} ${" "}
          <b>Level {n.y} → {n.y! + 1}</b>
        </>
      );
    case "claim":
      return (
        <>
          💰 <b>{short(n.owner)}</b> claimed the reward pool —{" "}
          {fmtSol(n.amount_sol ?? 0)} SOL
          <span className="bubble-sub"> · {n.meta?.pool != null ? poolName(n.meta.pool) : ""} </span>
        </>
      );
    case "gasp":
      return (
        <>
          {isMine ? (
            <>⚠️ Your pixel got gasped! ({n.x},{n.y})</>
          ) : (
            <>
              💥 <b>{short(n.owner)}</b> gasped the pixel ({n.x},{n.y}) —{" "}
              <b>{fmtSol(n.amount_sol ?? 0)} SOL</b>
            </>
          )}
          {n.meta?.newMult != null && <em className="bubble-hot"> ×{n.meta.newMult}</em>}
        </>
      );
    case "toast": {
      const kind = n.meta?.kind ?? "err";
      return (
        <span className={"toast-" + kind}>
          {kind === "ok" ? "✅ " : kind === "warn" ? "⚠️ " : "⛔ "}
          {n.meta?.message ?? ""}
        </span>
      );
    }
    default:
      return <>{n.type}: {JSON.stringify(n.meta ?? n)}</>;
  }
}

function poolName(id: string): string {
  const m: Record<string, string> = { small: "Grenade Pool", mid: "Missile Pool", big: "Nuke Pool" };
  return m[id] ?? id;
}

function useAutoDismiss(uid: string, ms: number, onDone: () => void) {
  type T = ReturnType<typeof setTimeout>;
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(onDone, ms);
    return () => { if (ref.current) clearTimeout(ref.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, ms]);
}
