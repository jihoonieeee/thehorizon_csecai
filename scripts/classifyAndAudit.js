#!/usr/bin/env node
/**
 * classifyAndAudit.js — run the full classify pipeline on specific source IDs,
 * then print a detailed audit report for each.
 *
 * Usage:
 *   node scripts/classifyAndAudit.js <id1> [id2 ...]
 */

import "dotenv/config";
import { createClient }         from "@supabase/supabase-js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";
import { qaClassificationLLM }  from "../lib/pipeline/understand/qaClassification.js";
import { computeImportance }    from "../lib/pipeline/scoring/importance.js";
import { deterministicMaturity } from "../lib/pipeline/scoring/maturityLevel.js";
import { upgradeDate }          from "../lib/pipeline/ingest/upgradeDate.js";
import { routedLLM }            from "../lib/llm/llmRouter.js";

const IDS = process.argv.slice(2);
if (!IDS.length) { console.error("Usage: node classifyAndAudit.js <id1> [id2...]"); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MATURITY_LEVELS = ["research","demonstrated","disclosed","observed","operational"];
const READING_FROM_IMP = { realized:"essential", proven:"recommended", research:"analyst", reference:"analyst", noise:"background" };

const W = 70;
const HR  = "─".repeat(W);
const HR2 = "═".repeat(W);

function wrap(text, indent = 2, width = W - indent) {
  if (!text) return " ".repeat(indent) + "(none)";
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = []; let line = " ".repeat(indent);
  for (const word of words) {
    if (line.length + word.length + 1 > width + indent) { lines.push(line.trimEnd()); line = " ".repeat(indent) + word + " "; }
    else line += word + " ";
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

function matchStr(stored, expected) {
  if (!stored) return "NOT SET";
  return stored === expected ? "✓ MATCH" : `✗ MISMATCH  stored=${stored}  expected=${expected}`;
}

async function classifyOne(s) {
  console.log(`\n  Classifying: ${s.title?.slice(0, 60)}…`);

  // Strip layer3_status so understandAllSources doesn't skip via cache-hit path.
  // These sources already passed L3 but never ran L4 (main_category=null).
  const sourceForClassify = { ...s, layer3_status: null };

  const { relevant, discarded } = await understandAllSources([sourceForClassify], routedLLM);
  const result = (relevant[0] || discarded[0]);
  if (!result) { console.log("  ✗ understandAllSources returned nothing"); return null; }

  console.log(`  verdict: ${result.verdict || "?"} | category: ${result.category || result.main_category || "?"}`);

  // Persist main classify result.
  // NOTE: the normalise() return shape uses `primary_tags`, not `tags`.
  const classifyPatch = {
    main_category:           result.category ?? result.main_category ?? null,
    tags:                    result.primary_tags ?? [],
    short_summary:           result.short_summary ?? null,
    intelligence:            { ...(s.intelligence || {}), ...(result.intelligence || {}), key_entities: result.key_entities ?? [] },
    claim_extraction_status: "success",
    understand_version:      result._understand_version ?? null,
  };
  await sb.from("sources").update(classifyPatch).eq("id", s.id);

  // QA verifier
  const merged = { ...s, ...classifyPatch, main_category: classifyPatch.main_category };
  try {
    const qaFix = await qaClassificationLLM(merged, routedLLM);
    if (qaFix) {
      await sb.from("sources").update(qaFix).eq("id", s.id);
      Object.assign(merged, qaFix);
      console.log(`  QA fix: ${JSON.stringify(qaFix)}`);
    }
  } catch (e) { console.log(`  QA skipped: ${e.message.slice(0, 60)}`); }

  // Scoring pass
  const imp       = computeImportance(merged);
  const expRead   = (imp.tier === "proven" && merged.source_type === "threat_intelligence")
    ? "essential" : (READING_FROM_IMP[imp.tier] ?? "background");
  const scorePatch = {
    reading_value: merged.reading_value || expRead,
    intelligence:  { ...merged.intelligence, importance: imp },
  };

  // Date upgrade
  const dateUp = upgradeDate(merged);
  if (dateUp) { Object.assign(scorePatch, dateUp); }

  await sb.from("sources").update(scorePatch).eq("id", s.id);
  return { ...merged, ...scorePatch };
}

async function auditOne(s, idx, total) {
  const intel    = s.intelligence || {};
  const mc       = intel.mechanism_classification || {};
  const sig      = intel.significance || {};
  const imp      = computeImportance(s);
  const detMat   = deterministicMaturity(s);
  const stMat    = intel.maturity_level ?? null;
  const stImp    = intel.importance?.tier ?? null;
  const stRead   = s.reading_value ?? intel.reading_value ?? null;
  const expRead  = (imp.tier === "proven" && s.source_type === "threat_intelligence")
    ? "essential" : (READING_FROM_IMP[imp.tier] ?? "background");

  const lines = [];
  const p = (...a) => lines.push(...a);

  p("", HR2);
  p(`  AUDIT ${idx}/${total} — POST-CLASSIFY`);
  p(HR2);
  p(`  TITLE     : ${(s.title || "").slice(0, W - 14)}`);
  p(`  PUBLISHER : ${s.publisher || "(none)"}  |  TRUST: ${s.trust_tier || "?"}`);
  p(`  DATE      : ${(s.date_published || "").slice(0, 10)}  CONFIDENCE: ${s.date_confidence || "?"}`);
  p(`  TYPE      : ${s.source_type || "?"}  |  ORIGIN: ${s.source_origin || s.discovery_route || "?"}`);

  p("", `  ${HR}`, "  1. TAXONOMY", `  ${HR}`);
  p(`  CATEGORY  : ${s.main_category || "✗ STILL NULL"}`);
  p(`  TAGS      : ${(s.tags || []).join(", ") || "(none)"}`);
  if (mc.mechanism) p(`  MECHANISM : ${mc.mechanism}  IS_DEF: ${mc.is_defensive ?? "?"}`);
  if ((intel.key_entities || []).length) p(`  ENTITIES  : ${intel.key_entities.slice(0, 8).join(", ")}`);

  p("", `  ${HR}`, "  2. THREAT MATURITY", `  ${HR}`);
  p(`  STORED    : ${stMat || "NOT SET"}`);
  p(`  DET.EXPCT : ${detMat.level}  (from source_type=${s.source_type})`);
  p(`  STATUS    : ${stMat ? (stMat === detMat.level ? "✓ consistent" : `⚠ diverges from deterministic (${detMat.level})`) : "NOT SET"}`);

  p("", `  ${HR}`, "  3. IMPORTANCE", `  ${HR}`);
  p(`  STORED    : ${stImp || "NOT SET"}`);
  p(`  EXPECTED  : ${imp.tier}  (reality=${imp.reality}, posture=${imp.posture})`);
  p(`  MATCH     : ${matchStr(stImp, imp.tier)}`);

  p("", `  ${HR}`, "  4. READING VALUE", `  ${HR}`);
  p(`  STORED    : ${stRead || "NOT SET"}`);
  p(`  EXPECTED  : ${expRead}`);
  p(`  MATCH     : ${matchStr(stRead, expRead)}`);

  if (s.source_type === "research_finding" || sig.level) {
    p("", `  ${HR}`, "  5. RESEARCH SIGNIFICANCE", `  ${HR}`);
    p(`  LEVEL     : ${sig.level || "NOT SET"}`);
    if (sig.broken_assumption) p(`  BREAKS    : "${sig.broken_assumption}"`);
  }

  p("", `  ${HR}`, "  6. SUMMARY", `  ${HR}`);
  if (s.short_summary) p(wrap(s.short_summary, 4));
  else p("    ✗ MISSING");

  p("", `  ${HR}`, "  7. VALIDATION REASON (layer3)", `  ${HR}`);
  if (s.validation_summary) p(wrap(s.validation_summary, 4));
  else p("    (none)");

  p("", HR2);
  return lines.join("\n");
}

async function main() {
  // Load sources
  const { data, error } = await sb
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,main_category,tags,reading_value,date_published,date_confidence,short_summary,full_text,clean_text,summary,intelligence,validation_status,validation_summary,layer3_status,candidate_domain,ai_threat_focus,is_digest,parent_source_id,source_origin,discovery_route")
    .in("id", IDS);

  if (error) { console.error("Load error:", error.message); process.exit(1); }
  const byId = Object.fromEntries((data || []).map(s => [s.id, s]));

  for (let i = 0; i < IDS.length; i++) {
    const s = byId[IDS[i]];
    if (!s) { console.log(`\n  ✗ ID not found: ${IDS[i]}`); continue; }

    console.log(`\n${"═".repeat(W)}`);
    console.log(`  SOURCE ${i+1}/${IDS.length}: ${s.title?.slice(0, 55)}`);
    console.log(`${"═".repeat(W)}`);

    let classified;
    if (!s.main_category) {
      classified = await classifyOne(s);
      if (!classified) continue;
    } else {
      console.log("  (already classified — auditing stored values only)");
      classified = s;
    }

    // Re-fetch to get DB-persisted values
    const { data: fresh } = await sb
      .from("sources")
      .select("id,title,url,publisher,source_type,trust_tier,main_category,tags,reading_value,date_published,date_confidence,short_summary,intelligence,validation_summary,source_origin,discovery_route")
      .eq("id", s.id)
      .single();

    console.log(await auditOne(fresh || classified, i + 1, IDS.length));
  }
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
