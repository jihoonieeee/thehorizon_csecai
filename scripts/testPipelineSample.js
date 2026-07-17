#!/usr/bin/env node
/**
 * testPipelineSample.js — Inspect L3 → L4 → L5 pipeline on starred sources.
 *
 * Runs one phase at a time so you can inspect output and fix prompts before
 * committing to the next layer. Uses starred sources as the test sample because
 * analysts already flagged them as high-value, so wrong outputs are easy to spot.
 *
 * Usage:
 *   node scripts/testPipelineSample.js --phase none|3|4|5|all [--limit 12] [--persist] [--verbose]
 *
 * Phases:
 *   none  — print starred source sample only (no LLM calls)
 *   3     — run Layer 3 validation
 *   4     — run Layer 4 understanding/classification
 *   5     — run Layer 5 evidence extraction
 *   all   — run all three in sequence
 *
 * Flags:
 *   --persist    write results back to Supabase (default: dry-run)
 *   --verbose    print full evidence items / summaries (default: compact)
 *   --limit N    number of starred sources to use (default: 12)
 *   --force      re-run even on sources that appear already classified
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag  = (f) => args.includes(f);

const PHASE    = getArg("--phase", "none");
const LIMIT    = parseInt(getArg("--limit", "12"), 10);
const PERSIST  = hasFlag("--persist");
const VERBOSE  = hasFlag("--verbose");
const FORCE    = hasFlag("--force");

const PHASES_TO_RUN = PHASE === "all" ? ["3", "4", "5"] : PHASE !== "none" ? [PHASE] : [];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Formatting helpers ─────────────────────────────────────────────────────────

function pad(str, w) { return String(str ?? "").slice(0, w).padEnd(w); }
function trunc(str, w) { const s = String(str ?? ""); return s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w); }
const SEP = "─".repeat(120);
const HR  = "═".repeat(120);

function header(title) {
  console.log(`\n${HR}\n  ${title}\n${HR}`);
}

function subheader(title) {
  console.log(`\n${SEP}\n  ${title}\n${SEP}`);
}

// ── Step 0: Load starred sources ───────────────────────────────────────────────

header(`Pipeline Quality Test  [phase=${PHASE}  limit=${LIMIT}  persist=${PERSIST}  verbose=${VERBOSE}]`);

const { data: starredRaw, error: loadErr } = await sb.from("sources")
  .select([
    "id", "title", "url", "publisher", "date_published",
    "source_type", "trust_tier", "main_category", "tags",
    "layer3_status", "downstream_route", "reading_value",
    "source_family", "validation_status",
    "full_text", "clean_text", "summary", "short_summary",
    "intelligence", "ai_specificity_score", "candidate_domain",
    "ai_threat_focus", "needs_review",
  ].join(","))
  .eq("starred", true)
  .not("full_text", "is", null)
  .order("date_published", { ascending: false })
  .limit(LIMIT);

if (loadErr) { console.error("DB load failed:", loadErr.message); process.exit(1); }
if (!starredRaw?.length) { console.log("No starred sources with full_text found."); process.exit(0); }

// Filter to sources with meaningful text (≥500 chars avoids wasting L3 LLM on thin news stubs)
const sources = starredRaw.filter(s => (s.full_text || "").length >= 500);
console.log(`\n  Loaded ${sources.length} starred sources (from ${starredRaw.length} fetched)\n`);

// Print selection table
subheader("SAMPLE SELECTION (current DB state)");
console.log(
  pad("TITLE", 48) + pad("PUBLISHER", 22) + pad("CATEGORY", 26) +
  pad("FAMILY", 22) + pad("L3", 8) + pad("READING", 12) + "SOURCE_TYPE"
);
console.log("─".repeat(160));
for (const s of sources) {
  console.log(
    trunc(s.title, 48) + pad(s.publisher, 22) + pad(s.main_category, 26) +
    pad(s.source_family || s.intelligence?.source_family || "—", 22) +
    pad(s.layer3_status || "—", 8) + pad(s.reading_value || "—", 12) + (s.source_type || "—")
  );
}
console.log();

if (PHASES_TO_RUN.length === 0) {
  console.log("  (phase=none — no LLM calls made)");
  process.exit(0);
}

// ── Layer 3: Validation ────────────────────────────────────────────────────────

let l3Results = null; // keyed by source.id

if (PHASES_TO_RUN.includes("3")) {
  const { validateAndTypeSource } = await import("../lib/pipeline/validation/validateAndTypeSource.js");

  header("LAYER 3 — VALIDATION");
  console.log("  Running validateAndTypeSource on each source (fresh LLM call)...\n");

  const results = [];
  for (const source of sources) {
    process.stdout.write(`  [L3] ${trunc(source.title, 60)}... `);
    try {
      const r = await validateAndTypeSource(source, { skipUrlCheck: true });
      results.push({ source, result: r });
      process.stdout.write(`${r.layer3_status ?? "?"}  ${r.reading_value ?? "—"}\n`);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      results.push({ source, result: null, error: e.message });
    }
  }

  subheader("L3 RESULTS TABLE");
  console.log(
    pad("TITLE", 48) + pad("L3 STATUS", 10) + pad("READING", 13) + pad("SOURCE_TYPE", 26) +
    pad("AI_MATERIAL", 13) + pad("TRUST", 10) + "ROUTE"
  );
  console.log("─".repeat(140));

  for (const { source, result, error } of results) {
    if (error) {
      console.log(trunc(source.title, 48) + "  ERROR: " + error);
      continue;
    }
    const r = result;
    console.log(
      trunc(r.title, 48) +
      pad(r.layer3_status, 10) +
      pad(r.reading_value, 13) +
      pad(r.source_type, 26) +
      pad(r.ai_materiality, 13) +
      pad(r.trust_tier, 10) +
      (r.downstream_route || "—")
    );

    if (VERBOSE) {
      if (r.validation_summary) console.log(`    summary: ${r.validation_summary}`);
      if (r.route_reason_codes?.length) console.log(`    reason_codes: ${r.route_reason_codes.join(", ")}`);
      if (r.final_validity_reason) console.log(`    gate: ${r.final_validity_reason}`);
      if (r.layer3_status === "reject") console.log(`    REJECT REASON: ${r.final_validity_reason || r.route_reason_codes?.join(", ")}`);
      console.log();
    }
  }

  // Accuracy check summary
  const passed   = results.filter(r => r.result?.layer3_status === "pass").length;
  const reviewed = results.filter(r => r.result?.layer3_status === "review").length;
  const rejected = results.filter(r => r.result?.layer3_status === "reject").length;
  const essential  = results.filter(r => r.result?.reading_value === "essential").length;
  const recommended = results.filter(r => r.result?.reading_value === "recommended").length;
  const background = results.filter(r => r.result?.reading_value === "background").length;

  subheader("L3 ACCURACY CHECK");
  console.log(`  Verdicts: pass=${passed}  review=${reviewed}  reject=${rejected}  (starred sources should almost all pass)`);
  console.log(`  Reading: essential=${essential}  recommended=${recommended}  background=${background}  (starred should be essential/recommended)`);
  if (rejected > 0) {
    console.log(`\n  ⚠  REJECTED STARRED SOURCES (investigate these):`);
    for (const { source, result } of results.filter(r => r.result?.layer3_status === "reject")) {
      console.log(`     - ${source.title}`);
      console.log(`       reason: ${result?.final_validity_reason || result?.route_reason_codes?.join(", ") || "unknown"}`);
    }
  }
  if (background > 0) {
    console.log(`\n  ⚠  BACKGROUND-READING STARRED SOURCES (may indicate weak prompt judgment):`);
    for (const { source, result } of results.filter(r => r.result?.reading_value === "background")) {
      console.log(`     - ${source.title}  (${result?.source_type})`);
    }
  }

  // Persist
  if (PERSIST) {
    subheader("L3 PERSIST");
    let ok = 0, fail = 0;
    for (const { source, result } of results) {
      if (!result) continue;
      const patch = {
        validation_status:    result.validation_status || result.layer3_status,
        layer3_status:        result.layer3_status,
        downstream_route:     result.downstream_route,
        source_type:          result.source_type || source.source_type,
        ai_specificity_score: result.ai_specificity_score ?? null,
        relevance_tier:       result.relevance_tier ?? null,
        ai_threat_focus:      result.ai_threat_focus ?? null,
        validation_summary:   result.validation_summary ?? null,
        reading_value:        result.reading_value ?? null,
        ai_materiality:       result.ai_materiality ?? null,
        boundary_rationale:   result.boundary_rationale ?? null,
        trust_tier:           result.trust_tier ?? source.trust_tier,
        publisher_class:      result.publisher_class ?? null,
      };
      const { error } = await sb.from("sources").update(patch).eq("id", source.id);
      if (error) { console.log(`  ✗ ${source.id}: ${error.message}`); fail++; }
      else { ok++; }
    }
    console.log(`  Persisted: ${ok} ok  ${fail} failed`);
  } else {
    console.log(`\n  (dry-run — add --persist to write to DB)`);
  }

  // Store for chained phases
  l3Results = Object.fromEntries(results.map(r => [r.source.id, r]));
}

// ── Layer 4: Understanding / Classification ────────────────────────────────────

let l4Results = null; // keyed by source.id

if (PHASES_TO_RUN.includes("4")) {
  const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
  const { deterministicMaturity } = await import("../lib/pipeline/scoring/maturityLevel.js");

  header("LAYER 4 — UNDERSTANDING / CLASSIFICATION");

  // Use in-memory L3 results if we just ran L3, otherwise use DB state
  const l4Inputs = sources.filter(s => {
    if (l3Results) {
      // Only process L3 passes
      return l3Results[s.id]?.result?.layer3_status === "pass";
    }
    // Exclude sources that L3 rejected (they should not proceed to L4)
    if (s.layer3_status === "reject") return false;
    // Skip if already classified unless --force
    if (!FORCE && s.layer3_status === "pass" && s.main_category && s.main_category !== "unclear_or_adjacent") {
      return false;
    }
    return true;
  }).map(s => {
    // Merge in L3 results if available
    if (l3Results?.[s.id]?.result) {
      return { ...s, ...l3Results[s.id].result };
    }
    return s;
  });

  console.log(`  Running understandSource on ${l4Inputs.length} sources...\n`);

  const results = [];
  for (const source of l4Inputs) {
    process.stdout.write(`  [L4] ${trunc(source.title, 60)}... `);
    try {
      const r = await understandSource(source, { skipLlm: false });
      results.push({ source, result: r });
      process.stdout.write(`${r.category ?? "—"}  ${r.primary_tags?.[0] ?? "—"}\n`);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      results.push({ source, result: null, error: e.message });
    }
  }

  subheader("L4 RESULTS TABLE");
  console.log(
    pad("TITLE", 45) + pad("CATEGORY", 26) + pad("PRIMARY_TAG", 16) +
    pad("FAMILY", 22) + pad("IS_DEF", 7) + "KEY_ENTITIES"
  );
  console.log("─".repeat(160));

  for (const { source, result, error } of results) {
    if (error) { console.log(trunc(source.title, 45) + "  ERROR: " + error); continue; }
    const r = result;
    const tag0 = r.primary_tags?.[0] || "—";
    const ents = (r.key_entities || []).slice(0, 3).join(", ");
    console.log(
      trunc(r.title || source.title, 45) +
      pad(r.category, 26) +
      pad(tag0, 16) +
      pad(r.source_family, 22) +
      pad(r.is_defensive ? "YES" : "no", 7) +
      ents
    );

    if (VERBOSE) {
      if (r.short_summary) console.log(`    summary: ${r.short_summary}`);
      if (r.primary_tags?.length > 1) console.log(`    all_tags: ${r.primary_tags.join(", ")}`);
      if (r.scope) console.log(`    scope: ${r.scope}`);
      // disposition: offensive=pass, adjacent=keep as reference, off_topic=truly discarded
      const disp = r.disposition || (r.keep === false ? "off_topic" : (!r.relevant ? "adjacent" : "offensive"));
      if (disp === "adjacent") console.log(`    ADJACENT (keep as reference context): unclear_or_adjacent`);
      if (disp === "off_topic") console.log(`    OFF-TOPIC (discarded): ${r.rejection_reason}`);
      console.log();
    }
  }

  // Accuracy check — distinguish adjacent (keep=true, reference context) from off_topic (discard)
  // r.keep = true for offensive + adjacent; r.relevant = true for offensive only
  const offensive = results.filter(r => r.result?.relevant === true);
  const adjacent  = results.filter(r => r.result && !r.result.relevant && r.result.keep !== false);
  const offTopic  = results.filter(r => r.result?.keep === false);
  const defensive = results.filter(r => r.result?.is_defensive);
  const unclear   = results.filter(r => r.result?.category === "unclear_or_adjacent" && r.result?.keep !== false);

  subheader("L4 ACCURACY CHECK");
  const catCounts = {};
  for (const { result: r } of results) {
    if (!r) continue;
    catCounts[r.category] = (catCounts[r.category] || 0) + 1;
  }
  console.log("  Category distribution:");
  for (const [cat, n] of Object.entries(catCounts)) {
    console.log(`    ${cat}: ${n}`);
  }
  console.log(`\n  Disposition: offensive=${offensive.length}  adjacent_context=${adjacent.length}  off_topic=${offTopic.length}`);
  if (offTopic.length) {
    console.log(`\n  ⚠  OFF-TOPIC (truly discarded by L4 — ${offTopic.length}):`);
    for (const { source, result } of offTopic) {
      console.log(`     - ${source.title}  (${result?.rejection_reason || "no reason"})`);
    }
  }
  if (adjacent.length) {
    console.log(`\n  ℹ  ADJACENT CONTEXT (kept as reference, not offensive corpus — ${adjacent.length}):`);
    for (const { source } of adjacent) {
      console.log(`     - ${source.title}`);
    }
  }
  if (defensive.length) {
    console.log(`\n  ⚠  CLASSIFIED AS DEFENSIVE (${defensive.length}) — check if correct:`);
    for (const { source } of defensive) {
      console.log(`     - ${source.title}`);
    }
  }
  if (unclear.length && unclear.length > adjacent.length) {
    console.log(`\n  ⚠  UNCLEAR/ADJACENT non-adjacent (${unclear.length - adjacent.length}) — check classification:`);
  }

  // Family distribution (critical for L5 routing)
  const familyCounts = {};
  for (const { result: r } of results) {
    if (!r) continue;
    familyCounts[r.source_family || "unknown"] = (familyCounts[r.source_family || "unknown"] || 0) + 1;
  }
  console.log("\n  Source-family distribution (determines L5 extractor):");
  for (const [fam, n] of Object.entries(familyCounts)) {
    console.log(`    ${fam}: ${n}`);
  }

  // Persist
  if (PERSIST) {
    subheader("L4 PERSIST");
    const now = new Date().toISOString();
    let ok = 0, fail = 0;
    for (const { source, result: r } of results) {
      if (!r) continue;
      const origIntel = source.intelligence || {};
      const maturity  = deterministicMaturity(r);
      const isAdjacent = r.disposition === "adjacent";
      const row = {
        id:            source.id,
        main_category: r.category,
        tags:          isAdjacent
          ? [...new Set([...(r.primary_tags || []), "adjacent_context"])]
          : (r.primary_tags || []),
        source_type:   r.source_type,
        trust_tier:    r.trust_tier,
        short_summary: r.short_summary || null,
        validation_status: "pass",
        layer3_status: "pass",
        relevance_tier: isAdjacent ? "adjacent" : "core",
        ai_specificity_score: isAdjacent ? 40 : 80,
        source_family: r.source_family || null,
        intelligence: {
          ...origIntel,
          is_defensive:         r.is_defensive || false,
          defended_category:    r.defended_category || null,
          defensive_techniques: r.defensive_techniques || [],
          key_entities:         r.key_entities || [],
          source_family:        r.source_family || null,
          maturity_level:       maturity.level,
          maturity_confidence:  maturity.confidence,
          maturity_reason:      maturity.reason,
          maturity_at:          now,
        },
      };
      const { error } = await sb.from("sources").upsert(row, { onConflict: "id", ignoreDuplicates: false });
      if (error) { console.log(`  ✗ ${source.id}: ${error.message}`); fail++; }
      else { ok++; }
    }
    console.log(`  Persisted: ${ok} ok  ${fail} failed`);
  } else {
    console.log(`\n  (dry-run — add --persist to write to DB)`);
  }

  l4Results = Object.fromEntries(results.map(r => [r.source.id, r]));
}

// ── Layer 5: Evidence Extraction ───────────────────────────────────────────────

if (PHASES_TO_RUN.includes("5")) {
  const { extractEvidence }     = await import("../lib/pipeline/extraction/extractEvidence.js");
  const { saveSourceEvidence, contentHashOf } = await import("../lib/storage/evidenceStore.js");

  header("LAYER 5 — EVIDENCE EXTRACTION");

  // Probe evidence table
  const probe = await sb.from("evidence").select("id").limit(1);
  if (probe.error) {
    console.error(`Evidence table not available: ${probe.error.message}\nApply migration 011_evidence_table.sql first.`);
    process.exit(1);
  }

  // Build L5 input: use in-memory L4 results if available, else re-load from DB
  const l5Inputs = [];
  for (const source of sources) {
    let s = source;

    // Merge in L4 result if we just ran it
    if (l4Results?.[source.id]?.result) {
      const r = l4Results[source.id].result;
      s = {
        ...source,
        category:      r.category,
        main_category: r.category,
        source_family: r.source_family,
        primary_tags:  r.primary_tags,
        tags:          r.primary_tags,
        trust_tier:    r.trust_tier,
        source_type:   r.source_type,
        key_entities:  r.key_entities,
        short_summary: r.short_summary,
      };
    } else {
      // Use DB state — map tags column to primary_tags so extraction prompts get proper tag context
      const dbTags = source.tags || [];
      s = {
        ...source,
        category:      source.main_category,
        source_family: source.source_family || source.intelligence?.source_family,
        primary_tags:  dbTags,
        primary_tag:   dbTags[0] || null,  // singular, used by academicRelevanceGate
      };
    }

    // Skip if category not in the 4 offensive domains
    const CATS = new Set(["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"]);
    if (!CATS.has(s.category)) {
      console.log(`  [skip] ${trunc(s.title, 60)} — category="${s.category || "null"}"`);
      continue;
    }

    l5Inputs.push(s);
  }

  console.log(`\n  Running extractEvidence on ${l5Inputs.length} eligible sources...\n`);

  for (const source of l5Inputs) {
    process.stdout.write(`  [L5] ${trunc(source.title, 60)}... `);
    let items = [];
    try {
      items = await extractEvidence(source, {});
      process.stdout.write(`${items.length} items\n`);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      continue;
    }

    if (items.length === 0) {
      console.log(`       (no evidence extracted — check eligibility gate or source_family routing)`);
      continue;
    }

    // Print evidence summary
    const highSpec  = items.filter(i => i.specificity === "high").length;
    const grounded  = items.filter(i => i.quote_grounded).length;
    const withNums  = items.filter(i => i.numbers?.length > 0).length;
    console.log(`       specificity: high=${highSpec}  grounded_quotes=${grounded}  with_numbers=${withNums}  family=${source.source_family || "—"}`);

    if (VERBOSE) {
      subheader(`Evidence items — ${source.title}`);
      for (const [i, item] of items.entries()) {
        console.log(`  [${i + 1}] type=${item.evidence_type}  specificity=${item.specificity}  grounded=${item.quote_grounded}`);
        console.log(`      fact: ${item.fact}`);
        if (item.quote) console.log(`      quote: "${item.quote}"`);
        if (item.technique_tags?.length) console.log(`      tags: ${item.technique_tags.join(", ")}`);
        if (item.numbers?.length) console.log(`      numbers: ${item.numbers.map(n => `${n.value}${n.unit ? " " + n.unit : ""}`).join(", ")}`);
        if (item.research_metadata) {
          const m = item.research_metadata;
          console.log(`      research: maturity=${m.maturity}  repro=${m.reproducibility}${m.boundary_conditions ? `  boundary: ${m.boundary_conditions.slice(0, 80)}` : ""}`);
        }
        if (item.campaign_metadata) {
          const c = item.campaign_metadata;
          console.log(`      campaign: attribution=${c.attribution_confidence}  name=${c.campaign_name || "—"}`);
        }
        console.log();
      }
    } else {
      // Print top 2 items in compact form
      for (const item of items.slice(0, 2)) {
        console.log(`       [${item.evidence_type}] ${trunc(item.fact, 100)}`);
        if (item.technique_tags?.length) console.log(`              tags: ${item.technique_tags.join(", ")}`);
      }
      if (items.length > 2) console.log(`       … and ${items.length - 2} more`);
    }

    if (PERSIST) {
      const textHash = contentHashOf(source.full_text || source.clean_text || "");
      const { error } = await saveSourceEvidence(sb, source.id, textHash, items);
      if (error) {
        console.log(`       ✗ persist failed: ${JSON.stringify(error)}`);
      } else {
        console.log(`       ✓ ${items.length} items saved to evidence table`);
      }
    }
  }

  if (!PERSIST) {
    console.log(`\n  (dry-run — add --persist to write to evidence table)`);
  }

  // Quality summary
  subheader("L5 ACCURACY CHECK");
  console.log("  For each source above, verify:");
  console.log("  1. fact   — is it a real, specific claim from the article (not a title paraphrase)?");
  console.log("  2. quote  — is quote_grounded=true? Can you find the text in full_text?");
  console.log("  3. tags   — are technique_tags valid taxonomy IDs (LLM01, TAI03 etc.) that match the content?");
  console.log("  4. type   — does evidence_type match (lab paper → research_finding, real incident → incident)?");
  console.log("  5. count  — starred academic papers should yield ≥3 items; threat intel ≥2.");
  console.log("\n  Fix prompts in lib/prompts/extraction/extract-evidence-<family>.md based on findings.");
}

// ── DB Verification Queries ────────────────────────────────────────────────────

header("DB VERIFICATION QUERIES");
console.log("  Run these in Supabase SQL editor to verify persisted state:\n");

const ids = sources.map(s => `'${s.id}'`).join(",");

if (PHASES_TO_RUN.includes("3") || PHASE === "none") {
  console.log("  -- After L3:");
  console.log(`  SELECT id, title, layer3_status, reading_value, source_type, downstream_route, ai_materiality`);
  console.log(`  FROM sources WHERE id IN (${ids});`);
  console.log();
}

if (PHASES_TO_RUN.includes("4")) {
  console.log("  -- After L4:");
  console.log(`  SELECT id, title, main_category, tags, source_family, intelligence->>'is_defensive' as is_defensive`);
  console.log(`  FROM sources WHERE id IN (${ids});`);
  console.log();
}

if (PHASES_TO_RUN.includes("5")) {
  console.log("  -- After L5:");
  console.log(`  SELECT s.title, COUNT(e.id) as items,`);
  console.log(`         SUM(CASE WHEN e.specificity = 'high' THEN 1 ELSE 0 END) as high_spec,`);
  console.log(`         SUM(CASE WHEN e.quote_grounded THEN 1 ELSE 0 END) as grounded`);
  console.log(`  FROM sources s JOIN evidence e ON e.source_id = s.id`);
  console.log(`  WHERE s.id IN (${ids})`);
  console.log(`  GROUP BY s.id, s.title ORDER BY items DESC;`);
  console.log();
}

console.log(`\n${HR}\n  Done.\n${HR}\n`);
