import type { PriceHover } from "../types";
import { SYMBOLS, SYMBOL_EMOJI } from "../types";
import { fmtSol } from "../pricing";

interface Props {
  selected: { x: number; y: number } | null;
  info: PriceHover | null;
  isMine: boolean;
  autoApprove: boolean;
  onBuy: () => void;
  busy: boolean;
  connected: boolean;
  /** True when the selected pixel is locked by someone's in-flight purchase. */
  isPending?: boolean;
  /** Closes the panel/sheet (clears the selection). */
  onClose?: () => void;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/**
 * The selected-pixel panel. A floating card on desktop, bottom-sheet content on
 * mobile. Blocks marked `.peek-hide` are hidden by CSS in the sheet's peek mode —
 * in peek only status + price + BUY are visible.
 * The cooldown counter is live: the parent re-provides the derived info (with
 * decayed `cooldownLeftSec`) on useBoard's every-second tick — no local interval.
 */
export function PixelPanel({ selected, info, isMine, autoApprove, onBuy, busy, connected, isPending, onClose }: Props) {
  const remaining = info?.cooldownLeftSec ?? 0;

  return (
    <aside className="panel">
      <div className="panel-head">
        <h3>
          {selected ? <>Pixel <span className="pi-coord">({selected.x}, {selected.y})</span></> : "Pixel"}
        </h3>
        {onClose && (
          <button className="panel-close" onClick={onClose} aria-label="Close">✕</button>
        )}
      </div>

      {!selected && (
        <div className="panel-empty">
          🎯 Pick a pixel from the map
          <div style={{ marginTop: 6, fontSize: 11.5, opacity: 0.75 }}>
            Grab an empty pixel, or gasp someone else's — every gasp doubles the price.
          </div>
        </div>
      )}

      {selected && info && (
        <>
          <div className="pi-statuses">
            <div className={"pi-status " + (info.isGold ? "gold" : isMine ? "mine" : info.hasOwner ? "owned" : "empty")}>
              {info.isGold ? "👑 GOLDEN PIXEL" : isMine ? "✅ YOUR PIXEL" : info.hasOwner ? "🎯 OWNED" : "✨ EMPTY"}
            </div>
            {info.isGold && isMine && <div className="pi-status mine">✅ YOUR PIXEL</div>}
          </div>
          <ul className="pi-rows peek-hide">
            <li><span>Base Price</span><span>{fmtSol(info.basePerPxSol)} SOL</span></li>
            <li><span>Multiplier</span><span className="mult">×{info.multiplier}</span></li>
            {!info.isGold && (
              <>
              <li><span>Next Multiplier</span><span>×{info.multiplierNext}</span></li>
              <li className="cooldown">
                <span>Cooldown</span>
                <span>{remaining > 0 ? fmt(remaining) : "—"}</span>
              </li>
              <li className="nuke wide">
                <span>Drop Chance</span>
                <span className="nuke-prob">
                  {SYMBOLS.map((s) => (
                    <span key={s} className="prob-line" title={s + " chance"}>
                      {SYMBOL_EMOJI[s]} {((info.probabilities?.[s] ?? 0) * 100).toFixed(2)}%
                    </span>
                  ))}
                </span>
              </li>
              </>
            )}
            {info.lastPaidSol != null && (
              <li>
                <span>Last Paid</span>
                <span>{fmtSol(info.lastPaidSol)} SOL</span>
              </li>
            )}
            {isMine && info.lastPaidSol != null && info.priorGainSol != null && (() => {
              // Gain: after a purchase, the share the prior buyer would receive (GASP_SPLIT_PRIOR_PCT)
              // minus the last amount paid. Comes from the live backend config (priorGainSol).
              // Negative = loss, positive = profit.
              const gainSol = info.priorGainSol - info.lastPaidSol;
              const loss = gainSol < 0;
              const s = Math.abs(gainSol);
              return (
                <li className={"gain wide " + (loss ? "loss" : "profit")}>
                  <span>Loss / Profit if Sold</span>
                  <span>
                    <strong className="gain-fact">
                      {loss ? "−" : "+"}{fmtSol(s)} SOL
                    </strong>
                  </span>
                </li>
              );
            })()}
            {info.hasOwner && (
              <li><span>Owner</span><span className="mono">{info.owner!.slice(0, 4)}…{info.owner!.slice(-4)}</span></li>
            )}
          </ul>
          {info.isGold ? (
            <div className="gold-unusable">
              👑 Golden pixel — can no longer be bought.
            </div>
          ) : (
            <>
            <div className="pi-total">
              <span className="pi-total-label">Pay Now</span>
              <div className="pi-total-vals">
                <strong>{fmtSol(info.priceSol)} SOL</strong>
              </div>
            </div>
            {isMine && (
              <div className="auto-hint mine-hint">
                This pixel is yours — it can't be bought again.
              </div>
            )}
            {isPending ? (
              <div className="pi-pending">
                <span className="pi-pending-spinner" /> Someone is buying this pixel…
                <div className="auto-hint">It stays locked until the purchase confirms or times out.</div>
              </div>
            ) : !autoApprove && !isMine ? (
              <button
                className="cta"
                onClick={onBuy}
                disabled={!connected || busy}
              >
                {busy ? "Processing…" : `Buy · ${fmtSol(info.priceSol)} SOL`}
              </button>
            ) : autoApprove && !isMine ? (
              <div className="auto-hint">
                ⚡ Quick buy active — tapping the pixel buys it automatically.
              </div>
            ) : null}
            </>
          )}
        </>
      )}
    </aside>
  );
}
