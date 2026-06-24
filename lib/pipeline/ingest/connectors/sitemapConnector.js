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

    for (const child of children.slice(0, 6)) { // cap at 6 child sitemaps
      try {
        const childXml = await fetchXml(child.loc);
        urlEntries.push(...parseUrlset(childXml));
        await sleep(800);
      } catch {}
    }
  } else {
    urlEntries = parseUrlset(xml);
  }

  // Step 2: filter by date range.
  // For targets with urlDateExtract: true (e.g. DFIR Report), the date is embedded
  // in the URL path (/YYYY/MM/DD/) rather than reliably in lastmod.
  const inWindow = urlEntries.filter(e => {
    const date = (target.urlDateExtract ? dateFromUrl(e.loc) : null) || e.lastmod;
    if (!date) return false;
    return date >= dateFrom && date <= dateTo;
  }).map(e => ({
    ...e,
    // Carry the resolved date forward so we can use it as date_published
    resolved_date: (target.urlDateExtract ? dateFromUrl(e.loc) : null) || e.lastmod,
  }));

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

      sources.push(normalizeSource({
        title:          (title || entry.loc.split("/").filter(Boolean).pop() || "Untitled").slice(0, 300),
        url:            entry.loc,
        publisher:      target.publisher,
        date_published: entry.resolved_date || entry.lastmod,
        source_type:    target.source_type,
        trust_tier:     target.trust_tier,
        full_text:      text.slice(0, 15000),
        summary:        text.slice(0, 400),
        collection_metadata: {
          connector_name:   `sitemap:${target.name}`,
          retrieval_method: "sitemap_crawl",
          trust_tier:       target.trust_tier,
          sitemap_lastmod:  entry.lastmod,
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
