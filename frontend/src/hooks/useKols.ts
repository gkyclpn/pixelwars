import { useEffect, useState } from "react";
import type { Kol } from "../types";
// The KOL fetch is disabled for now. To re-enable, restore the import below and
// the fetch inside the useEffect body.
// import { API_BASE } from "../api";

export function useKols() {
  const [kols, setKols] = useState<Record<string, Kol>>({});
  useEffect(() => {
    // fetch(`${API_BASE}/kols`) ... // disabled — returns an empty map, no avatar rendering
  }, []);
  void setKols; // noUnusedLocals — remove once the fetch is restored
  return kols;
}
