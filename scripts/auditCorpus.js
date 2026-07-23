#!/usr/bin/env node
/**
 * auditCorpus.js — interactive corpus quality audit.
 *
 * Pulls 5 sources at a time (risk-priority ordered) and prints a full
 * structured report per source. No LLM calls. No mutations.
 *
 * Usage:
 *   node scripts/auditCorpus.js [options]
 *
 * Options:
 *   --batch N            which batch of 5 to fetch (default: 1)
 *   --no-http            skip URL reachability check
 *   --show-all-evidence  show every evidence item (default: first 4)
 *   --category <key>     filter to one main_category
 *   --origin <value>     filter by source_origin substring (e.g. "discovery")
 *   --offset N           raw row offset (overrides --batch)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { computeImportance, IMPORTANCE_TIERS } from "../lib/pipeline/scoring/importance.js";
import { deterministicMaturity, MATURITY_LEVELS } from "../lib/pipeline/scoring/maturityLevel.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const getArg   = (f, def) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] ?? def : def; };
const hasFlag  = f => args.includes(f);

const BATCH         = parseInt(getArg("--batch", "1"), 10);
const NO_HTTP       = hasFlag("--no-http");
const ALL_EVIDENCE  = hasFlag("--show-all-evidence");
const CAT_FILTER    = getArg("--category", null);
const ORIGIN_FILTER = getArg("--origin", null);
const RAW_OFFSET    = getArg("--offset", null);
const BATCH_SIZE    = 5;
const OFFSET        = RAW_OFFSET !== null ? parseInt(RAW_OFFSET, 10) : (BATCH - 1) * BATCH_SIZE;
const EV_LIMIT      = ALL_EVIDENCE ? 999 : 4;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Deterministic expected values ─────────────────────────────────────────────

const READING_FROM_IMPORTANCE = {
  realized:  "essential",
  proven:    "recommended",
  research:  "analyst",
  reference: "analyst",
  noise:     "background",
};

function expectedReadingValue(source) {
  const imp = computeImportance(source);
  if (imp.tier === "proven" && source.source_type === "threat_intelligence") return "essential";
  return READING_FROM_IMPORTANCE[imp.tier] ?? "background";
}

function storedMaturity(source) {
  return source.intelligence?.maturity_level ?? null;
}

function storedImportance(source) {
  return source.intelligence?.importance?.tier ?? null;
}

// ── Risk-priority ordering ────────────────────────────────────────────────────
// Returns a numeric score — higher = more suspicious, pulled first.

function riskScore(s) {
  let score = 0;
  if (s.hallucination_risk && s.hallucination_risk !== "none")   score += 40;
  const origin = (s.source_origin || s.discovery_route || "").toLowerCase();
  if (origin.includes("discovery") || origin.includes("llm"))    score += 30;
  if (s.trust_tier === "unknown")                                 score += 20;
  if (s.date_confidence && s.date_confidence !== "exact")        score += 10;
  return score;
}

// ── HTTP check ────────────────────────────────────────────────────────────────

async function httpCheck(url, timeoutMs = 8000) {
  if (!url) return { status: "NO_URL" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonAudit/1.0)" },
    });
    clearTimeout(timer);
    return { status: res.status, ok: res.ok, final: res.url !== url ? res.url : null };
  } catch (e) {
    if (e.name === "AbortError") return { status: "TIMEOUT" };
    // HEAD blocked — try GET
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), timeoutMs);
      const res2 = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: ctrl2.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonAudit/1.0)" },
      });
      clearTimeout(timer2);
      return { status: res2.status, ok: res2.ok, via: "GET" };
    } catch (e2) {
      return { status: "ERROR", detail: e2.message.slice(0, 60) };
    }
  }
}

// ── Load evidence rows for a source ──────────────────────────────────────────

async function loadEvidence(sourceId) {
  const { data, error } = await sb
    .from("evidence")
    .select("evidence_id,fact,quote,quote_grounded,evidence_type,specificity,technique_tags,entities,event_date,claim_epistemic_type,source_family")
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true })
    .limit(EV_LIMIT + 5); // a few extra so we can report total accurately
  if (error) return { items: [], error: error.message };
  return { items: data || [] };
}

// ── Format helpers ────────────────────────────────────────────────────────────

const W = 70;
const HR  = "─".repeat(W);
const HR2 = "═".repeat(W);

function wrap(text, indent = 2, width = W - indent) {
  if (!text) return " ".repeat(indent) + "(none)";
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = " ".repeat(indent);
  for (const word of words) {
    if (line.length + word.length + 1 > width + indent) {
      lines.push(line.trimEnd());
      line = " ".repeat(indent) + word + " ";
    } else {
      line += word + " ";
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

function match(stored, expected) {
  if (!stored) return "NOT SET";
  return stored === expected ? "✓ MATCH" : `✗ MISMATCH  stored=${stored}  expected=${expected}`;
}

function urlDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── Main render for one source ────────────────────────────────────────────────

async function renderSource(s, idx, total, evidenceData) {
  const lines = [];
  const p = (...a) => lines.push(...a);

  const intel       = s.intelligence || {};
  const mc          = intel.mechanism_classification || {};
  const sig         = intel.significance || {};
  const keyEntities = (intel.key_entities || []).slice(0, 8);

  const detMaturity = deterministicMaturity(s);
  const expImport   = computeImportance(s);
  const expReading  = expectedReadingValue(s);
  const stMaturity  = storedMaturity(s);
  const stImport    = storedImportance(s);
  const stReading   = s.reading_value ?? intel.reading_value ?? null;

  const origin      = s.source_origin || s.discovery_route || "unknown";
  const fullTextLen = (s.full_text || "").trim().length;
  const summaryLen  = (s.short_summary || "").trim().length;

  // ── Header ────────────────────────────────────────────────────────────────
  p("");
  p(HR2);
  p(`  SOURCE ${idx}/${total}  —  batch ${BATCH}, offset ${OFFSET + idx - 1}`);
  p(HR2);

  p(`  TITLE      : ${(s.title || "(no title)").slice(0, W - 15)}`);
  if ((s.title || "").length > W - 15) p(`               ${s.title.slice(W - 15)}`);
  p(`  URL        : ${(s.url || "(none)").slice(0, W - 15)}`);
  const domain = urlDomain(s.url || "");
  p(`  PUBLISHER  : ${s.publisher || "(none)"}    DOMAIN: ${domain}`);
  p(`  TRUST      : ${s.trust_tier || "unknown"}    SOURCE_TYPE: ${s.source_type || "(none)"}`);
  p(`  DATE       : ${(s.date_published || "(none)").slice(0, 10)}    CONFIDENCE: ${s.date_confidence || "(none)"}`);
  if (s.date_published_actual && s.date_published_actual !== s.date_published) {
    p(`  DATE_ACTUAL: ${s.date_published_actual.slice(0, 10)}  (overrides stored date)`);
  }
  p(`  ORIGIN     : ${origin}`);
  p(`  HALL.RISK  : ${s.hallucination_risk || "none"}`);
  p(`  PARENT     : ${s.parent_source_id ? `yes → ${s.parent_source_id.slice(0, 12)}…` : "no (standalone)"}`);
  p(`  IS_REPORT  : ${s.is_digest ? "yes (digest/report)" : "no"}`);

  // ── 1. Taxonomy ───────────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  1. TAXONOMY`);
  p(`  ${HR}`);
  p(`  CATEGORY   : ${s.main_category || "(null — not classified)"}`);
  p(`  TAGS       : ${(s.tags || []).length ? s.tags.join(", ") : "(none)"}`);
  p(`  TAX.STATUS : ${s.taxonomy_validation_status || "(none)"}`);
  p(`  ALL_CATS   : ${(s.all_categories || []).length ? s.all_categories.join(", ") : "(none)"}`);
  if (mc.mechanism) {
    p(`  MECHANISM  : ${mc.mechanism}`);
    p(`  IS_DEF     : ${mc.is_defensive ?? "(not set)"}`);
  }
  if (keyEntities.length) {
    p(`  ENTITIES   : ${keyEntities.join(", ")}`);
  }

  // ── 2. Threat maturity ────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  2. THREAT MATURITY  (research→demonstrated→disclosed→observed→operational)`);
  p(`  ${HR}`);
  p(`  STORED     : ${stMaturity || "NOT SET"}`);
  p(`  DET.EXPECT : ${detMaturity.level}  (from source_type=${s.source_type})`);
  p(`  STATUS     : ${stMaturity ? (stMaturity === detMaturity.level ? "✓ consistent with deterministic" : `⚠ diverges from deterministic (det=${detMaturity.level}) — check if LLM was justified`) : "NOT SET — will fall back to deterministic"}`);

  // ── 3. Importance ─────────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  3. IMPORTANCE  (noise→reference→research→proven→realized)`);
  p(`  ${HR}`);
  p(`  STORED     : ${stImport || "NOT SET"}`);
  p(`  EXPECTED   : ${expImport.tier}  (reality=${expImport.reality}, posture=${expImport.posture}, provenance=${expImport.provenance})`);
  p(`  MATCH      : ${match(stImport, expImport.tier)}`);

  // ── 4. Reading value ──────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  4. READING VALUE  (background→analyst→recommended→essential)`);
  p(`  ${HR}`);
  p(`  STORED     : ${stReading || "NOT SET"}`);
  p(`  EXPECTED   : ${expReading}  (from importance=${expImport.tier})`);
  p(`  MATCH      : ${match(stReading, expReading)}`);

  // ── 5. Research significance (research_findings only) ─────────────────────
  if (s.source_type === "research_finding" || sig.level) {
    p("");
    p(`  ${HR}`);
    p(`  5. RESEARCH SIGNIFICANCE`);
    p(`  ${HR}`);
    p(`  LEVEL      : ${sig.level || "NOT SET"}  (landmark/notable/incremental/noise)`);
    if (sig.broken_assumption) p(`  BREAKS     : "${sig.broken_assumption}"`);
    if (sig.contribution)      p(`  CONTRIB    : ${sig.contribution}`);
    if (!sig.level)            p(`  NOTE       : not yet assessed — run scripts/classify.js to populate`);
  }

  // ── 6. Content quality ────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  6. CONTENT QUALITY`);
  p(`  ${HR}`);
  p(`  SUMMARY    : ${summaryLen ? `${summaryLen} chars` : "MISSING"}`);
  if (summaryLen) {
    p(wrap(s.short_summary, 4));
  }
  p(`  FULL TEXT  : ${fullTextLen ? `${fullTextLen.toLocaleString()} chars stored` : "MISSING — source may not have been fetched"}`);
  if (fullTextLen) {
    p(`  PREVIEW    :`);
    p(wrap((s.full_text || "").slice(0, 500), 4));
    if (fullTextLen > 500) p(`    … [${(fullTextLen - 500).toLocaleString()} more chars]`);
  }
  p(`  VALIDATION : ${s.validation_status || "(none)"}  |  layer3=${s.layer3_status || "(none)"}`);
  if (s.validation_summary) p(wrap(`  REASON: ${s.validation_summary}`, 4));

  // ── 7. Evidence ───────────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  const evTotal = evidenceData.items.length;
  p(`  7. EVIDENCE  (${evTotal > EV_LIMIT ? `showing ${EV_LIMIT} of ${evTotal}+` : `${evTotal} items`})`);
  p(`  ${HR}`);
  p(`  claim_extraction_status: ${s.claim_extraction_status || "null (not yet extracted)"}`);

  if (evidenceData.error) {
    p(`  ERROR loading evidence: ${evidenceData.error}`);
  } else if (!evTotal) {
    p(`  (no evidence items stored)`);
  } else {
    const shown = evidenceData.items.slice(0, EV_LIMIT);
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      p("");
      p(`  [${i + 1}] TYPE: ${e.evidence_type || "?"}`);
      p(`      SPECIFICITY: ${e.specificity || "?"}   GROUNDED: ${e.quote_grounded ? "yes" : "no"}   EPISTEMIC: ${e.claim_epistemic_type || "?"}`);
      if (e.technique_tags?.length) p(`      TECHNIQUES : ${e.technique_tags.join(", ")}`);
      p(`      FACT : ${wrap(e.fact, 0).trim()}`);
      if (e.quote) {
        p(`      QUOTE: ${wrap(`"${e.quote}"`, 0, W - 13).trim()}`);
      }
      if (e.event_date) p(`      EVENT DATE : ${e.event_date}`);
    }
  }

  // ── URL check ─────────────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  URL CHECK`);
  p(`  ${HR}`);
  if (NO_HTTP) {
    p(`  (skipped — run without --no-http to check)`);
  } else if (!s.url) {
    p(`  NO URL stored`);
  } else {
    const chk = await httpCheck(s.url);
    if (chk.status === "TIMEOUT")          p(`  ✗ TIMEOUT (8s)`);
    else if (chk.status === "NO_URL")      p(`  ✗ NO URL`);
    else if (chk.status === "ERROR")       p(`  ✗ ERROR: ${chk.detail}`);
    else if (chk.ok)                       p(`  ✓ HTTP ${chk.status} OK${chk.via ? ` (via ${chk.via})` : ""}${chk.final ? `\n    REDIRECTED TO: ${chk.final}` : ""}`);
    else                                   p(`  ✗ HTTP ${chk.status} — likely dead${chk.via ? ` (via ${chk.via})` : ""}`);
  }

  // ── Flags ─────────────────────────────────────────────────────────────────
  p("");
  p(`  ${HR}`);
  p(`  FLAGS`);
  p(`  ${HR}`);
  p(`  needs_review=${s.needs_review ?? false}   starred=${s.starred ?? false}   is_curated=${s.is_curated ?? false}`);
  p(`  ID: ${s.id}`);
  p(HR2);

  return lines.join("\n");
}

// ── Load sources ──────────────────────────────────────────────────────────────

async function loadBatch() {
  // Pull a larger window and sort risk-first client-side, because risk scoring
  // depends on fields that aren't easy to ORDER BY in SQL.
  const window = 200;
  const { data, error } = await sb
    .from("sources")
    .select([
      "id", "title", "url", "publisher", "date_published", "date_published_actual",
      "date_confidence", "source_type", "trust_tier", "main_category", "all_categories",
      "tags", "taxonomy_validation_status", "short_summary", "full_text",
      "validation_status", "validation_summary", "layer3_status",
      "claim_extraction_status", "reading_value", "intelligence",
      "source_origin", "discovery_route", "hallucination_risk",
      "needs_review", "starred", "is_curated", "is_digest",
      "parent_source_id",
    ].join(","))
    .eq("validation_status", "pass")
    .order("date_published", { ascending: false })
    .range(0, window - 1);

  if (error) { console.error("load error:", error.message); process.exit(1); }
  let rows = data || [];

  if (CAT_FILTER)    rows = rows.filter(s => s.main_category === CAT_FILTER);
  if (ORIGIN_FILTER) rows = rows.filter(s => (s.source_origin || s.discovery_route || "").toLowerCase().includes(ORIGIN_FILTER.toLowerCase()));

  // Risk-sort then pick the batch window
  rows.sort((a, b) => riskScore(b) - riskScore(a));

  const start = OFFSET;
  const batch = rows.slice(start, start + BATCH_SIZE);
  return { batch, totalInWindow: rows.length };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  The Horizon — Corpus Audit`);
  console.log(`  Batch ${BATCH}  (offset ${OFFSET}–${OFFSET + BATCH_SIZE - 1})${CAT_FILTER ? `  category=${CAT_FILTER}` : ""}${ORIGIN_FILTER ? `  origin~=${ORIGIN_FILTER}` : ""}`);
  console.log(`  HTTP checks: ${NO_HTTP ? "off" : "on"}   Evidence: ${ALL_EVIDENCE ? "all" : `first ${EV_LIMIT}`}\n`);

  const { batch, totalInWindow } = await loadBatch();
  if (!batch.length) {
    console.log("  No sources found for this batch/filter combination.");
    return;
  }
  console.log(`  Pulled ${batch.length} sources from a risk-sorted window of ${totalInWindow} (validation=pass)\n`);

  for (let i = 0; i < batch.length; i++) {
    const s  = batch[i];
    const ev = await loadEvidence(s.id);
    const report = await renderSource(s, i + 1, batch.length, ev);
    console.log(report);
  }

  console.log(`\n  End of batch ${BATCH}. Run --batch ${BATCH + 1} for the next 5.\n`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
