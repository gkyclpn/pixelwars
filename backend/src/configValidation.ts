import { PublicKey } from "@solana/web3.js";
import {
  NUM_KEYS,
  STRING_KEYS,
  OBJECT_KEYS,
} from "./configStore";
import { config } from "./config";

// Per-key + cross-key validation. The PATCH /admin/config batch is first applied to
// a shadow copy, then cross-key checks (splits summing to 100) run.

export interface ConfigError {
  key: string;
  message: string;
}

function validPublicKeyOrEmpty(v: unknown): boolean {
  if (v === "" || v == null) return true;
  if (typeof v !== "string") return false;
  try { new PublicKey(v); return true; } catch { return false; }
}

function check(key: string, value: unknown): string | null {
  // Reject unknown keys (only whitelisted config can be changed)
  if (!NUM_KEYS.has(key) && !STRING_KEYS.has(key) && !OBJECT_KEYS.has(key)) {
    return "Unknown config key";
  }

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

  switch (key) {
    case "BASE_SOL":
    case "DEFAULT_TOKEN_USD":
    case "DEFAULT_SOL_USD":
      return num(value) > 0 ? null : "Must be a positive number";
    case "PER_PX_MULT":
    case "MULT_CAP":
      return num(value) > 1 ? null : "Must be greater than 1";
    case "FILL_EXPAND_THRESHOLD":
    case "NUKE_BASE_PROB":
    case "NUKE_MULT_STEP":
    case "GRENADE_BASE_PROB":
    case "GRENADE_MULT_STEP":
    case "MISSILE_BASE_PROB":
    case "MISSILE_MULT_STEP":
    case "DROP_PRICE_STEP": {
      const n = num(value);
      return n >= 0 && n <= 1 ? null : "Must be between 0 and 1";
    }
    case "MULT_DECAY_FACTOR":
    case "SOL_TOLERANCE": {
      const n = num(value);
      return n >= 0 && n < 1 ? null : "Must be at least 0 and less than 1";
    }
    case "FILL_EXPAND_SECONDS":
    case "COOLDOWN_SECONDS":
    case "QUEUE_TTL_SEC":
    case "MAX_GRENADE_PER_PERSON":
    case "MAX_MISSILE_PER_PERSON":
    case "MAX_NUKE_PER_PERSON":
    case "TOKEN_DECIMALS":
    case "POOL_WEIGHT_SMALL":
    case "POOL_WEIGHT_MID":
    case "POOL_WEIGHT_BIG":
    case "REFER_POINTS_FOR_GRENADE":
    case "REFER_POINTS_FOR_MISSILE":
    case "REFER_POINTS_FOR_NUKE":
    case "REFER_GRENADE_REWARD":
    case "REFER_MISSILE_REWARD":
    case "REFER_NUKE_REWARD": {
      const n = num(value);
      return Number.isInteger(n) && n >= 0 ? null : "Must be a non-negative integer";
    }
    case "REFER_VOLUME_THRESHOLD_SOL": {
      return num(value) > 0 ? null : "Must be a positive number";
    }
    case "EMPTY_SPLIT_BURN_PCT":
    case "EMPTY_SPLIT_POOL_PCT":
    case "EMPTY_SPLIT_TREASURY_PCT":
    case "GASP_SPLIT_PRIOR_PCT":
    case "GASP_SPLIT_POOL_PCT":
    case "GASP_SPLIT_BURN_PCT":
    case "GASP_SPLIT_TREASURY_PCT": {
      const n = num(value);
      return n >= 0 && n <= 100 ? null : "Must be between 0 and 100";
    }
    case "BURN_WALLET":
    case "TREASURY_WALLET":
    case "POOL_WALLET":
    case "TOKEN_MINT":
      return validPublicKeyOrEmpty(value) ? null : "Must be a valid Solana address or empty";
    default:
      return "Unverifiable key";
  }
}

/** Validates all changes; returns errors as a (key, message) list. */
export function validateConfigChanges(changes: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === "BOARD_SIZES") {
      // array type validation: non-empty, positive integers, monotonically increasing.
      if (!Array.isArray(value) || value.length === 0) {
        errors.push({ key, message: "Must have at least 1 size (for growth)" });
        continue;
      }
      const arr = value as number[];
      for (const s of arr) {
        if (typeof s !== "number" || !Number.isInteger(s) || s < 2) {
          errors.push({ key, message: "Sizes must be integers greater than 2" });
          break;
        }
      }
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] <= arr[i - 1]) {
          errors.push({ key, message: "Sizes must be in ascending order (e.g. 5,6,10)" });
          break;
        }
      }
      if (Math.max(...arr) > 2000) {
        errors.push({ key, message: "Sizes above 2000 are not supported" });
      }
      continue;
    }
    if (key === "CLAIM_COST") {
      // object type validation
      if (typeof value !== "object" || value === null) {
        errors.push({ key, message: "Must be an object (small/mid/big)" });
        continue;
      }
      const o = value as Record<string, unknown>;
      for (const p of ["small", "mid", "big"]) {
        const n = o[p];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          errors.push({ key, message: `"${p}" must be a positive integer` });
        }
      }
      continue;
    }
    const defaultCheck = check(key, value);
    if (defaultCheck) errors.push({ key, message: defaultCheck });
  }

  // Cross-key: split sums must be 100.
  const numOr = (k: string, d: number) =>
    typeof changes[k] === "number" ? (changes[k] as number) : (config as any)[k] ?? d;
  const emptySum =
    numOr("EMPTY_SPLIT_BURN_PCT", 0) +
    numOr("EMPTY_SPLIT_POOL_PCT", 0) +
    numOr("EMPTY_SPLIT_TREASURY_PCT", 0);
  if (emptySum !== 100) {
    errors.push({ key: "empty_splits", message: `Empty-pixel splits must sum to 100 (currently ${emptySum})` });
  }
  const gaspSum =
    numOr("GASP_SPLIT_PRIOR_PCT", 0) +
    numOr("GASP_SPLIT_POOL_PCT", 0) +
    numOr("GASP_SPLIT_BURN_PCT", 0) +
    numOr("GASP_SPLIT_TREASURY_PCT", 0);
  if (gaspSum !== 100) {
    errors.push({ key: "gasp_splits", message: `Gasp splits must sum to 100 (currently ${gaspSum})` });
  }

  return errors;
}