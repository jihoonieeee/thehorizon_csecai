#!/usr/bin/env node
/**
 * auditFlaggedAndOthers.js — Critical LLM audit of flagged sources and
 * unclear_or_adjacent sources using Gemini.
 *
 * Priority groups:
 *   A — reject/pass mismatch (l3=pass but validation_status=reject, threat=central) → most likely wrong rejects
 *   B — high-specificity unclear (ai_specificity_score >= 60, no tags) → likely miscategorised
 *   C — reject/reject with threat=central (sample, 15) → verify rejection
 *   D — pass/pass flagged sources (31) → tag quality audit
 *
 * Usage:
 *   LLM_PROVIDER_ORDER=gemini node scripts/auditFlaggedAndOthers.js [--apply] [--group A|B|C|D]
 *
 * --apply   Write corrections back to DB (category + tags + validation_status where warranted)
 * --group   Run only one group (default: all)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { callLLM }      from "../lib/llm/callLLM.js";

if (!process.env.LLM_PROVIDER_ORDER) process.env.LLM_PROVIDER_ORDER = "gemini";

const args    = process.argv.slice(2);
const APPLY   = args.includes("--apply");
const GROUP   = args.find(a => a.startsWith("--group=") || (args[args.indexOf("--group") + 1]))?.replace("--group=", "") ||
                (args.includes("--group") ? args[args.indexOf("--group") + 1] : null);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const W  = 80;
const HR = "─".repeat(W);

// ── Taxonomy reference (compact, for prompt) ──────────────────────────────────

const TAXONOMY_COMPACT = `
DOMAINS & ROUTING RULES:
• traditional_ai_threats — ML model, training data, inference path, or ML supply chain attacked
• llm_threats            — LLM-specific surface: prompts, guardrails, RAG, embeddings, system prompt
• agentic_ai_threats     — agent acts through memory, tools, MCP, runtime, credentials, orchestration
• ai_enabled_threats     — AI used as offensive tool for phishing, malware, recon, disinformation
• unclear_or_adjacent    — relevant AI-security context not mapping to any offensive category above

PRIMARY TAGS (use exact IDs):
Traditional AI: TAI01_data_poisoning, TAI02_model_poisoning, TAI03_adversarial_evasion,
  TAI05_model_extraction, TAI06_model_inversion, TAI07_membership_inference,
  TAI08_inference_api_abuse, TAI09_model_denial_of_service, TAI10_ai_supply_chain_compromise
LLM: LLM01_prompt_injection, LLM02_sensitive_info_disclosure, LLM03_llm_supply_chain,
  LLM04_data_model_poisoning, LLM05_improper_output_handling, LLM06_excessive_agency,
  LLM07_system_prompt_leakage, LLM08_vector_embedding_weakness, LLM09_misinformation,
  LLM10_unbounded_consumption, LLM11_jailbreak_safety_bypass
Agentic: ASI01_agent_goal_hijack, ASI02_tool_misuse_exploitation, ASI03_identity_privilege_abuse,
  ASI04_agentic_supply_chain, ASI05_unexpected_code_execution, ASI06_memory_context_poisoning,
  ASI07_insecure_agent_comms, ASI08_cascading_failures, ASI09_human_agent_trust_exploit,
  ASI10_rogue_agents
AI-Enabled: AE01_ai_recon, AE02_ai_social_engineering, AE03_ai_vuln_research, AE04_ai_exploit_dev,
  AE05_ai_malware_dev, AE06_ai_evasion_obfuscation, AE07_ai_identity_abuse,
  AE08_ai_attack_orchestration, AE09_ai_disinformation, AE10_ai_deepfake
`.trim();

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildPrompt(sources) {
  const sourcesJson = sources.map((s, i) => ({
    index: i,
    id: s.id,
    title: s.title,
    publisher: s.publisher,
    date_published: s.date_published?.slice(0, 10) ?? "unknown",
    source_type: s.source_type,
    current_category: s.main_category,
    current_tags: s.tags ?? [],
    current_status: `l3=${s.layer3_status ?? "null"} / validation=${s.validation_status ?? "null"}`,
    ai_specificity_score: s.ai_specificity_score,
    short_summary: s.short_summary ?? "",
    ai_threat_focus: s.ai_threat_focus ?? "",
    text_excerpt: (s.clean_text || s.full_text || "").slice(0, 600),
  }));

  const system = `You are a senior AI threat intelligence analyst auditing a corpus of classified security sources.
Your task: critically review each source's classification labels, taxonomy tags, and data quality.
Be strict and precise. Flag every genuine error — do not excuse sloppy tags.

${TAXONOMY_COMPACT}

REVIEW CRITERIA:
1. CATEGORY accuracy — does main_category match the domain routing rules above?
   • Multi-domain sources: pick the DOMINANT offensive mechanism as primary.
   • Roundups/digest covering many topics: assign the most prevalent mechanism.
   • Governance/policy/defence-only content belongs in unclear_or_adjacent.
2. TAG accuracy — do tags reflect specific attack techniques present in the source?
   • Tags must be provable from the text/summary — no speculative tags.
   • Missing tags: flag if 1-3 additional primary tags clearly apply.
   • Wrong tags: flag if a tag is unsupported by the content.
   • Return 1-4 correct primary tags (exact IDs).
3. DATE plausibility — flag if date_published looks wrong:
   • Future-dated (past 2026-07-30), obviously wrong year, or timestamp looks like crawl date.
4. REJECTION correctness — for rejected sources:
   • RECONSIDER if the source clearly covers an offensive AI threat.
   • CONFIRM_REJECT if source is defensive-only, off-topic, or purely governance with no threat content.
5. EVIDENCE quality — based on summary/excerpt:
   • "rich" = specific attack details, CVEs, real incidents, technical mechanisms
   • "moderate" = general threat descriptions with some specificity
   • "thin" = vague/marketing/generic without grounded claims

Respond with a JSON array (one object per source, same order as input).`;

  const user = `Review these ${sources.length} sources:\n\n${JSON.stringify(sourcesJson, null, 2)}

Return a JSON array of objects, one per source, exactly:
[
  {
    "index": 0,
    "id": "...",
    "verdict": "KEEP_AS_IS" | "RECLASSIFY" | "TAG_FIX" | "RECONSIDER_REJECT" | "CONFIRM_REJECT",
    "correct_category": "...",
    "correct_tags": ["tag_id", ...],
    "date_issue": null | "description of date problem",
    "evidence_quality": "rich" | "moderate" | "thin",
    "issues": ["concise description of each problem found"],
    "reasoning": "1-2 sentence rationale"
  }
]
Return only the JSON array. No markdown, no explanation outside the array.`;

  return { system, user };
}

// ── Validation ─────────────────────────────────────────────────────────────────

const VALID_CATS = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats",
  "ai_enabled_threats", "unclear_or_adjacent",
]);
const VALID_TAGS = new Set([
  "TAI01_data_poisoning","TAI02_model_poisoning","TAI03_adversarial_evasion",
  "TAI05_model_extraction","TAI06_model_inversion","TAI07_membership_inference",
  "TAI08_inference_api_abuse","TAI09_model_denial_of_service","TAI10_ai_supply_chain_compromise",
  "LLM01_prompt_injection","LLM02_sensitive_info_disclosure","LLM03_llm_supply_chain",
  "LLM04_data_model_poisoning","LLM05_improper_output_handling","LLM06_excessive_agency",
  "LLM07_system_prompt_leakage","LLM08_vector_embedding_weakness","LLM09_misinformation",
  "LLM10_unbounded_consumption","LLM11_jailbreak_safety_bypass",
  "ASI01_agent_goal_hijack","ASI02_tool_misuse_exploitation","ASI03_identity_privilege_abuse",
  "ASI04_agentic_supply_chain","ASI05_unexpected_code_execution","ASI06_memory_context_poisoning",
  "ASI07_insecure_agent_comms","ASI08_cascading_failures","ASI09_human_agent_trust_exploit",
  "ASI10_rogue_agents",
  "AE01_ai_recon","AE02_ai_social_engineering","AE03_ai_vuln_research","AE04_ai_exploit_dev",
  "AE05_ai_malware_dev","AE06_ai_evasion_obfuscation","AE07_ai_identity_abuse",
  "AE08_ai_attack_orchestration","AE09_ai_disinformation","AE10_ai_deepfake",
]);

function sanitiseResult(r) {
  return {
    ...r,
    correct_category: VALID_CATS.has(r.correct_category) ? r.correct_category : null,
    correct_tags: (r.correct_tags ?? []).filter(t => VALID_TAGS.has(t)),
  };
}

// ── LLM batch call ─────────────────────────────────────────────────────────────

async function auditBatch(sources) {
  const { system, user } = buildPrompt(sources);
  // Wrap in object — Gemini rejects array as root responseSchema type
  const schema = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index:            { type: "integer" },
            id:               { type: "string" },
            verdict:          { type: "string", enum: ["KEEP_AS_IS","RECLASSIFY","TAG_FIX","RECONSIDER_REJECT","CONFIRM_REJECT"] },
            correct_category: { type: "string" },
            correct_tags:     { type: "array", items: { type: "string" } },
            date_issue:       { type: ["string","null"] },
            evidence_quality: { type: "string", enum: ["rich","moderate","thin"] },
            issues:           { type: "array", items: { type: "string" } },
            reasoning:        { type: "string" },
          },
          required: ["index","id","verdict","correct_category","correct_tags","evidence_quality","issues","reasoning"],
        },
      },
    },
    required: ["results"],
  };

  const raw = await callLLM(system, user, { schema, logLabel: "audit-flagged-others", temperature: 0.1 });
  const results = Array.isArray(raw) ? raw : (raw?.results ?? []);
  return results.map(sanitiseResult);
}

// ── DB apply ───────────────────────────────────────────────────────────────────

async function applyFix(source, result) {
  const updates = {};

  if (result.verdict === "RECLASSIFY" && result.correct_category && result.correct_category !== source.main_category) {
    updates.main_category = result.correct_category;
  }
  if (["RECLASSIFY","TAG_FIX"].includes(result.verdict) && result.correct_tags?.length) {
    updates.tags = result.correct_tags;
  }
  if (result.verdict === "RECONSIDER_REJECT") {
    // Promote to review so human can decide; don't auto-pass
    updates.validation_status = "review";
  }

  if (Object.keys(updates).length === 0) return null;

  const { error } = await sb.from("sources").update(updates).eq("id", source.id);
  if (error) throw new Error(`DB update failed for ${source.id}: ${error.message}`);
  return updates;
}

// ── Print helpers ──────────────────────────────────────────────────────────────

function verdictIcon(v) {
  return { KEEP_AS_IS: "✓", RECLASSIFY: "⚡", TAG_FIX: "🏷", RECONSIDER_REJECT: "⚠", CONFIRM_REJECT: "✗" }[v] ?? "?";
}

function printResult(source, result) {
  const icon = verdictIcon(result.verdict);
  console.log(`\n${HR}`);
  console.log(`${icon}  [${result.verdict}]  ${source.title?.slice(0,65)}`);
  console.log(`   ID: ${source.id.slice(0,8)}  |  publisher: ${source.publisher ?? "?"}  |  date: ${source.date_published?.slice(0,10) ?? "?"}  |  type: ${source.source_type ?? "?"}`);
  console.log(`   Current:  cat=${source.main_category ?? "null"}  tags=${JSON.stringify(source.tags ?? [])}`);
  if (["RECLASSIFY","TAG_FIX","RECONSIDER_REJECT"].includes(result.verdict)) {
    console.log(`   Correct:  cat=${result.correct_category ?? "—"}  tags=${JSON.stringify(result.correct_tags)}`);
  }
  if (result.date_issue) console.log(`   ⚠ DATE: ${result.date_issue}`);
  console.log(`   Evidence: ${result.evidence_quality}  |  ${result.reasoning}`);
  if (result.issues?.length) {
    result.issues.forEach(iss => console.log(`   • ${iss}`));
  }
}

// ── Source loaders ─────────────────────────────────────────────────────────────

async function loadGroupA() {
  const { data } = await sb.from("sources")
    .select("id,title,url,publisher,main_category,tags,validation_status,layer3_status,date_published,trust_tier,short_summary,ai_threat_focus,ai_specificity_score,source_type,clean_text,full_text")
    .eq("validation_status", "reject")
    .eq("layer3_status", "pass")
    .order("date_published", { ascending: false });
  return data ?? [];
}

async function loadGroupB() {
  const { data } = await sb.from("sources")
    .select("id,title,url,publisher,main_category,tags,validation_status,layer3_status,date_published,trust_tier,short_summary,ai_threat_focus,ai_specificity_score,source_type,clean_text,full_text")
    .eq("main_category", "unclear_or_adjacent")
    .gte("ai_specificity_score", 60)
    .order("ai_specificity_score", { ascending: false });
  return data ?? [];
}

async function loadGroupC() {
  const { data } = await sb.from("sources")
    .select("id,title,url,publisher,main_category,tags,validation_status,layer3_status,date_published,trust_tier,short_summary,ai_threat_focus,ai_specificity_score,source_type,clean_text,full_text")
    .eq("validation_status", "reject")
    .eq("layer3_status", "reject")
    .eq("ai_threat_focus", "central")
    .order("date_published", { ascending: false })
    .limit(20);
  return data ?? [];
}

async function loadGroupD() {
  const { data } = await sb.from("sources")
    .select("id,title,url,publisher,main_category,tags,validation_status,layer3_status,date_published,trust_tier,short_summary,ai_threat_focus,ai_specificity_score,source_type,clean_text,full_text")
    .eq("validation_status", "pass")
    .eq("layer3_status", "pass")
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent")
    .order("date_published", { ascending: false })
    .limit(31);
  return data ?? [];
}

// ── Deduplicate by ID ──────────────────────────────────────────────────────────

function dedup(sources) {
  const seen = new Set();
  return sources.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
}

// ── Run group ──────────────────────────────────────────────────────────────────

async function runGroup(label, sources, batchSize = 6) {
  sources = dedup(sources);
  if (!sources.length) { console.log(`\n[${label}] No sources found.`); return []; }

  console.log(`\n${"═".repeat(W)}`);
  console.log(`  GROUP ${label} — ${sources.length} sources  (batch size: ${batchSize})`);
  console.log(`${"═".repeat(W)}`);

  const allResults = [];
  for (let i = 0; i < sources.length; i += batchSize) {
    const batch    = sources.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const total    = Math.ceil(sources.length / batchSize);
    process.stdout.write(`  Batch ${batchNum}/${total} (${batch.length} sources)… `);

    let results;
    try {
      results = await auditBatch(batch);
      process.stdout.write(`done (${results.length} results)\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      continue;
    }

    for (const result of results) {
      const source = batch[result.index];
      if (!source) continue;
      printResult(source, result);
      allResults.push({ source, result });

      if (APPLY && result.verdict !== "KEEP_AS_IS" && result.verdict !== "CONFIRM_REJECT") {
        try {
          const applied = await applyFix(source, result);
          if (applied) console.log(`   → Applied: ${JSON.stringify(applied)}`);
        } catch (err) {
          console.error(`   → Apply failed: ${err.message}`);
        }
      }
    }

    // Polite delay between batches
    if (i + batchSize < sources.length) await new Promise(r => setTimeout(r, 2000));
  }

  return allResults;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(allGroupResults) {
  const flat = allGroupResults.flat();
  const counts = {};
  for (const { result } of flat) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;

  console.log(`\n${"═".repeat(W)}`);
  console.log("  AUDIT SUMMARY");
  console.log(`${"═".repeat(W)}`);
  for (const [v, n] of Object.entries(counts).sort()) {
    console.log(`  ${verdictIcon(v)}  ${v.padEnd(22)} ${n}`);
  }
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Total reviewed: ${flat.length}`);

  const dateIssues = flat.filter(r => r.result.date_issue);
  if (dateIssues.length) {
    console.log(`\n  DATE ISSUES (${dateIssues.length}):`);
    dateIssues.forEach(({ source, result }) =>
      console.log(`  • [${source.id.slice(0,8)}] ${source.title?.slice(0,55)} → ${result.date_issue}`)
    );
  }

  const thin = flat.filter(r => r.result.evidence_quality === "thin");
  if (thin.length) {
    console.log(`\n  THIN EVIDENCE (${thin.length}):`);
    thin.forEach(({ source }) =>
      console.log(`  • [${source.id.slice(0,8)}] ${source.title?.slice(0,60)}`)
    );
  }

  if (!APPLY) {
    console.log(`\n  Re-run with --apply to write corrections to DB.`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(W)}`);
console.log(`  Flagged & Others Audit — ${new Date().toISOString().slice(0, 16)} UTC`);
console.log(`  Provider: ${process.env.LLM_PROVIDER_ORDER ?? "default"}  |  Apply: ${APPLY}  |  Group: ${GROUP ?? "all"}`);
console.log(`${"═".repeat(W)}`);

const runGroups = [];
if (!GROUP || GROUP === "A") runGroups.push(["A — reject/pass mismatch (likely wrong rejects)", loadGroupA]);
if (!GROUP || GROUP === "B") runGroups.push(["B — high-specificity unclear (no tags, likely miscategorised)", loadGroupB]);
if (!GROUP || GROUP === "C") runGroups.push(["C — reject/reject with central threat (verify rejects)", loadGroupC]);
if (!GROUP || GROUP === "D") runGroups.push(["D — pass/pass flagged (tag quality audit)", loadGroupD]);

const allGroupResults = [];
for (const [label, loader] of runGroups) {
  const sources = await loader();
  const results = await runGroup(label, sources);
  allGroupResults.push(results);
}

printSummary(allGroupResults);