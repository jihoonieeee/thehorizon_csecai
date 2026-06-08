/**
 * Validation Layer Debug Script (Layer 3)
 *
 * Runs the validation layer (validateAndTypeSource) on recent sources from
 * Supabase and prints a structured summary for inspection: the LLM relevance
 * verdict, 2-3 sentence summary, source_type, and pass/review/reject status.
 *
 * Usage:
 *   node scripts/debugValidation.js [options]
 *
 * Options:
 *   --limit <n>          Number of sources to sample (default: 50)
 *   --trust <tier>       Filter by trust_tier (primary|high|medium|low|curated)
 *   --type <type>        Filter by current source_type in DB
 *   --invalid-only       Show only sources that fail validation
 *   --json               Output full JSON instead of summary table
 *   --no-llm             Skip the relevance LLM call (fully deterministic pre-gate)
 *   --days <n>           Sources from last N days (default: 30)
 *
 * Examples:
 *   node scripts/debugValidation.js
 *   node scripts/debugValidation.js --limit 100 --invalid-only
 *   node scripts/debugValidation.js --type research_paper --no-llm
 *   node scripts/debugValidation.js --trust medium --json
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { assertStage3 }          from "../lib/schemas/sourceSchema.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const getArg    = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const hasFlag   = (name) => args.includes(name);

const LIMIT      = parseInt(getArg("--limit", "50"), 10);
const TRUST      = getArg("--trust", null);
const TYPE       = getArg("--type", null);
const DAYS       = parseInt(getArg("--days", "30"), 10);
const INVALID_ONLY = hasFlag("--invalid-only");
const JSON_OUT   = hasFlag("--json");
const NO_LLM     = hasFlag("--no-llm");

// ── Load sources ──────────────────────────────────────────────────────────────

async function loadSources() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  let query = sb
    .from("sources")
    .select("id,title,url,publisher,date_published,source_type,trust_tier,tags,full_text,summary,short_summary,claim_extraction_status,intelligence,date_confidence,needs_review,created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (TRUST) query = query.eq("trust_tier", TRUST);
  if (TYPE)  query = query.eq("source_type", TYPE);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const COL_WIDTHS = { title: 45, source_type: 28, trust: 8, status: 7, tier: 10, flags: 35 };

function pad(str, width) {
  const s = String(str ?? "").slice(0, width);
  return s.padEnd(width);
}

function printTableHeader() {
  const sep = "─".repeat(
    COL_WIDTHS.title + COL_WIDTHS.source_type + COL_WIDTHS.trust +
    COL_WIDTHS.status + COL_WIDTHS.tier + COL_WIDTHS.flags + 10
  );
  console.log(sep);
  console.log(
    pad("Title", COL_WIDTHS.title) + "  " +
    pad("source_type", COL_WIDTHS.source_type) + "  " +
    pad("trust", COL_WIDTHS.trust) + "  " +
    pad("status", COL_WIDTHS.status) + "  " +
    pad("rel_tier", COL_WIDTHS.tier) + "  " +
    pad("filter_flags", COL_WIDTHS.flags)
  );
  console.log(sep);
}

function printTableRow(result) {
  const flags = (result.filter_flags || []).join(", ") || "";
  const typeDisplay = result.source_type +
    (result.source_type_reason && result.source_type_reason !== "existing"
      ? ` (${result.source_type_reason})`
      : "");

  console.log(
    pad(result.title, COL_WIDTHS.title) + "  " +
    pad(typeDisplay, COL_WIDTHS.source_type) + "  " +
    pad(result.trust_tier, COL_WIDTHS.trust) + "  " +
    pad(result.validation_status, COL_WIDTHS.status) + "  " +
    pad(result.relevance_tier, COL_WIDTHS.tier) + "  " +
    pad(flags, COL_WIDTHS.flags)
  );
}

// ── Summary statistics ────────────────────────────────────────────────────────

function printSummary(results, originalSources) {
  const passing  = results.filter((r) => r.validation_status !== "reject");
  const rejected = results.filter((r) => r.validation_status === "reject");
  const passed   = results.filter((r) => r.validation_status === "pass");
  const reviewed = results.filter((r) => r.validation_status === "review");
  const llmCalls = results.filter((r) => r.validation_relevance_method === "llm");

  // Source type distribution
  const typeDist = {};
  for (const r of results) {
    typeDist[r.source_type] = (typeDist[r.source_type] || 0) + 1;
  }

  // source_type_reason distribution
  const reasonDist = {};
  for (const r of results) {
    const m = r.source_type_reason || "none";
    reasonDist[m] = (reasonDist[m] || 0) + 1;
  }

  // Trust tier distribution (after Layer 5 assignment)
  const tierDist = {};
  for (const r of results) {
    tierDist[r.trust_tier] = (tierDist[r.trust_tier] || 0) + 1;
  }

  // Relevance tier distribution
  const relDist = {};
  for (const r of results) {
    relDist[r.relevance_tier] = (relDist[r.relevance_tier] || 0) + 1;
  }

  // Flag frequency (all sources)
  const flagDist = {};
  for (const r of results) {
    for (const flag of r.filter_flags || []) {
      flagDist[flag] = (flagDist[flag] || 0) + 1;
    }
  }

  // Types changed by Layer 5 (legacy → canonical mapping)
  const changed = results.filter((r, i) => r.source_type !== originalSources[i].source_type);

  console.log("\n" + "═".repeat(80));
  console.log("VALIDATION LAYER DEBUG SUMMARY");
  console.log("═".repeat(80));
  console.log(`Sources sampled:    ${results.length}`);
  console.log(`Pass:               ${passed.length} (${pct(passed.length, results.length)}%)`);
  console.log(`Review:             ${reviewed.length} (${pct(reviewed.length, results.length)}%)`);
  console.log(`Reject:             ${rejected.length} (${pct(rejected.length, results.length)}%)`);
  console.log(`LLM calls made:     ${llmCalls.length}`);
  console.log(`Types remapped:     ${changed.length} sources had source_type updated`);

  if (changed.length > 0) {
    console.log("\nType remapping examples (old → new):");
    for (const r of changed.slice(0, 8)) {
      console.log(`  ${originalSources[results.indexOf(r)].source_type} → ${r.source_type}  "${r.title?.slice(0,50)}"`);
    }
  }

  console.log("\nSource type distribution (after validation):");
  for (const [type, count] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${type}`);
  }

  console.log("\nClassification reason (source_type_reason):");
  for (const [reason, count] of Object.entries(reasonDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }

  console.log("\nTrust tier (after validation assignment):");
  for (const [tier, count] of Object.entries(tierDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${tier}`);
  }

  console.log("\nRelevance tier:");
  for (const [tier, count] of Object.entries(relDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${tier}`);
  }

  if (Object.keys(flagDist).length > 0) {
    console.log("\nFilter flag frequency:");
    for (const [flag, count] of Object.entries(flagDist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${flag}`);
    }
  }

  // Schema validation sample
  console.log("\nSchema validation (first 5 passing sources):");
  let failures = 0;
  for (const r of passed.slice(0, 5)) {
    const { valid: ok, issues } = assertStage3(r);
    if (!ok) {
      failures++;
      console.log(`  ✗ "${r.title?.slice(0, 50)}" — ${issues.slice(0, 3).join(", ")}`);
    } else {
      console.log(`  ✓ "${r.title?.slice(0, 50)}"`);
    }
  }
  if (failures === 0 && passed.length > 0) console.log("  All checked sources pass assertStage3()");
}

function pct(n, total) {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nValidation Layer Debug — ${LIMIT} sources, last ${DAYS} days`);
  if (TRUST) console.log(`Filter: trust_tier = ${TRUST}`);
  if (TYPE)  console.log(`Filter: source_type = ${TYPE}`);
  if (NO_LLM) console.log("Mode: --no-llm (deterministic pre-gate only)");
  console.log();

  const sources = await loadSources();
  if (sources.length === 0) {
    console.log("No sources found. Try increasing --days or adjusting filters.");
    return;
  }
  console.log(`Loaded ${sources.length} sources from DB\n`);

  // Run Layer 5 on each source
  const results = [];
  for (const source of sources) {
    const result = await validateAndTypeSource(source, { skipLlm: NO_LLM });
    results.push(result);
  }

  if (JSON_OUT) {
    const output = results
      .filter((r) => !INVALID_ONLY || !r.is_valid)
      .map((r) => ({
        id:                     r.id,
        title:                  r.title,
        url:                    r.url,
        publisher:              r.publisher,
        date_published:         r.date_published,
        is_valid:               r.is_valid,
        validity_reason:        r.validity_reason,
        filter_flags:           r.filter_flags,
        validation_status:      r.validation_status,
        ai_threat_focus:        r.ai_threat_focus,
        validation_summary:     r.validation_summary,
        validation_relevance_method: r.validation_relevance_method,
        validation_qa_status:   r.validation_qa_status,
        relevance_tier:         r.relevance_tier,
        source_type:            r.source_type,
        source_type_reason:     r.source_type_reason,
        source_type_confidence: r.source_type_confidence,
        trust_tier:             r.trust_tier,
        trust_tier_reason:      r.trust_tier_reason,
        text_quality_score:     r.text_quality_score,
        ai_relevance_score:     r.ai_relevance_score,
        publish_date_confidence: r.publish_date_confidence,
        source_credibility_score: r.source_credibility_score,
      }));
    console.log(JSON.stringify(output, null, 2));
  } else {
    const toShow = INVALID_ONLY ? results.filter((r) => !r.is_valid) : results;
    if (toShow.length === 0) {
      console.log("No results to display (try removing --invalid-only).");
    } else {
      printTableHeader();
      for (const r of toShow) printTableRow(r);
    }
    printSummary(results, sources);
  }
}

main().catch((err) => {
  console.error(`\nDebug failed: ${err.message}`);
  process.exit(1);
});
