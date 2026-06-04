/**
 * Layer 7.1C — Rawfact Source Scoring
 *
 * Fully deterministic — no LLM calls. Called twice per pipeline run:
 *   Pass 1 (before clustering): all sources scored, no duplicate penalty yet.
 *   Pass 2 (after clustering):  non-representative cluster members receive -10 penalty.
 *
 * ── SCORE FORMULA ─────────────────────────────────────────────────────────────
 * rawfact_score = common_base(0–40) + type_specific(0–45) + horizon_bonus(0–15) - penalties
 *
 * common_base (0–40): source_credibility(0–10) + ai_relevance(0–10) +
 *   evidence_concreteness(0–10) + citation_quality(0–5) + recency(0–5)
 *
 * type_specific (0–45): 15 scorers, one per source_type:
 *   threat_intel_report, academic_paper, vendor_security_blog, news_article,
 *   government_advisory, conference_talk, technical_writeup, vulnerability_db,
 *   tool_or_project, standard_or_framework, podcast_or_video, newsletter,
 *   social_media, forum_discussion, unknown
 *   Each scorer weights different rawfact_taxonomy fields
 *   (operational_relevance, attack_vectors, technical_depth, cve_count, etc.)
 *
 * horizon_bonus (0–15): bonus for AI-specific attack chains, multi-vector attacks,
 *   novel emerging techniques, or high ai_specificity_score
 *
 * duplicate_penalty (-10): applied to non-representative members of multi-source
 *   clusters (rawfact_cluster.is_representative === false AND cluster_size > 1).
 *   Only active in Pass 2.
 *
 * ── PRIORITY BANDS ────────────────────────────────────────────────────────────
 * must_read    ≥ 85
 * high         70–84
 * medium       50–69
 * low          30–49
 * archive_only < 30
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * Adds rawfact_score_data to each source:
 *   { rawfact_score, rawfact_priority, common_base, type_specific, horizon_bonus,
 *     duplicate_penalty, breakdown }
 * Also mirrors as feed_score_data for backward compatibility.
 */

// ── Utility helpers ────────────────────────────────────────────────────────────

/**
 * Map an enum value to a numeric score using a lookup map.
 * Returns `fallback` (default 0) when value is absent or not in the map.
 */
function enumScore(val, map, fallback = 0) {
  return map[val] ?? fallback;
}

// ── Common base scorer (0-40) ─────────────────────────────────────────────────

function commonBase(source) {
  // source_credibility (0-10)
  const CREDIBILITY = { primary: 10, curated: 9, high: 8, medium: 6, low: 3, unknown: 1 };
  const source_credibility = CREDIBILITY[source.trust_tier] ?? 1;

  // ai_cyber_relevance (0-10)
  const aiScore = source.ai_specificity_score ?? 0;
  const catConf = source.classification_confidence;
  const hasOffensiveCat = source.main_category && source.main_category !== "unclear_or_adjacent";
  let ai_relevance = Math.min(10, Math.round(aiScore * 10 / 100));
  if (hasOffensiveCat && catConf === "high")        ai_relevance = Math.max(ai_relevance, 8);
  else if (hasOffensiveCat && catConf === "medium") ai_relevance = Math.max(ai_relevance, 5);

  // evidence_concreteness (0-10)
  const keyFacts   = source.evidence_card?.key_facts?.length ?? source.understanding?.main_claims?.length ?? 0;
  const hasNumbers = (source.evidence_card?.numbers_statistics?.length ?? source.understanding?.important_numbers?.length ?? 0) > 0;
  const hasAttackFlow = (source.evidence_card?.attack_flow?.length ?? 0) > 0;
  const evidence_concreteness = Math.min(10, keyFacts * 2 + (hasNumbers ? 2 : 0) + (hasAttackFlow ? 2 : 0));

  // citation_quality (0-5)
  let citation_quality;
  if (source.trust_tier === "primary" || source.trust_tier === "curated") citation_quality = 5;
  else if (source.trust_tier === "high") citation_quality = 4;
  else if (source.url) citation_quality = 2;
  else citation_quality = 0;

  // recency (0-5)
  let recency = 0;
  if (source.date_published) {
    const ageMs   = Date.now() - new Date(source.date_published).getTime();
    const ageDays = ageMs / 86400000;
    if (ageDays <= 30)       recency = 5;
    else if (ageDays <= 90)  recency = 3;
    else if (ageDays <= 180) recency = 2;
    else if (ageDays <= 365) recency = 1;
  }

  const total = source_credibility + ai_relevance + evidence_concreteness + citation_quality + recency;

  return { source_credibility, ai_relevance, evidence_concreteness, citation_quality, recency, total };
}

// ── Type-specific scorer (0-45) ───────────────────────────────────────────────

function typeSpecificScore(source) {
  const st  = source.source_type || "unknown";
  const rt  = source.rawfact_taxonomy || {};
  const ctx = rt.source_type_context || {};

  switch (st) {
    case "vulnerability": {
      const exploitability = enumScore(ctx.exploitability,
        { very_high: 10, high: 8, medium: 5, low: 2 });
      const severity = enumScore(rt.impact_severity,
        { critical: 10, high: 8, medium: 5, low: 2, informational: 1 });
      const blast = enumScore(ctx.blast_radius,
        { global: 8, ecosystem: 7, sector: 5, product: 3, local: 1 });
      const ecosystem = (Array.isArray(rt.technology) &&
        (rt.technology.includes("llm") || rt.technology.includes("ai_agent"))) ? 7 : 4;
      const exploit_status = enumScore(ctx.exploit_status,
        { exploited_in_the_wild: 5, proof_of_concept: 3, disclosed: 1 });
      const defender = enumScore(ctx.defender_actionability,
        { immediate: 5, monitor: 3, low: 1 });
      const score = Math.min(45, exploitability + severity + blast + ecosystem + exploit_status + defender);
      return {
        score,
        breakdown: { exploitability, severity, blast, ecosystem, exploit_status, defender },
      };
    }

    case "exploit_disclosure": {
      const repro = enumScore(ctx.reproducibility,
        { high: 10, medium: 6, low: 2 });
      const realism = enumScore(ctx.operational_realism,
        { high: 10, medium: 6, low: 2 });
      const chainQuality = Math.min(8, (ctx.exploit_chain?.length ?? 0) * 2);
      const access = enumScore(ctx.required_access,
        { none: 7, user: 5, privileged: 2 });
      const tooling = ctx.public_tooling_available ? 5 : 0;
      const automation = enumScore(ctx.automation_potential,
        { high: 5, medium: 3, low: 1 });
      const score = Math.min(45, repro + realism + chainQuality + access + tooling + automation);
      return {
        score,
        breakdown: { repro, realism, chainQuality, access, tooling, automation },
      };
    }

    case "incident": {
      const impact = enumScore(ctx.confirmed_impact,
        { confirmed: 10, claimed: 6, unclear: 2 });
      const scale = enumScore(ctx.incident_scale,
        { societal: 8, ecosystem: 7, sector: 6, organization: 4, individual: 2 });
      const sectors = rt.sector || [];
      const sectorScore = sectors.some((s) =>
        ["financial_services","healthcare","energy","government","defense"].includes(s)) ? 7 : 4;
      const repeat = enumScore(ctx.repeatability,
        { high: 7, medium: 4, low: 1 });
      const method = ctx.attacker_method ? 5 : 0;
      const response = enumScore(ctx.institutional_response,
        { yes: 4, no: 1, unknown: 0 });
      const numbers = (ctx.known_losses_or_numbers?.length ?? 0) > 0 ? 4 : 0;
      const score = Math.min(45, impact + scale + sectorScore + repeat + method + response + numbers);
      return {
        score,
        breakdown: { impact, scale, sectorScore, repeat, method, response, numbers },
      };
    }

    case "threat_intelligence": {
      const opEvidence = enumScore(ctx.operational_confidence,
        { high: 10, medium: 6, low: 2 });
      const ttpScore = Math.min(10, (ctx.observed_ttps?.length ?? 0) * 3);
      const attribution = enumScore(ctx.attribution_confidence,
        { high: 7, medium: 4, low: 1 });
      const sectors = (ctx.targeted_sectors?.length ?? 0) > 0 ? 6 : 2;
      const aiRole = enumScore(ctx.ai_role_in_operation,
        { tool: 6, target: 5, operating_environment: 4, unknown: 0 });
      const defender = 6; // TI always has defender value
      const score = Math.min(45, opEvidence + ttpScore + attribution + sectors + aiRole + defender);
      return {
        score,
        breakdown: { opEvidence, ttpScore, attribution, sectors, aiRole, defender },
      };
    }

    case "research_finding": {
      const noveltyScore = enumScore(rt.novelty, {
        new_attack_surface: 10, new_tactic: 8, known_tactic_new_scale: 5,
        known_tactic: 3, incremental: 1,
      });
      const repro = enumScore(ctx.reproducibility,
        { high: 8, medium: 5, low: 2 });
      const threat = enumScore(ctx.research_to_threat_potential,
        { high: 10, medium: 5, low: 1 });
      const systems = Math.min(7, (ctx.systems_tested?.length ?? 0) * 2);
      const barriers = (ctx.operationalization_barriers?.length ?? 0) === 0
        ? 5
        : Math.max(0, 5 - ctx.operationalization_barriers.length);
      const defensive = ctx.defensive_implications ? 5 : 0;
      const score = Math.min(45, noveltyScore + repro + threat + systems + barriers + defensive);
      return {
        score,
        breakdown: { noveltyScore, repro, threat, systems, barriers, defensive },
      };
    }

    case "defensive_capability": {
      const gap = ctx.defensive_gap_addressed ? 10 : 0;
      const readiness = enumScore(ctx.deployment_readiness,
        { production: 10, pilot: 7, research: 4, concept: 2 });
      const coverage = enumScore(ctx.coverage_scope,
        { broad: 8, moderate: 5, narrow: 2 });
      const eval_qual = enumScore(ctx.evaluation_quality,
        { strong: 7, moderate: 4, weak: 1 });
      const enterprise = 5; // all defensive caps have enterprise value
      const limits = (ctx.limitations?.length ?? 0) > 0 ? 5 : 2; // transparency bonus
      const score = Math.min(45, gap + readiness + coverage + eval_qual + enterprise + limits);
      return {
        score,
        breakdown: { gap, readiness, coverage, eval_qual, enterprise, limits },
      };
    }

    case "governance_signal": {
      const authority = ctx.issuing_authority ? 10 : 3;
      const sectorScope = Math.min(8, (ctx.affected_sectors?.length ?? 0) * 2 + 2);
      const systemic = ctx.systemic_risk_recognized ? 10 : 3;
      const compliance = ctx.compliance_or_policy_implication ? 7 : 2;
      const nearTerm = 5; // always relevant
      const actions = Math.min(5, (ctx.recommended_actions?.length ?? 0) * 2);
      const score = Math.min(45, authority + sectorScope + systemic + compliance + nearTerm + actions);
      return {
        score,
        breakdown: { authority, sectorScope, systemic, compliance, nearTerm, actions },
      };
    }

    case "ecosystem_signal": {
      const adoption = enumScore(ctx.adoption_signal,
        { strong: 10, moderate: 6, weak: 2 });
      const infra = ctx.infrastructure_or_platform ? 10 : 3;
      const downstream = enumScore(ctx.downstream_security_impact,
        { high: 8, medium: 5, low: 2 });
      const depGrowth = enumScore(ctx.dependency_growth,
        { high: 7, medium: 4, low: 1 });
      const attackSurface = enumScore(ctx.attack_surface_growth,
        { high: 5, medium: 3, low: 1 });
      const centrality = 5;
      const score = Math.min(45, adoption + infra + downstream + depGrowth + attackSurface + centrality);
      return {
        score,
        breakdown: { adoption, infra, downstream, depGrowth, attackSurface, centrality },
      };
    }

    case "societal_harm_signal": {
      const harmSev = enumScore(rt.impact_severity,
        { critical: 10, high: 8, medium: 5, low: 2, informational: 1 });
      const population = ctx.affected_population ? 8 : 2;
      const scale = enumScore(ctx.harm_scale,
        { global: 7, national: 6, institutional: 5, community: 3, individual: 1 });
      const repeat = enumScore(ctx.repeatability,
        { high: 7, medium: 4, low: 1 });
      const response = enumScore(ctx.institutional_response,
        { yes: 6, no: 3, unknown: 0 });
      const trust = ctx.trust_system_affected ? 7 : 2;
      const score = Math.min(45, harmSev + population + scale + repeat + response + trust);
      return {
        score,
        breakdown: { harmSev, population, scale, repeat, response, trust },
      };
    }

    case "benchmark_evaluation": {
      const credibility = (source.trust_tier === "primary" || source.trust_tier === "high") ? 10 : 5;
      const capability = ctx.capability_measured ? 10 : 3;
      const eval_qual = enumScore(rt.impact_severity,
        { critical: 8, high: 6, medium: 4, low: 2 });
      const trajectory = enumScore(ctx.trajectory_signal,
        { high: 8, medium: 5, low: 2 });
      const operational = 5;
      const repro = (ctx.limitations?.length ?? 0) === 0 ? 4 : 2;
      const score = Math.min(45, credibility + capability + eval_qual + trajectory + operational + repro);
      return {
        score,
        breakdown: { credibility, capability, eval_qual, trajectory, operational, repro },
      };
    }

    case "strategic_signal": {
      const horizon = enumScore(ctx.horizon_relevance,
        { very_high: 10, high: 8, medium: 5, low: 2, none: 0 });
      const convergence = ctx.convergence_signal ? 10 : 3;
      const systemic = ctx.systemic_risk ? 8 : 2;
      const examples = Math.min(7, (ctx.supporting_examples?.length ?? 0) * 2);
      const confidence = enumScore(ctx.confidence,
        { high: 5, medium: 3, low: 1 });
      const deck = 5;
      const score = Math.min(45, horizon + convergence + systemic + examples + confidence + deck);
      return {
        score,
        breakdown: { horizon, convergence, systemic, examples, confidence, deck },
      };
    }

    case "capability_demonstration": {
      const noveltyScore = enumScore(rt.novelty, {
        new_attack_surface: 12, new_tactic: 10, known_tactic_new_scale: 6,
        known_tactic: 3, incremental: 1,
      });
      const ease = enumScore(ctx.ease_of_replication,
        { high: 10, medium: 6, low: 2 });
      const access = enumScore(ctx.required_access,
        { none: 8, user: 6, privileged: 3, unknown: 1 });
      const publicRepro = ctx.public_reproduction_available ? 8 : 0;
      const defender = ctx.defender_implications ? 7 : 2;
      const score = Math.min(45, noveltyScore + ease + access + publicRepro + defender);
      return { score, breakdown: { noveltyScore, ease, access, publicRepro, defender } };
    }

    case "adversary_adoption_signal": {
      const evidence = enumScore(ctx.observed_evidence,
        { confirmed: 12, claimed: 7, inferred: 4, unknown: 1 });
      const spread = enumScore(ctx.spread_trajectory,
        { high: 10, medium: 6, low: 2, unknown: 0 });
      const sectorCount = Math.min(8, (ctx.targeted_sectors?.length ?? 0) * 3);
      const opRel = enumScore(rt.operational_relevance,
        { very_high: 10, high: 7, medium: 4, low: 1, none: 0 });
      const actor = ctx.adopting_actor_type ? 5 : 0;
      const score = Math.min(45, evidence + spread + sectorCount + opRel + actor);
      return { score, breakdown: { evidence, spread, sectorCount, opRel, actor } };
    }

    case "infrastructure_dependency_signal": {
      const criticality = enumScore(ctx.criticality,
        { critical: 12, high: 9, medium: 5, low: 2, unknown: 1 });
      const scope = enumScore(ctx.scope_of_exposure,
        { global: 10, ecosystem: 8, sector: 5, organization: 3, unknown: 1 });
      const exploits = ctx.known_exploits ? 8 : 0;
      const surface = ctx.attack_surface_created ? 7 : 2;
      const systems = Math.min(8, (ctx.affected_systems?.length ?? 0) * 2);
      const score = Math.min(45, criticality + scope + exploits + surface + systems);
      return { score, breakdown: { criticality, scope, exploits, surface, systems } };
    }

    case "trust_boundary_shift": {
      const noveltyScore = enumScore(rt.novelty, {
        new_attack_surface: 12, new_tactic: 9, known_tactic_new_scale: 6,
        known_tactic: 3, incremental: 1,
      });
      const systemic = ctx.systemic_implication ? 10 : 3;
      const exploitability = enumScore(ctx.exploitability_window,
        { immediate: 10, near_term: 7, long_term: 4, unknown: 1 });
      const stakeholders = Math.min(8, (ctx.affected_stakeholders?.length ?? 0) * 3);
      const violated = ctx.trust_assumption_violated ? 7 : 2;
      const score = Math.min(45, noveltyScore + systemic + exploitability + stakeholders + violated);
      return { score, breakdown: { noveltyScore, systemic, exploitability, stakeholders, violated } };
    }

    default:
      return { score: 5, breakdown: { default_type: 5 } };
  }
}

// ── Horizon/evidence bonus (0-15) ─────────────────────────────────────────────

function horizonBonus(source) {
  let bonus = 0;
  const opRel  = source.rawfact_taxonomy?.operational_relevance;
  const novelty = source.rawfact_taxonomy?.novelty;

  if ((opRel === "very_high" || opRel === "high") &&
      (novelty === "new_attack_surface" || novelty === "new_tactic")) {
    bonus += 5;
  }

  const hasNumbers = (
    source.evidence_card?.numbers_statistics?.length ??
    source.understanding?.important_numbers?.length ?? 0
  ) > 0;
  if (hasNumbers) bonus += 5;

  const mainCat = source.main_category;
  if (mainCat && mainCat !== "unclear_or_adjacent" && source.classification_confidence === "high") {
    bonus += 5;
  }

  return bonus;
}

// ── Penalties ─────────────────────────────────────────────────────────────────

function penalties(source) {
  let pen = 0;

  // Duplicate (not representative)
  const cluster = source.rawfact_cluster;
  if (cluster?.is_multi_source && !cluster?.is_representative) pen += 10;

  // No concrete facts
  const factCount = source.evidence_card?.key_facts?.length ?? source.understanding?.main_claims?.length ?? 0;
  if (factCount === 0) pen += 10;

  // Weak AI relevance
  if ((source.ai_specificity_score ?? 100) < 20 && source.main_category === "unclear_or_adjacent") pen += 15;

  // Low trust tier
  if (source.trust_tier === "low") pen += 20;

  // Unknown type with no taxonomy tags
  if (
    source.source_type === "unknown" &&
    (source.understanding?.primary_threat_tags?.length ?? 0) === 0 &&
    (source.understanding?.secondary_dimensions?.length ?? 0) === 0
  ) pen += 10;

  return pen;
}

// ── Priority band ─────────────────────────────────────────────────────────────

function priorityBand(score) {
  if (score >= 85) return "must_read";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  if (score >= 30) return "low";
  return "archive_only";
}

// ── Scoring reason builder ────────────────────────────────────────────────────

function buildScoringReason(source, base, typeScore, bonus, penalty) {
  const parts = [];
  const tt = source.trust_tier || "unknown";
  const st = source.source_type || "unknown";

  parts.push(`${tt} trust (${base.source_credibility}/10)`);
  parts.push(`${st.replace(/_/g, " ")} type (type=${typeScore})`);

  if (base.ai_relevance >= 8)       parts.push("high AI relevance");
  else if (base.ai_relevance >= 5)  parts.push("medium AI relevance");
  else                              parts.push("low AI relevance");

  if (bonus > 0)   parts.push(`horizon bonus +${bonus}`);
  if (penalty > 0) parts.push(`penalties -${penalty}`);

  const opRel = source.rawfact_taxonomy?.operational_relevance;
  if (opRel) parts.push(`op_relevance=${opRel}`);

  return parts.join(", ");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score sources using source-type-specific deterministic scoring (Layer 7.1C).
 * Synchronous — no LLM calls.
 *
 * @param {object[]} sources - Sources with rawfact_taxonomy (and optionally evidence_card, rawfact_cluster).
 * @returns {object[]} Sources with `rawfact_score_data` and `feed_score_data` fields added.
 */
export function scoreRawfacts(sources) {
  return sources.map((source) => {
    const base     = commonBase(source);
    const { score: type_score, breakdown: type_breakdown } = typeSpecificScore(source);
    const bonus    = horizonBonus(source);
    const penalty  = penalties(source);

    const rawfact_score = Math.max(0, Math.min(100, base.total + type_score + bonus - penalty));
    const rawfact_priority = priorityBand(rawfact_score);

    const rawfact_score_data = {
      rawfact_score,
      rawfact_priority,
      score_breakdown: {
        common_base:    base.total,
        type_specific:  type_score,
        horizon_bonus:  bonus,
        penalties:      penalty,
        // Individual common_base components
        source_credibility:    base.source_credibility,
        ai_relevance:          base.ai_relevance,
        evidence_concreteness: base.evidence_concreteness,
        citation_quality:      base.citation_quality,
        recency:               base.recency,
        // Type-specific breakdown
        type_breakdown,
      },
      scoring_reason: buildScoringReason(source, base, type_score, bonus, penalty),
    };

    // Mirror as feed_score_data so the rest of the pipeline continues to work
    const feed_score_data = {
      feed_score:     rawfact_score,
      feed_priority:  rawfact_priority,
      scoring_reason: rawfact_score_data.scoring_reason,
    };

    return { ...source, rawfact_score_data, feed_score_data };
  });
}
