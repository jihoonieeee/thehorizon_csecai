/**
 * v2 — buildPresentation()
 *
 * Replaces the L7/L8 stack (planSlides 67K, generateSlideContent 79K,
 * selectSlideArgumentForm 26K, qaSlideContent 47K) with:
 *
 *   Step 1  planDeck()           ONE Sonnet call → slide plan (argument per slide)
 *   Step 2  generateSlides()     N Sonnet calls (one per slide) → headline/bullets/notes
 *   Step 3  validateTraceability() deterministic — all evidence IDs must resolve
 *
 * No pre-determined argument form taxonomy. The LLM selects the best
 * narrative structure for each slide given the evidence.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { callLLM }   from "../../llm/callLLM.js";

export const DECK_VERSION = "deck-v2.1";

// ── Step 1: Deterministic deck structure ──────────────────────────────────────
//
// The top-level structure is fixed (not LLM-planned). Per-category evidence slides
// (top_happenings, category_trends, category_insights) are still LLM-generated,
// but we control the ordering and mandatory slides deterministically.
//
// Fixed structure:
//   1  cover
//   2  scope_methodology      (deterministic — from corpus stats)
//   3  evidence_snapshot      (deterministic — from evidence pack distribution)
//   4  executive_summary      (LLM — 3-5 plain-English judgments)
//  [Per category, in fixed order: traditional → llm → agentic → ai_enabled]
//   N  category_section_intro (deterministic heading)
//   N  top_happenings         (LLM — concrete source-backed developments)
//   N  category_trends        (LLM — patterns across sources, explicit evidence count)
//   N  category_insights      (LLM — higher-order interpretation)
//   N  monitoring_signals     (LLM — structured signals from synthesis)
//  [After all categories]
//   N  early_signals_watchlist (deterministic from synthesis early_signals)
//   N  outlook_structured      (deterministic from synthesis outlook_assessment)
//   N  cross_category          (LLM — only if patterns found)
//   N  evidence_gaps           (deterministic from synthesis evidence_gaps)
//   N  references              (deterministic)

const CATEGORY_ORDER = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// Deterministic scope slide — no LLM.
function buildScopeSlide(corpusSummary, sourcesByCategory) {
  const total     = corpusSummary.total_sources || 0;
  const dateRange = corpusSummary.date_range    || "unknown";
  const catLines  = CATEGORY_ORDER.map(c =>
    `${CATEGORY_LABELS[c]}: ${sourcesByCategory[c] || 0} sources`
  );
  return {
    type:          "scope_methodology",
    slide_number:  2,
    headline:      `${total} validated sources — ${dateRange}`,
    argument:      "Scope and methodology for this briefing",
    bullets: [
      { text: `Reporting window: ${dateRange}`, bullet_type: "context" },
      { text: `Total sources: ${total} (after L3 validation + L4 relevance classification)`, bullet_type: "context" },
      ...catLines.map(l => ({ text: l, bullet_type: "context" })),
      { text: "Evidence maturity: research_demonstration to operational_campaign (see Evidence Snapshot slide)", bullet_type: "context" },
    ],
    speaker_notes: `This briefing covers ${total} sources from ${dateRange}. All sources passed automated L3 relevance validation and L4 threat-category classification. Claims are graded by evidence maturity level: research_demonstration (lab-proven), disclosed_vulnerability (CVE/advisory), observed_exploitation (in-the-wild), adversary_adoption (actor confirmed), or operational_campaign (sustained attributed activity).`,
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic evidence snapshot slide — no LLM.
function buildEvidenceSnapshotSlide(categoryAnalyses, evidenceItems) {
  const maturityCounts = {};
  const typeCounts     = {};
  categoryAnalyses.forEach(ca => {
    (ca.judgments || []).filter(j => !j.blocked).forEach(j => {
      const m = j.evidence_maturity || "unknown";
      maturityCounts[m] = (maturityCounts[m] || 0) + 1;
    });
  });
  evidenceItems.forEach(ei => {
    typeCounts[ei.evidence_type] = (typeCounts[ei.evidence_type] || 0) + 1;
  });
  const topTypes = Object.entries(typeCounts).sort(([,a],[,b])=>b-a).slice(0,4)
    .map(([t,n]) => `${t.replace(/_/g," ")}: ${n}`).join(" · ");
  const assessed = categoryAnalyses.filter(ca => ca.assessment_status === "assessed").length;
  const total_judgments = categoryAnalyses.flatMap(ca => (ca.judgments||[]).filter(j=>!j.blocked)).length;

  return {
    type:          "evidence_snapshot",
    slide_number:  3,
    headline:      `${evidenceItems.length} evidence items — ${assessed}/4 categories assessed`,
    argument:      "Evidence distribution and confidence summary for this briefing",
    bullets: [
      { text: `${total_judgments} approved analytical judgments across ${assessed} categories`, bullet_type: "context" },
      { text: `Evidence types: ${topTypes || "mixed"}`, bullet_type: "context" },
      ...(maturityCounts.research_demonstration     ? [{ text: `Research-only (lab-demonstrated only): ${maturityCounts.research_demonstration} findings`, bullet_type: "context" }] : []),
      ...(maturityCounts.disclosed_vulnerability     ? [{ text: `Disclosed vulnerabilities (CVE/advisory confirmed): ${maturityCounts.disclosed_vulnerability} findings`, bullet_type: "context" }] : []),
      ...(maturityCounts.observed_exploitation       ? [{ text: `Observed exploitation (in-the-wild confirmed): ${maturityCounts.observed_exploitation} findings`, bullet_type: "context" }] : []),
      ...(maturityCounts.adversary_adoption          ? [{ text: `Adversary adoption (actor confirmed): ${maturityCounts.adversary_adoption} findings`, bullet_type: "context" }] : []),
      ...(maturityCounts.operational_campaign        ? [{ text: `Operational campaigns (attributed, sustained): ${maturityCounts.operational_campaign} findings`, bullet_type: "context" }] : []),
    ],
    speaker_notes: `Evidence maturity labels appear throughout the briefing to distinguish research demonstrations from operational threats. Do not treat research_demonstration or disclosed_vulnerability findings as confirmed operational threats without additional adversary adoption evidence.`,
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic early signals slide — aggregates structured signals from synthesis.
function buildEarlySignalsSlide(categoryAnalyses, slideNumber) {
  const signals = categoryAnalyses.flatMap(ca => {
    const catLabel = CATEGORY_LABELS[ca.category] || ca.category;
    return (ca.judgments || []).filter(j => !j.blocked).flatMap(j =>
      (j.monitoring_signals || [])
        .filter(s => typeof s === "object" && s.signal)
        .map(s => ({ ...s, category: catLabel }))
    );
  }).slice(0, 6);

  if (signals.length === 0) return null;

  return {
    type:          "early_signals_watchlist",
    slide_number:  slideNumber,
    headline:      "Early Signals Watchlist — What to Monitor Now",
    argument:      "Specific measurable signals that indicate escalation toward operational threat",
    bullets: signals.map(s => ({
      text:        `${s.category}: ${s.signal} — escalation trigger: ${s.escalation_trigger || "unspecified"}`,
      bullet_type: "signal",
      signal_detail: {
        why_it_matters:        s.why_it_matters,
        current_evidence:      s.current_evidence,
        monitoring_source_type: s.monitoring_source_type,
      },
    })),
    speaker_notes: `These signals mark the boundary between research-stage and operational threats. Each has a defined escalation trigger — the specific observable event that would warrant moving from watch to active response. Check ${signals.map(s=>s.monitoring_source_type||"threat intel feeds").filter(Boolean).join(", ")} for these indicators.`,
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic outlook slide — uses structured outlook_assessment from synthesis.
function buildOutlookSlide(categoryAnalyses, slideNumber) {
  const outlooks = categoryAnalyses
    .filter(ca => ca.outlook_assessment && ca.assessment_status === "assessed")
    .map(ca => ({ cat: CATEGORY_LABELS[ca.category] || ca.category, ...ca.outlook_assessment }));

  if (outlooks.length === 0) return null;

  return {
    type:          "outlook_structured",
    slide_number:  slideNumber,
    headline:      "6-Month Outlook — Based on Observed Signals",
    argument:      "Forward-looking assessment with escalation triggers and confidence levels",
    bullets: outlooks.map(o => ({
      text:        `${o.cat}: ${o.likely_next_movement} [${o.confidence} confidence] — escalation trigger: ${o.escalation_trigger}`,
      bullet_type: "implication",
      outlook_detail: {
        observed_basis:        o.observed_basis,
        what_would_invalidate: o.what_would_invalidate,
      },
    })),
    speaker_notes: `These outlooks are grounded in observed evidence, not speculation. Each includes an invalidation condition — the signal that would prove the outlook wrong. Confidence reflects evidence maturity: none of these are operational_campaign-level findings without explicit labelling.`,
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic evidence gaps slide.
function buildEvidenceGapsSlide(categoryAnalyses, slideNumber) {
  const gaps = categoryAnalyses.flatMap(ca => {
    const catLabel = CATEGORY_LABELS[ca.category] || ca.category;
    return (ca.evidence_gaps || []).map(g => `${catLabel}: ${g}`);
  }).slice(0, 8);

  if (gaps.length === 0) return null;

  return {
    type:          "evidence_gaps",
    slide_number:  slideNumber,
    headline:      "Evidence Gaps — Where Intelligence Is Thin",
    argument:      "Known unknowns that limit confidence in the current assessment",
    bullets: gaps.map(g => ({ text: g, bullet_type: "context" })),
    speaker_notes: "These gaps represent areas where the current corpus is insufficient for high-confidence assessment. Filling these gaps should drive intelligence collection priorities for the next reporting cycle.",
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Per-category LLM slide types.
const CATEGORY_SLIDE_SCHEMA = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slide_type: { type: "string", enum: [
            "top_happenings",
            "category_trends",
            "category_insights",
            "monitoring_signals",
            "case_study",
          ]},
          argument:     { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
          judgment_id:  { type: "string" },
        },
        required: ["slide_type", "argument"],
      },
    },
  },
  required: ["slides"],
};

function buildCategoryPlanSystem() {
  return `You are designing slides for one section of a cybersecurity threat briefing (CISO audience).

For the assigned threat category, produce a plan for 3-5 slides in this exact order:
  1. top_happenings   : What actually happened or was discovered in this period. Concrete source-backed developments only. No speculation. If evidence is thin, say so.
  2. category_trends  : Patterns repeated across multiple sources. ONLY if ≥2 sources support the pattern — otherwise label it "single-source signal."
  3. category_insights: Higher-order interpretation. What assumption or control does this challenge? What attack path opens? What would defenders miss tracking only conventional threats?
  4. monitoring_signals: Structured watchlist. Use the monitoring signals from the synthesis judgments.
  5. case_study       : ONLY if evidence includes a named CVE, named product, named victim, or named actor. Skip otherwise.

RULES:
  - Every evidence_ids[] must contain real IDs from the evidence list provided.
  - Do not plan slides for which there is no evidence.
  - 3-4 bullets per slide — not 6. Fewer stronger points win.
  - Do not plan generic "outlook" slides — the outlook is handled separately.

Return ONLY valid JSON.`;
}

function buildCategoryPlanUser(ca, evidencePack) {
  const approved = (ca.judgments || []).filter(j => !j.blocked);
  const jLines = approved.map(j => {
    const sigLines = (j.monitoring_signals || []).filter(s => typeof s === "object").map(s =>
      `      • ${s.signal} (trigger: ${s.escalation_trigger || "?"})`
    ).join("\n");
    return `  [${j.judgment_id}] [${j.evidence_maturity || "?"}] ${j.judgment}\n    Confidence: ${j.confidence} | Evidence: ${(j.evidence_for||[]).join(", ")}` +
           (sigLines ? `\n    Signals:\n${sigLines}` : "");
  }).join("\n\n");

  const evLines = [...(evidencePack?.strong||[]), ...(evidencePack?.usable||[])].slice(0, 20).map(ev =>
    `[${ev.evidence_id}] [${ev.evidence_type}] ${ev.fact}`
  ).join("\n");

  return `Plan slides for: ${CATEGORY_LABELS[ca.category] || ca.category}

APPROVED JUDGMENTS:
${jLines || "(no approved judgments — plan 1 slide noting insufficient evidence)"}

AVAILABLE EVIDENCE:
${evLines || "(none)"}

Coverage assessment: ${ca.coverage_assessment || "unknown"}
Evidence gaps: ${(ca.evidence_gaps||[]).join("; ") || "none listed"}

Plan 3-5 slides in the required order. Use exact evidence IDs from above.`;
}

// ── Visual spec builder (deterministic, from evidence numbers) ────────────────
//
// Reads the numbers[] arrays on evidence items and auto-generates a chart spec.
// No LLM involved — data comes directly from structured extraction.
//
// Chart types:
//   comparison_bar  — paired percentages/rates (AI vs Template, before vs after rate)
//   before_after    — two time values showing compression/change
//   cost_comparison — dollar values side by side
//   stat_cluster    — 2–4 key metric callouts (default)

const VISUAL_STOP_WORDS = new Set([
  "for","the","a","an","of","in","by","with","against","during","using",
  "from","that","this","its","are","was","were","been","have","has","had",
  "will","can","rate","percentage","number","count","total","average","per",
  "each","all","both","their","time","times","overall","across","between",
]);

function vtokenise(str) {
  return (str || "").toLowerCase().match(/\b[a-z0-9]{3,}\b/g)
    ?.filter(w => !VISUAL_STOP_WORDS.has(w)) || [];
}

function contextSimilarity(a, b) {
  const ta = new Set(vtokenise(a));
  const tb = new Set(vtokenise(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function detectNumUnit(v) {
  const s = String(v || "");
  if (s.includes("%"))                            return "%";
  if (/\$[0-9]/.test(s) || s.startsWith("$"))   return "$";
  if (/[0-9]×|×[0-9]|\bx\b/.test(s))            return "×";
  if (/\b(day|hour|week|month|year)s?\b/i.test(s)) return "time";
  return "";
}

function parseNumValue(v) {
  return parseFloat(String(v || "").replace(/[^0-9.]/g, "")) || null;
}

// Discriminating words of context A relative to context B (for series labels)
function seriesLabel(contextA, contextB) {
  const mine   = new Set(vtokenise(contextA));
  const theirs = new Set(vtokenise(contextB));
  const unique = [...mine].filter(w => !theirs.has(w));
  if (!unique.length) return contextA.slice(0, 20);
  return unique.slice(0, 2).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Common words of two contexts (for metric axis label)
function metricLabel(contextA, contextB) {
  const wordsA = vtokenise(contextA);
  const setB   = new Set(vtokenise(contextB));
  const common = wordsA.filter(w => setB.has(w));
  if (!common.length) return contextA.slice(0, 30);
  return common.slice(0, 4).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// suggestion is the LLM's decision: "comparison_bar"|"stat_cluster"|"before_after"|"cost_comparison"|"none"|null
// "none" or null → no visual. Any other value → run deterministic builder constrained to that type.
export function buildVisualSpec(evidenceForSlide, suggestion) {
  if (!suggestion || suggestion === "none") return null;
  const allNums = evidenceForSlide.flatMap(ei =>
    (ei.numbers || []).map(n => ({
      value:       n.value,
      context:     n.context,
      evidence_id: ei.evidence_id,
      unit:        detectNumUnit(n.value),
      parsed:      parseNumValue(n.value),
    }))
  ).filter(n => n.value && n.context);

  if (allNums.length === 0) return null;

  const source_evidence_ids = [...new Set(evidenceForSlide.map(ei => ei.evidence_id))];

  // If suggestion is a specific type, jump to it; otherwise fall through the waterfall.
  const want = suggestion;

  // ── Before/after: two time-unit values → compression chart ──────────────────
  const timeNums = allNums.filter(n => n.unit === "time");
  if ((want === "before_after" || !want) && timeNums.length >= 2) {
    return {
      chart_type: "before_after",
      title:  "Timeline Compression",
      before: { value: timeNums[0].value, label: timeNums[0].context },
      after:  { value: timeNums[1].value, label: timeNums[1].context },
      source_evidence_ids,
    };
  }

  // ── Comparison bar: paired percentage values ─────────────────────────────────
  const pcts = allNums.filter(n => n.unit === "%" && n.parsed !== null);
  if ((want === "comparison_bar" || !want) && pcts.length >= 2) {
    const used  = new Set();
    const pairs = [];
    for (let i = 0; i < pcts.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < pcts.length; j++) {
        if (used.has(j)) continue;
        if (contextSimilarity(pcts[i].context, pcts[j].context) >= 0.3) {
          pairs.push([pcts[i], pcts[j]]);
          used.add(i); used.add(j);
          break;
        }
      }
    }
    if (pairs.length >= 1) {
      const labelA = seriesLabel(pairs[0][0].context, pairs[0][1].context);
      const labelB = seriesLabel(pairs[0][1].context, pairs[0][0].context);
      return {
        chart_type:    "comparison_bar",
        title:         `${labelA} vs ${labelB}`,
        series_labels: [labelA, labelB],
        chart_data: {
          items: pairs.map(([a, b]) => ({
            metric: metricLabel(a.context, b.context),
            values: [
              { series: labelA, value: a.parsed, display: a.value },
              { series: labelB, value: b.parsed, display: b.value },
            ],
            unit: "%",
          })),
        },
        source_evidence_ids,
      };
    }
  }

  // ── Cost comparison: dollar values ───────────────────────────────────────────
  const costs = allNums.filter(n => n.unit === "$");
  if ((want === "cost_comparison" || !want) && costs.length >= 2) {
    return {
      chart_type: "cost_comparison",
      title:      "Cost Comparison",
      chart_data: {
        items: costs.slice(0, 4).map(n => ({
          value: n.value,
          label: n.context,
        })),
      },
      source_evidence_ids,
    };
  }

  // ── Stat cluster: key metric callouts (default / explicit request) ───────────
  if (want && want !== "stat_cluster" && allNums.length > 0) {
    // LLM requested a type we couldn't satisfy (e.g. comparison_bar but no pairs) — fall back to stat_cluster
  }
  return {
    chart_type: "stat_cluster",
    title:      "Key Figures",
    chart_data: {
      metrics: allNums.slice(0, 4).map(n => ({
        value: n.value,
        label: n.context,
      })),
    },
    source_evidence_ids,
  };
}

// ── Bullet normalisation ──────────────────────────────────────────────────────
// LLMs return bullets as either plain strings or {text, bullet_type} objects.
// We normalise both to {text, bullet_type} and detect type deterministically.
// Evidence IDs are never inlined in bullet text — they live in citations[].

const REC_VERBS = /^(implement|deploy|patch|enforce|adopt|use|apply|establish|require|monitor|audit|rotate|update|move|prioritize|treat|run|scan|add|install|configure|check|review|shift|layer|mandate)\b/i;
const IMP_WORDS = /\b(means|therefore|result|consequence|implication|hence|thus|leading to|leads to|which means|so that)\b/i;
const NUM_PATTERN = /\d+%|\$[\d,]+|[\d,]+×|\d+ (day|hour|week|month)/;

// Strip any leaked evidence IDs ("(ev-xxx-1)" or "[ev-xxx-1]") from bullet text.
const EVIDENCE_ID_LEAK = /\s*[\[(]ev-[a-z0-9_-]+[\])]/gi;

function detectBulletType(text) {
  if (REC_VERBS.test(text))  return "recommendation";
  if (IMP_WORDS.test(text))  return "implication";
  if (NUM_PATTERN.test(text)) return "data_point";
  return "claim";
}

function normaliseBullet(b) {
  const raw         = typeof b === "string" ? b : (b?.text || String(b));
  const text        = raw.replace(EVIDENCE_ID_LEAK, "").trim();
  const type        = (typeof b === "object" && b?.bullet_type) || detectBulletType(text);
  const evidence_id = (typeof b === "object" && b?.evidence_id) || null;
  return { text, bullet_type: type, ...(evidence_id ? { evidence_id } : {}) };
}

// ── Step 2: Generate slide content ────────────────────────────────────────────

const SLIDE_SCHEMA = {
  type: "object",
  properties: {
    headline:      { type: "string" },
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text:        { type: "string" },
          evidence_id: { type: "string" },
          bullet_type: { type: "string", enum: ["claim","data_point","implication","recommendation","signal"] },
        },
        required: ["text"],
      },
    },
    speaker_notes:     { type: "string" },
    citations:         { type: "array", items: { type: "string" } },
    visual_suggestion: { type: "string", enum: ["comparison_bar","stat_cluster","before_after","cost_comparison","none"] },
  },
  required: ["headline", "bullets", "speaker_notes", "visual_suggestion"],
};

function buildSlideSystem() {
  return `You are writing content for a cybersecurity threat briefing for a security director or CISO audience.

════ QUALITY BAR ════
Before writing each bullet, check:
  1. Is there a clear claim (not a vague observation)?
  2. Is every factual bullet linked to an evidence_id?
  3. Does the bullet explain WHY this matters — not just WHAT happened?
  4. Would a security director understand it after one read, without context?
  5. Does it distinguish research, vulnerability, exploitation, and operational evidence?

════ HEADLINE ════
One declarative sentence ≤12 words. States the CONCLUSION. Not the topic.
  BAD:  "Agentic AI security challenges are growing"
  GOOD: "Agent tool-calls turn prompt attacks into filesystem and API exploits"

════ BULLETS ════
3-4 bullets maximum. Fewer strong points beat many weak ones.
Each bullet is: { "text": "...", "bullet_type": "...", "evidence_id": "..." }

text rules:
  - ≤18 words. Active voice. Specific subject + verb + object.
  - Include source attribution inline where possible: "...[Source: arXiv, 2026-06]"
  - Translate technical language: do not assume readers know acronyms.
  - BAD:  "GCG produces insufficient distributional signal to trigger classifiers."
  - GOOD: "Some jailbreaks look syntactically normal to safety classifiers while steering the model toward unsafe behavior. [Source: arXiv, 2026-06]"
  - BAD:  "Agentic tool-calling expands attack surface."
  - GOOD: "When an agent can call tools, a successful prompt attack can become a filesystem write, API call, or code-execution event. [Evidence: EV-ID]"
  - BAD:  "Operational use may increase."
  - GOOD: "No confirmed operational campaign yet; escalation trigger is first incident of actor using agent tooling for intrusion or data theft. [Analyst judgment]"
  - NEVER use "limited operational use" — replace with "exploitable attack surface identified; adversary adoption unconfirmed."
  - If only one source supports a claim: add "(single-source signal)" to the bullet.

bullet_type values:
  "claim"          — factual assertion (source-backed)
  "data_point"     — contains a specific number, rate, or measurement (MUST have evidence_id)
  "implication"    — consequence for defenders (what breaks, what opens up)
  "recommendation" — a specific defender action (start with an imperative verb)
  "signal"         — a monitoring indicator with an escalation trigger

evidence_id: REQUIRED for data_point and claim bullets. Use the exact ID from the evidence list.
  Do NOT put evidence IDs inside the text field — they belong in the evidence_id field.

════ SPEAKER NOTES ════
2-3 sentences only. Answer: "What is the key analytical point a presenter should emphasise?"
  - Do NOT restate the headline.
  - Do NOT list the bullets again.
  - Add nuance the slide cannot show (confidence caveat, limitation, what to watch next).
  - Cite evidence IDs parenthetically: "(see EV-ID)"

════ CITATIONS ════
Array of all evidence_ids used anywhere in this slide.

════ VISUAL_SUGGESTION ════
  "comparison_bar"  — two things compared with percentages or rates
  "stat_cluster"    — 2-4 distinct key metrics as callouts
  "before_after"    — timeline compression or before/after change
  "cost_comparison" — dollar values compared
  "none"            — narrative, monitoring, recommendation, or outlook slides

Return ONLY valid JSON. No markdown.`;
}

function buildSlideUser(plan, evidenceForSlide, judgment) {
  const evLines = evidenceForSlide.map(ev => {
    const pub  = ev.publisher || ev.source_title || "unknown";
    const date = (ev.source_url || "").match(/\d{4}(-\d{2})?/)?.[0] || "";
    const numStr = (ev.numbers || []).length
      ? `\n  Numbers: ${ev.numbers.map(n => `${n.value} (${n.context})`).join(", ")}`
      : "";
    return `[${ev.evidence_id}][${ev.evidence_type}] ${ev.fact}\n  Quote: "${ev.quote || ""}"\n  Source: ${pub}${date ? `, ${date}` : ""}${numStr}`;
  }).join("\n\n");

  const jLines = judgment ? [
    `DRIVING JUDGMENT [${judgment.evidence_maturity || "?"}]: ${judgment.judgment}`,
    `  What changed: ${judgment.what_changed}`,
    `  Why it matters: ${judgment.why_this_matters}`,
    `  Confidence: ${judgment.confidence}`,
    `  Caveats: ${(judgment.caveats||[]).join("; ")}`,
    judgment.recommended_action ? `  Recommended action: ${judgment.recommended_action}` : "",
  ].filter(Boolean).join("\n") : "";

  const signalsBlock = plan.type === "monitoring_signals" && (plan.monitoring_signals?.length)
    ? `\nMONITORING SIGNALS (write one bullet per signal, bullet_type="signal"):\n` +
      plan.monitoring_signals
        .filter(s => typeof s === "object" && s.signal)
        .map(s => `  signal: ${s.signal}\n  why: ${s.why_it_matters || ""}\n  trigger: ${s.escalation_trigger || "unspecified"}\n  source: ${s.monitoring_source_type || "threat intel"}`)
        .join("\n---\n")
    : "";

  return `Write content for this slide:

TYPE: ${plan.type}
ARGUMENT (the claim this slide must prove): ${plan.argument}

${jLines}
${signalsBlock}

EVIDENCE:
${evLines || "(no direct evidence — note thin corpus, write 1 bullet marked as analyst judgment)"}

IMPORTANT:
- 3-4 bullets maximum.
- Every claim bullet needs evidence_id if evidence is available above.
- If only 1 source supports a point, add "(single-source signal)" in the text.
- Speaker notes: 2-3 sentences, analytical nuance only, no restating the slide.`;
}

// ── Step 3: Validate traceability ─────────────────────────────────────────────

function validateTraceability(slides, evidenceIndex) {
  const issues = [];
  for (const slide of slides) {
    for (const b of slide.bullets || []) {
      if (b.evidence_id && !(b.evidence_id in evidenceIndex)) {
        issues.push({
          slide_number: slide.slide_number,
          type: "unresolved_evidence_id",
          evidence_id: b.evidence_id,
        });
      }
    }
    for (const cid of slide.citations || []) {
      if (cid.startsWith("ev-") && !(cid in evidenceIndex)) {
        issues.push({
          slide_number: slide.slide_number,
          type: "unresolved_citation",
          citation: cid,
        });
      }
    }
  }
  return issues;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a full presentation from category analyses.
 *
 * @param {object[]} categoryAnalyses  - From synthesizeAllCategories()
 * @param {object}   crossCategory     - From synthesizeCrossCategory()
 * @param {object[]} evidenceItems     - All evidence items (for lookup)
 * @param {object}   [opts]
 * @returns {Promise<object>}
 */
export async function buildPresentation(categoryAnalyses, crossCategory, evidenceItems, opts = {}) {
  const evidenceIndex = Object.fromEntries(evidenceItems.map(ei => [ei.evidence_id, ei]));
  const judgmentIndex = Object.fromEntries(
    categoryAnalyses.flatMap(ca =>
      (ca.judgments || []).filter(j => !j.blocked).map(j => [j.judgment_id, j])
    )
  );

  // Evidence packs keyed by category (for per-category planning)
  const evidenceByCategory = {};
  for (const ca of categoryAnalyses) {
    const ids = new Set(ca.evidence_ids || []);
    const items = evidenceItems.filter(ei => ids.has(ei.evidence_id));
    evidenceByCategory[ca.category] = {
      strong:  items.filter(ei => ei.is_cluster_rep),
      usable:  items.filter(ei => !ei.is_cluster_rep && ei.specificity !== "low"),
      context: items.filter(ei => !ei.is_cluster_rep && ei.specificity === "low"),
    };
  }

  // Corpus stats for deterministic slides
  const sourcesByCategory = {};
  categoryAnalyses.forEach(ca => {
    sourcesByCategory[ca.category] = ca.evidence_ids?.length || 0;
  });
  const corpusSummary = opts.corpusSummary || {
    total_sources: evidenceItems.length,
    date_range: "unknown",
  };

  // ── Step 1: Build deterministic fixed slides ─────────────────────────────────
  // Use relevant source count (not evidence item count) for scope slide
  const relevantCount = categoryAnalyses.reduce((n, ca) => n + (ca.approved_judgment_count ? (corpusSummary.source_count_by_category?.[ca.category] || 0) : 0), 0)
    || corpusSummary.total_sources || evidenceItems.length;
  const scopeCorpus = { ...corpusSummary, total_sources: corpusSummary.total_sources || relevantCount };
  const scopeSlide  = buildScopeSlide(scopeCorpus, sourcesByCategory);
  const snapshotSlide  = buildEvidenceSnapshotSlide(categoryAnalyses, evidenceItems);

  // ── Step 2: Per-category LLM slide planning ──────────────────────────────────
  // One LLM call per assessed category to plan its section slides.
  const categorySections = {};  // category → [{type, argument, evidence_ids, judgment_id}]

  for (const ca of categoryAnalyses) {
    if (opts.skipLlm || ca.assessment_status !== "assessed") {
      const approved = (ca.judgments || []).filter(j => !j.blocked);
      const monSignals = approved.flatMap(j => j.monitoring_signals || []);
      categorySections[ca.category] = [
        { type: "top_happenings",   argument: `Top happenings in ${CATEGORY_LABELS[ca.category]}`,   evidence_ids: approved.flatMap(j => j.evidence_for||[]).slice(0,4) },
        { type: "category_insights", argument: `Key insights for ${CATEGORY_LABELS[ca.category]}`,  evidence_ids: [], judgment_id: approved[0]?.judgment_id },
        { type: "monitoring_signals", argument: `What to watch: ${CATEGORY_LABELS[ca.category]}`, evidence_ids: [], monitoring_signals: monSignals },
      ];
      continue;
    }

    try {
      const sys = buildCategoryPlanSystem();
      const usr = buildCategoryPlanUser(ca, evidenceByCategory[ca.category]);
      let raw;
      try {
        const { result } = await routedLLM(sys, usr, { task: "slide_content", requires_json: true, schema: CATEGORY_SLIDE_SCHEMA });
        raw = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        const text = await callLLM(sys, usr, { schema: CATEGORY_SLIDE_SCHEMA, json: true });
        raw = typeof text === "string" ? JSON.parse(text) : text;
      }
      // Attach monitoring signal objects from judgments to the monitoring slide
      const approved = (ca.judgments || []).filter(j => !j.blocked);
      const monSignals = approved.flatMap(j => j.monitoring_signals || []).filter(s => typeof s === "object");

      // Fallback type order if LLM omits slide_type field
      const FALLBACK_TYPES = ["top_happenings","category_trends","category_insights","monitoring_signals","case_study"];
      const rawSlides = raw?.slides || [];

      const planned = rawSlides.map((s, idx) => {
        const resolvedType = s.type || s.slide_type || FALLBACK_TYPES[idx] || "top_happenings";
        if (resolvedType === "monitoring_signals") {
          return { ...s, type: resolvedType, monitoring_signals: monSignals };
        }
        return { ...s, type: resolvedType };
      });

      // Deduplicate: drop slides with identical argument/evidence_ids to the previous one
      const dedupedPlan = planned.filter((s, idx) => {
        if (idx === 0) return true;
        const prev = planned[idx - 1];
        const sameArg = s.argument === prev.argument;
        const sameEv  = JSON.stringify(s.evidence_ids) === JSON.stringify(prev.evidence_ids);
        return !(sameArg && sameEv);
      });
      categorySections[ca.category] = dedupedPlan;
    } catch {
      categorySections[ca.category] = [];
    }
  }

  // ── Step 3: Executive summary LLM call ──────────────────────────────────────
  let execSummaryPlan = [];
  if (!opts.skipLlm) {
    const approved = categoryAnalyses.flatMap(ca =>
      (ca.judgments || []).filter(j => !j.blocked).map(j => ({
        cat: CATEGORY_LABELS[ca.category] || ca.category,
        ...j,
      }))
    );
    const topJudgments = approved.slice(0, 5);
    execSummaryPlan = [
      {
        type:         "executive_summary",
        argument:     "3-5 plain-English strategic judgments covering the top AI threat developments this period",
        evidence_ids: topJudgments.flatMap(j => j.evidence_for || []).slice(0, 8),
        judgment_id:  null,
        _exec_judgments: topJudgments.map(j => `[${j.cat}][${j.evidence_maturity||"?"}] ${j.short_takeaway}: ${j.judgment}`),
      },
    ];
  } else {
    execSummaryPlan = [{ type: "executive_summary", argument: "Key findings from this period", evidence_ids: [] }];
  }

  // ── Step 4: Cross-category plan (LLM, optional) ────────────────────────────
  let crossPlan = [];
  const patterns = crossCategory?.patterns || [];
  if (!opts.skipLlm && patterns.length > 0) {
    crossPlan = [{
      type:         "cross_category",
      argument:     patterns[0]?.description || "Cross-category convergence pattern",
      evidence_ids: patterns.flatMap(p => p.evidence_ids || []).slice(0, 6),
    }];
  }

  // ── Step 5: Deterministic tail slides ─────────────────────────────────────
  const earlySignalsSlide = buildEarlySignalsSlide(categoryAnalyses, 0);
  const outlookSlide      = buildOutlookSlide(categoryAnalyses, 0);
  const gapsSlide         = buildEvidenceGapsSlide(categoryAnalyses, 0);

  // ── Step 6: Assemble full slide plan ────────────────────────────────────────
  const slidePlan = [
    { type: "cover",             argument: "AI Cyber Threat Horizon Scan",  evidence_ids: [] },
    scopeSlide,
    snapshotSlide,
    ...execSummaryPlan,
    ...CATEGORY_ORDER.flatMap(cat => {
      const section = categorySections[cat] || [];
      if (section.length === 0) return [];
      return [
        { type: "section_intro", argument: CATEGORY_LABELS[cat], evidence_ids: [], category: cat, deterministic: true },
        ...section.map(s => ({ ...s, category: cat })),
      ];
    }),
    ...(earlySignalsSlide ? [earlySignalsSlide] : []),
    ...(outlookSlide      ? [outlookSlide]      : []),
    ...crossPlan,
    ...(gapsSlide         ? [gapsSlide]         : []),
  ].map((s, i) => ({ ...s, type: s.type || s.slide_type, slide_number: i + 1 }));

  console.log(`  [L7] ${slidePlan.length} slides planned`);

  // ── Step 7: Generate LLM slide content ──────────────────────────────────────
  const slides = [];
  const SLIDE_CONCURRENCY = 3;
  const SKIP_TYPES = new Set([
    "cover", "section_intro", "scope_methodology",
    "evidence_snapshot", "early_signals_watchlist",
    "outlook_structured", "evidence_gaps",
  ]);

  for (let i = 0; i < slidePlan.length; i += SLIDE_CONCURRENCY) {
    const batch = slidePlan.slice(i, i + SLIDE_CONCURRENCY);
    const generated = await Promise.all(batch.map(async plan => {
      // Deterministic slides bypass content generation
      if (plan.deterministic || SKIP_TYPES.has(plan.type)) {
        return {
          ...plan,
          headline:      plan.headline || plan.argument.slice(0, 80),
          bullets:       plan.bullets || [],
          speaker_notes: plan.speaker_notes || "",
          citations:     plan.citations || plan.evidence_ids || [],
          visual_spec:   null,
          visual_suggestion: "none",
        };
      }

      const evForSlide = (plan.evidence_ids || []).map(id => evidenceIndex[id]).filter(Boolean);
      const judgment   = plan.judgment_id ? judgmentIndex[plan.judgment_id] : null;

      if (opts.skipLlm) {
        return {
          ...plan,
          headline:      plan.argument.slice(0, 80),
          bullets:       [],
          speaker_notes: plan.audience_signal || "",
          citations:     plan.evidence_ids || [],
          visual_spec:   buildVisualSpec(evForSlide, null),
          visual_suggestion: "none",
        };
      }

      // For exec summary: pass the judgment summaries as context
      const planForSlide = plan._exec_judgments
        ? { ...plan, argument: [plan.argument, ...plan._exec_judgments].join("\n\n") }
        : plan;

      // For monitoring_signals: attach structured signals
      const planWithSignals = plan.type === "monitoring_signals" && plan.monitoring_signals
        ? planForSlide
        : planForSlide;

      try {
        const sys = buildSlideSystem();
        const usr = buildSlideUser(planWithSignals, evForSlide, judgment);
        let raw;
        try {
          const { result } = await routedLLM(sys, usr, { task: "slide_content", requires_json: true, schema: SLIDE_SCHEMA });
          raw = typeof result === "string" ? JSON.parse(result) : result;
        } catch {
          const text = await callLLM(sys, usr, { schema: SLIDE_SCHEMA, json: true });
          raw = typeof text === "string" ? JSON.parse(text) : text;
        }
        const suggestion = raw?.visual_suggestion || "none";
        return {
          ...plan,
          headline:          raw?.headline || plan.argument.slice(0, 80),
          bullets:           (raw?.bullets || []).slice(0, 4).map(normaliseBullet),  // cap at 4
          speaker_notes:     raw?.speaker_notes || "",
          citations:         raw?.citations || plan.evidence_ids || [],
          visual_suggestion: suggestion,
          visual_spec:       buildVisualSpec(evForSlide, suggestion),
        };
      } catch {
        return {
          ...plan,
          headline:      plan.argument.slice(0, 80),
          bullets:       [{ text: "(Content generation failed)", bullet_type: "context" }],
          speaker_notes: "",
          citations:     [],
          visual_spec:   null,
          visual_suggestion: "none",
        };
      }
    }));
    slides.push(...generated);
    process.stdout.write(`  [L8] ${Math.min(i + SLIDE_CONCURRENCY, slidePlan.length)}/${slidePlan.length} slides generated\r`);
  }
  process.stdout.write("\n");

  // ── Step 3: Validate traceability ──────────────────────────────────────────
  const traceabilityIssues = validateTraceability(slides, evidenceIndex);
  if (traceabilityIssues.length > 0) {
    console.warn(`  [QA] ${traceabilityIssues.length} traceability issues found`);
  }

  // ── Step 4: References slide ───────────────────────────────────────────────
  // Collect all unique sources cited across the deck, resolve to URLs
  const citedEvidenceIds = new Set([
    ...slides.flatMap(s => s.citations || []),
    ...slides.flatMap(s => (s.bullets || []).filter(b => b.evidence_id).map(b => b.evidence_id)),
    ...slides.flatMap(s => s.visual_spec?.source_evidence_ids || []),
  ]);

  const seenUrls  = new Set();
  const refSources = [];
  for (const eid of citedEvidenceIds) {
    const ev = evidenceIndex[eid];
    if (!ev?.source_url || seenUrls.has(ev.source_url)) continue;
    seenUrls.add(ev.source_url);
    refSources.push({
      title:         ev.source_title || ev.publisher || "Unknown",
      url:           ev.source_url,
      publisher:     ev.publisher || "Unknown",
      trust_tier:    ev.trust_tier || "",
      evidence_type: ev.evidence_type || "",
    });
  }

  if (refSources.length > 0) {
    slides.push({
      type:         "references",
      slide_number: slides.length + 1,
      headline:     "Source References",
      bullets:      refSources.map(s => ({
        text:        `${s.publisher}: ${s.title}`,
        bullet_type: "context",
        url:         s.url,
        trust_tier:  s.trust_tier,
      })),
      speaker_notes: `Full list of ${refSources.length} sources cited in this briefing. All claims trace to these primary sources.`,
      citations:    [],
      visual_spec:  null,
      visual_suggestion: "none",
    });
  }

  // Counts
  const withVisual = slides.filter(s => s.visual_spec !== null && s.visual_spec !== undefined).length;
  const citedIds   = new Set(slides.flatMap(s => s.citations || []));

  return {
    slide_plan: slidePlan,
    slides,
    traceability_issues: traceabilityIssues,
    counts: {
      slides_planned:      slidePlan.length,
      slides_generated:    slides.length,
      slides_with_visual:  withVisual,
      cited_evidence_ids:  citedIds.size,
      unique_sources_cited: refSources.length,
      traceability_issues: traceabilityIssues.length,
    },
    deck_version: DECK_VERSION,
    deck_narrative: `${slides.length} slides covering ${categoryAnalyses.filter(ca => ca.assessment_status === "assessed").length} threat categories`,
  };
}
