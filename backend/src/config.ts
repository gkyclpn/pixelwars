// PixelWars V2.1 — economy + wallets + rules + nuke system.
// Set from env before launch; applied on backend restart.

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // --- Board / expansion -------------------------------------------------------
  // Starts at 5x5; every expansion grows by ONE (5→6→7→…→100→110→…→1000, the last
  // stretch jumps ×10 so the board doesn't take forever to reach max). The board
  // never shrinks: the next target is the first value above the current size
  // (pricing.nextBoardSize).
  BOARD_SIZES: [
    5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
    44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62,
    63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
    82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
    110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250,
    260, 270, 280, 290, 300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400,
    410, 420, 430, 440, 450, 460, 470, 480, 490, 500, 560, 620, 680, 740, 800,
    900, 1000,
  ],

  // --- Pixel economy -----------------------------------------------------------
  // SOL-native: price stays BASE_SOL × PER_PX_MULT^level — no oracle.
  BASE_SOL: num("BASE_SOL", 0.0002),
  // Per board-expansion step multiplier (1.5x, not 2x — 2x grew unmanageable).
  PER_PX_MULT: num("PER_PX_MULT", 1.5),
  FILL_EXPAND_THRESHOLD: num("FILL_EXPAND_THRESHOLD", 0.9),
  FILL_EXPAND_SECONDS: num("FILL_EXPAND_SECONDS", 5 * 60),
  // cooldown: a buy within this window after the last buy → ×2, otherwise ×MULT_DECAY_FACTOR
  COOLDOWN_SECONDS: num("COOLDOWN_SECONDS", 10 * 60),
  MULT_DECAY_FACTOR: num("MULT_DECAY_FACTOR", 0.5),
  // One more gasp on a multiplier that reached 64 → turns the pixel golden (no longer buyable).
  MULT_CAP: num("MULT_CAP", 64),

  // --- Wallets ----------------------------------------------------------------
  // Signing identities: only ESCROW and POOL keypairs exist. Burn and treasury are
  // destination ADDRESSES only — the escrow signs their transfer legs.
  ESCROW_KEYPAIR: process.env.ESCROW_KEYPAIR ?? "", // base64 secret (backend escrow)
  // The burn share of a purchase accumulates as SOL in the user's BURN_WALLET keypair;
  // a manual one-off moves it to the Incinerator (no auto burn worker at launch).
  BURN_WALLET: process.env.BURN_WALLET ?? "", // destination address — no backend keypair
  // Solana Incinerator — the final "burn" destination; it has NO keypair.
  DEAD_WALLET: "1nc1nerator11111111111111111111111111111111",
  TREASURY_WALLET: process.env.TREASURY_WALLET ?? "", // destination address — no backend keypair
  POOL_WALLET: process.env.POOL_WALLET ?? "",
  POOL_KEYPAIR: process.env.POOL_KEYPAIR ?? "", // base64 secret (reward pool, claim payouts)
  ADMIN_WALLETS: (process.env.ADMIN_WALLETS ?? "").split(",").filter(Boolean),

  // --- Split percentages --------------------------------------------------------
  // Empty pixel: 70% dead / 20% pool / 10% treasury
  EMPTY_SPLIT_BURN_PCT: 70,
  EMPTY_SPLIT_POOL_PCT: 20,
  EMPTY_SPLIT_TREASURY_PCT: 10,
  // Gasp: 60% previous owner / 20% pool / 10% dead / 10% treasury
  GASP_SPLIT_PRIOR_PCT: 60,
  GASP_SPLIT_POOL_PCT: 20,
  GASP_SPLIT_BURN_PCT: 10,
  GASP_SPLIT_TREASURY_PCT: 10,

  // --- 3 Jackpot pools ----------------------------------------------------------
  // Split the 20% pool share across 3 pools by weight (default 1:2:3 = small, mid, big).
  POOL_WEIGHT_SMALL: num("POOL_WEIGHT_SMALL", 1),
  POOL_WEIGHT_MID: num("POOL_WEIGHT_MID", 2),
  POOL_WEIGHT_BIG: num("POOL_WEIGHT_BIG", 3),

  // --- Three-symbol jackpot (grenade / missile / nuke) --------------------------
  // Drop chance formula: p = BASE_PROB + MULT_STEP * log2(mult)
  // Empty pixel (mult=1) → base, mult=64 (log2=6) → base + 6*step
  // Per symbol: grenade easy, missile medium, nuke hard.
  GRENADE_BASE_PROB: num("GRENADE_BASE_PROB", 0.02),  // 🧨 easy
  GRENADE_MULT_STEP: num("GRENADE_MULT_STEP", 0.01),
  MAX_GRENADE_PER_PERSON: num("MAX_GRENADE_PER_PERSON", 5),
  MISSILE_BASE_PROB: num("MISSILE_BASE_PROB", 0.005), // 🚀 medium
  MISSILE_MULT_STEP: num("MISSILE_MULT_STEP", 0.004),
  MAX_MISSILE_PER_PERSON: num("MAX_MISSILE_PER_PERSON", 3),
  NUKE_BASE_PROB: num("NUKE_BASE_PROB", 0.001), // ☢️ hard (backwards-compatible name)
  NUKE_MULT_STEP: num("NUKE_MULT_STEP", 0.005),
  MAX_NUKE_PER_PERSON: num("MAX_NUKE_PER_PERSON", 2),
  // Symbols also get RARER-ish? No — MORE common as the board grows (later levels have
  // higher per-px base prices). Each symbol's chance gains +DROP_PRICE_STEP per level:
  // p = base + step*log2(mult) + DROP_PRICE_STEP*level. Rewards late-game spenders.
  DROP_PRICE_STEP: num("DROP_PRICE_STEP", 0.002),
  // Claim cost: each pool asks for 5 symbols (admin-editable).
  CLAIM_COST: { small: 5, mid: 5, big: 5 },

  // --- Referral system (per symbol) --------------------------------------------
  // Referral volume target (SOL). Each invitee reaching the target = 1 point.
  // Each symbol has an independent threshold: grenade 10, missile 20, nuke 50 points to claim.
  // The reward symbol does NOT check stock / MAX_<SYMBOL>_PER_PERSON (referral channel is separate, 1 lifetime claim).
  REFER_VOLUME_THRESHOLD_SOL: num("REFER_VOLUME_THRESHOLD_SOL", 0.1),
  REFER_POINTS_FOR_GRENADE: num("REFER_POINTS_FOR_GRENADE", 10),
  REFER_POINTS_FOR_MISSILE: num("REFER_POINTS_FOR_MISSILE", 20),
  REFER_POINTS_FOR_NUKE: num("REFER_POINTS_FOR_NUKE", 50),
  REFER_GRENADE_REWARD: num("REFER_GRENADE_REWARD", 1),
  REFER_MISSILE_REWARD: num("REFER_MISSILE_REWARD", 1),
  REFER_NUKE_REWARD: num("REFER_NUKE_REWARD", 1),

  // --- Token (dead-wallet swap target + price) ----------------------------------
  TOKEN_MINT: process.env.TOKEN_MINT ?? "",
  TOKEN_DECIMALS: num("TOKEN_DECIMALS", 6),
  DEFAULT_TOKEN_USD: num("DEFAULT_TOKEN_USD", 0.0012),
  DEFAULT_SOL_USD: num("DEFAULT_SOL_USD", 150),

  // --- KOL list (static) ---------------------------------------------------------
  // Format: "ADDRESS,name,avatarUrl,xHandle" — multiple values separated by |
  KOL_LIST: (process.env.KOL_LIST ?? "")
    .split("|")
    .filter(Boolean)
    .map((line) => {
      const [addr, name, avatar, xHandle] = line.split(",");
      return { addr, name, avatar, xHandle };
    }),

  // --- SLA / lock -------------------------------------------------------------
  // Intent lock window: how long the pixel stays locked for a buyer's signature.
  // Solana-native flow: popup onay 2-5s sürer, bu bol marj verir. Çok kısa tutmak,
  // popup uzun açık kalırsa "para mahsur" riski doğurur (tx escrow'a gider ama intent
  // expire olur → claim edilemez). 10s'nin altına inme — 15-20s güvenli bant.
  QUEUE_TTL_SEC: num("QUEUE_TTL_SEC", 20),
  SOL_TOLERANCE: num("SOL_TOLERANCE", 0.03),

  // --- RPC / distribution (launch hardening) -----------------------------------
  // getLatestBlockhash cache TTL — blockhash lives ~60s/150 slots; 15s is safe.
  BLOCKHASH_TTL_MS: num("BLOCKHASH_TTL_MS", 15_000),
  // Max time to wait on a WebSocket signature confirmation for a distribution send.
  // WS push fires in 1-2s normally; this is just the worst-case cap. On timeout the
  // code returns 202 `pending` (pixel stays locked, client retries) — safe to keep low.
  DIST_WAIT_MS: num("DIST_WAIT_MS", 10_000),
};
