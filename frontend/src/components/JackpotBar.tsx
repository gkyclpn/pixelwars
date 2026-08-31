import type { Pool, SymbolCount } from "../types";
import { fmtSol } from "../pricing";

interface Props {
  pools: Pool[];
  onClaim: (poolId: "small" | "mid" | "big") => void;
  counts: Record<string, SymbolCount>;
}

/**
 * The 3 prize pools as compact cards — a horizontal snap-scroll strip on
 * mobile, a 3-up grid on desktop. Symbol slots light up for each one you hold;
 * when you hold enough, the card turns "ready" (spinning golden frame).
 */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function JackpotBar({ pools, onClaim, counts }: Props) {
  const order: Array<"big" | "mid" | "small"> = ["big", "mid", "small"];
  const sorted = order
    .map((id) => pools.find((p) => p.id === id))
    .filter(Boolean) as Pool[];
  return (
    <div className="jackpot-bar">
      {sorted.map((p) => {
        const have = Math.min(counts[p.claimSymbol]?.count ?? 0, p.claimCost);
        const enough = have >= p.claimCost;
        return (
          <div key={p.id} className={"jackpot jp-" + p.id + (enough ? " ready" : "")}>
            <span className="jp-icon" aria-hidden="true">
              {p.claimSymbolEmoji}
            </span>
            <div className="jp-main">
              <div className="jp-top">
                <span className="jp-name">{cap(p.claimSymbol)} Pool</span>
              </div>
              <div className="jp-amount">
                <span className="jp-sol">{fmtSol(p.balanceSol)}<small> SOL</small></span>
              </div>
              <span className="jp-cost" title={`${p.claimCost} × ${p.claimSymbol}`}>
                {Array.from({ length: p.claimCost }, (_, i) => (
                  <span key={i} className={"slot " + (i < have ? "filled" : "empty")}>{p.claimSymbolEmoji}</span>
                ))}
              </span>
            </div>
            <button
              className="jp-claim"
              onClick={() => onClaim(p.id)}
              disabled={!enough || p.balanceSol <= 0}
              title={
                !enough
                  ? `This pool needs ${p.claimCost} × ${p.claimSymbol} (you have ${have})`
                  : p.balanceSol <= 0
                  ? "Pool empty"
                  : `Claim`
              }
            >
              CLAIM
            </button>
          </div>
        );
      })}
    </div>
  );
}
