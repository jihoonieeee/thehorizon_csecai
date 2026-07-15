/**
 * L6.3 — Case Study Selection
 *
 * LLM-guided selection of the best case study per threat category.
 * A case study is a SINGLE named incident or entity told as a concrete attack story.
 *
 * Selection criteria (ranked):
 *   1. Has a named entity (CVE / actor / malware / victim org) confirmed in evidence
 *   2. Has outcome data (scale, impact, victim count) in evidence
 *   3. Has ≥2 distinct attack stages in evidence (enabling an attack-chain diagram)
 *   4. Grounded in ≥2 evidence items
 *   5. AI role is confirmed in the fact text (required for ai_enabled_threats)
 *
 * QA: deterministic only — selection criteria are concrete enough.
 * If NO candidate meets criteria 1-3, output null (no case study for that category).
 */

import { randomUUID }  from "crypto";
import { routedLLM }   from "../../llm/llmRouter.js";
import { callLLM }     from "../../llm/callLLM.js";
import { loadPrompt } from "../../prompts/promptLoader.js";

// ── Entity and nexus detection ────────────────────────────────────────────────

const CVE_RE       = /\bCVE-\d{4}-\d{4,}\b/i;
const ACTOR_RE     = /\b(APT\d+|lazarus|sandworm|cozy bear|fancy bear|volt typhoon|scattered spider|lapsus|cl0p|alphv|lockbit|blackcat|conti|revil|darkside|ryuk|evil corp|ta\d+|unc\d+|cobalt group|fin\d+)\b/i;
const PRODUCT_RE   = /\b(openai|anthropic|google|microsoft|langchain|langsmith|hugging ?face|ollama|mistral|llama|gpt-?[34]|claude|gemini|copilot|cursor|mcp|autogpt|crewai|gradio|vllm|ray|mlflow|weights ?& ?biases|kubeflow)\b/i;
const AI_NEXUS_RE  = /\b(llm|gpt|claude|gemini|copilot|chatgpt|ai[- ]generated|ai[- ]assisted|deepfake|synthetic|language model|foundation model|embedding|vector|rag|prompt|agentic|autonomous agent)\b/i;

const CASE_EVIDENCE_TYPES = new Set([
  "incident", "threat_actor_activity", "capability_demonstration",
  "exploit_demonstration", "vulnerability_disclosure",
]);

// ── Candidate building ────────────────────────────────────────────────────────

function extractNamedEntity(ev) {
  const text = `${ev.fact || ""} ${ev.quote || ""}`;
  const cve = text.match(CVE_RE)?.[0];
  if (cve) return cve;
  const actor = text.match(ACTOR_RE)?.[0];
  if (actor) return actor;
  const product = text.match(PRODUCT_RE)?.[0];
  if (product) return product;
  return null;
}

function buildCandidates(pack, evidenceIndex) {
  const candidates = [];
  const seenEntities = new Set();

  // ── Priority path: walkthrough-bearing evidence items ─────────────────────
  // Items from extractLongReportInsights carry explicit actor, steps, impact —
  // far better structured than anything we can reconstruct from entity extraction.
  // Score them highest so the LLM almost always picks a walkthrough-backed case.
  const allEvidence = [...(pack.strong || []), ...(pack.usable || [])];
  for (const ev of allEvidence) {
    if (!ev.walkthrough_steps?.length) continue;
    const entity = ev.walkthrough_actor && ev.walkthrough_actor !== "unattributed"
      ? ev.walkthrough_actor
      : (ev.walkthrough_technique || extractNamedEntity(ev) || "Unknown actor");
    if (seenEntities.has(entity)) continue;
    seenEntities.add(entity);

    const steps = ev.walkthrough_steps;
    const aiNexus = AI_NEXUS_RE.test(`${ev.fact || ""} ${ev.walkthrough_technique || ""} ${ev.walkthrough_mechanism || ""}`);
    candidates.push({
      named_entity:   entity,
      evidence_ids:   [ev.evidence_id],
      evidence_count: 1,
      has_outcome:    Boolean(ev.walkthrough_impact),
      ai_nexus:       aiNexus,
      attack_stages:  steps.map((s, i) => `${i + 1}. ${s}`),
      evidence_types: [ev.evidence_type],
      evidence_summary: `[walkthrough] ${ev.walkthrough_technique || ev.fact?.slice(0, 120)}`,
      _walkthrough_backed: true,
    });
  }

  // ── Fallback path: entity extraction from regular evidence ─────────────────
  const byEntity = {};
  for (const ev of allEvidence) {
    if (ev.walkthrough_steps?.length) continue; // already handled above
    if (!CASE_EVIDENCE_TYPES.has(ev.evidence_type)) continue;
    const entity = extractNamedEntity(ev);
    if (!entity || seenEntities.has(entity)) continue;
    if (!byEntity[entity]) byEntity[entity] = [];
    byEntity[entity].push(ev);
  }

  for (const [entity, items] of Object.entries(byEntity)) {
    const hasOutcome  = items.some(ev => (ev.numbers || []).length > 0 || /victim|affected|breach|stole|exfil|ransom|impact/i.test(ev.fact || ""));
    const aiNexus     = items.some(ev => AI_NEXUS_RE.test(`${ev.fact || ""} ${ev.quote || ""}`));
    const uniqueTypes = new Set(items.map(ev => ev.evidence_type));
    const attackStages = items.length >= 2
      ? [`Initial: ${items[0].fact?.slice(0, 60) || "unknown"}`, `Outcome: ${items[items.length - 1].fact?.slice(0, 60) || "unknown"}`]
      : [];
    candidates.push({
      named_entity:  entity,
      evidence_ids:  items.map(ev => ev.evidence_id),
      evidence_count: items.length,
      has_outcome:   hasOutcome,
      ai_nexus:      aiNexus,
      attack_stages: attackStages,
      evidence_types: [...uniqueTypes],
      evidence_summary: items.slice(0, 3).map(ev => ev.fact?.slice(0, 120) || "").filter(Boolean).join(" | "),
      _walkthrough_backed: false,
    });
  }

  // Score candidates against the 5 selection criteria with recommended weightings:
  //   30% strategic representativeness — illustrates the category's main theme
  //   25% evidence quality            — walkthrough-backed, outcome data, multi-item
  //   20% attack-chain clarity        — ≥3 distinct stages enable a diagram
  //   15% leadership relevance        — named victim/actor makes it tangible
  //   10% novelty                     — adds insight beyond a bare summary
  function candidateScore(c) {
    // 30% strategic representativeness: AI nexus + walkthrough (proxy for theme alignment)
    const representativeness = (c.ai_nexus ? 15 : 0) + (c._walkthrough_backed ? 15 : 0);
    // 25% evidence quality: outcome data + multi-item ground truth
    const evidenceQuality = (c.has_outcome ? 15 : 0) + (c.evidence_count >= 2 ? 10 : 0);
    // 20% attack-chain clarity: ≥3 stages = cleaner diagram
    const chainClarity = c.attack_stages.length >= 3 ? 20 : c.attack_stages.length >= 2 ? 10 : 0;
    // 15% leadership relevance: named actor or victim in the entity string
    const namedEntityScore = /\b(APT|lazarus|sandworm|volt typhoon|scattered spider|lapsus|group|actor|campaign|inc ransom|lockbit|alphv)/i.test(c.named_entity || "")
      ? 15 : c.named_entity ? 8 : 0;
    // 10% novelty: walkthrough-backed candidates tend to be from primary analysis reports
    const novelty = c._walkthrough_backed ? 10 : c.evidence_count >= 3 ? 5 : 0;
    return representativeness + evidenceQuality + chainClarity + namedEntityScore + novelty;
  }

  return candidates
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, 8);
}

// ── LLM selection prompt ──────────────────────────────────────────────────────

const SELECTION_SYSTEM = loadPrompt("analysis/select-case-study").system;

const SELECTION_SCHEMA = {
  type: "object",
  required: ["selected"],
  properties: {
    selected: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: ["named_entity", "why_selected", "attack_stages"],
          properties: {
            named_entity:  { type: "string" },
            why_selected:  { type: "string" },
            attack_stages: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    reason:               { type: "string" },
    rejected_alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          named_entity:     { type: "string" },
          rejection_reason: { type: "string" },
        },
      },
    },
  },
};

// ── Per-category selection ────────────────────────────────────────────────────

export async function selectCaseStudy(category, pack, evidenceIndex, opts = {}) {
  const { skipLlm = false } = opts;

  const candidates = buildCandidates(pack, evidenceIndex);
  if (!candidates.length) return null;

  // Deterministic early pass: if only one candidate and it meets minimum criteria, use it.
  // Require ≥3 attack stages for attack-chain diagram value; accept 2 as fallback.
  if (candidates.length === 1) {
    const c = candidates[0];
    if (c.evidence_count < 2) return null;
    if (!c.has_outcome && c.attack_stages.length < 2) return null;
    if (category === "ai_enabled_threats" && !c.ai_nexus) return null;
    return buildResult(c, category, []);
  }

  if (skipLlm) {
    // Prefer candidates with ≥3 stages; fall back to ≥2 stages when none qualify.
    const best = candidates.find(c => c.evidence_count >= 2 && c.has_outcome && c.attack_stages.length >= 3)
              || candidates.find(c => c.evidence_count >= 2 && c.has_outcome);
    if (!best) return null;
    if (category === "ai_enabled_threats" && !best.ai_nexus) return null;
    return buildResult(best, category, candidates.filter(c => c !== best).map(c => ({ named_entity: c.named_entity, rejection_reason: "not selected" })));
  }

  const userPrompt = `Select the best case study for: ${category.replace(/_/g, " ").toUpperCase()}
${category === "ai_enabled_threats" ? "\nNOTE: AI role must be explicit in the evidence text for this category.\n" : ""}
CANDIDATES:
${candidates.map((c, i) => `[${i + 1}] Entity: ${c.named_entity}
  Evidence items: ${c.evidence_count} (types: ${c.evidence_types.join(", ")})
  Has outcome data: ${c.has_outcome}
  AI nexus: ${c.ai_nexus}
  Attack stages: ${c.attack_stages.length}
  Evidence summary: ${c.evidence_summary}`).join("\n\n")}

Return: { "selected": { "named_entity": "...", "why_selected": "...", "attack_stages": ["step1", "step2", ...] } | null, "rejected_alternatives": [...] }`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(SELECTION_SYSTEM, userPrompt, {
        task: "case_study_selection", requires_json: true, schema: SELECTION_SCHEMA,
        logLabel: `case-select-${category}`,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(SELECTION_SYSTEM, userPrompt, { schema: SELECTION_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    if (!raw?.selected) {
      process.stdout.write(`  [L6.3] ${category}: no case study selected (${(raw?.reason || "no suitable candidate").slice(0, 60)})\n`);
      return null;
    }

    const selectedEntity = raw.selected.named_entity;
    const candidate = candidates.find(c => c.named_entity === selectedEntity) || candidates[0];

    // Deterministic gates — require a named entity, ≥2 evidence items, and AI nexus
    // for ai_enabled category. We accept 2 attack stages when the LLM selects a
    // candidate because the LLM may have identified a better narrative than auto-scoring.
    if (!selectedEntity || selectedEntity.length < 2) return null;
    if (candidate.evidence_count < 2) return null;
    if (candidate.attack_stages.length < 2) return null;
    if (category === "ai_enabled_threats" && !candidate.ai_nexus) return null;

    const result = buildResult(
      { ...candidate, attack_stages: raw.selected.attack_stages || candidate.attack_stages },
      category,
      raw.rejected_alternatives || [],
      raw.selected.why_selected,
    );
    process.stdout.write(`  [L6.3] ${category}: selected "${selectedEntity}" (${candidate.evidence_count} evidence items)\n`);
    return result;
  } catch (err) {
    process.stdout.write(`  [L6.3] ${category}: selection failed (${err.message.slice(0, 60)}) — skipping case study\n`);
    return null;
  }
}

function buildResult(candidate, category, rejectedAlternatives, whySelected = "Best evidence grounding and named entity") {
  // Prefer ≥3 stages for diagram; ≥2 is acceptable as fallback.
  const diagEligible = candidate.attack_stages.length >= 3;
  return {
    selection_id:          randomUUID(),
    category,
    case_title:            candidate.named_entity,
    named_entity:          candidate.named_entity,
    attack_stages:         candidate.attack_stages,
    evidence_ids:          candidate.evidence_ids,
    ai_nexus_confirmed:    candidate.ai_nexus,
    has_outcome_evidence:  candidate.has_outcome,
    diagram_eligible:      diagEligible,
    why_selected:          whySelected,
    rejected_alternatives: rejectedAlternatives,
  };
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function selectAllCaseStudies(packs, evidenceIndex, opts = {}) {
  const results = {};
  for (const [category, pack] of Object.entries(packs)) {
    results[category] = await selectCaseStudy(category, pack, evidenceIndex, opts);
  }
  const selected = Object.values(results).filter(Boolean).length;
  process.stdout.write(`  [L6.3] ${selected}/${Object.keys(packs).length} categories have a case study\n`);
  return results;
}
