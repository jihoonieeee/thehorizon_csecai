#!/usr/bin/env node
/**
 * scoreImportance.js — source-importance tiering: batch report + full-corpus recompute.
 *
 * The facets and rules live in lib/pipeline/importance.js (single source of truth,
 * shared with the ingest write-back). This script is just the harness: it pulls the
 * corpus, tiers each source via computeImportance(), prints the distribution + a
 * confidence cross-check + examples, and — with --write — persists the tier into
 * intelligence.importance. Run --write locally whenever RULES_VERSION changes to
 * re-tier the whole corpus (deterministic, no LLM, so it's cheap).
 *
 * DESIGN PRINCIPLES (enforced in lib/pipeline/importance.js):
 *   - No numeric scores. No weights. No summation. No magic thresholds.
 *   - Importance is a TIER from an ordered decision list over categorical facets.
 *   - Rank by SUBSTANCE (reality); provenance is a confidence annotation, not a driver.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { REALITY_BY_TYPE, computeImportance, RULES_VERSION } from "../lib/pipeline/importance.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const WRITE = process.argv.includes("--write");

const TIER_ORDER = ["realized", "proven", "research", "reference", "noise"];
const PROV_ORDER = ["authoritative", "established", "general", "weak"];

async function main() {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await sb.from("sources")
      .select("id,title,publisher,trust_tier,source_type,main_category,tags,short_summary,summary,intelligence")
      .order("id").range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const unmapped = new Set();
  const rows = all.map((s) => {
    if (s.source_type && !(s.source_type in REALITY_BY_TYPE)) unmapped.add(s.source_type);
    return { s, imp: computeImportance(s) };
  });

  const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
  for (const r of rows) byTier[r.imp.tier].push(r);

  console.log(`\n═══ IMPORTANCE TIERS (${RULES_VERSION}) — ${all.length} sources ═══\n`);
  for (const t of TIER_ORDER) {
    const pct = ((byTier[t].length / all.length) * 100).toFixed(1);
    console.log(`  ${t.padEnd(11)} ${String(byTier[t].length).padStart(4)}  (${pct}%)`);
  }

  console.log(`\n─── tier × provenance (confidence check — substance should drive the tier) ───`);
  console.log("  " + "tier".padEnd(11) + PROV_ORDER.map((p) => p.slice(0, 7).padStart(9)).join(""));
  for (const t of TIER_ORDER) {
    const counts = PROV_ORDER.map((p) => byTier[t].filter((r) => r.imp.provenance === p).length);
    console.log("  " + t.padEnd(11) + counts.map((n) => String(n).padStart(9)).join(""));
  }

  console.log(`\n─── tier × category ───`);
  const cats = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats", "unclear_or_adjacent"];
  console.log("  " + "tier".padEnd(11) + cats.map((c) => c.split("_")[0].slice(0, 6).padStart(8)).join(""));
  for (const t of TIER_ORDER) {
    const counts = cats.map((c) => byTier[t].filter((r) => r.s.main_category === c).length);
    console.log("  " + t.padEnd(11) + counts.map((n) => String(n).padStart(8)).join(""));
  }

  console.log(`\n─── examples per tier (title · reality/posture · provenance · publisher) ───`);
  for (const t of TIER_ORDER) {
    console.log(`\n[${t.toUpperCase()}]`);
    for (const r of byTier[t].slice(0, 5)) {
      console.log(`  · ${(r.s.title || "").slice(0, 76)}`);
      console.log(`      ${r.imp.reality}/${r.imp.posture} · ${r.imp.provenance} · ${r.s.publisher || "?"}`);
    }
  }

  if (unmapped.size) console.log(`\n⚠ unmapped source_type (→ 'other'): ${[...unmapped].join(", ")}`);

  if (WRITE) {
    const now = new Date().toISOString();
    let done = 0;
    const CONC = 40;
    console.log(`\nPersisting intelligence.importance (${RULES_VERSION}) …`);
    for (let i = 0; i < rows.length; i += CONC) {
      await Promise.all(rows.slice(i, i + CONC).map(async (r) => {
        const intel = { ...(r.s.intelligence || {}) };
        intel.importance = { ...r.imp, scored_at: now };   // merge — never clobber mechanism_classification
        const { error } = await sb.from("sources").update({ intelligence: intel }).eq("id", r.s.id);
        if (error) throw error;
      }));
      done += Math.min(CONC, rows.length - i);
      process.stdout.write(`\r  ${done}/${rows.length}`);
    }
    console.log(`\n  done — ${rows.length} sources tiered.`);
  } else {
    console.log(`\n(read-only — pass --write to persist intelligence.importance)`);
  }
  console.log();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
