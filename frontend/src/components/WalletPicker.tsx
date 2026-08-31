import { useEffect, useMemo, useState } from "react";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import {
  buildWalletList,
  orderWalletEntries,
  readWalletRecency,
  recordWalletUsed,
  type WalletEntry,
} from "../wallets/registry";

interface WalletPickerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Kintara-style connect wallet picker — ported from Kintara.com's wallet
 * picker. Lists detected Wallet Standard wallets (installed-first, most-recently
 * used on top) plus every curated wallet as an install CTA with its brand logo.
 * Clicking an installed row selects + connects the adapter; clicking an install
 * row opens the wallet's download page in a new tab and keeps the modal open.
 */
export function WalletPicker({ open, onClose }: WalletPickerProps) {
  const { wallets, select } = useWallet();
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");

  const list = useMemo(() => {
    if (!open) return [];
    const detected = wallets
      .filter((w) => w.readyState === "Installed")
      .map((w) => ({ name: w.adapter.name, icon: w.adapter.icon, adapter: w }));
    const built = buildWalletList({ detected, includeCurated: true });
    return orderWalletEntries(built, readWalletRecency());
  }, [open, wallets]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setErr("");
      return;
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const visible = q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list;

  const pick = (entry: WalletEntry) => {
    if (entry.kind === "install") {
      try {
        window.open(entry.installUrl, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — user can install manually */
      }
      return;
    }
    recordWalletUsed(entry.id);
    if (entry.kind === "wallet-standard" && entry.adapter) {
      const adapter = (entry.adapter as Wallet).adapter;

      // Shared connect + reload flow — for ALL providers.
      // We only call `select`: that closes the picker and triggers the autoConnect
      // effect in App, which runs a SINGLE `connect()` when the selected adapter is
      // Installed/Loadable. We deliberately don't call `adapter.connect()` manually —
      // mobile Phantom silently rejects two concurrent connect requests (the old
      // breakage). Success is caught via the adapter's `connect` event (all adapters
      // are EventEmitters; on Phantom the promise sometimes hangs, but the event fires).
      let done = false;
      const onConnect = () => {
        if (done) return;
        done = true;
        try { adapter.off?.("connect", onConnect); } catch {}
        // Let the adapter commit its state for a half-tick, then reload —
        // autoConnect resumes the same wallet (consistent on mobile + desktop extension).
        setTimeout(() => location.reload(), 50);
      };
      try { adapter.on?.("connect", onConnect); } catch {}
      select(adapter.name);
    }
    onClose();
  };

  return (
    <div className="wp-backdrop" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wp-panel">
        <div className="wp-head">
          <h2 className="wp-title">Connect wallet</h2>
          <button className="wp-close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="wp-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder={`Search among ${list.length} wallets…`}
            aria-label="Search wallets"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="wp-list">
          {visible.map((entry) => {
            const installable = entry.kind === "install";
            return (
              <button
                key={entry.id}
                className={"wp-row" + (installable ? " wp-row--install" : "")}
                type="button"
                onClick={() => pick(entry)}
              >
                {entry.icon ? (
                  <img className="wp-icon" src={entry.icon} alt="" />
                ) : (
                  <span className="wp-icon">{String(entry.name || "?").charAt(0).toUpperCase()}</span>
                )}
                <span className="wp-name">{entry.name}</span>
                {installable ? (
                  <span className="wp-chev">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18" />
                    </svg>
                  </span>
                ) : (
                  <span className="wp-tag wp-tag--detected">Installed</span>
                )}
              </button>
            );
          })}
          {visible.length === 0 && <div className="wp-empty">No wallets match your search.</div>}
        </div>

        {err && <div className="wp-err">{err}</div>}

        <div className="wp-foot">
          <p className="wp-legal">Non-custodial — PixWars never accesses or holds your funds.</p>
        </div>
      </div>
    </div>
  );
}
