import { createHash, randomBytes } from "crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import pool from "./db";
import { config } from "./config";
import { SYMBOLS, SYMBOL_EMOJI, isSymbol } from "./symbols";

/**
 * Referral system.
 * - slug: short code derived deterministically from the wallet (used in invite links as ?ref=SLUG).
 * - The invitee binds via `POST /refer/bind` (once during wallet connect; no rebind).
 * - Referral volume accumulates only from the invitee's pixel purchases (UPDATE'd in verify.ts).
 * - Each referral that reaches the goal = 1 point (derived: count(volume_sol >= threshold)).
 * - When points reach REFER_POINTS_FOR_NUKE, REFER_NUKE_REWARD nukes are claimable.
 *   The reward nuke ignores stock and MAX_NUKE_PER_PERSON; lifetime max 1 claim
 *   (referral_claims.slug is the PK — a second INSERT can't be written).
 *
 * Anti-tampering:
 * - Bind only via a wallet ed25519 signature: the connecting wallet first signs the bind
 *   genesis message and escrows it at `/refer/bind-propose`, then `/refer/bind` verifies
 *   the signer's signature. An account can only bind its own wallet — claiming goods to
 *   someone else's address no longer works because it requires proof of wallet ownership.
 * - At bind time the invitee must have no pixel purchases yet (`purchases` EXISTS check).
 */

const BIND_NONCE_TTL_MS = 10 * 60 * 1000;
const BIND_NONCE_MAX = 5;

function bindMessage(owner: string, slug: string, nonce: string): string {
  return `PixelWars referral\nreferee: ${owner}\nslug: ${slug}\nnonce: ${nonce}`;
}

// --- Signed referral reward claim -------------------------------------------
const CLAIM_NONCE_TTL_MS = 10 * 60 * 1000;

// The reward (symbol stock) must be claimed by the wallet owner themselves —
// otherwise someone could claim another person's referral points into their own account.
function claimMessage(owner: string, symbol: string, nonce: string): string {
  return `PixelWars refer claim\nowner: ${owner}\nsymbol: ${symbol}\nnonce: ${nonce}`;
}

const ProposeSchema = z.object({
  owner: z.string().min(32).max(48),
  slug: z.string().min(4).max(12),
});

const BindSchema = z.object({
  owner: z.string().min(32).max(48),
  slug: z.string().min(4).max(12),
  proposedAt: z.string(),
  signature: z.string().min(80).max(100),
});

const MineQuery = z.object({ owner: z.string().min(32).max(48) });

const ClaimSchema = z.object({
  owner: z.string().min(32).max(48),
  symbol: z.string().optional().default("nuke"),
});

/** Deterministic slug: first 6 base64url chars of the wallet hash. */
export function slugFor(owner: string): string {
  return createHash("sha256").update(owner).digest("base64url").slice(0, 6);
}

/** Does the owner have a code already? If not, create one (append a suffix on a slug collision). */
async function ensureCode(owner: string): Promise<{ slug: string; created: boolean }> {
  const existing = await pool.query(`SELECT slug FROM referral_codes WHERE owner=$1`, [owner]);
  if (existing.rows[0]) return { slug: existing.rows[0].slug, created: false };
  let slug = slugFor(owner);
  let suffix = 1;
  // Rare collision: if the slug is taken, try a short numeric suffix.
  for (;;) {
    const taken = await pool.query(`SELECT 1 FROM referral_codes WHERE slug=$1`, [slug]);
    if (!taken.rows[0]) break;
    slug = `${slugFor(owner)}${suffix++}`;
  }
  await pool.query(`INSERT INTO referral_codes (slug, owner) VALUES ($1,$2) ON CONFLICT (owner) DO NOTHING`, [slug, owner]);
  return { slug, created: true };
}

export async function referRoutes(app: FastifyInstance) {
  // Step 1/2 — After receiving the bind genesis message it will sign, the invitee
  // escrows its attempt. This "hands the signature nonce to the server" so the
  // next step can verify the signer's signature.
  app.post("/refer/bind-propose", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = ProposeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { owner, slug } = parsed.data;
    const code = await pool.query(`SELECT owner FROM referral_codes WHERE slug=$1`, [slug]);
    if (!code.rows[0]) {
      return reply.code(404).send({ error: "invalid_slug", message: "This referral code was not found." });
    }
    if (code.rows[0].owner === owner) {
      return reply.code(400).send({ error: "self_refer", message: "You can't invite yourself with your own referral code." });
    }
    const already = await pool.query(`SELECT 1 FROM referrals WHERE referee=$1`, [owner]);
    if (already.rows[0]) {
      return reply.code(409).send({ error: "already_bound", message: "This wallet is already linked to an invite." });
    }
    // To be a referee, the account must have no pixel purchases yet (anti-tampering).
    const bought = await pool.query(`SELECT 1 FROM purchases WHERE payer=$1 LIMIT 1`, [owner]);
    if (bought.rows[0]) {
      return reply.code(400).send({ error: "has_purchases", message: "You can't be a referee because you've already bought pixels." });
    }
    // Clear old escrows (one-shot gag).
    await pool.query(`DELETE FROM referral_bind_nonces WHERE owner=$1`, [owner]);
    const nonce = randomBytes(32).toString("hex");
    const created = await pool.query(
      `INSERT INTO referral_bind_nonces (owner, slug, nonce, expires_at) VALUES ($1,$2,$3, now() + $4::interval) RETURNING created_at`,
      [owner, slug, nonce, `${BIND_NONCE_TTL_MS} milliseconds`]
    );
    return reply.send({
      ok: true,
      nonce,
      proposedAt: created.rows[0].created_at.toISOString(),
      expiredAt: new Date(Date.now() + BIND_NONCE_TTL_MS).toISOString(),
      message: bindMessage(owner, slug, nonce),
    });
  });

  // Step 2/2 — Verify the signature and bind.
  app.post("/refer/bind", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = BindSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { owner, slug, proposedAt, signature } = parsed.data;
    // The DB nonce represents the escrowed attempt. The WHERE owner/slug match
    // already guarantees them — no need to re-check row.owner/row.slug.
    const escrow = await pool.query(
      `SELECT nonce, created_at FROM referral_bind_nonces WHERE owner=$1 AND slug=$2 ORDER BY created_at DESC LIMIT 1`,
      [owner, slug]
    );
    const row = escrow.rows[0];
    if (!row) {
      return reply.code(409).send({ error: "propose_required", message: "Start a bind attempt first." });
    }
    const expected = bindMessage(owner, slug, row.nonce);
    // One-shot: bind works only with the exact escrow that was proposed.
    if (proposedAt !== row.created_at.toISOString()) {
      return reply.code(409).send({ error: "stale_proposal", message: "This bind attempt is stale — start over." });
    }
    let pubBytes: Uint8Array;
    try { pubBytes = new PublicKey(owner).toBytes(); }
    catch { return reply.code(400).send({ error: "invalid_owner" }); }
    let sigBytes: Uint8Array;
    try { sigBytes = bs58.decode(signature); }
    catch { return reply.code(401).send({ error: "bad_signature" }); }
    const valid = nacl.sign.detached.verify(Buffer.from(expected, "utf8"), sigBytes, pubBytes);
    if (!valid) {
      return reply.code(401).send({ error: "bad_signature", message: "Signature could not be verified — you're not the wallet owner." });
    }
    // Signature verified: the signer owns this account. Repeat the anti-tampering check
    // here too (a purchase might have happened between propose and bind).
    const bought = await pool.query(`SELECT 1 FROM purchases WHERE payer=$1 LIMIT 1`, [owner]);
    if (bought.rows[0]) {
      await pool.query(`DELETE FROM referral_bind_nonces WHERE owner=$1`, [owner]);
      return reply.code(400).send({ error: "has_purchases", message: "You can't be a referee because you've already bought pixels." });
    }
    const res = await pool.query(
      `INSERT INTO referrals (slug, referee, referee_signature, referee_pubkey) VALUES ($1,$2,$3,$4) ON CONFLICT (referee) DO NOTHING`,
      [slug, owner, signature, owner]
    );
    if ((res.rowCount ?? 0) === 0) {
      await pool.query(`DELETE FROM referral_bind_nonces WHERE owner=$1`, [owner]);
      return reply.code(409).send({ error: "already_bound", message: "This wallet is already linked to an invite." });
    }
    await pool.query(`DELETE FROM referral_bind_nonces WHERE owner=$1`, [owner]);
    {
      // Both dashboards changed — the referrer's and the invitee's volume.
      const { signalReferralChanged } = await import("./broadcast");
      signalReferralChanged(owner); // the referee
      const refRes = await pool.query(`SELECT owner FROM referral_codes WHERE slug=$1`, [slug]);
      if (refRes.rows[0]?.owner) signalReferralChanged(refRes.rows[0].owner); // the current referrer
    }
    return reply.send({ ok: true });
  });

  // The referrer's dashboard: slug, invite link, points, invitee list + claim status.
  app.get("/refer/mine", async (req, reply) => {
    const parsed = MineQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_owner" });
    }
    const owner = parsed.data.owner;
    const { slug } = await ensureCode(owner);

    const threshold = Number(config.REFER_VOLUME_THRESHOLD_SOL);
    const pointsForNuke = Number(config.REFER_POINTS_FOR_NUKE);
    const nukeReward = Number(config.REFER_NUKE_REWARD);

    const [refsRes, claimRes] = await Promise.all([
      pool.query(
        `SELECT referee, volume_sol, bound_at, COALESCE(referee_signature, '') IS DISTINCT FROM '' AS signed FROM referrals WHERE slug=$1 ORDER BY bound_at DESC`,
        [slug]
      ),
      pool.query(`SELECT symbol, nukes, claimed_at FROM referral_claims WHERE slug=$1`, [slug]),
    ]);

    const claimedSymbols = new Set(claimRes.rows.map((r: any) => r.symbol));

    // A non-empty referee_signature means signature proof exists (anti-forgery).
    const referees = refsRes.rows.map((r: any) => ({
      referee: r.referee,
      volumeSol: Number(r.volume_sol),
      reached: Number(r.volume_sol) >= threshold,
      boundAt: r.bound_at,
      signed: !!r.signed,
    }));
    const points = referees.filter((r) => r.reached).length;
    const claimed = claimRes.rows[0]
      ? { nukes: Number(claimRes.rows[0].nukes), at: claimRes.rows[0].claimed_at }
      : null;

    // Invite link: keep the current origin (localhost on devnet, the domain in prod).
    const origin = req.headers.origin ?? `http://localhost:5173`;
    const link = `${origin}/?ref=${slug}`;

    const cfgA = config as any;
    const symbols = SYMBOLS.map((s) => {
      const K = s.toUpperCase();
      const needed = Number(cfgA[`REFER_POINTS_FOR_${K}`] ?? 0);
      return {
        id: s,
        emoji: SYMBOL_EMOJI[s],
        needed,
        reward: Number(cfgA[`REFER_${K}_REWARD`] ?? 0),
        ready: points >= needed,
        claimed: claimedSymbols.has(s),
      };
    });

    return {
      ok: true,
      slug,
      link,
      points,
      pointsNeeded: pointsForNuke,
      nukeReward,
      volumeThresholdSol: threshold,
      referees,
      claimed,
      symbols,
    };
  });

  // Grant the reward if the points meet the symbol's claim requirement. Atomic — the
  // same symbol can't be claimed twice. Two steps: /refer/claim-propose escrows a nonce
  // → the wallet signs → /refer/claim verifies. Previously a plain {owner,symbol} body
  // let someone pull another person's points into their own account.
  app.post("/refer/claim-propose", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { owner, symbol } = parsed.data;
    if (!isSymbol(symbol)) {
      return reply.code(400).send({ error: "invalid_symbol" });
    }
    let _pk: PublicKey;
    try { _pk = new PublicKey(owner); } catch { return reply.code(400).send({ error: "invalid_owner" }); }
    // A single active escrow per owner.
    await pool.query(`DELETE FROM refer_claim_nonces WHERE owner=$1`, [owner]);
    const nonce = randomBytes(32).toString("hex");
    const created = await pool.query(
      `INSERT INTO refer_claim_nonces (owner, symbol, nonce, expires_at) VALUES ($1,$2,$3, now() + $4::interval) RETURNING created_at`,
      [owner, symbol, nonce, `${CLAIM_NONCE_TTL_MS} milliseconds`]
    );
    return reply.send({
      ok: true,
      nonce,
      proposedAt: created.rows[0].created_at.toISOString(),
      expiredAt: new Date(Date.now() + CLAIM_NONCE_TTL_MS).toISOString(),
      message: claimMessage(owner, symbol, nonce),
    });
  });

  app.post("/refer/claim", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const owner = parsed.data.owner;
    const symbol = parsed.data.symbol;
    const bodyB = (req.body ?? {}) as { proposedAt?: string; signature?: string };
    const { proposedAt, signature } = bodyB;
    if (!isSymbol(symbol)) {
      return reply.code(400).send({ error: "invalid_symbol" });
    }
    if (!proposedAt || !signature) {
      return reply.code(422).send({ error: "signature_required", message: "Sign the claim attempt first." });
    }
    const escrow = await pool.query(
      `SELECT nonce, symbol, created_at FROM refer_claim_nonces WHERE owner=$1 AND symbol=$2 ORDER BY created_at DESC LIMIT 1`,
      [owner, symbol]
    );
    const row = escrow.rows[0];
    if (!row) {
      return reply.code(409).send({ error: "propose_required", message: "Start a claim attempt first." });
    }
    const expected = claimMessage(owner, symbol, row.nonce);
    if (proposedAt !== row.created_at.toISOString()) {
      return reply.code(409).send({ error: "stale_proposal", message: "This claim attempt is stale — start over." });
    }
    let pubBytes: Uint8Array;
    try { pubBytes = new PublicKey(owner).toBytes(); }
    catch { return reply.code(400).send({ error: "invalid_owner" }); }
    let sigBytes: Uint8Array;
    try { sigBytes = bs58.decode(signature); }
    catch { return reply.code(401).send({ error: "bad_signature" }); }
    const valid = nacl.sign.detached.verify(Buffer.from(expected, "utf8"), sigBytes, pubBytes);
    if (!valid) {
      return reply.code(401).send({ error: "bad_signature", message: "Signature could not be verified — you're not the wallet owner." });
    }

    const K = symbol.toUpperCase();
    const reward = Math.max(1, Math.floor(Number((config as any)[`REFER_${K}_REWARD`] ?? 1)));
    const pointsFor = Number((config as any)[`REFER_POINTS_FOR_${K}`] ?? 0);
    const threshold = Number(config.REFER_VOLUME_THRESHOLD_SOL);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const codeRes = await client.query(`SELECT slug FROM referral_codes WHERE owner=$1`, [owner]);
      const slug = codeRes.rows[0]?.slug;
      if (!slug) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "no_code", message: "You have no referral code." });
      }
      const pointsRes = await client.query(
        `SELECT count(*)::int AS n FROM referrals WHERE slug=$1 AND volume_sol >= $2`,
        [slug, threshold]
      );
      if (Number(pointsRes.rows[0]?.n ?? 0) < pointsFor) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "not_enough_points", symbol, need: pointsFor, have: Number(pointsRes.rows[0]?.n ?? 0) });
      }
      // Lifetime single claim (per symbol): (slug, symbol) PK conflict → rowCount 0 → ROLLBACK+409.
      const claimRes = await client.query(
        `INSERT INTO referral_claims (slug, symbol, nukes) VALUES ($1, $2, $3) ON CONFLICT (slug, symbol) DO NOTHING`,
        [slug, symbol, reward]
      );
      if ((claimRes.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "already_claimed", message: `You already claimed the ${symbol} reward.` });
      }
      // Ignores MAX_<SYMBOL>_PER_PERSON and the symbol stock — the referral path is a separate channel.
      await client.query(
        `INSERT INTO nuke_holders (owner, symbol, count) VALUES ($1, $2, $3)
         ON CONFLICT (owner, symbol) DO UPDATE SET count = nuke_holders.count + EXCLUDED.count`,
        [owner, symbol, reward]
      );
      await client.query(
        `INSERT INTO nuke_events (kind, owner, symbol, nukes) VALUES ('referral', $1, $2, $3)`,
        [owner, symbol, reward]
      );
      await client.query("COMMIT");
      await pool.query(`DELETE FROM refer_claim_nonces WHERE owner=$1`, [owner]);
      {
        const { signalNukesChanged, signalReferralChanged } = await import("./broadcast");
        signalNukesChanged(owner);
        signalReferralChanged(owner);
      }
      return reply.send({ ok: true, symbol, nukes: reward });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
}
