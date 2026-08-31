import { useCallback, useState } from "react";
import type { QuoteResult } from "../types";
import { API_BASE } from "../api";

const API = API_BASE;

export function useQuote() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async (owner: string, x: number, y: number): Promise<QuoteResult | { error: string; message?: string } | null> => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, x, y }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || data.error); return data; }
      return data as QuoteResult;
    } catch (e: any) {
      setError(e?.message ?? "network");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const cancel = useCallback(async (quoteId: string, owner: string) => {
    try {
      await fetch(`${API}/quote/${quoteId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner }),
      });
    } catch {}
  }, []);

  const confirm = useCallback(async (quoteId: string, txSig: string): Promise<any> => {
    const res = await fetch(`${API}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId, txSig }),
    });
    return { ok: res.ok, code: res.status, body: await res.json() };
  }, []);

  return { request, cancel, confirm, loading, error };
}
