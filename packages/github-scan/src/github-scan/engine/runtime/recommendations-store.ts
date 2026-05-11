/**
 * Read/write `~/.first-tree/github-scan/recommendations.json` — the cache of
 * LLM-generated structured actions for the island feature.
 *
 * SEPARATE FROM INBOX (deliberate):
 *   The Rust fetcher is the single writer of `inbox.json`. The Rust encoder's
 *   key set is frozen, so we cannot add a `recommendation` field there
 *   without breaking Rust ↔ TS round-tripping. Instead we keep recommendations
 *   in a sibling file owned by the TS daemon. The HTTP layer joins the two
 *   when serving `/inbox`.
 *
 * Concurrency:
 *   - Multiple subscribers may publish recommendations concurrently
 *     (the worker batches but errors are isolated per item). We use the
 *     same `proper-lockfile`-based pattern as `store.ts`.
 *   - Atomic writes: write to `.tmp` + rename, identical to `writeInbox`.
 *
 * Eviction:
 *   - On every write we drop entries whose id no longer exists in the
 *     current inbox. This keeps the cache bounded to live items.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { lock } from "proper-lockfile";

import {
  RecommendationCacheSchema,
  type Recommendation,
  type RecommendationCache,
} from "./types.js";

const EMPTY_CACHE: RecommendationCache = { version: 1, recommendations: {} };

/**
 * Read the cache. Returns an empty cache if the file is missing — that is
 * the legitimate first-run state. Throws on malformed JSON or schema drift,
 * matching the loud-error policy of `readInbox`.
 */
export function readRecommendations(path: string): RecommendationCache {
  if (!existsSync(path)) return { ...EMPTY_CACHE };
  const raw = readFileSync(path, "utf-8");
  if (raw.trim().length === 0) return { ...EMPTY_CACHE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`recommendations.json at ${path} is not valid JSON: ${msg}`);
  }
  const result = RecommendationCacheSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `recommendations.json at ${path} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

function serializeCache(cache: RecommendationCache): string {
  return JSON.stringify(cache);
}

/**
 * Atomically write the cache. Internal helper; external callers should use
 * `updateRecommendations` for read-modify-write operations.
 */
function writeRecommendationsFile(path: string, cache: RecommendationCache): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeCache(cache), "utf-8");
  renameSync(tmp, path);
}

export interface UpdateRecommendationsOptions {
  recommendationsPath: string;
  lockfilePath?: string;
  staleMs?: number;
  retries?: number;
}

/**
 * Load → mutate → write under an advisory lock. Mirrors `updateInbox`.
 *
 * The mutator receives the current cache (or an empty one if absent) and
 * returns the new cache, or `null` to abort without writing.
 */
export async function updateRecommendations(
  mutator: (current: RecommendationCache) => RecommendationCache | null,
  options: UpdateRecommendationsOptions,
): Promise<RecommendationCache | null> {
  const parent = dirname(options.recommendationsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const fileExists = existsSync(options.recommendationsPath);
  const lockTarget = fileExists ? options.recommendationsPath : parent;

  const release = await lock(lockTarget, {
    stale: options.staleMs ?? 10_000,
    // Higher retry budget than `updateInbox` (which sees only the poller).
    // Multiple enrichment workers may publish concurrently; in tests we
    // see ~12 in flight at once.
    retries: options.retries ?? { retries: 20, minTimeout: 25, maxTimeout: 250 },
    lockfilePath: options.lockfilePath ?? `${options.recommendationsPath}.lock`,
    realpath: false,
  });
  try {
    const current = readRecommendations(options.recommendationsPath);
    const next = mutator(current);
    if (next === null) return null;
    writeRecommendationsFile(options.recommendationsPath, next);
    return next;
  } finally {
    await release();
  }
}

/**
 * Insert or replace a recommendation. Convenience wrapper around
 * `updateRecommendations`.
 */
export async function putRecommendation(
  rec: Recommendation,
  options: UpdateRecommendationsOptions,
): Promise<void> {
  await updateRecommendations(
    (current) => ({
      ...current,
      recommendations: { ...current.recommendations, [rec.id]: rec },
    }),
    options,
  );
}

/**
 * Drop recommendations whose id is not present in `liveIds`. Called after
 * each inbox poll so the cache does not grow unbounded.
 */
export async function evictStale(
  liveIds: ReadonlySet<string>,
  options: UpdateRecommendationsOptions,
): Promise<number> {
  let dropped = 0;
  await updateRecommendations((current) => {
    const kept: Record<string, Recommendation> = {};
    for (const [id, rec] of Object.entries(current.recommendations)) {
      if (liveIds.has(id)) kept[id] = rec;
      else dropped += 1;
    }
    if (dropped === 0) return null; // no-op write
    return { ...current, recommendations: kept };
  }, options);
  return dropped;
}
