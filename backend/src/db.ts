import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    `postgres://${process.env.USER || "gokay.culpan"}@localhost:5432/pixelwars`,
  // The pool is the concurrency ceiling during purchase bursts + SSE init fanout.
  // Default pg Pool max is 10 — raise it so parallel /confirm + SSE init don't queue.
  max: Number(process.env.PG_POOL_MAX ?? 50),
});

export default pool;
