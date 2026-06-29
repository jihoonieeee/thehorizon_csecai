#!/usr/bin/env node
/**
 * backfillFromSitemaps.js — Backfill historical blog/intel posts from XML sitemaps.
 *
 * Fetches each publisher's sitemap, filters URLs by date, fetches article HTML,
 * and runs the full Layer 3 ingest pipeline (normalize → validate → DB upsert).
 * Already-ingested URLs are skipped via ID hash dedup.
 *
 * Usage:
 *   node scripts/backfillFromSitemaps.js [options]
 *
 * Options:
 *   --days N        How many days back to pull (default: 360 ≈ 2025 Q3 → now)
 *   --publisher X   Only this publisher name (case-insensitive substring match)
 *   --dry-run       Fetch + parse but don't write to DB
 *   --limit N       Max articles to ingest per publisher (default: 50)
 *   --concurrency N Parallel article fetches (default: 3)
 *
 * Examples:
 *   node scripts/backfillFromSitemaps.js --days 365 --publisher talos
 *   node scripts/backfillFromSitemaps.js --days 90
 *   node scripts/backfillFromSitemaps.js --dry-run --publisher crowdstrike
 */

import "dotenv/config";
import { createHash }              from "crypto";
import { createClient }            from "@supabase/supabase-js";
import { normalizeSource }         from "../lib/pipeline/ingest/normalizeSource.js";
import { extractDocumentSections } from "../lib/pipeline/ingest/extractDocumentSections.js";
import { validateAndTypeSource }   from "../lib/pipeline/validation/validateAndTypeSource.js";

const args         = process.argv.slice(2);
const getArg       = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag      = f => args.includes(f);

// Default window capped at ~360 days (≈ 2025 Q3 → now): the horizon scan only
// wants recent operational evidence, not multi-year archives.
const DAYS         = parseInt(getArg("--days",        "360"), 10);
const PUBLISHER_F  = getArg("--publisher", "").toLowerCase();
const DRY_RUN      = hasFlag("--dry-run");
const PER_PUB_LIMIT= parseInt(getArg("--limit",       "50"),  10);
const CONCURRENCY  = parseInt(getArg("--concurrency", "3"),   10);
const ARTICLE_TIMEOUT = 15000;
const MAX_HTML_CHARS  = 15000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Publisher registry ────────────────────────────────────────────────────────
// sitemap: direct urlset OR sitemap index (resolved automatically)
// urlFilter: only keep URLs matching this pattern (avoids tag/author pages)

// ── Platform strategies ──────────────────────────────────────────────────────
// ghost_rss  → paginated RSS feed (/rss/ → /rss/?page=2 …) — returns full content
// wp_api     → WordPress JSON REST API (/wp-json/wp/v2/posts) — returns full content
// rss_only   → standard RSS (current items only, used as a fallback signal)
// sitemap    → HTML scraping from sitemap URLs (works on static/non-JS sites)

const PUBLISHERS = [
  // ── Ghost CMS blogs (paginated RSS gives full historical content) ──────────
  {
    name:        "Cisco Talos",
    publisher:   "Cisco Talos",
    strategy:    "ghost_rss",
    rssBase:     "https://blog.talosintelligence.com/rss/",
    trust_tier:  "high",
    source_type: "threat_intelligence",
  },
  {
    name:        "Embrace The Red",
    publisher:   "Wunderwuzzi (Embrace The Red)",
    strategy:    "ghost_rss",
    rssBase:     "https://embracethered.com/blog/index.xml",
    trust_tier:  "high",
    source_type: "research_finding",
  },

  // ── WordPress blogs with paginated RSS (full content in feed) ───────────────
  {
    name:        "SentinelOne Labs",
    publisher:   "SentinelOne",
    strategy:    "ghost_rss",   // WP also supports ?paged=N on RSS
    rssBase:     "https://www.sentinelone.com/labs/feed/",
    rssPageParam:"paged",
    trust_tier:  "high",
    source_type: "threat_intelligence",
  },

  // ── Static/Hugo sites — sitemap + HTML fetch ───────────────────────────────
  {
    name:        "CrowdStrike Blog",
    publisher:   "CrowdStrike",
    strategy:    "sitemap",
    sitemaps:    ["https://www.crowdstrike.com/post-sitemap.xml",
                  "https://www.crowdstrike.com/post-sitemap2.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /crowdstrike\.com\/blog\//,
  },
  {
    name:        "Bishop Fox",
    publisher:   "Bishop Fox",
    strategy:    "sitemap",
    sitemaps:    ["https://bishopfox.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /bishopfox\.com\/blog\//,
    isSitemapIndex: true,
    indexFilter: /blog/,
  },

  // ── AI-enabled threat sources ────────────────────────────────────────────────
  {
    name:        "DFRLab (Atlantic Council)",
    publisher:   "Atlantic Council DFRLab",
    strategy:    "sitemap",
    sitemaps:    ["https://dfrlab.org/post-sitemap.xml", "https://dfrlab.org/post-sitemap2.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /dfrlab\.org\/\d{4}\/\d{2}\//,
  },
  {
    name:        "404 Media",
    publisher:   "404 Media",
    strategy:    "ghost_rss",
    rssBase:     "https://www.404media.co/rss/",
    trust_tier:  "medium",
    source_type: "news_article",
  },
  {
    name:        "The Record",
    publisher:   "The Record",
    strategy:    "sitemap",
    sitemaps:    ["https://therecord.media/sitemap.xml"],
    trust_tier:  "medium",
    source_type: "news_article",
    urlFilter:   /therecord\.media\/[a-z0-9-]+\/?$/,
    isSitemapIndex: true,
    indexFilter: /sitemaps\/page/,
  },

  // ── Sitemap + HTML (static sites / Hugo / Jekyll — no JS rendering) ────────
  {
    name:        "Google Security Blog",
    publisher:   "Google",
    strategy:    "sitemap",
    sitemaps:    ["https://security.googleblog.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /security\.googleblog\.com\/\d{4}\/\d{2}\//,
  },
  {
    name:        "Trail of Bits",
    publisher:   "Trail of Bits",
    strategy:    "sitemap",
    sitemaps:    ["https://blog.trailofbits.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /blog\.trailofbits\.com\/\d{4}\/\d{2}\//,
    isSitemapIndex: true,
    indexFilter: /post/,
  },
  {
    name:        "Adversa AI",
    publisher:   "Adversa AI",
    strategy:    "sitemap",
    sitemaps:    ["https://adversa.ai/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /adversa\.ai\/blog\//,
    isSitemapIndex: true,
    indexFilter: /blog/,
  },

  // ── Operational / incident-response publishers (deep sitemap scrape) ─────────
  {
    name:        "The DFIR Report",
    publisher:   "The DFIR Report",
    strategy:    "sitemap",
    sitemaps:    ["https://thedfirreport.com/post-sitemap.xml"],
    trust_tier:  "high",
    source_type: "incident",
    urlFilter:   /thedfirreport\.com\/20\d{2}\//,
  },
  {
    name:        "Red Canary",
    publisher:   "Red Canary",
    strategy:    "sitemap",
    sitemaps:    ["https://redcanary.com/post-sitemap.xml"],
    trust_tier:  "high",
    source_type: "incident",
    urlFilter:   /redcanary\.com\/blog\//,
  },
  {
    name:        "Huntress",
    publisher:   "Huntress",
    strategy:    "sitemap",
    sitemaps:    ["https://www.huntress.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "incident",
    urlFilter:   /huntress\.com\/blog\//,
  },
  {
    name:        "Check Point Research",
    publisher:   "Check Point Research",
    strategy:    "sitemap",
    sitemaps:    ["https://research.checkpoint.com/post-sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /research\.checkpoint\.com\/20\d{2}\//,
  },

  // ── Tier C: AI-native operational blogs with NO RSS (sitemap-only; added 2026-06-25)
  //    These are the best-fit AI-security feeds (agent/copilot abuse, jailbreaks,
  //    AI red-team research) but publish no RSS, so they cannot live in the daily
  //    RSS registry — they are pulled here by periodic backfill instead.
  //    Zenity sitemap carries <lastmod>; SPLX/Pillar do not, so their dates are
  //    extracted from each article's HTML at fetch time (resolveUrls keeps dateless
  //    URLs; fetchArticleText → extractDocumentSections recovers the date).
  //    See docs/OPERATIONAL_SOURCE_EXPANSION_PLAN.md §3 (Tier C).
  {
    name:        "Zenity Labs",
    publisher:   "Zenity",
    strategy:    "sitemap",
    sitemaps:    ["https://zenity.io/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /zenity\.io\/blog\//,
  },
  {
    name:        "SPLX (Straiker)",
    publisher:   "SPLX",
    strategy:    "sitemap",
    sitemaps:    ["https://splx.ai/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /splx\.ai\/blog\//,
  },
  {
    name:        "Pillar Security",
    publisher:   "Pillar Security",
    strategy:    "sitemap",
    sitemaps:    ["https://www.pillar.security/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /pillar\.security\/blog\//,
  },
];

// ── Ghost RSS paginator ────────────────────────────────────────────────────────
// Ghost exposes full post content in paginated RSS: /rss/?page=N
// Returns [{url, lastmod, title, text}]

async function fetchGhostRssPage(base, page, pageParam = "page") {
  const sep  = base.includes("?") ? "&" : "?";
  const url  = page === 1 ? base : `${base}${sep}${pageParam}=${page}`;
  const xml  = await fetchXml(url, 20000);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const chunk = m[1];
    const getTag = (t) => chunk.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`))?.[1]?.trim() || "";
    const loc  = getTag("link") || getTag("guid");
    const date = getTag("pubDate") || getTag("dc:date");
    // Ghost includes full content in <content:encoded>
    const body = getTag("content:encoded") || getTag("description") || "";
    const title = getTag("title");
    // Strip HTML tags for plain text
    const text = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_HTML_CHARS);
    if (loc && text.length > 100) items.push({ url: loc, lastmod: date, title, text });
  }
  return items;
}

async function resolveGhostRss(pub, cutoffDate, limit) {
  const entries = [];
  let page = 1;
  const pageParam = pub.rssPageParam || "page";   // Ghost uses ?page=N, WP uses ?paged=N
  while (entries.length < limit) {
    let items;
    try { items = await fetchGhostRssPage(pub.rssBase, page, pageParam); }
    catch { break; } // no more pages or blocked
    if (!items.length) break;

    let hitCutoff = false;
    for (const item of items) {
      const d = item.lastmod ? new Date(item.lastmod) : null;
      if (d && d < cutoffDate) { hitCutoff = true; break; }
      entries.push(item);
      if (entries.length >= limit) break;
    }
    if (hitCutoff || entries.length >= limit) break;
    page++;
    await new Promise(r => setTimeout(r, 500)); // polite delay
  }
  return entries;
}

// ── WordPress REST API ────────────────────────────────────────────────────────
// WP REST API returns JSON with full rendered content: /wp-json/wp/v2/posts
// Returns [{url, lastmod, title, text}]

async function fetchWpApiPage(base, page, cutoffDate) {
  const after = cutoffDate.toISOString();
  const url   = `${base}?per_page=50&page=${page}&after=${after}&_fields=link,date,title,content`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)", "Accept": "application/json" },
    redirect: "follow",
  });
  if (r.status === 400) return []; // WP returns 400 for page beyond max
  if (!r.ok) throw new Error(`WP API HTTP ${r.status}`);
  const posts = await r.json();
  if (!Array.isArray(posts)) return [];
  return posts.map(p => {
    const html = p.content?.rendered || "";
    const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_HTML_CHARS);
    const title = (p.title?.rendered || "").replace(/<[^>]+>/g, "").trim();
    return { url: p.link, lastmod: p.date, title, text };
  }).filter(p => p.url && p.text.length > 100);
}

async function resolveWpApi(pub, cutoffDate, limit) {
  const entries = [];
  let page = 1;
  while (entries.length < limit) {
    let items;
    try { items = await fetchWpApiPage(pub.apiBase, page, cutoffDate); }
    catch { break; }
    if (!items.length) break;
    entries.push(...items);
    if (items.length < 50) break; // last page
    page++;
    await new Promise(r => setTimeout(r, 400));
  }
  return entries.slice(0, limit);
}

// ── Sitemap parsing ────────────────────────────────────────────────────────────

function parseSitemapUrls(xml) {
  // Returns [{url, lastmod}] from urlset
  const entries = [];
  for (const m of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const loc     = m[0].match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    const lastmod = m[0].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim();
    if (loc) entries.push({ url: loc, lastmod: lastmod || null });
  }
  return entries;
}

function parseSitemapIndex(xml) {
  // Returns sub-sitemap URLs from sitemapindex
  const urls = [];
  for (const m of xml.matchAll(/<sitemap>[\s\S]*?<\/sitemap>/g)) {
    const loc = m[0].match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (loc) urls.push(loc);
  }
  return urls;
}

async function fetchXml(url, timeoutMs = 15000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function resolveUrls(pub, cutoffDate) {
  const allEntries = [];

  for (const sitemapUrl of pub.sitemaps) {
    let xml;
    try { xml = await fetchXml(sitemapUrl); }
    catch (err) { console.warn(`  [sitemap] fetch failed: ${sitemapUrl} — ${err.message}`); continue; }

    // Detect sitemap index
    const isIndex = xml.includes("<sitemapindex") || pub.isSitemapIndex;

    if (isIndex) {
      const subUrls = parseSitemapIndex(xml);
      const filtered = pub.indexFilter
        ? subUrls.filter(u => pub.indexFilter.test(u))
        : subUrls;

      for (const sub of filtered.slice(0, 5)) {  // max 5 sub-sitemaps
        try {
          const subXml = await fetchXml(sub);
          allEntries.push(...parseSitemapUrls(subXml));
        } catch { /* skip */ }
      }
    } else {
      allEntries.push(...parseSitemapUrls(xml));
    }
  }

  // Filter by URL pattern + date
  return allEntries.filter(({ url, lastmod }) => {
    if (pub.urlFilter && !pub.urlFilter.test(url)) return false;
    if (!lastmod) return true; // include if no date (will be filtered at fetch time)
    return new Date(lastmod) >= cutoffDate;
  });
}

// ── Article fetching ──────────────────────────────────────────────────────────

async function fetchArticleText(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ARTICLE_TIMEOUT),
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0; +https://thehorizon.ai)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const { text, title, date } = extractDocumentSections(html, { url, maxChars: MAX_HTML_CHARS });
  return { text, title, date };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

async function existingIds(ids) {
  // Only skip sources that have already been through Layer 3 (status is set)
  // Re-process null-status sources so they get proper validation
  const { data } = await supabase.from("sources").select("id,validation_status").in("id", ids);
  return new Set((data || []).filter(r => r.validation_status !== null).map(r => r.id));
}

// Only columns that exist in the sources table
const DB_COLUMNS = new Set([
  "id","url","title","publisher","author","date_published","source_type",
  "full_text","summary","trust_tier","tags","main_category","ai_specificity_score",
  "relevance_tier","validation_status","layer3_status","validation_summary",
  "ai_threat_focus","candidate_domain","downstream_route","intelligence",
  "short_summary","analyst_brief","claim_extraction_status","source_type",
]);

async function upsertSource(row) {
  const clean = Object.fromEntries(Object.entries(row).filter(([k]) => DB_COLUMNS.has(k)));
  const { error } = await supabase.from("sources").upsert(clean, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

// ── Ingest pipeline (simplified Layer 3 — save as 'review', understandCorpus handles rest) ──

async function ingestArticle(url, lastmod, pub) {
  let articleText = "", articleTitle = "", articleDate = lastmod;

  try {
    const { text, title, date } = await fetchArticleText(url);
    articleText  = text  || "";
    articleTitle = title || url.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "";
    articleDate  = date  || lastmod;
  } catch (err) {
    return { status: "fetch_failed", reason: err.message };
  }

  if (articleText.length < 200) {
    return { status: "skip", reason: "too_short" };
  }

  const id = makeId(url);
  const row = normalizeSource({
    id,
    title:          articleTitle,
    url,
    publisher:      pub.publisher,
    author:         pub.publisher,
    date_published: articleDate,
    source_type:    pub.source_type,
    full_text:      articleText,
    trust_tier:     pub.trust_tier,
  });

  // Save with validation_status='review' — understandCorpus + Layer 3 will classify
  // (same flow as RSS feed items that need review)
  const validated = await validateAndTypeSource(row, { skipLlm: false });
  const dbRow = {
    id:                row.id,
    url:               row.url,
    title:             row.title,
    publisher:         row.publisher,
    author:            row.publisher,
    date_published:    row.date_published,
    source_type:       validated.source_type || row.source_type,
    full_text:         row.full_text,
    summary:           row.full_text?.slice(0, 500) || "",
    trust_tier:        row.trust_tier,
    main_category:     validated.main_category || null,
    validation_status: validated.validation_status || "review",
    ai_threat_focus:   validated.ai_threat_focus || null,
    validation_summary: validated.validation_summary || null,
    claim_extraction_status: null,
  };

  await upsertSource(dbRow);
  return { status: "saved", chars: articleText.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cutoffDate = new Date(Date.now() - DAYS * 86400000);
  const cutoffStr  = cutoffDate.toISOString().slice(0, 10);

  const publishers = PUBLISHER_F
    ? PUBLISHERS.filter(p => p.name.toLowerCase().includes(PUBLISHER_F))
    : PUBLISHERS;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Sitemap Backfill`);
  console.log(`  Since: ${cutoffStr} (last ${DAYS} days)  Limit: ${PER_PUB_LIMIT}/publisher${DRY_RUN ? "  [DRY RUN]" : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  let totalSaved = 0, totalSkipped = 0, totalFailed = 0;

  for (const pub of publishers) {
    process.stdout.write(`  ${pub.name.padEnd(30)} [${pub.strategy}] fetching... `);

    // Resolve entries using the appropriate strategy
    let richEntries = []; // [{url, lastmod, title?, text?}]
    try {
      if (pub.strategy === "ghost_rss") {
        richEntries = await resolveGhostRss(pub, cutoffDate, PER_PUB_LIMIT);
      } else if (pub.strategy === "wp_api") {
        richEntries = await resolveWpApi(pub, cutoffDate, PER_PUB_LIMIT);
      } else {
        const urlEntries = await resolveUrls(pub, cutoffDate);
        richEntries = urlEntries.slice(0, PER_PUB_LIMIT).map(e => ({ ...e, text: null }));
      }
    } catch (err) {
      console.log(`FAIL (${err.message.slice(0, 70)})`);
      continue;
    }

    process.stdout.write(`${richEntries.length} posts\n`);
    if (richEntries.length === 0) continue;

    if (DRY_RUN) {
      richEntries.slice(0, 5).forEach(e =>
        console.log(`    ${(e.lastmod||"?").slice(0,10)} [${e.text?.length||0}ch] ${e.url}`)
      );
      if (richEntries.length > 5) console.log(`    ... and ${richEntries.length - 5} more`);
      continue;
    }

    // Check which IDs already exist
    const ids = richEntries.map(e => makeId(e.url));
    const existing = await existingIds(ids);
    const toProcess = richEntries.filter(e => !existing.has(makeId(e.url)));

    const alreadyIn = richEntries.length - toProcess.length;
    if (alreadyIn > 0) process.stdout.write(`    ${alreadyIn} already in DB, ingesting ${toProcess.length} new\n`);
    if (toProcess.length === 0) continue;

    let saved = 0, skipped = 0, failed = 0;
    let i = 0;

    async function worker() {
      while (i < toProcess.length) {
        const entry = toProcess[i++];
        let result;
        // ghost_rss / wp_api already have full text — save directly
        if (entry.text && entry.text.length >= 200) {
          try {
            const normalized = normalizeSource({
              id:             makeId(entry.url),
              title:          entry.title || entry.url.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "",
              url:            entry.url,
              publisher:      pub.publisher,
              author:         pub.publisher,
              date_published: entry.lastmod,
              source_type:    pub.source_type,
              full_text:      entry.text,
              trust_tier:     pub.trust_tier,
            });
            // Run Layer 3 validation so only AI-relevant content passes to understandCorpus
            const validated = await validateAndTypeSource(normalized, { skipLlm: false });
            const row = {
              id:                normalized.id,
              url:               normalized.url,
              title:             normalized.title,
              publisher:         normalized.publisher,
              author:            normalized.publisher,
              date_published:    normalized.date_published,
              source_type:       validated.source_type || normalized.source_type,
              full_text:         normalized.full_text,
              summary:           normalized.full_text?.slice(0, 500) || "",
              trust_tier:        normalized.trust_tier,
              main_category:     validated.main_category || null,
              validation_status: validated.validation_status || "review",
              ai_threat_focus:   validated.ai_threat_focus || null,
              validation_summary: validated.validation_summary || null,
              claim_extraction_status: null,
            };
            await upsertSource(row);
            result = { status: "saved" };
          } catch (err) {
            result = { status: "fetch_failed", reason: err.message };
          }
        } else {
          // sitemap strategy — fetch article HTML
          result = await ingestArticle(entry.url, entry.lastmod, pub);
        }

        if      (result.status === "saved")        { saved++;   process.stdout.write("."); }
        else if (result.status === "fetch_failed") { failed++;  process.stdout.write("x"); }
        else                                       { skipped++; process.stdout.write("_"); }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    process.stdout.write(`\n    saved:${saved} skipped:${skipped} failed:${failed}\n`);

    totalSaved   += saved;
    totalSkipped += skipped;
    totalFailed  += failed;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Total: ${totalSaved} saved, ${totalSkipped} skipped, ${totalFailed} failed`);

  if (totalSaved > 0 && !DRY_RUN) {
    console.log(`\n  Next step — run the full ingest pipeline on new sources:`);
    console.log(`    node scripts/backfillSources.js --feeds-only`);
    console.log(`  Then enrich:`);
    console.log(`    node scripts/understandCorpus.js --concurrency 3`);
  }
}

main().catch(err => {
  console.error("\nFATAL:", err.message, err.stack?.slice(0, 400));
  process.exit(1);
});
