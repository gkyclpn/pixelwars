import { useLayoutEffect, useRef } from "react";
import type { PriceHover } from "../types";
import { SYMBOLS, SYMBOL_EMOJI } from "../types";
import { fmtSol } from "../pricing";

interface Props {
  info: PriceHover | null;
  screen: { x: number; y: number } | null;
  myOwner?: string | null;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function shortAddr(addr: string, n = 4): string {
  return addr.length <= n * 2 + 1 ? addr : addr.slice(0, n) + "…" + addr.slice(-n);
}

/**
 * Pointer-following tooltip over the canvas. Hidden on mobile (PixelPanel suffices).
 */
export function HoverTooltip({ info, screen, myOwner }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Anchor the tooltip snug against the cursor/pixel (below-right). Flip to the left /
  // above when it would fall off the viewport — measured real size, so no stale constant.
  // Writing style imperatively in a layout effect keeps it clamped to the cursor without
  // a state round-trip, and runs before paint so there's no initial top-left flash.
  useLayoutEffect(() => {
    if (!info || !screen || !ref.current) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const GAP = 6;
    const M = 6;
    // Anchor the tooltip's top-left a few px below-right of the cursor so it hugs
    // the pixel. Flip to the other side when it would run off the viewport.
    let left = screen.x + GAP;
    if (left + w > window.innerWidth - M) left = screen.x - GAP - w;
    left = Math.max(M, left);
    let top = screen.y + GAP;
    if (top + h > window.innerHeight - M) top = screen.y - GAP - h;
    top = Math.max(M, top);
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.opacity = "1";
  }, [info, screen]);

  if (!info || !screen) return null;
  const mine = myOwner != null && info.owner === myOwner;
  return (
    <div ref={ref} className="hover-tooltip">
      <div className="ht-title">
        ({info.x},{info.y})
        {info.isGold && <span className="ht-gold">👑 GOLDEN</span>}
        {mine && <span className="ht-mine">✅ YOUR PIXEL</span>}
        {!mine && info.hasOwner && !info.isGold && <span className="ht-owned">🎯 OWNED</span>}
      </div>
      {info.isGold ? (
        <div className="ht-gold-owner" title={info.owner ?? undefined}>
          <span className="ht-gold-owner-label">Owner</span>
          <span className="mono">{info.owner ? shortAddr(info.owner) : "—"}</span>
        </div>
      ) : (
        <>
        <div className="ht-price">
          {fmtSol(info.priceSol)} SOL
        </div>
        <div className="ht-meta">
          <span>Base {fmtSol(info.basePerPxSol)} SOL</span>
          <span className="mult">×{info.multiplier}{!info.isGold && <> → ×{info.multiplierNext}</>}</span>
        </div>
        </>
      )}
      {!info.isGold && (
        <div className="ht-meta">
          <span className="ht-probs">
            {SYMBOLS.map((s) => (
              <span key={s} title={s + " chance"}>
                {SYMBOL_EMOJI[s]} {((info.probabilities?.[s] ?? 0) * 100).toFixed(2)}%
              </span>
            ))}
          </span>
          {info.cooldownLeftSec > 0 && <span>Cooldown: {fmt(info.cooldownLeftSec)}</span>}
        </div>
      )}
      {mine && info.lastPaidSol != null && info.priorGainSol != null && (() => {
        // The share that goes to the prior owner (computed in the backend from GASP_SPLIT_PRIOR_PCT) minus the last amount paid.
        const gainSol = info.priorGainSol - info.lastPaidSol;
        const loss = gainSol < 0;
        return (
          <div className={"ht-gain " + (loss ? "loss" : "profit")}>
            {loss ? "Loss" : "Profit"} if sold: {loss ? "−" : "+"}{fmtSol(Math.abs(gainSol))} SOL
          </div>
        );
      })()}
    </div>
  );
}
