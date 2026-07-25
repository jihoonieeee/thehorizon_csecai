#!/usr/bin/env node
/**
 * deepTagAudit.js — deep accuracy audit for taxonomy tags, maturity, and reading_value.
 *
 * Unlike autoAudit.js (which checks canonicality and obvious misapplications),
 * this script evaluates whether each assigned tag is SEMANTICALLY ACCURATE for the
 * specific source content, using the full classify.md + maturity.md prompt rules as
 * the ground truth. Gemini is the judge; corrections are applied directly to the DB.
 *
 * Usage:
 *   node scripts/deepTagAudit.js [options]
 *
 * Options:
 *   --tag <TAG_ID>    target only sources with this tag (e.g. AE05_ai_malware_dev)
 *   --batch N         start from batch N (default: 1)
 *   --limit N         stop after N batches (default: unlimited)
 *   --dry-run         print findings without writing to DB or log
 *   --category <cat>  filter by main_category
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_TAGS } from "../lib/pipeline/understand/taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = path.resolve(__dirname, "..");
const LOG_FILE = path.join(ROOT, "docs", "database_audit.md");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] ?? d : d; };
const hasFlag  = f => args.includes(f);

const DRY_RUN      = hasFlag("--dry-run");
const LIMIT        = parseInt(getArg("--limit", "0"), 10) || Infinity;
const CLI_BATCH    = parseInt(getArg("--batch", "1"), 10);
const TAG_FILTER   = getArg("--tag", null);
const CAT_FILTER   = getArg("--category", null);
const BATCH_SIZE   = 3;

const GEMINI_MODEL   = "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CANONICAL_TAG_IDS = new Set(PRIMARY_TAGS.map(t => t.id));

// ── Full classify + maturity rules for Gemini ─────────────────────────────────
// These are the verbatim prompt rules from classify.md and maturity.md.

const CLASSIFY_RULES = `
═══════════════════════════════════════════════════════════════
THE ONE QUESTION THAT DECIDES EVERYTHING: is the AI TARGET or WEAPON?
═══════════════════════════════════════════════════════════════

• AI/ML system is the VICTIM → traditional_ai_threats | llm_threats | agentic_ai_threats
• AI is the ATTACKER'S TOOL against a non-AI victim → ai_enabled_threats

DETERMINISTIC-SOFTWARE TEST: "Would this exploit still work if the LLM/agent were replaced with ordinary deterministic software?"
  YES → conventional software / AI-infrastructure vulnerability. Do NOT force into LLM or agentic behavioral categories.
  NO  → genuine LLM or agentic threat.

GLOBAL RULE: classify by the MECHANISM that best explains the incident — not the most severe downstream consequence.

ONE-LINE DISCRIMINATORS:
  traditional_ai_threats: attacker exploits the system AS A MACHINE LEARNING ARTIFACT — weights, data, math, training, inference, model supply chain.
  llm_threats: attacker exploits AS AN INSTRUCTION-FOLLOWING LANGUAGE SYSTEM — prompts, context, guardrails, language output surface.
  agentic_ai_threats: attacker exploits AS AN AUTONOMOUS ACTOR — tool use, code execution, memory, identity, decisions with real-world effect.
  ai_enabled_threats: attacker uses AI AS A WEAPON — victim is human/org/conventional system, not an AI system.

WHOSE AGENT? RULE:
  attacker-owned autonomous agent doing harm to a conventional victim → ai_enabled_threats + AE08
  victim/user-owned agent turned against its owner → agentic_ai_threats

═══════════════════════════════════════════════════════════════
TAG DEFINITIONS WITH DISCRIMINATORS
═══════════════════════════════════════════════════════════════

TAI01_data_poisoning
  WHAT: Attacker manipulates INPUTS TO THE TRAINING PROCESS of a CLASSICAL (non-LLM) model.
  BELONGS WHEN: attacker's access is to training inputs of a classical model.
  CRITICAL FAILURE MODE — NOT TAI01 for:
    • Model inversion (reconstructing training data from outputs) → TAI06
    • Model extraction (querying to clone model) → TAI05
    • Membership inference (determining if record was in training set) → TAI07
    • Code poisoning of ML libraries (poisoning the library not the data) → TAI10
    • LLM training/fine-tune/alignment/RAG data → LLM04

TAI02_model_poisoning
  WHAT: Attacker DIRECTLY EDITS model artifact parameters (weights/tensors/LoRA) of a CLASSICAL model.
  BELONGS WHEN: malice is IN THE ARTIFACT; classical (non-LLM) model; harm is misclassification/wrong output (not autonomous tool calls).
  NOT TAI02 for: LLM weight/LoRA/checkpoint backdoor → LLM03.

TAI03_adversarial_evasion
  WHAT: Crafting INPUT at inference time so a deployed CLASSICAL ML classifier misclassifies it.
  BELONGS WHEN: model/data untouched; attacked model is a CLASSICAL classifier/detector.
  NOT TAI03 for: LLM alignment/safety bypass → LLM11; LLM guardrail bypass → LLM11.
  LLM used ONLY to craft perturbations against a classical model → still TAI03 (LLM is attacker's tooling).

TAI05_model_extraction
  WHAT: Primary objective is to RECOVER THE MODEL ITSELF — weights, decision boundary, working replica. CLASSICAL model only.
  OBJECTIVE TEST: "Is obtaining a functional replica the attack's end goal?" Yes → TAI05.
  NOT TAI05: surrogate trained only to craft adversarial examples → TAI03; wanting training data → TAI06; LLM functionality stealing → LLM10.

TAI06_model_inversion
  WHAT: Recovering private TRAINING DATA from model behaviour. CLASSICAL model only.
  NOT TAI06: TAI05 wants the model; TAI06 wants data content. LLM data recovery → LLM02.

TAI07_membership_inference
  WHAT: Determining if a SPECIFIC RECORD was in training data — binary yes/no signal. CLASSICAL model only.
  NOT TAI07: if attacker recovers actual content → TAI06. LLM or RAG membership inference → LLM02.

TAI10_ai_supply_chain_compromise
  WHAT: Exploiting TRUST IN PROCESSES that produce/package/distribute a CLASSICAL ML model. Survives because the PROCESS remains compromised.
  BELONGS WHEN: compiler, loader, marketplace, pipeline, conversion process REMAINS COMPROMISED.
  RETRAIN TEST: "Would retraining from scratch with trusted infra remove it?" No → TAI10 (pipeline infected).
  NOT TAI10 for: LLM stack components → LLM03; agent runtime/skill registry → ASI04; fake "model" that is just malware (no working ML) → AE05.

LLM01_prompt_injection
  WHAT: Attacker-controlled text overrides developer instructions. TWO MODES: direct (user types it) or indirect (hidden in content model ingests: web page, RAG doc, email, tool response).
  BELONGS WHEN: consequence stays TEXTUAL/INFORMATIONAL — wrong/manipulated answer, leaked snippet in reply.
  CRITICAL FAILURE MODE — NOT LLM01 for:
    • RAG corpus poisoning (planting attacker docs in knowledge base) → LLM04 (pre-retrieval, not inference-time injection)
    • Federated RAG profile forging → LLM04 + LLM08
    • Knowledge graph extraction (GraphSteal) → LLM02 + LLM08
    KEY TEST: "Did attacker inject a malicious INSTRUCTION into prompt/context at inference time?" Yes → LLM01. Attack on DATA LAYER before retrieval → LLM04.
  AGENTIC UPGRADE: if injection makes AGENT ACT (call tool, run code, write memory, change permissions) → ASI tag primary, LLM01 secondary.

LLM04_data_model_poisoning
  WHAT: Manipulating DATA an LLM depends on — RAG corpus, fine-tuning data, alignment data, embedding store — at CORPUS LEVEL.
  CRITICAL FAILURE MODE — NOT LLM04 for:
    • Knowledge graph EXTRACTION (GraphSteal) → LLM02 + LLM08 (reading out, not writing in)
    • Model extraction / knowledge stealing → TAI05/LLM02
    KEY TEST: "Is attacker WRITING malicious content into a data store?" Yes → LLM04. READING/EXTRACTING via model queries → LLM02/TAI05. Manipulating ROUTING/EMBEDDINGS → LLM08.

LLM11_jailbreak_safety_bypass
  WHAT: DIRECT USER defeats model's own safety alignment/refusal training. No external channel involved.
  KEY TEST: "Did attack ride in ingested content, or did user type it as direct instruction?" Typed → LLM11. Content channel → LLM01.
  NOT LLM11 for: classical ML classifier/detector victim → TAI03.

ASI01_agent_goal_hijack
  WHAT: Attacker REDIRECTS AN AUTONOMOUS AGENT'S OBJECTIVE/PLAN. The agent's PURPOSE is subverted.
  NOT ASI01 for: specific tool abused but goal unchanged → ASI02.

ASI02_tool_misuse_exploitation
  WHAT: Harm from WHAT AGENT DOES WITH A TOOL — agent driven to invoke legitimate authorized tool harmfully.
  NOT ASI02 for: code/OS execution via agent's interpreter → ASI05; authorization/approval gap is issue → ASI03.

ASI03_identity_privilege_abuse
  WHAT: Harm from WHAT AGENT IS ALLOWED TO DO — identity, credentials, delegated permissions, or missing authorization controls.
  KEY TEST: "Is the core issue the authorization gap (ASI03) or the specific destructive action with existing permissions (ASI02)?"
  IMPORTANT: Researcher disclosing that an agent LACKS authorization controls is an offensive attack-surface finding — NOT defensive capability.

ASI04_agentic_supply_chain
  WHAT: Attacker compromises component AN AGENT LOADS/RUNS AT RUNTIME; harm flows through AGENT ACTING on it.
  DETERMINISTIC-SOFTWARE CARVE-OUT: generic npm/PyPI package payload running at install/import time (not requiring agent autonomy) → conventional supply chain, NOT ASI04.
  NOT ASI04 for: LLM packages/checkpoints → LLM03; classical ML pipeline → TAI10.

ASI05_unexpected_code_execution
  WHAT: Code/command execution reached THROUGH AGENTIC EXECUTION PATH — autonomous agent's own tool/interpreter runs the code.
  NOT ASI05 for: deterministic API endpoint calling subprocess() (not via agent's tool-selection) → AI-infrastructure / unclear_or_adjacent.
  NOT ASI05 for: APP passes model output to executing system (not an autonomous agent) → LLM05.

ASI06_memory_context_poisoning
  WHAT: Attacker seeds agent's LONG-TERM MEMORY or context store; harm PERSISTS into future sessions.
  NOT ASI06 for: LLM training/RAG corpus → LLM04 (that's corpus-level, not session memory).

AE01_ai_recon
  WHAT: AI accelerates target DISCOVERY, profiling, scanning, or OSINT.
  BELONGS WHEN: AI is genuinely doing the reconnaissance work (not just mentioned tangentially). The AI is the attacker's tool.
  NOT AE01 for: conventional scanning/recon with no meaningful AI contribution.

AE03_ai_vuln_research
  WHAT: AI AUTONOMOUSLY DISCOVERS, ANALYSES, or triages vulnerabilities in a non-AI target's software.
  BELONGS WHEN: deliverable is a FOUND VULNERABILITY; AI is the entity that FOUND the bug.
  CRITICAL FAILURE MODE — NOT AE03 when:
    • Vulnerability was already KNOWN/DISCLOSED/CVE-listed before AI used it.
    • Attacker/agent exploiting a KNOWN CVE is AE08 (orchestration), NOT AE03.
    TEST: "Did the AI find this vulnerability, or was it already public?" Already public → AE03 does NOT apply.

AE04_ai_exploit_dev
  WHAT: AI GENERATES, ADAPTS, or WEAPONIZES a working exploit from a known or discovered vulnerability.
  BELONGS WHEN: deliverable is a WORKING EXPLOIT — AI produced functional attack code.
  CRITICAL FAILURE MODE — NOT AE04 when:
    • Attacker simply TRIGGERED or RAN a public/known exploit without AI generating new exploit code.
    • Autonomous attack agent exploiting a known CVE for initial access → AE08 (orchestration), not AE04.
    TEST: "Did the AI write or adapt the exploit code?" Just invoked a known CVE → AE04 does NOT apply.

AE05_ai_malware_dev
  ══ MANDATORY TEST: "Was AI used to WRITE, GENERATE, or MUTATE the malicious code?" If NO → AE05 does NOT apply. ══
  WHAT: AI AUTHORS, MUTATES, or PACKAGES malicious software. Also covers CONVENTIONAL malware DISTRIBUTED disguised as AI artifact (fake model on hub = dropper with no ML).
  CRITICAL FAILURE MODES — NOT AE05 for:
    • Malware that TARGETS AI files (ENCFORGE ransomware encrypting model weights) — conventional malware targeting AI assets
    • Worms exploiting AI coding-agent config files (Mini Shai-Hulud/SANDWORM_MODE) → agentic_ai_threats (ASI04+ASI02/ASI03)
    • Supply-chain worms targeting AI toolchains where AI did not generate the worm → supply-chain tags, not AE05
  SCALE+COORDINATION RULE: coordinated campaign planting malicious packages in AI/ML repositories → TAI10 (supply chain), not AE05.

AE08_ai_attack_orchestration
  WHAT: AI AUTONOMOUSLY COORDINATES a MULTI-STAGE ATTACK CHAIN — recon, access, lateral movement, action — with minimal human direction.
  BELONGS WHEN: AI agent IS the attacker's weapon orchestrating a conventional attack against a NON-AI victim.
  CRITICAL: NOT for sources that merely describe AI being used in one stage of an attack (that's AE01/AE02/AE03/AE04/AE05). AE08 requires multi-stage autonomous COORDINATION.
  NOT AE08 for: someone's AI agent being subverted (that's agentic_ai_threats); AI used in a single attack stage.
  NOT AE08 for: papers that discuss the CONCEPT of AI attack orchestration without documenting a specific real/PoC multi-stage AI-orchestrated attack.

═══════════════════════════════════════════════════════════════
MATURITY LADDER
═══════════════════════════════════════════════════════════════

RESEARCH: technique studied/simulated only in controlled academic/research environment. No real-world exploitation. Lab/synthetic/toy environments only.
  EXCEPTION — real-model attacks: If paper attacks REAL COMMERCIAL MODELS (GPT-4, Claude, Gemini, live production APIs, real mobile apps) with measured results → DEMONSTRATED, even if framed as benchmark evaluation. RESEARCH applies only to synthetic/toy/simulated environments.

DEMONSTRATED: working exploit/tool exists, shown to work outside purely academic setting. No adversary use yet. Researcher targeting live API/production service = DEMONSTRATED.

DISCLOSED: vendor/researcher/government confirmed vulnerability exists, but no exploitation observed and no public working exploit.

OBSERVED: technique confirmed in real-world use against real victims by actual adversaries (not researchers). At least one incident documented with evidence of actual exploitation.

OPERATIONAL: technique is repeatable tradecraft or SUSTAINED ADVERSARY BEHAVIOR across multiple campaigns. Single large incident = OBSERVED, not OPERATIONAL.

MATURITY FROM SOURCE_TYPE:
  incident → observed | threat_intelligence → operational | adversary_adoption_signal → operational
  exploit_disclosure / capability_demonstration → demonstrated
  research_finding / benchmark_evaluation → research (default — exceptions above apply)
  vulnerability → disclosed | governance_signal → research

═══════════════════════════════════════════════════════════════
READING VALUE
═══════════════════════════════════════════════════════════════

Importance from source_type:
  incident / threat_intelligence / adversary_adoption_signal → realized → essential
  exploit_disclosure / capability_demonstration → proven → recommended (essential if source_type=threat_intelligence)
  research_finding / benchmark_evaluation → research → analyst (DEFAULT for all research papers)
  governance_signal (primary/curated publisher) → reference → analyst
  vulnerability (no active exploitation language) → noise → background
  vulnerability (with "exploited in the wild" / "actively exploited") → realized → essential

RESEARCH-MATURITY CAP: ALL research papers default to "analyst". Upgrade to "recommended" ONLY when: first-of-kind attack CLASS (not just new technique within established class) AND changes strategic threat model AND working demonstration. Papers with new techniques within known attack classes (prompt injection, jailbreaks, backdoors, model extraction, adversarial evasion, etc.) = analyst even if the paper claims "novel" or "first".
`.trim();

const SYSTEM_PROMPT = `You are a senior AI threat intelligence database auditor performing a deep accuracy audit.

Your task is to evaluate whether the assigned taxonomy tags, maturity level, and reading value are ACCURATE for each source — not just canonically valid, but actually correctly representing what the source is about.

${CLASSIFY_RULES}

═══════════════════════════════════════════════════════════════
CANONICAL TAG LIST (40 valid IDs)
═══════════════════════════════════════════════════════════════

${PRIMARY_TAGS.map(t => `  ${t.id} — ${t.label}: ${t.description}`).join("\n")}

═══════════════════════════════════════════════════════════════
EVALUATION INSTRUCTIONS
═══════════════════════════════════════════════════════════════

For each source:

1. TAGS: Evaluate each assigned tag independently. Ask for each:
   - Is this tag ACCURATE for what this source is actually about?
   - Does the source content actually describe this threat mechanism?
   - Apply the MANDATORY TESTS and CRITICAL FAILURE MODES above.
   Flag tags as "wrong" only when you are HIGH CONFIDENCE they are inaccurate.
   Suggest correct replacement tags when wrong.

2. MAIN_CATEGORY: Does the main_category correctly reflect whether AI is Target or Weapon?

3. MATURITY: Given what the source actually presents (lab experiment vs real-world attack vs adversary campaign),
   is the maturity level correct? Apply the EXCEPTION for real commercial model attacks.

4. READING_VALUE: Given the source_type and whether this research introduces a genuinely new attack CLASS
   or a new technique within an established class, is reading_value correct?

Return JSON for each source with your findings.`.trim();

// ── Response schema ───────────────────────────────────────────────────────────
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["clean", "issues"] },
          tag_assessment: {
            type: "array",
            description: "One entry per assigned tag",
            items: {
              type: "object",
              properties: {
                tag:      { type: "string" },
                accurate: { type: "boolean" },
                reason:   { type: "string" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["tag", "accurate", "reason", "confidence"],
            },
          },
          wrong_tags:       { type: "array", items: { type: "string" }, description: "Tags to remove (high confidence wrong)" },
          add_tags:         { type: "array", items: { type: "string" }, description: "Tags to add (missing and clearly correct)" },
          category_correct: { type: "boolean" },
          correct_category: { type: "string", description: "If category_correct=false, the correct category" },
          maturity_correct: { type: "boolean" },
          correct_maturity: { type: "string", description: "If maturity_correct=false, the correct maturity level" },
          reading_value_correct: { type: "boolean" },
          correct_reading_value: { type: "string", description: "If reading_value_correct=false, the correct reading_value" },
          reasoning: { type: "string", description: "Brief reasoning for findings (2-3 sentences max)" },
        },
        required: ["id", "verdict", "tag_assessment", "wrong_tags", "add_tags", "category_correct", "maturity_correct", "reading_value_correct", "reasoning"],
      },
    },
  },
  required: ["sources"],
};

// ── Gemini call ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}` }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  };

  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      try { return JSON.parse(text); }
      catch { return JSON.parse(text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim()); }
    }
    const bodyText = await res.text().catch(() => "");
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const wait = res.status === 503 ? 25000 + attempt * 15000 : 12000 + attempt * 8000;
      process.stdout.write(` [${res.status}, waiting ${wait / 1000}s]`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${bodyText.slice(0, 200)}`);
  }
}

// ── Load sources ──────────────────────────────────────────────────────────────
const DB_FIELDS = [
  "id", "title", "url", "publisher", "date_published", "source_type",
  "trust_tier", "main_category", "tags", "short_summary", "full_text",
  "reading_value", "intelligence",
].join(",");

async function loadAllTargetSources() {
  let query = sb.from("sources").select(DB_FIELDS).eq("validation_status", "pass").not("main_category", "is", null);

  if (TAG_FILTER) {
    query = query.contains("tags", [TAG_FILTER]);
  } else {
    // Default: target the most error-prone tag groups
    query = query.or(
      "tags.cs.{AE05_ai_malware_dev}," +
      "tags.cs.{AE08_ai_attack_orchestration}," +
      "tags.cs.{AE01_ai_recon}," +
      "tags.cs.{AE03_ai_vuln_research}," +
      "tags.cs.{AE04_ai_exploit_dev}," +
      "tags.cs.{TAI01_data_poisoning}," +
      "tags.cs.{LLM01_prompt_injection}," +
      "tags.cs.{ASI03_identity_privilege_abuse}," +
      "tags.cs.{ASI05_unexpected_code_execution}"
    );
  }

  if (CAT_FILTER) query = query.eq("main_category", CAT_FILTER);

  const { data, error } = await query.order("date_published", { ascending: false });
  if (error) throw new Error(`DB: ${error.message}`);
  return data || [];
}

// ── Format source for Gemini ──────────────────────────────────────────────────
function formatSource(s, idx) {
  const intel        = s.intelligence || {};
  const storedMat    = intel.maturity_level ?? "NOT_SET";
  const storedImport = intel.importance?.tier ?? "NOT_SET";
  const storedRV     = s.reading_value ?? "NOT_SET";
  const tags         = s.tags || [];
  const preview      = (s.full_text || "").trim().slice(0, 1200);
  const fullLen      = (s.full_text || "").trim().length;

  return `SOURCE ${idx}
ID: ${s.id}
TITLE: ${(s.title || "").slice(0, 120)}
URL: ${(s.url || "").slice(0, 120)}
PUBLISHER: ${s.publisher || "(none)"} | TRUST: ${s.trust_tier || "unknown"} | SOURCE_TYPE: ${s.source_type || "(none)"}
DATE: ${(s.date_published || "").slice(0, 10)}
MAIN_CATEGORY: ${s.main_category || "(null)"}
TAGS: [${tags.join(", ")}]
MATURITY stored=${storedMat} | IMPORTANCE stored=${storedImport} | READING_VALUE stored=${storedRV}
FULL_TEXT_CHARS: ${fullLen.toLocaleString()}
SHORT_SUMMARY: ${(s.short_summary || "(none)").slice(0, 500)}
FULL_TEXT_PREVIEW (first 1200 chars):
${preview || "(none)"}${fullLen > 1200 ? `\n... [${(fullLen - 1200).toLocaleString()} more chars]` : ""}`.trim();
}

// ── Apply fixes to DB ─────────────────────────────────────────────────────────
async function applyFixes(source, judgment) {
  const fixes = [];
  const currentTags = source.tags || [];

  // Tag corrections
  const wrongTags = (judgment.wrong_tags || []).filter(t => CANONICAL_TAG_IDS.has(t) && currentTags.includes(t));
  const addTags   = (judgment.add_tags || []).filter(t => CANONICAL_TAG_IDS.has(t) && !currentTags.includes(t));

  if (wrongTags.length > 0 || addTags.length > 0) {
    const newTags = [...currentTags.filter(t => !wrongTags.includes(t)), ...addTags];
    const { error } = await sb.from("sources").update({ tags: newTags }).eq("id", source.id);
    fixes.push({ field: "tags", from: currentTags.join(","), to: newTags.join(","), ok: !error, err: error?.message });
  }

  // main_category correction
  if (!judgment.category_correct && judgment.correct_category) {
    const { error } = await sb.from("sources").update({ main_category: judgment.correct_category }).eq("id", source.id);
    fixes.push({ field: "main_category", from: source.main_category, to: judgment.correct_category, ok: !error, err: error?.message });
  }

  // maturity_level correction
  if (!judgment.maturity_correct && judgment.correct_maturity) {
    const intel = { ...(source.intelligence || {}), maturity_level: judgment.correct_maturity };
    const { error } = await sb.from("sources").update({ intelligence: intel }).eq("id", source.id);
    fixes.push({ field: "maturity_level", from: source.intelligence?.maturity_level, to: judgment.correct_maturity, ok: !error, err: error?.message });
  }

  // reading_value correction
  if (!judgment.reading_value_correct && judgment.correct_reading_value) {
    const { error } = await sb.from("sources").update({ reading_value: judgment.correct_reading_value }).eq("id", source.id);
    fixes.push({ field: "reading_value", from: source.reading_value, to: judgment.correct_reading_value, ok: !error, err: error?.message });
  }

  return fixes;
}

// ── Write to audit log ────────────────────────────────────────────────────────
function buildLogEntry(sources, judged) {
  const ts    = new Date().toISOString().slice(0, 10);
  const label = `deepTagAudit/${ts}`;

  const rows = [];
  for (let i = 0; i < Math.min(judged.length, sources.length); i++) {
    const j = judged[i];
    const s = sources[i];
    const title   = (s?.title || "").slice(0, 50).replace(/\|/g, "-");
    const shortId = `\`${s.id.slice(0, 8)}\``;

    if (j.verdict === "clean") {
      rows.push(`| ${title} | ${shortId} | \`wontfix\` | — | Deep accuracy audit: CLEAN. ${j.reasoning || ""} | No action. |`);
      continue;
    }

    const issues = [];
    if ((j.wrong_tags || []).length > 0) issues.push(`tag: remove [${j.wrong_tags.join(", ")}]`);
    if ((j.add_tags || []).length > 0)   issues.push(`tag: add [${j.add_tags.join(", ")}]`);
    if (!j.category_correct && j.correct_category) issues.push(`category: ${s.main_category} → ${j.correct_category}`);
    if (!j.maturity_correct && j.correct_maturity)  issues.push(`maturity: ${s.intelligence?.maturity_level} → ${j.correct_maturity}`);
    if (!j.reading_value_correct && j.correct_reading_value) issues.push(`reading_value: ${s.reading_value} → ${j.correct_reading_value}`);

    const fixText = DRY_RUN ? "DRY RUN — no write." : "Auto-corrected.";
    rows.push(`| ${title} | ${shortId} | \`fixed\` | \`taxonomy/maturity/reading_value\` | Deep accuracy audit: ${issues.join("; ")}. ${j.reasoning || ""} | ${fixText} |`);
  }

  return `\n### Batch ${label}\n\n| Source | ID (first 8) | Status | Type | Issue | Fix applied |\n|--------|-------------|--------|------|-------|-------------|\n${rows.join("\n")}\n`;
}

function prependToLog(section) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN — would prepend to database_audit.md:]");
    console.log(section);
    return;
  }
  let content = fs.readFileSync(LOG_FILE, "utf8");
  const HDR = "\n## Per-Source Issues\n";
  const hdrIdx = content.indexOf(HDR);
  if (hdrIdx < 0) { fs.writeFileSync(LOG_FILE, content + section, "utf8"); return; }
  const searchFrom = hdrIdx + HDR.length;
  const firstBatch = content.indexOf("\n### Batch", searchFrom);
  if (firstBatch < 0) { fs.writeFileSync(LOG_FILE, content + section, "utf8"); return; }
  fs.writeFileSync(LOG_FILE, content.slice(0, firstBatch) + section + "\n" + content.slice(firstBatch), "utf8");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GEMINI_API_KEY) { console.error("ERROR: GEMINI_API_KEY not set"); process.exit(1); }

  console.log(`\n  Deep Tag Accuracy Audit  [Gemini ${GEMINI_MODEL}]`);
  if (TAG_FILTER)  console.log(`  Tag filter: ${TAG_FILTER}`);
  if (CAT_FILTER)  console.log(`  Category filter: ${CAT_FILTER}`);
  if (DRY_RUN)     console.log("  DRY RUN — no DB writes");
  console.log();

  process.stdout.write("  Loading target sources from DB...");
  const allSources = await loadAllTargetSources();
  console.log(` ${allSources.length} sources.`);

  if (allSources.length === 0) {
    console.log("  Nothing to audit.");
    return;
  }

  let batch     = CLI_BATCH;
  let runCount  = 0;
  let fixCount  = 0;
  const offset  = (batch - 1) * BATCH_SIZE;

  for (let i = offset; i < allSources.length && runCount < LIMIT; i += BATCH_SIZE) {
    const sources = allSources.slice(i, i + BATCH_SIZE);
    if (sources.length === 0) break;

    const batchLabel = `batch ${batch} (sources ${i + 1}–${i + sources.length} of ${allSources.length})`;
    process.stdout.write(`  [${batchLabel}] calling Gemini...`);

    const userPrompt = sources.map((s, idx) => formatSource(s, idx + 1)).join(`\n\n${"─".repeat(60)}\n\n`);

    let result;
    try {
      result = await callGemini(userPrompt);
      process.stdout.write(" ✓\n");
    } catch (err) {
      console.error(`\n  Gemini failed: ${err.message} — skipping batch`);
      batch++; runCount++;
      continue;
    }

    const judged = result.sources || [];

    // Positional matching (same as autoAudit — Gemini may mis-read IDs)
    for (let j = 0; j < Math.min(judged.length, sources.length); j++) {
      const judge = judged[j];
      const src   = sources[j];

      if (judge.id && judge.id !== src.id) {
        console.warn(`    ⚠ ID mismatch at position ${j + 1}: Gemini reported ${String(judge.id).slice(0, 8)} but actual is ${src.id.slice(0, 8)} — using actual`);
        judge.id = src.id;
      }

      const wrongTags = (judge.wrong_tags || []).filter(t => (src.tags || []).includes(t));
      const addTags   = (judge.add_tags || []).filter(t => CANONICAL_TAG_IDS.has(t));
      const hasFix    = wrongTags.length > 0 || addTags.length > 0 ||
                        (!judge.category_correct && judge.correct_category) ||
                        (!judge.maturity_correct && judge.correct_maturity) ||
                        (!judge.reading_value_correct && judge.correct_reading_value);

      if (judge.verdict === "clean") {
        console.log(`    ${src.id.slice(0, 8)} — CLEAN`);
      } else {
        const summary = [
          wrongTags.length ? `remove tags: [${wrongTags.join(", ")}]` : null,
          addTags.length   ? `add tags: [${addTags.join(", ")}]` : null,
          !judge.category_correct && judge.correct_category ? `category → ${judge.correct_category}` : null,
          !judge.maturity_correct && judge.correct_maturity ? `maturity → ${judge.correct_maturity}` : null,
          !judge.reading_value_correct && judge.correct_reading_value ? `reading_value → ${judge.correct_reading_value}` : null,
        ].filter(Boolean);
        console.log(`    ${src.id.slice(0, 8)} — ${summary.join(" | ")}`);

        if (!DRY_RUN && hasFix) {
          const fixes = await applyFixes(src, { ...judge, wrong_tags: wrongTags, add_tags: addTags });
          for (const f of fixes) {
            if (!f.ok) console.warn(`      ⚠ fix failed ${f.field}: ${f.err}`);
            else { console.log(`      ✓ ${f.field}: ${f.from} → ${f.to}`); fixCount++; }
          }
        }
      }

      // Print tag-by-tag assessment for any inaccurate tags
      for (const ta of (judge.tag_assessment || [])) {
        if (!ta.accurate) {
          console.log(`      ✗ ${ta.tag} [${ta.confidence}]: ${ta.reason}`);
        }
      }
    }

    // Write to audit log
    const section = buildLogEntry(sources, judged);
    prependToLog(section);

    runCount++;
    batch++;

    if (i + BATCH_SIZE < allSources.length && runCount < LIMIT) await sleep(1000);
  }

  console.log(`\n  Done. ${runCount} batch(es), ${fixCount} fields corrected in DB.`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
