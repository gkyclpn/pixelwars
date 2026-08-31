import { useState } from "react";
import { WalletPill } from "./WalletPill";
import { copyText } from "../clipboard";
import { fmtSol } from "../pricing";

interface Props {
  tokenMint: string;
  perPxSol: number;
  onConnectRequest: () => void;
}

/** Brand mark — the logo PNG (transparent background, 3D cube). Size is CSS-driven so it stays crisp on mobile. */
function PixelLogo() {
  return <img className="brand-logo-img" src="/logo.png" alt="PixelWars" aria-hidden="true" />;
}

export function TopBar({ tokenMint, perPxSol, onConnectRequest }: Props) {
  const [copied, setCopied] = useState(false);

  const copyToken = async () => {
    if (!tokenMint) return;
    if (await copyText(tokenMint)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-logo"><PixelLogo /></span>
        <span className="brand-name">PIX<em>WARS</em></span>
      </div>
      <div className="topbar-center">
        {tokenMint ? (
          <button className="token-pill" onClick={copyToken} data-tip="Copy token address" aria-label="Copy token address">
            <span className="token-label">CA</span>
            <code>{tokenMint.slice(0, 4)}…{tokenMint.slice(-4)}</code>
            <span className={"copy-hint " + (copied ? "on" : "")}>{copied ? "✓" : "⧉"}</span>
          </button>
        ) : (
          <span className="token-pill pending">
            <span className="pending-full">Token address set before launch</span>
            <span className="pending-short">CA: soon</span>
          </span>
        )}
      </div>
      <div className="topbar-right">
        <div className="per-px">
          <span className="per-px-label">Pixel</span>
          <span className="per-px-val">{fmtSol(perPxSol)} SOL</span>
        </div>
        <div className="wallet-row">
          <WalletPill onConnectRequest={onConnectRequest} />
        </div>
      </div>
    </header>
  );
}
