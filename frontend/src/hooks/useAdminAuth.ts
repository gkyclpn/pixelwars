import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { API_BASE } from "../api";

// Admin ed25519 signature + JWT session. The token lives in localStorage,
// verified via `signMessage` (signature, no gas) and obtained from /admin/login.

const API = API_BASE;
const TOKEN_KEY = "pw_admin_token";

function readToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function useAdminAuth() {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Verify admin status via /admin/me on mount + whenever the wallet changes.
  useEffect(() => {
    let active = true;
    const check = async () => {
      setLoading(true);
      setError(null);
      const token = readToken();
      if (!token || !wallet) {
        if (active) { setAuthed(false); setIsAdmin(false); setLoading(false); }
        return;
      }
      try {
        const res = await fetch(`${API}/admin/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        // The wallet returned by the token must match the connected wallet (invalid otherwise).
        const valid = res.ok && data.wallet === wallet && data.isAdmin === true;
        if (active) {
          setAuthed(res.ok && data.wallet === wallet);
          setIsAdmin(valid);
        }
      } catch {
        if (active) { setAuthed(false); setIsAdmin(false); }
      } finally {
        if (active) setLoading(false);
      }
    };
    check();
    return () => { active = false; };
  }, [wallet, connected]);

  const login = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!wallet || !signMessage) {
      setError("No wallet connected or signMessage isn't supported.");
      return false;
    }
    try {
      const nonceRes = await fetch(`${API}/admin/nonce?wallet=${wallet}`);
      if (!nonceRes.ok) throw new Error("Couldn't fetch a nonce");
      const { nonce, message } = await nonceRes.json();
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const signature = bs58.encode(sigBytes);
      const loginRes = await fetch(`${API}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, nonce, signature }),
      });
      const data = await loginRes.json();
      if (!loginRes.ok) {
        setError(data.error === "not_admin" ? "This wallet is not an admin." : (data.error ?? "Login failed"));
        return false;
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setAuthed(true);
      setIsAdmin(true);
      return true;
    } catch (e: any) {
      setError(e?.message ?? "Login error");
      return false;
    }
  }, [wallet, signMessage]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setAuthed(false);
    setIsAdmin(false);
  }, []);

  // `fetch` that attaches the Bearer token to admin routes. Drops the session on 401.
  const authFetch = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const token = readToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 401) {
      setAuthed(false);
      setIsAdmin(false);
      localStorage.removeItem(TOKEN_KEY);
    }
    return res;
  }, []);

  return { wallet, authed, isAdmin, loading, error, login, logout, authFetch };
}

export type UseAdminAuth = ReturnType<typeof useAdminAuth>;