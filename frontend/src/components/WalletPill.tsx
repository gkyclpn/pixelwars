import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { copyText } from "../clipboard";

const LS_KEY = "pw_last_wallet";

export function getLastWallet(): string | null {
  return localStorage.getItem(LS_KEY);
}

export function setLastWallet(addr: string): void {
  localStorage.setItem(LS_KEY, addr);
  window.dispatchEvent(new Event("pw-last-wallet"));
}

export function clearLastWallet(): void {
  localStorage.removeItem(LS_KEY);
  window.dispatchEvent(new Event("pw-last-wallet"));
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// Our own wallet pill. The react-ui WalletMultiButton misbehaves in edge cases:
// - With Phantom closed, autoConnect hangs on "Connecting".
// - Reconnecting after a disconnect behaves oddly.
// This pill doesn't read the wallet-adapter state — it shows the most recently
// connected wallet instead, and looks idle while no wallet is open. Clicking it
// opens the connect modal.
//
// The last-wallet value is lifted into state and refreshed by the `pw-last-wallet`
// event (+ changes to `connected`). That way setLastWallet/clearLastWallet calls
// (from App.tsx and doDisconnect) reflect on the pill within the same render,
// avoiding a janky render-time localStorage read.
export function WalletPill({ onConnectRequest }: { onConnectRequest: () => void }) {
  const { connected, publicKey, disconnect } = useWallet();
  const [last, setLast] = useState<string | null>(getLastWallet);

  useEffect(() => {
    setLast(getLastWallet());
  }, [connected, publicKey]);

  useEffect(() => {
    const sync = () => setLast(getLastWallet());
    window.addEventListener("pw-last-wallet", sync);
    return () => window.removeEventListener("pw-last-wallet", sync);
  }, []);

  // Show the live publicKey if present (current), otherwise the last connected one (e.g. Phantom closed).
  const shown = connected && publicKey ? publicKey.toBase58() : last;
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!shown) {
    return <button className="wallet-pill" onClick={onConnectRequest}>Connect to Wallet</button>;
  }

  const copy = async () => {
    if (await copyText(shown)) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
  };

  // Disconnect: adapter.disconnect() + localStorage cleanup. The pill then shows
  // "Connect"; reopening the modal is enough to reconnect (Phantom reconnects and
  // writes the address again).
  const doDisconnect = async () => {
    try { if (disconnect) await disconnect(); } catch { /* ignore */ }
    clearLastWallet();
    setConfirm(false);
  };

  return (
    <div className="wallet-pill-wrap">
      <button
        className={"wallet-pill" + (connected ? " live" : "")}
        onClick={() => (connected ? setConfirm((v) => !v) : onConnectRequest())}
        title={connected ? short(shown) : "Click to connect a wallet"}
      >
        <span className="wp-dot">{connected ? "🟢" : "⚪"}</span>
        <span className="wp-addr">{short(shown)}</span>
        {connected && <span className="wp-tri">▾</span>}
      </button>

      {confirm && (
        <div className="wp-menu">
          <button className="wp-item" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
          <button className="wp-item danger" onClick={doDisconnect}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
