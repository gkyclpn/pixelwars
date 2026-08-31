import { SYMBOLS, SYMBOL_EMOJI, type SymbolCount } from "../types";

interface Props {
  fillPercent: number;
  size: number;
  occupied: number;
  expanding: boolean;
  expandDeadlineSec: number | null;
  /** The connected wallet's symbol counts — shown on the right of the chip. */
  counts?: Record<string, SymbolCount>;
  showSymbols?: boolean;
  /** Opens the referral panel — shown as a button next to the symbols. */
  onReferOpen?: () => void;
  /** Live count of connected players (SSE sessions). Null until the first snapshot arrives. */
  activeCount?: number | null;
}

function fmtCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Compact player count — capped at 4 chars so the chip never widens as it grows:
    999 → "999", 1234 → "1.2K", 9999 → "10K", 10500 → "10K", 123456 → "123K". */
function fmtActive(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 10 ? String(Math.floor(k)) : k.toFixed(1).replace(/\.0$/, "")) + "K";
}

/**
 * Compact board-status chip floating over the canvas.
 * Active players + size + fill bar + expansion countdown + (when connected) the symbol inventory.
 * The chip's single pulsing green dot lives in the active-players segment — "live" = people online.
 */
export function FillBar({ fillPercent, size, occupied, expanding, expandDeadlineSec, counts, showSymbols, onReferOpen, activeCount }: Props) {
  const pct = Math.round(Math.min(100, fillPercent * 100));
  return (
    <div className={"board-chip" + (showSymbols && counts ? " has-symbols" : "")} title={`${occupied} / ${size * size} pixels filled`}>
      {activeCount != null && (
        <span className="bc-active" title={`${activeCount} players online right now`}>
          <span className="live-dot" aria-hidden="true" />
          <b>{fmtActive(activeCount)}</b>
          <span className="bc-active-label">Active&nbsp;Users</span>
          <span className="bc-active-online">Online</span>
          <span className="bc-sep" aria-hidden="true" />
        </span>
      )}
      <span className="bc-size">{size}×{size}</span>
      <div className="bc-track">
        <div className="bc-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bc-pct">%{pct}</span>
      {expanding && expandDeadlineSec !== null && (
        <span className="expand-pill">
          🌱 <strong>{fmtCountdown(expandDeadlineSec)}</strong>
        </span>
      )}
      {showSymbols && counts && (
        <span className="bc-symbols" title="Your symbols">
          <span className="bc-sep" aria-hidden="true" />
          {SYMBOLS.map((s) => (
            <span className="bc-sym" key={s}>
              {SYMBOL_EMOJI[s]}<b>{counts[s]?.count ?? 0}</b>
            </span>
          ))}
        </span>
      )}
      {showSymbols && onReferOpen && (
        <button className="bc-refer" onClick={onReferOpen} data-tip="Invite friends, win symbols">
          <span>Earn</span>
        </button>
      )}
    </div>
  );
}
