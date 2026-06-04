/**
 * Web Discovery Result Cache
 *
 * Disk cache for Layer 1B discovery results, keyed by mission + version + week.
 * Discovery is run-bounded and recall-oriented; caching per ISO-week keeps the
 * pipeline from re-spending web-search budget on the same mission within a few
 * days while still refreshing weekly.
 *
 * Bypass with WEB_DISCOVERY_CACHE_BYPASS=1.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const TTL_MS = parseInt(process.env.WEB_DISCOVERY_CACHE_TTL_HOURS || "168", 10) * 3_600_000; // 7d
const CACHE_DIR = process.env.WEB_DISCOVERY_CACHE_DIR || join(process.cwd(), ".cache", "web_discovery");

let _dirEnsured = false;
async function ensureDir() {
  if (_dirEnsured) return;
  try { await mkdir(CACHE_DIR, { recursive: true }); } catch {}
  _dirEnsured = true;
}

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildDiscoveryCacheKey(mission, version) {
  return createHash("sha256").update(`${mission}:${version}:${isoWeek()}`).digest("hex").slice(0, 16);
}

export async function discoveryCacheGet(key) {
  if (process.env.WEB_DISCOVERY_CACHE_BYPASS === "1") return null;
  try {
    const raw = await readFile(join(CACHE_DIR, `${key}.json`), "utf-8");
    const { value, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) return null;
    return value;
  } catch {
    return null;
  }
}

export async function discoveryCacheSet(key, value) {
  try {
    await ensureDir();
    await writeFile(
      join(CACHE_DIR, `${key}.json`),
      JSON.stringify({ value, expiresAt: Date.now() + TTL_MS, savedAt: new Date().toISOString() }),
      "utf-8",
    );
  } catch {}
}

export function getDiscoveryCacheConfig() {
  return {
    dir: CACHE_DIR,
    ttl_hours: TTL_MS / 3_600_000,
    bypass: process.env.WEB_DISCOVERY_CACHE_BYPASS === "1",
    week: isoWeek(),
  };
}
