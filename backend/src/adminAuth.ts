import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import pool from "./db";
import { getAdminWallets } from "./configStore";

// ed25519 signature-verified admin login + JWT (HS256, via node:crypto).
// Replay protection: single-use nonce (5min TTL), JWT exp 2h, nonce bound to the wallet.

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_S = 2 * 60 * 60;

function jwtSecret(): string {
  const s = process.env.ADMIN_JWT_SECRET ?? "";
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_JWT_SECRET env required in production");
  }
  return s;
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function buildToken(payload: { sub: string; iat: number; exp: number }): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(createHmac("sha256", jwtSecret()).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyToken(token: string): { sub: string } | null {
  try {
    const [h, b, s] = token.split(".");
    if (!h || !b || !s) return null;
    const expected = createHmac("sha256", jwtSecret()).update(`${h}.${b}`).digest();
    const a = Buffer.from(s, "base64url");
    if (a.length !== expected.length || !timingSafeEqual(a, expected)) return null;
    const payload = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

function messageFor(wallet: string, nonce: string, issuedAt: string, expiresAt: string): string {
  return `PixelWars admin login\nwallet: ${wallet}\nnonce: ${nonce}\nissued: ${issuedAt}\nexpires: ${expiresAt}`;
}

function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  // cookie support (optional)
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.split(";").map((c) => c.trim().split("=")).find(([k]) => k === "pw_admin");
    if (m && m[1]) return m.slice(1).join("=");
  }
  return null;
}

/** preHandler for admin routes. Sets `req.adminWallet`. */
export function requireAdmin(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(req);
    if (!token) return reply.code(401).send({ error: "no_token" });
    const payload = verifyToken(token);
    if (!payload) return reply.code(401).send({ error: "invalid_token" });
    if (!getAdminWallets().includes(payload.sub)) {
      return reply.code(403).send({ error: "not_admin" });
    }
    (req as any).adminWallet = payload.sub;
  };
}

export async function adminAuthRoutes(app: FastifyInstance) {
  // Generate + store a nonce. Does NOT reveal admin membership.
  app.get("/admin/nonce", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const wallet = (req.query as any)?.wallet as string | undefined;
    if (!wallet) return reply.code(400).send({ error: "missing_wallet" });
    try { new PublicKey(wallet); } catch { return reply.code(400).send({ error: "invalid_wallet" }); }
    // expiry prune
    await pool.query(`DELETE FROM admin_nonces WHERE expires_at < now()`);
    const nonce = randomBytes(32).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    await pool.query(
      `INSERT INTO admin_nonces (nonce, wallet, issued_at, expires_at) VALUES ($1,$2,$3,$4)`,
      [nonce, wallet, issuedAt, expiresAt]
    );
    return reply.send({
      nonce,
      message: messageFor(wallet, nonce, issuedAt.toISOString(), expiresAt.toISOString()),
      expiresAt: expiresAt.toISOString(),
    });
  });

  // Verify signature + issue a JWT if admin.
  app.post("/admin/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = (req.body ?? {}) as { wallet?: string; nonce?: string; signature?: string };
    const { wallet, nonce, signature } = b;
    if (!wallet || !nonce || !signature) {
      return reply.code(400).send({ error: "missing_fields" });
    }
    let pubBytes: Uint8Array;
    try { pubBytes = new PublicKey(wallet).toBytes(); }
    catch { return reply.code(400).send({ error: "invalid_wallet" }); }

    const res = await pool.query(
      `SELECT nonce, wallet, issued_at, expires_at, used, expires_at > now() AS unexpired
       FROM admin_nonces WHERE nonce=$1`,
      [nonce]
    );
    const row = res.rows[0];
    if (!row) return reply.code(401).send({ error: "bad_nonce" });
    if (row.wallet !== wallet) return reply.code(401).send({ error: "nonce_wallet_mismatch" });
    if (row.used) return reply.code(401).send({ error: "nonce_used" });
    if (!row.unexpired) return reply.code(401).send({ error: "nonce_expired" });

    const message = messageFor(wallet, nonce, row.issued_at.toISOString(), row.expires_at.toISOString());
    let sigBytes: Uint8Array;
    try { sigBytes = bs58.decode(signature); }
    catch { return reply.code(401).send({ error: "bad_signature" }); }
    const ok = nacl.sign.detached.verify(
      Buffer.from(message, "utf8"),
      sigBytes,
      pubBytes
    );
    if (!ok) return reply.code(401).send({ error: "bad_signature" });

    if (!getAdminWallets().includes(wallet)) {
      return reply.code(403).send({ error: "not_admin" });
    }

    await pool.query(`UPDATE admin_nonces SET used=true WHERE nonce=$1`, [nonce]);

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + SESSION_TTL_S;
    const token = buildToken({ sub: wallet, iat, exp });
    return reply.send({ token, expiresAt: new Date(exp * 1000).toISOString() });
  });

  // Pre-login boolean check so non-admin users never see a signature prompt.
  // No auth (public): wallet addresses are already public on-chain; this endpoint just
  // answers "is admin?" with a boolean and only asks for the hidden route.
  app.get("/admin/whitelisted", async (req, reply) => {
    const vault = String((req.query as any)?.vault ?? "");
    return reply.send({ whitelisted: getAdminWallets().includes(vault) });
  });

  app.post("/admin/logout", async (_req, reply) => {
    return reply.send({ ok: true });
  });

  // `isAdmin` response for anyone holding a valid JWT (admin or not).
  app.get("/admin/me", async (req, reply) => {
    const token = extractToken(req);
    if (!token) return reply.code(401).send({ error: "no_token" });
    const payload = verifyToken(token);
    if (!payload) return reply.code(401).send({ error: "invalid_token" });
    return reply.send({ wallet: payload.sub, isAdmin: getAdminWallets().includes(payload.sub) });
  });
}