#!/usr/bin/env node
/**
 * auditSourceDates.js — REPORT-ONLY publish-date audit for non-arXiv sources.
 *
 * fixSourceDates.js only ever looks at sources with a null / low-confidence /
 * arXiv-bleed date. It cannot catch a source that stored a *confident but wrong*
 * date — e.g. Check Point's "29th June" report stored as 2025-07-21 with
 * date_confidence="exact". This audit cross-checks every non-arXiv source's
 * stored date_published against two independent, cheaper-than-the-LLM signals:
 *
 *   1. URL-path date   — blog/CMS convention .../YYYY/MM/DD/ or .../YYYY/MM/
 *                        (dfrlab, volexity, googleblog, checkpoint …). Authoritative
 *                        for these publishers; needs no network call.
 *   2. Page meta date  — best-effort fetch of the page, parsing the same
 *                        og:article:published_time / JSON-LD datePublished /
 *                        <time datetime> tags fixSourceDates.js uses. Many sites
 *                        are bot-protected (403/202) or SPAs (NVD) → skipped.
 *
 * It also flags "collection-bleed": date_published within a few minutes of
 * created_at, i.e. the scrape time got stored as the publish date.
 *
 * This script NEVER writes to the database. It prints a report and can dump the
 * findings to JSON for review. Correct the flagged rows separately once reviewed.
 *
 * Usage:
 *   node scripts/auditSourceDates.js                 # URL-date + fetch audit, report
 *   node scripts/auditSourceDates.js --no-fetch      # URL/title/bleed signals only
 *   node scripts/auditSourceDates.js --tolerance=5   # days of slack before flagging
 *   node scripts/auditSourceDates.js --concurrency=8
 *   node scripts/auditSourceDates.js --out=/tmp/date-audit.json
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  })
);
const FETCH     = !args["no-fetch"];
const TOL_DAYS  = parseInt(args["tolerance"] || "5", 10);
const CONC      = parseInt(args["concurrency"] || "8", 10);
const OUT       = args["out"] || null;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const isArxiv = u => /arxiv\.org/i.test(u || "");
const DAY = 86400000;

// ── Signal 1: URL-path date (highest confidence, no network) ────────────────────
function urlPathDate(url) {
  if (!url) return null;
  let path;
  try { path = new URL(url).pathname; } catch { path = url; }
  const ymd = path.match(/\/(20\d\d)\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
  if (ymd && +ymd[2] <= 12 && +ymd[3] <= 31) return { y: +ymd[1], m: +ymd[2], d: +ymd[3], prec: "day" };
  const ym = path.match(/\/(20\d\d)\/(\d{1,2})(?:\/|$)/);
  if (ym && +ym[2] <= 12) return { y: +ym[1], m: +ym[2], prec: "month" };
  const y = path.match(/\/(20\d\d)\//);
  if (y) return { y: +y[1], prec: "year" };
  return null;
}

// ── Signal 2: textual date in title (e.g. "29th June", "June 29 2025") ───────────
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const MON_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
function titleTextDate(title) {
  const s = (title || "").toLowerCase();
  const a = s.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_RE})(?:\\s+(20\\d\\d))?`));
  if (a) return { d: +a[1], m: MONTHS[a[2].slice(0,3)], y: a[3] ? +a[3] : null };
  const b = s.match(new RegExp(`(${MON_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?`));
  if (b) return { m: MONTHS[b[1].slice(0,3)], d: +b[2], y: b[3] ? +b[3] : null };
  return null;
}

// ── Signal 3: page meta date (best-effort fetch) ─────────────────────────────────
const DATE_META_SELECTORS = [
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /"published"\s*:\s*"(202[0-9][^"]+)"/,
  /<meta[^>]+name=["']DC\.date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  /itemprop=["']datePublished["'][^>]*(?:datetime|content)=["']([^"']+)["']/i,
];
function metaDateFromHtml(html) {
  for (const re of DATE_META_SELECTORS) {
    const m = re.exec(html);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) {
        const iso = d.toISOString().slice(0, 10);
        if (iso >= "2010-01-01" && iso <= new Date(Date.now() + DAY).toISOString().slice(0, 10)) return iso;
      }
    }
  }
  return null;
}
async function fetchPageDate(url, timeoutMs = 12000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0)", "Accept": "text/html" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return { date: null, reason: `http_${res.status}` };
    let html = "";
    const reader = res.body?.getReader();
    if (!reader) return { date: null, reason: "no_body" };
    while (html.length < 80000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});
    const date = metaDateFromHtml(html);
    return { date, reason: date ? "meta_tag" : "no_date_in_html" };
  } catch (e) {
    return { date: null, reason: e.name === "AbortError" ? "timeout" : e.message.slice(0, 30) };
  }
}

// ── Compare an "evidence" date fragment against the stored date ──────────────────
// Returns { flag, diffDays, reason } where evidence dates may be partial (year/month).
function compare(stored, ev) {
  const sd = new Date(stored);
  const sy = sd.getUTCFullYear(), sm = sd.getUTCMonth() + 1, sD = sd.getUTCDate();
  if (ev.iso) {
    const diff = Math.abs(new Date(ev.iso) - sd) / DAY;
    return diff > TOL_DAYS ? { flag: true, diffDays: Math.round(diff) } : { flag: false, diffDays: Math.round(diff) };
  }
  // partial URL/title date
  if (ev.y && ev.y !== sy) return { flag: true, diffDays: null, reason: "year" };
  if (ev.m && (ev.m !== sm || (ev.y && ev.y !== sy))) {
    // allow month-recap false positives only when day precision missing AND within adjacent month
    const adj = Math.abs(ev.m - sm) <= 1 && !ev.d;
    return { flag: !adj, diffDays: null, reason: adj ? "month_adjacent" : "month" };
  }
  if (ev.d && ev.m === sm && Math.abs(ev.d - sD) > TOL_DAYS) return { flag: true, diffDays: Math.abs(ev.d - sD), reason: "day" };
  return { flag: false, diffDays: null };
}

// ── Load ─────────────────────────────────────────────────────────────────────────
async function loadSources() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id,title,url,date_published,date_confidence,publisher,created_at,source_type")
      .range(from, from + 999);
    if (error) { console.error("load error:", error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all.filter(s => !isArxiv(s.url) && s.date_published);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  Source publish-date audit (report only, no writes)`);
  console.log(`  fetch=${FETCH}  tolerance=${TOL_DAYS}d  concurrency=${CONC}`);
  console.log(`${"═".repeat(72)}\n`);

  const rows = await loadSources();
  console.log(`  Loaded ${rows.length} non-arXiv sources with a stored date.\n`);

  // Optionally fetch page dates first (concurrency pool).
  const pageDate = new Map();   // id → iso | null
  const fetchReason = new Map();
  if (FETCH) {
    console.log(`  Fetching page dates…`);
    let done = 0;
    for (let i = 0; i < rows.length; i += CONC) {
      const chunk = rows.slice(i, i + CONC);
      const res = await Promise.all(chunk.map(r => fetchPageDate(r.url)));
      chunk.forEach((r, j) => { pageDate.set(r.id, res[j].date); fetchReason.set(r.id, res[j].reason); });
      done += chunk.length;
      if (done % 80 === 0 || done === rows.length) process.stdout.write(`\r    ${done}/${rows.length}`);
      await new Promise(r => setTimeout(r, 150));
    }
    console.log("");
    const reasons = {};
    for (const v of fetchReason.values()) reasons[v] = (reasons[v] || 0) + 1;
    console.log(`  Fetch outcomes:`, reasons, "\n");
  }

  const findings = [];
  let bleed = 0;
  for (const s of rows) {
    const url  = urlPathDate(s.url);
    const ttl  = titleTextDate(s.title);
    const meta = pageDate.get(s.id) || null;

    // Signal precedence: page meta (most authoritative) > URL-path day > URL month/year > title.
    let ev = null, evSrc = null;
    if (meta)                       { ev = { iso: meta };                    evSrc = "page_meta"; }
    else if (url?.prec === "day")   { ev = { iso: `${url.y}-${String(url.m).padStart(2,"0")}-${String(url.d).padStart(2,"0")}` }; evSrc = "url_path"; }
    else if (url)                   { ev = { y: url.y, m: url.m };           evSrc = `url_path_${url.prec}`; }
    else if (ttl)                   { ev = { y: ttl.y, m: ttl.m, d: ttl.d }; evSrc = "title"; }

    // Collection-bleed: publish date ≈ scrape time.
    const bleedMin = s.created_at ? Math.abs(new Date(s.created_at) - new Date(s.date_published)) / 60000 : null;
    const isBleed = bleedMin != null && bleedMin < 10;
    if (isBleed) bleed++;

    if (!ev && !isBleed) continue;
    const cmp = ev ? compare(s.date_published, ev) : { flag: false };
    if (!cmp.flag && !isBleed) continue;

    // Confidence: page_meta & url_path(day) are reliable; title & bleed-only are advisory.
    const reliable = evSrc === "page_meta" || evSrc === "url_path";
    findings.push({
      id: s.id,
      title: s.title,
      url: s.url,
      publisher: s.publisher,
      stored: s.date_published,
      stored_confidence: s.date_confidence,
      evidence_date: ev?.iso || (ev?.y ? `${ev.y}-${ev.m ? String(ev.m).padStart(2,"0") : "??"}` : null),
      evidence_source: evSrc,
      diff_days: cmp.diffDays ?? null,
      collection_bleed: isBleed,
      confidence: reliable ? "high" : (isBleed ? "medium" : "low"),
    });
  }

  // ── Report ─────────────────────────────────────────────────────────────────────
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.confidence] - order[b.confidence] || (b.diff_days || 0) - (a.diff_days || 0));

  const byConf = { high: 0, medium: 0, low: 0 };
  for (const f of findings) byConf[f.confidence]++;

  console.log(`${"─".repeat(72)}`);
  console.log(`  FLAGGED: ${findings.length}  (high=${byConf.high} medium=${byConf.medium} low=${byConf.low})`);
  console.log(`  collection-bleed rows: ${bleed}`);
  console.log(`${"─".repeat(72)}\n`);

  for (const f of findings) {
    const tag = f.confidence.toUpperCase().padEnd(6);
    const bl  = f.collection_bleed ? " [BLEED]" : "";
    const diff = f.diff_days != null ? ` Δ${f.diff_days}d` : "";
    console.log(`  ${tag} stored=${f.stored.slice(0,10)} → evidence=${f.evidence_date || "?"} (${f.evidence_source})${diff}${bl}`);
    console.log(`         ${(f.title || "").slice(0,64)}`);
    console.log(`         ${f.url}\n`);
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify(findings, null, 2)); console.log(`  Wrote ${findings.length} findings → ${OUT}\n`); }
  console.log(`  Review 'high'-confidence rows first; these have an authoritative URL-path`);
  console.log(`  or page-meta date that disagrees with the stored value. Nothing was written.\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
