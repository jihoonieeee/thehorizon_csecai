/**
 * L6 — Compact Category Evidence Dossier (LLM-facing)
 *
 * Flattens a fused dossier (which already merges 5A rawfacts, 5B analytics, and
 * 5C external evidence per category) into a COMPACT, uniformly-shaped evidence set
 * that the category-synthesis LLM reasons over — plus an `id_index` the
 * deterministic validator uses to resolve every cited evidence_id back to its
 * origin, source_type, strength, and permitted_uses.
 *
 * Deterministic — no LLM. Output:
 * {
 *   category, source_count,
 *   evidence_5A[], evidence_5B[], evidence_5C[],   // compact, capped
 *   trend_support{ distinct_publishers, distinct_months, item_count },
 *   evidence_gaps[], confidence_assessment,
 *   allowed_ids: Set<string>,
 *   id_index: Map<string, { origin, source_type, evidence_strength, permitted_uses[], limitations[], publisher, date }>
 * }
 */

import { classifyAttackVector } from "../../config/attackVectors.js";

// Coverage-aware cap. Scales with category richness (more distinct attack vectors →
// more slots) so the synthesis dossier is not a flat 16-item / ~6%-of-corpus window
// regardless of how much the category actually holds. Bounded by MAX_5A to control
// prompt size.
const BASE_5A = 16;
const MAX_5A  = 28;
const CAP_5B = 6;
const CAP_5C = 6;

const STRENGTH_RANK = { strong: 3, usable: 2, context: 1, archive: 0 };
// Significance tie-break: at equal reliability, prefer evidence that MATTERS more —
// a novel/escalating signal over a routine confirming/redundant fact.
const MATERIALITY_RANK = { novel: 3, escalating: 2, confirming: 1, redundant: 0 };
const OPERATIONAL_SOURCE_TYPES = new Set([
  "incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure",
]);

function monthOf(date) {
  const s = String(date || "");
  const m = s.match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function strengthOfItem(it) {
  return STRENGTH_RANK[it.triage_data?.evidence_strength || "archive"] ?? 0;
}
function materialityOfItem(it) {
  return MATERIALITY_RANK[it.triage_data?.materiality || "confirming"] ?? 1;
}
// Sort comparator: reliability first, then significance (materiality).
function compareItems(a, b) {
  return strengthOfItem(b) - strengthOfItem(a) || materialityOfItem(b) - materialityOfItem(a);
}

// The TOPIC bucket an item covers — attack vector if detectable, else evidence_type.
// Used to round-robin so one hot vector cannot monopolise the dossier.
function coverageKey(it) {
  return classifyAttackVector(it.fact || it.source_quote || "") || it.evidence_type || "other";
}

function projectItem(it) {
  return {
    evidence_id:       it.evidence_id,
    origin:            "5A_rawfact",
    evidence_type:     it.evidence_type,
    source_type:       it.source_type || it._source_type || "unknown",
    evidence_strength: it.triage_data?.evidence_strength || "archive",
    permitted_uses:    it.triage_data?.permitted_uses || [],
    limitations:       it.triage_data?.limitations || [],
    fact:              it.fact || "",
    source_quote:      it.source_quote || it.supporting_text || "",
    entities:          it.entities || [],
    numbers:           it.numbers || [],
    publisher:         it.publisher || "",
    date:              it.date || it.published_date || null,
    primary_origin_url: it.primary_origin_url || null,
    independence_level: it.independence_level || null,
    coverage_vector:   coverageKey(it),
    materiality:       it.triage_data?.materiality || null,
    uniqueness:        it.triage_data?.uniqueness || null,
  };
}

// ── 5A rawfact items (coverage-aware selection) ───────────────────────────────
//
// Previously this took the first 16 items by fixed bucket order + ordinal strength,
// so one dominant attack vector could fill every slot and rare-but-important signals
// below the strength cutoff never reached the synthesis LLM. The new selection:
//   1. dedupe across all rawfact buckets,
//   2. PHASE 1 (coverage): round-robin the strongest unused item from each distinct
//      attack-vector group, so every attested vector is represented before any vector
//      is deepened — and guarantee ≥1 operational item if the category has one,
//   3. PHASE 2 (strength fill): fill remaining slots by strength.
// The cap scales with the number of distinct vectors (BASE_5A..MAX_5A).
function compact5A(dossier) {
  const rf = dossier.rawfact || {};
  const seen = new Set();
  const items = [];
  const buckets = [
    rf.strong_evidence, rf.usable_evidence, rf.context_evidence,
    rf.statistics, rf.case_study_candidates, rf.outlook_inputs,
    rf.exposure_inputs, rf.recommendation_inputs,
  ];
  for (const bucket of buckets) {
    for (const it of (bucket || [])) {
      if (!it?.evidence_id || seen.has(it.evidence_id)) continue;
      seen.add(it.evidence_id);
      items.push(it);
    }
  }
  if (items.length === 0) return [];

  // Group by coverage vector, each group sorted strongest-first.
  const groups = new Map();
  for (const it of items) {
    const key = coverageKey(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const arr of groups.values()) arr.sort(compareItems);

  // Cap scales with distinct-vector richness.
  const cap = Math.min(MAX_5A, Math.max(BASE_5A, groups.size + BASE_5A - 2));

  const selected = [];
  const picked = new Set();

  // Guarantee ≥1 operational item (the category's real-world anchor) if one exists.
  const strongestOperational = items
    .filter((it) => OPERATIONAL_SOURCE_TYPES.has(it.source_type || it._source_type))
    .sort(compareItems)[0];
  if (strongestOperational) {
    selected.push(strongestOperational);
    picked.add(strongestOperational.evidence_id);
  }

  // PHASE 1 — coverage: round-robin the strongest unused item from each vector group,
  // strongest groups first (a group's strength = its best item).
  const orderedGroups = [...groups.entries()]
    .sort((a, b) => strengthOfItem(b[1][0]) - strengthOfItem(a[1][0]))
    .map(([, arr]) => arr);
  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (const arr of orderedGroups) {
      if (selected.length >= cap) break;
      const next = arr.find((it) => !picked.has(it.evidence_id));
      if (next) {
        selected.push(next);
        picked.add(next.evidence_id);
        progressed = true;
      }
    }
  }

  // PHASE 2 — strength fill (redundant after round-robin exhausts groups, but keeps
  // selection deterministic if a group ran out mid-pass).
  if (selected.length < cap) {
    const rest = items
      .filter((it) => !picked.has(it.evidence_id))
      .sort(compareItems);
    for (const it of rest) {
      if (selected.length >= cap) break;
      selected.push(it);
      picked.add(it.evidence_id);
    }
  }

  return selected.map(projectItem);
}

// ── 5B analytics evidence (two possible shapes; normalise) ────────────────────
function compact5B(dossier) {
  const ae = dossier.analytics?.analytics_evidence || [];
  return ae.slice(0, CAP_5B).map((a, i) => ({
    evidence_id:  a.analytics_evidence_id || a.analytics_id || `agg_${dossier.category}_${i}`,
    origin:       "5B_analytics",
    metric:       a.metric_name || a.metric_type || "frequency_distribution",
    finding:      a.finding || a.metric_name || "",
    value_summary: summariseValue(a.value || a.data),
    source_count: (a.source_ids || []).length,
    confidence:   a.confidence || "medium",
    caveat:       a.caveat_if_any || null,
  }));
}

function summariseValue(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value).slice(0, 120);
  // Top 4 entries of a frequency map.
  const entries = Object.entries(value)
    .filter(([, v]) => typeof v === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`);
  return entries.join(", ").slice(0, 160);
}

// ── 5C external/web evidence (defensive against the rich 5C shape) ────────────
function compact5C(dossier) {
  const items = dossier.web_evidence?.evidence_items || dossier.rawfact?.external_evidence || [];
  return items.slice(0, CAP_5C).map((e, i) => {
    const stat = (e.statistics || [])[0] || null;
    const quote = (e.source_grounding?.verbatim_quotes || []).find((q) => String(q || "").trim().length >= 12)
      || e.exact_quote || "";
    return {
      evidence_id:  e.web_evidence_id || e.evidence_id || `webev_${dossier.category}_${i}`,
      origin:       "5C_external",
      title:        e.source_grounding?.title || e.title || (e.concrete_claim || "").slice(0, 80),
      publisher:    e.source_grounding?.publisher || e.publisher || "",
      url:          e.source_lineage?.original_source_url || e.source_grounding?.source_url || e.url || "",
      claim:        e.concrete_claim || e.summary || "",
      quote,
      metric_name:  stat?.metric || e.metric_name || null,
      metric_value: stat?.value  || e.metric_value || null,
      confidence:   e.evidence_confidence || (e.confidence === "low" ? "low" : "medium"),
      // Quality signals used to bound what this external item may support.
      validation_status: e.validation_status || null,
      observed_use: e.observed_use === true,
      needs_manual_review: e.manual_review_required === true || e.needs_manual_review === true,
    };
  }).filter((e) => !e.needs_manual_review && e.validation_status !== "rejected");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildCategoryEvidenceDossier(dossier) {
  const evidence_5A = compact5A(dossier);
  const evidence_5B = compact5B(dossier);
  const evidence_5C = compact5C(dossier);

  const id_index = new Map();
  for (const it of evidence_5A) {
    id_index.set(it.evidence_id, {
      origin: "5A_rawfact", source_type: it.source_type,
      evidence_strength: it.evidence_strength, permitted_uses: it.permitted_uses,
      limitations: it.limitations, publisher: it.publisher, date: it.date,
      primary_origin_url: it.primary_origin_url || null,
      independence_level: it.independence_level || null,
      materiality: it.materiality || null,
      uniqueness: it.uniqueness || null,
    });
  }
  for (const it of evidence_5B) {
    id_index.set(it.evidence_id, { origin: "5B_analytics", source_type: "analytics", permitted_uses: [], limitations: [], publisher: null, date: null });
  }
  for (const it of evidence_5C) {
    // External web evidence defaults to context_only. It may anchor a factual
    // claim (fact_support) ONLY when it is validated AND carries a grounding
    // quote — otherwise a weak / unverified web result could support claims it
    // has no business supporting. Default-deny: unknown validation → context_only.
    const grounded = String(it.quote || "").trim().length >= 20;
    const validated = it.validation_status === "validated";
    const canFactSupport = grounded && validated;
    id_index.set(it.evidence_id, {
      origin: "5C_external",
      source_type: "external",
      permitted_uses: canFactSupport ? ["context_only", "fact_support"] : ["context_only"],
      limitations: canFactSupport ? [] : ["external_unverified"],
      observed_use: it.observed_use === true,
      publisher: it.publisher,
      date: null,
    });
  }

  // Trend-eligibility signals over 5A (the only origin with per-item dates/publishers).
  const dated = evidence_5A.filter((e) => e.date);
  const trend_support = {
    item_count:         evidence_5A.length,
    distinct_publishers: new Set(evidence_5A.map((e) => e.publisher).filter(Boolean)).size,
    distinct_months:    new Set(dated.map((e) => monthOf(e.date)).filter(Boolean)).size,
  };

  return {
    category:     dossier.category,
    source_count: dossier.source_count || 0,
    evidence_5A,
    evidence_5B,
    evidence_5C,
    trend_support,
    evidence_gaps:         dossier.fusion_summary?.evidence_gaps || [],
    confidence_assessment: dossier.fusion_summary?.confidence_assessment || "low",
    allowed_ids: new Set(id_index.keys()),
    id_index,
  };
}
