import type { BoardState, PixelState, PriceHover, Symbol } from "./types";

/**
 * Client-side pricing — an exact port of backend pricing.ts. Since the /price REST
 * endpoint was removed, all price/multiplier/probability/cooldown derivatives are
 * computed synchronously from SSE state (cells + board). Formulas:
 *   price(SOL) = perPxSol(level) × effective_mult
 *   effective_mult = owned ? max(2, mult×2) : max(1, mult)
 */

/**
 * Compact SOL display — 3-decimals, trims trailing zeros (0.002, 0.128, 2.56).
 * Values smaller than 0.001 wouldn't round to anything at 3 decimals, so they
 * fall back to 6-decimal precision to avoid showing a meaningless "0".
 */
export function fmtSol(v: number): string {
  const p = Math.abs(v) > 0 && Math.abs(v) < 0.001 ? 6 : 3;
  return v.toFixed(p).replace(/\.?0+$/, "");
}

export function effectiveMult(mult: number, owned: boolean): number {
  return owned ? Math.max(2, mult * 2) : Math.max(1, mult);
}

export function priceForCell(mult: number, perPxSol: number, owned = false): number {
  return perPxSol * effectiveMult(mult, owned);
}

/** p = base + step × log2(mult); clamp [0,1]. Config board.chance'tan gelir. */
export function dropProb(symbol: Symbol, mult: number, chore: BoardState["chance"]): number {
  const m = Math.max(1, mult);
  const lg = Math.log2(m);
  const chance = chore ? chore[symbol] : { base: 0, step: 0 };
  const p = chance.base + chance.step * lg;
  return Math.max(0, Math.min(1, p));
}

/** Seconds left until the next decay — each cooldown window halves the multiplier. */
export function cooldownLeftSec(
  lastBuyTs: string | null | undefined,
  mult: number,
  isGold: boolean,
  cooldownSeconds: number,
  now = Date.now()
): number {
  if (!lastBuyTs) return 0;
  if (isGold) return 0;
  if (mult <= 1) return 0;
  const elapsed = (now - new Date(lastBuyTs).getTime()) / 1000;
  const phase = elapsed % cooldownSeconds;
  return Math.max(0, Math.ceil(cooldownSeconds - phase));
}

/**
 * Full panel/tooltip info for a (x, y) point — same shape as the old /price response.
 * `cell` may be undefined (empty pixel) or from the cells array. Uses the decayed
 * mult (useBoard's ticked `cells` derivation) so it stays in sync with the cooldown.
 */
export function deriveCellInfo(
  x: number,
  y: number,
  cell: PixelState | undefined,
  board: BoardState,
  now = Date.now()
): PriceHover {
  const hasOwner = Boolean(cell?.owner);
  const isGold = Boolean(cell?.is_gold);
  const isKOL = Boolean(cell?.is_kol);
  const mult = cell?.mult ?? 1;
  const priceSol = priceForCell(mult, board.perPxSol, hasOwner);
  return {
    x,
    y,
    priceSol,
    multiplier: mult,
    multiplierNext: hasOwner ? Math.min(board.multCap ?? 64, mult * 2) : 1,
    hasOwner,
    owner: cell?.owner ?? null,
    buyCount: cell?.buy_count ?? 0,
    isKOL,
    isGold,
    cooldownLeftSec: cooldownLeftSec(cell?.last_buy_ts, mult, isGold, board.cooldownSeconds ?? 600, now),
    nukeProb: dropProb("nuke", mult, board.chance),
    probabilities: {
      grenade: dropProb("grenade", mult, board.chance),
      missile: dropProb("missile", mult, board.chance),
      nuke: dropProb("nuke", mult, board.chance),
    },
    basePerPxSol: board.perPxSol,
    // pg returns numeric as a string (cellsPayload subquery + cell_patch payload) — coerce to number.
    lastPaidSol: cell?.last_paid_sol != null ? Number(cell.last_paid_sol) : null,
    nukeDropped: Boolean(cell?.nuke_dropped),
    priorGainSol: priceSol * ((board.gaspSplitPriorPct ?? 60) / 100),
  };
}
