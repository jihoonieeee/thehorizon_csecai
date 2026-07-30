#!/usr/bin/env node
/**
 * settleEstimatedDates.js — Multi-signal date settlement for sources with
 * date_confidence != "exact" and validation_status = "pass".
 *
 * Resolution pipeline (per source, in order):
 *   1. URL-path date   — /YYYY/MM/DD/ in URL path (authoritative for blogs/CMS)
 *   2. arXiv API       — for arxiv.org URLs (most reliable source)
 *   3. Page meta fetch — og:article:published_time, JSON-LD datePublished, <time>
 *   4. Gemini LLM      — reads full_text and extracts an explicit publication date
 *
 * The first signal that yields a date wins. The script updates date_published,
 * date_published_actual, date_confidence="exact", needs_review=false for each
 * resolved source. Unresolvable sources are left unchanged and reported.
 *
 * Usage:
 *   node scripts/settleEstimatedDates.js            # dry-run
 *   node scripts/settleEstimatedDates.js --execute  # write to DB
 *   node scripts/settleEstimatedDates.js --execute --skip-llm    # skip Gemini
 *   node scripts/settleEstimatedDates.js --execute --llm-only    # only LLM-unresolved
 *   node scripts/settleEstimatedDates.js --execute --limit 30
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { routedLLM } from "../lib/llm/llmRouter.js";

const args     = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const EXECUTE  = Boolean(args["execute"]);
const SKIP_LLM = Boolean(args["skip-llm"]);
const LLM_ONLY = Boolean(args["llm-only"]);  // only sources that need LLM (skip URL/fetch resolved)
const LIMIT    = parseInt(args["limit"] || "9999", 10);
const CONC     = parseInt(args["concurrency"] || "5", 10);

// Force Gemini for LLM calls
process.env.LLM_PROVIDER_ORDER = "gemini";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Signal 1: URL-path date ────────────────────────────────────────────────────
const TEXT_MON = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
function urlPathDate(url) {
  if (!url) return null;
  let path;
  try { path = new URL(url).pathname; } catch { path = url; }
  // Numeric: /2026/07/22/
  const ymd = path.match(/\/(20\d\d)\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$|-)/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  // Text month: /2026/jul/22/ (simonwillison.net style)
  const tmd = path.match(/\/(20\d\d)\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})(?:\/|$|-)/i);
  if (tmd) { const mon = TEXT_MON[tmd[2].toLowerCase()]; return mon ? `${tmd[1]}-${mon}-${tmd[3].padStart(2,"0")}` : null; }
  return null;
}

// ── Signal 2.5: GitHub API ─────────────────────────────────────────────────────
const GITHUB_REPO_RE = /github\.com\/([^/]+\/[^/]+?)(?:\/|$)/i;
async function fetchGithubDate(url) {
  const m = GITHUB_REPO_RE.exec(url || "");
  if (!m) return null;
  // Strip /blob/... or /tree/... suffixes to get the base repo path
  const repo = m[1].replace(/\.(git|md|txt)$/i, "");
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "HorizonScanner/2.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer pushed_at (last activity) if it matches our estimate; otherwise use created_at
    const created = data.created_at?.slice(0, 10) || null;
    return created;
  } catch { return null; }
}

// ── Signal 2: arXiv API ────────────────────────────────────────────────────────
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf|html?)\/(\d{4}\.\d{4,5})/i;

async function fetchArxivDate(url) {
  const m = ARXIV_RE.exec(url || "");
  if (!m) return null;
  const arxivId = m[1];
  try {
    const res = await fetch(
      `https://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`,
      { headers: { "User-Agent": "HorizonScanner/2.0 date-settle" }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const pub = xml.match(/<published>([\d-T:Z+]+)<\/published>/);
    return pub ? pub[1].slice(0, 10) : null;
  } catch { return null; }
}

// ── Signal 3: Page meta fetch ──────────────────────────────────────────────────
const DATE_RES = [
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /"published"\s*:\s*"(202[0-9][^"]+)"/,
  /<meta[^>]+name=["']DC\.date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  /itemprop=["']datePublished["'][^>]*datetime=["']([^"']+)["']/i,
];
const TODAY_ISO = new Date().toISOString().slice(0, 10);

// Extract local calendar date from a raw datetime string.
// If the string carries an explicit timezone offset (e.g. -05:00), the local
// date before conversion is authoritative for editorial publish dates; converting
// to UTC first can shift the calendar day by 1 (e.g. 10 PM CDT → next day UTC).
function extractLocalDate(raw) {
  if (!raw) return null;
  // Already a plain date
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Timestamp with explicit tz offset — take the local date portion as-is
  const withTz = raw.match(/^(\d{4}-\d{2}-\d{2})T[\d:.]+[+-]\d{2}:?\d{2}$/);
  if (withTz) return withTz[1];
  // UTC or no-tz — convert and take UTC date
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseHtmlDate(html) {
  for (const re of DATE_RES) {
    const m = re.exec(html);
    if (m?.[1]) {
      const iso = extractLocalDate(m[1]);
      if (iso && iso >= "2010-01-01" && iso <= TODAY_ISO) return iso;
    }
  }
  // Fallback: first spelled month date in visible text
  const MONTH_MAP = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
  const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
  const tm = new RegExp(`(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(202\\d)`).exec(html);
  if (tm) {
    const mon = MONTH_MAP[tm[1].slice(0, 3).toLowerCase()];
    if (mon) {
      const iso = `${tm[3]}-${mon}-${tm[2].padStart(2, "0")}`;
      if (iso <= TODAY_ISO) return iso;
    }
  }
  return null;
}

async function fetchPageDate(url) {
  // Skip digest fan-out items (they share the parent URL)
  if (!url || url.includes("github.com")) return null; // GitHub pages are SPAs, skip
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0)", Accept: "text/html" },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseHtmlDate(html);
  } catch { return null; }
}

// ── Signal 4: Gemini LLM date extraction ──────────────────────────────────────
const LLM_SYSTEM = `You are a date extraction assistant. Given a source article's metadata and text excerpt, extract the publication date.

Return ONLY a JSON object: {"date": "YYYY-MM-DD", "confidence": "high"|"medium"|"low", "source": "where you found it"}
Return {"date": null} if you cannot determine the date with at least medium confidence.
Do not guess. Only return a date you can see explicitly stated.`;

async function llmExtractDate(source) {
  const excerpt = (source.full_text || source.summary || "").slice(0, 3000);
  if (!excerpt || excerpt.length < 100) return null;

  const userPrompt = `Extract the publication date of this article.

Title: ${source.title || "(no title)"}
Publisher: ${source.publisher || "Unknown"}
URL: ${source.url || ""}
Stored estimated date: ${(source.date_published || "").slice(0, 10)}

Text excerpt:
${excerpt}`;

  try {
    const { result } = await routedLLM(LLM_SYSTEM, userPrompt, {
      task: "date_extraction",
      requires_json: true,
      logLabel: `date-${(source.id || "").slice(0, 12)}`,
    });
    if (!result?.date) return null;
    // Validate format
    const d = new Date(result.date);
    if (isNaN(d.getTime())) return null;
    const iso = d.toISOString().slice(0, 10);
    if (iso < "2010-01-01" || iso > TODAY_ISO) return null;
    return { date: iso, confidence: result.confidence || "medium", source: result.source || "llm" };
  } catch (e) {
    return null;
  }
}

// ── Load candidates ────────────────────────────────────────────────────────────
async function loadCandidates() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id,title,url,publisher,date_published,date_published_actual,date_confidence,needs_review,full_text,summary")
      .eq("validation_status", "pass")
      .neq("date_confidence", "exact")
      .order("date_published", { ascending: false })
      .range(from, from + 999);
    if (error) { console.error("DB load error:", error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows.slice(0, LIMIT);
}

// ── Resolve one source ─────────────────────────────────────────────────────────
async function resolveSource(src) {
  const isDigest = /-.+?-i\d+$/.test(src.id);
  const baseUrl = src.url; // digest items share parent URL

  // Signal 1: URL-path date (instant, no network)
  if (!LLM_ONLY) {
    const urlDate = urlPathDate(baseUrl);
    if (urlDate) return { date: urlDate, method: "url_path" };
  }

  // Signal 2: arXiv API
  if (!LLM_ONLY && ARXIV_RE.test(baseUrl || "")) {
    const arxivDate = await fetchArxivDate(baseUrl);
    if (arxivDate) return { date: arxivDate, method: "arxiv_api" };
  }

  // Signal 2.5: GitHub API (for github.com repos/blobs)
  if (!LLM_ONLY && /github\.com/i.test(baseUrl || "")) {
    const ghDate = await fetchGithubDate(baseUrl);
    if (ghDate) return { date: ghDate, method: "github_api" };
  }

  // Signal 3: page meta fetch (skip GitHub — already handled above)
  if (!LLM_ONLY) {
    const pageDate = await fetchPageDate(baseUrl);
    if (pageDate) return { date: pageDate, method: "page_fetch" };
  }

  // Signal 4: Gemini LLM
  if (!SKIP_LLM) {
    const llmResult = await llmExtractDate(src);
    if (llmResult?.date) return { date: llmResult.date, method: `llm(${llmResult.confidence})` };
  }

  return null;
}

// ── Apply DB update ────────────────────────────────────────────────────────────
async function applyUpdate(src, resolved) {
  const iso = `${resolved.date}T12:00:00+00:00`;
  const { error } = await sb.from("sources").update({
    date_published:        iso,
    date_published_actual: iso,
    date_confidence:       "exact",
    needs_review:          false,
  }).eq("id", src.id);
  return !error;
}

// ── Concurrency pool ───────────────────────────────────────────────────────────
async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  Settle Estimated Dates${EXECUTE ? "  [EXECUTE]" : "  [DRY-RUN]"}${SKIP_LLM ? "  [no-LLM]" : ""}${LLM_ONLY ? "  [LLM-only]" : ""}`);
  console.log(`  provider: gemini  concurrency: ${CONC}  limit: ${LIMIT}`);
  console.log(`${"═".repeat(68)}\n`);

  const candidates = await loadCandidates();
  console.log(`  Loaded ${candidates.length} sources (pass, date_confidence != exact)\n`);

  const resolved   = [];
  const unresolved = [];
  let done = 0;

  await runPool(candidates, async (src) => {
    const result = await resolveSource(src);
    done++;
    if (result) {
      const changed = result.date !== (src.date_published || "").slice(0, 10);
      resolved.push({ src, result, changed });
      process.stdout.write(`\r  Resolved ${resolved.length} / processed ${done}`);
    } else {
      unresolved.push(src);
      process.stdout.write(`\r  Resolved ${resolved.length} / processed ${done}`);
    }
  }, CONC);

  console.log(`\n\n  ── RESULTS ──`);
  console.log(`  Resolved:   ${resolved.length}  (${resolved.filter(r => r.changed).length} date shifts)`);
  console.log(`  Unresolved: ${unresolved.length}\n`);

  // Show resolved breakdown by method
  const byMethod = {};
  for (const r of resolved) byMethod[r.result.method] = (byMethod[r.result.method] || 0) + 1;
  console.log("  By method:", byMethod);

  // Show date shifts
  const shifts = resolved.filter(r => r.changed);
  if (shifts.length) {
    console.log(`\n  Date shifts (stored → settled):`);
    for (const { src, result } of shifts) {
      console.log(`    ${(src.date_published || "?").slice(0,10)} → ${result.date}  [${result.method}]  ${(src.publisher||"?").slice(0,22).padEnd(22)} ${(src.title||"").slice(0,40)}`);
    }
  }

  // Show unresolved
  if (unresolved.length) {
    console.log(`\n  Unresolved sources (still needs_review):`);
    for (const src of unresolved.slice(0, 20)) {
      console.log(`    ${(src.date_published||"?").slice(0,10)} [${src.date_confidence}] ${(src.publisher||"?").slice(0,22).padEnd(22)} ${(src.title||"").slice(0,45)}`);
    }
    if (unresolved.length > 20) console.log(`    … and ${unresolved.length - 20} more`);
  }

  if (!EXECUTE) {
    console.log(`\n  [dry-run] No changes written. Re-run with --execute to apply.\n`);
    return;
  }

  // Apply updates
  let updated = 0, failed = 0;
  for (const { src, result } of resolved) {
    const ok = await applyUpdate(src, result);
    if (ok) updated++; else failed++;
  }
  console.log(`\n  Updated ${updated} sources to date_confidence="exact".`);
  if (failed) console.log(`  ${failed} update errors.`);
  console.log("");
}

main().catch(e => { console.error("FATAL:", e.message || e); process.exit(1); });
