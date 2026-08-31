// Global snapshot cache for mutation-driven domains.
// Pattern: after a DB commit, the mutation site calls bumpCache(); the next reader
// recomputes the payload on version mismatch, or serves the cache when it matches.
// The board payload is intentionally NOT cached (live counters — always fresh).

export type CacheDomain = "cells" | "pools" | "leaderboard";

interface Entry {
  version: number;
  value: unknown;
  at: number;
}

const versions: Record<CacheDomain, number> = { cells: 0, pools: 0, leaderboard: 0 };
const gens: Record<CacheDomain, number> = { cells: 0, pools: 0, leaderboard: 0 };
const entries: Partial<Record<CacheDomain, Entry>> = {};

export function cacheVersion(domain: CacheDomain): number {
  return versions[domain];
}

export function cacheGeneration(domain: CacheDomain): number {
  return gens[domain];
}

export function bumpCache(domains: CacheDomain | CacheDomain[]): void {
  for (const d of Array.isArray(domains) ? domains : [domains]) versions[d]++;
}

/** Returns the value when valid and fresh; null when missing/stale (caller recomputes). */
export function cachedValue<T>(domain: CacheDomain, maxAgeMs = Number.POSITIVE_INFINITY): T | null {
  const e = entries[domain];
  if (!e || e.version !== versions[domain]) return null;
  if (Date.now() - e.at >= maxAgeMs) return null;
  return e.value as T;
}

/** Commits a payload. `version` was captured at recompute start — if a bump happens
 *  during recompute the entry stays stale and the next read recomputes again
 *  (fail-safe: stale data is never served as fresh). */
export function commitCache<T>(domain: CacheDomain, value: T, version: number): void {
  gens[domain]++;
  entries[domain] = { version, value, at: Date.now() };
}
