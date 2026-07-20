/**
 * Sitemap-based historical backfill connector for operational security blogs.
 *
 * Parses an XML sitemap (or sitemap index), filters URLs by <lastmod> date,
 * fetches each article's HTML, extracts plain text, and returns normalised
 * source objects in the same shape as the RSS connector.
 *
 * Used for sites with no date-range API but with well-maintained sitemaps:
 * The DFIR Report, Red Canary, Huntress, Volexity, WithSecure, etc.
 *
 * Rate limiting: 2s between article fetches to avoid hitting rate limits.
 * Hard cap: 60 articles per site per call.
 */

import { normalizeSource } from "../normalizeSource.js";
import { callLLM } from "../../../llm/callLLM.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Operational blog sitemap targets ─────────────────────────────────────────
// Each entry maps to one operational feed. sitemapUrl may be a sitemap index
// (containing child sitemap URLs) or a direct URL sitemap.

export const OPERATIONAL_SITEMAPS = [
  {
    name:         "The DFIR Report",
    publisher:    "The DFIR Report",
    sitemapUrl:   "https://thedfirreport.com/post-sitemap.xml",
    source_type:  "incident",
    trust_tier:   "high",
    maxArticles:  40,
    // DFIR sitemap lastmod = original publish date, which is embedded in the URL
    // path (/YYYY/MM/DD/title/). Set urlDateExtract: true to parse date from URL.
    urlDateExtract: true,
  },
  {
    name:         "Red Canary Blog",
    publisher:    "Red Canary",
    sitemapUrl:   "https://redcanary.com/sitemap.xml",
    source_type:  "incident",
    trust_tier:   "high",
    maxArticles:  30,
  },
  {
    name:         "Huntress Blog",
    publisher:    "Huntress",
    sitemapUrl:   "https://www.huntress.com/sitemap.xml",
    source_type:  "incident",
    trust_tier:   "high",
    maxArticles:  30,
  },
  {
    name:         "Volexity Threat Research",
    publisher:    "Volexity",
    // Use the direct post sitemap — the index requires a browser UA that bypasses CDN
    sitemapUrl:   "https://www.volexity.com/post-sitemap.xml",
    source_type:  "threat_intelligence",
    trust_tier:   "high",
    maxArticles:  30,
  },
  {
    name:         "Google Threat Intelligence Group / Mandiant",
    publisher:    "Google Threat Intelligence Group",
    // Google Cloud blog has no per-topic RSS; its only machine-readable index is
    // this date-chunked sitemap (1000+ children like …/cloudblog/en/DATE/DATE).
    // childDateRange windowing fetches only children overlapping the run window;
    // pathInclude keeps just the threat-intelligence posts (GTIG/Mandiant:
    // PROMPTFLUX, TeamPCP, AI-built zero-days). Child entries carry <lastmod>.
    sitemapUrl:   "https://cloud.google.com/transform/sitemapsummary/cloudblog",
    source_type:  "threat_intelligence",
    trust_tier:   "high",
    maxArticles:  25,
    pathInclude:  /\/blog\/topics\/threat-intelligence\//,
  },
  {
    name:         "HiddenLayer Research",
    publisher:    "HiddenLayer",
    // Flat urlset with NO <lastmod> and no meta date on articles — dates live
    // only as visible byline text, recovered by dateFromHtmlText post-fetch.
    // pathInclude limits the 340-URL sitemap to /research/ articles.
    sitemapUrl:   "https://hiddenlayer.com/sitemap.xml",
    source_type:  "research_finding",
    trust_tier:   "high",
    maxArticles:  40,
    pathInclude:  /\/research\//,
  },
  {
    name:        "Unit 42 Threat Research",
    publisher:   "Palo Alto Networks Unit 42",
    // Sitemap index: child sitemaps post-sitemap.xml/2/3 + threat-bulletin-sitemap.xml
    // are auto-selected by the /post|threat/ child filter; page/category/tag sitemaps
    // are excluded. lastmod in Unit 42's post sitemaps = original publish date.
    sitemapUrl:  "https://unit42.paloaltonetworks.com/sitemap_index.xml",
    source_type: "threat_intelligence",
    trust_tier:  "high",
    maxArticles: 80,
  },

  // WithSecure (labs.withsecure.com/sitemap.xml returns HTML — bot-blocked)
  // Lumen Black Lotus Labs (blog.lumen.com/sitemap.xml returns HTML — bot-blocked)
  // These are omitted until correct sitemap URLs or an unblocked fetch path is found.

  // MITRE ATLAS — versioned YAML bundle, not a sitemap. New case studies arrive
  // in monthly releases (ATLAS-YYYY.MM.yaml). Run scripts/ingestMitreAtlas.js
  // manually after each release; it is idempotent (skips already-ingested IDs).
  // Not suitable for daily RSS/sitemap polling.

  // Mindgard — sitemap lists only section index pages, no individual post URLs;
  // no RSS feed available. Cannot be polled automatically.
];

// ── XML parsing helpers (no external deps) ───────────────────────────────────

function extractTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  }
  return results;
}

function parseUrlset(xml) {
  // Extract <url> blocks
  const urlBlockRe = /<url>([\s\S]*?)<\/url>/g;
  const entries = [];
  let m;
  while ((m = urlBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const loc     = (block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const lastmod = (block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/) || [])[1]?.trim();
    if (loc) entries.push({ loc, lastmod: lastmod?.slice(0, 10) || null });
  }
  return entries;
}

function parseSitemapIndex(xml) {
  const sitemapRe = /<sitemap>([\s\S]*?)<\/sitemap>/g;
  const entries = [];
  let m;
  while ((m = sitemapRe.exec(xml)) !== null) {
    const block   = m[1];
    const loc     = (block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const lastmod = (block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/) || [])[1]?.trim();
    if (loc) entries.push({ loc, lastmod: lastmod?.slice(0, 10) || null });
  }
  return entries;
}

// ── HTML → plain text (minimal, no DOM parser needed) ────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : null;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

// Browser-like UA avoids CDN/WAF blocks that reject obvious bots.
const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchXml(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": FETCH_UA, "Accept": "application/xml,text/xml,*/*" },
    signal:  AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  // Guard: some servers return HTML error pages with 200 status
  const text = await resp.text();
  if (text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html")) {
    throw new Error(`Got HTML instead of XML from ${url} — likely bot-blocked`);
  }
  return text;
}

async function fetchArticle(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": FETCH_UA, "Accept": "text/html,*/*" },
    signal:  AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

/**
 * Jina AI Reader fallback — free JS-aware extraction, no API key.
 * Used when fetchArticle returns thin/bot-blocked content.
 */
async function fetchArticleViaJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain", "X-Return-Format": "text" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const raw = await res.text();
  return raw.replace(/^(Title:|URL Source:|Published Time:)[^\n]*\n/gm, "").trim() || null;
}

// ── Date extraction helpers ───────────────────────────────────────────────────

const TODAY_PLUS_ONE = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

// Parse an ISO/RFC date string to YYYY-MM-DD in UTC. Intentionally strict:
// only accepts strings that are unambiguously machine-readable (ISO date-only,
// ISO datetime with or without timezone, RFC 2822 with timezone). Locale-style
// strings like "January 15, 2026" are NOT accepted here — they must go through
// dateFromHtmlText which builds the ISO string from components (no tz shift).
//
// Handles:
//   "2026-01-15"                → UTC date-only (ECMAScript spec)
//   "2026-01-15T08:00:00Z"      → explicit UTC
//   "2026-01-15T08:00:00+08:00" → explicit offset
//   "2026-01-15T00:00:00"       → tz-naive datetime → treated as UTC (append Z)
function validIso(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  // Only proceed for strings starting with YYYY-MM-DD (ISO format)
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  // Timezone-naive datetime → treat as UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  return iso >= "2010-01-01" && iso <= TODAY_PLUS_ONE() ? iso : null;
}

// For sites like DFIR Report where the publish date is embedded in the URL path.
function dateFromUrl(url) {
  // Full /YYYY/MM/DD/ — exact
  const full = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (full) return { date: `${full[1]}-${full[2]}-${full[3]}`, confidence: "exact" };
  // Partial /YYYY/MM/ without day — approximate
  const partial = url.match(/\/(\d{4})\/(\d{2})\//);
  if (partial && +partial[2] <= 12) return { date: `${partial[1]}-${partial[2]}-01`, confidence: "estimated" };
  return null;
}

// Tier 1 — machine-readable publish-date metadata: explicit publish timestamps
// declared by the publisher. These are authoritative and map to "exact".
const META_EXACT = [
  // Open Graph / article
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  // JSON-LD — datePublished is the canonical publish date
  /"datePublished"\s*:\s*"(20\d\d[^"]{0,30})"/,
  // JSON-LD — dateCreated is equivalent for first-publish
  /"dateCreated"\s*:\s*"(20\d\d[^"]{0,30})"/,
  // Schema.org "published" shorthand
  /"published"\s*:\s*"(20\d\d[^"]{0,30})"/,
  // Microdata — <meta itemprop="datePublished" content="...">
  /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']datePublished["']/i,
  // <time> element with itemprop or datetime (common in blog themes)
  /<time[^>]+itemprop=["']datePublished["'][^>]*datetime=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["'][^>]*itemprop=["']datePublished["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  // Dublin Core
  /<meta[^>]+name=["']DC\.date(?:\.created)?["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']DC\.date(?:\.created)?["']/i,
  // Common CMS meta name variants
  /<meta[^>]+name=["'](?:pubdate|publish[_-]?date|published[_-]?date|article\.published|sailthru\.date|cXenseParse:recs:publishtime)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:pubdate|publish[_-]?date|published[_-]?date|article\.published|sailthru\.date|cXenseParse:recs:publishtime)["']/i,
];

// Tier 2 — less authoritative meta: "date" and "created" without a publish
// qualifier, modification timestamps used as fallback. Mark "estimated".
const META_ESTIMATED = [
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']date["']/i,
  // dateModified — last resort; modification ≈ publish for many publishers
  /"dateModified"\s*:\s*"(20\d\d[^"]{0,30})"/,
];

function metaContentToIso(raw) {
  if (!raw) return null;
  // Try direct parse first (handles ISO and RFC dates)
  const iso = validIso(raw);
  if (iso) return iso;
  // Some meta tags (e.g. sailthru.date) carry human-readable dates — parse via text patterns
  return dateFromHtmlText(raw) ?? null;
}

function dateFromHtmlMeta(html) {
  for (const re of META_EXACT) {
    const iso = metaContentToIso((re.exec(html) || [])[1]);
    if (iso) return { date: iso, confidence: "exact" };
  }
  for (const re of META_ESTIMATED) {
    const iso = metaContentToIso((re.exec(html) || [])[1]);
    if (iso) return { date: iso, confidence: "estimated" };
  }
  return null;
}

// ── Text-scan date extraction (last structural resort) ────────────────────────
// Tries common date formats in the first 2 000 characters of rendered HTML.
// Priority: label-prefixed ISO > label-prefixed spelled-out > bare spelled-out.
// Returns YYYY-MM-DD or null; caller marks this "estimated".

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_ABBR  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_NUM   = Object.fromEntries([...MONTH_NAMES, ...MONTH_ABBR].map((m, i) => [m, String((i % 12) + 1).padStart(2, "0")]));
const MO_LONG = MONTH_NAMES.join("|");
const MO_ABBR = MONTH_ABBR.join("|");
const MO_ALL  = `${MO_LONG}|${MO_ABBR}`;
const p2 = (n) => String(n).padStart(2, "0");

// Construct YYYY-MM-DD from components, bypassing new Date() to avoid timezone shifts.
// monthRaw can be a full name ("January"), abbreviation ("Jan"), or two-digit string ("01").
function buildIso(year, monthRaw, day) {
  const mo = MONTH_NUM[monthRaw] ?? (String(monthRaw).padStart(2, "0"));
  if (!mo || +mo < 1 || +mo > 12) return null;
  const iso = `${year}-${mo}-${p2(day)}`;
  return validIso(iso);
}

// Each entry: { re, fn } where fn(match) → YYYY-MM-DD or null.
// Patterns tried in priority order against the first 2 000 chars of HTML.
const TEXT_DATE_PATTERNS = [
  // Labelled ISO: "Published: 2026-01-15", "Date 2026-01-15"
  { re: /(?:published?|posted?|date|authored?)\s*:?\s*(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/i,
    fn: (m) => buildIso(m[1], m[2], m[3]) },
  // Bare ISO anywhere: "2026-01-15"
  { re: /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/,
    fn: (m) => buildIso(m[1], m[2], m[3]) },
  // Labelled Month-D-Y: "Published January 15, 2026" / "Posted on Jan 15, 2026"
  { re: new RegExp(`(?:published?|posted?|date|authored?)\\s+(?:on\\s+)?(${MO_ALL})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})`, "i"),
    fn: (m) => buildIso(m[3], m[1], m[2]) },
  // Labelled D-Month-Y: "Published 15 January 2026"
  { re: new RegExp(`(?:published?|posted?|date|authored?)\\s+(\\d{1,2})\\s+(${MO_ALL})\\.?\\s+(20\\d{2})`, "i"),
    fn: (m) => buildIso(m[3], m[2], m[1]) },
  // Bare Month-D-Y: "January 15, 2026" / "Jan 15, 2026"
  { re: new RegExp(`\\b(${MO_ALL})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "i"),
    fn: (m) => buildIso(m[3], m[1], m[2]) },
  // Bare D-Month-Y: "15 January 2026" / "15 Jan 2026"
  { re: new RegExp(`\\b(\\d{1,2})\\s+(${MO_ALL})\\.?\\s+(20\\d{2})\\b`, "i"),
    fn: (m) => buildIso(m[3], m[2], m[1]) },
];

function dateFromHtmlText(html) {
  // Only scan the first 2 000 chars — publish dates appear in the article header,
  // not in the body where related-post or referenced-event dates appear.
  const head = (html || "").slice(0, 2000);
  for (const { re, fn } of TEXT_DATE_PATTERNS) {
    const m = re.exec(head);
    if (m) {
      const iso = fn(m);
      if (iso) return iso;
    }
  }
  return null;
}

// ── LLM date extraction — absolute last resort ────────────────────────────────
// Called only when every structural signal (URL, meta, text scan, lastmod) fails.
// Uses the article's first 600 characters — enough for a byline — with a cheap
// gpt-4o-mini / Gemini Flash call (default callLLM rotation, no Anthropic needed).
async function dateFromLLM(title, textHead) {
  if (!textHead || textHead.length < 50) return null;
  try {
    const system = "You extract publish dates from article text. Reply ONLY with a date in YYYY-MM-DD format, or the word \"unknown\" if no date is visible. No explanation.";
    const user   = `Article title: ${(title || "").slice(0, 120)}\n\nOpening text:\n${textHead.slice(0, 600)}`;
    const raw = await callLLM(system, user, { max_tokens: 20, logLabel: "date-extract" });
    const text = (typeof raw === "string" ? raw : "").trim();
    if (/^unknown$/i.test(text)) return null;
    return validIso(text.match(/20\d{2}-\d{2}-\d{2}/)?.[0]);
  } catch {
    return null;
  }
}

// A Google-style blog sitemap INDEX lists date-chunked child sitemaps whose loc
// carries the range they cover (…/cloudblog/en/2026-06-16/2026-06-30). Extract
// that range so we fetch only children overlapping the requested window — the
// first N children of a chronological index are the OLDEST, which is useless.
function childDateRange(loc) {
  const m = (loc || "").match(/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})(?:\/?|$)/);
  return m ? { start: m[1], end: m[2] } : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch historical articles from a sitemap-enabled operational blog.
 *
 * @param {object} target     Entry from OPERATIONAL_SITEMAPS
 * @param {object} window     { start_utc, end_utc }
 * @returns {Promise<object[]>}  Normalised source objects
 */
export async function fetchSitemapSources(target, window, options = {}) {
  const dateFrom = window.start_utc?.slice(0, 10);
  const dateTo   = window.end_utc?.slice(0, 10);
  if (!dateFrom || !dateTo) throw new Error("window missing start_utc/end_utc");

  const maxArticles = target.maxArticles ?? 40;
  const sources = [];

  // Step 1: fetch and parse the sitemap
  let xml;
  try { xml = await fetchXml(target.sitemapUrl); }
  catch (e) {
    console.warn(`  [sitemap] ${target.name}: sitemap fetch failed — ${e.message}`);
    return [];
  }

  // Detect sitemap index vs urlset
  const isIndex = /<sitemapindex/i.test(xml);

  let urlEntries = [];

  if (isIndex) {
    // Fetch child sitemaps (typically post-sitemap.xml, blog-sitemap.xml, etc.)
    const children = parseSitemapIndex(xml)
      .filter(s => /post|blog|article|research|threat|intel/i.test(s.loc));

    // Prefer children whose date range overlaps the window, newest first — a
    // large chronological index (e.g. Google Cloud blog: 1000+ children) would
    // otherwise waste the cap on 2014-era chunks. Children with no date range in
    // their loc keep the original first-N behaviour.
    const dated = [], undated = [];
    for (const c of children) {
      const r = childDateRange(c.loc);
      if (r) { if (r.end >= dateFrom && r.start <= dateTo) dated.push({ ...c, _end: r.end }); }
      else undated.push(c);
    }
    dated.sort((a, b) => b._end.localeCompare(a._end));
    const picked = (dated.length ? dated : undated).slice(0, 8);

    for (const child of picked) {
      try {
        const childXml = await fetchXml(child.loc);
        urlEntries.push(...parseUrlset(childXml));
        await sleep(800);
      } catch {}
    }
  } else {
    urlEntries = parseUrlset(xml);
  }

  // Optional path allow-list: keep only article URLs matching target.pathInclude
  // (e.g. only /blog/topics/threat-intelligence/ posts out of the whole Google
  // Cloud blog, or only /research/ articles out of HiddenLayer's full sitemap).
  if (target.pathInclude) urlEntries = urlEntries.filter(e => target.pathInclude.test(e.loc || ""));

  // Step 2: filter by date range.
  // For targets with urlDateExtract: true (e.g. DFIR Report), the date is embedded
  // in the URL path (/YYYY/MM/DD/) rather than reliably in lastmod. Entries with
  // NO pre-fetch date (sitemaps that omit <lastmod> AND have no URL date, e.g.
  // HiddenLayer) are kept as candidates and windowed AFTER fetch using the date
  // parsed from the article HTML — otherwise they'd all be silently dropped here.
  const candidates = [];
  for (const e of urlEntries) {
    const preDate = (target.urlDateExtract ? dateFromUrl(e.loc) : null) || e.lastmod || null;
    if (preDate) {
      if (preDate >= dateFrom && preDate <= dateTo) candidates.push({ ...e, resolved_date: preDate, dateless: false });
    } else {
      candidates.push({ ...e, resolved_date: null, dateless: true });
    }
  }
  // Dated in-window entries first, then the date-less ones (windowed post-fetch).
  candidates.sort((a, b) => Number(a.dateless) - Number(b.dateless));
  const inWindow = candidates;

  // Step 3: fetch article bodies (rate-limited, capped)
  const toFetch = inWindow.slice(0, maxArticles);
  let fetched = 0;

  for (const entry of toFetch) {
    try {
      const html  = await fetchArticle(entry.loc);
      const title = extractTitle(html);
      let text    = htmlToText(html);

      // Fallback: Jina Reader handles JS-rendered pages and Cloudflare-blocked sites
      // that return empty or near-empty HTML to a plain fetch.
      if (!text || text.length < 200) {
        const jinaText = await fetchArticleViaJina(entry.loc).catch(() => null);
        if (jinaText && jinaText.length >= 200) {
          text = jinaText;
        } else {
          await sleep(500);
          continue;
        }
      }

      // Resolve the authoritative publish date. Cascade by reliability:
      //   1. URL path /YYYY/MM/DD/ or /YYYY/MM/ — direct encoding in permalink
      //   2. Machine-readable HTML metadata (og:article:published_time, JSON-LD, microdata…)
      //   3. Visible-text date scan (byline patterns: "Jan 15, 2026", "15 January 2026"…)
      //   4. sitemap <lastmod> — last-resort structural fallback
      //   5. LLM (Haiku) — fires only when all structural signals fail
      // Levels 1–2 (exact signals) → date_confidence:"exact"
      // Levels 3–5 (heuristic/inferred) → date_confidence:"estimated"
      const urlResult  = dateFromUrl(entry.loc);
      const metaResult = urlResult?.confidence === "exact" ? null : dateFromHtmlMeta(html);
      const textDate   = (urlResult || metaResult) ? null : dateFromHtmlText(html);

      // lastmod as structural fallback (estimated)
      const lastmodDate = (!urlResult && !metaResult && !textDate && entry.lastmod) ? entry.lastmod : null;

      // LLM fallback — only when every structural signal is absent
      let llmDate = null;
      if (!urlResult && !metaResult && !textDate && !lastmodDate) {
        llmDate = await dateFromLLM(title, text);
      }

      const realDate = urlResult?.date || metaResult?.date || textDate || lastmodDate || llmDate || null;
      const dateConf = (urlResult?.confidence === "exact" || metaResult?.confidence === "exact") ? "exact" : "estimated";
      const dateSrc  = urlResult ? `url_path(${urlResult.confidence})`
        : metaResult ? `html_meta(${metaResult.confidence})`
        : textDate   ? "html_text"
        : lastmodDate ? "sitemap_lastmod"
        : llmDate    ? "llm_haiku"
        : "none";

      // Date-less candidates are windowed here, now that we know the real date.
      // (If no date could be resolved at all, keep it — normalizeSource nulls the
      // date and eligibilityFlags routes it to needs_review, not a period report.)
      if (entry.dateless && realDate && (realDate < dateFrom || realDate > dateTo)) {
        await sleep(300);
        continue;
      }

      sources.push(normalizeSource({
        title:          (title || entry.loc.split("/").filter(Boolean).pop() || "Untitled").slice(0, 300),
        url:            entry.loc,
        publisher:      target.publisher,
        date_published:  realDate,
        date_confidence: dateConf,
        source_type:    target.source_type,
        trust_tier:     target.trust_tier,
        full_text:      text.slice(0, 15000),
        summary:        text.slice(0, 400),
        collection_metadata: {
          connector_name:   `sitemap:${target.name}`,
          retrieval_method: "sitemap_crawl",
          trust_tier:       target.trust_tier,
          sitemap_lastmod:  entry.lastmod,
          date_source:      dateSrc,
        },
      }));

      fetched++;
      process.stdout.write(`  [sitemap] ${target.name}: ${fetched}/${toFetch.length}\r`);
      await sleep(2000); // respectful rate-limit
    } catch (e) {
      // non-fatal — skip this article
      await sleep(500);
    }
  }

  process.stdout.write("\n");
  return sources;
}

/**
 * Fetch from all OPERATIONAL_SITEMAPS targets within the date window.
 * Accepts opts.signal for AbortController compatibility with runConnector.
 */
export async function fetchAllOperationalSitemaps(window, opts = {}) {
  const targets = opts.targets || OPERATIONAL_SITEMAPS;
  const signal  = opts.signal;
  const all = [];

  for (const target of targets) {
    if (signal?.aborted) break;
    console.log(`  [sitemap] Fetching ${target.name} (${target.sitemapUrl})…`);
    try {
      const sources = await fetchSitemapSources(target, window);
      console.log(`  [sitemap] ${target.name}: ${sources.length} articles`);
      all.push(...sources);
    } catch (e) {
      console.warn(`  [sitemap] ${target.name}: ERROR — ${e.message}`);
    }
    await sleep(3000); // pause between sites
  }

  return all;
}

/**
 * Connector descriptor for use with runConnector / collectRawSources extraConnectors.
 * run({ window, signal }) → Promise<object[]>
 */
export const sitemapConnector = {
  name:             "Operational Sitemaps",
  key:              "sitemap",
  trust_tier:       "high",
  retrieval_method: "sitemap_crawl",
  timeout_ms:       900000,  // 15 minutes — crawls up to 6 sites with article fetches
  run: ({ window, signal }) => fetchAllOperationalSitemaps(window, { signal }),
};
