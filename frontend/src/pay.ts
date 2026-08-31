import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { QuoteResult } from "./types";

// SPL Memo program ID (constant)
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * SPL Memo expects cheap contexts (priority fee 0) and requires the explicit
 * account tag; without it some wallet runtimes reject with an opaque
 * "unexpected error". Must match the GUID byte-array the backend parses.
 */
export const MEMO_PREFIX = "pixelwars:";

/**
 * Builds the purchase transaction's instructions:
 *  1) buyer → escrow SOL transfer (quote.priceSol, plus 1 extra lamport as a
 *     "marker" so an identically-priced tx is still a different serialization —
 *     Memo is signer-less, and a buyer racing two exact-same buys would otherwise
 *     replay the same signature hash. Backend's tolerance absorbs the +1 lamport.)
 *  2) a Memo instruction tagged `pixelwars:<quoteId>`
 * Backend confirm parses both and claims the pixel atomically.
 *
 * Requires buyer to have >= price + 1 lamport + fee. On a devnet wallet with a
 * pre-funded 1 SOL this is a non-issue; on mainnet, consider a thin margin.
 */
export function buildPurchaseIxs(
  quote: QuoteResult,
  buyer: PublicKey,
  escrow: PublicKey
): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  const lamports = Math.ceil(quote.priceSol * LAMPORTS_PER_SOL) + 1;
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: buyer,
      toPubkey: escrow,
      lamports,
    })
  );
  const memoStr = quote.instructions.memo.startsWith(MEMO_PREFIX)
    ? quote.instructions.memo
    : `${MEMO_PREFIX}${quote.instructions.memo}`;
  ixs.push(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(memoStr, "utf8"),
    })
  );
  return ixs;
}
