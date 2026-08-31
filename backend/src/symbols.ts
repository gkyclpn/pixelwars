// Symbol constants — three-symbol jackpot system (grenade / missile / nuke).
// Shared runtime definition (backend). The frontend keeps the same constants in its types.ts + hooks.

export type Symbol = "grenade" | "missile" | "nuke";
export type PoolId = "small" | "mid" | "big";

export const SYMBOLS: Symbol[] = ["grenade", "missile", "nuke"];

export const SYMBOL_EMOJI: Record<Symbol, string> = {
  grenade: "🧨",
  missile: "🚀",
  nuke: "☢️",
};

// Pool → symbol mapping (used at claim): small→grenade, mid→missile, big→nuke.
export const POOL_SYMBOL: Record<PoolId, Symbol> = {
  small: "grenade",
  mid: "missile",
  big: "nuke",
};

export function isSymbol(s: string): s is Symbol {
  return s === "grenade" || s === "missile" || s === "nuke";
}