// Leaf module — time-safe keypair helpers shared by verify.ts and distribution.ts.
// Only ESCROW and POOL hold secrets; burn + treasury are destination addresses that
// the escrow signs (no keypair). Placed here so neither the verify <-> distribution
// circular import runs into a temporal-dead-zone on `Keypair`.

import { Keypair } from "@solana/web3.js";
import { config } from "./config";

function fromBase64(label: string, secret: string): Keypair {
  if (!secret) throw new Error(`${label} env not set — backend cannot sign` );
  try {
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(secret, "base64")));
  } catch {
    throw new Error(`${label} invalid base64 secret`);
  }
}

export function escrowKeypair(): Keypair {
  return fromBase64("ESCROW_KEYPAIR", config.ESCROW_KEYPAIR);
}

export function poolKeypair(): Keypair {
  return fromBase64("POOL_KEYPAIR", config.POOL_KEYPAIR);
}