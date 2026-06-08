/**
 * L6 — Deterministic validation of category synthesis output.
 *
 * The LLM (synthesizeCategory) proposes; this module disposes. It:
 *   - resolves every supporting_evidence_ids entry against the dossier id_index,
 *     drops unresolved ids, and RECOMPUTES evidence_origins from the resolved items;
 *   - removes outputs with zero resolved evidence;
 *   - enforces trend rules (relabel trend → recurring_pattern / early_signal);
 *   - enforces source-type permission gates (adoption / operational claims);
 *   - validates the 6-month outlook (observed_basis vs projection; confidence cap);
 *   - sets assessment_status and emits a validation_report + selected_evidence_by_output.
 *
 * No LLM, no scores. Reuses 5A permitted_uses / evidence_strength / source_type.
 */

const OBSERVED_SOURCE_TYPES = new Set(["incident", "threat_intelligence", "adversary_adoption_signal"]);

const ADOPTION_TERMS    = /\b(adopt(ed|ion|ing)?|in the wild|real[- ]world use|used by (attackers|adversaries|threat actors)|deployed by (attackers|adversaries))\b/i;
const OPERATIONAL_TERMS = /\b(actively exploited|exploited in|attackers? (used|exploited|compromised)|breach(ed)?|ransomware campaign|in production attacks|operational(ly)? (use|deployed))\b/i;
const TREND_HYPE        = /\b(surging|surge|exploding|skyrocket|dominant|widespread|accelerating|rampant|epidemic)\b/i;

const CONF_RANK = { high: 2, medium: 1, low: 0 };
const cap = (conf, max) => (CONF_RANK[conf] ?? 0) > (CONF_RANK[max] ?? 0) ? max : (conf || "low");

function monthOf(date) {
  const m = String(date || "").match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// Resolve an output item's evidence ids; recompute origins; apply permission gates.
function resolveAndGate(item, idIndex, report) {
  const ids = Array.isArray(item.supporting_evidence_ids) ? item.supporting_evidence_ids : [];
  const resolvedIds = [];
  const resolved = [];
  for (const id of ids) {
    const meta = idIndex.get(id);
    if (meta) { resolvedIds.push(id); resolved.push(meta); }
    else report.unresolved_ids.push(id);
  }
  if (resolved.length === 0) return null; // caller removes

  const origins = [...new Set(resolved.map((r) => r.origin))];
  let confidence = item.confidence || "low";
  const caveats = [];
  if (item.caveat_if_any) caveats.push(item.caveat_if_any);

  const text = item.text || "";
  const hasObserved = resolved.some((r) => OBSERVED_SOURCE_TYPES.has(r.source_type) || r.origin === "5C_external");
  const r5A = resolved.filter((r) => r.origin === "5A_rawfact");
  const allContext5A = r5A.length > 0 && r5A.every((r) => r.evidence_strength === "context");

  // Gate 1 — adoption claims need observed-use evidence.
  if (ADOPTION_TERMS.test(text) && !hasObserved) {
    confidence = cap(confidence, "low");
    caveats.push("adoption not backed by observed-use evidence (incident / threat-intel / adoption signal)");
    report.permission_downgrades++;
  }
  // Gate 2 — operational claims supported ONLY by context-strength 5A (no 5B/5C, no observed).
  if (OPERATIONAL_TERMS.test(text) && allContext5A && !resolved.some((r) => r.origin !== "5A_rawfact") && !hasObserved) {
    confidence = cap(confidence, "low");
    caveats.push("operational claim supported only by context-level evidence");
    report.permission_downgrades++;
  }
  // Gate 3 — single-origin, single-item → cannot be high confidence.
  if (resolved.length === 1 && confidence === "high") {
    confidence = "medium";
  }

  return {
    ...item,
    supporting_evidence_ids: resolvedIds,
    evidence_origins:        origins,
    confidence,
    caveat_if_any:           caveats.length ? [...new Set(caveats)].join("; ") : null,
  };
}

function cleanList(list, idIndex, report, max) {
  const out = [];
  for (const raw of (list || [])) {
    const gated = resolveAndGate(raw, idIndex, report);
    if (!gated) { report.removed_unsupported++; continue; }
    if (TREND_HYPE.test(gated.text) && gated.confidence !== "high") {
      gated.caveat_if_any = [gated.caveat_if_any, "trend-intensity language not quantitatively supported"].filter(Boolean).join("; ");
    }
    out.push(gated);
    if (out.length >= max) break;
  }
  return out;
}

// Trend rule: a "trend" needs ≥3 resolved items from ≥2 publishers across ≥2 months.
function applyTrendRules(trends, idIndex, report) {
  return (trends || []).map((t) => {
    const resolved = (t.supporting_evidence_ids || []).map((id) => idIndex.get(id)).filter(Boolean);
    const publishers = new Set(resolved.map((r) => r.publisher).filter(Boolean));
    const months     = new Set(resolved.map((r) => monthOf(r.date)).filter(Boolean));
    const claimed = t.pattern_label || "recurring_pattern";
    let label = claimed;
    if (claimed === "trend") {
      const ok = resolved.length >= 3 && publishers.size >= 2 && months.size >= 2;
      if (!ok) {
        label = resolved.length >= 2 ? "recurring_pattern" : "early_signal";
        report.trend_relabels++;
      }
    }
    return { ...t, pattern_label: label };
  });
}

function validateOutlook(outlook, idIndex, report) {
  const o = outlook || {};
  const ids = (o.supporting_evidence_ids || []).filter((id) => idIndex.has(id));
  const origins = [...new Set(ids.map((id) => idIndex.get(id).origin))];
  let confidence = o.confidence || "low";
  const caveats = [];
  if (o.caveat_if_any) caveats.push(o.caveat_if_any);

  if (!o.observed_basis || !String(o.observed_basis).trim()) {
    caveats.push("outlook lacks an explicit observed basis");
    confidence = cap(confidence, "low");
  }
  // High confidence requires ≥2 converging origins.
  if (confidence === "high" && origins.length < 2) confidence = "medium";
  if (ids.length === 0) confidence = "low";

  return {
    observed_basis:          o.observed_basis || "",
    projected_trajectory:    o.projected_trajectory || "",
    reasoning:               o.reasoning || "",
    time_horizon:            "6 months",
    supporting_evidence_ids: ids,
    evidence_origins:        origins,
    confidence,
    caveat_if_any:           caveats.length ? [...new Set(caveats)].join("; ") : null,
  };
}

/**
 * Validate a raw category-synthesis result against its compact dossier.
 *
 * @param {object} raw           Parsed output of synthesizeCategory().
 * @param {object} compactDossier Output of buildCategoryEvidenceDossier() (has id_index).
 * @returns {object} validated contract { ..., assessment_status, validation_report, selected_evidence_by_output }
 */
export function validateCategoryAnalysis(raw, compactDossier) {
  const idIndex = compactDossier.id_index;
  const report = {
    removed_unsupported: 0, permission_downgrades: 0, trend_relabels: 0, unresolved_ids: [],
  };

  const top_insights   = cleanList(raw.top_insights, idIndex, report, 3)
    .map((i) => ({ ...i, output_type: "insight" }));
  const top_happenings = cleanList(raw.top_happenings, idIndex, report, 3)
    .map((i) => ({ ...i, output_type: "happening" }));
  const recommendations = cleanList(raw.recommendations, idIndex, report, 3)
    .map((i) => ({ ...i, output_type: "recommendation" }));
  const early_signals  = cleanList(raw.early_signals, idIndex, report, 3)
    .map((i) => ({ ...i, output_type: "early_signal", why_early: i.why_early || "emerging — not yet repeated" }));
  const trendsGated    = cleanList(raw.top_trends_or_patterns, idIndex, report, 3);
  const top_trends_or_patterns = applyTrendRules(trendsGated, idIndex, report)
    .map((i) => ({ ...i, output_type: i.pattern_label || "recurring_pattern" }));

  const outlook_6_months = validateOutlook(raw.outlook_6_months, idIndex, report);
  const evidence_gaps = Array.isArray(raw.evidence_gaps) ? raw.evidence_gaps.slice(0, 5) : [];

  // assessment_status
  const anyValidated = top_insights.length > 0;
  const anyWeak = top_trends_or_patterns.length + top_happenings.length + early_signals.length > 0;
  const assessment_status = anyValidated ? "assessed" : anyWeak ? "partial" : "evidence_insufficient";

  // selected_evidence_by_output — every surviving output's resolved evidence.
  const selected_evidence_by_output = [];
  const collect = (arr) => arr.forEach((o) => selected_evidence_by_output.push({
    output_id: o.id || null, output_type: o.output_type,
    evidence_ids: o.supporting_evidence_ids, evidence_origins: o.evidence_origins,
  }));
  collect(top_insights); collect(top_trends_or_patterns); collect(top_happenings);
  collect(early_signals); collect(recommendations);
  if (outlook_6_months.supporting_evidence_ids.length) {
    selected_evidence_by_output.push({
      output_id: "outlook", output_type: "outlook",
      evidence_ids: outlook_6_months.supporting_evidence_ids, evidence_origins: outlook_6_months.evidence_origins,
    });
  }

  return {
    category: compactDossier.category,
    assessment_status,
    top_insights,
    top_trends_or_patterns,
    top_happenings,
    early_signals,
    outlook_6_months,
    recommendations,
    evidence_gaps,
    selected_evidence_by_output,
    validation_report: report,
  };
}
