/**
 * LLM-powered source discovery backfill.
 *
 * Runs Gemini with Google Search grounding to find agentic AI / MCP /
 * prompt injection security content and saves it directly to Supabase.
 * Unlike backfillSources.js, this does NOT filter by date window since
 * discovered sources may predate our coverage gap.
 *
 * Requires GEMINI_API_KEY in .env.
 *
 * Usage:
 *   node scripts/llmDiscoverySources.js
 */

import "dotenv/config";
import { fetchLlmDiscoverySources } from "../lib/pipeline/ingest/connectors/llmDiscoveryConnector.js";
import { cleanSources } from "../lib/pipeline/clean/cleanSources.js";
import { dedupeSources } from "../lib/utils/dedupe.js";
import { filterAcceptableSources } from "../lib/pipeline/ingest/filterAcceptableSources.js";
import { attachValidityToSources } from "../lib/pipeline/ingest/sourceValidity.js";
import { attachInitialTags } from "../lib/pipeline/ingest/tagSource.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";

const now = new Date();

console.log(`\n${"═".repeat(60)}`);
console.log(` LLM Source Discovery — ${now.toISOString().slice(0, 10)}`);
console.log(` Model: Gemini 2.5 Flash + Google Search grounding`);
console.log(`${"═".repeat(60)}\n`);

// ── Discovery ─────────────────────────────────────────────────────────────────

console.log("Phase 1: Querying Gemini with grounding prompts…");
const rawSources = await fetchLlmDiscoverySources({});
console.log(`  Raw discovered: ${rawSources.length} sources\n`);

if (rawSources.length === 0) {
  console.log("No sources discovered. Check GEMINI_API_KEY / GEMINI_API_KEY_2 and Gemini quota.");
  process.exit(0);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

console.log("Phase 2: Running pipeline (clean → dedup → filter → validate → tag)…");

const cleaned = cleanSources(rawSources);
const deduped = dedupeSources(cleaned);
const { accepted, rejected } = filterAcceptableSources(deduped);
const withValidity = await attachValidityToSources(accepted);
const usable = withValidity.filter((s) => s.validity?.usable);
const tagged = attachInitialTags(usable);

console.log(`  Raw:      ${rawSources.length}`);
console.log(`  Deduped:  ${deduped.length}`);
console.log(`  Accepted: ${accepted.length}  (rejected: ${rejected.length})`);
console.log(`  Usable:   ${usable.length}`);
console.log(`  Tagged:   ${tagged.length}\n`);

if (rejected.length > 0) {
  console.log("  Rejected sources:");
  for (const r of rejected.slice(0, 5)) {
    console.log(`    - ${r.title?.slice(0, 60)} (${r.reason})`);
  }
  if (rejected.length > 5) console.log(`    … and ${rejected.length - 5} more`);
  console.log();
}

// ── Save ──────────────────────────────────────────────────────────────────────

console.log("Phase 3: Saving to Supabase…");

// Build a reporting window spanning the discovered sources' date range
const dates = tagged
  .map((s) => s.date_published)
  .filter(Boolean)
  .sort();

const windowStart = dates[0] || now.toISOString();
const windowEnd = dates[dates.length - 1] || now.toISOString();

const snapshot = {
  generated_at: now.toISOString(),
  period: "custom",
  stage: "llm_discovery_backfill",
  reporting_window: {
    timezone: "Asia/Singapore",
    start_utc: windowStart,
    end_utc: windowEnd,
    start_sgt: windowStart,
    end_sgt: windowEnd,
  },
  count: tagged.length,
  removed_by_publish_date_count: 0,
  rejected_count: rejected.length,
  discarded_count: usable.length - tagged.length,
  pipeline_counts: {
    raw: rawSources.length,
    cleaned: cleaned.length,
    deduped: deduped.length,
    accepted: accepted.length,
    rejected: rejected.length,
    usable: usable.length,
    tagged: tagged.length,
  },
  sources: tagged,
  archive: null,
  connector_results: [
    {
      connector: "LLM Discovery",
      status: "success",
      count: rawSources.length,
      trust_tier: "medium",
      retrieval_method: "llm_discovery",
      started_at: now.toISOString(),
      finished_at: new Date().toISOString(),
    },
  ],
};

try {
  await saveSnapshotToDatabase(snapshot);
  console.log(`  Saved ${tagged.length} sources.\n`);
} catch (err) {
  console.error(`  Save failed: ${err.message}`);
  process.exit(1);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("Top discovered sources by initial tag:");
const sorted = [...tagged].sort((a, b) => (b.tags?.length || 0) - (a.tags?.length || 0));
for (const s of sorted.slice(0, 10)) {
  const tags = (s.tags || []).slice(0, 3).join(", ") || "untagged";
  console.log(`  [${tags}] ${s.title?.slice(0, 70)}`);
}

console.log(`\n${"─".repeat(60)}`);
console.log(` Discovery complete.`);
console.log(`   Sources saved : ${tagged.length}`);
console.log(`\n Next steps:`);
console.log(`   1. node scripts/dailyClassify.js --since-hours 6 --limit 500  (classify + QA + digest fanout)`);
console.log(`${"═".repeat(60)}\n`);
