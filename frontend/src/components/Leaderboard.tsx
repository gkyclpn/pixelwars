import { useEffect, useState } from "react";
import { subscribe, getLastInit } from "../hooks/eventBus";
import { fmtSol } from "../pricing";

interface ByCount { owner: string; count: number; }
interface ByVolume { owner: string; volumeSol: number; }

type Tab = "count" | "volume";

export function Leaderboard() {
  const [tab, setTab] = useState<Tab>("count");
  const [byCount, setByCount] = useState<ByCount[]>([]);
  const [byVolume, setByVolume] = useState<ByVolume[]>([]);

  // No polling: leaderboard global snapshots flow via SSE.
  useEffect(() => {
    const init = getLastInit();
    if (init) applyLeaderboard(init.leaderboard);
    const unsub = subscribe((ev) => {
      if (ev.type === "init") applyLeaderboard(ev.leaderboard);
      else if (ev.type === "leaderboard_snapshot") applyLeaderboard(ev);
    });
    return unsub;
  }, []);

  function applyLeaderboard(d: { byCount?: ByCount[]; byVolume?: ByVolume[] }) {
    if (d.byCount) setByCount(d.byCount);
    if (d.byVolume) setByVolume(d.byVolume);
  }

  return (
    <div className="leaderboard">
      <div className="lb-tabs">
        <button className={"lb-tab " + (tab === "count" ? "active" : "")} onClick={() => setTab("count")}>
          🏆 Most Pixels
        </button>
        <button className={"lb-tab " + (tab === "volume" ? "active" : "")} onClick={() => setTab("volume")}>
          💸 Biggest Spender
        </button>
      </div>
      <div className="lb-body">
        {tab === "count" && (
          <ol className="lb-list">
            {byCount.length === 0 && <li className="empty">No purchases yet</li>}
            {byCount.slice(0, 50).map((r) => (
              <li key={r.owner}>
                <span className="lb-owner">{short(r.owner)}</span>
                <span className="lb-val">{r.count} px</span>
              </li>
            ))}
          </ol>
        )}
        {tab === "volume" && (
          <ol className="lb-list">
            {byVolume.length === 0 && <li className="empty">No purchases yet</li>}
            {byVolume.slice(0, 50).map((r) => (
              <li key={r.owner}>
                <span className="lb-owner">{short(r.owner)}</span>
                <span className="lb-val">{fmtSol(r.volumeSol)} SOL</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function short(a?: string): string {
  if (!a) return "?";
  return a.length <= 9 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}
