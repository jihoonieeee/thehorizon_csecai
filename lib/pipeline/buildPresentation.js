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

import { routedLLM } from "../llm/llmRouter.js";
import { callLLM }   from "../llm/callLLM.js";
import { attachSlideDiagrams } from "./generateDiagrams.js";
import { qaSlides }  from "./qaSlides.js";
import { qaBulletEntailment } from "./qaBulletEntailment.js";

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

  // Compress to a scannable line: "Category — <signal>". The escalation trigger
  // (the "act when…" part) is the spoken detail → speaker notes, not the slide.
  const tighten = (t, n = 16) => {
    const words = String(t || "").replace(/\s+/g, " ").trim().split(" ");
    return words.length > n ? words.slice(0, n).join(" ") + "…" : words.join(" ");
  };
  return {
    type:          "early_signals_watchlist",
    slide_number:  slideNumber,
    headline:      "Early Signals — What to Monitor Now",
    argument:      "Specific measurable signals that indicate escalation toward operational threat",
    bullets: signals.map(s => ({
      text:        `${s.category} — ${tighten(s.signal)}`,
      bullet_type: "context",
    })),
    speaker_notes: "Escalation triggers: " + signals.map(s =>
      `${s.category} — act when ${String(s.escalation_trigger || "first corroborating report").replace(/\s+/g, " ").trim()} (watch: ${s.monitoring_source_type || "threat intel"})`
    ).join("; ") + ".",
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

  // Trim each forecast to its core (first sentence, ≤22 words). The basis and the
  // invalidation signal are the spoken detail → speaker notes.
  const coreForecast = (t) => {
    const first = String(t || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)[0] || "";
    const words = first.split(" ");
    return words.length > 22 ? words.slice(0, 22).join(" ") + "…" : first;
  };
  return {
    type:          "outlook_structured",
    slide_number:  slideNumber,
    headline:      "6-Month Outlook — Based on Observed Signals",
    argument:      "Forward-looking assessment with escalation triggers and confidence levels",
    bullets: outlooks.map(o => ({
      text:        `${o.cat} — ${coreForecast(o.likely_next_movement)}  (${o.confidence})`,
      bullet_type: "implication",
      outlook_detail: {
        observed_basis:        o.observed_basis,
        what_would_invalidate: o.what_would_invalidate,
      },
    })),
    speaker_notes: outlooks.map(o =>
      `${o.cat}: rests on ${o.observed_basis || "current evidence"}; wrong if ${o.what_would_invalidate || "n/a"}.`
    ).join(" "),
    citations:     [],
    visual_spec:   null,
    visual_suggestion: "none",
    deterministic: true,
  };
}

// Deterministic cross-category slide — built from synthesis convergence patterns.
// Clearly labelled so the audience knows it is the ecosystem-level analysis.
function buildCrossCategorySlide(crossCategory, slideNumber, evidenceByCategory = {}) {
  const patterns = (crossCategory?.patterns || []).slice(0, 2);
  if (!patterns.length) return null;
  // Ground each cross-category claim in representative evidence so it is TRACEABLE
  // (otherwise qaSlides flags it claim_bullet_orphan — the ecosystem claim sits on
  // nothing). The pattern's `supporting_judgments` are human-readable LABELS, not
  // resolvable IDs, so we instead cite the approved-judgment evidence of the
  // categories the pattern spans (categories_involved) — the right grounding for an
  // ecosystem-level convergence claim.
  // categories_involved may be canonical keys OR display labels ("Traditional AI
  // Threats"); normalise both to the canonical key before looking up evidence.
  const LABEL_TO_KEY = Object.fromEntries(
    Object.entries(CATEGORY_LABELS).map(([k, v]) => [v.toLowerCase(), k])
  );
  const toKey = (c) => (evidenceByCategory[c] ? c : (LABEL_TO_KEY[String(c).toLowerCase()] || c));
  const evidenceForPattern = (p) => [...new Set(
    (p.categories_involved || p.categories || []).flatMap(c => evidenceByCategory[toKey(c)] || [])
  )].slice(0, 4);
  // Strip category-local "[n]" markers AND analyst-meta preambles that make the
  // slide read as abstract jargon ("Three independent judgments across three
  // categories each demonstrate that…", "The corpus reveals…"). The reader wants
  // the THING, not a description of how we counted it.
  const META_PREAMBLE = /^(?:[A-Za-z]+\s+)?(?:independent\s+)?judgments?\s+across\s+[\w\s-]+?(?:categories|domains)\s+(?:each\s+)?(?:demonstrate|show|confirm|reveal|indicate)s?\s+that\s+/i;
  const clean = (t) => String(t || "")
    .replace(/\s*\[\d+\]/g, "")
    .replace(/^(the corpus reveals?|the evidence shows?|analysis (?:shows?|reveals?)|we (?:observe|find|assess) that)\s+/i, "")
    .replace(META_PREAMBLE, "")
    .replace(/\s+([,.;)])/g, "$1")
    .replace(/\s{2,}/g, " ").trim();
  const firstSentence = (t) => { const c = clean(t); return c.split(/(?<=[.!?])\s+/)[0] || c; };
  const cap = (t, n) => { const w = clean(t).split(" "); return w.length > n ? w.slice(0, n).join(" ") + "…" : w.join(" "); };
  const sentenceCase = (t) => t ? t.charAt(0).toUpperCase() + t.slice(1) : t;

  // Explain ONE primary pattern clearly: what the shared thread is → why combining
  // it across categories is worse → the single action. (Cramming two patterns made
  // it unreadable.) A second pattern, if any, gets ONE summary line.
  const primary = patterns[0];
  const cats = (primary.categories_involved || primary.categories || [])
    .map(c => CATEGORY_LABELS[c] || c).join(", ");
  const what = sentenceCase(firstSentence(primary.convergence_description || primary.description || ""));
  const why  = sentenceCase(firstSentence(primary.compounding_risk || primary.compounding_effect || ""));
  const act  = sentenceCase(firstSentence(primary.actionable_recommendation || primary.implication || ""));
  const evIds = evidenceForPattern(primary);

  const bullets = [];
  if (cats) bullets.push({ text: `The same weakness shows up across ${cats}.`, bullet_type: "context" });
  if (what) bullets.push({ text: cap(what, 26), bullet_type: "claim", ...(evIds[0] ? { evidence_id: evIds[0] } : {}) });
  if (why)  bullets.push({ text: cap(why, 24),  bullet_type: "implication" });
  if (act)  bullets.push({ text: cap(act, 20),  bullet_type: "recommendation" });
  // Optional one-line second pattern.
  if (patterns[1]) {
    const p2 = patterns[1];
    const t2 = cap(p2.title || p2.convergence_description || "", 18);
    if (t2) bullets.push({ text: `Also watch: ${sentenceCase(t2)}`, bullet_type: "context" });
  }

  // Plain headline — strip the jargon title down to a readable framing.
  const headline = "Cross-Category: One Weakness, Multiple Fronts";
  return {
    type:          "cross_category",
    slide_number:  slideNumber,
    headline,
    argument:      "The same weakness appears in several categories — so one fix (or one attacker capability) spans them",
    bullets:       bullets.slice(0, 5),
    speaker_notes: clean(crossCategory.ecosystem_assessment) || "Ecosystem-level read: the same capability recurs across categories, so defenders should treat it as one problem, not several.",
    citations:     [...new Set(evIds)],
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

// NOTE: the per-category LLM slide PLANNER (CATEGORY_SLIDE_SCHEMA /
// buildCategoryPlanSystem / buildCategoryPlanUser) was removed 2026-06-25. The
// section structure is now fixed deterministically in deterministicCategoryPlan()
// (up to 3 key-development slides + 1 strategic-insight slide + optional case
// study); the LLM only writes each slide's content in L8. This removed a source
// of inconsistent slide counts and repeated developments/insights.

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

// Numbers that are administrative noise, not insight. CVE descriptions are full of
// software version strings ("fixed in 2.9.0", "prior to 0.6.52") that the number
// extractor captures verbatim — these must NEVER become a "Key Figure". A figure
// earns the slide only if it conveys SCALE or IMPACT (a count, %, $, ×, or a
// duration), not a release identifier.
const VERSION_VALUE_RE  = /^v?\d+(\.\d+){1,}[a-z0-9.\-]*$|^\d+\.x$|^\d+(\.\d+)*$/i; // 2.9.0, 1.x, 4.x, 1.11.1
const ADMIN_CONTEXT_RE  = /\b(version|fixed|patched|affected|prior to|release|build|commit|cve-?\d|advisory|semver|tag|branch|rc\d|beta|alpha)\b/i;
function isMeaningfulFigure(n) {
  const val = String(n.value || "").trim();
  const ctx = String(n.context || "");
  // Drop version-looking values (2.9.0, 1.x) and version/CVE-admin contexts FIRST —
  // before the unit shortcut, because detectNumUnit misreads the ".x" in "4.x" as a
  // "×" multiplier and would otherwise wave a version through.
  if (VERSION_VALUE_RE.test(val) && /\.\d|\.x/i.test(val)) return false; // multi-part → a version, not a count
  if (ADMIN_CONTEXT_RE.test(ctx)) return false;
  // Keep anything with a real unit (%, $, ×, time) — those are inherently scale/impact.
  if (n.unit) return true;
  // A bare integer with an impact-flavoured context (agents, victims, downloads,
  // techniques, packages, models, accounts, countries…) is a real figure.
  if (/\b(agent|victim|download|technique|package|plugin|model|account|countr|organi|user|device|sample|incident|attack|campaign|skill|repositor|dataset|server|host|record|credential|company|companies)\w*\b/i.test(ctx)) return true;
  // Otherwise: keep only if it's a sizable count (≥ 10) — small bare integers are
  // usually structural trivia ("2 finally blocks", "three parsers").
  return (n.parsed ?? 0) >= 10;
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
  return `You are writing ONE case-study slide for a cybersecurity threat briefing. The
audience is SENIOR EXECUTIVES who are NOT technical — explain it like a smart board
member, not an engineer. They care about: what happened, who was hit, how bad, and
what we do about it. They do NOT want protocol/library internals.

A case study tells a single concrete attack story anchored on a NAMED entity.
  named_entity : the specific CVE, product, victim org, malware family, or threat actor this case is about. If the evidence has no named entity, you should not be writing a case study.
  headline     : ≤12 words, plain English, naming what happened to whom (the conclusion). e.g. "Booby-trapped AI plugin reached 26,000 company accounts".

PLAIN-LANGUAGE RULES (critical for this audience):
  - Translate every technical term. "ASGI middleware trusted upstream headers" → "the system trusted a forged ID and let attackers in without a password". "Dependency confusion" → "attackers slipped a fake software package into the supply chain". "IDOR" → "users could reach data that wasn't theirs".
  - NO acronyms unless universally known; if you must use one, gloss it in plain words.
  - Lead with impact and stakes, not mechanism. A non-technical reader should grasp WHY THEY SHOULD CARE from each bullet.

bullets (3-5), each exactly one type — the story then its meaning:
  - "claim" / "data_point" = Evidence: one concrete, PLAIN-LANGUAGE step or fact (what the attacker did, how bad, the scale). MUST cite an evidence_id.
  - "implication"  = what this means for the business (which protection failed, what's now exposed) — in business terms.
  - "recommendation" = the specific action to take.

ONE BULLET = ONE SOURCE (critical): each Evidence bullet states a fact from EXACTLY ONE
evidence item and cites THAT item. The actor, victim, CVE, number, and action in a bullet
must ALL come from the SAME item. NEVER stitch an actor from one item to a number or
victim from another — a case study often draws on a multi-incident source, and fusing two
incidents (e.g. crediting one actor with another's attack) is a fabrication. If two facts
live in two items, write two bullets. Do not let the named_entity bleed onto facts that
belong to a different incident.
Rules: ≤20 words/bullet, plain English, no jargon, no source names/IDs in text (citations are added automatically). Evidence bullets MUST set evidence_id from the list.

The attack chain is drawn as a simple diagram automatically — your bullets give the stakes + takeaway, not a redundant technical step list.

speaker_notes: 2-3 sentences the presenter can say to add nuance (confidence, what to watch). No restating bullets.

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

This slide is your ANALYSIS — not a list of facts. It is the STRATEGIC READ of where
this category is heading across the whole corpus timeframe: synthesise across ALL the
category's judgments into a trajectory, do NOT just recap the individual developments
(those have their own slides). Produce EXACTLY 3 insights.

A briefing slide is SCANNED in seconds, then the presenter SPEAKS the detail. So:
  • the insight TEXT is one tight sentence the audience reads at a glance;
  • the supporting evidence + fuller reasoning go in speaker_notes (what you SAY).

Each insight TEXT is ONE sentence, ≤ 22 words, that:
  • leads with the strategic claim (the "so what"), not the raw observation;
  • names the single most important fact woven in (one number/entity), no more;
  • makes clear which defender assumption breaks or what new exposure opens.
Do NOT cram evidence, implication, AND recommendation into the on-slide text — that
is what makes slides unreadable. Keep the line short; put the rest in the notes.

BAD (too long, 40+ words):  "The assumption that model hubs are safe is now broken: a single trojanized model reached 200k downloads before removal, meaning intake-time scanning no longer protects you and model artifacts must be treated as executable code under runtime control."
GOOD (≤22 words, on-slide):  "Model hubs are now a primary credential-theft vector — one trojanized model hit 200k downloads before removal."
GOOD (matching speaker_notes): "Intake-time scanning no longer protects you; treat model artifacts as executable code under runtime control. Evidence: 200k downloads before the hub removed it."

Rules:
  • 3 insights, each ≤ 22 words, plain English, distinct from one another.
  • Set evidence_id on each insight to the exact ID that grounds it (from the list).
  • No source names, dates, or [n] markers in the insight text — citations are added automatically.
  • speaker_notes: REQUIRED. For each of the 3 insights, write 1-2 sentences of elaboration
    (the evidence detail and the defender implication) — this is the spoken track.
  • headline: one declarative sentence (≤10 words) capturing the category's single most important shift.

Return ONLY valid JSON.`;
}

function buildInsightsUser(plan, evidenceForSlide, judgments = []) {
  const evLines = evidenceForSlide.map(ev => `[${ev.evidence_id}] ${ev.fact}`).join("\n");
  const jList = (Array.isArray(judgments) ? judgments : [judgments]).filter(Boolean);
  const jLines = jList.length
    ? "ALL JUDGMENTS FOR THIS CATEGORY (synthesise across them — this is the trajectory, not a recap of one):\n" +
      jList.map((j, i) => `  ${i + 1}. ${j.judgment}\n     mechanism: ${j.causal_mechanism || ""}\n     matters: ${j.why_this_matters || ""}`).join("\n")
    : "";
  return `Category: ${plan.argument}

${jLines}

EVIDENCE (ground each insight in one of these; cite the exact ID):
${evLines || "(thin evidence — write fewer, clearly-hedged insights)"}

Write EXACTLY 3 strategic insights that, together, describe WHERE THIS CATEGORY IS
HEADING across the whole corpus timeframe — the trajectory and what it means for
defenders — not a restatement of the individual developments. Plus a headline.`;
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

════ ONE BULLET = ONE SOURCE (critical — prevents false composites) ════
Each Evidence bullet (claim/data_point) states a fact from EXACTLY ONE evidence item
and cites THAT item's ID. You may ONLY write what that single item says.
  - NEVER merge details from two different evidence items into one bullet. If item A
    says "actor INC Ransom stole 1.5TB" and item B says "Akira exploited a VPN CVE",
    you may NOT write "Akira stole 1.5TB" — that fuses two incidents into a falsehood.
  - The named actor, the victim, the CVE, the number, and the action in a bullet must
    ALL come from the SAME cited item. If they live in different items, write two bullets.
  - If a point needs two sources to be true, it is not a single Evidence bullet — split it.

════ CLAIM CALIBRATION (do not overstate) ════
Match the claim strength to the evidence's own wording. Do NOT escalate:
  - "reached / reportedly / was distributed to N" is REACH, not "compromised N".
  - "could / may / demonstrated in a lab" is POTENTIAL, not "is being exploited".
  - "linked / associated with an actor" is not "carried out by" that actor.
  - one report of a thing is "a reported case", not "widespread" or "now standard".
If the evidence says "reached 26,000 agents", write "reached 26,000 agents" — never "compromised". When unsure of strength, use the weaker verb.

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

// Deterministic, judgment-driven section plan. Always evidence-backed so an
// assessed category never renders as an empty "thin corpus" section even when
// the LLM planner (or a fallback model) returns a weak plan.
// Per-category section: up to 3 KEY-DEVELOPMENT slides (one focused development
// each) + ONE strategic-insight slide (whole-category trajectory across all
// judgments) + an optional digestible case study. Developments scale with
// evidence — a thin category gets fewer; we never pad to 3 with filler.
function deterministicCategoryPlan(ca, pack) {
  const approved = (ca.judgments || []).filter(j => !j.blocked);
  if (!approved.length) return [];
  const label = CATEGORY_LABELS[ca.category] || ca.category;
  // One dev slide per distinct approved judgment, capped at 3. Each carries its
  // OWN judgment + that judgment's evidence so the three slides don't repeat.
  const devJudgments = approved.slice(0, 3);
  const plan = devJudgments.map((j, i) => ({
    type:         "top_happenings",
    argument:     `Key development — ${label}`,
    evidence_ids: (j.evidence_for || []).slice(0, 5),
    judgment_id:  j.judgment_id,
    dev_index:    i + 1,
    dev_total:    devJudgments.length,
  }));
  // Strategic insight — synthesises ACROSS all judgments + the category outlook,
  // i.e. where this category is heading over the corpus timeframe (not a recap of
  // one development).
  plan.push({
    type:             "category_insights",
    argument:         `Strategic read — ${label}`,
    evidence_ids:     approvedJudgmentEvidenceIds(ca, 6),
    judgment_id:      approved[0].judgment_id,
    all_judgment_ids: approved.map(j => j.judgment_id),
  });
  const caseSlide = caseStudyPlanFor(ca, pack);
  if (caseSlide) plan.push(caseSlide);
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

  // ── Step 2: Per-category section plan (deterministic skeleton) ───────────────
  // The structure is fixed in code — up to 3 Key-Development slides + 1 Strategic
  // Insight + optional Case Study (see deterministicCategoryPlan). The LLM is used
  // only to WRITE each slide's content in L8, not to decide the structure (the old
  // LLM planner produced inconsistent counts and repeated developments/insights).
  const categorySections = {};  // category → [{type, argument, evidence_ids, judgment_id}]
  for (const ca of categoryAnalyses) {
    categorySections[ca.category] = deterministicCategoryPlan(ca, evidenceByCategory[ca.category]);
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
  // Map each category → its approved-judgment evidence IDs, so cross-category
  // claims can be grounded in the evidence of the categories they span.
  const evidenceIdsByCategory = Object.fromEntries(
    categoryAnalyses.map(ca => [ca.category, approvedJudgmentEvidenceIds(ca, 8)])
  );
  const crossSlide = buildCrossCategorySlide(crossCategory, 0, evidenceIdsByCategory);
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
      // Insight slides synthesise across ALL the category's judgments (trajectory),
      // not just one — so pass the full set when the plan carries them.
      const insightJudgments = (plan.all_judgment_ids || [])
        .map(id => judgmentIndex[id]).filter(Boolean);
      try {
        const sys    = isCase ? buildCaseStudySystem() : isInsight ? buildInsightsSystem() : buildSlideSystem();
        const usr    = isCase ? buildCaseStudyUser(plan, evForSlide, judgment)
                     : isInsight ? buildInsightsUser(plan, evForSlide, insightJudgments.length ? insightJudgments : (judgment ? [judgment] : []))
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

  // ── Step 2b: Per-bullet entailment QA (Lever 2 — anti-hallucination) ───────
  // Verify every claim/data_point bullet against the SINGLE evidence item it cites
  // (a second model checks entailment, not token overlap). Catches conflation
  // (actor from one item + number from another), over-claim, and maturity inflation
  // that token-level grounding misses. Non-entailed bullets are downgraded to
  // context with their citation stripped, so a fabricated composite can never read
  // as evidence-backed. Skipped in skipLlm/dry-run mode.
  let entailmentIssues = [];
  if (!opts.skipLlm) {
    try {
      const { issues, counts, checked, acted } = await qaBulletEntailment(slides, evidenceIndex, {
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
    qa_issues: [...qaIssues, ...entailmentIssues],
    counts: {
      slides_planned:      slidePlan.length,
      slides_generated:    slides.length,
      slides_with_visual:  withVisual,
      slides_with_diagram: withDiagram,
      cited_evidence_ids:  citedIds.size,
      unique_sources_cited: refSources.length,
      traceability_issues: traceabilityIssues.length,
      entailment_failures: entailmentIssues.filter(i => i.type === "entailment_fail").length,
    },
    deck_version: DECK_VERSION,
    deck_narrative: `${slides.length} slides covering ${categoryAnalyses.filter(ca => ca.assessment_status === "assessed").length} threat categories`,
  };
}
