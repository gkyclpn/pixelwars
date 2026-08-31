import pool from "./db";
import { config } from "./config";

// --- Board level / price ---------------------------------------------------

/** DB-backed size list (configStore.refreshConfig updates it in place). */
function boardSizes(): number[] {
  const s = (config as any).BOARD_SIZES;
  return Array.isArray(s) && s.length ? s : [5];
}

export function boardLevelForSize(size: number): number {
  const idx = boardSizes().indexOf(size);
  return idx >= 0 ? idx : 0;
}

export function boardSizeForLevel(level: number): number {
  const sizes = boardSizes();
  return sizes[Math.min(level, sizes.length - 1)] ?? 5;
}

// --- Size ↔ index maps -------------------------------------------------
// INDEX is authoritative: the BOARD_SIZES list index. These maps are rebuilt on
// every config refresh — even if admin changes the list, the size→index resolution
// stays exact.

// Memoized size→index (covers values up to 2^21, number-safe).
const _szSize = new Map<number, Map<number, number>>();
function _sizeMap(): Map<number, number> {
  const s = boardSizes();
  // If sizes are NOT unique, the SMALLEST index is authoritative (otherwise 0).
  const map = new Map<number, number>();
  for (let i = 0; i < s.length; i++) if (!map.has(s[i])) map.set(s[i], i);
  return map;
}
function _sizeCache(): Map<number, number> {
  const arr = boardSizes();
  const key = arr.length;
  let c = _szSize.get(key);
  if (!c || c.size !== new Set(arr).size) {
    c = _sizeMap();
    _szSize.set(key, c);
  }
  return c;
}

export function indexOfSize(size: number): number | null {
  const m = _sizeCache();
  return m.has(size) ? (m.get(size) as number) : null;
}

export function sizeAtIndex(index: number): number | null {
  const sizes = boardSizes();
  return sizes[index] ?? null;
}

/**
 * Target board size — directional (index based). The INDEX of the CONFIG
 * BOARD_SIZES list is authoritative: positive → first value larger than the current
 * size (never shrinks), negative → last value below the current size (can lower it).
 * Never falls outside the index list: shrinking never goes below the first element.
 */
export function nextBoardAt(direction: number, currentSize: number): number | null {
  const sizes = boardSizes();
  if (!sizes.length) return null;
  if (direction >= 0) {
    for (const s of sizes) if (s > currentSize) return s;
    return null;
  }
  // Shrinking: the last value BELOW the current size.
  for (let i = sizes.length - 1; i >= 0; i--) if (sizes[i] < currentSize) return sizes[i];
  return null;
}

/**
 * Next expansion target (backwards-compatible). Beware: config is index-based, so
 * the expansion target is now computed from the list as well.
 */
export function nextBoardSize(currentSize: number): number | null {
  return nextBoardAt(1, currentSize);
}

/** Target size by list `index` (no direction, index is authoritative). */
export function boardSizeAt(index: number): number | null {
  const sizes = boardSizes();
  return sizes[index] ?? null;
}

/** Level by index — aligns automation/price matching with the list index. */
export function levelForIndex(index: number): number {
  return Math.max(0, index);
}

/**
 * Per-pixel SOL price at a level: BASE_SOL × PER_PX_MULT^level.
 * Rounded to the same precision the UI displays (fmtSol: 3 decimals, falling back to
 * 6 only when the value is flagged by rounding — i.e. sub-0.001 and non-zero). Keeping
 * the ROUNDED value authoritative here means the stored board per_px_sol, the SSE
 * board.perPxSol, the price shown to the user, AND the SOL actually charged in
 * quote/verify all agree — no "shows 0.005, charges 0.0045" divergence.
 */
export function perPxSolForLevel(level: number): number {
  return roundSol(config.BASE_SOL * Math.pow(config.PER_PX_MULT, level));
}

/** Round a SOL amount to display precision — mirrors the frontend's fmtSol. */
export function roundSol(v: number): number {
  const p = Math.abs(v) > 0 && Math.abs(v) < 0.001 ? 6 : 3;
  return Number(v.toFixed(p));
}

export function boardCeiling(size: number): number {
  return size * size;
}

/**
 * Permanent (no-decay) underlying multiplier — ×2 every purchase, derived from buy_count.
 *   buy_count 1 (just bought)  → 1  → owned price: ×2
 *   buy_count 2 (first gasp)   → 2  → owned price: ×4
 *   buy_count 3 (second gasp)  → 4  → owned price: ×8   ...
 * Cooldown decay is NEVER applied to the price; it only lives in the heatmap visual.
 */
export function permanentMult(buyCount: number): number {
  return Math.min(config.MULT_CAP, Math.pow(2, Math.max(1, buyCount) - 1));
}

/**
 * A pixel's EFFECTIVE (priced) multiplier when owned — never decays.
 * Fixed progression the user defined:
 *   empty:           base × 1
 *   just bought:     base × 2
 *   first gasp:      base × 2 × 2  (= stored mult 2 → 4)
 *   every gasp:      × 2
 * Via permanentMult (2^number of gasps): owned → mult × 2.
 */
export function effectiveMult(mult: number, owned: boolean): number {
  return owned ? Math.max(2, mult * 2) : Math.max(1, mult);
}

/** Multiplier used when computing the price (permanent, no decay). */
export function priceForCell(
  mult: number,
  level: number,
  owned = false
): { sol: number } {
  const eff = effectiveMult(mult, owned);
  return { sol: perPxSolForLevel(level) * eff };
}

// --- Multiplier logic -------------------------------------------------------

export interface CellRow {
  owner: string;
  mult: number;
  last_buy_ts: string | null;
  buy_count: number;
  is_kol: boolean;
}

/**
 * A cell's current multiplier.
 * Cooldown rule: once COOLDOWN_SECONDS have passed since the last buy, the
 * multiplier is reduced by ×MULT_DECAY_FACTOR for each full cooldown window elapsed.
 * Never below 1.
 */
export function decayedMult(mult: number, lastBuyTs: string | null, now = Date.now(), isGold = false): number {
  if (isGold) return mult; // golden pixel is terminal — never decays, stays at MULT_CAP
  if (mult <= 1) return 1;
  if (!lastBuyTs) return mult;
  const last = new Date(lastBuyTs).getTime();
  const elapsed = Math.max(0, (now - last) / 1000);
  const cycles = Math.floor(elapsed / config.COOLDOWN_SECONDS);
  if (cycles === 0) return mult;
  const factor = Math.pow(config.MULT_DECAY_FACTOR, cycles);
  return Math.max(1, mult * factor);
}

/**
 * Remaining cooldown seconds — until the next decay.
 * Every completed cooldown window halves the multiplier (decayedMult); so the
 * remaining time is "the position inside the window": it keeps counting down
 * toward 1x while no purchase is made. Only valid for pixels with mult >= 2.
 */
export function cooldownLeftSec(lastBuyTs: string | null, mult = 1, isGold = false, now = Date.now()): number {
  if (!lastBuyTs) return 0;
  if (isGold) return 0; // golden pixel is locked — no countdown
  if (mult <= 1) return 0; // 1x pixel — no cooldown
  const elapsed = (now - new Date(lastBuyTs).getTime()) / 1000;
  const phase = elapsed % config.COOLDOWN_SECONDS;
  return Math.max(0, Math.ceil(config.COOLDOWN_SECONDS - phase));
}

/**
 * Symbol drop chance (0..1). Three-symbol jackpot system.
 * Formula: p = BASE_PROB + MULT_STEP * log2(mult) + DROP_PRICE_STEP * level
 * empty pixel (mult=1) → base, mult=64 (log2=6) → base + 6*step
 * Per-symbol parameters: grenade easy, missile medium, nuke hard.
 * The optional `level` (board expansion step) adds a price-linked bump: later, more
 * expensive boards give slightly better symbol odds, rewarding late-game spenders.
 * An actual drop also needs per-symbol stock (`nuke_config.available`) > 0 and the
 * buyer's symbol count below its max (guarded in verify.ts).
 */
export function dropProb(symbol: "grenade" | "missile" | "nuke", mult: number, level = 0): number {
  const m = Math.max(1, mult);
  const lg = Math.log2(m);
  const [base, step] = symbol === "grenade"
    ? [config.GRENADE_BASE_PROB, config.GRENADE_MULT_STEP]
    : symbol === "missile"
    ? [config.MISSILE_BASE_PROB, config.MISSILE_MULT_STEP]
    : [config.NUKE_BASE_PROB, config.NUKE_MULT_STEP];
  const p = base + step * lg + config.DROP_PRICE_STEP * Math.max(0, level);
  return Math.max(0, Math.min(1, p));
}

/** Max symbols a single person can hold (per symbol). */
export function maxPerPerson(symbol: "grenade" | "missile" | "nuke"): number {
  return symbol === "grenade"
    ? config.MAX_GRENADE_PER_PERSON
    : symbol === "missile"
    ? config.MAX_MISSILE_PER_PERSON
    : config.MAX_NUKE_PER_PERSON;
}

/** Backwards-compatible nuke wrapper. */
export function nukeProb(mult: number): number {
  return dropProb("nuke", mult);
}

export async function cellsForBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Promise<Map<string, CellRow>> {
  const { rows } = await pool.query<CellRow & { x: number; y: number }>(
    `SELECT x, y, owner, mult, last_buy_ts, buy_count, is_kol
     FROM cells
     WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
    [x1, x2, y1, y2]
  );
  const map = new Map<string, CellRow>();
  for (const r of rows) map.set(`${r.x},${r.y}`, r);
  return map;
}
