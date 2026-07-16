#!/usr/bin/env node
/**
 * auditPipelineL3L4.js — spot-check Layer 3 + Layer 4 on a hand-picked set of sources.
 *
 * Runs validateAndTypeSource (L3) then understandSource / fanOutDigest (L4) on sources
 * fetched from the DB. Does NOT write results back to the DB. Read-only audit.
 *
 * Usage:
 *   node scripts/auditPipelineL3L4.js [--ids id1,id2,...] [--limit N]
 */

import "dotenv/config";
import { createClient }          from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { understandSource }      from "../lib/pipeline/understand/understandSource.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { routedLLM }             from "../lib/llm/llmRouter.js";
import { callLLM }               from "../lib/llm/callLLM.js";
import { flushCostBuffer }       from "../lib/llm/usagePersistence.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const IDS    = getArg("--ids", null)?.split(",").map(s => s.trim()) || null;
const LIMIT  = parseInt(getArg("--limit", "14"), 10);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// layer3Llm expects routedLLM signature → { result, llm_metadata }
// fanOutDigest + understandSource expect callLLM signature → result directly
const routedFn = (sys, usr, opts) => routedLLM(sys, usr, opts);
const llmFn    = (sys, usr, opts) => callLLM(sys, usr, opts);

const PASS  = "✅";
const FAIL  = "❌";
const WARN  = "⚠️ ";
const INFO  = "  ";

function hr(char = "─", len = 70) { return char.repeat(len); }
function label(k, v) { return `  ${k.padEnd(22)}: ${v}`; }

// ── Load sources ──────────────────────────────────────────────────────────────
async function loadSources() {
  let q = sb.from("sources")
    .select("id,title,url,publisher,trust_tier,source_type,main_category,validation_status,tags,is_digest,parent_source_id,intelligence,full_text,clean_text,summary,short_summary,date_published,ai_specificity_score,needs_review,layer3_status,date_confidence");

  if (IDS) {
    q = q.in("id", IDS);
  } else {
    // Default: diverse mix — digests, incidents, research, null-category, thin
    q = q.not("full_text","is",null).neq("validation_status","reject")
      .order("date_published",{ascending:false}).limit(LIMIT);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── L3 audit for one source ───────────────────────────────────────────────────
async function auditL3(source) {
  console.log(`\n${hr()}`);
  console.log(`[L3] ${source.publisher} — ${(source.title||"").slice(0,72)}`);
  console.log(`     id:${source.id}  trust_stored:${source.trust_tier}  type_stored:${source.source_type}`);
  const textLen = (source.full_text||"").length;
  console.log(`     full_text:${textLen}c  status_stored:${source.validation_status}`);

  let result;
  try {
    result = await validateAndTypeSource(source, {
      skipUrlCheck: true,   // don't re-probe URLs; we have stored text
      llmFn: routedFn,      // layer3Llm expects routedLLM signature
    });
  } catch (e) {
    console.log(`${FAIL} L3 threw: ${e.message}`);
    return null;
  }

  const verdict = result.layer3_status;
  const icon = verdict === "pass" ? PASS : verdict === "reject" ? FAIL : WARN;
  console.log(`${icon} verdict          : ${verdict}`);
  console.log(label("reason",            result.final_validity_reason || "(none)"));
  console.log(label("llm_verdict",       result.llm_verdict           || "null (deterministic)"));
  console.log(label("ai_threat_focus",   result.ai_threat_focus       || "(none)"));
  console.log(label("ai_materiality",    result.ai_materiality        || "(none)"));
  console.log(label("content_quality",   result.content_quality       || "(none)"));
  console.log(label("evidence_quality",  result.evidence_quality      || "(none)"));
  console.log(label("trust_tier (LLM)",  result.trust_tier            || "(none)"));
  console.log(label("source_type (LLM)", result.source_type           || "(none)"));
  console.log(label("reading_value",     result.reading_value         || "(none)"));
  console.log(label("candidate_domain",  result.candidate_domain      || "(none)"));
  if (result.validation_summary) {
    console.log(`  summary            : ${result.validation_summary.slice(0,160)}`);
  }

  // Flag mismatches between stored and new verdicts
  if (source.validation_status === "pass" && verdict !== "pass") {
    console.log(`${WARN} MISMATCH: stored=pass but new verdict=${verdict}`);
  }
  if (source.trust_tier && result.trust_tier && source.trust_tier !== result.trust_tier) {
    console.log(`${WARN} trust tier changed: ${source.trust_tier} → ${result.trust_tier}`);
  }
  if (source.source_type && result.source_type && source.source_type !== result.source_type) {
    console.log(`${INFO} source_type changed: ${source.source_type} → ${result.source_type}`);
  }

  return result;
}

// ── L4 digest fanout audit ────────────────────────────────────────────────────
async function auditDigestFanout(source) {
  const det = detectDigest(source);
  if (!det.is_digest) {
    console.log(`${INFO} [fanout] not detected as digest (reason: heuristic negative)`);
    return null;
  }
  console.log(`${INFO} [fanout] digest detected (${det.reason}) — calling LLM to extract items…`);

  let fanout;
  try {
    fanout = await fanOutDigest(source, { llmFn });
  } catch (e) {
    console.log(`${FAIL} [fanout] threw: ${e.message}`);
    return null;
  }

  if (!fanout.is_digest) {
    console.log(`${WARN} [fanout] LLM disagrees — single-topic (${fanout.reason})`);
    return null;
  }

  console.log(`${PASS} [fanout] ${fanout.children.length} children extracted`);
  for (const [i, child] of fanout.children.entries()) {
    const childTitle = (child.title || "").replace(source.title, "").replace(/^\s*\[|\]\s*$/g, "").slice(0,80);
    console.log(`  child ${i+1}: [cat:${child.main_category||"null"}] [trust:${child.trust_tier}] ${childTitle}`);
    if (child.intelligence?.report_finding?.supporting_quote) {
      console.log(`          quote: "${child.intelligence.report_finding.supporting_quote.slice(0,100)}…"`);
    }
  }
  return fanout;
}

// ── L4 classify audit ─────────────────────────────────────────────────────────
async function auditL4Classify(source) {
  console.log(`  [L4b] classifying…`);
  let result;
  try {
    result = await understandSource(source, { llmFn, skipLlm: false });
  } catch (e) {
    console.log(`${FAIL} [L4b] threw: ${e.message}`);
    return null;
  }

  const resultCat = result.category || result.main_category;
  const catMatch  = !source.main_category || source.main_category === resultCat;
  const catIcon   = catMatch ? PASS : WARN;
  console.log(`${catIcon} [L4b] category      : ${resultCat}${!catMatch ? ` (stored: ${source.main_category})` : ""}`);
  console.log(label("[L4b] tags",          (result.primary_tags||result.tags||[]).join(", ").slice(0,80) || "(none)"));
  console.log(label("[L4b] source_type",   result.source_type || "(none)"));
  console.log(label("[L4b] trust_tier",    result.trust_tier  || "(none)"));
  console.log(label("[L4b] is_defensive",  String(result.intelligence?.is_defensive || false)));
  if (result.short_summary) {
    console.log(`  [L4b] summary        : ${result.short_summary.slice(0,160)}`);
  }
  if (result.intelligence?.maturity_level) {
    console.log(label("[L4b] maturity",      result.intelligence.maturity_level));
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Pipeline audit — L3 + L4  (${new Date().toISOString().slice(0,16)} UTC)`);
  console.log(`  Dry-run: NO writes to DB`);
  console.log(`${"═".repeat(70)}`);

  const sources = await loadSources();
  console.log(`\nLoaded ${sources.length} sources for audit\n`);

  const summary = { l3_pass:0, l3_reject:0, l3_mismatch:0, fanout:0, fanout_children:0, l4_cat_match:0, l4_cat_mismatch:0 };

  for (const source of sources) {
    // ── L3 ──
    const l3 = await auditL3(source);
    if (!l3) continue;

    if (l3.layer3_status === "pass") summary.l3_pass++;
    else { summary.l3_reject++; continue; }   // don't L4 a rejected source

    if (source.validation_status === "pass" && l3.layer3_status !== "pass") summary.l3_mismatch++;

    // ── L4a: digest detection + fanout ──
    const isDigestCandidate = detectDigest(source).is_digest;
    if (isDigestCandidate) {
      const fanout = await auditDigestFanout(source);
      if (fanout?.children?.length) {
        summary.fanout++;
        summary.fanout_children += fanout.children.length;
        // Classify one child to verify the path works
        const child = fanout.children[0];
        console.log(`\n  [L4b on child 1] classifying first child…`);
        const childSource = { ...child, full_text: child.full_text || child.summary || child.intelligence?.report_finding?.item_summary || "" };
        await auditL4Classify(childSource);
        continue;  // skip classifying the parent itself
      }
    }

    // ── L4b: classify ──
    const l4 = await auditL4Classify({ ...source, main_category: null, validation_status: "pass" });
    if (l4) {
      if (!source.main_category || source.main_category === l4.main_category) summary.l4_cat_match++;
      else summary.l4_cat_mismatch++;
    }
  }

  // ── Summary ──
  console.log(`\n${"═".repeat(70)}`);
  console.log("  AUDIT SUMMARY");
  console.log(`${"═".repeat(70)}`);
  console.log(`  L3 pass              : ${summary.l3_pass}`);
  console.log(`  L3 reject            : ${summary.l3_reject}`);
  console.log(`  L3 stored→new mismatch: ${summary.l3_mismatch}`);
  console.log(`  Digests fanned out   : ${summary.fanout}  (${summary.fanout_children} children)`);
  console.log(`  L4 category match    : ${summary.l4_cat_match}`);
  console.log(`  L4 category mismatch : ${summary.l4_cat_mismatch}`);
  console.log();
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
