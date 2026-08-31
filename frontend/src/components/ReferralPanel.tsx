import { useState } from "react";
import type { ReferralState, Symbol } from "../types";
import { copyText } from "../clipboard";
import { fmtSol } from "../pricing";

interface Props {
  state: ReferralState;
  onClaim: (symbol: Symbol) => Promise<void>;
  onClose: () => void;
}

export function ReferralPanel({ state, onClaim, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [claiming, setClaiming] = useState<Symbol | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);

  const copy = async () => {
    if (await copyText(state.link || window.location.origin + "/?ref=" + state.slug)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const doClaim = async (symbol: Symbol) => {
    setClaiming(symbol);
    setClaimErr(null);
    try {
      await onClaim(symbol);
    } catch (e: any) {
      setClaimErr(e?.message ?? "Claim error");
    } finally {
      setClaiming(null);
    }
  };

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-modal refer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <span className="admin-title">🫂 Earn via Referrals</span>
          <span className="admin-sub">Invite friends, earn points from their pixel volume, and claim nukes.</span>
          <button className="admin-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="refer-body">
          <div className="refer-invite">
            <span className="refer-label">Your invite link</span>
            <div className="refer-link-row">
              <code className="refer-link">{state.link || (window.location.origin + "/?ref=" + state.slug)}</code>
              <button className="btn-admin-mini" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
            </div>
          </div>

          <div className="refer-reward">
            <div className="refer-reward-head">
              <span className="refer-label">Reward progress</span>
              <span className="refer-points"><b>{state.points}</b> pts</span>
            </div>
            <div className="refer-reward-desc">
              Every referral who reaches the target earns you <b>1 point</b>. Spend
              points to claim symbols of your choice.
            </div>
            <div className="refer-symbols">
              {(state.symbols ?? []).map((s) => {
                const pct = s.needed > 0 ? Math.min(100, (state.points / s.needed) * 100) : 0;
                return (
                  <div className={"refer-symbol" + (s.claimed ? " claimed" : s.ready ? " ready" : "")} key={s.id}>
                    <span className="refer-symbol-emoji">{s.emoji}</span>
                    <div className="refer-symbol-mid">
                      <span className="refer-symbol-name">{s.id.toUpperCase()}</span>
                      <div className="refer-progress"><div className="refer-progress-fill" style={{ width: pct + "%" }} /></div>
                      <span className="refer-symbol-vol">{state.points}/{s.needed} pts</span>
                    </div>
                    {s.claimed ? (
                      <span className="refer-claimed-tag">✓ Claimed</span>
                    ) : (
                      <button
                        className="btn-refer-claim"
                        disabled={!s.ready || claiming !== null}
                        onClick={() => doClaim(s.id)}
                      >
                        {claiming === s.id ? "Claiming…" : s.ready ? "Claim" : `+${s.needed - state.points} pts`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {claimErr && <div className="refer-err">{claimErr}</div>}
          </div>

          <div className="refer-refs">
            <span className="refer-label">Your referrals ({state.referees.length})</span>
            {state.referees.length === 0 ? (
              <div className="panel-empty">No invites yet — share your link and earn your first point!</div>
            ) : (
              <div className="refer-refs-list">
                {state.referees.map((r) => {
                  // If the threshold is surpassed, the display caps it at the threshold (the max in config).
                  const shown = Math.min(r.volumeSol, state.volumeThresholdSol);
                  return (
                    <div className={"refer-row" + (r.reached ? " reached" : "")} key={r.referee}>
                      <span className="refer-row-owner">{short(r.referee)}</span>
                      <span className="refer-row-vol">{fmtSol(shown)} SOL / {fmtSol(state.volumeThresholdSol)} SOL</span>
                      <span className="refer-row-badge">{r.reached ? "✅" : ""}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function short(a?: string): string {
  if (!a) return "?";
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}
