/**
 * synthesizeCategory()
 *
 * Replaces the L6 analysis stack (22 files: buildAnalyticalState 34K,
 * synthesizeCategory 29K, claimQa 41K, validateCategoryAnalysis 18K, …)
 * with a 3-step pipeline:
 *
 *   Step 1  buildDossier()       deterministic — packages evidence for the LLM
 *   Step 2  callSynthesis()      ONE Opus/Sonnet call → strategic judgments
 *   Step 3  evaluateJudgments()  deterministic rubric — blocks hollow outputs
 *
 * The LLM forms its own analytical state. We do not pre-compute signals,
 * confidence ceilings, or claim permissions before the call.
 */

import { routedLLM }    from "../llm/llmRouter.js";
import { callLLM }      from "../llm/callLLM.js";
import { DOMAIN_RULES, buildTaxonomyPromptBlock } from "./taxonomy.js";
import { randomUUID }  from "crypto";
import { qaJudgments } from "./qaJudgments.js";

export const SYNTHESIS_VERSION = "synthesis-v2.1";

// ── Per-category SCOPE CONTRACT ───────────────────────────────────────────────
// The synthesis prompt was category-agnostic, so a category would drift to
// whatever AI content existed in its evidence — e.g. "Traditional AI Threats"
// (attacks ON ML models) drifted into "AI used to find flaws in normal apps".
// Each category now carries an explicit framing question + in/out-of-scope lines.
// The analyst must answer the framing question and stay inside the scope, or say
// the evidence is thin — never substitute adjacent AI content.
const CATEGORY_SCOPE = {
  traditional_ai_threats: {
    question: "How are attacks that TARGET machine-learning / AI models themselves evolving?",
    in_scope: "data poisoning, training-data manipulation, model extraction / model theft, model inversion & membership inference, adversarial examples / evasion attacks, model backdoors, attacks on ML supply chain (poisoned weights, malicious models on model hubs).",
    out_of_scope: "AI used AS an attack tool (that is AI-Enabled Threats); prompt injection / jailbreaks (LLM Threats); agent/tool abuse (Agentic); and ordinary CVEs in apps that merely happen to use AI.",
    incident_hook: "model theft, weight exfiltration, a poisoned model on a hub, a real evasion attack on a deployed classifier.",
  },
  llm_threats: {
    question: "How are attacks that TARGET large language models and their pipelines evolving?",
    in_scope: "prompt injection (direct & indirect), jailbreaks / guardrail bypass, system-prompt leakage, training-data extraction, RAG poisoning, output-handling exploits against LLM applications.",
    out_of_scope: "autonomous agent / tool-calling abuse (Agentic); AI used to generate malware or phishing (AI-Enabled); classical ML-model attacks (Traditional).",
    incident_hook: "a real indirect-prompt-injection breach, data exfiltration via an LLM app, a guardrail bypass used in the wild.",
  },
  agentic_ai_threats: {
    question: "How are attacks that TARGET AI agents, their tools, and their ecosystems evolving?",
    in_scope: "agent goal hijack, tool/function-call abuse, MCP-server and plugin/skill-marketplace compromise, memory/context poisoning, autonomous-agent privilege escalation, agent supply-chain attacks.",
    out_of_scope: "single-shot prompt injection against a chatbot with no tools (LLM Threats); classical ML-model attacks (Traditional); AI-generated attack content (AI-Enabled).",
    incident_hook: "a malicious agent skill/plugin, an MCP compromise, an agent tricked into a harmful tool call.",
  },
  ai_enabled_threats: {
    question: "How is AI being used AS an offensive tool by attackers?",
    in_scope: "AI-generated phishing / social engineering, deepfakes & voice cloning, AI-assisted malware or exploit generation, AI-scaled disinformation, AI-accelerated reconnaissance.",
    out_of_scope: "attacks ON AI systems (those are the other three categories). The AI must be the attacker's TOOL, evidenced in the source.",
    incident_hook: "a real campaign using AI-built malware, a deepfake fraud, AI-generated phishing at scale.",
  },
};

function buildScopeBlock(category) {
  const s = CATEGORY_SCOPE[category];
  if (!s) return "";
  return `═══ CATEGORY SCOPE — answer THIS question, stay inside THIS boundary ═══
FRAMING QUESTION (your judgments must answer it): ${s.question}
IN SCOPE:  ${s.in_scope}
OUT OF SCOPE (do NOT write judgments about these — they belong to other categories): ${s.out_of_scope}
LOOK FOR (the highest-value evidence): ${s.incident_hook}

HONESTY RULE: if the evidence genuinely lacks in-scope material, do NOT substitute
adjacent AI content to fill the section. Produce ONE low-confidence judgment that
states plainly what in-scope evidence is missing, and list it in evidence_gaps.
A thin, honest section beats an off-topic one.`;
}

// ── Step 1: Build dossier ─────────────────────────────────────────────────────
// Packages evidence into a clean text block the LLM can reason over.
// No pre-analysis, no signal mapping, no confidence ceilings.

// ── Evidence selection: tag-diversity clustering ──────────────────────────────
// Selects evidence to maximise technique coverage rather than naively taking
// the first N items (which clusters on whatever technique ranked first).
// Round-robins across technique-tag groups so every attack surface gets
// at least one representative in the dossier.

function selectDiverseEvidence(items, cap) {
  if (items.length <= cap) return items;

  const SPEC = { high: 3, medium: 2, low: 1 };
  const score = (ei) =>
    (ei.quote_grounded ? 4 : 0) +
    (SPEC[ei.specificity] || 1) +
    ((ei.numbers?.length || 0) > 0 ? 1 : 0);

  // Group by primary technique tag
  const groups = {};
  for (const ei of items) {
    const tag = ei.technique_tags?.[0] || "untagged";
    if (!groups[tag]) groups[tag] = [];
    groups[tag].push(ei);
  }
  for (const g of Object.values(groups)) g.sort((a, b) => score(b) - score(a));

  // Sort groups: larger groups get more representation but not all slots
  const tagKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const cursors = Object.fromEntries(tagKeys.map(k => [k, 0]));
  const selected = [];

  let progress = true;
  while (selected.length < cap && progress) {
    progress = false;
    for (const tag of tagKeys) {
      if (selected.length >= cap) break;
      if (cursors[tag] < groups[tag].length) {
        selected.push(groups[tag][cursors[tag]++]);
        progress = true;
      }
    }
  }
  return selected;
}

// Single-call dossier caps. selectDiverseEvidence() ensures these items span
// all technique-tag groups rather than clustering on one area.
// 60 strong + 25 usable + 10 context ≈ 15K tokens — fits Sonnet and Gemini Pro.
const CHUNK_STRONG  = 60;
const CHUNK_USABLE  = 25;
const CHUNK_CONTEXT = 10;

function buildDossier(category, pack, sources, corpusSummary, itemSubset = null) {
  // itemSubset: pre-selected items for a specific chunk (map phase).
  // If null, select diverse items from the full pack (single-call path).
  let strong, usable, context;
  if (itemSubset) {
    strong  = itemSubset.filter(ei => ei._strength === "strong");
    usable  = itemSubset.filter(ei => ei._strength === "usable");
    context = itemSubset.filter(ei => ei._strength === "context");
  } else {
    strong  = selectDiverseEvidence(pack.strong  || [], CHUNK_STRONG);
    usable  = selectDiverseEvidence(pack.usable  || [], CHUNK_USABLE);
    context = (pack.context || []).slice(0, CHUNK_CONTEXT);
  }
  const allItems = [...strong, ...usable, ...context];

  const totalAvailable = itemSubset
    ? itemSubset.length
    : (pack.strong?.length || 0) + (pack.usable?.length || 0) + (pack.context?.length || 0);
  const capped = totalAvailable > allItems.length;

  if (allItems.length === 0) {
    return { dossier_text: "(no evidence for this category)", evidence_index: {} };
  }

  const evidence_index = {};
  const lines = [
    `CATEGORY: ${category.replace(/_/g, " ").toUpperCase()}`,
    `DOMAIN RULE: ${DOMAIN_RULES[category] || ""}`,
    "",
    `CORPUS COVERAGE:`,
    `  Sources: ${corpusSummary.source_count_by_category?.[category] || 0} of ${corpusSummary.total_sources} total`,
    `  Date range: ${corpusSummary.date_range || "unknown"}`,
    `  Trust tiers present: ${corpusSummary.trust_by_category?.[category] || "unknown"}`,
    "",
    `EVIDENCE (${allItems.length} items shown of ${totalAvailable} total${capped ? ` — top ${CHUNK_STRONG} strong / ${CHUNK_USABLE} usable / ${CHUNK_CONTEXT} context per chunk selected` : ""}, ${strong.length} strong / ${usable.length} usable / ${context.length} context):`,
    "",
  ];

  for (const ei of allItems) {
    evidence_index[ei.evidence_id] = {
      fact:        ei.fact,
      source_id:   ei.source_id,
      source_url:  ei.source_url,
      trust_tier:  ei.trust_tier,
      specificity: ei.specificity,
    };

    const tier   = ei.is_cluster_rep ? "[STRONG]" : "[CONTEXT]";
    const grnd   = ei.quote_grounded ? "✓grounded" : "~inferred";
    lines.push(`[${ei.evidence_id}] ${tier} ${grnd} (${ei.evidence_type}, ${ei.specificity} specificity)`);
    lines.push(`  FACT: ${ei.fact}`);
    if (ei.quote && ei.quote_grounded) {
      lines.push(`  QUOTE: "${ei.quote}"`);
    }
    lines.push(`  SOURCE: ${ei.source_title || ei.source_url || ei.source_id} [${ei.trust_tier}]`);
    if (ei.technique_tags?.length) {
      lines.push(`  TAGS: ${ei.technique_tags.join(", ")}`);
    }
    lines.push("");
  }

  return { dossier_text: lines.join("\n"), evidence_index };
}

// ── Step 2: Synthesis LLM call ────────────────────────────────────────────────

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          judgment:           { type: "string" },
          what_changed:       { type: "string" },
          why_this_matters:   { type: "string" },
          causal_mechanism:   { type: "string" },
          confidence:         { type: "string", enum: ["high", "medium", "low"] },
          evidence_maturity:  { type: "string", enum: [
            "research_demonstration",
            "disclosed_vulnerability",
            "observed_exploitation",
            "adversary_adoption",
            "operational_campaign",
          ]},
          evidence_for:       { type: "array", items: { type: "string" } },
          evidence_against:   { type: "array", items: { type: "string" } },
          caveats:            { type: "array", items: { type: "string" } },
          short_takeaway:     { type: "string" },
          technique_focus:    { type: "array", items: { type: "string" } },
          monitoring_signals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                signal:               { type: "string" },
                why_it_matters:       { type: "string" },
                current_evidence:     { type: "string" },
                escalation_trigger:   { type: "string" },
                monitoring_source_type: { type: "string" },
              },
              required: ["signal", "why_it_matters", "escalation_trigger"],
            },
          },
          recommended_action: { type: "string" },
        },
        required: [
          "judgment", "what_changed", "causal_mechanism", "why_this_matters",
          "confidence", "evidence_maturity", "evidence_for", "caveats", "short_takeaway",
        ],
      },
    },
    outlook_assessment: {
      type: "object",
      properties: {
        observed_basis:        { type: "string" },
        likely_next_movement:  { type: "string" },
        escalation_trigger:    { type: "string" },
        confidence:            { type: "string", enum: ["high", "medium", "low"] },
        what_would_invalidate: { type: "string" },
      },
      required: ["observed_basis", "likely_next_movement", "escalation_trigger", "confidence", "what_would_invalidate"],
    },
    coverage_assessment: { type: "string" },
    evidence_gaps:       { type: "array", items: { type: "string" } },
  },
  required: ["judgments", "coverage_assessment"],
};

function buildSynthesisSystem() {
  return `You are a principal threat intelligence analyst writing a strategic assessment for a cybersecurity leadership briefing.

Your job is to produce 2-4 strategic judgments and a structured outlook for the assigned threat category.

═══ EVIDENCE MATURITY — REQUIRED for every judgment ═══
Assign exactly one maturity level. These are strict definitions:
  research_demonstration   — Lab-proven feasibility. No real-world deployment confirmed.
  disclosed_vulnerability  — A CVE, advisory, or researcher disclosure confirms an exploitable flaw.
  observed_exploitation    — Incident reporting or threat intelligence confirms in-the-wild exploitation.
  adversary_adoption       — A named threat actor or criminal group is confirmed using this technique.
  operational_campaign     — Sustained, attributed campaign across multiple incidents.

RULES:
  ✗ NEVER write "operational use" unless evidence_maturity is adversary_adoption or operational_campaign.
  ✗ A CVE alone = disclosed_vulnerability, NOT observed_exploitation.
  ✗ A research paper alone = research_demonstration, regardless of how convincing the results.
  ✓ When maturity is research_demonstration or disclosed_vulnerability, write:
    "Exploitable attack surface is visible; adversary adoption remains unconfirmed."
  ✓ When only one source supports a claim, add caveat: "single-source signal — treat as early indicator."

═══ ANALYTICAL QUALITY — REQUIRED ═══
Every judgment has four mandatory analytical fields. All four must be substantive (≥1 sentence each):

  judgment:          The core finding stated as a precise, falsifiable claim. NOT a description.
                     BAD:  "Attackers are using AI for phishing."
                     GOOD: "AI-generated spear-phishing now bypasses attention-based email filters at enterprise scale."

  what_changed:      What specifically changed, emerged, or was newly demonstrated in this corpus period?
                     Must name the capability shift, disclosure, or incident — not generic "X is increasing."
                     GOOD: "OpenAI Codex demonstrated autonomous exploit generation on real CVEs with no human guidance."

  causal_mechanism:  WHY is this happening now? What technical or economic change made it possible?
                     Must explain the mechanism, not restate the finding.
                     GOOD: "LLMs eliminate the per-recipient effort cost of personalisation, making industrialised spear-phishing economically viable."

  why_this_matters:  What control assumption breaks? What new blast radius or attack path opens up?
                     Must state defender implication — not "this is concerning."
                     GOOD: "Signature-based phishing detection fails when every email is unique; defenders must shift to behavioural detection."

All four fields are REQUIRED. Do not leave any empty or write placeholder text.

4. CONFIDENCE must match evidence strength:
   high   = 2+ strong items from high-trust sources, consistent findings, evidence_maturity ≥ observed_exploitation
   medium = 1-2 usable items, some inconsistency, or maturity = disclosed_vulnerability
   low    = context-only, single source, or maturity = research_demonstration only

5. MONITORING SIGNALS — give 1-2 SPECIFIC, OBSERVABLE signals (structured objects).
   - signal: a concrete, measurable thing a defender can actually watch for — name
     the artifact/behaviour/place. NOT a generic category restatement.
   - escalation_trigger: a DIFFERENT, specific event that confirms escalation. It
     must NOT merely restate the signal.
       BAD  signal: "New prompt injection attacks"; trigger: "Detection of a new prompt injection attack" (circular, useless)
       GOOD signal: "Public exploit kits adding an indirect-prompt-injection module for a named agent framework";
            trigger: "First IR/vendor report of that module used in a real customer breach"
   - why_it_matters: one clause on the consequence.
   - current_evidence: what in THIS corpus hints at it.
   - monitoring_source_type: the concrete feed to watch (e.g. "vendor IR reports", "NVD", "criminal-forum intel").
   Keep each ≤ 22 words. No vague "increased X" / "new Y" placeholders.

6. OUTLOOK — produce one outlook_assessment for the category. This is a 6-month
   forecast for a CISO; it must be SPECIFIC and FALSIFIABLE, not a truism.
   likely_next_movement MUST name at least one concrete element: a specific
   technique, a named actor/actor-type, a target system/sector, or a measurable
   threshold — and a direction over the next ~6 months. Ban hedge-verbs used
   alone ("continue", "evolve", "grow", "increase", "develop", "may", "could").
   It MUST be derived from THIS category's evidence and be DIFFERENT from the other
   categories' outlooks — do not reuse a generic template across categories.
     BAD (too vague):  "Adversaries will continue to develop and exploit AI weaknesses."
     BAD (too vague):  "The use of LLMs will grow and attackers will develop techniques."
   Keep likely_next_movement to ONE sentence, ≤ 35 words — a punchy forecast, not
   a paragraph. The example below shows the STYLE only (specificity + 6-month
   horizon + a trigger). Do NOT copy its subject or wording:
     STYLE EXAMPLE: "Within 6 months, expect the first <specific, category-relevant
            event> as <named technique/actor> moves from <current stage> to <next stage>."
   observed_basis:        The concrete evidence in THIS corpus the forecast rests on.
   escalation_trigger:    The specific observable event that confirms the movement.
   confidence:            high / medium / low (match evidence strength).
   what_would_invalidate: The specific signal that would prove this outlook wrong.

short_takeaway: ≤15 words. The single most important point. No vague language.

${buildTaxonomyPromptBlock()}

Return ONLY valid JSON. No markdown, no preamble.

CRITICAL: evidence_for MUST contain exact evidence IDs (e.g., "ev-fixture--1") from the dossier. Copy verbatim.`;
}

function buildSynthesisUser(category, dossier_text) {
  return `Produce strategic judgments and outlook for: ${category.replace(/_/g, " ").toUpperCase()}

${buildScopeBlock(category)}

${dossier_text}

Generate 2-4 judgments. EVERY judgment MUST populate all four analytical fields:
  "judgment"          — precise falsifiable claim (not a description)
  "what_changed"      — specific capability shift or disclosure observed in this evidence
  "causal_mechanism"  — WHY this is happening now (the mechanism, not a restatement of the finding)
  "why_this_matters"  — which control assumption breaks; what new attack path opens

Empty strings for any of these fields will fail QA and the judgment will be discarded.

Other requirements:
- evidence_for[]: exact IDs from the dossier. Copy verbatim from [brackets] at start of each evidence block.
- evidence_maturity: assign the correct level — a CVE ≠ observed_exploitation; a research paper = research_demonstration.
- monitoring_signals: structured objects (signal / why_it_matters / current_evidence / escalation_trigger / monitoring_source_type).
- outlook_assessment: one structured forward-looking assessment for the whole category.
- If corpus is thin: 1 judgment at low confidence + full evidence_gaps list. Do not inflate confidence.`;
}

// Critical fields the model must populate for a judgment to pass QA
const CRITICAL_FIELDS = ["judgment", "what_changed", "causal_mechanism", "why_this_matters"];
const MIN_FIELD_LEN   = 20;

function judgmentsHaveCriticalFields(raw) {
  const judgments = raw?.judgments || [];
  if (!judgments.length) return false;
  return judgments.every(j =>
    CRITICAL_FIELDS.every(f => typeof j[f] === "string" && j[f].trim().length >= MIN_FIELD_LEN)
  );
}

// ── Map→Reduce synthesis ──────────────────────────────────────────────────────
// When evidence exceeds one chunk (>45 items), split into chunks, run parallel
// synthesis calls on each, then consolidate all preliminary findings into final
// strategic judgments in one final call.

function buildChunks(pack) {
  // Tag each item with its strength tier so buildDossier can re-split after flat merge
  const strong  = (pack.strong  || []).map(ei => ({ ...ei, _strength: "strong" }));
  const usable  = (pack.usable  || []).map(ei => ({ ...ei, _strength: "usable" }));
  const context = (pack.context || []).map(ei => ({ ...ei, _strength: "context" }));

  // Select diverse items across the full pool first, then chunk
  const divStrong  = selectDiverseEvidence(strong,  Math.min(strong.length,  CHUNK_STRONG  * 4));
  const divUsable  = selectDiverseEvidence(usable,  Math.min(usable.length,  CHUNK_USABLE  * 4));
  const divContext = context.slice(0, CHUNK_CONTEXT * 4);

  const allSelected = [...divStrong, ...divUsable, ...divContext];
  const chunkSize   = CHUNK_STRONG + CHUNK_USABLE + CHUNK_CONTEXT;  // 45

  if (allSelected.length <= chunkSize) return [allSelected];  // single chunk

  // Split into chunks of ~chunkSize, respecting strength-tier proportions
  const chunks = [];
  for (let i = 0; i < allSelected.length; i += chunkSize) {
    chunks.push(allSelected.slice(i, i + chunkSize));
  }
  return chunks;
}

const PRELIMINARY_SCHEMA = {
  type: "object",
  properties: {
    preliminary_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          finding:           { type: "string" },
          what_changed:      { type: "string" },
          causal_mechanism:  { type: "string" },
          why_this_matters:  { type: "string" },
          confidence:        { type: "string", enum: ["high","medium","low"] },
          evidence_maturity: { type: "string" },
          evidence_ids:      { type: "array", items: { type: "string" } },
          technique_areas:   { type: "array", items: { type: "string" } },
        },
        required: ["finding","what_changed","causal_mechanism","why_this_matters","confidence","evidence_maturity","evidence_ids"],
      },
    },
  },
  required: ["preliminary_findings"],
};

const CONSOLIDATION_SCHEMA = SYNTHESIS_SCHEMA;

function buildConsolidationPrompt(category, allPreliminaryFindings, evidenceIndex) {
  // List valid evidence IDs up front so the model knows what format to use
  const validIds = Object.keys(evidenceIndex);
  const lines = [
    `CATEGORY: ${category.replace(/_/g, " ").toUpperCase()}`,
    "",
    `VALID EVIDENCE IDs (ALL start with "ev-", use ONLY these in evidence_for[]):`,
    validIds.slice(0, 50).join(", "),
    "",
    `You have ${allPreliminaryFindings.length} preliminary findings from evidence sub-batches.`,
    `Consolidate into 2-4 final strategic judgments. Merge overlapping findings.`,
    "",
    "PRELIMINARY FINDINGS:",
    "",
  ];

  allPreliminaryFindings.forEach((f, i) => {
    // Include the actual evidence IDs from the map phase so the model can copy them
    const ids = (f.evidence_ids || []).filter(id => id in evidenceIndex);
    lines.push(`[F${i+1}] ${f.finding}`);
    lines.push(`  WHAT CHANGED: ${f.what_changed}`);
    lines.push(`  MECHANISM: ${f.causal_mechanism}`);
    lines.push(`  WHY IT MATTERS: ${f.why_this_matters}`);
    lines.push(`  CONFIDENCE: ${f.confidence} | MATURITY: ${f.evidence_maturity}`);
    lines.push(`  VALID ev- IDs for this finding: ${ids.length ? ids.join(", ") : "(none resolved)"}`);
    lines.push("");
  });

  lines.push("EVIDENCE FACTS (for grounding — copy the [ev-...] IDs into evidence_for[]):");
  lines.push("");
  for (const [id, ev] of Object.entries(evidenceIndex)) {
    lines.push(`[${id}] ${ev.fact?.slice(0, 100) || ""} [${ev.trust_tier}]`);
  }

  return lines.join("\n");
}

// Returns { raw, evidenceIndex } so the caller can evaluate judgments against
// the full merged index (not just the single-chunk dossier).
async function callSynthesisMapReduce(category, pack, sources, corpusSummary, opts) {
  const chunks = buildChunks(pack);

  // Single chunk — no map phase needed, fall back to direct synthesis
  if (chunks.length === 1) {
    const { dossier_text, evidence_index } = buildDossier(category, pack, sources, corpusSummary, chunks[0]);
    const raw = await callSynthesis(category, dossier_text, opts);
    return { raw, evidenceIndex: evidence_index };
  }

  process.stdout.write(`  [L6] ${category}: ${chunks.length} evidence chunks → parallel map...\n`);

  // Build a merged evidence index across all chunks for the consolidation call
  const mergedEvidenceIndex = {};

  // ── Map phase: parallel synthesis on each chunk ───────────────────────────
  const mapSys = `You are a threat intelligence analyst extracting preliminary findings from an evidence batch.
Extract 2-5 concrete, specific preliminary findings from the evidence provided.
Each finding must be directly supported by specific evidence IDs from this batch.
Focus on WHAT is demonstrated, not general observations.
Return JSON with "preliminary_findings" array.`;

  const mapResults = await Promise.all(chunks.map(async (chunk, idx) => {
    const { dossier_text, evidence_index } = buildDossier(category, pack, sources, corpusSummary, chunk);
    Object.assign(mergedEvidenceIndex, evidence_index);

    const mapUsr = `Extract preliminary findings from this evidence batch (batch ${idx+1} of ${chunks.length}):\n\n${dossier_text}`;
    try {
      let raw;
      try {
        const { result } = await routedLLM(mapSys, mapUsr, {
          task: "category_synthesis",
          requires_json: true,
          schema: PRELIMINARY_SCHEMA,
        });
        raw = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        const text = await callLLM(mapSys, mapUsr, { schema: PRELIMINARY_SCHEMA, json: true });
        raw = typeof text === "string" ? JSON.parse(text) : text;
      }
      return raw?.preliminary_findings || [];
    } catch (err) {
      process.stdout.write(`  [L6] chunk ${idx+1} failed: ${err.message}\n`);
      return [];
    }
  }));

  const allFindingsRaw = mapResults.flat();

  // Cap at 12 findings for consolidation — rank by confidence+maturity so
  // the best signals survive. More than 12 makes the consolidation prompt
  // too large and causes providers to timeout or return null.
  const MATURITY_RANK = { operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3, disclosed_vulnerability: 2, research_demonstration: 1 };
  const CONF_RANK = { high: 3, medium: 2, low: 1 };
  const allFindings = allFindingsRaw
    .sort((a, b) =>
      ((CONF_RANK[b.confidence]||0) + (MATURITY_RANK[b.evidence_maturity]||0)) -
      ((CONF_RANK[a.confidence]||0) + (MATURITY_RANK[a.evidence_maturity]||0))
    )
    .slice(0, 12);

  process.stdout.write(`  [L6] ${category}: ${allFindingsRaw.length} preliminary findings (top ${allFindings.length} selected) → consolidation call\n`);

  if (allFindings.length === 0) {
    // All chunks failed — fall back to single-chunk synthesis
    const { dossier_text, evidence_index } = buildDossier(category, pack, sources, corpusSummary);
    const raw = await callSynthesis(category, dossier_text, opts);
    return { raw, evidenceIndex: evidence_index };
  }

  // ── Reduce phase: consolidation call ─────────────────────────────────────
  // Cap consolidation text to ~12K chars to keep prompt within provider limits.
  // The evidence index is the largest section — truncate it if needed.
  const rawConsolidationText = buildConsolidationPrompt(category, allFindings, mergedEvidenceIndex);
  const consolidationText = rawConsolidationText.length > 12000
    ? rawConsolidationText.slice(0, 12000) + "\n[...evidence index truncated for length...]\n"
    : rawConsolidationText;

  const consolidationUsr = `${consolidationText}

Produce 2-4 final strategic judgments that consolidate the preliminary findings above.

CRITICAL RULES:
1. evidence_for[] MUST contain exact IDs from the EVIDENCE INDEX above — IDs start with "ev-" (e.g. "ev-a1b2c3d4-1"). Do NOT use finding numbers (F1, F2) or any other format. Only IDs that appear in the evidence index are valid.
2. Do NOT invent statistics, CVE IDs, product names, percentages, or actor names that are not explicitly stated in the evidence items above. Every factual claim must trace to evidence.
3. Every judgment MUST populate all four fields with ≥1 full sentence each:
   - "judgment": precise falsifiable claim (not a description)
   - "what_changed": specific capability shift or disclosure in this evidence period
   - "causal_mechanism": WHY this is happening now (the technical/economic mechanism)
   - "why_this_matters": which defender assumption breaks; what new attack path opens`;

  let raw;
  try {
    const { result } = await routedLLM(buildSynthesisSystem(), consolidationUsr, {
      task: "category_synthesis",
      requires_json: true,
      schema: CONSOLIDATION_SCHEMA,
    });
    raw = typeof result === "string" ? JSON.parse(result) : result;
  } catch (err1) {
    process.stdout.write(`  [L6] ${category} consolidation primary failed: ${err1.message} — trying callLLM fallback\n`);
    try {
      const text = await callLLM(buildSynthesisSystem(), consolidationUsr, {
        schema: CONSOLIDATION_SCHEMA, json: true,
      });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    } catch (err2) {
      process.stdout.write(`  [L6] ${category} consolidation fallback also failed: ${err2.message}\n`);
      raw = { judgments: [], coverage_assessment: `Consolidation failed: ${err2.message}`, evidence_gaps: [] };
    }
  }

  // Guard: providers can return null or non-object on timeout/truncation
  if (!raw || typeof raw !== "object") {
    raw = { judgments: [], coverage_assessment: "Consolidation returned non-object response", evidence_gaps: [] };
  }

  // Normalise key aliases — some providers return "strategic_judgments" instead
  // of "judgments" despite the schema. Accept both.
  if (!raw.judgments?.length && raw.strategic_judgments?.length) {
    raw = { ...raw, judgments: raw.strategic_judgments };
  }

  const jCount = raw?.judgments?.length ?? 0;
  if (jCount === 0) {
    process.stdout.write(`  [L6] WARNING: ${category} consolidation returned 0 judgments (raw keys: ${Object.keys(raw||{}).join(", ")})\n`);
    const rawStr = JSON.stringify(raw || {}).slice(0, 300);
    process.stdout.write(`  [L6] raw excerpt: ${rawStr}\n`);
  }

  // Return merged evidence index so evaluateJudgments can resolve all IDs
  return { raw, evidenceIndex: mergedEvidenceIndex };
}

async function callSynthesis(category, dossier_text, opts) {
  if (opts.skipLlm) {
    return {
      judgments: [{
        judgment:           `Stub judgment for ${category} (LLM disabled)`,
        what_changed:       "LLM disabled — no change to report",
        why_this_matters:   "LLM disabled — no implication to report",
        causal_mechanism:   "LLM disabled — no mechanism to report",
        confidence:         "low",
        evidence_maturity:  "research_demonstration",
        evidence_for:       [],
        evidence_against:   [],
        caveats:            ["LLM calls disabled — deterministic stub"],
        short_takeaway:     "LLM disabled",
        technique_focus:    [],
        monitoring_signals: [],
        recommended_action: "Enable LLM for real synthesis",
      }],
      outlook_assessment: {
        observed_basis:        "LLM disabled — no assessment",
        likely_next_movement:  "Unknown",
        escalation_trigger:    "Unknown",
        confidence:            "low",
        what_would_invalidate: "Unknown",
      },
      coverage_assessment: "LLM disabled",
      evidence_gaps: [],
    };
  }

  const sys = buildSynthesisSystem();
  const usr = buildSynthesisUser(category, dossier_text);

  async function attempt() {
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "category_synthesis",
        requires_json: true,
        schema: SYNTHESIS_SCHEMA,
      });
      return typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: SYNTHESIS_SCHEMA, json: true });
      return typeof text === "string" ? JSON.parse(text) : text;
    }
  }

  let raw = await attempt();

  // Retry with explicit field-fill instruction if critical analytical fields came back empty.
  // The model sometimes returns "" to satisfy the JSON schema without actual content.
  if (!judgmentsHaveCriticalFields(raw)) {
    process.stdout.write(`  [L6] critical fields empty for ${category} — retrying with explicit instruction...\n`);

    // Identify which fields were empty to give the model targeted feedback
    const emptyFields = [];
    for (const j of (raw?.judgments || [])) {
      for (const f of CRITICAL_FIELDS) {
        if (!j[f] || String(j[f]).trim().length < MIN_FIELD_LEN) {
          if (!emptyFields.includes(f)) emptyFields.push(f);
        }
      }
    }
    const fieldList = emptyFields.join(", ");

    const retryUsr = `${buildSynthesisUser(category, dossier_text)}

RETRY INSTRUCTION: Your previous response returned empty or placeholder values for: ${fieldList}.
These fields are MANDATORY and must each contain at least one full sentence of substantive analysis.
Do NOT return empty strings. Do NOT return "N/A". Write the actual analytical content.
${emptyFields.includes("causal_mechanism") ? `"causal_mechanism" must explain WHY this is happening now — the technical or economic mechanism that makes this possible. Not a restatement of the judgment.` : ""}
${emptyFields.includes("why_this_matters") ? `"why_this_matters" must state which defender assumption breaks and what new attack path opens. Not "this is concerning."` : ""}`;

    try {
      const { result } = await routedLLM(sys, retryUsr, {
        task: "category_synthesis",
        requires_json: true,
        schema: SYNTHESIS_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, retryUsr, { schema: SYNTHESIS_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
  }

  // Normalise key aliases across all providers
  if (!raw?.judgments?.length && raw?.strategic_judgments?.length) {
    raw = { ...raw, judgments: raw.strategic_judgments };
  }

  return raw;
}

// ── Step 3: Evaluate judgments ────────────────────────────────────────────────
// Deterministic rubric. Blocks hollow outputs. No 41K of rule-based claim QA.

function evaluateJudgments(judgments, evidence_index) {
  return judgments.map(j => {
    const issues = [];

    // Hard block: no evidence cited
    const resolvedEvIds = (j.evidence_for || []).filter(id => id in evidence_index);
    if (resolvedEvIds.length === 0) {
      issues.push("no_evidence_cited");
    }

    // Soft flag: LLM embedded analytical content in judgment rather than sub-fields.
    // Judgment text length > 80 chars is sufficient — we do not hard-block on missing
    // sub-fields because the LLM legitimately packs all content into judgment sometimes.
    const judgmentText = j.judgment || "";
    const hasSubFields = (j.what_changed?.length || 0) > 20 && (j.why_this_matters?.length || 0) > 20;
    const hasSubstantiveJudgment = judgmentText.length > 80;
    if (!hasSubFields && !hasSubstantiveJudgment) {
      issues.push("descriptive_not_analytical");
    }

    // Populate what_changed / why_this_matters from judgment text if LLM omitted them.
    // Split on first sentence boundary as a heuristic.
    const sentences = judgmentText.split(/(?<=[.!?])\s+/);
    if (!j.what_changed && sentences.length > 0) {
      j = { ...j, what_changed: sentences[0] || "" };
    }
    if (!j.why_this_matters && sentences.length > 1) {
      j = { ...j, why_this_matters: sentences.slice(1).join(" ").slice(0, 300) };
    }

    // Soft flag: confidence overreach
    if (j.confidence === "high" && resolvedEvIds.length < 2) {
      issues.push("confidence_overreach");
    }

    // Soft flag: no caveats (only expected when evidence is thin)
    if ((j.caveats || []).length === 0 && j.confidence === "low") {
      issues.push("missing_caveats");
    }

    // Only hard-block on no evidence — analytical quality is a warning only
    const blocked = issues.includes("no_evidence_cited");

    return {
      ...j,
      judgment_id:            randomUUID(),
      evidence_for:           resolvedEvIds,
      qa_issues:              issues,
      blocked,
      approved_for_dashboard: !blocked,
      approved_for_slides:    !blocked,
      approved_for_chatbot:   !blocked && j.confidence !== "low",
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesize strategic analysis for a single threat category.
 *
 * @param {string}   category       - Threat category ID
 * @param {object}   pack           - Evidence pack from assembleEvidencePacks()
 * @param {object[]} sources        - All understood sources (for corpus summary)
 * @param {object}   corpusSummary  - Aggregated corpus stats
 * @param {object}   [opts]
 * @returns {Promise<object>}        Category analysis result
 */
export async function synthesizeCategory(category, pack, sources, corpusSummary, opts = {}) {
  const { dossier_text, evidence_index } = buildDossier(category, pack, sources, corpusSummary);

  const allItems = [...(pack?.strong || []), ...(pack?.usable || []), ...(pack?.context || [])];
  if (allItems.length === 0) {
    return {
      category,
      assessment_status: "insufficient_evidence",
      judgments: [],
      evidence_ids: [],
      evidence_gaps: [`No evidence found for ${category}`],
      coverage_assessment: "No evidence in corpus for this category.",
      synthesis_version: SYNTHESIS_VERSION,
    };
  }

  let raw;
  // Single-call synthesis with diversity-selected evidence.
  // map→reduce was attempted but produced worse results: evidence IDs didn't carry
  // through consolidation reliably, prompts caused provider timeouts (8+ hour runs),
  // and the LLM hallucinated during merging. The baseline single-call with
  // selectDiverseEvidence() covers a representative cross-section of techniques
  // within the token budget and produced 13/15 approved in the baseline run.
  const evalIndex = evidence_index;
  try {
    raw = await callSynthesis(category, dossier_text, opts);
  } catch (err) {
    return {
      category,
      assessment_status: "synthesis_error",
      judgments: [],
      evidence_ids: [],
      evidence_gaps: [],
      coverage_assessment: `Synthesis failed: ${err.message}`,
      synthesis_version: SYNTHESIS_VERSION,
      error: err.message,
    };
  }

  // Diagnostic: log how many judgment IDs resolve against the eval index
  const jIn = raw.judgments || [];
  if (jIn.length > 0) {
    const resolvedCounts = jIn.map(j => (j.evidence_for||[]).filter(id => id in evalIndex).length);
    process.stdout.write(`  [L6] ${category}: ${jIn.length} judgments entering eval, index size=${Object.keys(evalIndex).length}, resolved IDs: [${resolvedCounts.join(", ")}]\n`);
  }
  const evaluated = evaluateJudgments(jIn, evalIndex);

  // Step 4: Two-pass QA — analytical quality gate + second-model verification
  const skipLlmQa  = opts.skipLlm || opts.skipQa || false;
  const { judgments: qaed, qa_report } = await qaJudgments(
    evaluated, evidence_index, category, { skipLlmQa }
  );

  const approved = qaed.filter(j => !j.blocked);

  return {
    category,
    assessment_status: approved.length > 0 ? "assessed" : "insufficient_quality",
    judgments: qaed,
    approved_judgment_count: approved.length,
    blocked_judgment_count:  qaed.length - approved.length,
    qa_report,
    evidence_ids:        Object.keys(evalIndex),
    evidence_gaps:       raw.evidence_gaps || [],
    coverage_assessment: raw.coverage_assessment || "",
    outlook_assessment:  raw.outlook_assessment || null,
    synthesis_version:   SYNTHESIS_VERSION,
  };
}

/**
 * Synthesize all categories from evidence packs.
 *
 * @param {object[]} packs         - From extractAllEvidence()
 * @param {object[]} sources       - Understood sources
 * @param {object}   corpusSummary - From buildCorpusSummary()
 * @param {object}   [opts]
 * @returns {Promise<object[]>}    Array of category analyses
 */
export async function synthesizeAllCategories(packs, sources, corpusSummary, opts = {}) {
  const analyses = [];
  for (const pack of packs) {
    process.stdout.write(`  [L6] synthesizing ${pack.category}... `);
    try {
      const analysis = await synthesizeCategory(pack.category, pack, sources, corpusSummary, opts);
      analyses.push(analysis);
      const qa = analysis.qa_report;
      const qaLine = qa
        ? ` [QA: −${qa.analytical_quality_blocked} quality, −${qa.llm_unsupported} unsupported, +${qa.llm_needs_caveat} caveats]`
        : "";
      process.stdout.write(`${analysis.approved_judgment_count || 0} approved${qaLine}\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      analyses.push({
        category: pack.category,
        assessment_status: "error",
        judgments: [],
        error: err.message,
        synthesis_version: SYNTHESIS_VERSION,
      });
    }
  }
  return analyses;
}

// ── Cross-category synthesis ──────────────────────────────────────────────────

const CROSS_CAT_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:                      { type: "string" },
          title:                   { type: "string" },
          categories_involved:     { type: "array", items: { type: "string" } },
          supporting_judgments:    { type: "array", items: { type: "string" } },
          convergence_mechanism:   { type: "string" },
          compounding_effect:      { type: "string" },
          confidence:              { type: "string", enum: ["high", "medium", "low"] },
          actionable_recommendation: { type: "string" },
        },
        required: ["title", "categories_involved", "convergence_mechanism", "compounding_effect", "actionable_recommendation"],
      },
    },
    ecosystem_assessment: { type: "string" },
    top_priority:         { type: "string" },
  },
  required: ["patterns", "ecosystem_assessment"],
};

// Normalise pattern fields: add backward-compat aliases so downstream consumers
// (dashboard, chatbot) can read either the new rich fields or the legacy names.
function normalisePatterns(raw) {
  const patterns = (raw?.patterns || []).map(p => ({
    ...p,
    // Aliases for downstream consumers that read legacy field names
    pattern:     p.title || p.pattern || "",
    description: p.convergence_mechanism || p.description || "",
    categories:  p.categories_involved   || p.categories  || [],
    implication: p.actionable_recommendation || p.implication || "",
  }));
  return { ...raw, patterns };
}

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats (attacks on ML models: data poisoning, model extraction, adversarial evasion)",
  llm_threats:            "LLM Threats (prompt injection, jailbreaks, RAG poisoning, guardrail bypass)",
  agentic_ai_threats:     "Agentic AI Threats (agent hijacking, tool misuse, MCP abuse, memory poisoning)",
  ai_enabled_threats:     "AI-Enabled Threats (AI as attack tool: deepfakes, AI phishing, AI malware)",
};

/**
 * Run a cross-category synthesis pass (one call) to find convergence patterns.
 * Passes full analytical content per judgment so the model can reason across categories.
 */
export async function synthesizeCrossCategory(categoryAnalyses, opts = {}) {
  const approved = categoryAnalyses.flatMap(ca =>
    (ca.judgments || []).filter(j => !j.blocked).map(j => ({
      category:        ca.category,
      category_label:  CATEGORY_LABELS[ca.category] || ca.category,
      judgment:        j.judgment        || "",
      what_changed:    j.what_changed    || "",
      causal_mechanism: j.causal_mechanism || "",
      why_this_matters: j.why_this_matters || "",
      confidence:      j.confidence      || "low",
      evidence_maturity: j.evidence_maturity || "",
      caveats:         (j.caveats || []).join("; "),
    }))
  );

  if (approved.length < 2 || opts.skipLlm) {
    return { patterns: [], ecosystem_assessment: "Insufficient approved judgments for cross-category synthesis." };
  }

  // Group by category for the prompt
  const byCategory = {};
  for (const j of approved) {
    if (!byCategory[j.category]) byCategory[j.category] = [];
    byCategory[j.category].push(j);
  }

  const judgmentBlock = Object.entries(byCategory).map(([cat, judgments]) => {
    const label = CATEGORY_LABELS[cat] || cat;
    const items = judgments.map((j, i) =>
      `  [${i+1}] ${j.judgment} (${j.confidence} confidence, ${j.evidence_maturity})
       MECHANISM: ${j.causal_mechanism}
       IMPLICATION: ${j.why_this_matters}`
    ).join("\n\n");
    return `── ${label} ──\n${items}`;
  }).join("\n\n");

  const sys = `You are a principal AI threat intelligence analyst producing an ecosystem-level assessment for a cybersecurity leadership briefing.

Your task: identify concrete patterns that span multiple threat categories. A cross-category pattern is a finding where:
  - The same attacker technique appears across different AI system types (e.g., supply-chain poisoning affecting both ML models and LLM RAG pipelines)
  - A capability demonstrated in one category lowers the barrier to attacks in another (e.g., AI-generated exploit code enabling model extraction at scale)
  - Two or more threats compound each other when they co-occur (e.g., prompt injection enabling agent tool misuse escalates to AI-enabled malware delivery)

Rules:
- Only identify patterns genuinely supported by the specific judgments provided — do not generalise beyond the evidence
- Every pattern must name at least 2 specific categories from the input
- Patterns must be specific and actionable, not generic observations like "AI threats are increasing"
- If no genuine cross-category pattern exists, return an empty patterns array with an honest ecosystem_assessment
- ecosystem_assessment: 2-3 sentences on the overall AI threat posture from this corpus
- top_priority: the single most important thing a defender should act on NOW based on cross-category evidence`;

  const usr = `Identify cross-category convergence patterns from these ${approved.length} approved judgments across ${Object.keys(byCategory).length} threat categories:

${judgmentBlock}

Return 1-3 genuine cross-category patterns, or an empty array if none exist.`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "cross_category_synthesis",
        requires_json: true,
        schema: CROSS_CAT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: CROSS_CAT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return normalisePatterns(raw) || { patterns: [], ecosystem_assessment: "No response from synthesis model." };
  } catch (err) {
    return { patterns: [], ecosystem_assessment: `Cross-category synthesis error: ${err.message}` };
  }
}
