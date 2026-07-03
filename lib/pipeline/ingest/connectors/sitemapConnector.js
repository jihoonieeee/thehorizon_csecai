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
  // WithSecure (labs.withsecure.com/sitemap.xml returns HTML — bot-blocked)
  // Lumen Black Lotus Labs (blog.lumen.com/sitemap.xml returns HTML — bot-blocked)
  // These are omitted until correct sitemap URLs or an unblocked fetch path is found.
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

// For sites like DFIR Report where lastmod = original publish date (e.g. 2020-04-04)
// even for new articles, extract the date from the URL path (/YYYY/MM/DD/title/).
function dateFromUrl(url) {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Sitemap <lastmod> is the last time the PAGE was regenerated, not when the
// article was published — a site-wide rebuild restamps every old post with a
// recent date. Since we already fetch the article HTML, parse the real publish
// date from its structured metadata (og/article:published_time, JSON-LD
// datePublished, <time datetime>). Returns YYYY-MM-DD or null.
const DATE_META_SELECTORS = [
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /"published"\s*:\s*"(202[0-9][^"]+)"/,
  /<meta[^>]+name=["']DC\.date["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
];
function dateFromHtmlMeta(html) {
  for (const re of DATE_META_SELECTORS) {
    const m = re.exec(html);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!Number.isNaN(d.getTime())) {
        const iso = d.toISOString().slice(0, 10);
        if (iso >= "2010-01-01" && iso <= new Date(Date.now() + 86400000).toISOString().slice(0, 10)) return iso;
      }
    }
  }
  return null;
}

// Last-resort date signal for sites that expose NO structured date at all
// (no <lastmod>, no URL-path date, no meta tag — e.g. Webflow sites like
// HiddenLayer that print "January 22, 2026" only as visible text). Grab the
// first spelled-out "Month DD, YYYY" — the article's own byline date; later
// occurrences are related-post dates. Heuristic → caller marks it "estimated".
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_NUM   = Object.fromEntries(MONTH_NAMES.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const MONTH_TEXT_RE = new RegExp(`\\b(${MONTH_NAMES.join("|")})\\s+(\\d{1,2}),?\\s+(20\\d\\d)\\b`);
function dateFromHtmlText(html) {
  const m = MONTH_TEXT_RE.exec(html || "");
  if (!m) return null;
  const iso = `${m[3]}-${MONTH_NUM[m[1]]}-${m[2].padStart(2, "0")}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (iso < "2010-01-01" || iso > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) return null;
  return iso;
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
export async function fetchSitemapSources(target, window) {
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
      const text  = htmlToText(html);

      if (!text || text.length < 200) {
        await sleep(500);
        continue;
      }

      // Resolve the authoritative publish date: URL-path date (most reliable) →
      // article HTML metadata → visible-text byline date → sitemap <lastmod>
      // (last resort). Only URL/meta dates are trustworthy enough to mark
      // "exact"; text-scan and lastmod dates are estimates and must not be
      // counted in period reports.
      const urlDate  = dateFromUrl(entry.loc);
      const metaDate = dateFromHtmlMeta(html);
      const textDate = (urlDate || metaDate) ? null : dateFromHtmlText(html);
      const realDate = urlDate || metaDate || textDate || entry.lastmod || null;
      const dateConf = (urlDate || metaDate) ? "exact" : "estimated";
      const dateSrc  = urlDate ? "url_path" : metaDate ? "html_meta" : textDate ? "html_text" : "sitemap_lastmod";

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
