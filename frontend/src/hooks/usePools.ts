import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import type { Pool } from "../types";
import { subscribe, getLastInit } from "./eventBus";
import { API_BASE } from "../api";

const API = API_BASE;

export function usePools() {
  const [pools, setPools] = useState<Pool[]>([]);
  const { signMessage } = useWallet();

  useEffect(() => {
    const init = getLastInit();
    if (init) setPools(init.pools);
    const unsub = subscribe((ev) => {
      if (ev.type === "init") setPools(ev.pools);
      else if (ev.type === "pools_snapshot") setPools(ev.pools);
    });
    return unsub;
  }, []);

  // REST fallback.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/pools`);
      if (!r.ok) return;
      const d = await r.json();
      setPools(d.pools || []);
    } catch { /* ignore */ }
  }, []);

  // Two-step anti-forgery: propose (nonce escrow) → signMessage → claim.
  // Since the signer is the wallet owner, you can only claim with your own wallet,
  // and nobody can draw a payout on your behalf.
  const claim = useCallback(async (owner: string, pool: "small" | "mid" | "big") => {
    try {
      const p = await fetch(`${API}/claim-propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, pool }),
      });
      const pd = await p.json().catch(() => null);
      if (!p.ok) return { ok: false, code: p.status, body: pd };
      if (!signMessage) {
        return { ok: false, code: 0, body: { error: "no_signmessage", message: "Your wallet doesn't support signMessage." } };
      }
      const sigBytes = await signMessage(new TextEncoder().encode(pd.message));
      const signature = bs58.encode(sigBytes);
      const r = await fetch(`${API}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, pool, proposedAt: pd.proposedAt, signature }),
      });
      return { ok: r.ok, code: r.status, body: await r.json() };
    } catch (e: any) {
      return { ok: false, code: 0, body: { error: "network", message: e?.message ?? "Connection error" } };
    }
  }, [signMessage]);

  return { pools, refresh, claim };
}