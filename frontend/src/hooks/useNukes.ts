import { useEffect, useState, useCallback } from "react";
import { SYMBOLS, type Symbol, type SymbolCount } from "../types";
import { subscribe } from "./eventBus";
import { API_BASE } from "../api";

const API = API_BASE;

const EMPTY_COUNTS = (): Record<Symbol, SymbolCount> => ({
  grenade: { count: 0 },
  missile: { count: 0 },
  nuke: { count: 0 },
});

export interface NukeState {
  count: number;
  counts: Record<Symbol, SymbolCount>;
  cost: { small: number; mid: number; big: number };
}

export function useNukes(owner: string | null) {
  const [state, setState] = useState<NukeState>({
    count: 0,
    counts: EMPTY_COUNTS(),
    cost: { small: 5, mid: 5, big: 5 },
  });

  const fetchNukes = useCallback(async () => {
    if (!owner) return;
    try {
      const r = await fetch(`${API}/nukes/${owner}`);
      if (!r.ok) return;
      const d = await r.json();
      const counts = EMPTY_COUNTS();
      for (const s of SYMBOLS) {
        const c = d.counts?.[s];
        if (c) counts[s] = { count: c.count ?? 0 };
      }
      setState({
        count: d.count ?? counts.nuke.count,
        counts,
        cost: d.cost ?? state.cost,
      });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  // No polling: fetch once on first render, then only refetch on demand when a
  // `nukes_changed` signal arrives for THIS owner.
  useEffect(() => {
    if (!owner) return;
    const unsub = subscribe((ev) => {
      if (ev.type === "nukes_changed" && ev.owner === owner) {
        fetchNukes();
      }
    });
    fetchNukes();
    return unsub;
  }, [fetchNukes, owner]);

  return { ...state, refresh: fetchNukes };
}