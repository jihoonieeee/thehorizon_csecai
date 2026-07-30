#!/usr/bin/env node
/**
 * fixSourceDates.js
 *
 * Recovers real publication dates for sources where date_published is null,
 * has date_confidence=low/none, or has a collection-time timestamp (same-second
 * cluster from arXiv bleed).
 *
 * Strategy per source type:
 *   1. arXiv URLs → query arXiv Atom API (exact, authoritative)
 *   2. Other URLs  → HEAD/GET the page, parse <meta> date tags
 *                    (og:article:published_time, article:published_time,
 *                     datePublished, DC.date, etc.)
 *   3. If no date recovered → mark date_confidence=none, leave date_published
 *      null so the source is correctly excluded from period reports
 *
 * Usage:
 *   node scripts/fixSourceDates.js [--dry-run] [--concurrency=5]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args    = Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith("--")).map(a=>{const[k,v]=a.slice(2).split("=");return[k,v??true];}));
const DRY_RUN = Boolean(args["dry-run"]);
const CONC    = parseInt(args["concurrency"]||"5",10);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Identify candidates ────────────────────────────────────────────────────────

async function findCandidates() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("sources")
      .select("id,title,url,date_published,date_confidence,publisher,date_published_actual")
      .eq("validation_status","pass")
      .range(from, from+999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  const candidates = [];

  for (const s of all) {
    const reason = getFixReason(s, all);
    if (reason) candidates.push({ ...s, _fix_reason: reason });
  }

  return candidates;
}

function getFixReason(s, allSources) {
  // Null date — highest priority
  if (!s.date_published) return "null_date";

  // Explicitly low/none confidence
  if (s.date_confidence === "low" || s.date_confidence === "none") return `low_confidence_${s.date_confidence}`;

  // arXiv sources at same second as 2+ other arXiv sources = collection-time bleed
  if (s.url?.includes("arxiv")) {
    const ts = new Date(s.date_published).toISOString().slice(0, 19);
    const sameTs = allSources.filter(o =>
      o.id !== s.id &&
      o.url?.includes("arxiv") &&
      o.date_published &&
      new Date(o.date_published).toISOString().slice(0, 19) === ts
    );
    if (sameTs.length >= 2) return "arxiv_timestamp_bleed";
  }

  return null;
}

// ── arXiv date recovery ────────────────────────────────────────────────────────

const ARXIV_ID_RE = /arxiv\.org\/(?:abs|pdf|html?)\/(\d{4}\.\d{4,5})/i;

async function fetchArxivDates(ids) {
  // Batch up to 50 IDs per request
  const results = {};
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const url = `https://export.arxiv.org/api/query?id_list=${chunk.join(",")}&max_results=${chunk.length}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "HorizonScanner/2.0 date-recovery" },
      });
      if (!res.ok) { console.warn(`  [arxiv-api] HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
      let m;
      while ((m = entryRe.exec(xml)) !== null) {
        const block = m[1];
        const idMatch  = block.match(/<id>.*?arxiv\.org\/abs\/([\d.v]+)<\/id>/);
        const pubMatch = block.match(/<published>([\d-T:Z+]+)<\/published>/);
        if (idMatch && pubMatch) {
          const arxivId = idMatch[1].replace(/v\d+$/, "");
          results[arxivId] = pubMatch[1].slice(0, 10);
        }
      }
    } catch (e) { console.warn(`  [arxiv-api] ${e.message}`); }
    if (i + CHUNK < ids.length) await new Promise(r => setTimeout(r, 1500));
  }
  return results;
}

// ── HTML date recovery ─────────────────────────────────────────────────────────

const DATE_META_SELECTORS = [
  // OpenGraph / article meta tags
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  // Schema.org / JSON-LD (non-empty value only — Webflow sites blank this field)
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /"published"\s*:\s*"(202[0-9][^"]+)"/,
  // DC / Dublin Core
  /<meta[^>]+name=["']DC\.date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  // time element
  /<time[^>]+datetime=["']([^"']+)["']/i,
  // itemprop
  /itemprop=["']datePublished["'][^>]*datetime=["']([^"']+)["']/i,
  /itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
];

// Month-spelled date in visible text — first match is the article's own date
// (subsequent matches are related-post dates in sidebars/footers)
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_MAP   = Object.fromEntries(MONTH_NAMES.map((m,i)=>[m, String(i+1).padStart(2,"0")]));
const MONTH_TEXT_RE = new RegExp(
  `(${MONTH_NAMES.join("|")})\\s+(\\d{1,2}),?\\s+(202\\d)`
);

function extractMonthDate(html) {
  const m = MONTH_TEXT_RE.exec(html);
  if (!m) return null;
  const iso = `${m[3]}-${MONTH_MAP[m[1]]}-${m[2].padStart(2,"0")}`;
  // Sanity check
  const d = new Date(iso);
  if (isNaN(d.getTime()) || iso > new Date().toISOString().slice(0,10)) return null;
  return iso;
}

// Use local calendar date when the raw string has an explicit timezone offset,
// preventing UTC-conversion from shifting editorial publish dates by 1 day.
function extractLocalDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const withTz = raw.match(/^(\d{4}-\d{2}-\d{2})T[\d:.]+[+-]\d{2}:?\d{2}$/);
  if (withTz) return withTz[1];
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractDateFromHtml(html) {
  // 1. Try structured meta/JSON-LD first (most reliable)
  for (const re of DATE_META_SELECTORS) {
    const m = re.exec(html);
    if (m?.[1]) {
      const iso = extractLocalDate(m[1]);
      // Sanity: must be between 2010 and today+1
      if (iso && iso >= "2010-01-01" && iso <= new Date(Date.now()+86400000).toISOString().slice(0,10)) {
        return iso;
      }
    }
  }
  // 2. Fall back to first month-spelled date in visible text
  return extractMonthDate(html);
}

async function fetchPageDate(url, timeoutMs = 10000) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0)",
        "Accept": "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return { date: null, reason: `http_${res.status}` };
    // Only read first 30KB — date meta tags are always in <head>
    const reader = res.body?.getReader();
    if (!reader) return { date: null, reason: "no_body" };
    let html = "";
    while (html.length < 30000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});
    const date = extractDateFromHtml(html);
    return { date, reason: date ? "meta_tag" : "no_date_in_html" };
  } catch (e) {
    return { date: null, reason: e.name === "AbortError" ? "timeout" : e.message.slice(0, 40) };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Source Date Recovery`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}  Concurrency: ${CONC}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("  Finding candidates…");
  const candidates = await findCandidates();

  const byReason = {};
  for (const c of candidates) byReason[c._fix_reason] = (byReason[c._fix_reason]||0)+1;
  console.log(`  Candidates: ${candidates.length}`);
  Object.entries(byReason).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>
    console.log(`    ${r.padEnd(30)} ${n}`)
  );

  if (!candidates.length) { console.log("\n  Nothing to fix."); return; }

  // ── Step 1: batch-fix arXiv sources ──────────────────────────────────────────
  const arxivCandidates = candidates.filter(c => ARXIV_ID_RE.test(c.url || ""));
  const nonArxiv        = candidates.filter(c => !ARXIV_ID_RE.test(c.url || ""));

  let fixed = 0, failed = 0;

  if (arxivCandidates.length > 0) {
    console.log(`\n  arXiv sources: ${arxivCandidates.length} → fetching real dates from arXiv API…`);
    const idMap = {}; // arxivId → source
    for (const c of arxivCandidates) {
      const m = ARXIV_ID_RE.exec(c.url);
      if (m) idMap[m[1]] = c;
    }
    const dates = await fetchArxivDates(Object.keys(idMap));

    for (const [arxivId, date] of Object.entries(dates)) {
      const c = idMap[arxivId];
      if (!c) continue;
      console.log(`    ${c._fix_reason.padEnd(28)} ${c.date_published?.slice(0,10)||"null"} → ${date}  ${c.title?.slice(0,45)}`);
      if (!DRY_RUN) {
        await sb.from("sources").update({
          date_published:  date,
          date_confidence: "exact",
        }).eq("id", c.id);
      }
      fixed++;
    }
    // Sources where arXiv API returned nothing
    const missing = arxivCandidates.filter(c => {
      const m = ARXIV_ID_RE.exec(c.url);
      return m && !dates[m[1]];
    });
    if (missing.length) {
      console.log(`    ${missing.length} arXiv sources not found in API — marking none`);
      if (!DRY_RUN) {
        for (const c of missing) {
          await sb.from("sources").update({ date_confidence: "none", date_published: null }).eq("id", c.id);
        }
      }
      failed += missing.length;
    }
  }

  // ── Step 2: HTML meta scrape for non-arXiv ────────────────────────────────────
  if (nonArxiv.length > 0) {
    console.log(`\n  Non-arXiv sources: ${nonArxiv.length} → scraping page dates…`);
    let done = 0;

    for (let i = 0; i < nonArxiv.length; i += CONC) {
      const chunk = nonArxiv.slice(i, i + CONC);
      const results = await Promise.all(chunk.map(c => fetchPageDate(c.url || "")));

      for (let j = 0; j < chunk.length; j++) {
        const c   = chunk[j];
        const res = results[j];
        done++;
        process.stdout.write(`    ${done}/${nonArxiv.length}  `);

        if (res.date) {
          console.log(`${c._fix_reason.padEnd(22)} ${c.date_published?.slice(0,10)||"null"} → ${res.date}  ${c.title?.slice(0,40)}`);
          if (!DRY_RUN) {
            await sb.from("sources").update({
              date_published:  res.date,
              date_confidence: "exact",
            }).eq("id", c.id);
          }
          fixed++;
        } else {
          console.log(`[FAIL:${res.reason.slice(0,20)}] ${c.date_published?.slice(0,10)||"null"}  ${c.title?.slice(0,45)}`);
          if (!DRY_RUN) {
            await sb.from("sources").update({ date_confidence: "none", date_published: null }).eq("id", c.id);
          }
          failed++;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Fixed: ${fixed}  Failed/nulled: ${failed}  ${DRY_RUN ? "(dry run)" : ""}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
