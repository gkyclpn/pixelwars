import pool from "./db";
import { config } from "./config";

// Type classes for DB-backed config. The live `config` object is mutated in place
// on refresh → existing `config.X` call sites need no refactor.
export const NUM_KEYS = new Set([
  "BASE_SOL", "PER_PX_MULT", "FILL_EXPAND_THRESHOLD", "FILL_EXPAND_SECONDS",
  "COOLDOWN_SECONDS", "MULT_DECAY_FACTOR", "MULT_CAP",
  "EMPTY_SPLIT_BURN_PCT", "EMPTY_SPLIT_POOL_PCT", "EMPTY_SPLIT_TREASURY_PCT",
  "GASP_SPLIT_PRIOR_PCT", "GASP_SPLIT_POOL_PCT", "GASP_SPLIT_BURN_PCT", "GASP_SPLIT_TREASURY_PCT",
  "POOL_WEIGHT_SMALL", "POOL_WEIGHT_MID", "POOL_WEIGHT_BIG",
  "GRENADE_BASE_PROB", "GRENADE_MULT_STEP", "MAX_GRENADE_PER_PERSON",
  "MISSILE_BASE_PROB", "MISSILE_MULT_STEP", "MAX_MISSILE_PER_PERSON",
  "NUKE_BASE_PROB", "NUKE_MULT_STEP", "MAX_NUKE_PER_PERSON",
  "DROP_PRICE_STEP",
  "TOKEN_DECIMALS", "DEFAULT_TOKEN_USD", "DEFAULT_SOL_USD",
  "QUEUE_TTL_SEC", "SOL_TOLERANCE",
  "REFER_VOLUME_THRESHOLD_SOL",
  "REFER_POINTS_FOR_GRENADE", "REFER_POINTS_FOR_MISSILE", "REFER_POINTS_FOR_NUKE",
  "REFER_GRENADE_REWARD", "REFER_MISSILE_REWARD", "REFER_NUKE_REWARD",
]);
export const STRING_KEYS = new Set(["BURN_WALLET", "TREASURY_WALLET", "POOL_WALLET", "TOKEN_MINT"]);
export const OBJECT_KEYS = new Set(["CLAIM_COST", "BOARD_SIZES"]);

export const CONFIG_CATEGORIES: Record<string, string> = {
  BASE_SOL: "econ", PER_PX_MULT: "econ", FILL_EXPAND_THRESHOLD: "econ",
  FILL_EXPAND_SECONDS: "econ", COOLDOWN_SECONDS: "econ", MULT_DECAY_FACTOR: "econ", MULT_CAP: "econ",
  BURN_WALLET: "wallet", TREASURY_WALLET: "wallet", POOL_WALLET: "wallet",
  EMPTY_SPLIT_BURN_PCT: "split", EMPTY_SPLIT_POOL_PCT: "split", EMPTY_SPLIT_TREASURY_PCT: "split",
  GASP_SPLIT_PRIOR_PCT: "split", GASP_SPLIT_POOL_PCT: "split", GASP_SPLIT_BURN_PCT: "split", GASP_SPLIT_TREASURY_PCT: "split",
  POOL_WEIGHT_SMALL: "pool", POOL_WEIGHT_MID: "pool", POOL_WEIGHT_BIG: "pool",
  GRENADE_BASE_PROB: "chance", GRENADE_MULT_STEP: "chance", MAX_GRENADE_PER_PERSON: "chance",
  MISSILE_BASE_PROB: "chance", MISSILE_MULT_STEP: "chance", MAX_MISSILE_PER_PERSON: "chance",
  NUKE_BASE_PROB: "chance", NUKE_MULT_STEP: "chance", MAX_NUKE_PER_PERSON: "chance",
  DROP_PRICE_STEP: "chance",
  CLAIM_COST: "chance",
  TOKEN_MINT: "token", TOKEN_DECIMALS: "token", DEFAULT_TOKEN_USD: "token", DEFAULT_SOL_USD: "token",
  QUEUE_TTL_SEC: "sla", SOL_TOLERANCE: "sla",
  REFER_VOLUME_THRESHOLD_SOL: "refer",
  REFER_POINTS_FOR_GRENADE: "refer", REFER_POINTS_FOR_MISSILE: "refer", REFER_POINTS_FOR_NUKE: "refer",
  REFER_GRENADE_REWARD: "refer", REFER_MISSILE_REWARD: "refer", REFER_NUKE_REWARD: "refer",
  BOARD_SIZES: "econ",
};

export const CONFIG_KEY_META: Record<string, { type: string; category: string; description: string }> = {
  BASE_SOL: { type: "number", category: "econ", description: "Base price of an empty pixel (SOL)" },
  PER_PX_MULT: { type: "number", category: "econ", description: "Base price multiplier per board expansion (level)" },
  FILL_EXPAND_THRESHOLD: { type: "number", category: "econ", description: "Board fill ratio at which expansion starts (0-1)" },
  FILL_EXPAND_SECONDS: { type: "number", category: "econ", description: "Expansion countdown (seconds)" },
  COOLDOWN_SECONDS: { type: "number", category: "econ", description: "Multiplier ×2 window after the last buy (seconds)" },
  MULT_DECAY_FACTOR: { type: "number", category: "econ", description: "Multiplier factor once cooldown passes (0-1)" },
  MULT_CAP: { type: "number", category: "econ", description: "Max multiplier; one more gasp → golden pixel" },
  BURN_WALLET: { type: "string", category: "wallet", description: "Burn accumulation wallet (SOL collects here, a separate worker swaps it for the token)" },
  TREASURY_WALLET: { type: "string", category: "wallet", description: "Treasury wallet address" },
  POOL_WALLET: { type: "string", category: "wallet", description: "Reward pool wallet address (claim shares collect here)" },
  EMPTY_SPLIT_BURN_PCT: { type: "number", category: "split", description: "Burn share on an empty pixel purchase (%)" },
  EMPTY_SPLIT_POOL_PCT: { type: "number", category: "split", description: "Pool share on an empty pixel purchase (%)" },
  EMPTY_SPLIT_TREASURY_PCT: { type: "number", category: "split", description: "Treasury share on an empty pixel purchase (%)" },
  GASP_SPLIT_PRIOR_PCT: { type: "number", category: "split", description: "Gasp (owned purchase) previous-owner share (%)" },
  GASP_SPLIT_POOL_PCT: { type: "number", category: "split", description: "Gasp pool share (%)" },
  GASP_SPLIT_BURN_PCT: { type: "number", category: "split", description: "Gasp burn share (%)" },
  GASP_SPLIT_TREASURY_PCT: { type: "number", category: "split", description: "Gasp treasury share (%)" },
  POOL_WEIGHT_SMALL: { type: "number", category: "pool", description: "Small jackpot pool weight" },
  POOL_WEIGHT_MID: { type: "number", category: "pool", description: "Mid jackpot pool weight" },
  POOL_WEIGHT_BIG: { type: "number", category: "pool", description: "Big jackpot pool weight" },
  GRENADE_BASE_PROB: { type: "number", category: "chance", description: "🧨 Grenade base drop chance (empty pixel, 0-1)" },
  GRENADE_MULT_STEP: { type: "number", category: "chance", description: "+grenade chance per multiplier doubling (0-1)" },
  MAX_GRENADE_PER_PERSON: { type: "number", category: "chance", description: "Max grenades a single person can hold" },
  MISSILE_BASE_PROB: { type: "number", category: "chance", description: "🚀 Missile base drop chance (empty pixel, 0-1)" },
  MISSILE_MULT_STEP: { type: "number", category: "chance", description: "+missile chance per multiplier doubling (0-1)" },
  MAX_MISSILE_PER_PERSON: { type: "number", category: "chance", description: "Max missiles a single person can hold" },
  NUKE_BASE_PROB: { type: "number", category: "chance", description: "☢️ Nuke base drop chance (empty pixel, 0-1)" },
  NUKE_MULT_STEP: { type: "number", category: "chance", description: "+nuke chance per multiplier doubling (0-1)" },
  MAX_NUKE_PER_PERSON: { type: "number", category: "chance", description: "Max nukes a single person can hold" },
  DROP_PRICE_STEP: { type: "number", category: "chance", description: "+symbol drop chance per board level (0-1). Rises as the base price grows" },
  CLAIM_COST: { type: "object", category: "chance", description: "Claim cost per pool (symbol count)" },
  BOARD_SIZES: { type: "array", category: "econ", description: "Board expansion size steps (comma-separated, ascending)" },
  TOKEN_MINT: { type: "string", category: "token", description: "Dead-wallet swap target token mint" },
  TOKEN_DECIMALS: { type: "number", category: "token", description: "Token decimal count" },
  DEFAULT_TOKEN_USD: { type: "number", category: "token", description: "Token USD price when there is no oracle" },
  DEFAULT_SOL_USD: { type: "number", category: "token", description: "SOL USD price when there is no oracle" },
  QUEUE_TTL_SEC: { type: "number", category: "sla", description: "Intent/quote TTL (seconds)" },
  SOL_TOLERANCE: { type: "number", category: "sla", description: "SOL price tolerance (0-1)" },
  REFER_VOLUME_THRESHOLD_SOL: { type: "number", category: "refer", description: "Pixel volume (SOL) a referral needs to count as a point" },
  REFER_POINTS_FOR_GRENADE: { type: "number", category: "refer", description: "🧨 Points needed to claim 1 grenade" },
  REFER_POINTS_FOR_MISSILE: { type: "number", category: "refer", description: "🚀 Points needed to claim 1 missile" },
  REFER_POINTS_FOR_NUKE: { type: "number", category: "refer", description: "☢️ Points needed to claim 1 nuke" },
  REFER_GRENADE_REWARD: { type: "number", category: "refer", description: "🧨 Grenade claim reward (units). Independent of stock/max" },
  REFER_MISSILE_REWARD: { type: "number", category: "refer", description: "🚀 Missile claim reward (units). Independent of stock/max" },
  REFER_NUKE_REWARD: { type: "number", category: "refer", description: "☢️ Nuke claim reward (units). Independent of stock/MAX_NUKE_PER_PERSON" },
};

let adminWalletsCache: string[] = [];

export function getAdminWallets(): string[] {
  return adminWalletsCache;
}

function typeOf(key: string): string {
  if (NUM_KEYS.has(key)) return "number";
  if (STRING_KEYS.has(key)) return "string";
  return "object";
}

function currentValue(key: string): unknown {
  return (config as any)[key];
}

/** Fills missing keys with the existing (env-seeded) `config` values. Idempotent. */
export async function seedConfigIfEmpty(): Promise<void> {
  const allKeys = new Set([...NUM_KEYS, ...STRING_KEYS, ...OBJECT_KEYS]);
  for (const key of allKeys) {
    const val = currentValue(key);
    if (val === undefined) continue;
    await pool.query(
      `INSERT INTO app_config (key, value, type, category, description)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(val), typeOf(key), CONFIG_CATEGORIES[key] ?? "econ",
       CONFIG_KEY_META[key]?.description ?? null]
    );
  }
  // seed admin_wallets from env if empty
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM admin_wallets`);
  if (Number(rows[0]?.n ?? 0) === 0 && config.ADMIN_WALLETS.length > 0) {
    for (const w of config.ADMIN_WALLETS) {
      await pool.query(
        `INSERT INTO admin_wallets (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING`,
        [w]
      );
    }
  }
}

/** Updates the `config` object in place with DB values. */
export async function refreshConfig(): Promise<void> {
  const cfg = config as any;
  try {
    const { rows } = await pool.query(`SELECT key, value FROM app_config`);
    for (const r of rows) {
      if (NUM_KEYS.has(r.key)) cfg[r.key] = Number(r.value);
      else if (STRING_KEYS.has(r.key)) cfg[r.key] = String(r.value);
      else if (OBJECT_KEYS.has(r.key)) cfg[r.key] = r.value;
    }
    const admins = await pool.query(`SELECT wallet FROM admin_wallets ORDER BY added_at`);
    adminWalletsCache = admins.rows.map((r: any) => r.wallet as string);
    cfg.ADMIN_WALLETS = adminWalletsCache;
  } catch (e) {
    // if the DB is unreachable the env-default `config` stays valid (cold-start safe).
    console.error("refreshConfig error", e);
  }
}

/** Update a single key + refresh immediately. */
export async function updateConfigKey(key: string, value: unknown, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO app_config (key, value, type, category, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, now())
     ON CONFLICT (key)
     DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), typeOf(key), CONFIG_CATEGORIES[key] ?? "econ", updatedBy]
  );
  await refreshConfig();
}