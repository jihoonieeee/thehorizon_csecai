/**
 * LLM Prompt Cache
 *
 * Two-level cache: in-memory (process lifetime) + optional disk (across runs).
 *
 * Cache key: SHA-256 of (systemPrompt + "\x00" + userPrompt + "\x00" + modelId)
 * TTL: configurable via LLM_CACHE_TTL_HOURS (default: 48h)
 * Disk store: LLM_CACHE_DIR/<hash>.json (optional; disabled if env not set)
 *
 * Usage:
 *   const cached = await llmCache.get(key);
 *   if (cached) return { ...cached, cache_hit: true };
 *   ...call LLM...
 *   await llmCache.set(key, result);
 */

import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const TTL_MS    = (parseInt(process.env.LLM_CACHE_TTL_HOURS || "48", 10)) * 3600 * 1000;
const CACHE_DIR = process.env.LLM_CACHE_DIR || null;

// In-memory store: key → { value, expiresAt }
const _memCache = new Map();

// Stats
let hits = 0;
let misses = 0;
let diskHits = 0;

// ── Key builder ───────────────────────────────────────────────────────────────

/**
 * Build a cache key from the inputs that determine the LLM response.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} modelId      - Specific model called (not provider alias)
 * @returns {string} 16-char hex prefix (collision-safe for this use case)
 */
export function buildCacheKey(systemPrompt, userPrompt, modelId = "") {
  const raw = `${systemPrompt}\x00${userPrompt}\x00${modelId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ── In-memory cache ───────────────────────────────────────────────────────────

function memGet(key) {
  const entry = _memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value) {
  _memCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  // Evict oldest entries if cache grows too large (>2000 entries)
  if (_memCache.size > 2000) {
    const oldest = [..._memCache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, 200);
    for (const [k] of oldest) _memCache.delete(k);
  }
}

// ── Disk cache ────────────────────────────────────────────────────────────────

let _diskReady = false;

async function ensureDiskDir() {
  if (!CACHE_DIR || _diskReady) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    _diskReady = true;
  } catch {
    // Non-fatal: disk cache just won't work
  }
}

async function diskGet(key) {
  if (!CACHE_DIR) return null;
  try {
    const path = join(CACHE_DIR, `${key}.json`);
    const raw  = await readFile(path, "utf8");
    const entry = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) return null;
    return entry.value;
  } catch {
    return null;
  }
}

async function diskSet(key, value) {
  if (!CACHE_DIR) return;
  await ensureDiskDir();
  if (!_diskReady) return;
  try {
    const path  = join(CACHE_DIR, `${key}.json`);
    const entry = { value, expiresAt: Date.now() + TTL_MS, savedAt: new Date().toISOString() };
    await writeFile(path, JSON.stringify(entry), "utf8");
  } catch {
    // Non-fatal
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a cached LLM response.
 *
 * @param {string} key  - From buildCacheKey()
 * @returns {Promise<object|null>} Cached result object or null
 */
export async function cacheGet(key) {
  // Memory first (fast path)
  const mem = memGet(key);
  if (mem) {
    hits++;
    return mem;
  }

  // Disk fallback (async)
  const disk = await diskGet(key);
  if (disk) {
    memSet(key, disk); // populate memory for subsequent calls
    diskHits++;
    hits++;
    return disk;
  }

  misses++;
  return null;
}

/**
 * Store an LLM response in the cache.
 *
 * @param {string} key    - From buildCacheKey()
 * @param {object} value  - The result to cache (should be the full routedLLM return)
 * @returns {Promise<void>}
 */
export async function cacheSet(key, value) {
  memSet(key, value);
  await diskSet(key, value);
}

/**
 * Get cache statistics.
 *
 * @returns {{ hits: number, misses: number, disk_hits: number, hit_rate: string, in_memory: number }}
 */
export function getCacheStats() {
  const total    = hits + misses;
  const hit_rate = total === 0 ? "0%" : `${Math.round((hits / total) * 100)}%`;
  return {
    hits,
    misses,
    disk_hits: diskHits,
    hit_rate,
    in_memory: _memCache.size,
    ttl_hours: TTL_MS / 3600000,
    disk_cache: CACHE_DIR || "(disabled)",
  };
}

/**
 * Clear the in-memory cache (does not affect disk).
 */
export function clearMemoryCache() {
  _memCache.clear();
}
