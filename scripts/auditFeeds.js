#!/usr/bin/env node
/**
 * auditFeeds.js — probe registry feeds, auto-heal dead ones, auto-disable truly dead ones.
 *
 * Recovery ladder for a failing feed (tried in order):
 *   1. Feed autodiscovery — scrape site homepage for <link rel="alternate"> RSS tag
 *   2. Google News RSS proxy — news.google.com/rss/search?q=site:domain works for any
 *      news outlet blocked by Cloudflare from CI IPs (BleepingComputer, SecurityWeek…)
 *   3. Jina proxy — r.jina.ai/{url} renders JS-heavy pages; sometimes returns raw XML
 *
 * Outcomes written to sourceRegistry.js in-place:
 *   - Healed (new url found)  → update url: field + add a comment
 *   - Confirmed dead (404/DNS, all recovery failed) → set enabled: false
 *   - Uncertain (403/5xx/timeout, recovery failed)  → log warning, no change
 *
 * Usage:
 *   node scripts/auditFeeds.js              # probe + print report (no changes)
 *   node scripts/auditFeeds.js --auto-fix   # apply heals + disable confirmed-dead
 *   node scripts/auditFeeds.js --all        # include already-disabled feeds
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { SOURCE_REGISTRY } from "../lib/pipeline/ingest/sourceRegistry.js";

const __dirname   = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "../lib/pipeline/ingest/sourceRegistry.js");

const TIMEOUT_MS  = 12000;
const BROWSER_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const AUTO_FIX    = process.argv.includes("--auto-fix");
const CHECK_ALL   = process.argv.includes("--all");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// ── Feed probe ────────────────────────────────────────────────────────────────

function getTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() || "";
}

function parseFeedXml(url, xml) {
  const isAtom  = url.includes("atom") || xml.slice(0, 500).includes("<feed");
  const chunks  = isAtom
    ? xml.split(/<entry[\s>]/).slice(1)
    : xml.split(/<item[\s>]/).slice(1);
  const isFeed  = chunks.length > 0 || xml.includes("<rss") || xml.includes("<feed");
  if (!isFeed) return null;
  const dates = chunks.slice(0, 5).map((chunk) => {
    const raw = getTag(chunk, "pubDate") || getTag(chunk, "published") || getTag(chunk, "updated");
    return raw ? new Date(raw) : null;
  }).filter((d) => d && !isNaN(d));
  const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
  return { items: chunks.length, latestDate: latest };
}

async function fetchXml(url, ua = BROWSER_UA) {
  const res = await fetch(url, {
    signal:  AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": ua, Accept: "application/rss+xml, application/atom+xml, text/xml, */*" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const xml    = await res.text();
  const parsed = parseFeedXml(url, xml);
  if (!parsed)  return { ok: false, status: res.status, notFeed: true };
  return { ok: true, status: res.status, url, ...parsed };
}

// Is this a "confirmed dead" status (safe to auto-disable)?
// 404/410 = content gone. DNS error = domain gone. These won't self-heal.
// 403/5xx/timeout = uncertain — could be temporary or IP-based block.
function isConfirmedDead(status, errorMsg = "") {
  if (status === 404 || status === 410) return true;
  if (/ENOTFOUND|ENOENT|getaddrinfo/i.test(errorMsg)) return true;
  return false;
}

// ── Recovery strategies ───────────────────────────────────────────────────────

async function tryAutodiscovery(source) {
  try {
    const { resolveFeedUrl } = await import("../lib/pipeline/ingest/feedResolver.js");
    const { feedUrl } = await resolveFeedUrl(source.url, { homepage: source.homepage });
    if (!feedUrl || feedUrl === source.url) return null;
    const probe = await fetchXml(feedUrl);
    if (probe.ok) return { via: "autodiscovery", url: feedUrl, ...probe };
  } catch {}
  return null;
}

async function tryGoogleNews(source) {
  // Extract domain from the feed URL or homepage
  const base = source.homepage || source.url;
  const domain = base.match(/https?:\/\/([^/]+)/)?.[1];
  if (!domain) return null;
  const gnUrl = `https://news.google.com/rss/search?q=site:${domain}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const probe = await fetchXml(gnUrl);
    if (probe.ok && probe.items > 0) return { via: "google_news", url: gnUrl, ...probe };
  } catch {}
  return null;
}

async function tryJina(source) {
  const jinaUrl = `https://r.jina.ai/${source.url}`;
  try {
    const res = await fetch(jinaUrl, {
      signal:  AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": BROWSER_UA, Accept: "text/plain" },
    });
    if (!res.ok) return null;
    const xml    = await res.text();
    const parsed = parseFeedXml(source.url, xml);
    if (parsed) return { via: "jina", url: source.url, ...parsed };
  } catch {}
  return null;
}

// ── Registry patcher ───────────────────────────────────────���──────────────────

function patchRegistry(changes) {
  // changes: [{ source, action: "heal"|"disable", newUrl?, reason }]
  if (changes.length === 0) return false;

  let text = readFileSync(REGISTRY_PATH, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  for (const change of changes) {
    const { source, action, newUrl, reason } = change;
    // Find the entry by its URL value — unique per entry
    const escapedUrl = source.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const urlLineRe  = new RegExp(`([ \\t]*url:\\s*["']${escapedUrl}["'],?)`, "m");

    if (!urlLineRe.test(text)) {
      console.warn(`  [patch] could not locate entry for ${source.name} — skipping`);
      continue;
    }

    if (action === "heal" && newUrl) {
      // Replace the url: value and add a comment on the next line
      text = text.replace(urlLineRe, (match) => {
        const indent = match.match(/^([ \t]*)url:/m)?.[1] || "    ";
        const quote  = match.includes('"') ? '"' : "'";
        return `${indent}url: ${quote}${newUrl}${quote},\n${indent}// Healed ${today} via ${change.via}: original URL was ${source.url}`;
      });
    } else if (action === "disable") {
      // Add enabled: false after the url: line
      text = text.replace(urlLineRe, (match) => {
        const indent = match.match(/^([ \t]*)url:/)?.[1] || "    ";
        return `${match}\n${indent}enabled: false,  // auto-disabled ${today}: ${reason}`;
      });
    }
  }

  writeFileSync(REGISTRY_PATH, text, "utf8");
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const feeds = SOURCE_REGISTRY.filter((s) => CHECK_ALL || s.enabled !== false);
console.log(`\nAuditing ${feeds.length} feeds${AUTO_FIX ? " (auto-fix ON)" : ""}…\n`);

// Probe all feeds in parallel
const probeResults = await Promise.all(feeds.map(async (source) => {
  try {
    const result = await fetchXml(source.url);
    return { source, probe: result, err: null };
  } catch (err) {
    return { source, probe: { ok: false, status: 0, error: err.message }, err: err.message };
  }
}));

// For failed feeds, run recovery in parallel
const recoveryResults = await Promise.all(probeResults.map(async (r) => {
  if (r.probe.ok) return { ...r, recovery: null };
  const [disco, gnews, jina] = await Promise.all([
    tryAutodiscovery(r.source),
    tryGoogleNews(r.source),
    tryJina(r.source),
  ]);
  const recovery = disco || gnews || jina || null;
  return { ...r, recovery };
}));

// Classify results
const ok       = recoveryResults.filter((r) => r.probe.ok);
const healed   = recoveryResults.filter((r) => !r.probe.ok && r.recovery);
const confirmed = recoveryResults.filter((r) => !r.probe.ok && !r.recovery &&
  isConfirmedDead(r.probe.status, r.err || ""));
const uncertain = recoveryResults.filter((r) => !r.probe.ok && !r.recovery &&
  !isConfirmedDead(r.probe.status, r.err || ""));
const stale    = ok.filter((r) => r.probe.latestDate &&
  Date.now() - r.probe.latestDate.getTime() > THIRTY_DAYS);

// Print table
const icon = (r) => {
  if (healed.includes(r))    return "↺ HEALED";
  if (confirmed.includes(r)) return "✗ DEAD  ";
  if (uncertain.includes(r)) return "? UNSURE";
  if (stale.includes(r))     return "⚠ STALE ";
  return                            "✓ OK    ";
};
const latestStr = (d) => d ? d.toISOString().slice(0, 10) : "—";

console.log("Feed".padEnd(36), "Status  ", "Items", "Latest    ", "Notes");
console.log("─".repeat(100));
for (const r of [...confirmed, ...uncertain, ...healed, ...stale, ...ok]) {
  const name   = r.source.name.slice(0, 35).padEnd(35);
  const items  = String(r.probe.ok ? r.probe.items : (r.recovery?.items || 0)).padStart(5);
  const latest = latestStr(r.probe.ok ? r.probe.latestDate : r.recovery?.latestDate).padEnd(10);
  let   notes  = "";
  if (!r.probe.ok && !r.recovery) notes = r.err || `HTTP ${r.probe.status}`;
  if (r.recovery)                 notes = `→ ${r.recovery.via}: ${r.recovery.url.slice(0, 55)}`;
  console.log(name, icon(r), items, latest, notes.slice(0, 60));
}

console.log("\n─".repeat(100));
console.log(`  ✓ OK: ${ok.length - stale.length}   ⚠ STALE: ${stale.length}   ↺ HEALED: ${healed.length}   ? UNSURE: ${uncertain.length}   ✗ DEAD: ${confirmed.length}`);

// Apply fixes
if (AUTO_FIX && (healed.length > 0 || confirmed.length > 0)) {
  console.log("\n── Applying fixes to sourceRegistry.js ──");

  const changes = [
    ...healed.map((r) => ({
      source:  r.source,
      action:  "heal",
      newUrl:  r.recovery.url,
      via:     r.recovery.via,
      reason:  `original ${r.source.url} returned HTTP ${r.probe.status}`,
    })),
    ...confirmed.map((r) => ({
      source:  r.source,
      action:  "disable",
      reason:  r.err || `HTTP ${r.probe.status}`,
    })),
  ];

  const patched = patchRegistry(changes);
  if (patched) {
    for (const c of changes) {
      if (c.action === "heal")    console.log(`  ↺ healed    ${c.source.name} → ${c.newUrl}`);
      if (c.action === "disable") console.log(`  ✗ disabled  ${c.source.name} (${c.reason})`);
    }
    console.log(`\n  sourceRegistry.js updated — commit this file to apply permanently.\n`);
  }
}

if (!AUTO_FIX && (healed.length > 0 || confirmed.length > 0)) {
  console.log(`\n  Run with --auto-fix to heal ${healed.length} feed(s) and disable ${confirmed.length} dead feed(s).\n`);
}

if (uncertain.length > 0) {
  console.log(`  ${uncertain.length} feed(s) had uncertain failures (403/5xx/timeout) — not auto-disabled.`);
  console.log(`  These may be temporary or IP-based blocks. Re-run to confirm.\n`);
}

process.exit(confirmed.length > 0 ? 1 : 0);
