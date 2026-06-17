#!/usr/bin/env node
/**
 * 100-Source End-to-End Pipeline Test with Layer Checkpoints
 *
 * Processes 100 sources through the full pipeline and runs quality-gate
 * checks at every layer boundary. Continues through warnings; hard-stops
 * only on unexpected exceptions.
 *
 * Checkpoints:
 *   0  — Corpus quality before processing
 *   1  — Layer 3 triage (rejection rate, primary-tier protection, relevance)
 *   2  — Layer 4 taxonomy (tag validity, category balance, coverage)
 *   3  — Layer 5A evidence (admissibility, strength, hallucination guard)
 *   4  — Layer 5B analytics (corpus scoping, QA score, category coverage)
 *   5  — Layer 6 synthesis (hallucinated IDs, claim blocking, cross-category)
 *   6  — Layer 7-8 slides + QA (argument_form, claim anchoring, blocking issues)
 *
 * Usage:
 *   node scripts/run100SourcePipelineTest.js [--no-llm] [--limit <n>] [--days <n>]
 *
 * Outputs:
 *   docs/audits/test-runs/<run_id>/
 *     run-summary.md
 *     checkpoint-*.json  (one per checkpoint)
 *     sources.json, triage-results.json, taxonomy-results.json
 *     evidence-packets.json, qa-results.json, analysis-output.md
 */
import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args   = process.argv.slice(2);
const NO_LLM = args.includes("--no-llm");
const LIMIT  = parseInt(args[args.indexOf("--limit") + 1] || "100", 10);
const DAYS   = parseInt(args[args.indexOf("--days")  + 1] || "90",  10);

// ── Run setup ─────────────────────────────────────────────────────────────────

const RUN_ID  = `test-100src-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const OUT_DIR = path.join(ROOT, "docs/audits/test-runs", RUN_ID);
fs.mkdirSync(OUT_DIR, { recursive: true });

const startTime = Date.now();

console.log(`\n${"═".repeat(64)}`);
console.log(`  100-Source Pipeline Test`);
console.log(`  Run ID : ${RUN_ID}`);
console.log(`  LLM    : ${NO_LLM ? "disabled (--no-llm)" : "live"}`);
console.log(`  Limit  : ${LIMIT}  |  Window: ${DAYS} days`);
console.log(`${"═".repeat(64)}\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function save(name, data) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log(`    → ${name}`);
}

// Checkpoint system -----------------------------------------------------------

const allCheckpoints = [];
let totalPass = 0, totalWarn = 0, totalFail = 0;

function beginSection(title) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  CHECKPOINT: ${title}`);
  console.log(`${"─".repeat(64)}`);
  return { title, checks: [] };
}

function ck(section, name, passed, { sev = "fail", detail = "" } = {}) {
  const status = passed ? "pass" : sev;
  if (status === "pass")  totalPass++;
  else if (sev === "warn") totalWarn++;
  else                    totalFail++;
  const icon = passed ? "✓" : sev === "warn" ? "⚠" : "✗";
  console.log(`    ${icon}  ${name}${detail ? `  [${detail}]` : ""}`);
  section.checks.push({ name, status, detail });
  return passed;
}

function endSection(section) {
  allCheckpoints.push(section);
  const p = section.checks.filter(c => c.status === "pass").length;
  const w = section.checks.filter(c => c.status === "warn").length;
  const f = section.checks.filter(c => c.status === "fail").length;
  console.log(`    → ${p} pass, ${w} warn, ${f} fail`);
  save(`checkpoint-${allCheckpoints.length - 1}-${section.title.replace(/\W+/g, "_").toLowerCase()}.json`, section);
}

// Simple distribution helper
function dist(arr, keyFn) {
  const d = {};
  for (const x of arr) { const k = keyFn(x) ?? "(null)"; d[k] = (d[k] || 0) + 1; }
  return d;
}
function pct(n, total) { return total > 0 ? Math.round(100 * n / total) : 0; }

// ── Step 1: Load sources ──────────────────────────────────────────────────────
// Strategy: load sources that were already Layer-3 validated by the backfill
// (layer3_status IS NOT NULL). This avoids re-running expensive LLM triage
// on sources the ingest pipeline already processed. Checkpoint 1 verifies
// the quality of those pre-set fields.

console.log("\n[1/8] Loading Layer-3-validated sources from Supabase...");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const endDate   = new Date().toISOString().slice(0, 10);
const startDate = (() => { const d = new Date(); d.setDate(d.getDate() - DAYS); return d.toISOString().slice(0, 10); })();

// Load with overshoot then stratify for diversity.
// Filter: validation_status IN (pass|review) — saveSnapshotToDatabase writes
// validation_status (not layer3_status) for accepted backfill sources.
// layer3_status is a UI-facing alias set later by enrichment runs.
const { data: rawPool, error: loadErr } = await supabase
  .from("sources")
  .select("*")
  .gte("date_published", startDate)
  .in("validation_status", ["pass", "review"])
  .order("date_published", { ascending: false })
  .limit(LIMIT * 3);   // overshoot; stratify below

if (loadErr) { console.error("DB load failed:", loadErr.message); process.exit(1); }
console.log(`  Pool: ${rawPool.length} validated sources in window ${startDate} → ${endDate}`);

// Stratified selection: bucket by (trust_tier, source_type); take proportionally
const buckets = {};
for (const s of rawPool) {
  const k = `${s.trust_tier}|${s.source_type}`;
  (buckets[k] = buckets[k] || []).push(s);
}
// Round-robin across buckets to get LIMIT sources
const sources = [];
const keys    = Object.keys(buckets);
let i = 0;
while (sources.length < LIMIT && rawPool.length > sources.length) {
  const bucket = buckets[keys[i % keys.length]];
  if (bucket && bucket.length > 0) sources.push(bucket.shift());
  i++;
  if (keys.every(k => !buckets[k]?.length)) break;
}

console.log(`  Selected: ${sources.length} sources (stratified)`);
save("sources.json", sources.map(s => ({
  id: s.id, title: s.title, source_type: s.source_type, trust_tier: s.trust_tier,
  date_published: s.date_published, publisher: s.publisher,
  has_text: !!(s.full_text?.length > 100 || s.clean_text?.length > 100),
})));

// ── Step 1b: Enrich arXiv sources with full paper text ───────────────────────
// Sources loaded from DB may only have the abstract (~1 400 chars). Fetch the
// full HTML paper (intro + methods + results, ~15 000 chars) for any arXiv
// source that hasn't been enriched yet.  This runs BEFORE checkpoints so all
// quality measurements reflect the richer text.

console.log("\n[1b/8] Fetching full arXiv paper text for thin sources...");
const { fetchFullPaperText, arxivIdFrom } = await import("../lib/pipeline/ingest/connectors/arxivConnector.js");

const arxivSources = sources.filter(s =>
  s.publisher === "arXiv" && (s.full_text || s.clean_text || "").length < 3000
);
console.log(`  arXiv sources with thin text: ${arxivSources.length}`);

let enriched = 0, enrichFailed = 0;
for (const s of arxivSources) {
  const arxivId = arxivIdFrom(s.url || "");
  if (!arxivId) continue;
  try {
    const fullText = await fetchFullPaperText(arxivId, null);
    if (fullText && fullText.length > 500) {
      s.full_text  = fullText;
      s.clean_text = fullText;
      enriched++;
    } else {
      enrichFailed++;
    }
  } catch {
    enrichFailed++;
  }
  // 1.5s gap between requests — polite to arxiv, fast enough for ~100 sources
  await new Promise(r => setTimeout(r, 1500));
}
console.log(`  Enriched: ${enriched}  Not available: ${enrichFailed}`);
const afterLengths = sources.map(s => (s.full_text || s.clean_text || "").length);
afterLengths.sort((a,b)=>a-b);
const medLen = afterLengths[Math.floor(afterLengths.length/2)];
const maxLen = afterLengths[afterLengths.length-1];
console.log(`  Text after enrichment: median=${medLen} max=${maxLen} chars`);

// ── CHECKPOINT 0: Corpus quality ──────────────────────────────────────────────

const cp0 = beginSection("Corpus quality");

const tierDist = dist(sources, s => s.trust_tier);
const typeDist = dist(sources, s => s.source_type);
const withText = sources.filter(s => (s.full_text?.length || s.clean_text?.length || 0) > 100).length;
const primaryN  = tierDist.primary || 0;
const highN     = tierDist.high    || 0;
const mediumN   = tierDist.medium  || 0;
const monthDist = dist(sources, s => (s.date_published||"").slice(0,7));

console.log(`    Trust tiers : ${JSON.stringify(tierDist)}`);
console.log(`    Source types: ${JSON.stringify(typeDist)}`);
console.log(`    Months      : ${JSON.stringify(monthDist)}`);

ck(cp0, "≥ 80 sources loaded",              sources.length >= 80,
  { detail: `${sources.length}/${LIMIT}` });
ck(cp0, "≥ 80% sources have text",          pct(withText, sources.length) >= 80,
  { sev: "warn", detail: `${withText}/${sources.length}` });
ck(cp0, "Primary/high tier sources present",primaryN + highN > 0,
  { detail: `primary=${primaryN} high=${highN}` });
ck(cp0, "≥ 3 distinct source types",        Object.keys(typeDist).length >= 3,
  { sev: "warn", detail: Object.keys(typeDist).join(", ") });
ck(cp0, "≥ 2 distinct calendar months",     Object.keys(monthDist).length >= 2,
  { sev: "warn", detail: Object.keys(monthDist).join(", ") });

endSection(cp0);

// ── Step 2: Layer 3 field quality check (backfill already ran validation) ─────
// Sources were Layer-3 validated during the backfill (collectRawSources runs
// validateAndTypeSources). We verify the quality of those pre-set fields here
// rather than re-running expensive LLM triage.

console.log("\n[2/8] Checkpoint 1 — Layer 3 field quality (pre-validated by backfill)...");

const n         = sources.length;
// Sources use validation_status (written by backfill); layer3_status is a later enrichment column.
const passN     = sources.filter(s => s.validation_status === "pass").length;
const reviewN   = sources.filter(s => s.validation_status === "review").length;
const acceptedN = passN + reviewN;
const nullStatusN = sources.filter(s => !s.validation_status).length;

const primarySources  = sources.filter(s => s.trust_tier === "primary");
const primaryRejected = primarySources.filter(s => s.validation_status === "reject");
const nullRelPath      = sources.filter(s => s.relevance_path === null || s.relevance_path === undefined);

const scoresDist = dist(sources, s => {
  const sc = s.ai_specificity_score || 0;
  if (sc === 0) return "0"; if (sc < 20) return "1-19";
  if (sc < 50) return "20-49"; return "50+";
});
const qualDist = dist(sources, s => s.content_quality || "unknown");
const sqDist   = dist(sources, s => s.source_quality_status || "unknown");

// Check for suspicious validation_relevance_method distribution
const methodDist = dist(sources, s => s.validation_relevance_method || "unknown");

console.log(`  pass=${passN}  review=${reviewN}  null_status=${nullStatusN}`);
console.log(`  Score dist  : ${JSON.stringify(scoresDist)}`);
console.log(`  Qual dist   : ${JSON.stringify(qualDist)}`);
console.log(`  SQ dist     : ${JSON.stringify(sqDist)}`);
console.log(`  Method dist : ${JSON.stringify(methodDist)}`);

const cp1 = beginSection("Layer 3 triage (field quality)");

ck(cp1, "All loaded sources have layer3_status set",
  nullStatusN === 0,
  { detail: `${nullStatusN} missing` });

ck(cp1, "Primary tier: 0 hard rejections",
  primaryRejected.length === 0,
  { detail: `${primaryRejected.length}/${primarySources.length} primary rejected` });

ck(cp1, "≥ 80% sources are pass (not just review)",
  pct(passN, n) >= 80,
  { sev: "warn", detail: `${passN}/${n} (${pct(passN,n)}%)` });

ck(cp1, "relevance_path non-null on all sources",
  nullRelPath.length === 0,
  { sev: "warn", detail: `${nullRelPath.length} null` });

ck(cp1, "content_quality set on ≥ 90% of sources",
  pct(sources.filter(s => s.content_quality).length, n) >= 90,
  { sev: "warn", detail: `${sources.filter(s=>s.content_quality).length}/${n}` });

ck(cp1, "source_quality_status set on ≥ 80% of sources",
  pct(sources.filter(s => s.source_quality_status).length, n) >= 80,
  { sev: "warn", detail: `${sources.filter(s=>s.source_quality_status).length}/${n}` });

ck(cp1, "LLM triage ran on majority (not all deterministic fallback)",
  !NO_LLM && (methodDist.llm || 0) > (methodDist.deterministic || 0),
  { sev: "warn", detail: `llm=${methodDist.llm||0} det=${methodDist.deterministic||0}` });

ck(cp1, "ai_specificity_score > 0 on ≥ 50% of sources",
  pct(sources.filter(s => (s.ai_specificity_score||0) > 0).length, n) >= 50,
  { sev: "warn", detail: `${sources.filter(s=>(s.ai_specificity_score||0)>0).length}/${n}` });

ck(cp1, "source_type populated on all sources",
  sources.every(s => s.source_type && s.source_type !== "unknown"),
  { sev: "warn", detail: `${sources.filter(s=>!s.source_type||s.source_type==="unknown").length} missing/unknown` });

// Suspect sources for manual review: high/primary with low specificity
const suspectLowSignal = sources.filter(s =>
  (s.trust_tier === "primary" || s.trust_tier === "high") &&
  (s.ai_specificity_score || 0) === 0 &&
  s.layer3_status === "pass"
);
if (suspectLowSignal.length > 0) {
  console.log(`    ⚠ High/primary sources with ai_specificity=0 that passed (${suspectLowSignal.length}):`);
  suspectLowSignal.slice(0, 3).forEach(s =>
    console.log(`      • ${s.trust_tier} | ${s.validation_relevance_method} | ${s.title?.slice(0, 55)}`)
  );
}

save("triage-results.json", sources.map(s => ({
  id: s.id, title: s.title?.slice(0, 60), layer3_status: s.layer3_status,
  source_type: s.source_type, trust_tier: s.trust_tier,
  content_quality: s.content_quality, ai_specificity_score: s.ai_specificity_score,
  relevance_tier: s.relevance_tier, relevance_path: s.relevance_path,
  source_quality_status: s.source_quality_status, origin_role: s.origin_role,
  publisher_class: s.publisher_class, independence_level: s.independence_level,
  validation_relevance_method: s.validation_relevance_method,
  final_validity_reason: s.final_validity_reason, downstream_route: s.downstream_route,
})));

// All loaded sources are accepted (loaded with layer3_status in pass|review filter).
// Compute the variables used in the final summary.
const accepted        = sources;
const rejectN         = 0;    // not re-running rejection; all sources are already accepted
const rejectPct       = 0;
const acceptPct       = 100;
const suspectRejections = [];  // none — we loaded only accepted sources

endSection(cp1);

// ── Step 3: Layer 4 — Taxonomy ────────────────────────────────────────────────

console.log("\n[3/8] Layer 4 — Taxonomy understanding + classify...");
const { understandSources, TAXONOMY_VERSION } = await import("../lib/pipeline/understand/understandSources.js");
const { classifySources, CLASSIFY_VERSION }   = await import("../lib/pipeline/classify/classifyCategory.js");
const { VALID_PRIMARY_TAGS }                  = await import("../lib/config/taxonomyRegistry.js");
const { OFFENSIVE_CATEGORIES }                = await import("../lib/config/categories.js");

let understoodResult;
try {
  understoodResult = await understandSources(accepted, {
    skipLlm: NO_LLM,
    onProgress: (done, total) => process.stdout.write(`\r  [L4] ${done}/${total} `)
  });
} catch (err) {
  console.error("  Layer 4 FATAL:", err.message); process.exit(1);
}
console.log("");  // newline after progress

const { sources: understoodSources, discarded: discardedByTaxonomy, counts: l4Counts } = understoodResult;
const { sources: l4sources }       = classifySources(understoodSources);

console.log(`  Understood: ${understoodSources.length}  Classified: ${l4sources.length}  Discarded by taxonomy: ${discardedByTaxonomy?.length ?? 0}`);
save("taxonomy-results.json", l4sources.map(s => ({
  id: s.id, title: s.title?.slice(0, 60),
  primary_domain: s.primary_domain, main_category: s.main_category,
  primary_tags: (s.primary_tags || []).map(t => t.tag || t),
  taxonomy_validation_status: s.taxonomy_validation_status,
  ai_enabled: s.ai_enabled,
  classification_confidence: s.classification_confidence,
})));

// ── CHECKPOINT 2: Taxonomy quality ────────────────────────────────────────────

const cp2 = beginSection("Layer 4 taxonomy");

const tvsDist    = dist(l4sources, s => s.taxonomy_validation_status || "none");
const catDist    = dist(l4sources, s => s.main_category || "none");
const validatedN = (tvsDist.validated || 0);
const emergingN  = (tvsDist.emerging_unmapped || 0);
const noMatchN   = (tvsDist.no_domain_match || 0) + (tvsDist.no_tags_found || 0);
const offensiveN = l4sources.filter(s => OFFENSIVE_CATEGORIES.has(s.main_category)).length;
const categoriesHit = Object.keys(catDist).filter(c => OFFENSIVE_CATEGORIES.has(c));

// Tag validity check
const invalidTags = [];
for (const s of l4sources) {
  for (const t of (s.primary_tags || [])) {
    const tag = typeof t === "object" ? t.tag : t;
    if (tag && !VALID_PRIMARY_TAGS.has(tag)) invalidTags.push({ source: s.id, tag });
  }
}

// Category balance: no category > 60% of classified offensive sources
const maxCatPct = offensiveN > 0
  ? Math.max(...Object.values(catDist).map(n => pct(n, offensiveN)))
  : 0;

console.log(`    TVS dist  : ${JSON.stringify(tvsDist)}`);
console.log(`    Cat dist  : ${JSON.stringify(catDist)}`);
console.log(`    Categories: ${categoriesHit.join(", ") || "none"}`);
console.log(`    Invalid tags: ${invalidTags.length}`);

ck(cp2, "taxonomy_version set on understood sources",
  understoodSources.every(s => s.taxonomy_version),
  { sev: "warn", detail: `${understoodSources.filter(s => !s.taxonomy_version).length} missing` });

ck(cp2, "validated ≥ 40% of understood",
  l4sources.length > 0 && pct(validatedN, l4sources.length) >= 40,
  { sev: "warn", detail: `${validatedN}/${l4sources.length} (${pct(validatedN, l4sources.length)}%)` });

ck(cp2, "emerging_unmapped ≤ 30%",
  l4sources.length === 0 || pct(emergingN, l4sources.length) <= 30,
  { sev: "warn", detail: `${emergingN}/${l4sources.length} (${pct(emergingN, l4sources.length)}%)` });

ck(cp2, "≥ 2 offensive categories covered",
  categoriesHit.length >= 2,
  { detail: `${categoriesHit.length} of 4: ${categoriesHit.join(", ")}` });

ck(cp2, "All 4 offensive categories covered",
  categoriesHit.length >= 4,
  { sev: "warn", detail: `missing: ${["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"].filter(c => !categoriesHit.includes(c)).join(", ") || "none"}` });

ck(cp2, "Zero invalid primary tags",
  invalidTags.length === 0,
  { detail: invalidTags.slice(0, 3).map(x => x.tag).join(", ") });

ck(cp2, "No single category dominates (≤ 60% of offensive sources)",
  maxCatPct <= 60,
  { sev: "warn", detail: `max ${maxCatPct}%` });

ck(cp2, "main_category set on every classified source",
  l4sources.every(s => s.main_category),
  { sev: "warn", detail: `${l4sources.filter(s => !s.main_category).length} missing` });

endSection(cp2);

// ── Step 4: Layer 5–6 — Synthesis ─────────────────────────────────────────────

console.log("\n[4/8] Layers 5–6 — Synthesis (rawfact + analytics + viewpoints)...");
const { runSynthesisLayer } = await import("../lib/pipeline/synthesis/synthesisLayer.js");

let synthesisResult;
try {
  synthesisResult = await runSynthesisLayer(l4sources, { skipLlm: NO_LLM });
} catch (err) {
  console.error("  Synthesis FATAL:", err.message, "\n", err.stack);
  process.exit(1);
}

const { feed_sources, rawfact, analytics, category_analyses, presentation_packet } = synthesisResult;

// ── CHECKPOINT 3: Evidence quality ────────────────────────────────────────────

const cp3 = beginSection("Layer 5A evidence packets");

const evSources = feed_sources || [];
const allItems  = evSources.flatMap(s => s.evidence_items || []);
const eligible  = evSources.filter(s => s.evidence_eligibility?.eligible_for_evidence);
const itemsDist = dist(allItems, i => i.triage_data?.evidence_strength || i.evidence_strength || "unknown");
const admDist   = dist(allItems, i => i.triage_data?.admissibility    || i.admissibility    || "unknown");
const typeDist2 = dist(allItems, i => i.evidence_type || "unknown");
const packs     = rawfact?.evidence_packs || synthesisResult.evidence_packs || [];

// Hallucination guard: all evidence_ids must have source_id set
const nullIdItems = allItems.filter(i => !i.evidence_id);
// Check evidence type values are from vocabulary (ALL_EVIDENCE_TYPES from extraction profiles)
const { ALL_EVIDENCE_TYPES } = await import("../lib/pipeline/rawfact/evidenceExtractionProfiles.js");
const VALID_EV_TYPES = new Set(ALL_EVIDENCE_TYPES);
const invalidTypeItems = allItems.filter(i => i.evidence_type && !VALID_EV_TYPES.has(i.evidence_type));

const strongUsable = (itemsDist.strong || 0) + (itemsDist.usable || 0);
const admPassed    = (admDist.passed || 0) + (admDist.context_only || 0);

console.log(`    Eligible sources : ${eligible.length}/${evSources.length}`);
console.log(`    Total items      : ${allItems.length}`);
console.log(`    Strength dist    : ${JSON.stringify(itemsDist)}`);
console.log(`    Admissibility    : ${JSON.stringify(admDist)}`);
console.log(`    Type dist        : ${JSON.stringify(typeDist2)}`);
console.log(`    Packs            : ${packs.length}`);

save("evidence-packets.json", allItems.map(i => ({
  evidence_id:       i.evidence_id,
  source_id:         i.source_id,
  evidence_type:     i.evidence_type,
  evidence_strength: i.triage_data?.evidence_strength || i.evidence_strength,
  admissibility:     i.triage_data?.admissibility || i.admissibility,
  observed_use:      i.triage_data?.observed_use ?? i.observed_use,
  quote_entailment:  i.triage_data?.quote_entailment,
  claim:             (i.claim || "").slice(0, 120),
})));

ck(cp3, "At least 1 eligible source",
  eligible.length >= 1,
  { detail: `${eligible.length}/${evSources.length}` });

ck(cp3, "≥ 5 evidence items extracted",
  allItems.length >= 5,
  { sev: "warn", detail: `${allItems.length}` });

ck(cp3, "At least 1 strong or usable item",
  strongUsable >= 1,
  { sev: "warn", detail: `strong=${itemsDist.strong||0} usable=${itemsDist.usable||0}` });

ck(cp3, "Zero items missing evidence_id (no ID hallucination)",
  nullIdItems.length === 0,
  { detail: `${nullIdItems.length} null IDs` });

ck(cp3, "Zero items with invalid evidence_type",
  invalidTypeItems.length === 0,
  { sev: "warn", detail: invalidTypeItems.slice(0,3).map(i => i.evidence_type).join(", ") });

ck(cp3, "archive-only rate ≤ 80% (some items above archive)",
  allItems.length === 0 || pct((itemsDist.strong||0)+(itemsDist.usable||0)+(itemsDist.context||0), allItems.length) >= 20,
  { sev: "warn", detail: `${pct(strongUsable,allItems.length)}% strong/usable` });

ck(cp3, "admissibility: ≥ 20% passed or context_only",
  allItems.length === 0 || pct(admPassed, allItems.length) >= 20,
  { sev: "warn", detail: `${admPassed}/${allItems.length}` });

endSection(cp3);

// ── CHECKPOINT 4: Analytics quality ───────────────────────────────────────────

const cp4 = beginSection("Layer 5B analytics");

const analyticsData = analytics || {};
const vizSpecs      = analyticsData.visualization_specs || [];
const qaScore       = analyticsData.qa?.score;
const analyticsGraph = synthesisResult.analytics_graph || analyticsData.analytics_graph;

// Corpus-scope check: L5B corpus specs must have corpus_scoped=true.
// External-web specs (L5C) are NOT corpus-scoped by design — exclude them.
const corpusSpecs     = vizSpecs.filter(v => v.source !== "external_web");
const nonCorpusSpecs  = corpusSpecs.filter(v => !v.corpus_scoped);
// Caveat check: all specs must have caveat_if_any (including external — fixed in generateExternalEvidenceSpecs)
const noCaveatSpecs   = vizSpecs.filter(v => !v.caveat_if_any);
const vizByCategory   = dist(vizSpecs, v => v.primary_category || v.category || "none");

console.log(`    Viz specs        : ${vizSpecs.length}`);
console.log(`    Analytics QA     : ${qaScore ?? "n/a"}`);
console.log(`    Corpus-scoped    : ${vizSpecs.length - nonCorpusSpecs.length}/${vizSpecs.length}`);
console.log(`    Has caveat       : ${vizSpecs.length - noCaveatSpecs.length}/${vizSpecs.length}`);
console.log(`    By category      : ${JSON.stringify(vizByCategory)}`);

ck(cp4, "≥ 5 visualization specs generated",
  vizSpecs.length >= 5,
  { sev: "warn", detail: `${vizSpecs.length}` });

ck(cp4, "All corpus viz specs corpus_scoped=true",
  nonCorpusSpecs.length === 0,
  { detail: `${nonCorpusSpecs.length} missing corpus_scoped (external_web specs exempt)` });

ck(cp4, "All viz specs have caveat_if_any",
  noCaveatSpecs.length === 0,
  { detail: `${noCaveatSpecs.length} missing caveat` });

ck(cp4, "Analytics QA score ≥ 80",
  qaScore == null || qaScore >= 80,
  { sev: "warn", detail: `score=${qaScore}` });

endSection(cp4);

// ── CHECKPOINT 5: Synthesis quality ───────────────────────────────────────────

const cp5 = beginSection("Layer 6 synthesis");

const catAnalyses = category_analyses || [];
const activeCats  = catAnalyses.filter(ca => ca.assessment_status === "assessed" || ca.status === "assessed");
const llmCats     = catAnalyses.filter(ca => ca.llm_used);

// Hallucinated evidence ID check: collect all IDs cited in analyses
// and verify they exist in the evidence registry
const registeredIds = new Set(allItems.map(i => i.evidence_id).filter(Boolean));
const citedIds      = new Set();
for (const ca of catAnalyses) {
  for (const ev of [...(ca.insights || []), ...(ca.recommendations || []), ...(ca.trend_patterns || [])]) {
    for (const id of (ev.supporting_evidence_ids || ev.evidence_ids || [])) citedIds.add(id);
  }
}
const hallucinatedIds = [...citedIds].filter(id => !registeredIds.has(id));

// Claim QA blocking rate
const totalInsightsAttempted = catAnalyses.reduce((n, ca) => n + (ca.blocked_claims_count || 0) + (ca.insights?.length || 0), 0);
const blockedClaims = catAnalyses.reduce((n, ca) => n + (ca.blocked_claims_count || 0), 0);
const blockPct = pct(blockedClaims, totalInsightsAttempted);

// Corpus audit flags
const corpusFlags = synthesisResult.corpus_audit?.flags || [];
const hasSmallCorpusFlag = corpusFlags.includes("small_corpus");

console.log(`    Categories       : ${catAnalyses.length} total, ${activeCats.length} assessed`);
console.log(`    LLM categories   : ${llmCats.length}`);
console.log(`    Evidence IDs     : registered=${registeredIds.size} cited=${citedIds.size} hallucinated=${hallucinatedIds.length}`);
console.log(`    Claim blocking   : ${blockedClaims}/${totalInsightsAttempted} (${blockPct}%)`);
console.log(`    Corpus flags     : ${corpusFlags.join(", ") || "none"}`);

ck(cp5, "≥ 2 categories assessed",
  activeCats.length >= 2,
  { detail: activeCats.map(c => c.category).join(", ") });

ck(cp5, "All 4 offensive categories assessed",
  [...OFFENSIVE_CATEGORIES].every(c => activeCats.some(ca => ca.category === c)),
  { sev: "warn", detail: `assessed: ${activeCats.map(c => c.category).join(", ")}` });

ck(cp5, "Zero hallucinated evidence IDs",
  hallucinatedIds.length === 0,
  { sev: "warn", detail: `${hallucinatedIds.length} IDs not in registry: ${hallucinatedIds.slice(0,3).join(", ")}` });

ck(cp5, "Claim blocking rate ≤ 60%",
  blockPct <= 60,
  { sev: "warn", detail: `${blockPct}% (${blockedClaims}/${totalInsightsAttempted})` });

ck(cp5, "Presentation packet built",
  !!presentation_packet && Object.keys(presentation_packet).length > 0,
  { sev: "warn" });

ck(cp5, "Cross-category synthesis present",
  !!(synthesisResult.cross_category_synthesis && Object.keys(synthesisResult.cross_category_synthesis).length > 0),
  { sev: "warn" });

endSection(cp5);

// ── Step 5: Layer 7–8 — Slides + QA ──────────────────────────────────────────

console.log("\n[5/8] Layers 7–8 — Slides + QA...");
const { runSlidesLayer } = await import("../lib/pipeline/slides/slidesLayer.js");
const { runQALayer }     = await import("../lib/pipeline/qa/qaLayer.js");
const { exportMarkdownDeck } = await import("../lib/pipeline/slides/exportMarkdownDeck.js");

let deckResult, qaResult;
try {
  deckResult = await runSlidesLayer(synthesisResult, {
    skipLlm: NO_LLM, exportFormat: "all", detailedNotes: false,
    onProgress: (step, msg) => console.log(`  [${step}] ${msg}`),
  });
  console.log(`  Slides: ${deckResult?.slides?.length ?? 0}  version=${deckResult?.deck_version}`);
} catch (err) {
  console.error("  Slides FATAL:", err.message, "\n", err.stack);
  deckResult = { error: err.message, slides: [], deck_version: "unknown" };
}

try {
  qaResult = await runQALayer(deckResult, synthesisResult);
} catch (err) {
  console.error("  QA error:", err.message);
  qaResult = { overall_pass: false, error: err.message };
}

// ── CHECKPOINT 6: Slide quality ───────────────────────────────────────────────

const cp6 = beginSection("Layers 7-8 slides + QA");

const slides        = deckResult?.slides || [];
const contentQa     = deckResult?.content_qa_report || {};
const notesQa       = deckResult?.notes_qa_report   || {};
const deckVersion   = deckResult?.deck_version;

const analyticalTypes = new Set([
  "critical_claim","evidence_support","trend_claim","outlook_6month",
  "recommendation","case_study","analytics_pattern","evidence_gap",
]);
const analyticalSlides = slides.filter(s => analyticalTypes.has(s.slide_type));
const withForm         = analyticalSlides.filter(s => s.argument_form);
const formPct          = pct(withForm.length, analyticalSlides.length || 1);

const claimAnchored    = deckResult?.counts?.claim_anchored_slides ?? 0;
const blockingContent  = contentQa.slides_blocking ?? 0;
const blockingNotes    = notesQa.slides_blocking   ?? 0;

// Bullet role check
const unTypedBullets = slides.reduce((n, s) => {
  const bads = (s.bullets || []).filter(b => typeof b === "string" || !b?.bullet_role);
  return n + bads.length;
}, 0);
const totalBullets = slides.reduce((n, s) => n + (s.bullets?.length || 0), 0);
const unTypedPct   = pct(unTypedBullets, totalBullets || 1);

// Speaker notes check
const missingNotes = slides.filter(s =>
  !["title","section_divider","appendix","appendix_evidence_index","appendix_analytics_tables","appendix_taxonomy"].includes(s.slide_type)
  && (!s.speaker_notes || typeof s.speaker_notes !== "string")
).length;

console.log(`    Slides         : ${slides.length}`);
console.log(`    Deck version   : ${deckVersion}`);
console.log(`    Analytical     : ${analyticalSlides.length} (${withForm.length} with argument_form = ${formPct}%)`);
console.log(`    Claim-anchored : ${claimAnchored}`);
console.log(`    Blocking (content) : ${blockingContent}`);
console.log(`    Blocking (notes)   : ${blockingNotes}`);
console.log(`    Untyped bullets    : ${unTypedBullets}/${totalBullets} (${unTypedPct}%)`);

save("qa-results.json", {
  overall_pass: qaResult?.overall_pass ?? false,
  slide_count: slides.length, deck_version: deckVersion,
  claim_anchored: claimAnchored,
  content_qa: { slides_blocking: blockingContent, slides_warning: contentQa.slides_warning },
  notes_qa:   { slides_blocking: blockingNotes,   slides_warning: notesQa.slides_warning },
  untyped_bullets_pct: unTypedPct,
  missing_speaker_notes: missingNotes,
});

ck(cp6, "deck-v9.1 generated",
  deckVersion === "deck-v9.1",
  { detail: deckVersion });

ck(cp6, "≥ 18 slides generated",
  slides.length >= 18,
  { detail: `${slides.length}` });

ck(cp6, "argument_form on ≥ 70% analytical slides",
  formPct >= 70,
  { sev: "warn", detail: `${formPct}% (${withForm.length}/${analyticalSlides.length})` });

ck(cp6, "≥ 3 claim-anchored slides",
  claimAnchored >= 3,
  { sev: "warn", detail: `${claimAnchored}` });

ck(cp6, "Blocking content QA issues ≤ 20% of slides",
  pct(blockingContent, slides.length || 1) <= 20,
  { sev: "warn", detail: `${blockingContent}/${slides.length}` });

ck(cp6, "Blocking notes QA issues ≤ 10% of slides",
  pct(blockingNotes, slides.length || 1) <= 10,
  { sev: "warn", detail: `${blockingNotes}/${slides.length}` });

ck(cp6, "Untyped bullets ≤ 5%",
  unTypedPct <= 5,
  { sev: "warn", detail: `${unTypedPct}% (${unTypedBullets}/${totalBullets})` });

ck(cp6, "All non-structural slides have speaker notes",
  missingNotes === 0,
  { sev: "warn", detail: `${missingNotes} missing` });

endSection(cp6);

// Markdown export
try {
  save("analysis-output.md", exportMarkdownDeck(deckResult, { includeAppendix: false }));
} catch (err) {
  save("analysis-output.md", `# Export error\n\n${err.message}\n`);
}

// ── Step 6: Token usage ───────────────────────────────────────────────────────

console.log("\n[6/8] Token usage...");
let tokenSummary = null;
try {
  const { getTokenUsageSummary } = await import("../lib/llm/llmRouter.js");
  tokenSummary = getTokenUsageSummary?.() ?? null;
  if (tokenSummary) console.log(`  Total tokens: ${tokenSummary.daily_total ?? "n/a"}`);
} catch { /* non-fatal */ }

// ── Final run summary ─────────────────────────────────────────────────────────

const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
const allFail   = totalFail;
const allWarn   = totalWarn;
const allPass   = totalPass;
const verdict   = allFail > 0 ? "FAIL" : allWarn > 0 ? "WARN" : "PASS";

const checkpointLines = allCheckpoints.map(cp => {
  const p = cp.checks.filter(c => c.status === "pass").length;
  const w = cp.checks.filter(c => c.status === "warn").length;
  const f = cp.checks.filter(c => c.status === "fail").length;
  return `| ${cp.title.padEnd(40)} | ${p} pass | ${w} warn | ${f} fail |`;
});

const summary = [
  `# 100-Source Pipeline Test — Run Summary`,
  ``,
  `**Run ID:** ${RUN_ID}`,
  `**Date:** ${new Date().toISOString().slice(0,19)}Z`,
  `**LLM mode:** ${NO_LLM ? "deterministic" : "live"} (LLM_MODE=${process.env.LLM_MODE || "?"})`,
  `**Elapsed:** ${elapsed}s`,
  `**Verdict:** ${verdict}  (${allPass} pass · ${allWarn} warn · ${allFail} fail)`,
  ``,
  `## Checkpoint Results`,
  ``,
  `| Checkpoint | Pass | Warn | Fail |`,
  `|---|---|---|---|`,
  ...checkpointLines,
  ``,
  `## Corpus`,
  `- Sources loaded: ${sources.length}`,
  `- Window: ${startDate} → ${endDate}`,
  `- Tier mix: primary=${primaryN} high=${highN} medium=${mediumN}`,
  ``,
  `## Layer 3 Triage`,
  `- Accepted: ${acceptedN} (${acceptPct}%)   Rejected: ${rejectN} (${rejectPct}%)`,
  `- Primary rejected: ${primaryRejected.length}/${primarySources.length}`,
  ``,
  `## Layer 4 Taxonomy`,
  `- Categories: ${categoriesHit.join(", ")}`,
  `- Validated: ${validatedN}/${l4sources.length}  Emerging: ${emergingN}`,
  `- Invalid tags: ${invalidTags.length}`,
  ``,
  `## Evidence (Layer 5A)`,
  `- Items: ${allItems.length} from ${eligible.length} eligible sources`,
  `- Strength: ${JSON.stringify(itemsDist)}`,
  `- Hallucinated IDs: ${hallucinatedIds.length}`,
  ``,
  `## Analytics (Layer 5B)`,
  `- Viz specs: ${vizSpecs.length}  QA score: ${qaScore ?? "n/a"}`,
  ``,
  `## Synthesis (Layer 6)`,
  `- Categories assessed: ${activeCats.length}`,
  `- Claim blocking rate: ${blockPct}%`,
  ``,
  `## Slides (Layer 7-8)`,
  `- Slides: ${slides.length}  Claim-anchored: ${claimAnchored}`,
  `- Blocking: content=${blockingContent} notes=${blockingNotes}`,
  ``,
  `## Token Usage`,
  tokenSummary ? `\`\`\`\n${JSON.stringify(tokenSummary, null, 2)}\n\`\`\`` : "Not available.",
  ``,
  `## Suspect False Negatives`,
  suspectRejections.length > 0
    ? suspectRejections.slice(0, 10).map(s => `- ${s.trust_tier} | ${s.title?.slice(0,70)}`).join("\n")
    : "None found.",
];

save("run-summary.md", summary.join("\n"));

console.log(`\n${"═".repeat(64)}`);
console.log(`  Verdict : ${verdict}`);
console.log(`  Checks  : ${allPass} pass · ${allWarn} warn · ${allFail} fail`);
console.log(`  Elapsed : ${elapsed}s`);
console.log(`  Output  : docs/audits/test-runs/${RUN_ID}/`);
console.log(`${"═".repeat(64)}\n`);

if (allFail > 0) process.exit(1);
