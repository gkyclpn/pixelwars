import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import type { ReferralState, BindResult, Symbol } from "../types";
import { subscribe } from "./eventBus";
import { API_BASE } from "../api";

const API = API_BASE;

const EMPTY: ReferralState = {
  slug: "",
  link: "",
  points: 0,
  pointsNeeded: 50,
  nukeReward: 1,
  volumeThresholdSol: 0.1,
  referees: [],
  claimed: null,
  symbols: [
    { id: "grenade", emoji: "🧨", needed: 10, reward: 1, ready: false, claimed: false },
    { id: "missile", emoji: "🚀", needed: 20, reward: 1, ready: false, claimed: false },
    { id: "nuke", emoji: "☢️", needed: 50, reward: 1, ready: false, claimed: false },
  ],
};

export function useReferral(owner: string | null) {
  const [state, setState] = useState<ReferralState>(EMPTY);
  const { signMessage } = useWallet();

  const fetchMine = useCallback(async () => {
    if (!owner) return;
    try {
      const r = await fetch(`${API}/refer/mine?owner=${encodeURIComponent(owner)}`);
      if (!r.ok) return;
      const d = await r.json();
      setState({ ...EMPTY, ...d });
    } catch { /* ignore */ }
  }, [owner]);

  // No polling: fetch once on first render, then only refetch on demand when a
  // `referral_changed` signal arrives for THIS owner.
  useEffect(() => {
    if (!owner) return;
    const unsub = subscribe((ev) => {
      if (ev.type === "referral_changed" && ev.owner === owner) {
        fetchMine();
      }
    });
    fetchMine();
    return unsub;
  }, [fetchMine, owner]);

  // Two-step anti-forgery: propose → signMessage → bind.
  // Signer = wallet owner (ed25519) → you can't bind your wallet to someone else's
  // link, and nobody can bind your wallet for you.
  const bind = useCallback(async (referee: string, slug: string): Promise<BindResult> => {
    try {
      const p = await fetch(`${API}/refer/bind-propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: referee, slug }),
      });
      const pd = await p.json().catch(() => null);
      if (!p.ok) return { ok: false, body: pd };
      if (!signMessage) {
        return { ok: false, body: { error: "no_signmessage", message: "Your wallet doesn't support signMessage." } };
      }
      const sigBytes = await signMessage(new TextEncoder().encode(pd.message));
      const signature = bs58.encode(sigBytes);
      const r = await fetch(`${API}/refer/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: referee, slug, proposedAt: pd.proposedAt, signature }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok) fetchMine();
      return { ok: r.ok, body: d };
    } catch (e: any) {
      return { ok: false, body: { error: "network", message: e?.message ?? "Connection error" } };
    }
  }, [signMessage, fetchMine]);

  // Two-step anti-forgery: propose → signMessage → claim (same pattern as bind).
  const claim = useCallback(async (ownerAddr: string, symbol: Symbol) => {
    try {
      const p = await fetch(`${API}/refer/claim-propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: ownerAddr, symbol }),
      });
      const pd = await p.json().catch(() => null);
      if (!p.ok) return { ok: false, body: pd };
      if (!signMessage) {
        return { ok: false, body: { error: "no_signmessage", message: "Your wallet doesn't support signMessage." } };
      }
      const sigBytes = await signMessage(new TextEncoder().encode(pd.message));
      const signature = bs58.encode(sigBytes);
      const r = await fetch(`${API}/refer/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: ownerAddr, symbol, proposedAt: pd.proposedAt, signature }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok) fetchMine();
      return { ok: r.ok, body: d };
    } catch (e: any) {
      return { ok: false, body: { error: "network", message: e?.message ?? "Connection error" } };
    }
  }, [signMessage, fetchMine]);

  return { ...state, refresh: fetchMine, bind, claim };
}
