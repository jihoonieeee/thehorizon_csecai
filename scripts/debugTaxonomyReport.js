#!/usr/bin/env node
/**
 * debugTaxonomyReport.js — read-only taxonomy diagnostics (no API, no writes).
 *
 * Per-source: original_category, tags, mechanism fields, map-vs-LLM conflict.
 * Per-tag:    kept/defense/benchmark/conflict counts + missing_landmark_topics.
 * Also lists the map-vs-LLM conflict rows (the audit view) and the targeted
 * search directives for landmark gaps.
 *
 * Usage:
 *   node scripts/debugTaxonomyReport.js                 # summary
 *   node scripts/debugTaxonomyReport.js --conflicts     # only map/LLM conflicts
 *   node scripts/debugTaxonomyReport.js --gaps          # landmark gaps + directives
 *   node scripts/debugTaxonomyReport.js --tag=LLM01_prompt_injection
 *   node scripts/debugTaxonomyReport.js --json
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { LANDMARK_TOPICS, detectAllLandmarkGaps, buildSearchDirectives } from "../lib/pipeline/landmarkGaps.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val  = (n) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : null; };

const isDomainTag = (t) => /^(TAI|LLM|ASI|AE)\d/.test(t);

async function fetchAll() {
  const all = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id,title,short_summary,tags,main_category,source_type,trust_tier,intelligence")
      .range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; all.push(...data); if (data.length < 1000) break;
  }
  return all;
}

function sourceRow(s) {
  const mc = s.intelligence?.mechanism_classification || {};
  return {
    id: String(s.id).slice(0, 12),
    title: (s.title || "").slice(0, 70),
    original_category: s.main_category,
    tags: (s.tags || []).filter(isDomainTag),
    primary_security_property: mc.primary_security_property ?? null,
    primary_exploit_mechanism: mc.primary_exploit_mechanism ?? null,
    primary_consequence: mc.primary_consequence ?? null,
    evidence_role: mc.evidence_role ?? null,
    mapped_tag: mc.mapped_tag ?? null,
    llm_suggestion: mc.llm_suggestion ?? null,
    conflict: mc.conflict === true,
    is_defensive: s.intelligence?.is_defensive === true || (s.tags || []).includes("defensive"),
    rationale: mc.rationale ?? null,
  };
}

async function main() {
  const all = await fetchAll();
  const rows = all.map(sourceRow);
  const gaps = detectAllLandmarkGaps(all);

  // ── Conflicts view ────────────────────────────────────────────────────────────
  if (flag("conflicts")) {
    const conflicts = rows.filter(r => r.conflict);
    console.log(`\nMAP vs LLM CONFLICTS: ${conflicts.length}\n${"─".repeat(60)}`);
    for (const r of conflicts) {
      console.log(`  ${r.mapped_tag}  (LLM said ${r.llm_suggestion})  ${r.title}`);
      if (r.rationale) console.log(`     ↳ ${r.rationale}`);
    }
    if (flag("json")) console.log(JSON.stringify(conflicts, null, 2));
    return;
  }

  // ── Landmark gaps + directives ─────────────────────────────────────────────────
  if (flag("gaps")) {
    const directives = buildSearchDirectives(gaps);
    console.log(`\nLANDMARK GAPS (missing topics) + TARGETED DIRECTIVES\n${"─".repeat(60)}`);
    for (const [tag, missing] of Object.entries(gaps)) {
      if (missing.length) console.log(`  ${tag}: ${missing.length} missing → ${missing.join(", ")}`);
    }
    console.log(`\n${directives.length} search directives (deduped):`);
    for (const d of directives.slice(0, flag("json") ? directives.length : 40)) {
      console.log(`  [${d.provider}] ${d.query}   → ${d.target_source_types.join("/")}`);
    }
    if (flag("json")) console.log(JSON.stringify(directives, null, 2));
    return;
  }

  // ── Single-tag drilldown ────────────────────────────────────────────────────────
  const tagFilter = val("tag");
  if (tagFilter) {
    const tagRows = rows.filter(r => r.tags.includes(tagFilter));
    console.log(`\n${tagFilter}: ${tagRows.length} sources\n${"─".repeat(60)}`);
    for (const r of tagRows.slice(0, 60)) {
      console.log(`  ${r.mapped_tag || "(no mech)"} ${r.conflict ? "⚠conflict" : ""} ${r.is_defensive ? "🛡" : ""}  ${r.title}`);
    }
    console.log(`\n  missing_landmark_topics: ${(gaps[tagFilter] || []).join(", ") || "none"}`);
    return;
  }

  // ── Per-tag metrics (default) ────────────────────────────────────────────────────
  const metrics = {};
  for (const tag of Object.keys(LANDMARK_TOPICS)) {
    metrics[tag] = { kept_count: 0, defense_count: 0, benchmark_count: 0, conflict_count: 0, missing_landmark_topics: gaps[tag] || [] };
  }
  const catCounts = {};
  let withMech = 0, conflicts = 0;
  for (const r of rows) {
    catCounts[r.original_category] = (catCounts[r.original_category] || 0) + 1;
    if (r.primary_exploit_mechanism) withMech++;
    if (r.conflict) conflicts++;
    for (const tag of r.tags) {
      if (!metrics[tag]) continue;
      metrics[tag].kept_count++;
      if (r.is_defensive) metrics[tag].defense_count++;
      if (r.evidence_role === "benchmark") metrics[tag].benchmark_count++;
      if (r.conflict) metrics[tag].conflict_count++;
    }
  }

  console.log(`\n═══ TAXONOMY REPORT ═══  ${all.length} sources`);
  console.log(`  with mechanism_classification: ${withMech}  |  map/LLM conflicts: ${conflicts}\n`);
  console.log("  category distribution:");
  for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${c}`);

  console.log(`\n  per-tag  (count / def / bench / conflict / #missing-landmarks):`);
  for (const [tag, m] of Object.entries(metrics)) {
    if (m.kept_count === 0 && m.missing_landmark_topics.length === 0) continue;
    console.log(`    ${tag.padEnd(34)} ${String(m.kept_count).padStart(4)} /${String(m.defense_count).padStart(3)} /${String(m.benchmark_count).padStart(3)} /${String(m.conflict_count).padStart(3)} /${String(m.missing_landmark_topics.length).padStart(3)}`);
  }

  const totalMissing = Object.values(gaps).reduce((a, g) => a + g.length, 0);
  console.log(`\n  total missing landmark topics: ${totalMissing}  (run --gaps for targeted directives)`);
  if (flag("json")) console.log("\n" + JSON.stringify({ metrics, catCounts, gaps }, null, 2));
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
