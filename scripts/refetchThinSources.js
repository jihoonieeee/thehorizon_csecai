#!/usr/bin/env node
/**
 * refetchThinSources.js — Re-fetch full text for sources with suspiciously short
 * full_text (< THIN_THRESHOLD chars). These are sources where the connector only
 * captured a teaser blurb or RSS description instead of the full article body.
 *
 * What it does per source:
 *   1. Fetches the URL with the same fetchPageText() used by the discovery pipeline.
 *   2. If the fetched text is substantially longer than what is stored, writes
 *      full_text back to the DB and clears claim_extraction_status so the source
 *      is picked up by the next evidence-extraction run.
 *   3. Prints a per-source result: ENRICHED / UNCHANGED / SKIPPED / FAILED.
 *
 * Skipped automatically:
 *   - arXiv sources (handled by enrichArxivFullText.js with rate-limit awareness)
 *   - Known paywalled domains (ScienceDirect, IEEE, ACM, AAAI, Springer)
 *   - Child digest sources (parent_source_id set — text lives on the parent)
 *   - Sources with full_text already ≥ THIN_THRESHOLD
 *
 * Usage:
 *   node scripts/refetchThinSources.js [options]
 *
 *   --threshold N   Consider full_text "thin" if < N chars (default: 500)
 *   --limit N       Max sources to attempt (default: 200)
 *   --gap-ms N      Delay between requests in ms (default: 1200)
 *   --dry-run       Fetch and measure but do not write to DB
 *   --min-gain N    Only write if fetched text is at least N chars longer (default: 300)
 */

import "dotenv/config";
import { createClient }  from "@supabase/supabase-js";
// fetchPageText now has Jina+Tavily fallback built in (direct → Jina → Tavily)
import { fetchPageText } from "../lib/pipeline/discovery/fetchCandidateText.js";

const argv = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v !== undefined ? v : true];
  })
);
const THIN_THRESHOLD = parseInt(argv["threshold"] || "500",  10);
const LIMIT          = parseInt(argv["limit"]     || "200",  10);
const GAP_MS         = parseInt(argv["gap-ms"]    || "1200", 10);
const DRY_RUN        = Boolean(argv["dry-run"]);
const MIN_GAIN       = parseInt(argv["min-gain"]  || "300",  10);

// Domains where full text is behind a paywall or bot-block — skip rather than waste
// a request that will return a login wall.
const SKIP_DOMAINS = new Set([
  "arxiv.org",          // handled by enrichArxivFullText.js
  "sciencedirect.com",
  "ieeexplore.ieee.org",
  "ieee.org",
  "dl.acm.org",
  "acm.org",
  "ojs.aaai.org",
  "link.springer.com",
  "springer.com",
  "nature.com",
  "wiley.com",
]);

function shouldSkip(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return [...SKIP_DOMAINS].some(d => host === d || host.endsWith(`.${d}`));
  } catch {
    return true; // malformed URL
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  refetchThinSources — threshold=${THIN_THRESHOLD}  limit=${LIMIT}  gap=${GAP_MS}ms`);
  if (DRY_RUN) console.log("  DRY RUN — no DB writes");
  console.log(`${"═".repeat(60)}\n`);

  // Load candidates — fetch more than LIMIT and post-filter by length, since
  // PostgREST doesn't expose length() as a filter predicate.
  const { data: raw, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,full_text,source_type,trust_tier,main_category")
    .neq("validation_status", "reject")
    .is("parent_source_id", null)           // skip digest children
    .not("full_text", "is", null)
    .not("url", "is", null)
    .order("date_published", { ascending: false })
    .limit(5000);

  const data = (raw || [])
    .filter(s => (s.full_text || "").length < THIN_THRESHOLD)
    .slice(0, LIMIT);

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("No thin sources found. Done."); return; }

  // Sort: primary → high → medium → low → unknown
  const TIER_ORDER = { primary: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  data.sort((a, b) => (TIER_ORDER[a.trust_tier] ?? 4) - (TIER_ORDER[b.trust_tier] ?? 4));

  console.log(`Found ${data.length} thin sources (full_text < ${THIN_THRESHOLD} chars)\n`);

  let enriched = 0, unchanged = 0, skipped = 0, failed = 0;
  const enrichedIds = [];

  for (const s of data) {
    const stored = (s.full_text || "").length;
    const shortTitle = (s.title || "").slice(0, 60);

    if (shouldSkip(s.url)) {
      console.log(`  SKIP     [${s.trust_tier}] ${shortTitle}`);
      console.log(`           ${s.url} (paywalled/arXiv domain)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  FETCH    [${s.trust_tier}] ${shortTitle}\n           ${s.url}\n`);

    try {
      // fetchPageText cascades: direct fetch → Jina Reader → Tavily Extract
      const fetched = await fetchPageText(s.url, { timeoutMs: 20000, maxChars: 20000 });
      const gain = fetched.length - stored;

      if (fetched.length < 200 || gain < MIN_GAIN) {
        console.log(`           → ${fetched.length} chars (gain ${gain > 0 ? "+" : ""}${gain}) — UNCHANGED`);
        unchanged++;
      } else {
        console.log(`           → ${fetched.length} chars (was ${stored}, gain +${gain}) — ENRICHED`);
        if (!DRY_RUN) {
          const { error: upErr } = await supabase
            .from("sources")
            .update({
              full_text: fetched,
              // Clear so extraction pipeline re-runs on next evidence pass
              claim_extraction_status: null,
            })
            .eq("id", s.id);
          if (upErr) {
            console.error(`           DB write failed: ${upErr.message}`);
            failed++;
          } else {
            enriched++;
            enrichedIds.push(s.id);
          }
        } else {
          enriched++;
          enrichedIds.push(s.id);
        }
      }
    } catch (err) {
      console.log(`           → FAILED: ${err.message.slice(0, 80)}`);
      failed++;
    }

    await sleep(GAP_MS);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Enriched : ${enriched}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);
  if (enrichedIds.length) {
    console.log(`\n  Enriched IDs (re-run evidence extraction on these):`);
    console.log(`  ${enrichedIds.join(", ")}`);
    console.log(`\n  To extract evidence: node scripts/dailyClassify.js --force-ids ${enrichedIds.join(",")}`);
  }
  if (DRY_RUN) console.log("\n  (dry run — no DB changes made)");
}

main().catch(err => { console.error(err); process.exit(1); });
