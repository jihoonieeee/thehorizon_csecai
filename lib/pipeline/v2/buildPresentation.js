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
import { attachSlideDiagrams } from "./generateDiagrams.js";

export const DECK_VERSION = "deck-v2.2";

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
  // sourcesByCategory holds per-category EVIDENCE counts (they sum to far more
  // than total sources). Use real per-category source counts when available;
  // otherwise label them honestly as evidence items, not sources.
  const byCat     = corpusSummary.source_count_by_category || null;
  const catLines  = CATEGORY_ORDER.map(c => byCat
    ? `${CATEGORY_LABELS[c]}: ${byCat[c] || 0} sources`
    : `${CATEGORY_LABELS[c]}: ${sourcesByCategory[c] || 0} evidence items`);
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

// Deterministic early signals slide — each line is a concrete signal + the
// escalation trigger that would move it from "watch" to "act", deduped so we
// don't list the same vector twice. Format: "Category — signal → trigger".
function buildEarlySignalsSlide(categoryAnalyses, slideNumber) {
  const all = categoryAnalyses.flatMap(ca => {
    const catLabel = CATEGORY_LABELS[ca.category] || ca.category;
    return (ca.judgments || []).filter(j => !j.blocked).flatMap(j =>
      (j.monitoring_signals || [])
        .filter(s => typeof s === "object" && s.signal)
        .map(s => ({ ...s, category: catLabel }))
    );
  });
  // Dedup near-identical signals (same category + similar opening words).
  const seen = new Set();
  const signals = [];
  for (const s of all) {
    const key = `${s.category}|${String(s.signal).toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 5).join(" ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push(s);
    if (signals.length >= 6) break;
  }

  if (signals.length === 0) return null;

  return {
    type:          "early_signals_watchlist",
    slide_number:  slideNumber,
    headline:      "Early Signals Watchlist — What to Monitor Now",
    argument:      "Specific measurable signals that indicate escalation toward operational threat",
    bullets: signals.map(s => {
      const sig = String(s.signal).replace(/\s+/g, " ").trim();
      const trg = s.escalation_trigger ? `  →  act when: ${String(s.escalation_trigger).replace(/\s+/g, " ").trim()}` : "";
      return {
        text:        `${s.category}: ${sig}${trg}`,
        bullet_type: "context",
      };
    }),
    speaker_notes: `What to look for and where: ${signals.map(s => `${s.category} (${s.monitoring_source_type || "threat intel"})`).join("; ")}.`,
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
      text:        `${o.cat} — ${o.likely_next_movement}  (confidence: ${o.confidence})`,
      bullet_type: "implication",
      outlook_detail: {
        observed_basis:        o.observed_basis,
        what_would_invalidate: o.what_would_invalidate,
      },
    })),
    speaker_notes: `What would prove each outlook wrong: ${outlooks.map(o => `${o.cat} — ${o.what_would_invalidate || "n/a"}`).join("; ")}.`,
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic cross-category slide — built from synthesis convergence patterns.
// Clearly labelled so the audience knows it is the ecosystem-level analysis.
function buildCrossCategorySlide(crossCategory, slideNumber) {
  const patterns = (crossCategory?.patterns || []).slice(0, 2);
  if (!patterns.length) return null;
  // Synthesis text sometimes embeds category-local "[1]/[2]" markers that look
  // like global citations but aren't — strip them so the slide isn't misleading.
  const clean = (t) => String(t || "")
    .replace(/\s*\[\d+\]/g, "")          // drop category-local [n] markers
    .replace(/,\s*([)\]])/g, "$1")        // tidy "X, )" → "X)"
    .replace(/\(\s*,?\s*\)/g, "")          // drop emptied "( )" / "(,)"
    .replace(/\s+([,.;)])/g, "$1")          // no space before punctuation
    .replace(/\s{2,}/g, " ").trim();
  const bullets = [];
  for (const p of patterns) {
    const cats = (p.categories_involved || p.categories || []).map(c => CATEGORY_LABELS[c] || c).join(" + ");
    // One concise bullet per pattern: the convergence claim + a short "so what".
    // Keep the first 1-2 sentences only (tight, not a paragraph). The substance
    // may live in convergence_mechanism OR compounding_effect depending on synthesis.
    const firstSentences = (t, n = 2) => clean(t).split(/(?<=[.!?])\s+/).slice(0, n).join(" ");
    const head = clean(p.title || p.pattern);
    const body = firstSentences(p.convergence_mechanism || p.compounding_effect || p.description || "", 2);
    bullets.push({ text: body ? `${head} — ${body}` : `${head}${cats ? ` (${cats})` : ""}`, bullet_type: "claim" });
    const act = firstSentences(p.actionable_recommendation || p.implication || "", 1);
    if (act) bullets.push({ text: act, bullet_type: "recommendation" });
  }
  const headline = patterns[0].title
    ? `Cross-Category: ${patterns[0].title}`
    : "Cross-Category Convergence";
  return {
    type:          "cross_category",
    slide_number:  slideNumber,
    headline,
    argument:      "How threats across the four categories reinforce one another",
    bullets:       bullets.slice(0, 6),
    speaker_notes: crossCategory.ecosystem_assessment || "Ecosystem-level read across all four categories.",
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
// Strip leaked inline source/judgment tags the model sometimes still emits, e.g.
// "[Source: arXiv, 2026-06]", "[Evidence: …]", "[Analyst judgment]", "(single-source signal)".
const SOURCE_TAG_LEAK = /\s*[\[(](?:source|evidence|analyst[ _]?judgment|single-source[^\])]*)\b[^\])]*[\])]/gi;

function detectBulletType(text) {
  if (REC_VERBS.test(text))  return "recommendation";
  if (IMP_WORDS.test(text))  return "implication";
  if (NUM_PATTERN.test(text)) return "data_point";
  return "claim";
}

function normaliseBullet(b) {
  const raw         = typeof b === "string" ? b : (b?.text || String(b));
  const text        = raw.replace(EVIDENCE_ID_LEAK, "").replace(SOURCE_TAG_LEAK, "").trim();
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

// ── Case-study slide (Phase 3) ────────────────────────────────────────────────
// A case study is anchored on a NAMED entity (CVE / product / victim / actor)
// and tells one concrete attack story. The attack-chain diagram is the visual;
// bullets carry the impact and defender takeaway.
const CASE_STUDY_SCHEMA = {
  type: "object",
  properties: {
    named_entity: { type: "string" },   // the CVE / product / victim / actor this case is about
    headline:     { type: "string" },
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text:        { type: "string" },
          evidence_id: { type: "string" },
          bullet_type: { type: "string", enum: ["claim","data_point","implication","recommendation"] },
        },
        required: ["text"],
      },
    },
    speaker_notes: { type: "string" },
    citations:     { type: "array", items: { type: "string" } },
  },
  required: ["named_entity", "headline", "bullets", "speaker_notes"],
};

function buildCaseStudySystem() {
  return `You are writing ONE case-study slide for a cybersecurity threat briefing (CISO audience).

A case study tells a single concrete attack story anchored on a NAMED entity.
  named_entity : the specific CVE, product, victim org, malware family, or threat actor this case is about. If the evidence has no named entity, you should not be writing a case study.
  headline     : ≤12 words naming what happened to whom (the conclusion). e.g. "Poisoned PyPI package backdoored 100+ ML pipelines".

bullets (3-5), each exactly one type — the attack STORY then its meaning:
  - "claim" / "data_point" = Evidence: a concrete step or fact in the attack (what the attacker did, how, scale). MUST cite an evidence_id. Order them as the attack chain.
  - "implication"  = what this means for defenders (which control failed, what it exposes).
  - "recommendation" = the specific defender action.
Rules: ≤22 words/bullet, plain English, no source names/IDs in text (citations are added automatically). Evidence bullets MUST set evidence_id from the list.

The attack chain itself is drawn as a diagram automatically from the evidence — your bullets give the impact + takeaway, not a redundant step list.

speaker_notes: 2-3 sentences of analytical nuance (confidence, what to watch). No restating bullets.

Return ONLY valid JSON.`;
}

function buildCaseStudyUser(plan, evidenceForSlide, judgment) {
  const evLines = evidenceForSlide.map(ev => {
    const pub = ev.publisher || ev.source_title || "unknown";
    return `[${ev.evidence_id}][${ev.evidence_type}] ${ev.fact}\n  Quote: "${ev.quote || ""}"\n  Source: ${pub}`;
  }).join("\n\n");
  const jLine = judgment ? `\nDRIVING JUDGMENT: ${judgment.judgment}\n  Why it matters: ${judgment.why_this_matters || ""}` : "";
  return `Write a case-study slide for: ${plan.argument}
${jLine}

EVIDENCE (use these for the attack story; cite exact evidence_ids):
${evLines || "(no direct evidence — do not fabricate a case study)"}

Identify the single named_entity this case centres on, a conclusion headline, 3-5 typed bullets (Evidence steps → Implication → Recommendation), and speaker notes.`;
}

// ── Category insights (Phase: 3 connected strategic insights) ─────────────────
// The fix for "detached line-by-line" content: an insight is NOT an Evidence /
// Implication / Recommendation triple — it is ONE connected analytical claim that
// fuses what we observe with what it means and what to do about it.
const INSIGHTS_SCHEMA = {
  type: "object",
  properties: {
    headline:     { type: "string" },
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insight:     { type: "string" },
          evidence_id: { type: "string" },
        },
        required: ["insight"],
      },
    },
    speaker_notes: { type: "string" },
  },
  required: ["headline", "insights"],
};

function buildInsightsSystem() {
  return `You are the principal analyst writing the INSIGHTS slide for one threat category in a CISO briefing.

This slide is your ANALYSIS — not a list of facts. Produce EXACTLY 3 insights.

Each insight is ONE connected, self-contained strategic statement (2-3 sentences) that:
  • leads with the strategic claim (the "so what"), not the raw observation;
  • weaves the supporting evidence INTO the sentence (don't separate it into its own line);
  • makes explicit which defender assumption breaks or what new exposure opens;
  • where natural, ends with the strategic implication or the move it forces.
Do NOT split an insight into "Evidence:" / "Implication:" / "Recommendation:" pieces — that reads as disconnected fragments. Write it as flowing analysis a senior leader can act on.

BAD (detached):  "Evidence: A model had 200k downloads. Implication: model hubs are risky. Recommendation: audit models."
GOOD (connected): "Model hubs have become a primary credential-theft vector: a single trojanized model reached 200k downloads before removal, which means intake-time scanning no longer protects you and model artifacts must be treated as executable code under runtime control."

Rules:
  • 3 insights, each ≤ ~45 words, plain English, distinct from one another.
  • Set evidence_id on each insight to the exact ID that grounds it (from the list).
  • No source names, dates, or [n] markers in the text — citations are added automatically.
  • headline: one declarative sentence (≤12 words) capturing the category's single most important shift.

Return ONLY valid JSON.`;
}

function buildInsightsUser(plan, evidenceForSlide, judgment) {
  const evLines = evidenceForSlide.map(ev => `[${ev.evidence_id}] ${ev.fact}`).join("\n");
  const jLines = judgment ? `\nLEAD JUDGMENT: ${judgment.judgment}\n  Why it matters: ${judgment.why_this_matters || ""}\n  Mechanism: ${judgment.causal_mechanism || ""}` : "";
  return `Category: ${plan.argument}
${jLines}

EVIDENCE (ground each insight in one of these; cite the exact ID):
${evLines || "(thin evidence — write fewer, clearly-hedged insights)"}

Write EXACTLY 3 connected strategic insights (each fusing observation + meaning + implication) and a headline.`;
}

function buildSlideSystem() {
  return `You are writing one slide for a cybersecurity threat briefing for a security director / CISO audience.

A slide has a STRUCTURE the reader must grasp in one glance:
  • HEADLINE  = the slide's single strategic CLAIM (the conclusion / "so what").
  • BULLETS   = the support, where EACH bullet is exactly ONE of:
      Evidence       — a concrete observed fact or measurement (MUST cite an evidence_id)
      Implication    — what this means for defenders: which control breaks, what opens up
      Recommendation — a specific defender action (start with an imperative verb)
      Watch          — a monitoring signal and the event that would escalate it
Do NOT blend these. An Evidence bullet states the fact only; the meaning goes in a separate Implication bullet. This separation is what makes the slide an analysis, not an info dump.

════ HEADLINE ════
One declarative sentence ≤12 words stating the CLAIM (not the topic).
  BAD:  "Agentic AI security challenges are growing"
  GOOD: "Agent tool-calls turn prompt injection into real code execution"

════ BULLETS (3-4 max) ════
Each bullet is: { "text": "...", "bullet_type": "...", "evidence_id": "..." }
  - bullet_type ∈ { "data_point" (Evidence with a number), "claim" (Evidence, factual), "implication", "recommendation", "signal" (Watch) }.
  - text ≤ 20 words, active voice, plain English (translate acronyms). State the point only.
  - Do NOT write source names, publishers, dates, or IDs in the text — citation numbers are added automatically from evidence_id. (No "[Source: …]", no "[Analyst judgment]".)
  - Lead a section with one Evidence bullet, then its Implication, then a Recommendation or Watch.
  - data_point and claim bullets MUST set evidence_id to an exact ID from the evidence list.

════ SPEAKER NOTES ════
2-3 sentences of analytical nuance a presenter should add (confidence caveat, limitation, what to watch). Do NOT restate the headline or re-list bullets. No source names or IDs.

════ CITATIONS ════
Array of the evidence_ids used in this slide.

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
${evLines || "(no direct evidence for this slide — write one Implication bullet stating the gap plainly)"}

IMPORTANT:
- Headline = the strategic claim. 3-4 bullets, each exactly one type (Evidence / Implication / Recommendation / Watch).
- Every Evidence (claim/data_point) bullet needs an evidence_id from the list above.
- Do NOT write source names, dates, or IDs in bullet text — citations are added automatically.
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
    // AI diagrams must trace every node back to resolvable evidence.
    if (slide.diagram_spec) {
      const dids = slide.diagram_spec.source_evidence_ids || [];
      const unresolved = dids.filter(id => !(id in evidenceIndex));
      if (dids.length === 0 || unresolved.length === dids.length) {
        issues.push({
          slide_number: slide.slide_number,
          type: "unresolved_diagram_evidence",
          diagram_id: slide.diagram_spec.visualization_id,
        });
      }
    }
  }
  return issues;
}

// ── Category plan helpers ─────────────────────────────────────────────────────

// Unique evidence IDs cited by a category's approved judgments.
function approvedJudgmentEvidenceIds(ca, limit = 8) {
  const approved = (ca.judgments || []).filter(j => !j.blocked);
  return [...new Set(approved.flatMap(j => j.evidence_for || []))].slice(0, limit);
}

// A case study needs a NAMED entity (CVE / actor / malware) and a multi-step
// operational story. Detect a case-worthy evidence subset for a category.
const CVE_RE = /\bCVE-\d{4}-\d{3,}\b/i;
const CASE_EVIDENCE_TYPES = new Set([
  "incident", "exploit_disclosure", "observed_exploitation",
  "adversary_adoption", "operational_campaign", "threat_intelligence",
  "threat_actor_activity",
]);
function caseStudyPlanFor(ca, pack) {
  const items = [...(pack?.strong || []), ...(pack?.usable || [])];
  const worthy = items.filter(e => CVE_RE.test(e.fact || "") || CASE_EVIDENCE_TYPES.has(e.evidence_type));
  if (worthy.length < 2) return null;   // need a real multi-step operational story
  const label = CATEGORY_LABELS[ca.category] || ca.category;
  return {
    type:         "case_study",
    argument:     `Case study — ${label}`,
    evidence_ids: worthy.slice(0, 6).map(e => e.evidence_id),
    judgment_id:  (ca.judgments || []).find(j => !j.blocked)?.judgment_id,
  };
}

// Deterministic, judgment-driven section plan. Always evidence-backed so an
// assessed category never renders as an empty "thin corpus" section even when
// the LLM planner (or a fallback model) returns a weak plan.
function deterministicCategoryPlan(ca, pack) {
  const approved = (ca.judgments || []).filter(j => !j.blocked);
  if (!approved.length) return [];
  const label   = CATEGORY_LABELS[ca.category] || ca.category;
  const evIds   = approvedJudgmentEvidenceIds(ca, 8);
  const monSignals = approved.flatMap(j => j.monitoring_signals || []).filter(s => typeof s === "object");
  const plan = [
    { type: "top_happenings",    argument: `Key developments in ${label} this period`,        evidence_ids: evIds.slice(0, 5), judgment_id: approved[0].judgment_id },
    { type: "category_insights", argument: `What this means for defenders — ${label}`,         evidence_ids: evIds.slice(0, 5), judgment_id: (approved[1] || approved[0]).judgment_id },
  ];
  const caseSlide = caseStudyPlanFor(ca, pack);
  if (caseSlide) plan.push(caseSlide);
  if (monSignals.length) {
    plan.push({ type: "monitoring_signals", argument: `What to watch — ${label}`, evidence_ids: [], monitoring_signals: monSignals });
  }
  return plan;
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
// Marketing / SEO / tabloid domains that are not acceptable as evidence in an
// executive threat brief. Their evidence is dropped before slides are built, so
// no claim is grounded on them.
const WEAK_SOURCE_DOMAINS = new Set([
  "aimagicx.com", "techtimes.com",
]);
function isWeakSource(ev) {
  try { return WEAK_SOURCE_DOMAINS.has(new URL(ev.source_url).hostname.replace(/^www\./, "")); }
  catch { return false; }
}

export async function buildPresentation(categoryAnalyses, crossCategory, evidenceItemsRaw, opts = {}) {
  // Drop weak-source evidence up front so neither claims nor citations use it.
  const evidenceItems = (evidenceItemsRaw || []).filter(ei => !isWeakSource(ei));
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
    const pack = evidenceByCategory[ca.category];
    if (opts.skipLlm || ca.assessment_status !== "assessed") {
      categorySections[ca.category] = deterministicCategoryPlan(ca, pack);
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

      // Backfill evidence: the planner (esp. on fallback models) often omits
      // evidence_ids, which strands the slide with no evidence → "thin corpus"
      // content. Fill empties from the category's approved-judgment evidence.
      const catEvIds = approvedJudgmentEvidenceIds(ca, 8);
      for (const s of dedupedPlan) {
        if (s.type !== "monitoring_signals" && !(s.evidence_ids || []).length) {
          s.evidence_ids = catEvIds.slice(0, 5);
        }
      }

      // If the plan is degraded (single slide, or no slide carries evidence),
      // fall back to a deterministic judgment-driven plan so the section is real.
      const degraded = dedupedPlan.length < 2 ||
        dedupedPlan.every(s => s.type === "monitoring_signals" || !(s.evidence_ids || []).length);
      let finalPlan = degraded ? deterministicCategoryPlan(ca, pack) : dedupedPlan;

      // Ensure a case study when the evidence supports one (named CVE/actor +
      // multi-step operational story) and the planner didn't include it.
      if (!finalPlan.some(s => s.type === "case_study")) {
        const caseSlide = caseStudyPlanFor(ca, pack);
        if (caseSlide) finalPlan = [...finalPlan, caseSlide];
      }
      categorySections[ca.category] = finalPlan;
    } catch {
      categorySections[ca.category] = deterministicCategoryPlan(ca, pack);
    }
  }

  // ── Section structure: Key Developments → Insights → Case Study ────────────
  // Each plays a DISTINCT role (not the old repetition): developments = what
  // happened (facts), insights = our 3-point analysis, case study = the deep-dive
  // that supports the analysis. Per-category "watchlist" (monitoring_signals) and
  // "trend" are dropped — the deck-level Early Signals slide consolidates watch items.
  for (const cat of Object.keys(categorySections)) {
    const sec       = categorySections[cat] || [];
    const happening = sec.find(s => s.type === "top_happenings");
    const insight   = sec.find(s => s.type === "category_insights");
    const caseStudy = sec.find(s => s.type === "case_study");
    const kept = [];
    if (happening) kept.push(happening);
    if (insight)   kept.push(insight);
    if (caseStudy) kept.push(caseStudy);
    // Guarantee at least a developments + insights pair.
    if (!kept.length) kept.push(...sec.slice(0, 2));
    categorySections[cat] = kept;
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

  // ── Step 4: Cross-category slide (deterministic, clearly labelled) ─────────
  const crossSlide = buildCrossCategorySlide(crossCategory, 0);
  const crossPlan  = crossSlide ? [crossSlide] : [];

  // ── Step 5: Deterministic tail slides ─────────────────────────────────────
  const earlySignalsSlide = buildEarlySignalsSlide(categoryAnalyses, 0);
  const outlookSlide      = buildOutlookSlide(categoryAnalyses, 0);
  // (Evidence-gaps slide removed per review — low executive value + artifact-prone.)

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

      const isCase    = plan.type === "case_study";
      const isInsight = plan.type === "category_insights";
      try {
        const sys    = isCase ? buildCaseStudySystem() : isInsight ? buildInsightsSystem() : buildSlideSystem();
        const usr    = isCase ? buildCaseStudyUser(plan, evForSlide, judgment)
                     : isInsight ? buildInsightsUser(plan, evForSlide, judgment)
                     : buildSlideUser(planWithSignals, evForSlide, judgment);
        const schema = isCase ? CASE_STUDY_SCHEMA : isInsight ? INSIGHTS_SCHEMA : SLIDE_SCHEMA;
        let raw;
        try {
          const { result } = await routedLLM(sys, usr, { task: "slide_content", requires_json: true, schema });
          raw = typeof result === "string" ? JSON.parse(result) : result;
        } catch {
          const text = await callLLM(sys, usr, { schema, json: true });
          raw = typeof text === "string" ? JSON.parse(text) : text;
        }
        // Insights → up to 3 connected strategic statements (no chart/diagram).
        if (isInsight) {
          const insights = (raw?.insights || []).slice(0, 3).map(it => normaliseBullet({
            text: it.insight || it.text || "", bullet_type: "claim", evidence_id: it.evidence_id,
          })).filter(b => b.text);
          return {
            ...plan,
            headline:      raw?.headline || plan.argument.slice(0, 80),
            bullets:       insights,
            speaker_notes: raw?.speaker_notes || "",
            citations:     raw?.citations || plan.evidence_ids || [],
            visual_suggestion: "none",
            visual_spec:   null,
          };
        }
        // Case studies never carry a stat chart — the attack-chain diagram is the visual.
        const suggestion = isCase ? "none" : (raw?.visual_suggestion || "none");
        return {
          ...plan,
          headline:          raw?.headline || plan.argument.slice(0, 80),
          ...(isCase ? { named_entity: raw?.named_entity || "" } : {}),
          bullets:           (raw?.bullets || []).slice(0, isCase ? 5 : 4).map(normaliseBullet),
          speaker_notes:     raw?.speaker_notes || "",
          citations:         raw?.citations || plan.evidence_ids || [],
          visual_suggestion: suggestion,
          visual_spec:       isCase ? null : buildVisualSpec(evForSlide, suggestion),
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

  // ── Step 7b: AI diagram generation (Phase 2) ───────────────────────────────
  // Attach Mermaid attack-flow / concept diagrams to eligible narrative slides
  // whose evidence describes a multi-step or multi-actor process.
  if (!opts.skipLlm) {
    try {
      await attachSlideDiagrams(slides, evidenceIndex, { skipLlm: opts.skipLlm, max: opts.maxDiagrams ?? 6 });
    } catch (err) {
      console.warn(`  [diagram] diagram pass failed: ${err.message}`);
    }
  }

  // ── Step 3: Validate traceability ──────────────────────────────────────────
  const traceabilityIssues = validateTraceability(slides, evidenceIndex);
  if (traceabilityIssues.length > 0) {
    console.warn(`  [QA] ${traceabilityIssues.length} traceability issues found`);
  }

  // ── Step 3b: Citation numbering ────────────────────────────────────────────
  // Each cited SOURCE (by URL) gets a stable number in order of first appearance.
  // Bullets are tagged with their number(s) ([n], rendered after the text); the
  // numbered References slide lists each source's publisher, title, and URL.
  const urlToNum = new Map();
  const refList  = [];   // { num, publisher, title, url }
  function citeNumFor(evId) {
    const ev = evidenceIndex[evId];
    if (!ev?.source_url) return null;
    if (!urlToNum.has(ev.source_url)) {
      const num = urlToNum.size + 1;
      urlToNum.set(ev.source_url, num);
      refList.push({
        num,
        publisher: ev.publisher || ev.source_title || "Unknown",
        title:     ev.source_title || ev.publisher || "Untitled",
        url:       ev.source_url,
      });
    }
    return urlToNum.get(ev.source_url);
  }
  // Only number sources actually cited as [n] on a bullet — chart/diagram-only
  // sources are NOT added (that produced orphan references with no [n] anchor).
  for (const slide of slides) {
    for (const b of (slide.bullets || [])) {
      if (b.evidence_id) {
        const n = citeNumFor(b.evidence_id);
        if (n) b.cite_nums = [n];
      }
    }
  }

  // ── Step 4: Numbered References slide ───────────────────────────────────────
  if (refList.length > 0) {
    slides.push({
      type:         "references",
      slide_number: slides.length + 1,
      headline:     "Source References",
      bullets:      refList.map(r => ({ ref_num: r.num, publisher: r.publisher, title: r.title, url: r.url, text: `${r.publisher} — ${r.title}` })),
      speaker_notes: `${refList.length} sources cited; the bracketed numbers on each slide map to this list.`,
      citations:    [],
      visual_spec:  null,
      visual_suggestion: "none",
    });
  }

  // Counts
  const withVisual  = slides.filter(s => s.visual_spec !== null && s.visual_spec !== undefined).length;
  const withDiagram = slides.filter(s => s.diagram_spec).length;
  const citedIds    = new Set(slides.flatMap(s => (s.bullets || []).filter(b => b.cite_nums).map(b => b.evidence_id)));
  const refSources  = refList;

  return {
    slide_plan: slidePlan,
    slides,
    traceability_issues: traceabilityIssues,
    counts: {
      slides_planned:      slidePlan.length,
      slides_generated:    slides.length,
      slides_with_visual:  withVisual,
      slides_with_diagram: withDiagram,
      cited_evidence_ids:  citedIds.size,
      unique_sources_cited: refSources.length,
      traceability_issues: traceabilityIssues.length,
    },
    deck_version: DECK_VERSION,
    deck_narrative: `${slides.length} slides covering ${categoryAnalyses.filter(ca => ca.assessment_status === "assessed").length} threat categories`,
  };
}
