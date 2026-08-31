interface Props {
  onClose: () => void;
}

/**
 * "How to Play" modal — every game mechanic is explained with live mini-component
 * snapshots (no static images, all CSS/DOM). All figures match the backend config.
 */
export function HowToPlay({ onClose }: Props) {
  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-modal htp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <span className="admin-title">🎮 How to Play</span>
          <span className="admin-sub">PixWars — every mechanic, step by step</span>
          <button className="admin-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="htp-body">
          {/* 1 — Buy a pixel */}
          <section className="htp-step">
            <div className="htp-num">1</div>
            <div className="htp-main">
              <h3>Buy a Pixel</h3>
              <p>
                The board starts at <b>5×5</b>. Tap any empty pixel and pay the <b>base price</b> — the
                pixel is now <b>yours</b>. Pixels with a green frame are your property.
              </p>
              <div className="htp-demo">
                <div className="htp-board" aria-hidden="true">
                  {Array.from({ length: 25 }, (_, i) => (
                    <span
                      key={i}
                      className={
                        "htp-px" + (i === 12 ? " mine" : "") + ([6, 18].includes(i) ? " taken" : "")
                      }
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* 2 — Gasp */}
          <section className="htp-step">
            <div className="htp-num">2</div>
            <div className="htp-main">
              <h3>Gasp &amp; Double the Price</h3>
              <p>
                You can <b>gasp</b> anyone's pixel for <b>2× its current price</b> — every gasp doubles
                it again. If your pixel gets gasped, <b>60%</b> of the payment comes back to you —
                about <b>1.2×</b> of what you paid.
              </p>
              <div className="htp-demo htp-flow" aria-hidden="true">
                <div className="htp-cell"><span className="htp-cell-emoji">😀</span><b>BASE PRICE</b></div>
                <span className="htp-arrow">→</span>
                <div className="htp-cell hot"><i className="htp-mult">×2</i><span className="htp-cell-emoji">🔥</span><b>2× PRICE</b></div>
                <span className="htp-arrow">→</span>
                <div className="htp-cell hot"><i className="htp-mult">×4</i><span className="htp-cell-emoji">🤑</span><b>4× PRICE</b></div>
              </div>
            </div>
          </section>

          {/* 3 — Golden pixel */}
          <section className="htp-step">
            <div className="htp-num">3</div>
            <div className="htp-main">
              <h3>Turn a Pixel Golden</h3>
              <p>
                If a pixel at <b>64×</b> gets gasped once more, it turns <b>golden</b> and locks
                forever — it can never be bought again. The last buyer becomes a legend.
              </p>
              <div className="htp-demo htp-flow" aria-hidden="true">
                <div className="htp-cell hot"><i className="htp-mult">×64</i><span className="htp-cell-emoji">🚀</span><b>64× PRICE</b></div>
                <span className="htp-arrow">→</span>
                <div className="htp-cell gold"><span className="htp-cell-emoji">👑</span><b>GOLDEN</b></div>
                <span className="htp-lock">🔒 locked</span>
              </div>
            </div>
          </section>

          {/* 4 — Symbol drop */}
          <section className="htp-step">
            <div className="htp-num">4</div>
            <div className="htp-main">
              <h3>Collect Symbols</h3>
              <p>
                Every purchase gives you a chance at a symbol drop. Odds follow the pixel's multiplier —
                every gasp doubles your chance — and <b>every board expansion (level) pushes them higher</b>.
                The golden conversion has the best odds.
              </p>
              <div className="htp-demo htp-symbols" aria-hidden="true">
                <div className="htp-sym">
                  <span className="htp-sym-emoji">🧨</span>
                  <div className="htp-sym-mid"><b>Grenade</b><div className="htp-sym-bar"><i style={{ width: "100%" }} /></div></div>
                  <span className="htp-sym-chance">Best chance</span>
                </div>
                <div className="htp-sym">
                  <span className="htp-sym-emoji">🚀</span>
                  <div className="htp-sym-mid"><b>Missile</b><div className="htp-sym-bar"><i style={{ width: "45%" }} /></div></div>
                  <span className="htp-sym-chance">Medium chance</span>
                </div>
                <div className="htp-sym">
                  <span className="htp-sym-emoji">☢️</span>
                  <div className="htp-sym-mid"><b>Nuke</b><div className="htp-sym-bar"><i style={{ width: "18%" }} /></div></div>
                  <span className="htp-sym-chance">Rarest</span>
                </div>
              </div>
            </div>
          </section>

          {/* 5 — Pool claim */}
          <section className="htp-step">
            <div className="htp-num">5</div>
            <div className="htp-main">
              <h3>Claim a Pool</h3>
              <p>
                Three prize pools build up: <b>Grenade / Missile / Nuke</b> (1:2:3 weighting — the nuke
                pool grows fastest). Collect <b>5×</b> of the matching symbol to claim the pool's
                <b> entire balance</b>.
              </p>
              <div className="htp-demo htp-jps" aria-hidden="true">
                <div className="htp-jp"><span>🧨</span><b>GRENADE</b><i>×5 = CLAIM</i></div>
                <div className="htp-jp mid"><span>🚀</span><b>MISSILE</b><i>×5 = CLAIM</i></div>
                <div className="htp-jp big"><span>☢️</span><b>NUKE</b><i>×5 = CLAIM</i></div>
              </div>
            </div>
          </section>

          {/* 6 — Fee split */}
          <section className="htp-step">
            <div className="htp-num">6</div>
            <div className="htp-main">
              <h3>Fee Split</h3>
              <p>Every payment is split transparently:</p>
              <div className="htp-demo htp-fees" aria-hidden="true">
                <span className="htp-fee-label">Empty pixel purchase</span>
                <div className="htp-fee-bar">
                  <i className="burn" style={{ width: "70%" }}>%70</i>
                  <i className="pool" style={{ width: "20%" }}>%20</i>
                  <i className="fee" style={{ width: "10%" }}>%10</i>
                </div>
                <span className="htp-fee-label">Gasp (seize)</span>
                <div className="htp-fee-bar">
                  <i className="owner" style={{ width: "60%" }}>%60</i>
                  <i className="pool" style={{ width: "20%" }}>%20</i>
                  <i className="burn" style={{ width: "10%" }}>%10</i>
                  <i className="fee" style={{ width: "10%" }}>%10</i>
                </div>
                <div className="htp-legend">
                  <span><i className="dot burn" /> Burn (token burn)</span>
                  <span><i className="dot pool" /> Prize pools</span>
                  <span><i className="dot owner" /> Previous owner</span>
                  <span><i className="dot fee" /> Platform</span>
                </div>
              </div>
            </div>
          </section>

          {/* 7 — Referral */}
          <section className="htp-step">
            <div className="htp-num">7</div>
            <div className="htp-main">
              <h3>Invite &amp; Win Symbols</h3>
              <p>
                Share your referral link. Every invitee who reaches <b>0.1 SOL</b> of volume earns you
                <b> 1 point</b>. Spend points to claim symbols of your choice:
              </p>
              <div className="htp-demo htp-refs" aria-hidden="true">
                <div className="htp-ref"><span>🧨</span><div className="htp-ref-bar"><i style={{ width: "20%" }} /></div><b>10 pts</b></div>
                <div className="htp-ref"><span>🚀</span><div className="htp-ref-bar"><i style={{ width: "40%" }} /></div><b>20 pts</b></div>
                <div className="htp-ref"><span>☢️</span><div className="htp-ref-bar"><i style={{ width: "100%" }} /></div><b>50 pts</b></div>
              </div>
            </div>
          </section>

          {/* 8 — Expansion */}
          <section className="htp-step">
            <div className="htp-num">8</div>
            <div className="htp-main">
              <h3>The Board Expands</h3>
              <p>
                When occupancy hits <b>90%</b>, a <b>5-minute</b> countdown starts and the board grows
                automatically by one step: <b>5×5 → 6×6 → 7×7 → … → 1000×1000</b>. More pixels, still
                affordable. The early bird wins.
              </p>
              <div className="htp-demo htp-expand" aria-hidden="true">
                <div className="htp-mini-grid g5">
                  {Array.from({ length: 25 }, (_, i) => <span key={i} className={i % 4 === 0 ? "on" : ""} />)}
                </div>
                <span className="htp-arrow">→</span>
                <div className="htp-mini-grid g6">
                  {Array.from({ length: 36 }, (_, i) => <span key={i} className={i % 5 === 0 ? "on" : ""} />)}
                </div>
                <span className="htp-arrow">→</span>
                <div className="htp-mini-grid g7">
                  {Array.from({ length: 49 }, (_, i) => <span key={i} className={i % 6 === 0 ? "on" : ""} />)}
                </div>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
