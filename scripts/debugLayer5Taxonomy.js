/**
 * Layer 5 Taxonomy Debug Script
 *
 * Loads recent cleaned sources from Supabase, runs Layer 5 taxonomy enrichment,
 * and prints structured output for inspection. Optionally saves raw output to
 * outputs/debug/layer5_taxonomy_outputs.json.
 *
 * Usage:
 *   node scripts/debugLayer5Taxonomy.js [options]
 *
 * Options:
 *   --limit <n>          Number of sources to sample (default: 20)
 *   --days <n>           Sources from last N days (default: 30)
 *   --trust <tier>       Filter by trust_tier (primary|high|medium|curated)
 *   --type <type>        Filter by current source_type in DB
 *   --category <cat>     Filter by current main_category in DB
 *   --no-llm             Force deterministic fallback (faster, no API calls)
 *   --save               Save full output to outputs/debug/layer5_taxonomy_outputs.json
 *   --json               Print full JSON output to stdout instead of summary table
 *   --re-enrich          Re-run even on sources already stamped with taxonomy-v5.0
 *
 * Examples:
 *   node scripts/debugLayer5Taxonomy.js
 *   node scripts/debugLayer5Taxonomy.js --limit 50 --trust primary --save
 *   node scripts/debugLayer5Taxonomy.js --no-llm --category llm_threats
 *   node scripts/debugLayer5Taxonomy.js --json | head -200
 */

import "dotenv/config";
import { createClient }     from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname }   from "path";
import { fileURLToPath }   from "url";
import { understandSource, TAXONOMY_VERSION } from "../lib/pipeline/understand/understandSource.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (name, def) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; };
const hasFlag = (name) => args.includes(name);

const LIMIT      = parseInt(getArg("--limit",   "20"), 10);
const DAYS       = parseInt(getArg("--days",    "30"), 10);
const TRUST      = getArg("--trust",    null);
const TYPE       = getArg("--type",     null);
const CATEGORY   = getArg("--category", null);
const NO_LLM     = hasFlag("--no-llm");
const SAVE       = hasFlag("--save");
const JSON_OUT   = hasFlag("--json");
const RE_ENRICH  = hasFlag("--re-enrich");

// ── Supabase ──────────────────────────────────────────────────────────────────

async function loadSources() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  let query = sb
    .from("sources")
    .select(
      "id,title,url,publisher,date_published,source_type,main_category,trust_tier," +
      "tags,full_text,clean_text,summary,intelligence,understand_version,taxonomy_version," +
      "claim_extraction_status,layer3_status,created_at"
    )
    .gte("created_at", since)
    .not("layer3_status", "eq", "reject")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (TRUST)    query = query.eq("trust_tier",    TRUST);
  if (TYPE)     query = query.eq("source_type",   TYPE);
  if (CATEGORY) query = query.eq("main_category", CATEGORY);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function pad(str, width) {
  const s = String(str ?? "").slice(0, width);
  return s.padEnd(width);
}

function truncate(str, max) {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function confidenceIcon(conf) {
  if (conf === "high")   return "●";
  if (conf === "medium") return "◑";
  return "○";
}

function printSourceResult(source) {
  const u = source.understanding || {};
  const llmBadge = u.llm_used ? "[LLM]" : "[det]";
  const skipped  = source.taxonomy_version === TAXONOMY_VERSION && !RE_ENRICH;

  console.log("\n" + "─".repeat(90));
  console.log(`${llmBadge} ${truncate(source.title, 80)}`);
  console.log(`  Publisher : ${source.publisher || "—"}   Date: ${source.date_published || "—"}`);
  console.log(`  source_type: ${source.source_type || "—"} (${u.source_type_confidence || "—"}) — ${truncate(u.source_type_reason || "", 60)}`);

  if (skipped) {
    console.log("  [skipped — already taxonomy-v5.0; use --re-enrich to force]");
    return;
  }

  // Summary
  if (u.source_summary) {
    console.log(`  summary  : ${truncate(u.source_summary, 120)}`);
  }
  if (u.primary_subject) {
    console.log(`  subject  : ${u.primary_subject}`);
  }

  // Claims
  if (u.main_claims?.length) {
    console.log(`  claims (${u.main_claims.length}):`);
    for (const c of u.main_claims) {
      console.log(`    • ${truncate(c, 100)}`);
    }
  }

  // Entities
  if (u.key_entities?.length) {
    console.log(`  entities : ${u.key_entities.slice(0, 8).join(", ")}`);
  }

  // Numbers
  if (u.important_numbers?.length) {
    console.log(`  numbers  : ${u.important_numbers.join(" | ")}`);
  }

  // Primary threat tags (Validated AI Threat Taxonomy)
  console.log(`  domain   : ${u.primary_domain || "(none)"}  | validation: ${u.validation_status || "?"}`);
  if (u.primary_threat_tags?.length) {
    console.log(`  tags (${u.primary_threat_tags.length}):`);
    for (const t of u.primary_threat_tags) {
      console.log(
        `    ${confidenceIcon(t.confidence)} ${t.tag} [${t.domain}/${t.validation_status}]` +
        `  — ${truncate(t.supporting_quote || "", 70)}`
      );
    }
  } else {
    console.log("  tags     : (none)");
  }
  if (u.secondary_dimensions?.length) {
    console.log(`  secondary: ${u.secondary_dimensions.join(", ")}`);
  }

  // Category candidates
  if (u.category_candidates?.length) {
    console.log(`  candidates:`);
    for (const c of u.category_candidates) {
      const tags = c.supporting_tags?.join(", ") || "—";
      console.log(
        `    ${confidenceIcon(c.confidence)} ${c.category}  [${tags}]` +
        `  — ${truncate(c.reason || "", 60)}`
      );
    }
  } else {
    console.log("  candidates: (none — unclear_or_adjacent)");
  }
}

// ── Summary statistics ────────────────────────────────────────────────────────

function printSummary(results, originalSources) {
  const llmUsed  = results.filter((s) => s.understanding?.llm_used).length;
  const fallback = results.filter((s) => !s.understanding?.llm_used).length;
  const alreadyDone = originalSources.filter(
    (s) => s.taxonomy_version === TAXONOMY_VERSION
  ).length;

  // source_type distribution (after Layer 5)
  const typeDist = {};
  for (const s of results) {
    const t = s.source_type || "unknown";
    typeDist[t] = (typeDist[t] || 0) + 1;
  }

  // Category candidate distribution
  const catDist = {};
  for (const s of results) {
    const candidates = s.understanding?.category_candidates || [];
    if (candidates.length === 0) {
      catDist["(no candidate)"] = (catDist["(no candidate)"] || 0) + 1;
    } else {
      const top = candidates[0];
      catDist[top.category] = (catDist[top.category] || 0) + 1;
    }
  }

  // Primary threat tag frequency
  const tagDist = {};
  for (const s of results) {
    for (const t of s.understanding?.primary_threat_tags || []) {
      tagDist[t.tag] = (tagDist[t.tag] || 0) + 1;
    }
  }

  console.log("\n" + "═".repeat(90));
  console.log("LAYER 5 TAXONOMY DEBUG SUMMARY");
  console.log("═".repeat(90));
  console.log(`Sources loaded:    ${originalSources.length}`);
  console.log(`Already taxonomy-v5.0: ${alreadyDone} ${RE_ENRICH ? "(re-enriched)" : "(skipped)"}`);
  console.log(`LLM enriched:      ${llmUsed}`);
  console.log(`Fallback (no LLM): ${fallback}`);

  console.log("\nSource type distribution (after Layer 5):");
  for (const [t, n] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  }

  console.log("\nTop category candidate:");
  for (const [c, n] of Object.entries(catDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${c}`);
  }

  if (Object.keys(tagDist).length > 0) {
    console.log("\nFramework tag frequency (top 10):");
    for (const [tag, n] of Object.entries(tagDist).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${String(n).padStart(4)}  ${tag}`);
    }
  }
}

// ── Save output ───────────────────────────────────────────────────────────────

function saveOutput(results) {
  const outDir = join(__dirname, "..", "outputs", "debug");
  mkdirSync(outDir, { recursive: true });

  const outPath = join(outDir, "layer5_taxonomy_outputs.json");
  const payload = results.map((s) => ({
    id:           s.id,
    title:        s.title,
    url:          s.url,
    publisher:    s.publisher,
    date_published: s.date_published,
    source_type:  s.source_type,
    taxonomy_version: s.taxonomy_version,
    understanding: s.understanding,
  }));

  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nSaved ${payload.length} results → ${outPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Layer 5 Taxonomy Debug  |  limit=${LIMIT}  days=${DAYS}` +
    (TRUST    ? `  trust=${TRUST}`    : "") +
    (TYPE     ? `  type=${TYPE}`      : "") +
    (CATEGORY ? `  category=${CATEGORY}` : "") +
    (NO_LLM   ? "  [no-llm]"         : "") +
    (RE_ENRICH? "  [re-enrich]"       : "")
  );

  let sources;
  try {
    sources = await loadSources();
  } catch (err) {
    console.error("Failed to load sources from Supabase:", err.message);
    process.exit(1);
  }

  if (sources.length === 0) {
    console.log("No sources found for the given filters.");
    return;
  }

  console.log(`Loaded ${sources.length} sources. Running Layer 5...`);

  // Optionally force re-enrichment by clearing the stamp
  const toProcess = RE_ENRICH
    ? sources.map((s) => ({ ...s, taxonomy_version: null, understand_version: null }))
    : sources;

  const results = [];
  for (let i = 0; i < toProcess.length; i++) {
    process.stdout.write(`  [${i + 1}/${toProcess.length}] `);
    try {
      const enriched = await understandSource(toProcess[i], { skipLlm: NO_LLM });
      results.push(enriched);
    } catch (err) {
      console.error(`\n  ERROR on source ${toProcess[i].id}: ${err.message}`);
      results.push(toProcess[i]);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(results.map((s) => ({
      id:           s.id,
      title:        s.title,
      source_type:  s.source_type,
      taxonomy_version: s.taxonomy_version,
      understanding: s.understanding,
    })), null, 2));
  } else {
    for (const s of results) {
      printSourceResult(s);
    }
    printSummary(results, sources);
  }

  if (SAVE) {
    saveOutput(results);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
