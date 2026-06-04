/**
 * Evidence Search Result Cache
 *
 * Disk-based cache for Component 5E (External Evidence Search) results.
 *
 * Why a separate cache from llmCache.js:
 *   1. The evidence search calls Anthropic web_search directly — it does not go
 *      through routedLLM, so the LLM prompt cache never sees these calls.
 *   2. The user prompt includes dynamic context (source counts, entities) that
 *      changes every run, making prompt-hash caching useless.
 *   3. Evidence findings are stable for days/weeks — cache the RESULTS, not the prompt.
 *
 * Cache key = category + EVIDENCE_SEARCH_VERSION + YYYY-MM
 *   → Stable for the whole month; auto-invalidates on version bump or month rollover.
 *   → Override: EVIDENCE_CACHE_BYPASS=1 forces a fresh search regardless.
 *
 * Default TTL: 7 days (EVIDENCE_CACHE_TTL_HOURS env var).
 * Cache dir:   .cache/evidence_search/ (EVIDENCE_CACHE_DIR env var).
 */

import { createHash }              from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join }                    from "node:path";

const TTL_MS   = parseInt(process.env.EVIDENCE_CACHE_TTL_HOURS || "168", 10) * 3_600_000;
const CACHE_DIR = process.env.EVIDENCE_CACHE_DIR ||
  join(process.cwd(), ".cache", "evidence_search");

let _dirEnsured = false;
async function ensureDir() {
  if (_dirEnsured) return;
  try { await mkdir(CACHE_DIR, { recursive: true }); } catch {}
  _dirEnsured = true;
}

/**
 * Build a stable cache key from category + pipeline version + current UTC month.
 * Changing either the version constant or the calendar month auto-invalidates.
 */
export function buildEvidenceCacheKey(category, version) {
  const month = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  return createHash("sha256")
    .update(`${category}:${version}:${month}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Read a cached evidence result.
 * Returns null on miss, expiry, or any I/O error.
 *
 * @param {string} key - From buildEvidenceCacheKey
 * @returns {Promise<object|null>}
 */
export async function evidenceCacheGet(key) {
  if (process.env.EVIDENCE_CACHE_BYPASS === "1") return null;
  try {
    const raw = await readFile(join(CACHE_DIR, `${key}.json`), "utf-8");
    const { value, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Write evidence results to cache.
 * Silently swallows write failures — a cache miss is never fatal.
 *
 * @param {string} key   - From buildEvidenceCacheKey
 * @param {object} value - The full category result to cache
 */
export async function evidenceCacheSet(key, value) {
  try {
    await ensureDir();
    await writeFile(
      join(CACHE_DIR, `${key}.json`),
      JSON.stringify({
        value,
        expiresAt: Date.now() + TTL_MS,
        savedAt:   new Date().toISOString(),
      }),
      "utf-8",
    );
  } catch {}
}

/**
 * Return cache configuration for diagnostics.
 */
export function getEvidenceCacheConfig() {
  return {
    dir:         CACHE_DIR,
    ttl_hours:   TTL_MS / 3_600_000,
    bypass:      process.env.EVIDENCE_CACHE_BYPASS === "1",
  };
}
