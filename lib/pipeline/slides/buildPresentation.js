/**
 * buildPresentation()
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
import { qaSlides }  from "./qaSlides.js";
import { qaBulletEntailment } from "../analysis/qaBulletEntailment.js";
import { validateDeckCoherence } from "./validateDeckCoherence.js";
import { loadPrompt } from "../../prompts/promptLoader.js";

export const DECK_VERSION = "deck-v2.3";

// ── Slide roles ───────────────────────────────────────────────────────────────
// Each slide has a narrative ROLE that defines what argument it makes and what
// new information it introduces. The slide writer receives this role so it does
// not repeat the previous slide's function.
export const SLIDE_ROLES = {
  establish_baseline:  "establish_baseline",   // what was true before the period
  introduce_change:    "introduce_change",      // what newly emerged
  prove_shift:         "prove_shift",           // evidence that the shift occurred
  explain_mechanism:   "explain_mechanism",     // HOW the attack works
  illustrate_case:     "illustrate_case",       // named incident told start to finish
  compare_patterns:    "compare_patterns",      // cross-category or cross-actor comparison
  state_implication:   "state_implication",     // strategic so-what for leadership
  forecast_next_move:  "forecast_next_move",    // grounded prediction
};

// Deterministic role assignment for each slide type.
const SLIDE_TYPE_ROLE = {
  cover:                  null,
  scope_methodology:      null,
  evidence_snapshot:      "establish_baseline",
  executive_summary:      "state_implication",
  section_intro:          null,
  category_insights:      "establish_baseline",
  top_happenings:         "prove_shift",
  case_study:             "illustrate_case",
  monitoring_signals:     "introduce_change",
  overall_developments:   "prove_shift",
  overall_insights:       "state_implication",
  cross_category:         "compare_patterns",
  outlook_tiered:         "forecast_next_move",
  early_signals_watchlist:"forecast_next_move",
  evidence_gaps:          "establish_baseline",
  references:             null,
};

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
    argument:      "Evidence distribution for this briefing",
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

// ── 6-month outlook (deterministic) ──────────────────────────────────────────
// The old LLM "5 sharp predictions" path (SIGNALS_SCHEMA + buildSignals* prompts)
// was removed. The outlook slide is now built deterministically below from each
// category's outlook_assessment.

// 6-month outlook slide. When the caller supplies LLM-generated predictions
// (opts.outlookBullets — grounded in emerging research + the period's themes), we
// use those. Otherwise fall back to the deterministic per-category forecast so the
// slide is never empty even if the outlook LLM call failed.
async function buildSharpSignalsSlide(categoryAnalyses, allOutlooks, slideNumber, opts = {}) {
  let bullets = Array.isArray(opts.outlookBullets) ? opts.outlookBullets.filter(b => b?.text) : [];
  let headline = opts.outlookHeadline || "6-Month Outlook";

  if (!bullets.length) {
    for (const ca of categoryAnalyses) {
      const catLabel = CATEGORY_LABELS[ca.category] || ca.category;
      const forecast = ca.outlook_assessment?.likely_next_movement
        || (allOutlooks?.byCategory?.[ca.category]?.likely?.forecast)
        || "";
      if (forecast && forecast.length > 15) {
        bullets.push({ text: `${catLabel}: ${forecast.trim()}`, bullet_type: "signal" });
      }
    }
  }
  return {
    type:          "early_signals_watchlist",
    slide_number:  slideNumber,
    headline,
    argument:      "Where the AI threat landscape is heading over the next two quarters",
    bullets,
    speaker_notes: opts.outlookNotes || "Forward outlook grounded in this period's emerging research and confirmed developments.",
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

// NOTE: the per-category LLM slide PLANNER was removed 2026-06-25. Section
// structure is fixed deterministically; the LLM only writes slide content.
// 2026-07-09: removed scope_methodology + evidence_snapshot slides; replaced
// deterministic early-signals + per-category outlook with a single combined LLM
// call producing 5 sharp named predictions; upgraded development slides to
// include mechanism walkthrough; upgraded insights to 3-5 sharp claims.

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

// ── KEY FIGURE PRIORITY ORDER ─────────────────────────────────────────────────
//
// A Key Figure earns a slide callout only when it conveys one of (in priority):
//   1. Scale       — victims, accounts, orgs, downloads, packages affected
//   2. Efficacy    — attack success rate, bypass rate, detection rate
//   3. Speed       — time-to-exploit, dwell time, automation speed-up
//   4. Financial   — losses, ransom, fraud amount
//   5. Coverage    — products, sectors, countries affected
//
// NEVER select: ages, dates, timestamps, anecdotal narrative details, names,
// ransom negotiation amounts divorced from victim scale, version numbers.
//
// The old ">= 10 bare integer" fallback was the source of the "age 15" and
// "January 20 2023" bugs: parseNumValue("January 20, 2023") strips non-digits
// → 202023 ≥ 10; parseNumValue("15") = 15 ≥ 10. Both now explicitly rejected.

const VERSION_VALUE_RE = /^v?\d+(\.\d+){1,}[a-z0-9.\-]*$|^\d+\.x$|^\d+(\.\d+)*$/i;
const ADMIN_CONTEXT_RE = /\b(version|fixed|patched|affected|prior to|release|build|commit|cve-?\d|advisory|semver|tag|branch|rc\d|beta|alpha)\b/i;

// Temporal/narrative contexts that must never become a Key Figure.
const TEMPORAL_VALUE_RE  = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const TEMPORAL_CONTEXT_RE = /\b(date|dated|timestamp|when|time of|occurred|first observed|disclosed on|published on|reported on|discovered on)\b/i;
const NARRATIVE_CONTEXT_RE = /\b(age|years? old|born|daughter|son|wife|husband|child|victim's|hostage|kidnap|ransom demand|negotiat|personal|identity|name of)\b/i;

// Scale / efficacy / speed / financial / coverage — the five valid Key Figure types.
const SCALE_CONTEXT_RE    = /\b(victim|account|user|device|download|package|plugin|model|install|deploy|org|compan|customer|endpoint|record|credential|employee|member|client|system|host|server|repositor|dataset|sample|incident|breach|attack|campaign|skill|sector|countr|region)\w*\b/i;
const EFFICACY_CONTEXT_RE = /\b(success|bypass|evasion|detection|accuracy|precision|recall|f1|win rate|click.?rate|open.?rate|conversion|attack rate|failure|false positive|false negative)\w*\b/i;
const SPEED_CONTEXT_RE    = /\b(second|minute|hour|day|week|dwell|latency|window|time.?to|speed|faster|slower|duration|elapsed)\b/i;
const FINANCIAL_CONTEXT_RE = /\b(loss|lost|cost|ransom|fraud|theft|stolen|damage|revenue|fine|penalty|settlement)\w*\b/i;
const COVERAGE_CONTEXT_RE  = /\b(product|vendor|categor|platform|sector|industr|application|service|framework|tool|language|operating system|browser|extension)\w*\b/i;

function isMeaningfulFigure(n) {
  const val = String(n.value || "").trim();
  const ctx = String(n.context || "");

  // 1. Hard rejections — version strings and admin contexts.
  if (VERSION_VALUE_RE.test(val) && /\.\d|\.x/i.test(val)) return false;
  if (ADMIN_CONTEXT_RE.test(ctx)) return false;

  // 2. Hard rejections — dates (month name in value or temporal context label).
  if (TEMPORAL_VALUE_RE.test(val)) return false;
  if (TEMPORAL_CONTEXT_RE.test(ctx)) return false;

  // 3. Hard rejections — narrative/anecdotal details (age, names, negotiation rounds).
  if (NARRATIVE_CONTEXT_RE.test(ctx)) return false;

  // 4. Always keep percentage / multiplier / dollar values (inherently scale/efficacy).
  //    Time-unit values are kept only when context is speed/dwell, not when it's a date.
  if (n.unit === "%" || n.unit === "$" || n.unit === "×") return true;
  if (n.unit === "time" && SPEED_CONTEXT_RE.test(ctx)) return true;
  if (n.unit === "time") return false;  // time-unit but NOT a speed context → likely a date

  // 5. Bare integers accepted only when context matches one of the five valid types.
  if (SCALE_CONTEXT_RE.test(ctx))    return true;
  if (EFFICACY_CONTEXT_RE.test(ctx)) return true;
  if (FINANCIAL_CONTEXT_RE.test(ctx) && (n.parsed ?? 0) >= 1000) return true;  // only large $ amounts
  if (COVERAGE_CONTEXT_RE.test(ctx) && (n.parsed ?? 0) >= 3)    return true;

  // 6. No valid category matched → reject. The old ">= 10" fallback is removed
  //    because it was the direct cause of "age 15" and date-string bugs.
  return false;
}

// suggestion is the LLM's decision: "comparison_bar"|"stat_cluster"|"before_after"|"cost_comparison"|"none"|null
// "none" or null → no visual. Any other value → run deterministic builder constrained to that type.
// A figure must appear in its OWN evidence item's text (fact/quote). This grounds
// Key Figures even for evidence cached before the extract-time `grounded` flag
// existed — a number the model attached but that isn't in its own evidence text is
// not trustworthy as a headline figure. Tolerates thousands separators and units.
function figureInEvidenceText(value, ei) {
  const digits = (String(value || "").match(/\d[\d,.]*/) || [])[0];
  if (!digits) return true;                       // word-form figure — don't penalise
  const core = digits.replace(/[.,]+$/, "");
  const text = `${ei.fact || ""} ${ei.quote || ""}`;
  return text.includes(core) || text.includes(core.replace(/,/g, "")) ||
         text.includes(Number(core.replace(/,/g, "")).toLocaleString("en-US"));
}

export function buildVisualSpec(evidenceForSlide, suggestion) {
  if (!suggestion || suggestion === "none") return null;
  const allNums = evidenceForSlide.flatMap(ei =>
    (ei.numbers || [])
      // Drop figures explicitly flagged as hallucinated at extraction (grounded===false),
      .filter(n => n?.grounded !== false)
      // AND self-ground against the evidence item's own text — covers cached evidence
      // (extracted before the grounded flag) so a fabricated headline figure can't slip in.
      .filter(n => figureInEvidenceText(n.value, ei))
      .map(n => ({
        value:       n.value,
        context:     n.context,
        evidence_id: ei.evidence_id,
        unit:        detectNumUnit(n.value),
        parsed:      parseNumValue(n.value),
      }))
  ).filter(n => n.value && n.context)
   .filter(isMeaningfulFigure);   // drop CVE versions / structural trivia

  if (allNums.length === 0) return null;

  // Deduplicate by value — the same number can appear in multiple evidence items
  // (e.g. the iOS leakage paper citing "444 apps" appears in both a research item and
  // a news item, producing two identical metrics). Keep first occurrence only.
  const seenValues = new Set();
  const deduped = allNums.filter(n => {
    const key = String(n.value).trim().toLowerCase();
    if (seenValues.has(key)) return false;
    seenValues.add(key);
    return true;
  });
  if (deduped.length === 0) return null;
  // Replace allNums with deduplicated set for all subsequent chart building.
  allNums.length = 0;
  allNums.push(...deduped);

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

const MECH_PREFIX = /^(how:|the attack works:|mechanism:|step:|attacker|via |using |by )/i;
function detectBulletType(text) {
  if (REC_VERBS.test(text))   return "recommendation";
  if (IMP_WORDS.test(text))   return "implication";
  if (MECH_PREFIX.test(text)) return "mechanism";
  if (NUM_PATTERN.test(text)) return "data_point";
  return "claim";
}

// Coerce any shape the LLM returns for bullet text into a plain string. Guards
// against the [object Object] bug where a model nests { claim, detail } under
// `text` or `insight` instead of returning a flat string.
function coerceText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    // Common nested shapes: {text}, {claim}, {insight}, {statement}
    return coerceText(v.text ?? v.claim ?? v.insight ?? v.statement ?? v.value ?? "");
  }
  return String(v);
}

// Hard brevity + plainness enforcement — the model cannot be trusted to always
// comply, so we mechanically enforce: one idea (first clause before a semicolon),
// no version strings / CVE IDs, and a word cap truncated at a word boundary.
//
// VERSION_RE strips software version strings (1.139.0, v2.9, 1.82.7-1.82.8) but
// MUST NOT strip percentages (90.3%) or multipliers (26.08x, 26x) — those are
// key evidence figures. Negative lookahead (?![%×x]) excludes them.
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:[–-]\d+\.\d+(?:\.\d+)?)?(?![%×x])\b/gi;
const CVE_ID_RE  = /\bCVE[-–]\d{4}[-–]\d{3,}\b/gi;
const MAX_BULLET_WORDS = 28;

function tightenBulletText(text) {
  let t = String(text || "").trim();
  // Take only the first clause — a semicolon means the model stacked ideas.
  const semi = t.indexOf(";");
  if (semi > 20) t = t.slice(0, semi);
  // Comma-enumeration guard: "A, B, C, D, and E" crams many ideas into one bullet.
  // If there are 3+ commas, the model made a list — keep the lead-in up to the
  // SECOND comma and stop (drops the rest of the catalogue).
  if ((t.match(/,/g) || []).length >= 3) {
    const parts = t.split(",");
    t = parts.slice(0, 2).join(",").trim();
  }
  // Strip version strings and CVE IDs entirely (board-level deck).
  t = t.replace(CVE_ID_RE, "").replace(VERSION_RE, "");
  // Collapse "versions  –" leftovers and double spaces.
  t = t.replace(/\bversions?\b\s*/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;)])/g, "$1").trim();
  // Hard word cap — truncate at a word boundary, drop a trailing partial clause.
  const words = t.split(/\s+/);
  if (words.length > MAX_BULLET_WORDS) {
    t = words.slice(0, MAX_BULLET_WORDS).join(" ").replace(/[,;:]\s*\S*$/, "").replace(/[.;,]+$/, "");
  }
  // Ensure it ends cleanly.
  t = t.replace(/[\s,;:]+$/, "");
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t.trim();
}

// Headline tightener: strip version/CVE noise, cap at ~11 words so a headline is
// always a short strategic claim, never a jargon catalogue.
const MAX_HEADLINE_WORDS = 14;
function tightenHeadline(text) {
  let t = String(text || "").replace(CVE_ID_RE, "").replace(VERSION_RE, "")
    .replace(/\bversions?\b\s*/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;)])/g, "$1").trim();
  const words = t.split(/\s+/);
  if (words.length > MAX_HEADLINE_WORDS) {
    t = words.slice(0, MAX_HEADLINE_WORDS).join(" ").replace(/[,;:]\s*\S*$/, "").replace(/[.;,]+$/, "");
  }
  return t.trim();
}

function normaliseBullet(b) {
  const raw         = typeof b === "string" ? b : coerceText(b?.text ?? b);
  let   text        = String(raw).replace(EVIDENCE_ID_LEAK, "").replace(SOURCE_TAG_LEAK, "")
    .replace(/^[-–—•]\s+/, "")   // strip leading dash/bullet char if the LLM emitted one
    .trim();
  text              = tightenBulletText(text);
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
          bullet_type: { type: "string", enum: ["claim","data_point","mechanism","implication","recommendation","signal"] },
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

// Batch schema: one call generates all top_happenings slides for a category.
const BATCH_SLIDE_SCHEMA = {
  type: "object",
  required: ["slides"],
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        required: ["headline", "bullets", "speaker_notes", "visual_suggestion"],
        properties: {
          headline:          { type: "string" },
          speaker_notes:     { type: "string" },
          citations:         { type: "array", items: { type: "string" } },
          visual_suggestion: { type: "string", enum: ["comparison_bar","stat_cluster","before_after","cost_comparison","none"] },
          bullets: {
            type: "array",
            items: {
              type: "object",
              required: ["text"],
              properties: {
                text:        { type: "string" },
                evidence_id: { type: "string" },
                bullet_type: { type: "string", enum: ["claim","data_point","mechanism","implication","recommendation","signal"] },
              },
            },
          },
        },
      },
    },
  },
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

// Lazy-loaded system prompts — loaded once from prompt files on first use.
let _caseStudySystem    = null;
let _slideSystem        = null;
let _themeSystem        = null;
let _catInsightsSystem  = null;

function buildCaseStudySystem() {
  if (!_caseStudySystem) _caseStudySystem = loadPrompt("slides/slide-case-study").system;
  return _caseStudySystem;
}

function buildCatInsightsSystem() {
  if (!_catInsightsSystem) _catInsightsSystem = loadPrompt("slides/slide-category-insights").system;
  return _catInsightsSystem;
}

function buildCatInsightsUser(catLabel, judgments, evidenceIndex, categoryNarrative = "") {
  const lines = [
    `CATEGORY: ${catLabel}`,
    ``,
  ];
  if (categoryNarrative) {
    lines.push(`PERIOD NARRATIVE (the one question this section answers):`);
    lines.push(`  "${categoryNarrative}"`);
    lines.push(`All bullets on this slide must support this narrative.`);
    lines.push(``);
  }
  lines.push(`JUDGMENTS THIS PERIOD (${judgments.length} — each is a different mechanism/layer/victim):`);
  for (const j of judgments) {
    lines.push(`\n[${j.evidence_maturity || "?"}] ${j.judgment}`);
    if (j.what_changed)     lines.push(`  What changed: ${j.what_changed}`);
    if (j.causal_mechanism) lines.push(`  How it works: ${j.causal_mechanism}`);
    if (j.why_this_matters) lines.push(`  Why it matters: ${j.why_this_matters}`);
    const evSample = (j.evidence_for || []).slice(0, 2).map(id => evidenceIndex[id]).filter(Boolean);
    for (const ev of evSample) {
      lines.push(`  Evidence [${ev.evidence_id}]: ${ev.fact.slice(0, 180)}`);
    }
  }
  lines.push(`
RULES FOR THIS SLIDE:
- Headline = 6–10 words naming the PATTERN across these developments, not any single event.
  BAD:  "${catLabel} — Mobile Apps Leak API Credentials"  (one paper, not a pattern)
  GOOD: "${catLabel} — Secret Management Is Shifting to the Client Edge"  (cross-source shift)
- Each bullet must address a DIFFERENT judgment (different mechanism or layer).
- An insight bullet requires ≥2 sources. A single-source finding → use "data_point" not "claim".
- Do NOT repeat the headline of any top_happenings slide that follows.
- Cite evidence_id on every bullet.

Return JSON: { "headline": "...", "bullets": [...], "speaker_notes": "...", "visual_suggestion": "..." }`);
  return lines.join("\n");
}

function buildCaseStudyUser(plan, evidenceForSlide, judgment) {
  const evLines = evidenceForSlide.map(ev => {
    const pub = ev.publisher || ev.source_title || "unknown";
    // Expose full walkthrough structure when available — far richer than fact alone.
    if (ev.walkthrough_steps?.length) {
      const actor = ev.walkthrough_actor && ev.walkthrough_actor !== "unattributed"
        ? ev.walkthrough_actor : "Threat actor";
      const lines = [
        `[${ev.evidence_id}][walkthrough] ${actor} — ${ev.walkthrough_technique || ev.fact.slice(0, 100)}`,
        ev.walkthrough_mechanism ? `  Mechanism: ${ev.walkthrough_mechanism}` : "",
        `  Steps: ${ev.walkthrough_steps.map((s, i) => `${i+1}. ${s}`).join(" → ")}`,
        ev.walkthrough_impact ? `  Impact: ${ev.walkthrough_impact}` : "",
        ev.quote ? `  Quote: "${ev.quote}"` : "",
        `  Source: ${pub}`,
      ];
      return lines.filter(Boolean).join("\n");
    }
    return `[${ev.evidence_id}][${ev.evidence_type}] ${ev.fact}\n  Quote: "${ev.quote || ""}"\n  Source: ${pub}`;
  }).join("\n\n");

  // If attack stages were pre-extracted from the report (analyst main_claims),
  // tell the LLM to use them as the attack chain rather than inferring it.
  const stagesHint = plan.attack_stages?.length
    ? `\nATTACK CHAIN (from the analyst's report — use as the backbone of the story):\n${plan.attack_stages.map((s, i) => `  ${i+1}. ${s}`).join("\n")}\n`
    : "";

  // The analyst's brief gives the strategic framing of the incident.
  const briefHint = plan.analyst_brief
    ? `\nANALYST FRAMING: ${plan.analyst_brief}\n`
    : "";

  const jLine = judgment ? `\nDRIVING JUDGMENT: ${judgment.judgment}\n  Why it matters: ${judgment.why_this_matters || ""}` : "";
  return `Write a case-study slide (ONE incident, told start to finish) for: ${plan.argument}
${jLine}${briefHint}${stagesHint}

EVIDENCE (use these for the attack story; cite exact evidence_ids):
${evLines || "(no direct evidence — do not fabricate a case study)"}

Identify the single named_entity this case centres on, a conclusion headline, and 3-4 typed bullets
(Evidence steps → Implication). Do NOT write a recommendation bullet. Then speaker notes.`;
}

function buildSlideSystem() {
  if (!_slideSystem) _slideSystem = loadPrompt("slides/slide-content").system;
  return _slideSystem;
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

// ── Theme slide system prompt (batch) ────────────────────────────────────────
// ── Theme slide system prompt (batch) ────────────────────────────────────────
// Loaded from lib/prompts/slides/slide-theme.md — edit the prose there, not here.
function buildThemeSlideSystem() {
  if (!_themeSystem) _themeSystem = loadPrompt("slides/slide-theme").system;
  return _themeSystem;
}

// ── Batch user prompt for top_happenings ─────────────────────────────────────
// Packages all judgments for one category into a single prompt.
// The model returns { slides: [...] } in the same order as the input plans.

function buildBatchSlideUser(plans, evidenceIndex, judgmentIndex, batchOpts = {}) {
  const {
    prior_slide_context      = null,  // argument of the slide immediately before this batch
    prohibited_repeated_claims = [],  // claims already made in earlier slides (strings)
  } = batchOpts;
  const cat = (plans[0].category || "").replace(/_/g, " ");
  const lines = [
    `Generate ${plans.length} STRATEGIC INSIGHT slides for the "${cat}" threat category.`,
    `Return { "slides": [ ...${plans.length} objects in order ] }.`,
    ``,
    `━━ THE SINGLE MOST IMPORTANT RULE: BE SPECIFIC ━━`,
    `Every bullet must name at least ONE of: a specific product, tool, actor, organisation, or`,
    `measured number. Bullets that could apply to any AI threat are WRONG.`,
    ``,
    `  ✗ WRONG: "Attackers are exploiting AI coding tools to access files."`,
    `  ✓ RIGHT: "Six AI coding assistants (including Cursor and Copilot) follow symlinks outside their workspace."`,
    ``,
    `  ✗ WRONG: "AI models on public platforms can contain hidden malware."`,
    `  ✓ RIGHT: "A typosquatted model on HuggingFace reached 200,000 downloads before detection."`,
    ``,
    `  ✗ WRONG: "LLM infrastructure vulnerabilities can expose API keys."`,
    `  ✓ RIGHT: "A misconfigured LiteLLM gateway leaked every upstream provider API key via path traversal."`,
    ``,
    `━━ PLAIN ENGLISH RULES (for board-level audience) ━━`,
    `  ✗ NEVER write CVE numbers in bullet text. Say "a critical flaw in [named product]" instead.`,
    `  ✗ NEVER write version strings. Say "a poisoned update to [named package]" instead.`,
    `  ✗ NEVER stack more than 2 product names per bullet. Keep the most specific one.`,
    `  ✓ Product names ARE allowed — explain what the product does if it's not obvious.`,
    `     e.g. "LiteLLM (the AI gateway)" or "vLLM (the model inference server)"`,
    `  ✓ Actor names ARE allowed. Say "nation-state group" or "criminal group" if uncertain.`,
    `  ✓ Keep ONE striking number per bullet (a %, a count, a $ figure) — these make bullets concrete.`,
    ``,
    `━━ HEADLINE ━━`,
    `Use the supplied headline VERBATIM (it is already the insight). Do NOT replace it.`,
    ``,
    `━━ BULLET STRUCTURE (exactly 3, in this order) ━━`,
    `  1. The Finding   (bullet_type "claim")`,
    `     State WHAT is happening using the SPECIFIC named entity from WHAT CHANGED below.`,
    `     If the intel names "GhostApproval" or "symlink traversal" or "200,000 downloads" — USE IT.`,
    `     Do NOT abstract it to "an attacker plugin" or "a file access issue".`,
    `     Cite the strongest evidence_id.`,
    ``,
    `  2. The Proof     (bullet_type "data_point")`,
    `     Give the ONE most striking concrete fact from the evidence: a named incident, a number,`,
    `     a named victim, or a named actor. This is the "show don't tell" bullet.`,
    `     Example: "GhostApproval extension reached 26,000 enterprise GitHub Copilot accounts."`,
    `     Example: "GPT-4o personalised phishing achieved 54% click-rate vs 12% for templates."`,
    `     Cite an evidence_id — ideally from a DIFFERENT source than bullet 1.`,
    ``,
    `  3. So what       (bullet_type "implication")`,
    `     Which specific defender control or trust assumption now fails, and why.`,
    `     Example: "Marketplace vetting cannot catch post-publish payload updates."`,
    `     Example: "Signature-based filters fail — every email is unique, no shared pattern to block."`,
    `     Cite the evidence_id that drives this implication.`,
    ``,
    `Do NOT write a recommendation/action bullet. Exactly 3 bullets. Each ≤22 words.`,
  ];

  // Prior slide context — prevents repeating the previous slide's argument.
  if (prior_slide_context) {
    lines.push(`\n━━ PRIOR SLIDE (do NOT repeat its conclusion) ━━`);
    lines.push(prior_slide_context);
  }

  // Prohibited claims — conclusions already made earlier in this category section.
  if (prohibited_repeated_claims.length > 0) {
    lines.push(`\n━━ PROHIBITED REPEATED CLAIMS (these have already been stated — do NOT restate them) ━━`);
    for (const claim of prohibited_repeated_claims) {
      lines.push(`  ✗ ${claim.slice(0, 100)}`);
    }
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const judgment   = plan.judgment_id ? judgmentIndex[plan.judgment_id] : null;
    const evForSlide = (plan.evidence_ids || []).map(id => evidenceIndex[id]).filter(Boolean);

    const mechanism  = plan.causal_mechanism  || judgment?.causal_mechanism  || "";
    const changed    = plan.what_changed      || judgment?.what_changed      || "";
    const matters    = plan.why_this_matters  || judgment?.why_this_matters  || "";
    const action     = plan.recommended_action|| judgment?.recommended_action|| "";
    const maturity   = judgment?.evidence_maturity || "unknown";
    const subVectors = Array.isArray(plan.sub_vectors) ? plan.sub_vectors : [];

    lines.push(`\n${"═".repeat(60)}`);
    lines.push(`SLIDE ${i + 1} of ${plans.length}   [maturity: ${maturity}]`);
    lines.push(`\nHEADLINE (use this as the slide title — it is the strategic insight):`);
    lines.push(plan.argument);
    if (subVectors.length) {
      lines.push(`\nSUB-VECTORS this insight spans (name these in the Pattern bullet):`);
      lines.push(subVectors.map(v => `  • ${v}`).join("\n"));
    }
    lines.push(`\nWHAT CHANGED — USE THIS FOR BULLET 1 (specific named entities preserved from intel analysis):`);
    lines.push(changed || "(derive from evidence below — must name a specific product, actor, or technique)");
    lines.push(`\nHOW THE ATTACK WORKS (specific mechanism — use for the context of bullet 1 or 2):`);
    lines.push(mechanism || "(derive from evidence below)");
    lines.push(`\nWHICH ASSUMPTION BREAKS — USE THIS FOR BULLET 3 (the "So what"):`);
    lines.push(matters || "(derive from evidence below)");

    const evLines = evForSlide.map(ev => {
      const pub    = ev.publisher || ev.source_title || "unknown";
      const numStr = (ev.numbers || []).length
        ? `\n  Numbers: ${ev.numbers.map(n => `${n.value} (${n.context})`).join(", ")}`
        : "";
      const quoteStr = ev.quote ? `\n  Quote: "${ev.quote.slice(0, 300)}"` : "";
      return `[${ev.evidence_id}][${ev.evidence_type}][${pub}]\n  Fact: ${ev.fact}${quoteStr}${numStr}`;
    }).join("\n\n");

    lines.push(`\nEVIDENCE — cite from these; bullet 2 should use a DIFFERENT source than bullet 1:\n${evLines || "(none — derive bullets from WHAT CHANGED above)"}`);
  }

  lines.push(`\n${"═".repeat(60)}`);
  lines.push(`slides[0] is SLIDE 1, etc. Each slide: keep the supplied HEADLINE verbatim, then`);
  lines.push(`EXACTLY 3 plain-language bullets — Pattern → Proof → So what. No recommendations.`);
  lines.push(`No CVE numbers, no version strings. Return JSON now.`);
  return lines.join("\n");
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

// A case study needs a NAMED entity (CVE / actor / malware) and a multi-step
// operational story. Detect a case-worthy evidence subset for a category.
const CVE_RE = /\bCVE-\d{4}-\d{3,}\b/i;
const CASE_EVIDENCE_TYPES = new Set([
  "incident", "exploit_disclosure", "observed_exploitation",
  "adversary_adoption", "operational_campaign", "threat_intelligence",
  "threat_actor_activity",
]);
// An AI nexus the FACT text must actually show (not merely a tag) — used to keep
// non-AI incidents out of an AI threat brief. Deliberately excludes bare "model"/
// "agent" (too noisy); requires an explicit AI term.
const AI_NEXUS_RE = /\b(?:A\.?I\.?|artificial intelligence|LLM|large language model|GPT|generative|deepfake|voice clon\w*|machine learning|\bML\b|chatbot|prompt injection|prompt[- ]?inject\w*|neural network|AI-(?:generated|powered|enabled|assisted)|fine-tuned model|exploit generation|jailbreak)\b/i;

function caseStudyPlanFor(ca, pack) {
  const items = [...(pack?.strong || []), ...(pack?.usable || [])];
  let worthy = items.filter(e => CVE_RE.test(e.fact || "") || CASE_EVIDENCE_TYPES.has(e.evidence_type));
  // A case study in an AI threat brief MUST actually involve AI. For ai_enabled
  // (AI-as-attack-tool), the FACT text — not just a tag — must show an AI nexus;
  // AE tags are over-applied (e.g. a credential-phishing actor tagged AE02 with no
  // AI in the fact). Without this, a purely-conventional intrusion becomes the
  // "AI-Enabled Threats" case study. Drop case evidence with no AI signal; if that
  // leaves <2, emit NO case study rather than a misleading one.
  if (ca.category === "ai_enabled_threats") {
    worthy = worthy.filter(e => AI_NEXUS_RE.test(e.fact || ""));
  }
  if (worthy.length < 2) return null;   // need a real multi-step operational story
  const label = CATEGORY_LABELS[ca.category] || ca.category;
  return {
    type:         "case_study",
    argument:     `Case study — ${label}`,
    evidence_ids: worthy.slice(0, 6).map(e => e.evidence_id),
    judgment_id:  (ca.judgments || []).find(j => !j.blocked)?.judgment_id,
  };
}

// Deterministic, judgment-driven section plan.
// Per-category: up to 3 KEY-DEVELOPMENT slides (one per judgment, each with
// mechanism walkthrough) + 1 INSIGHTS slide (3-5 sharp named predictions) +
// optional CASE STUDY. Evidence is sorted realized/proven/starred first.
function deterministicCategoryPlan(ca, pack, evidenceIndex = {}, preselectedCaseStudy = null) {
  const approved = (ca.judgments || []).filter(j => !j.blocked);
  if (!approved.length) return [];
  const label = CATEGORY_LABELS[ca.category] || ca.category;

  // Sort judgments: realized > proven > research, then by evidence count
  const REALITY_RANK = { realized: 3, proven: 2, research: 1 };
  const sortedJudgments = [...approved].sort((a, b) => {
    const ra = REALITY_RANK[a.evidence_maturity] || 0;
    const rb = REALITY_RANK[b.evidence_maturity] || 0;
    if (ra !== rb) return rb - ra;
    return (b.evidence_for?.length || 0) - (a.evidence_for?.length || 0);
  });

  // Top-insights overview slide — one per category, leads the section.
  // Gives executives a single-slide summary of all key findings before the detail slides.
  const topEvIds = [...new Set(
    sortedJudgments.slice(0, 3).flatMap(j => j.evidence_for || []).slice(0, 8)
  )];
  // Skip the insights overview when only one judgment survived QA — it would just
  // duplicate the first top_happenings slide. Two judgments required to form a pattern.
  const insightsSlides = sortedJudgments.length >= 2 ? [{
    type:               "category_insights",
    slide_role:         SLIDE_TYPE_ROLE["category_insights"],
    argument:           `Top ${label} Insights`,
    evidence_ids:       topEvIds,
    judgment_id:        null,
    // Pass the category narrative so the insights slide can frame its bullets
    // around the period's defining theme rather than listing independent facts.
    _category_narrative: ca.category_narrative || "",
    _cat_judgments:     sortedJudgments.slice(0, 6).map(j => ({
      judgment:          j.judgment,
      what_changed:      j.what_changed    || "",
      causal_mechanism:  j.causal_mechanism|| "",
      why_this_matters:  j.why_this_matters|| "",
      evidence_maturity: j.evidence_maturity || "research_demonstration",
      evidence_for:      j.evidence_for || [],
    })),
    category: ca.category,
  }] : [];
  const plan = [...insightsSlides];

  // Theme slides — up to 4, one per judgment, each with mechanism walkthrough.
  const devJudgments = sortedJudgments.slice(0, 4);
  plan.push(...devJudgments.map((j, i) => ({
    type:       "top_happenings",
    slide_role: SLIDE_TYPE_ROLE["top_happenings"],
    // The argument IS the theme insight — this becomes the slide headline.
    argument:          j.judgment || `Key development — ${label}`,
    sub_vectors:       Array.isArray(j.sub_vectors) ? j.sub_vectors : [],
    is_theme:          j.is_theme === true,
    causal_mechanism:  j.causal_mechanism  || "",
    what_changed:      j.what_changed      || "",
    why_this_matters:  j.why_this_matters  || "",
    recommended_action: j.recommended_action || "",
    // Theme slides cite MULTIPLE sources — keep up to 8 evidence ids, diversified
    // across distinct sources so the pattern bullet is genuinely multi-source.
    evidence_ids: (() => {
      const ids = j.evidence_for || [];
      const RRANK = { realized: 3, proven: 2, research: 1 };
      const sorted = [...ids].sort((a, b) => {
        const ea = evidenceIndex[a], eb = evidenceIndex[b];
        if ((ea?.starred ? 1 : 0) !== (eb?.starred ? 1 : 0))
          return (eb?.starred ? 1 : 0) - (ea?.starred ? 1 : 0);
        return (RRANK[eb?.importance_tier] || 0) - (RRANK[ea?.importance_tier] || 0);
      });
      // Diversify: prefer one evidence item per source before doubling up
      const seen = new Set(), diverse = [], rest = [];
      for (const id of sorted) {
        const sid = evidenceIndex[id]?.source_id;
        if (sid && !seen.has(sid)) { seen.add(sid); diverse.push(id); }
        else rest.push(id);
      }
      return [...diverse, ...rest].slice(0, 8);
    })(),
    judgment_id:  j.judgment_id,
    dev_index:    i + 1,
    dev_total:    devJudgments.length,
  })));

  // Use preselected case study from selectCaseStudies (walkthrough-backed when
  // available) rather than re-running caseStudyPlanFor independently.
  if (preselectedCaseStudy) {
    plan.push({
      type:          "case_study",
      slide_role:    SLIDE_TYPE_ROLE["case_study"],
      argument:      `Case study — ${label}`,
      evidence_ids:  preselectedCaseStudy.evidence_ids || [],
      judgment_id:   (ca.judgments || []).find(j => !j.blocked)?.judgment_id,
      // Pre-extracted attack stages — handed directly to buildCaseStudyUser so
      // the LLM uses the real attack chain from the report, not a reconstructed one.
      attack_stages: preselectedCaseStudy.attack_stages || [],
      named_entity:  preselectedCaseStudy.named_entity  || "",
      analyst_brief: preselectedCaseStudy.analyst_brief || "",
    });
  } else {
    const caseSlide = caseStudyPlanFor(ca, pack);
    if (caseSlide) plan.push({ ...caseSlide, slide_role: SLIDE_TYPE_ROLE["case_study"] });
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

// ── Slide type alias map for backward compatibility ───────────────────────────
export const SLIDE_TYPE_ALIASES = {
  top_happenings:   "category_development",
  category_insights: "category_insight",
};

export async function buildPresentation(categoryAnalyses, crossCategory, evidenceItemsRaw, opts = {}, externalSlidePlan = null) {
  const { caseStudies = null } = opts;
  // Drop weak-source evidence up front so neither claims nor citations use it.
  const evidenceItems = (evidenceItemsRaw || []).filter(ei => !isWeakSource(ei));

  // Merge starred + importance_tier onto each evidence item so sorting works
  // in deterministicCategoryPlan without needing a separate DB lookup.
  // opts.starredSourceUrls: Set<string> of URLs from starred=true sources.
  // opts.importanceTierByUrl: Map<url, tier> from intelligence.importance.tier.
  const starredUrls   = opts.starredSourceUrls   ? new Set(opts.starredSourceUrls)  : new Set();
  const importanceMap = opts.importanceTierByUrl  ? new Map(Object.entries(opts.importanceTierByUrl)) : new Map();
  for (const ei of evidenceItems) {
    if (!ei.starred && ei.source_url && starredUrls.has(ei.source_url)) ei.starred = true;
    if (!ei.importance_tier && ei.source_url) ei.importance_tier = importanceMap.get(ei.source_url) || null;
  }

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

  // ── Step 2: Per-category section plan (deterministic skeleton) ───────────────
  // Structure: up to 3 Key-Development slides (with mechanism walkthrough) +
  // 1 Insights slide (3-5 sharp named predictions) + optional Case Study.
  // Evidence is sorted realized/proven/starred first within each judgment.
  const categorySections = {};
  for (const ca of categoryAnalyses) {
    categorySections[ca.category] = deterministicCategoryPlan(
      ca, evidenceByCategory[ca.category], evidenceIndex,
      caseStudies?.[ca.category] || null,
    );
  }

  // ── Step 5: Deterministic 6-month outlook (from per-category outlook_assessment)
  const allOutlooks = opts.allOutlooks || null;

  // ── Step 6: Assemble full slide plan ─────────────────────────────────────────
  const internalSlidePlan = [
    { type: "cover", slide_role: null, argument: "AI Cyber Threat Horizon Scan", evidence_ids: [], deterministic: true },
    ...CATEGORY_ORDER.flatMap(cat => {
      const section = categorySections[cat] || [];
      if (section.length === 0) return [];
      return [
        { type: "section_intro", slide_role: null, argument: CATEGORY_LABELS[cat], evidence_ids: [], category: cat, deterministic: true },
        ...section.map(s => ({ ...s, category: cat })),
      ];
    }),
    // Placeholder — replaced by the deterministic outlook slide built below
    { type: "early_signals_watchlist", slide_role: SLIDE_TYPE_ROLE["early_signals_watchlist"], argument: "6-Month Forward Signals", evidence_ids: [], _placeholder: true },
    // Cross-category slide removed per design.
  ].map((s, i) => ({
    ...s,
    type:       s.type || s.slide_type,
    slide_role: s.slide_role ?? SLIDE_TYPE_ROLE[s.type || s.slide_type] ?? null,
    slide_number: i + 1,
  }));

  console.log(`  [L7] ${internalSlidePlan.length} slides planned`);

  // ── Step 6.5: Pre-generate top_happenings in category batches ────────────────
  // Group all top_happenings slides by category and make 1 call per category
  // (instead of 1 per judgment). Reduces 12 Sonnet calls → 4 and shares the
  // cached system prompt write across all categories in a single run.
  // Results are stored on plan._batch_raw; the main loop uses them if present.
  if (!opts.skipLlm) {
    const catGroups = {};
    for (const plan of internalSlidePlan) {
      if (plan.type === "top_happenings" && plan.category) {
        if (!catGroups[plan.category]) catGroups[plan.category] = [];
        catGroups[plan.category].push(plan);
      }
    }

    // Build per-category prior-slide context: the category_insights slide argument
    // that precedes each batch of top_happenings slides.
    const catPriorContext = {};
    for (const plan of internalSlidePlan) {
      if (plan.type === "category_insights" && plan.category) {
        catPriorContext[plan.category] = plan.argument;
      }
    }

    // Run category batches in parallel (4 calls, independent of each other)
    await Promise.all(Object.entries(catGroups).map(async ([cat, plans]) => {
      const sys = buildThemeSlideSystem();
      const usr = buildBatchSlideUser(plans, evidenceIndex, judgmentIndex, {
        prior_slide_context: catPriorContext[cat] || null,
        // No prohibited claims yet at this stage (insights slide runs separately)
        prohibited_repeated_claims: [],
      });
      try {
        let raw;
        try {
          const { result } = await routedLLM(sys, usr, {
            task: "slide_content_batch", requires_json: true, schema: BATCH_SLIDE_SCHEMA,
          });
          raw = typeof result === "string" ? JSON.parse(result) : result;
        } catch {
          const text = await callLLM(sys, usr, { schema: BATCH_SLIDE_SCHEMA, json: true });
          raw = typeof text === "string" ? JSON.parse(text) : text;
        }
        const batchSlides = raw?.slides || [];
        plans.forEach((plan, i) => { if (batchSlides[i]) plan._batch_raw = batchSlides[i]; });
        process.stdout.write(`  [L7-batch] ${cat}: ${batchSlides.length}/${plans.length} slides\n`);
      } catch (err) {
        process.stdout.write(`  [L7-batch] ${cat} failed (${err.message.slice(0, 60)}) — falling back to per-slide\n`);
      }
    }));
  }

  // ── Step 7: Generate LLM slide content ──────────────────────────────────────
  const slides = [];
  // 6 concurrent independent LLM calls — each slide is fully isolated, and
  // Anthropic's API handles parallel requests well within rate limits.
  const SLIDE_CONCURRENCY = 6;
  // Build the sharp signals slide now (1 LLM call for all 5 predictions at once)
  const signalsSlide = await buildSharpSignalsSlide(categoryAnalyses, allOutlooks, 0, {
    skipLlm: opts.skipLlm,
    outlookBullets:  opts.outlookBullets,
    outlookHeadline: opts.outlookHeadline,
    outlookNotes:    opts.outlookNotes,
  });

  const SKIP_TYPES = new Set([
    "cover", "section_intro", "scope_methodology",
    "evidence_snapshot", "evidence_gaps",
  ]);

  for (let i = 0; i < internalSlidePlan.length; i += SLIDE_CONCURRENCY) {
    const batch = internalSlidePlan.slice(i, i + SLIDE_CONCURRENCY);
    const generated = await Promise.all(batch.map(async plan => {
      // Signals placeholder → replace with the pre-built LLM signals slide
      if (plan._placeholder && plan.type === "early_signals_watchlist") {
        return { ...signalsSlide, slide_number: plan.slide_number };
      }

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

      // Category insights slide — LLM call with all judgments as context
      if (plan.type === "category_insights" && !opts.skipLlm) {
        const catLabel = CATEGORY_LABELS[plan.category] || plan.category || "Threat Category";
        const catJudgments = plan._cat_judgments || [];
        const evForSlide = (plan.evidence_ids || []).map(id => evidenceIndex[id]).filter(Boolean);
        try {
          let raw;
          const sys = buildCatInsightsSystem();
          const usr = buildCatInsightsUser(catLabel, catJudgments, evidenceIndex, plan._category_narrative || "");
          try {
            const { result } = await routedLLM(sys, usr, { task: "slide_content_insights", requires_json: true, schema: SLIDE_SCHEMA });
            raw = typeof result === "string" ? JSON.parse(result) : result;
          } catch {
            const text = await callLLM(sys, usr, { schema: SLIDE_SCHEMA, json: true });
            raw = typeof text === "string" ? JSON.parse(text) : text;
          }
          const suggestion = raw?.visual_suggestion || "none";
          return {
            ...plan,
            headline:          tightenHeadline(coerceText(raw?.headline).trim() || plan.argument),
            bullets:           (raw?.bullets || []).slice(0, 5).map(normaliseBullet),
            speaker_notes:     raw?.speaker_notes || "",
            citations:         raw?.citations || plan.evidence_ids || [],
            visual_suggestion: suggestion,
            visual_spec:       buildVisualSpec(evForSlide, suggestion),
          };
        } catch (err) {
          return {
            ...plan,
            headline:          plan.argument,
            bullets:           catJudgments.slice(0, 5).map(j => ({
              text: tightenBulletText(j.judgment || ""),
              bullet_type: "claim",
            })),
            speaker_notes:     "",
            citations:         plan.evidence_ids || [],
            visual_spec:       null,
            visual_suggestion: "none",
          };
        }
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

      // Use pre-generated batch result (top_happenings processed in Step 6.5)
      if (plan._batch_raw) {
        const raw        = plan._batch_raw;
        const suggestion = raw.visual_suggestion || "none";
        // For theme slides the headline IS the strategic insight. Fall back to the
        // full argument (the insight), never a mid-sentence 80-char truncation.
        const themeHead = tightenHeadline(coerceText(raw.headline).trim() || plan.argument);
        return {
          ...plan,
          headline:          themeHead,
          bullets:           (raw.bullets || []).slice(0, 3).map(normaliseBullet),
          speaker_notes:     raw.speaker_notes     || "",
          citations:         raw.citations         || plan.evidence_ids || [],
          visual_suggestion: suggestion,
          visual_spec:       buildVisualSpec(evForSlide, suggestion),
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

      const isCase  = plan.type === "case_study";
      const isTheme = plan.is_theme === true;   // top_happenings strategic-insight slide
      try {
        // Theme slides use the SAME theme prompt as the batch path (a single-plan
        // batch), so a batch failure that drops to per-slide stays consistent —
        // never the old entity-headline buildSlideSystem, which conflicts.
        const sys    = isCase  ? buildCaseStudySystem()
                     : isTheme ? buildThemeSlideSystem()
                     :           buildSlideSystem();
        const usr    = isCase  ? buildCaseStudyUser(plan, evForSlide, judgment)
                     : isTheme ? buildBatchSlideUser([plan], evidenceIndex, judgmentIndex)
                     :           buildSlideUser(planWithSignals, evForSlide, judgment);
        const schema = isCase  ? CASE_STUDY_SCHEMA
                     : isTheme ? BATCH_SLIDE_SCHEMA
                     :           SLIDE_SCHEMA;
        let raw;
        try {
          const { result } = await routedLLM(sys, usr, { task: "slide_content", requires_json: true, schema });
          raw = typeof result === "string" ? JSON.parse(result) : result;
        } catch {
          const text = await callLLM(sys, usr, { schema, json: true });
          raw = typeof text === "string" ? JSON.parse(text) : text;
        }
        // Theme slides return { slides: [one] } (BATCH_SLIDE_SCHEMA) — unwrap it.
        if (isTheme) {
          const one = (raw?.slides && raw.slides[0]) || raw || {};
          const suggestion = one.visual_suggestion || "none";
          return {
            ...plan,
            headline:          coerceText(one.headline).trim() || plan.argument,
            bullets:           (one.bullets || []).slice(0, 3).map(normaliseBullet),
            speaker_notes:     one.speaker_notes || "",
            citations:         one.citations || plan.evidence_ids || [],
            visual_suggestion: suggestion,
            visual_spec:       buildVisualSpec(evForSlide, suggestion),
          };
        }
        // Case studies never carry a stat chart — the attack-chain diagram is the visual.
        const suggestion = isCase ? "none" : (raw?.visual_suggestion || "none");
        let caseBullets = (raw?.bullets || []).slice(0, isCase ? 4 : 4).map(normaliseBullet)
          .filter(b => b.text && b.text.length > 5);
        // Fallback: if LLM returned empty bullets for case study, synthesise from evidence facts
        if (isCase && caseBullets.length === 0 && evForSlide.length > 0) {
          caseBullets = evForSlide.slice(0, 4).map((ev, idx) => ({
            text: tightenBulletText(ev.fact || ""),
            bullet_type: idx === evForSlide.length - 1 ? "implication" : "claim",
            evidence_id: ev.evidence_id,
          })).filter(b => b.text.length > 5);
        }
        return {
          ...plan,
          headline:          isCase ? (coerceText(raw?.headline).trim() || plan.argument.slice(0, 80))
                                    : tightenHeadline(coerceText(raw?.headline).trim() || plan.argument),
          ...(isCase ? { named_entity: raw?.named_entity || "" } : {}),
          bullets:           caseBullets.length ? caseBullets : (raw?.bullets || []).slice(0, 4).map(normaliseBullet),
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
    process.stdout.write(`  [L8] ${Math.min(i + SLIDE_CONCURRENCY, internalSlidePlan.length)}/${internalSlidePlan.length} slides generated\r`);
  }
  process.stdout.write("\n");

  // ── Global recommendation strip (deck gives NO recommendations) ──────────────
  // Defensive net: no matter what any prompt produced, drop bullets that are
  // recommendations / imperative "do X" actions. Signal bullets (outlook) are kept.
  const REC_TYPES = new Set(["recommendation", "action"]);
  const IMPERATIVE_RE = /^(implement|deploy|enforce|mandate|require|adopt|apply|establish|use|monitor|audit|rotate|update|prioriti[sz]e|treat|run|scan|add|install|configure|review|shift|layer|restrict|disable|block|segment|isolate|patch|pin|ban|migrate|gate)\b/i;
  let strippedRecs = 0;
  for (const slide of slides) {
    if (slide.type === "early_signals_watchlist") continue;  // outlook = forward signals, keep
    const before = (slide.bullets || []).length;
    slide.bullets = (slide.bullets || []).filter(b =>
      !REC_TYPES.has(b.bullet_type) && !IMPERATIVE_RE.test((b.text || "").trim())
    );
    strippedRecs += before - slide.bullets.length;
  }
  if (strippedRecs) console.log(`  [L8] stripped ${strippedRecs} recommendation bullet(s)`);

  // ── Step 7b: AI diagram generation (Phase 2) ───────────────────────────────
  // Attach Mermaid attack-flow / concept diagrams to eligible narrative slides
  // whose evidence describes a multi-step or multi-actor process.
  // maxDiagrams: 0 disables the pass (caller may render deck without diagrams).
  const maxDiagrams = opts.maxDiagrams ?? 6;
  if (!opts.skipLlm && maxDiagrams > 0) {
    try {
      const d = await attachSlideDiagrams(slides, evidenceIndex, { skipLlm: opts.skipLlm, max: maxDiagrams });
      console.log(`  [diagram] ${d.generated} attached`);
    } catch (err) {
      console.warn(`  [diagram] diagram pass failed: ${err.message}`);
    }
  }

  // ── Step 2b: Per-bullet entailment QA (Lever 2 — anti-hallucination) ───────
  // Verify every claim/data_point bullet against the SINGLE evidence item it cites.
  // This ONLY makes sense for single-incident slides (case studies) where each
  // bullet states one fact from one source. THEME slides deliberately synthesise a
  // PATTERN across multiple sources, so a bullet is never entailed by the one item
  // it happens to cite — running entailment on them flags ~everything, self-disables,
  // and burns Haiku calls for no value. Only check case-study + exec-summary slides.
  let entailmentIssues = [];
  if (!opts.skipLlm) {
    try {
      const entailmentSlides = slides.filter(s =>
        s.type === "case_study" || s.type === "executive_summary"
      );
      const { issues, counts, checked, acted } = await qaBulletEntailment(entailmentSlides, evidenceIndex, {
        concurrency: opts.entailmentConcurrency ?? 4,
        verifyFn: opts.entailmentVerifyFn,
      });
      entailmentIssues = issues;
      const failed = counts.entailment_fail || 0;
      console.log(`  [QA] entailment: ${checked} factual bullets checked, ${failed} unsupported${failed ? (acted ? " (downgraded)" : " (FLAGGED ONLY — fail-rate too high, verifier suspect)") : ""}`);
    } catch (err) {
      console.warn(`  [QA] entailment check failed: ${err.message}`);
    }
  }

  // ── Step 2c: Deterministic content QA (H3) ────────────────────────────────
  // Checks ev_* leaks, prohibited phrases, orphan claim bullets, and numeric
  // stats that don't appear in any evidence. Mutates slides in place for safe
  // fixes (ev_* removal); flags others for human review.
  const { issues: qaIssues, counts: qaCounts } = qaSlides(slides, evidenceIndex);
  if (qaIssues.length > 0) {
    const summary = Object.entries(qaCounts).map(([k, v]) => `${k}:${v}`).join(", ");
    console.warn(`  [QA] ${qaIssues.length} content QA issues (${summary})`);
  }

  // ── Step 2d-pre: Null out hallucinated evidence IDs ─────────────────────────
  // The slide-writing model sometimes generates evidence IDs that look plausible
  // but don't match any item in the index (off-by-one hex char, invented IDs).
  // Strip them now so they don't create phantom citation numbers or mislead QA.
  let nulledIds = 0;
  for (const slide of slides) {
    for (const b of slide.bullets || []) {
      if (b.evidence_id && !(b.evidence_id in evidenceIndex)) {
        b.evidence_id = null;
        nulledIds++;
      }
    }
    // Also clean citations array
    if (slide.citations) {
      slide.citations = slide.citations.filter(c =>
        !String(c).startsWith("ev-") || (c in evidenceIndex)
      );
    }
  }
  if (nulledIds > 0) console.log(`  [QA] nulled ${nulledIds} unresolvable evidence_id(s) on bullets`);

  // ── Step 2d: Build source_pointers on every bullet that carries an evidence_id ─
  // Converts the bare evidence_id string into a structured pointer so the renderer
  // and downstream systems have direct access to source_id and source_url without
  // re-joining. Bullets may cite only evidence from the approved evidenceIndex.
  for (const slide of slides) {
    for (const b of (slide.bullets || [])) {
      if (b.evidence_id && b.evidence_id in evidenceIndex) {
        const ev = evidenceIndex[b.evidence_id];
        b.source_pointers = [{
          evidence_id: b.evidence_id,
          source_id:   ev.source_id   || null,
          source_url:  ev.source_url  || null,
        }];
      }
    }
  }

  // Attach slide_role to all generated slides (carried from plan)
  for (const slide of slides) {
    if (!slide.slide_role) {
      slide.slide_role = SLIDE_TYPE_ROLE[slide.type] ?? null;
    }
  }

  // ── Step 2e: Cross-slide coherence validation ──────────────────────────────
  let coherenceIssues = [];
  let coherenceCounts = {};
  try {
    const { issues: cIssues, counts: cCounts } = validateDeckCoherence(
      slides, evidenceIndex,
      {
        windowStart:  opts.windowStart  || null,
        windowEnd:    opts.windowEnd    || null,
        maxSourceUse: opts.maxSourceUse || 4,
      },
    );
    coherenceIssues = cIssues;
    coherenceCounts = cCounts;
    if (cIssues.length > 0) {
      const summary = Object.entries(cCounts).map(([k, v]) => `${k}:${v}`).join(", ");
      console.warn(`  [QA] coherence: ${cIssues.length} cross-slide issues (${summary})`);
    }
  } catch (err) {
    console.warn(`  [QA] coherence check failed: ${err.message}`);
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
  // Pass 1: assign cite_nums to bullets that carry an explicit evidence_id.
  // Chart/diagram-only sources are NOT added here (those produced orphan references
  // with no [n] anchor on any slide bullet).
  for (const slide of slides) {
    for (const b of (slide.bullets || [])) {
      if (b.evidence_id) {
        const n = citeNumFor(b.evidence_id);
        if (n) b.cite_nums = [n];
      }
    }
  }
  // Pass 2: for mechanism and implication bullets that still have no cite_nums
  // (either the LLM ignored the instruction or it is a deterministic bullet),
  // inherit cite_nums from the nearest preceding evidence bullet on the same slide.
  // Mechanism bullets explain the evidence above them; implication bullets interpret
  // it — both belong to the same source.
  for (const slide of slides) {
    let lastCiteNums = null;
    for (const b of (slide.bullets || [])) {
      if (b.cite_nums) {
        lastCiteNums = b.cite_nums;
      } else if (lastCiteNums && (b.bullet_type === "mechanism" || b.bullet_type === "implication")) {
        b.cite_nums = lastCiteNums;
      }
    }
  }

  // Pass 3: fallback for slides where the LLM produced no per-bullet evidence_ids.
  // Use slide.citations (the evidence pool the LLM was given) to assign cite_nums
  // to all bullets on that slide so the footnote block is never empty.
  for (const slide of slides) {
    if (["cover", "section_intro", "references"].includes(slide.type)) continue;
    const hasAnyCiteNums = (slide.bullets || []).some(b => b.cite_nums?.length);
    if (!hasAnyCiteNums) {
      const citeIds = (slide.citations || [])
        .filter(id => typeof id === "string" && id.startsWith("ev-") && (id in evidenceIndex))
        .slice(0, 4);
      if (citeIds.length) {
        const nums = [...new Set(citeIds.map(citeNumFor).filter(Boolean))];
        if (nums.length) {
          for (const b of (slide.bullets || [])) {
            b.cite_nums = nums;
          }
        }
      }
    }
  }

  // ── Step 3c: Attach per-slide footnote data ────────────────────────────────
  for (const slide of slides) {
    if (["cover", "section_intro", "references"].includes(slide.type)) continue;
    const nums = new Set((slide.bullets || []).flatMap(b => b.cite_nums || []));
    if (nums.size > 0) {
      slide._footnotes = [...nums].sort((a, b) => a - b)
        .map(n => refList.find(r => r.num === n))
        .filter(Boolean);
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

  // ── Deck narrative map ─────────────────────────────────────────────────────
  // A structured narrative map so the presenter and downstream tools can see
  // the deck's analytical arc without reading every slide.
  const assessed = categoryAnalyses.filter(ca => ca.assessment_status === "assessed");
  const deckNarrativeMap = {
    thesis: `AI threat landscape briefing across ${assessed.length} active categories`,
    category_arcs: assessed.map(ca => ({
      category:     ca.category,
      baseline:     (ca.evidence_gaps?.length ? `Gaps: ${ca.evidence_gaps[0]}` : null),
      what_changed: ca.judgments?.find(j => !j.blocked)?.what_changed?.slice(0, 120) || null,
      why_it_matters: ca.judgments?.find(j => !j.blocked)?.why_this_matters?.slice(0, 120) || null,
    })),
    cross_category: crossCategory?.patterns?.length
      ? crossCategory.patterns.map(p => p.title || p.pattern).slice(0, 3)
      : [],
  };

  return {
    slide_plan: externalSlidePlan || internalSlidePlan,
    slides,
    deck_narrative_map: deckNarrativeMap,
    traceability_issues: traceabilityIssues,
    qa_issues: [...qaIssues, ...entailmentIssues],
    coherence_issues: coherenceIssues,
    counts: {
      slides_planned:       internalSlidePlan.length,
      slides_generated:     slides.length,
      slides_with_visual:   withVisual,
      slides_with_diagram:  withDiagram,
      cited_evidence_ids:   citedIds.size,
      unique_sources_cited: refSources.length,
      traceability_issues:  traceabilityIssues.length,
      entailment_failures:  entailmentIssues.filter(i => i.type === "entailment_fail").length,
      coherence_issues:     coherenceIssues.length,
      ...Object.fromEntries(Object.entries(coherenceCounts).map(([k, v]) => [`coherence_${k}`, v])),
    },
    deck_version: DECK_VERSION,
    deck_narrative: deckNarrativeMap.thesis,
  };
}
