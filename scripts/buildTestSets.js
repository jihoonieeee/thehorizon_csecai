#!/usr/bin/env node
/**
 * buildTestSets.js — Curated test set builder
 *
 * Queries Supabase for past-quarter sources across all four offensive threat
 * categories, runs LLM qualitative evaluation on each candidate, then assembles
 * three curated test sets (operational, balanced, emerging-signals) with ~50
 * sources each and at least 10 per category.
 *
 * Usage:
 *   node scripts/buildTestSets.js [--days N] [--limit N] [--no-llm] [--eval-cache <path>]
 *
 * Options:
 *   --days <n>         Candidate window in days (default: 90)
 *   --limit <n>        Max candidates per category (default: 150)
 *   --no-llm           Skip LLM evaluation; use heuristic rules only
 *   --eval-cache <p>   Load/save LLM evaluations from JSON cache to avoid re-running
 *
 * Outputs:
 *   data/test_sets/horizon_q_testset_operational.json
 *   data/test_sets/horizon_q_testset_balanced.json
 *   data/test_sets/horizon_q_testset_emerging.json
 *   docs/test_sets/horizon_q_testset_summary.md
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";
import { loadPrompt } from "../lib/prompts/promptLoader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag = (f) => args.includes(f);

const DAYS       = parseInt(getArg("--days",  "90"), 10);
const LIMIT      = parseInt(getArg("--limit", "150"), 10);
const NO_LLM     = hasFlag("--no-llm");
const EVAL_CACHE = getArg("--eval-cache", path.join(ROOT, "data/test_sets/_eval_cache.json"));

const OFFENSIVE_CATS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const CAT_LABEL = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const OPERATIONAL_EVIDENCE_TYPES = new Set([
  "operational_incident",
  "exploited_vulnerability",
  "disclosed_vulnerability",
  "threat_intelligence",
  "adversary_adoption",
]);

const EMERGING_EVIDENCE_TYPES = new Set([
  "research_demonstration",
  "benchmark",
  "capability_demonstration",
  "adversary_adoption",
  "commentary",
]);

// ── Supabase ──────────────────────────────────────────────────────────────────

function makeSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Source query ──────────────────────────────────────────────────────────────

async function fetchCandidates(supabase) {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const extended = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

  let all = [];

  for (const cat of OFFENSIVE_CATS) {
    // Primary window: past N days
    const { data: recent, error: e1 } = await supabase
      .from("sources")
      .select([
        "id", "title", "url", "publisher", "date_published",
        "main_category", "source_type", "trust_tier",
        "validation_status", "short_summary", "summary",
        "evidence_strength_hint", "publisher_class", "evidence_role",
        "tags", "ai_specificity_score",
      ].join(","))
      .eq("main_category", cat)
      .eq("validation_status", "pass")
      .gte("date_published", since)
      .order("date_published", { ascending: false })
      .limit(LIMIT);

    if (e1) { console.error(`DB error (${cat} recent):`, e1.message); process.exit(1); }
    const recentRows = recent || [];

    // If category is thin, supplement with older high-trust sources
    let supplementRows = [];
    if (recentRows.length < 20) {
      const { data: older, error: e2 } = await supabase
        .from("sources")
        .select([
          "id", "title", "url", "publisher", "date_published",
          "main_category", "source_type", "trust_tier",
          "validation_status", "short_summary", "summary",
          "evidence_strength_hint", "publisher_class", "evidence_role",
          "tags", "ai_specificity_score",
        ].join(","))
        .eq("main_category", cat)
        .eq("validation_status", "pass")
        .in("trust_tier", ["primary", "high"])
        .gte("date_published", extended)
        .lt("date_published", since)
        .order("date_published", { ascending: false })
        .limit(40);

      if (!e2) supplementRows = older || [];
    }

    console.log(`  ${CAT_LABEL[cat]}: ${recentRows.length} recent${supplementRows.length ? ` + ${supplementRows.length} supplement` : ""}`);
    all.push(...recentRows, ...supplementRows);
  }

  // Deduplicate by id
  const seen = new Set();
  const deduped = all.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  console.log(`  Total candidates: ${deduped.length}\n`);
  return deduped;
}

// ── LLM evaluation ────────────────────────────────────────────────────────────

const EVAL_SCHEMA = {
  type: "object",
  properties: {
    evaluations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:                   { type: "string" },
          category_fit:         { type: "string", enum: ["strong", "weak", "misplaced"] },
          evidence_type:        { type: "string", enum: [
            "operational_incident", "exploited_vulnerability", "disclosed_vulnerability",
            "threat_intelligence", "adversary_adoption",
            "defensive_analysis", "research_demonstration", "benchmark",
            "capability_demonstration", "commentary",
          ]},
          analytical_usefulness: { type: "string", enum: ["high", "usable", "context_only"] },
          source_reliability:    { type: "string", enum: ["primary", "reputable_secondary", "weak_secondary", "unclear"] },
          time_relevance:        { type: "string", enum: ["within_past_quarter", "older_still_relevant", "stale"] },
          slide_usefulness:      { type: "string", enum: ["strong_candidate", "supporting_candidate", "appendix_only", "exclude"] },
          selection_reason:      { type: "string" },
        },
        required: ["id","category_fit","evidence_type","analytical_usefulness","source_reliability","time_relevance","slide_usefulness","selection_reason"],
      },
    },
  },
  required: ["evaluations"],
};

const EVAL_SYSTEM = loadPrompt("scripts/eval-testset").system;

function buildEvalUserPrompt(batch) {
  const items = batch.map((s, i) => {
    const snippet = (s.short_summary || s.summary || "").slice(0, 400);
    return `[${i+1}] id=${s.id}
title: ${s.title || "(no title)"}
publisher: ${s.publisher || "unknown"} | trust_tier: ${s.trust_tier || "unknown"}
date: ${s.date_published || "unknown"} | category: ${s.main_category}
source_type: ${s.source_type || "unknown"}
summary: ${snippet || "(no summary available)"}`;
  }).join("\n\n");

  return `Evaluate the following ${batch.length} sources. Return one evaluation object per source in the evaluations array.\n\n${items}`;
}

async function evaluateBatch(batch, routedLLM) {
  const sys = EVAL_SYSTEM;
  const usr = buildEvalUserPrompt(batch);
  try {
    const { result } = await routedLLM(sys, usr, { task: "category_analysis", schema: EVAL_SCHEMA, logLabel: "TestSetEval" });
    if (result?.evaluations && Array.isArray(result.evaluations)) {
      return result.evaluations;
    }
    if (Array.isArray(result)) return result;
    console.warn("  LLM eval returned unexpected shape:", JSON.stringify(result).slice(0, 200));
    return [];
  } catch (err) {
    console.warn(`  LLM eval batch failed: ${err.message}`);
    return [];
  }
}

function heuristicEvaluate(source) {
  const tier = source.trust_tier || "unknown";
  const stype = source.source_type || "unknown";
  const date = source.date_published || "";
  const sinceMs = Date.now() - new Date(date).getTime();
  const daysAgo = sinceMs / 86400000;

  const source_reliability =
    tier === "primary"  ? "primary" :
    tier === "high"     ? "reputable_secondary" :
    tier === "medium"   ? "reputable_secondary" :
    tier === "low"      ? "weak_secondary" : "unclear";

  const time_relevance =
    daysAgo <= 90  ? "within_past_quarter" :
    daysAgo <= 180 ? "older_still_relevant" : "stale";

  const evidence_type =
    stype === "vulnerability"             ? "disclosed_vulnerability" :
    stype === "exploit_disclosure"        ? "exploited_vulnerability" :
    stype === "incident"                  ? "operational_incident" :
    stype === "threat_intelligence"       ? "threat_intelligence" :
    stype === "adversary_adoption_signal" ? "adversary_adoption" :
    stype === "research_finding"          ? "research_demonstration" :
    stype === "benchmark_evaluation"      ? "benchmark" :
    stype === "capability_demonstration"  ? "capability_demonstration" :
    stype === "defensive_capability"      ? "defensive_analysis" : "commentary";

  const operational = OPERATIONAL_EVIDENCE_TYPES.has(evidence_type);
  const highReliability = ["primary","reputable_secondary"].includes(source_reliability);

  const slide_usefulness =
    (operational && highReliability && time_relevance === "within_past_quarter") ? "strong_candidate" :
    (operational || highReliability)                                              ? "supporting_candidate" :
    "appendix_only";

  const analytical_usefulness =
    (operational && highReliability) ? "high" :
    (operational || highReliability) ? "usable" : "context_only";

  return {
    id: source.id,
    category_fit:          "strong",
    evidence_type,
    analytical_usefulness,
    source_reliability,
    time_relevance,
    slide_usefulness,
    selection_reason:      `Heuristic: ${stype} from ${tier} source, ${Math.round(daysAgo)}d ago`,
  };
}

async function runEvaluations(candidates) {
  // Load cache
  let cache = {};
  if (fs.existsSync(EVAL_CACHE)) {
    try { cache = JSON.parse(fs.readFileSync(EVAL_CACHE, "utf8")); }
    catch { cache = {}; }
  }

  const { routedLLM } = await import("../lib/llm/llmRouter.js");
  const results = {};

  // Identify what needs evaluation
  const toEval = candidates.filter(c => !cache[c.id]);
  const cached = candidates.filter(c =>  cache[c.id]);

  for (const c of cached) results[c.id] = cache[c.id];
  console.log(`  ${cached.length} from cache, ${toEval.length} to evaluate`);

  if (toEval.length === 0) return results;

  if (NO_LLM) {
    console.log("  --no-llm: using heuristic evaluation");
    for (const s of toEval) results[s.id] = heuristicEvaluate(s);
    return results;
  }

  // Batch in groups of 5
  const BATCH = 5;
  let done = 0;
  for (let i = 0; i < toEval.length; i += BATCH) {
    const batch = toEval.slice(i, i + BATCH);
    const evals = await evaluateBatch(batch, routedLLM);

    // Match by id or position
    for (const ev of evals) {
      if (ev.id && results[ev.id] === undefined) {
        results[ev.id] = ev;
        cache[ev.id]   = ev;
      }
    }

    // Fallback: heuristic for any source in the batch that didn't get an eval
    for (const s of batch) {
      if (!results[s.id]) {
        results[s.id] = heuristicEvaluate(s);
        cache[s.id]   = results[s.id];
      }
    }

    done += batch.length;
    process.stdout.write(`    evaluated ${done}/${toEval.length}\r`);

    // Rate-limit: 1s between batches
    if (i + BATCH < toEval.length) await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write("\n");

  // Persist cache
  fs.mkdirSync(path.dirname(EVAL_CACHE), { recursive: true });
  fs.writeFileSync(EVAL_CACHE, JSON.stringify(cache, null, 2));
  console.log(`  Evaluation cache saved → ${path.relative(ROOT, EVAL_CACHE)}`);

  return results;
}

// ── Test set assembly ─────────────────────────────────────────────────────────

function rank(source, evaluation) {
  // Returns a rough ordinal rank string for sorting within a tier.
  // Lower = better. Used to deterministically break ties without fake scores.
  const tier = evaluation.slide_usefulness;
  const use  = evaluation.analytical_usefulness;
  const rel  = evaluation.source_reliability;
  const time = evaluation.time_relevance;

  const tierRank = { strong_candidate: 0, supporting_candidate: 1, appendix_only: 2, exclude: 3 }[tier] ?? 3;
  const useRank  = { high: 0, usable: 1, context_only: 2 }[use]  ?? 2;
  const relRank  = { primary: 0, reputable_secondary: 1, weak_secondary: 2, unclear: 3 }[rel] ?? 3;
  const timeRank = { within_past_quarter: 0, older_still_relevant: 1, stale: 2 }[time] ?? 2;

  return tierRank * 1000 + useRank * 100 + relRank * 10 + timeRank;
}

function buildEnrichedSource(s, eval_) {
  return {
    id:             s.id,
    title:          s.title,
    url:            s.url,
    date_published: s.date_published,
    publisher:      s.publisher,
    source_type:    s.source_type,
    main_category:  s.main_category,
    trust_tier:     s.trust_tier,
    short_summary:  s.short_summary || s.summary || "",
    evaluation:     eval_,
  };
}

function selectForSet(candidates, evalMap, filterFn, perCat, total) {
  // Phase 1: fill each category to perCat using filterFn priority
  const selected = new Map(); // id → enrichedSource
  const byCat = {};
  for (const cat of OFFENSIVE_CATS) byCat[cat] = [];

  // Sort candidates within each category by rank
  for (const s of candidates) {
    const ev = evalMap[s.id];
    if (!ev || ev.slide_usefulness === "exclude") continue;
    if (!OFFENSIVE_CATS.includes(s.main_category)) continue;
    byCat[s.main_category].push({ s, ev, rank: rank(s, ev) });
  }
  for (const cat of OFFENSIVE_CATS) {
    byCat[cat].sort((a, b) => a.rank - b.rank);
  }

  // Phase 1: category fills using filterFn
  for (const cat of OFFENSIVE_CATS) {
    let added = 0;
    for (const { s, ev } of byCat[cat]) {
      if (added >= perCat) break;
      if (!filterFn(ev, "primary")) continue;
      if (selected.has(s.id)) continue;
      selected.set(s.id, buildEnrichedSource(s, ev));
      added++;
    }
    // Phase 1b: relax filter if still under quota
    if (added < perCat) {
      for (const { s, ev } of byCat[cat]) {
        if (added >= perCat) break;
        if (!filterFn(ev, "secondary")) continue;
        if (selected.has(s.id)) continue;
        selected.set(s.id, buildEnrichedSource(s, ev));
        added++;
      }
    }
    // Phase 1c: fill remaining with any non-excluded
    if (added < perCat) {
      for (const { s, ev } of byCat[cat]) {
        if (added >= perCat) break;
        if (ev.slide_usefulness === "exclude" || ev.analytical_usefulness === "context_only") continue;
        if (selected.has(s.id)) continue;
        selected.set(s.id, buildEnrichedSource(s, ev));
        added++;
      }
    }
  }

  // Phase 2: fill remaining slots up to total with best across all categories
  const remaining = total - selected.size;
  if (remaining > 0) {
    const allSorted = candidates
      .map(s => ({ s, ev: evalMap[s.id], r: evalMap[s.id] ? rank(s, evalMap[s.id]) : 9999 }))
      .filter(({ s, ev }) => ev && ev.slide_usefulness !== "exclude" && OFFENSIVE_CATS.includes(s.main_category) && !selected.has(s.id))
      .sort((a, b) => a.r - b.r);

    for (const { s, ev } of allSorted) {
      if (selected.size >= total) break;
      selected.set(s.id, buildEnrichedSource(s, ev));
    }
  }

  return [...selected.values()];
}

function buildSetA(candidates, evalMap) {
  // Operational: prefer incidents, CVEs, TI, adversary adoption
  return selectForSet(
    candidates,
    evalMap,
    (ev, phase) => {
      if (phase === "primary") {
        return OPERATIONAL_EVIDENCE_TYPES.has(ev.evidence_type) &&
               ev.slide_usefulness === "strong_candidate" &&
               ev.analytical_usefulness !== "context_only";
      }
      return OPERATIONAL_EVIDENCE_TYPES.has(ev.evidence_type) &&
             ev.analytical_usefulness !== "context_only";
    },
    10,
    50,
  );
}

function buildSetB(candidates, evalMap) {
  // Balanced: mix operational + research + adoption signals
  return selectForSet(
    candidates,
    evalMap,
    (ev, phase) => {
      if (phase === "primary") {
        return ev.slide_usefulness === "strong_candidate" &&
               ev.analytical_usefulness !== "context_only";
      }
      return ["strong_candidate","supporting_candidate"].includes(ev.slide_usefulness) &&
             ev.analytical_usefulness !== "context_only" &&
             ev.source_reliability !== "unclear";
    },
    12,
    50,
  );
}

function buildSetC(candidates, evalMap) {
  // Emerging: prefer research demonstrations, PoCs, adoption signals, benchmarks
  return selectForSet(
    candidates,
    evalMap,
    (ev, phase) => {
      if (phase === "primary") {
        return EMERGING_EVIDENCE_TYPES.has(ev.evidence_type) &&
               ev.analytical_usefulness !== "context_only" &&
               ev.time_relevance === "within_past_quarter";
      }
      return EMERGING_EVIDENCE_TYPES.has(ev.evidence_type) &&
             ev.analytical_usefulness !== "context_only";
    },
    10,
    50,
  );
}

// ── Near-miss extraction ───────────────────────────────────────────────────────

function extractNearMisses(candidates, evalMap, selected, limit = 20) {
  const selectedIds = new Set(selected.map(s => s.id));
  const misses = [];

  for (const s of candidates) {
    if (selectedIds.has(s.id)) continue;
    const ev = evalMap[s.id];
    if (!ev) continue;
    if (!["strong_candidate","supporting_candidate"].includes(ev.slide_usefulness)) continue;
    misses.push({
      id:            s.id,
      title:         s.title,
      url:           s.url,
      date_published: s.date_published,
      publisher:     s.publisher,
      main_category: s.main_category,
      exclusion_reason: `slide_usefulness=${ev.slide_usefulness} but not selected — likely displaced by higher-priority source in same category`,
      evaluation:    ev,
    });
    if (misses.length >= limit) break;
  }
  return misses;
}

// ── JSON + Markdown output ────────────────────────────────────────────────────

function countByCat(sources) {
  const counts = {};
  for (const cat of OFFENSIVE_CATS) counts[cat] = 0;
  for (const s of sources) if (counts[s.main_category] !== undefined) counts[s.main_category]++;
  return counts;
}

function buildTestSetJson(id, name, purpose, sources, nearMisses) {
  return {
    set_id:          id,
    set_name:        name,
    purpose,
    created_at:      new Date().toISOString(),
    source_count:    sources.length,
    category_counts: countByCat(sources),
    sources,
    excluded_near_misses: nearMisses,
  };
}

function buildMarkdownSummary(sets) {
  const lines = [];
  lines.push("# Horizon Q Test Set Summary");
  lines.push(`\nGenerated: ${new Date().toISOString().slice(0,10)}\n`);
  lines.push("Three curated source test sets for slide generation quality testing. Each set contains ~50 sources with at least 10 per threat category, selected by LLM semantic judgment against qualitative criteria.\n");
  lines.push("---\n");

  for (const { meta, data } of sets) {
    lines.push(`## ${meta.name}`);
    lines.push(`\n**Purpose**: ${meta.purpose}\n`);
    lines.push(`**Total sources**: ${data.source_count}`);
    lines.push(`\n**Category breakdown**:`);
    for (const [cat, n] of Object.entries(data.category_counts)) {
      lines.push(`- ${CAT_LABEL[cat]}: ${n}`);
    }
    lines.push(`\n**Evidence type distribution**:`);
    const etypes = {};
    for (const s of data.sources) {
      const et = s.evaluation?.evidence_type || "unknown";
      etypes[et] = (etypes[et] || 0) + 1;
    }
    for (const [et, n] of Object.entries(etypes).sort((a,b) => b[1]-a[1])) {
      lines.push(`- ${et}: ${n}`);
    }
    lines.push(`\n**Slide usefulness breakdown**:`);
    const su = {};
    for (const s of data.sources) {
      const k = s.evaluation?.slide_usefulness || "unknown";
      su[k] = (su[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(su).sort((a,b) => b[1]-a[1])) {
      lines.push(`- ${k}: ${n}`);
    }
    lines.push(`\n**Source reliability breakdown**:`);
    const sr = {};
    for (const s of data.sources) {
      const k = s.evaluation?.source_reliability || "unknown";
      sr[k] = (sr[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(sr).sort((a,b) => b[1]-a[1])) {
      lines.push(`- ${k}: ${n}`);
    }

    lines.push(`\n### Selected Sources\n`);
    lines.push("| # | Category | Title | Publisher | Date | Evidence Type | Slide Fit |");
    lines.push("|---|----------|-------|-----------|------|---------------|-----------|");
    data.sources.forEach((s, i) => {
      const title = (s.title || "").replace(/\|/g, "—").slice(0, 70);
      const pub   = (s.publisher || "").slice(0, 25);
      const date  = (s.date_published || "").slice(0, 10);
      const et    = s.evaluation?.evidence_type || "";
      const su2   = s.evaluation?.slide_usefulness || "";
      const cat   = CAT_LABEL[s.main_category]?.split(" ")[0] || s.main_category;
      lines.push(`| ${i+1} | ${cat} | ${title} | ${pub} | ${date} | ${et} | ${su2} |`);
    });

    if (data.excluded_near_misses?.length > 0) {
      lines.push(`\n### Excluded Near-Misses (top ${data.excluded_near_misses.length})\n`);
      lines.push("| Category | Title | Publisher | Date | Reason |");
      lines.push("|----------|-------|-----------|------|--------|");
      for (const m of data.excluded_near_misses.slice(0, 10)) {
        const title = (m.title || "").replace(/\|/g, "—").slice(0, 60);
        const pub   = (m.publisher || "").slice(0, 20);
        const date  = (m.date_published || "").slice(0, 10);
        const cat   = CAT_LABEL[m.main_category]?.split(" ")[0] || m.main_category;
        lines.push(`| ${cat} | ${title} | ${pub} | ${date} | ${m.exclusion_reason?.slice(0,80)} |`);
      }
    }

    lines.push("\n---\n");
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Horizon Test Set Builder`);
  console.log(`  Days: ${DAYS} | Limit/cat: ${LIMIT} | LLM: ${NO_LLM ? "off (heuristic)" : "on"}`);
  console.log(`${banner}\n`);

  const supabase = makeSupabase();

  // Step 1: Fetch candidates
  console.log("Step 1: Fetching source candidates...");
  const candidates = await fetchCandidates(supabase);

  // Step 2: Evaluate
  console.log(`\nStep 2: Evaluating ${candidates.length} candidates...`);
  const evalMap = await runEvaluations(candidates);

  const evaluated  = candidates.filter(c => evalMap[c.id]);
  const excluded   = candidates.filter(c => evalMap[c.id]?.slide_usefulness === "exclude");
  const usable     = candidates.filter(c => evalMap[c.id] && evalMap[c.id].slide_usefulness !== "exclude");
  console.log(`  ${evaluated.length} evaluated | ${usable.length} usable | ${excluded.length} excluded\n`);

  // Step 3: Build test sets
  console.log("Step 3: Building test sets...");
  const setA = buildSetA(usable, evalMap);
  const setB = buildSetB(usable, evalMap);
  const setC = buildSetC(usable, evalMap);

  const nearA = extractNearMisses(candidates, evalMap, setA);
  const nearB = extractNearMisses(candidates, evalMap, setB);
  const nearC = extractNearMisses(candidates, evalMap, setC);

  console.log(`  Set A (operational):       ${setA.length} sources | cats: ${JSON.stringify(countByCat(setA))}`);
  console.log(`  Set B (balanced):          ${setB.length} sources | cats: ${JSON.stringify(countByCat(setB))}`);
  console.log(`  Set C (emerging-signals):  ${setC.length} sources | cats: ${JSON.stringify(countByCat(setC))}`);

  // Step 4: Save outputs
  console.log("\nStep 4: Writing outputs...");

  const outDir = path.join(ROOT, "data/test_sets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "docs/test_sets"), { recursive: true });

  const jsonA = buildTestSetJson("horizon_q_testset_operational", "Test Set A — Operationally Weighted",
    "Maximize incidents, CVEs, advisories, threat-intel. Use to test whether slides become more actionable.", setA, nearA);
  const jsonB = buildTestSetJson("horizon_q_testset_balanced",    "Test Set B — Strategic Balanced",
    "Combine operational, high-quality research, and ecosystem signals. Use for horizon-scanning insights.", setB, nearB);
  const jsonC = buildTestSetJson("horizon_q_testset_emerging",    "Test Set C — Emerging-Signals Weighted",
    "Include research PoCs, new tools, adoption indicators, and early signals. Use for 6-month outlook generation.", setC, nearC);

  const sets = [
    { meta: { name: "Test Set A — Operationally Weighted", purpose: jsonA.purpose }, data: jsonA },
    { meta: { name: "Test Set B — Strategic Balanced",     purpose: jsonB.purpose }, data: jsonB },
    { meta: { name: "Test Set C — Emerging-Signals",       purpose: jsonC.purpose }, data: jsonC },
  ];

  const pathA = path.join(outDir, "horizon_q_testset_operational.json");
  const pathB = path.join(outDir, "horizon_q_testset_balanced.json");
  const pathC = path.join(outDir, "horizon_q_testset_emerging.json");
  const pathMd = path.join(ROOT, "docs/test_sets/horizon_q_testset_summary.md");

  fs.writeFileSync(pathA,  JSON.stringify(jsonA, null, 2));
  fs.writeFileSync(pathB,  JSON.stringify(jsonB, null, 2));
  fs.writeFileSync(pathC,  JSON.stringify(jsonC, null, 2));
  fs.writeFileSync(pathMd, buildMarkdownSummary(sets));

  console.log(`  → ${path.relative(ROOT, pathA)}`);
  console.log(`  → ${path.relative(ROOT, pathB)}`);
  console.log(`  → ${path.relative(ROOT, pathC)}`);
  console.log(`  → ${path.relative(ROOT, pathMd)}`);
  console.log(`\nDone. Run next:\n  node scripts/runTestSetDeck.js --set data/test_sets/horizon_q_testset_operational.json --pptx\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
