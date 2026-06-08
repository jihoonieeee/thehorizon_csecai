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

const CAP_5A = 16;
const CAP_5B = 6;
const CAP_5C = 6;

function monthOf(date) {
  const s = String(date || "");
  const m = s.match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// ── 5A rawfact items (already carry triage_data + permitted_uses + limitations) ──
function compact5A(dossier) {
  const rf = dossier.rawfact || {};
  const seen = new Set();
  const out = [];
  // Order matters: strongest first, then thematic inputs.
  const buckets = [
    rf.strong_evidence, rf.usable_evidence, rf.context_evidence,
    rf.statistics, rf.case_study_candidates, rf.outlook_inputs,
    rf.exposure_inputs, rf.recommendation_inputs,
  ];
  for (const bucket of buckets) {
    for (const it of (bucket || [])) {
      if (!it?.evidence_id || seen.has(it.evidence_id)) continue;
      seen.add(it.evidence_id);
      out.push({
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
      });
      if (out.length >= CAP_5A) return out;
    }
  }
  return out;
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
      needs_manual_review: e.manual_review_required === true || e.needs_manual_review === true,
    };
  }).filter((e) => !e.needs_manual_review);
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
    });
  }
  for (const it of evidence_5B) {
    id_index.set(it.evidence_id, { origin: "5B_analytics", source_type: "analytics", permitted_uses: [], limitations: [], publisher: null, date: null });
  }
  for (const it of evidence_5C) {
    id_index.set(it.evidence_id, { origin: "5C_external", source_type: "external", permitted_uses: ["context_only", "fact_support"], limitations: [], publisher: it.publisher, date: null });
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
