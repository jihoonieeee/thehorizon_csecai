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
 *   --days N        How many days back to pull (default: 180)
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
import { createHash }          from "crypto";
import { createClient }        from "@supabase/supabase-js";
import { normalizeSource }     from "../lib/pipeline/ingest/normalizeSource.js";
import { extractDocumentSections } from "../lib/pipeline/ingest/extractDocumentSections.js";

const args         = process.argv.slice(2);
const getArg       = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag      = f => args.includes(f);

const DAYS         = parseInt(getArg("--days",        "180"), 10);
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

const PUBLISHERS = [
  {
    name:        "Cisco Talos",
    publisher:   "Cisco Talos",
    sitemaps:    ["https://blog.talosintelligence.com/sitemap-posts.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /^https:\/\/blog\.talosintelligence\.com\/[a-z0-9-]+\/?$/,
  },
  {
    name:        "SentinelOne Labs",
    publisher:   "SentinelOne",
    sitemaps:    ["https://www.sentinelone.com/labs-sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /sentinelone\.com\/blog\/|sentinelone\.com\/labs\//,
  },
  {
    name:        "CrowdStrike Blog",
    publisher:   "CrowdStrike",
    sitemaps:    ["https://www.crowdstrike.com/post-sitemap.xml",
                  "https://www.crowdstrike.com/post-sitemap2.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /crowdstrike\.com\/blog\//,
  },
  {
    name:        "Palo Alto Unit 42",
    publisher:   "Palo Alto Networks Unit 42",
    sitemaps:    ["https://unit42.paloaltonetworks.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /unit42\.paloaltonetworks\.com\/[a-z0-9-]+\/?$/,
    isSitemapIndex: true,
    indexFilter: /post/,
  },
  {
    name:        "Google Security Blog",
    publisher:   "Google",
    sitemaps:    ["https://security.googleblog.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /security\.googleblog\.com\/\d{4}\/\d{2}\//,
  },
  {
    name:        "Mandiant",
    publisher:   "Mandiant",
    sitemaps:    ["https://www.mandiant.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /mandiant\.com\/resources\/(blog|reports|research)\//,
    isSitemapIndex: true,
    indexFilter: /blog|research|report/,
  },
  {
    name:        "Proofpoint Threat Insight",
    publisher:   "Proofpoint",
    sitemaps:    ["https://www.proofpoint.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /proofpoint\.com\/(us|uk)\/blog\/threat-insight\//,
    isSitemapIndex: true,
    indexFilter: /blog/,
  },
  {
    name:        "Embrace The Red",
    publisher:   "Wunderwuzzi (Embrace The Red)",
    sitemaps:    ["https://embracethered.com/blog/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /embracethered\.com\/blog\/posts?\//,
  },
  {
    name:        "Elastic Security Labs",
    publisher:   "Elastic",
    sitemaps:    ["https://www.elastic.co/sitemap.xml"],
    trust_tier:  "high",
    source_type: "threat_intelligence",
    urlFilter:   /elastic\.co\/security-labs\//,
    isSitemapIndex: true,
    indexFilter: /security-labs/,
  },
  {
    name:        "Adversa AI",
    publisher:   "Adversa AI",
    sitemaps:    ["https://adversa.ai/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /adversa\.ai\/blog\//,
    isSitemapIndex: true,
    indexFilter: /blog/,
  },
  {
    name:        "Trail of Bits",
    publisher:   "Trail of Bits",
    sitemaps:    ["https://blog.trailofbits.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /blog\.trailofbits\.com\/\d{4}\/\d{2}\//,
    isSitemapIndex: true,
    indexFilter: /post/,
  },
  {
    name:        "Bishop Fox",
    publisher:   "Bishop Fox",
    sitemaps:    ["https://bishopfox.com/sitemap.xml"],
    trust_tier:  "high",
    source_type: "research_finding",
    urlFilter:   /bishopfox\.com\/blog\//,
    isSitemapIndex: true,
    indexFilter: /blog/,
  },
];

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
  const { data } = await supabase.from("sources").select("id").in("id", ids);
  return new Set((data || []).map(r => r.id));
}

async function upsertSource(row) {
  const { error } = await supabase.from("sources").upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

// ── Ingest pipeline (simplified Layer 3 — save as 'review', enrichCorpus handles rest) ──

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

  // Save with validation_status='review' — enrichCorpus + Layer 3 will classify
  // (same flow as RSS feed items that need review)
  const dbRow = {
    ...row,
    validation_status:       null,   // let the normal pipeline decide
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
    process.stdout.write(`  ${pub.name.padEnd(30)} resolving sitemap... `);

    let entries;
    try {
      entries = await resolveUrls(pub, cutoffDate);
    } catch (err) {
      console.log(`FAIL (${err.message.slice(0, 60)})`);
      continue;
    }

    entries = entries.slice(0, PER_PUB_LIMIT);
    process.stdout.write(`${entries.length} URLs in range\n`);

    if (entries.length === 0) continue;

    if (DRY_RUN) {
      entries.slice(0, 5).forEach(e => console.log(`    ${e.lastmod?.slice(0,10) || "?"} ${e.url}`));
      if (entries.length > 5) console.log(`    ... and ${entries.length - 5} more`);
      continue;
    }

    // Check which IDs already exist
    const ids = entries.map(e => makeId(e.url));
    const existing = await existingIds(ids);
    const toFetch  = entries.filter(e => !existing.has(makeId(e.url)));

    const alreadyIn = entries.length - toFetch.length;
    if (alreadyIn > 0) process.stdout.write(`    ${alreadyIn} already in DB, fetching ${toFetch.length} new\n`);

    // Fetch + ingest with bounded concurrency
    let saved = 0, skipped = 0, failed = 0;
    let i = 0;

    async function worker() {
      while (i < toFetch.length) {
        const { url, lastmod } = toFetch[i++];
        try {
          const result = await ingestArticle(url, lastmod, pub);
          if      (result.status === "saved")        { saved++;   process.stdout.write("."); }
          else if (result.status === "fetch_failed") { failed++;  process.stdout.write("x"); }
          else                                       { skipped++; process.stdout.write("_"); }
        } catch (err) {
          failed++;
          process.stdout.write("x");
        }
        // Polite delay between requests to the same host
        await new Promise(r => setTimeout(r, 400));
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
    console.log(`    node scripts/enrichCorpus.js --concurrency 3`);
  }
}

main().catch(err => {
  console.error("\nFATAL:", err.message, err.stack?.slice(0, 400));
  process.exit(1);
});
