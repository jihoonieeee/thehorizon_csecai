#!/usr/bin/env node
/**
 * auditFeeds.js — probe all registry feeds and report health.
 *
 * For each enabled feed, attempts a live fetch and checks:
 *   - HTTP status
 *   - Content is valid RSS/Atom (has <item> or <entry> tags)
 *   - At least one item in the last 30 days
 *
 * Prints a table of pass / warn / dead feeds and exits non-zero if any
 * feeds are dead so it can be wired into CI or run manually.
 *
 * Usage:
 *   node scripts/auditFeeds.js           — check all enabled feeds
 *   node scripts/auditFeeds.js --all     — include disabled feeds
 *   node scripts/auditFeeds.js --fix     — print suggested registry fixes for dead feeds
 */

import "dotenv/config";
import { SOURCE_REGISTRY } from "../lib/pipeline/ingest/sourceRegistry.js";

const TIMEOUT_MS  = 12000;
const BROWSER_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const CHECK_ALL   = process.argv.includes("--all");
const SHOW_FIX    = process.argv.includes("--fix");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function getTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() || "";
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/atom+xml, text/xml, */*" },
    });
    if (!res.ok) return { ok: false, status: res.status, items: 0, latestDate: null };
    const xml = await res.text();
    const isAtom = url.includes("atom") || xml.slice(0, 500).includes("<feed");
    const chunks = isAtom
      ? xml.split(/<entry[\s>]/).slice(1)
      : xml.split(/<item[\s>]/).slice(1);
    const isFeed = chunks.length > 0 || xml.includes("<rss") || xml.includes("<feed");
    if (!isFeed) return { ok: false, status: res.status, items: 0, latestDate: null, notFeed: true };
    // Parse dates from first 5 items
    const dates = chunks.slice(0, 5).map((chunk) => {
      const raw = getTag(chunk, "pubDate") || getTag(chunk, "published") || getTag(chunk, "updated") || getTag(chunk, "dc:date");
      return raw ? new Date(raw) : null;
    }).filter((d) => d && !isNaN(d));
    const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return { ok: true, status: res.status, items: chunks.length, latestDate: latest };
  } catch (err) {
    return { ok: false, status: 0, items: 0, latestDate: null, error: err.message.slice(0, 60) };
  }
}

const feeds = SOURCE_REGISTRY.filter((s) => CHECK_ALL || s.enabled !== false);
console.log(`\nAuditing ${feeds.length} feeds (${CHECK_ALL ? "all including disabled" : "enabled only"})…\n`);

const results = await Promise.all(feeds.map(async (source) => {
  const result = await probeUrl(source.url);
  return { source, ...result };
}));

// Sort: dead first, then warn, then pass
const dead = results.filter((r) => !r.ok);
const stale = results.filter((r) => r.ok && r.latestDate && (Date.now() - r.latestDate.getTime() > THIRTY_DAYS));
const pass = results.filter((r) => r.ok && (!r.latestDate || Date.now() - r.latestDate.getTime() <= THIRTY_DAYS));

const statusIcon = (r) => !r.ok ? "✗ DEAD " : (stale.includes(r) ? "⚠ STALE" : "✓ OK   ");
const latestStr  = (d) => d ? d.toISOString().slice(0, 10) : "no date";

console.log("Feed".padEnd(38), "Status ", "Items", "Latest     ", "Publisher");
console.log("─".repeat(100));
for (const r of [...dead, ...stale, ...pass]) {
  const name    = (r.source.name || "").slice(0, 36).padEnd(37);
  const items   = String(r.ok ? r.items : 0).padStart(5);
  const latest  = latestStr(r.latestDate).padEnd(11);
  const pub     = (r.source.publisher || "").slice(0, 22);
  const detail  = !r.ok ? (r.error || `HTTP ${r.status}${r.notFeed ? " (not a feed)" : ""}`) : "";
  console.log(name, statusIcon(r), items, latest, pub, detail ? `  [${detail}]` : "");
}

console.log("\n─".repeat(100));
console.log(`  ✓ OK: ${pass.length}   ⚠ STALE: ${stale.length}   ✗ DEAD: ${dead.length}`);

if (SHOW_FIX && dead.length > 0) {
  console.log("\n── Suggested fixes (add to sourceRegistry.js) ──");
  for (const r of dead) {
    console.log(`  { name: "${r.source.name}", enabled: false },  // HTTP ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  }
}

if (dead.length > 0) {
  console.log(`\n⚠  ${dead.length} dead feed(s). Run with --fix to see suggested registry changes.\n`);
  process.exit(1);
}
console.log("\n✓ All feeds healthy.\n");
