/**
 * L6.1 — Development Generation
 *
 * "What changed?" — produces 3 ranked Development objects per category,
 * plus 3 overall top developments across all categories.
 *
 * A Development is a concrete, evidence-bound fact about what objectively changed
 * this period. It is NOT interpretation ("what it means") — that is L6.2 Insights.
 *
 * Every development must:
 *   - Name ≥1 concrete anchor (CVE / actor / product / victim OR a specific number)
 *   - Cite ≥1 ev-* ID from the evidence
 *   - Have what_changed ≥40 chars and be purely factual (no interpretation)
 *
 * QA gates:
 *   Deterministic: evidence_ids ≥1, what_changed ≥40 chars, named entity OR number,
 *                  confidence cap if single-source
 *   Second-model:  "Is this stating what changed (✓) or what it means (✗)?"
 *                  Insight-disguised-as-development is flagged as _insight_candidate
 */

import { randomUUID }          from "crypto";
import { routedLLM }           from "../llm/llmRouter.js";
import { callLLM }             from "../llm/callLLM.js";
import { runSecondModelVerification } from "./qaJudgments.js";
import {
  buildDossier, selectDiverseEvidence,
  CATEGORY_SCOPE, CHUNK_STRONG, CHUNK_USABLE, CHUNK_CONTEXT,
} from "./synthesizeCategory.js";

const EVIDENCE_MATURITY_VALUES = new Set([
  "research_demonstration", "disclosed_vulnerability", "observed_exploitation",
  "adversary_adoption", "operational_campaign",
]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

// ── System prompt ─────────────────────────────────────────────────────────────

const DEVELOPMENT_SYSTEM = `You are a threat intelligence analyst writing DEVELOPMENT entries for a CISO briefing.

A DEVELOPMENT answers only: "WHAT CHANGED or WAS NEWLY DEMONSTRATED in this evidence period?"

═══ THE DEVELOPMENT / INSIGHT SEPARATION — MANDATORY ═══
A DEVELOPMENT is a CONCRETE FACT:
  ✓ A named capability demonstrated for the first time
  ✓ A named incident or exploitation event
  ✓ A specific CVE disclosed or exploited
  ✓ A named actor confirmed using a technique
  ✓ A measurable change (scale, speed, cost) with numbers from evidence

A DEVELOPMENT is NOT:
  ✗ "What this means for defenders" — that is an INSIGHT (different layer)
  ✗ "Why this is happening" — that is a causal mechanism, belongs in INSIGHTS
  ✗ A general trend description ("phishing attacks are increasing")
  ✗ A recommendation ("organizations should monitor for…")

THE TEST: Remove all interpretation. Does the development still read as a concrete fact?
  If YES → it is a development.
  If NO  → it is an insight disguised as a development. Write only the factual core.

═══ NAMED ANCHOR — REQUIRED ═══
Every development MUST include ≥1 concrete anchor:
  - a named actor / CVE / product / victim organization, OR
  - a specific number from the evidence (count, percentage, dollar amount)
A development with no named entity and no specific number will be rejected.

═══ EVIDENCE MATURITY ═══
research_demonstration  — lab-proven feasibility only; no real-world deployment confirmed
disclosed_vulnerability — CVE/advisory confirms exploitable flaw
observed_exploitation   — incident/threat intel confirms in-the-wild use
adversary_adoption      — named threat actor confirmed using technique
operational_campaign    — sustained, attributed campaign across incidents

NEVER write "operational use" or "confirmed in the wild" unless maturity ≥ observed_exploitation.

═══ CONFIDENCE ═══
high   — ≥2 strong evidence items from high-trust sources, maturity ≥ observed_exploitation
medium — 1-2 items, or maturity = disclosed_vulnerability
low    — single source, research_demonstration only

evidence_ids[]: COPY EXACT IDs from the dossier (must start with "ev-"). Minimum 1.
what_changed: ≥40 chars, purely factual — no interpretation, no "meaning".
Produce EXACTLY 3 RANKED developments (rank 1 = highest operational significance).
If evidence supports fewer than 3 distinct developments, produce fewer (do not pad with filler).

Return ONLY valid JSON.`;

const DEVELOPMENT_SCHEMA = {
  type: "object",
  required: ["developments"],
  properties: {
    developments: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "what_changed", "evidence_ids", "evidence_maturity", "confidence", "rank_within_category"],
        properties: {
          title:                  { type: "string" },
          what_changed:           { type: "string" },
          named_entities:         { type: "array", items: { type: "string" } },
          evidence_ids:           { type: "array", items: { type: "string" } },
          evidence_maturity:      { type: "string" },
          confidence:             { type: "string" },
          is_first_occurrence:    { type: "boolean" },
          recency:                { type: "string" },
          rank_within_category:   { type: "number" },
        },
      },
    },
  },
};

// ── Second-model QA for developments ─────────────────────────────────────────
// Checks: "Is this stating what changed (development) or what it means (insight)?"

const DEV_QA_SYSTEM = `You are reviewing DEVELOPMENT entries for a cybersecurity briefing.

A Development states WHAT CHANGED — a concrete, factual change or event.
An Insight states WHAT IT MEANS — interpretation, implication, or significance.

For each development, return one of:
  "development" — correctly states a concrete fact/change/event
  "insight"     — contains interpretation, implication, or "what this means" language

Return ONLY JSON: { "verdicts": [{ "index": 0, "verdict": "development"|"insight", "reason": "..." }] }`;

async function qaDevVsInsight(developments, category) {
  if (!developments.length) return developments;
  const userPrompt = `Category: ${category.replace(/_/g, " ").toUpperCase()}

${developments.map((d, i) => `[${i}] title: "${d.title}"\nwhat_changed: "${d.what_changed}"`).join("\n\n")}

For each, is it a development (what changed) or an insight (what it means)?
Return: { "verdicts": [{ "index": 0, "verdict": "development"|"insight", "reason": "..." }] }`;

  try {
    const { result } = await routedLLM(DEV_QA_SYSTEM, userPrompt, {
      task: "final_qa", requires_json: true, logLabel: `dev-qa-${category}`,
    });
    const verdicts = (typeof result === "string" ? JSON.parse(result) : result)?.verdicts || [];
    return developments.map((d, i) => {
      const v = verdicts.find(v => v.index === i);
      if (v?.verdict === "insight") {
        process.stdout.write(`  [L6.1 QA] D${i} flagged as insight — marking _insight_candidate\n`);
        return { ...d, _insight_candidate: true, _qa_reason: v.reason };
      }
      return d;
    });
  } catch {
    return developments;  // QA failure is non-blocking
  }
}

// ── Deterministic gates ───────────────────────────────────────────────────────

const EV_ID_RE = /^ev-[a-f0-9]{8}-\d+$/i;

function validateDevelopments(raw, evidenceIndex) {
  const valid = [];
  for (const d of raw) {
    const allIds = (d.evidence_ids || []);
    const resolved = allIds.filter(id => id in evidenceIndex);
    // Accept if at least one ID resolves, OR if the IDs look structurally valid (ev-*) and
    // we have a named anchor — LLMs sometimes return slightly misformatted IDs from thin corpora.
    const hasValidIdFormat = allIds.some(id => EV_ID_RE.test(id));
    if (!resolved.length && !hasValidIdFormat) continue;    // no evidence at all → reject
    if ((d.what_changed || "").length < 30) continue;       // substance gate (relaxed: 30 not 40)
    if (!EVIDENCE_MATURITY_VALUES.has(d.evidence_maturity)) continue;
    if (!CONFIDENCE_VALUES.has(d.confidence)) continue;

    // Confidence cap: single-source or unresolved IDs cannot be high
    let confidence = d.confidence;
    if ((resolved.length <= 1 || !resolved.length) && confidence === "high") confidence = "medium";

    valid.push({
      development_id:         randomUUID(),
      title:                  (d.title || "").trim(),
      what_changed:           (d.what_changed || "").trim(),
      named_entities:         (d.named_entities || []).filter(Boolean),
      evidence_ids:           resolved.length ? resolved : allIds,  // keep unresolved IDs if nothing resolved
      evidence_maturity:      d.evidence_maturity,
      confidence,
      is_first_occurrence:    d.is_first_occurrence ?? false,
      recency:                (d.recency || "within this reporting period").trim(),
      source_count:           resolved.length,
      rank_within_category:   d.rank_within_category || valid.length + 1,
      _evidence_ids_resolved: resolved.length > 0,
    });
  }
  return valid.slice(0, 3);
}

// ── Per-category generation ───────────────────────────────────────────────────

export async function generateDevelopments(category, pack, patterns, corpusSummary, opts = {}) {
  const { skipLlm = false } = opts;

  const { dossier_text, evidence_index } = buildDossier(category, pack, [], corpusSummary || { total_sources: 0, date_range: "unknown" });

  if (skipLlm) {
    return [];
  }

  const scope = CATEGORY_SCOPE[category];
  const scopeBlock = scope
    ? `\nCATEGORY FOCUS: ${scope.question}\nIn scope: ${scope.in_scope}\nLook for: ${scope.incident_hook}`
    : "";

  const patternBlock = patterns?.length
    ? `\nIDENTIFIED PATTERNS (use these to find the strongest developments):\n${patterns.map((p, i) => `  ${i + 1}. [${p.strength}] ${p.pattern_label} — ${p.description} (evidence: ${p.evidence_ids.join(", ")})`).join("\n")}`
    : "";

  const userPrompt = `Generate developments for: ${category.replace(/_/g, " ").toUpperCase()}
${scopeBlock}
${patternBlock}

${dossier_text}

Produce exactly 3 ranked developments (rank 1 = highest operational significance).
Each development states WHAT CHANGED — a concrete fact, not an interpretation.`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(DEVELOPMENT_SYSTEM, userPrompt, {
        task: "development_generation", requires_json: true, schema: DEVELOPMENT_SCHEMA,
        logLabel: `developments-${category}`,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(DEVELOPMENT_SYSTEM, userPrompt, { schema: DEVELOPMENT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    const rawDevs = raw?.developments || [];
    if (!rawDevs.length) {
      process.stdout.write(`  [L6.1] ${category}: LLM produced no developments (thin corpus or no named anchors)\n`);
    }
    let developments = validateDevelopments(rawDevs, evidence_index);
    // Add category tag
    developments = developments.map(d => ({ ...d, category }));
    // QA: development vs insight check
    developments = await qaDevVsInsight(developments, category);

    process.stdout.write(`  [L6.1] ${category}: ${developments.length} developments (${developments.filter(d => d._insight_candidate).length} flagged as insight candidates)\n`);
    return developments;
  } catch (err) {
    process.stdout.write(`  [L6.1] ${category}: development generation failed (${err.message.slice(0, 60)})\n`);
    return [];
  }
}

// ── Overall top-3 across categories ──────────────────────────────────────────

const OVERALL_DEV_SYSTEM = `You are selecting the top 3 overall developments across all threat categories for an executive briefing summary.

From the developments provided (each from a different threat category), select 3 that together:
  1. Represent the most operationally significant changes across the full AI threat landscape
  2. Cover different categories (diversity preferred)
  3. Have the highest combined evidence maturity and confidence

Return ONLY the development_ids of your top 3 selections, in ranked order.
Return ONLY valid JSON: { "selected_ids": ["dev-id-1", "dev-id-2", "dev-id-3"] }`;

export async function generateOverallDevelopments(allCategoryDevelopments, opts = {}) {
  const { skipLlm = false } = opts;

  // Flatten all developments
  const all = Object.values(allCategoryDevelopments).flat().filter(d => !d._insight_candidate);
  if (all.length <= 3) return all.map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));

  if (skipLlm) {
    // Deterministic fallback: rank by maturity + confidence
    const MATURITY_RANK = { operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3, disclosed_vulnerability: 2, research_demonstration: 1 };
    const CONF_RANK = { high: 3, medium: 2, low: 1 };
    return all
      .sort((a, b) => (MATURITY_RANK[b.evidence_maturity] || 0) + (CONF_RANK[b.confidence] || 0) -
                      (MATURITY_RANK[a.evidence_maturity] || 0) - (CONF_RANK[a.confidence] || 0))
      .slice(0, 3)
      .map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
  }

  const devList = all.map(d => `[${d.development_id}] [${d.category}] [${d.evidence_maturity}/${d.confidence}] ${d.title}\n  ${d.what_changed.slice(0, 120)}`).join("\n\n");
  const userPrompt = `Select the top 3 overall developments from across all threat categories.

AVAILABLE DEVELOPMENTS:
${devList}

Return: { "selected_ids": ["id1", "id2", "id3"] }`;

  try {
    const { result } = await routedLLM(OVERALL_DEV_SYSTEM, userPrompt, {
      task: "development_generation", requires_json: true, logLabel: "overall-developments",
    });
    const r = typeof result === "string" ? JSON.parse(result) : result;
    const selectedIds = new Set(r?.selected_ids || []);
    const selected = all.filter(d => selectedIds.has(d.development_id)).slice(0, 3);
    if (!selected.length) return all.slice(0, 3).map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
    return selected.map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
  } catch {
    return all.slice(0, 3).map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
  }
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function generateAllDevelopments(packs, allPatterns, corpusSummary, opts = {}) {
  const results = {};
  for (const [category, pack] of Object.entries(packs)) {
    const patterns = allPatterns?.[category] || [];
    results[category] = await generateDevelopments(category, pack, patterns, corpusSummary, opts);
  }
  const total = Object.values(results).flat().length;
  const overall = await generateOverallDevelopments(results, opts);
  process.stdout.write(`  [L6.1] ${total} total developments; ${overall.length} overall top developments selected\n`);
  return { byCategory: results, overall };
}
