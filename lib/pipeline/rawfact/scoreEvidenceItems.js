/**
 * Layer 5a.5 — Evidence Importance Scoring
 *
 * Scores individual evidence items using a multi-dimensional rubric. Deterministic.
 * Called twice: before clustering (no duplicate penalty) and after (with penalty).
 *
 * Score = source_authority(0–15) + evidence_strength(0–20) + operational_relevance(0–20)
 *       + horizon_significance(0–20) + actionability(0–10) + corroboration(0–10)
 *       + recency(0–5) − penalties(0–20)
 *
 * Priority bands: critical ≥ 85 | high 70–84 | medium 50–69 | low 30–49 | archive_only < 30
 * Critical requires BOTH score ≥ 85 AND additional gate conditions.
 */

// ── Scoring helpers ───────────────────────────────────────────────────────────

function enumScore(val, map, fallback = 0) {
  return map[val] ?? fallback;
}

// ── Component scorers ─────────────────────────────────────────────────────────

function scoreSourceAuthority(source) {
  const AUTHORITY = {
    primary: 15, curated: 12, high: 10, medium: 7, low: 3, unknown: 1,
  };
  return AUTHORITY[source.trust_tier] ?? 1;
}

function scoreEvidenceStrength(item, source) {
  // Strength is based on evidence_type and the specificity of the fact
  const fact = item.fact || "";
  const hasNumbers = (item.numbers || []).length > 0 ||
    /\d+%|\$[\d,.]+|\d+[kKmMbB]|\d+\s*(million|billion|thousand)/i.test(fact);
  const hasEntities = (item.entities || []).length > 0;
  const hasAttackFlow = item.evidence_type === "exploit_chain" || item.evidence_type === "attack_method";
  const confidence = item.evidence_confidence || "medium";

  // Base from evidence_type
  const TYPE_BASE = {
    incident_event:       18,
    vulnerability_fact:   17,
    exploit_chain:        18,
    attack_method:        15,
    threat_actor_activity:16,
    adversary_adoption:   15,
    research_result:      13,
    capability_delta:     14,
    benchmark_result:     12,
    societal_harm:        13,
    governance_action:    10,
    defensive_control:    10,
    ecosystem_shift:      9,
    infrastructure_dependency: 9,
    trust_boundary_shift: 11,
    strategic_signal:     8,
    statistic:            14,
    mitigation:           10,
    timeline_event:       10,
  };
  let base = TYPE_BASE[item.evidence_type] ?? 8;

  // Modifiers
  if (confidence === "high")   base = Math.min(20, base + 2);
  if (confidence === "low")    base = Math.max(0,  base - 6);
  if (hasNumbers)              base = Math.min(20, base + 2);
  if (hasEntities)             base = Math.min(20, base + 1);
  if (fact.length < 30)        base = Math.max(0,  base - 4); // too short = too vague
  if (hasAttackFlow && (item.entities || []).length >= 2) base = Math.min(20, base + 1);

  // Grounding bonus — a verbatim-verified quote is the strongest evidence signal.
  if (item.quote_verified === true)  base = Math.min(20, base + 2);
  // Atomic claims are cleaner evidence than compound/summary facts.
  if (item.is_atomic === true)       base = Math.min(20, base + 1);

  return Math.max(0, Math.min(20, base));
}

function scoreOperationalRelevance(item, source, rt) {
  const opRel = rt?.operational_relevance || "medium";
  const OP_BASE = {
    very_high: 18, high: 15, medium: 10, low: 5, none: 0,
  };
  let score = OP_BASE[opRel] ?? 10;

  // Boost for types that imply real-world activity
  const OP_TYPE_BOOST = {
    incident_event: 3, exploit_chain: 2, threat_actor_activity: 2,
    adversary_adoption: 2, vulnerability_fact: 1,
  };
  score = Math.min(20, score + (OP_TYPE_BOOST[item.evidence_type] || 0));

  return Math.max(0, score);
}

function scoreHorizonSignificance(item, source, rt) {
  const novelty = rt?.novelty || "unknown";
  const NOVELTY_BASE = {
    new_attack_surface: 18, new_tactic: 16, known_tactic_new_scale: 13,
    known_tactic: 8, incremental: 5, unknown: 7,
  };
  let score = NOVELTY_BASE[novelty] ?? 7;

  // Boost for ecosystem-level or broad-scope items
  const SCOPE_BOOST = {
    ecosystem_shift: 3, infrastructure_dependency: 3, trust_boundary_shift: 2,
    capability_delta: 2, adversary_adoption: 2,
  };
  score = Math.min(20, score + (SCOPE_BOOST[item.evidence_type] || 0));

  return Math.max(0, score);
}

function scoreActionability(item) {
  const ACTIONABLE_TYPES = {
    mitigation: 9, vulnerability_fact: 8, governance_action: 8,
    defensive_control: 8, exploit_chain: 7, incident_event: 6,
    attack_method: 6, threat_actor_activity: 6, adversary_adoption: 5,
    benchmark_result: 5, research_result: 4, capability_delta: 5,
    statistic: 4, strategic_signal: 3, ecosystem_shift: 3,
    infrastructure_dependency: 4, trust_boundary_shift: 5,
    societal_harm: 4, timeline_event: 3,
  };
  return ACTIONABLE_TYPES[item.evidence_type] ?? 3;
}

function scoreCorroboration(item, source) {
  // Base from trust tier — primary/curated sources are inherently more credible
  const TIER_BASE = { primary: 5, curated: 5, high: 4, medium: 3, low: 1, unknown: 0 };
  let score = TIER_BASE[source.trust_tier] ?? 0;

  // Cross-source cluster bonus: claim appears in multiple independent sources
  const cluster = item.evidence_cluster || {};
  if (cluster.is_multi_source) {
    const size = cluster.cluster_size || 1;
    if (size >= 5)      score += 5;
    else if (size >= 3) score += 4;
    else if (size >= 2) score += 3;
  } else if (cluster.is_representative === false) {
    // Non-representative duplicate within a cluster — already corroborated but penalised separately
    score += 1;
  }

  return Math.min(10, score);
}

function scoreRecency(source) {
  if (!source.date_published) return 0;
  const ageDays = (Date.now() - new Date(source.date_published).getTime()) / 86400000;
  if (ageDays <= 30)  return 5;
  if (ageDays <= 90)  return 4;
  if (ageDays <= 180) return 3;
  if (ageDays <= 365) return 2;
  return 1;
}

// ── Penalties ─────────────────────────────────────────────────────────────────

function computePenalties(item, source, applyDuplicatePenalty) {
  let pen = 0;
  const reasons = [];

  // Duplicate (non-representative cluster member)
  if (applyDuplicatePenalty && item.evidence_cluster?.is_multi_source && !item.evidence_cluster?.is_representative) {
    pen += 10;
    reasons.push("duplicate(-10)");
  }

  // Low confidence
  if (item.evidence_confidence === "low") {
    pen += 10;
    reasons.push("low_confidence(-10)");
  }

  // Speculative language heuristic.
  // Match modal verbs (may/might/could) only when used as lowercase modals
  // followed by a verb — this avoids flagging the month "May" or proper nouns.
  const factOrig = item.fact || "";
  const speculative =
    /\b(may|might|could)\s+[a-z]/.test(factOrig) ||      // lowercase modal + lowercase word
    /\b(possibly|potentially)\b/i.test(factOrig) ||
    /\b(it is possible|in the future|is expected to|is likely to)\b/i.test(factOrig);
  if (speculative) {
    pen += 8;
    reasons.push("speculative(-8)");
  }

  // Missing URL
  if (!source.url) {
    pen += 5;
    reasons.push("no_url(-5)");
  }

  // Missing date
  if (!source.date_published) {
    pen += 3;
    reasons.push("no_date(-3)");
  }

  // Very short fact (likely generic)
  if ((item.fact || "").length < 20) {
    pen += 5;
    reasons.push("short_fact(-5)");
  }

  // Non-atomic fact (compound / summary) — rawfacts should be atomic claims.
  if (item.is_atomic === false) {
    pen += 6;
    reasons.push("non_atomic(-6)");
  }

  // Ungrounded quote — source_quote could not be traced to the source body.
  // Only penalise when the source actually had text to check against.
  if (item.quote_verified === false && item.quote_match && item.quote_match !== "no_source") {
    pen += 6;
    reasons.push("ungrounded_quote(-6)");
  }

  return { total: Math.min(25, pen), reasons };
}

// ── Criticality check ─────────────────────────────────────────────────────────

function checkCriticality(score, components, item) {
  if (score < 85) return false;
  if (components.source_authority < 10) return false;
  if (components.evidence_strength < 14) return false;
  if (components.operational_relevance < 15 && components.horizon_significance < 15) return false;
  if (item.evidence_confidence === "low") return false;
  if (components.penalties > 5) return false;
  // A critical rawfact must be a grounded, atomic claim — never a summary or an
  // unverified quote. quote_verified === false (with a checkable source) disqualifies;
  // undefined (older items / no source text) is allowed through for backward compat.
  if (item.quote_verified === false && item.quote_match !== "no_source") return false;
  if (item.is_atomic === false) return false;
  return true;
}

// ── Priority bands ─────────────────────────────────────────────────────────────

function priorityBand(score, isCritical) {
  if (isCritical && score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  if (score >= 30) return "low";
  return "archive_only";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score a single evidence item.
 *
 * @param {object} item   - Evidence item from normalizeEvidenceItems
 * @param {object} source - The parent source
 * @param {boolean} applyDuplicatePenalty - True in the second pass (after clustering)
 * @returns {object} Item with `score_data` field added
 */
export function scoreEvidenceItem(item, source, applyDuplicatePenalty = false) {
  const rt = source.rawfact_taxonomy || {};

  const source_authority       = scoreSourceAuthority(source);
  const evidence_strength      = scoreEvidenceStrength(item, source);
  const operational_relevance  = scoreOperationalRelevance(item, source, rt);
  const horizon_significance   = scoreHorizonSignificance(item, source, rt);
  const actionability          = scoreActionability(item);
  const corroboration          = scoreCorroboration(item, source);
  const recency                = scoreRecency(source);
  const { total: penalties, reasons: penalty_reasons } = computePenalties(item, source, applyDuplicatePenalty);

  const raw = source_authority + evidence_strength + operational_relevance +
              horizon_significance + actionability + corroboration + recency - penalties;

  const evidence_score = Math.max(0, Math.min(100, raw));
  const components = {
    source_authority, evidence_strength, operational_relevance,
    horizon_significance, actionability, corroboration, recency, penalties,
  };
  const isCritical = checkCriticality(evidence_score, components, item);
  const evidence_priority = priorityBand(evidence_score, isCritical);

  return {
    ...item,
    score_data: {
      evidence_score,
      evidence_priority,
      score_breakdown: components,
      penalty_reasons,
      criticality_reason: isCritical
        ? `score=${evidence_score}, authority=${source_authority}, strength=${evidence_strength}, op_rel=${operational_relevance}, horizon=${horizon_significance}`
        : null,
    },
  };
}

/**
 * Score all evidence items for a single source.
 *
 * @param {object} source
 * @param {boolean} applyDuplicatePenalty
 * @returns {object} Source with evidence_items re-scored
 */
export function scoreSourceEvidenceItems(source, applyDuplicatePenalty = false) {
  const items = source.evidence_items || [];
  if (items.length === 0) {
    // Maintain backward compat: derive rawfact_score_data from source-level fields if no items
    return source;
  }

  const scoredItems = items.map((item) => scoreEvidenceItem(item, source, applyDuplicatePenalty));

  // Derive source-level rawfact_score_data from the best evidence item
  const bestItem = scoredItems.reduce((best, item) => {
    const score = item.score_data?.evidence_score ?? 0;
    return score > (best?.score_data?.evidence_score ?? 0) ? item : best;
  }, scoredItems[0]);

  const rawfact_score    = bestItem?.score_data?.evidence_score ?? 0;
  const rawfact_priority = bestItem?.score_data?.evidence_priority === "critical"
    ? "must_read"
    : bestItem?.score_data?.evidence_priority ?? "archive_only";

  const rawfact_score_data = {
    rawfact_score,
    rawfact_priority,
    score_breakdown: bestItem?.score_data?.score_breakdown || {},
    scoring_reason:  `Derived from best evidence item (${bestItem?.evidence_id || "n/a"})`,
    // v6 fields
    evidence_item_count: scoredItems.length,
    critical_count: scoredItems.filter((i) => i.score_data?.evidence_priority === "critical").length,
    high_count:     scoredItems.filter((i) => i.score_data?.evidence_priority === "high").length,
  };

  return {
    ...source,
    evidence_items: scoredItems,
    rawfact_score_data,
    // Mirror for backward compat
    feed_score_data: {
      feed_score:     rawfact_score,
      feed_priority:  rawfact_priority,
      scoring_reason: rawfact_score_data.scoring_reason,
    },
  };
}

/**
 * Score all evidence items across all sources (initial pass — no duplicate penalty).
 *
 * @param {object[]} sources
 * @returns {object[]}
 */
export function scoreAllEvidenceItems(sources) {
  return sources.map((s) => scoreSourceEvidenceItems(s, false));
}

/**
 * Re-score after clustering, applying duplicate penalty to non-representative items.
 *
 * @param {object[]} sources
 * @returns {object[]}
 */
export function rescoreWithDuplicatePenalty(sources) {
  return sources.map((s) => scoreSourceEvidenceItems(s, true));
}
