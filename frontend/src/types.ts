export type Symbol = "grenade" | "missile" | "nuke";

export const SYMBOLS: Symbol[] = ["grenade", "missile", "nuke"];

export const SYMBOL_EMOJI: Record<Symbol, string> = {
  grenade: "🧨",
  missile: "🚀",
  nuke: "☢️",
};

export interface SymbolCount {
  count: number;
}

export interface BoardState {
  level: number;
  size: number;
  perPxSol: number;
  tokenMint: string;
  fillPercent: number;
  occupied: number;
  expanding: boolean;
  expandDeadlineSec: number | null;
  /** Absolute expansion expiry (epoch ms) — the frontend ticks down from this locally
   *  on its 1s clock so the countdown never freezes between heartbeat snapshots. */
  expandDeadlineMs?: number | null;
  /** Maintenance freeze (game paused). When true, time stands still: no decay, no
   *  /quote. The heatmap freezes at the last state; cooldowns resume when OFF. */
  isMaintenance?: boolean;
  /** Maintenance started (epoch ms) — the freeze boundary; admin shows "since". */
  maintenanceStartedAtMs?: number | null;
  cooldownSeconds: number;
  multDecayFactor: number;
  /** /price was removed, so client-side pricing config arrives over SSE. */
  gaspSplitPriorPct?: number;
  multCap?: number;
  chance?: {
    grenade: { base: number; step: number };
    missile: { base: number; step: number };
    nuke: { base: number; step: number };
  };
}

export interface PixelState {
  x: number;
  y: number;
  owner: string | null;
  mult: number;
  buy_count: number;
  is_kol: boolean;
  is_gold: boolean;
  last_buy_ts?: string | null;
  last_paid_sol?: number | null;
  nuke_dropped?: boolean;
}

export interface QuoteResult {
  quoteId: string;
  x: number;
  y: number;
  priceSol: number;
  solPerPx: number;
  level: number;
  multiplier: number;
  multiplierNext: number;
  hasOwner: boolean;
  priorOwner: string | null;
  isKOL: boolean;
  cooldownLeftSec: number;
  nukeProb: number;
  probabilities: Record<Symbol, number>;
  expiresInSec: number;
  instructions: { memo: string };
}

export interface PriceHover {
  x: number;
  y: number;
  priceSol: number;
  multiplier: number;
  multiplierNext: number;
  hasOwner: boolean;
  owner: string | null;
  buyCount: number;
  isKOL: boolean;
  isGold: boolean;
  cooldownLeftSec: number;
  nukeProb: number;
  probabilities: Record<Symbol, number>;
  basePerPxSol: number;
  lastPaidSol: number | null;
  nukeDropped: boolean;
  priorGainSol?: number;
}

export interface Pool {
  id: "small" | "mid" | "big";
  balanceSol: number;
  claimCost: number;
  claimSymbol: Symbol;
  claimSymbolEmoji: string;
  weightPct: number;
}

export interface Kol {
  addr: string;
  name: string;
  avatar?: string;
  x_handle?: string;
}

export interface EventItem {
  type: string;
  x?: number;
  y?: number;
  owner?: string | null;
  amount_sol?: number;
  amount_usd?: number;
  prior_owner?: string | null;
  meta?: any;
  ts?: string;
}

export interface LeaderboardData {
  byCount: { owner: string; count: number }[];
  byVolume: { owner: string; volumeSol: number }[];
  byValue: { x: number; y: number; owner: string; buyCount: number; mult: number; valueSol: number }[];
}

/** An in-flight purchase lock on a pixel (matches backend intents table). */
export interface PendingIntentState {
  x: number;
  y: number;
  owner: string;
  quoteId: string;
  expiresAtSec: number;
}

/** The messages flowing on SSE /events (the same shapes as backend broadcast.ts). */
export type SSEEvent =
  | { type: "init"; board: BoardState; cells: PixelState[]; size: number; pools: Pool[]; leaderboard: LeaderboardData; recent: EventItem[]; intents: PendingIntentState[]; activeCount?: number }
  | { type: "board_snapshot"; board: BoardState }
  | { type: "cells_snapshot"; cells: PixelState[]; size: number }
  | { type: "cell_patch"; cell: PixelState }
  | { type: "pools_snapshot"; pools: Pool[] }
  | { type: "leaderboard_snapshot"; byCount: LeaderboardData["byCount"]; byVolume: LeaderboardData["byVolume"]; byValue: LeaderboardData["byValue"] }
  | { type: "intent_locked"; x: number; y: number; owner: string; quoteId: string; expiresAtSec: number }
  | { type: "intent_unlocked"; x: number; y: number }
  | { type: "nukes_changed"; owner: string }
  | { type: "referral_changed"; owner: string }
  | { type: "users_count"; count: number };

export interface ReferralReferee {
  referee: string;
  volumeSol: number;
  reached: boolean;
  boundAt: string;
}

export interface BindResult {
  ok: boolean;
  body: any;
}

export interface ReferSymbolClaim {
  id: Symbol;
  emoji: string;
  needed: number;
  reward: number;
  ready: boolean;
  claimed: boolean;
}

export interface ReferralState {
  ok?: boolean;
  slug: string;
  link: string;
  points: number;
  pointsNeeded: number;
  nukeReward: number;
  volumeThresholdSol: number;
  referees: ReferralReferee[];
  claimed?: { nukes: number; at: string } | null;
  symbols?: ReferSymbolClaim[];
}
