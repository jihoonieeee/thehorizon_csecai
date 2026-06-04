/**
 * Layer 5a.5 — Evidence Importance Scoring (v2)
 *
 * Source-type-aware scoring architecture. Deterministic.
 * Called twice: before clustering (no duplicate penalty) and after (with penalty).
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 *   Stage 1 — Hard eligibility gates    → immediate archive_only if failed
 *   Stage 2 — Evidence role             → classify what role this fact plays
 *   Stage 3 — Criticality path          → source_type-specific gate for critical band
 *   Stage 4 — Weighted scoring (0–100)  → source_type group determines dimension weights
 *   Stage 5 — Band assignment           → gates control decision; score supports it
 *   Stage 6 — Scoring explanation       → auditable breakdown on every item
 *
 * ── BANDS ─────────────────────────────────────────────────────────────────────
 *   critical ≥ 80 (AND criticality path passed)
 *   high     ≥ 65
 *   medium   ≥ 45
 *   low      ≥ 25
 *   archive_only < 25
 *
 * ── SOURCE TYPE GROUPS ────────────────────────────────────────────────────────
 *   operational — vulnerability, exploit_disclosure, incident, threat_intelligence
 *   horizon     — research_finding, benchmark_evaluation, capability_demonstration,
 *                  adversary_adoption_signal, infrastructure_dependency_signal, strategic_signal
 *   contextual  — defensive_capability, trust_boundary_shift, societal_harm_signal,
 *                  governance_signal, ecosystem_signal
 *   unknown     — fallback; capped at medium
 */

// ── Source type → group ───────────────────────────────────────────────────────

const SOURCE_TYPE_GROUP = {
  vulnerability:                    "operational",
  exploit_disclosure:               "operational",
  incident:                         "operational",
  threat_intelligence:              "operational",
  research_finding:                 "horizon",
  benchmark_evaluation:             "horizon",
  capability_demonstration:         "horizon",
  adversary_adoption_signal:        "horizon",
  infrastructure_dependency_signal: "horizon",
  strategic_signal:                 "horizon",
  defensive_capability:             "contextual",
  trust_boundary_shift:             "contextual",
  societal_harm_signal:             "contextual",
  governance_signal:                "contextual",
  ecosystem_signal:                 "contextual",
};

// Hard ceiling per source_type. The criticality path can lift "high" → "critical"
// for types marked critical in the ceiling, but cannot exceed this value.
const SOURCE_TYPE_MAX_BAND = {
  vulnerability:                    "critical",
  exploit_disclosure:               "critical",
  incident:                         "critical",
  threat_intelligence:              "critical",
  research_finding:                 "high",   // critical allowed via path (novelty + operational pathway)
  benchmark_evaluation:             "high",   // critical allowed via path (headline numeric anchor)
  capability_demonstration:         "high",   // critical allowed via path (concrete operationalization)
  adversary_adoption_signal:        "critical",
  infrastructure_dependency_signal: "high",   // critical allowed via path (systemic exposure)
  trust_boundary_shift:             "high",   // critical allowed via path (concrete attack path)
  societal_harm_signal:             "high",   // critical allowed via path (large-scale observed harm)
  governance_signal:                "high",
  ecosystem_signal:                 "high",   // critical allowed via path (systemic surface change)
  strategic_signal:                 "high",   // critical allowed via path (corroborated major shift)
  unknown:                          "medium",
};

// Dimension weights per group. Each group's weights sum to 100.
// Operational: what happened, how bad, how real
// Horizon:     how novel, how likely to operationalize, what it means for the future
// Contextual:  strategic implications, policy relevance, indirect security impact
const GROUP_WEIGHTS = {
  operational: {
    source_credibility:    15,
    threat_relevance:      25,
    evidence_concreteness: 20,
    operational_impact:    20,
    corroboration:         10,
    recency:                5,
    analytical_usefulness:  5,
  },
  horizon: {
    source_credibility:            15,
    threat_relevance:              20,
    evidence_concreteness:         15,
    horizon_significance:          25,
    operationalization_likelihood: 15,
    corroboration:                  5,
    analytical_usefulness:          5,
  },
  contextual: {
    source_credibility:      15,
    threat_relevance:        15,
    evidence_concreteness:   15,
    strategic_relevance:     20,
    operational_implication: 15,
    corroboration:           10,
    analytical_usefulness:   10,
  },
  unknown: {
    source_credibility:    20,
    threat_relevance:      20,
    evidence_concreteness: 30,
    corroboration:         20,
    recency:               10,
  },
};

const BAND_ORDER = ["archive_only", "low", "medium", "high", "critical"];

// ── Stage 1 — Hard eligibility gates ─────────────────────────────────────────
// Failing any gate immediately assigns archive_only regardless of score.
// These catch structurally weak evidence before expensive dimension computation.

function checkHardGates(item, source) {
  const reasons = [];
  const fact     = item.fact || "";

  // No source URL — evidence is unverifiable
  if (!source.url) reasons.push("no_source_url");

  // Quote was checked against source body and failed verification
  // (quote_verified = false with a non-null quote_match that isn't "no_source")
  if (item.quote_verified === false && item.quote_match && item.quote_match !== "no_source") {
    reasons.push("unverified_quote");
  }

  // Non-atomic claims are compound; they don't meet rawfact atomicity requirement
  if (item.is_atomic === false) reasons.push("non_atomic_claim");

  // Fact too short to be meaningful
  if (fact.length < 20) reasons.push("fact_too_short");

  // Speculative language — modals as uncertainty markers, not as future tense
  if (
    /\b(may|might|could)\s+[a-z]/.test(fact) ||
    /\b(possibly|potentially)\b/i.test(fact) ||
    /\bit is possible|in the future|is expected to|is likely to\b/i.test(fact)
  ) {
    reasons.push("speculative_language");
  }

  // Generic opener with no specifics — "AI can be used to..." style
  if (/^(ai|ml|llm|attackers?|defenders?)\s+(can|may|will|are)\b/i.test(fact) && fact.length < 60) {
    reasons.push("generic_claim");
  }

  // Marketing language without measurable substance
  if (/\b(best[ -]in[ -]class|industry[ -]leading|state[ -]of[ -]the[ -]art|revolutionar|game[ -]changer)\b/i.test(fact)) {
    reasons.push("marketing_language");
  }

  // Unknown + low-trust: not enough signal to be useful
  if ((!source.source_type || source.source_type === "unknown") && source.trust_tier === "low") {
    reasons.push("unknown_low_trust_source");
  }

  // Low confidence with no cross-source corroboration — too weak to use
  if (item.evidence_confidence === "low" && !item.evidence_cluster?.is_multi_source) {
    reasons.push("low_confidence_uncorroborated");
  }

  return { passes: reasons.length === 0, archive_reasons: reasons };
}

// ── Stage 2 — Evidence role classification ────────────────────────────────────
// Describes what function this evidence item serves in the intelligence picture.

const EVIDENCE_TYPE_TO_ROLE = {
  incident_event:            "real_world_incident",
  vulnerability_fact:        "vulnerability_exposure",
  exploit_chain:             "exploitability_signal",
  attack_method:             "attacker_capability",
  threat_actor_activity:     "attacker_capability",
  adversary_adoption:        "adversary_adoption",
  capability_delta:          "attacker_capability",
  benchmark_result:          "quantitative_anchor",
  research_result:           "attacker_capability",
  defensive_control:         "mitigation_or_defensive_priority",
  mitigation:                "mitigation_or_defensive_priority",
  governance_action:         "governance_context",
  ecosystem_shift:           "ecosystem_context",
  infrastructure_dependency: "infrastructure_dependency",
  trust_boundary_shift:      "trust_boundary_change",
  societal_harm:             "societal_harm_case",
  strategic_signal:          "strategic_shift",
  statistic:                 "quantitative_anchor",
  timeline_event:            "background_context",
};

// Source types that force a role override (the type dominates evidence_type for role)
const SOURCE_TYPE_DEFAULT_ROLE = {
  incident:             "operational_impact",
  governance_signal:    "governance_context",
  ecosystem_signal:     "ecosystem_context",
  societal_harm_signal: "societal_harm_case",
  strategic_signal:     "strategic_shift",
};

function classifyEvidenceRole(item, source) {
  const fromType = EVIDENCE_TYPE_TO_ROLE[item.evidence_type];
  if (fromType) return fromType;
  return SOURCE_TYPE_DEFAULT_ROLE[source.source_type] || "background_context";
}

// ── Stage 3 — Source-type criticality paths ───────────────────────────────────
// Each source_type has a named criticality path with specific conditions.
// Returns { passed, path, reason }.
// "passed" = true allows score ≥ 80 to become "critical".
// "passed" = false caps the item at "high" even if score ≥ 80.

function checkCriticalityPath(item, source, rt) {
  const st            = source.source_type || "unknown";
  const et            = item.evidence_type || "";
  const fact          = item.fact || "";
  const hasNumbers    = (item.numbers || []).length > 0 || /\d+%|\$[\d,.]+|\d+[kKmMbB]/i.test(fact);
  const hasEntities   = (item.entities || []).length > 0;
  const credTier      = source.trust_tier || "unknown";
  const opRel         = rt?.operational_relevance || "medium";
  const novelty       = rt?.novelty || "unknown";
  const isMultiSource = item.evidence_cluster?.is_multi_source ?? false;

  const HIGH_CRED   = ["primary", "curated", "high"];
  const MEDIUM_CRED = ["primary", "curated", "high", "medium"];
  const HIGH_OP     = ["very_high", "high"];
  const NEW_NOVELTY = ["new_attack_surface", "new_tactic"];

  switch (st) {
    case "vulnerability":
      // Named component + vuln/exploit evidence type + medium+ trust
      if (["vulnerability_fact", "exploit_chain"].includes(et) && hasEntities && MEDIUM_CRED.includes(credTier)) {
        return { passed: true, path: "vulnerability:cve_with_named_component", reason: "Concrete vulnerability with named component and medium+ trust source" };
      }
      return { passed: false, path: null, reason: "Needs named component, vuln/exploit evidence type, and medium+ credibility" };

    case "exploit_disclosure":
      // Concrete exploit or attack method from credible source
      if (["exploit_chain", "attack_method"].includes(et) && MEDIUM_CRED.includes(credTier)) {
        return { passed: true, path: "exploit_disclosure:reproducible_method", reason: "Concrete exploit or attack method from credible source" };
      }
      return { passed: false, path: null, reason: "Needs exploit_chain or attack_method evidence type with medium+ credibility" };

    case "incident":
      // Real event with concrete details — entities or numbers confirm it's not hypothetical
      if (["incident_event", "threat_actor_activity"].includes(et) && (hasEntities || hasNumbers)) {
        return { passed: true, path: "incident:confirmed_real_world_impact", reason: "Real-world incident with named entities or scale data" };
      }
      return { passed: false, path: null, reason: "Incident needs concrete entities or numbers (actor, victim, method, scale)" };

    case "threat_intelligence":
      // Observed adversary behaviour from high-trust or corroborated source
      if (["threat_actor_activity", "adversary_adoption", "exploit_chain"].includes(et) &&
          (HIGH_CRED.includes(credTier) || isMultiSource)) {
        return { passed: true, path: "threat_intel:observed_adversary_behaviour", reason: "Observed adversary behaviour from high-trust or cross-source corroborated source" };
      }
      return { passed: false, path: null, reason: "Threat intel needs high-trust source or multi-source corroboration for critical" };

    case "research_finding":
      // New attack surface/tactic + quantitative evidence + high operational relevance
      if (hasNumbers && ["research_result", "capability_delta", "benchmark_result"].includes(et) &&
          HIGH_OP.includes(opRel) && NEW_NOVELTY.includes(novelty)) {
        return { passed: true, path: "research:empirical_with_operational_pathway", reason: "New attack surface/tactic with quantitative evidence and high operational relevance" };
      }
      return { passed: false, path: null, reason: "Research needs: numbers + new novelty (new_attack_surface/new_tactic) + high operational relevance; capped at high otherwise" };

    case "benchmark_evaluation":
      // Numeric benchmark result — suitable as a chart or headline anchor
      if (hasNumbers && et === "benchmark_result") {
        return { passed: true, path: "benchmark:headline_quantitative_anchor", reason: "Numeric benchmark result suitable as chart or headline anchor" };
      }
      return { passed: false, path: null, reason: "Benchmark without numeric result is capped at high" };

    case "capability_demonstration":
      // Concrete demo with named target and plausible operationalization
      if (["capability_delta", "exploit_chain"].includes(et) && hasEntities && HIGH_OP.includes(opRel)) {
        return { passed: true, path: "capability_demo:demonstrated_with_pathway", reason: "Concrete capability demo with named target and high operational relevance" };
      }
      return { passed: false, path: null, reason: "Capability demo needs named target entities and plausible operationalization path for critical" };

    case "adversary_adoption_signal":
      // Concrete observed adoption — not theoretical or speculative use
      if (["adversary_adoption", "threat_actor_activity"].includes(et)) {
        return { passed: true, path: "adversary_adoption:observed_adoption", reason: "Concrete observed adversary adoption signal" };
      }
      return { passed: false, path: null, reason: "Adversary adoption signal needs adversary_adoption or threat_actor_activity evidence type" };

    case "infrastructure_dependency_signal":
      // Systemic dependency with high operational exposure
      if (et === "infrastructure_dependency" && HIGH_OP.includes(opRel)) {
        return { passed: true, path: "infra_dependency:systemic_exposure", reason: "Infrastructure dependency with systemic high-impact exposure" };
      }
      return { passed: false, path: null, reason: "Infrastructure dependency needs systemic high-impact exposure signal for critical" };

    case "trust_boundary_shift":
      // New trust boundary with concrete attack pathway
      if (et === "trust_boundary_shift" && HIGH_OP.includes(opRel)) {
        return { passed: true, path: "trust_boundary:concrete_attack_path", reason: "New trust boundary creating concrete attack pathway" };
      }
      return { passed: false, path: null, reason: "Trust boundary shift needs high operational relevance and concrete attack path for critical" };

    case "societal_harm_signal":
      // Large-scale observed harm — scale data AND named entities required
      if (et === "societal_harm" && hasNumbers && hasEntities) {
        return { passed: true, path: "societal_harm:large_scale_observed", reason: "Large-scale observed harm with quantitative scope and named affected party" };
      }
      return { passed: false, path: null, reason: "Societal harm is capped at high; needs numeric scale AND named entities for critical" };

    case "ecosystem_signal":
      // Ecosystem shift creating systemic new attack surface
      if (["ecosystem_shift", "infrastructure_dependency"].includes(et) && HIGH_OP.includes(opRel)) {
        return { passed: true, path: "ecosystem:systemic_surface_change", reason: "Ecosystem shift creating systemic attack surface change" };
      }
      return { passed: false, path: null, reason: "Ecosystem signals capped at high without systemic high-impact evidence" };

    case "strategic_signal":
      // Cross-source corroboration + high operational relevance required
      if (isMultiSource && HIGH_OP.includes(opRel)) {
        return { passed: true, path: "strategic:corroborated_shift", reason: "Corroborated strategic shift with high operational relevance" };
      }
      return { passed: false, path: null, reason: "Strategic signals need multi-source corroboration for critical; capped at high" };

    case "governance_signal":
      // Governance signals rarely reach critical — exceptional circumstances only
      return { passed: false, path: null, reason: "Governance signals are capped at high; critical requires extraordinary policy shift with direct operational impact" };

    case "defensive_capability":
      // Defensive capability informs priority but doesn't drive critical evidence
      return { passed: false, path: null, reason: "Defensive capability is capped at high; critical requires a linked critical threat and major defensive gap" };

    default:
      return { passed: false, path: null, reason: `Unknown source_type '${st}' is capped at medium` };
  }
}

// ── Stage 4 — Dimension scorers (0–100 each) ──────────────────────────────────

function scoreSourceCredibility(source) {
  const TIER = { primary: 100, curated: 90, high: 80, medium: 60, low: 30, unknown: 10 };
  return TIER[source.trust_tier] ?? 10;
}

function scoreEvidenceConcreteness(item) {
  const fact        = item.fact || "";
  const hasNumbers  = (item.numbers || []).length > 0 || /\d+%|\$[\d,.]+|\d+[kKmMbB]/i.test(fact);
  const hasEntities = (item.entities || []).length > 0;

  let score = 40; // baseline for a non-empty claim
  if (hasNumbers)                         score += 15;
  if (hasEntities)                        score += 15;
  if (item.quote_verified === true)       score += 15;
  if (item.is_atomic === true)            score += 10;
  if (item.evidence_confidence === "high") score += 10;
  if (item.evidence_confidence === "low")  score -= 25;
  if (fact.length < 30)                   score -= 15;
  if (fact.length >= 100)                 score +=  5;

  return Math.max(0, Math.min(100, score));
}

function scoreThreatRelevance(item, rt) {
  const opRel = rt?.operational_relevance || "medium";
  const OP_BASE = { very_high: 90, high: 75, medium: 55, low: 30, none: 10 };
  let score = OP_BASE[opRel] ?? 55;

  const TYPE_BOOST = {
    exploit_chain: 10, threat_actor_activity: 10, incident_event: 8,
    vulnerability_fact: 8, adversary_adoption: 7, attack_method: 7, capability_delta: 5,
  };
  return Math.max(0, Math.min(100, score + (TYPE_BOOST[item.evidence_type] || 0)));
}

function scoreOperationalImpact(item, rt) {
  const opRel = rt?.operational_relevance || "medium";
  const OP_BASE = { very_high: 85, high: 70, medium: 50, low: 25, none: 5 };
  let score = OP_BASE[opRel] ?? 50;

  const TYPE_BOOST = {
    incident_event: 12, exploit_chain: 10, vulnerability_fact: 8,
    threat_actor_activity: 8, adversary_adoption: 5,
  };
  return Math.max(0, Math.min(100, score + (TYPE_BOOST[item.evidence_type] || 0)));
}

function scoreHorizonSignificance(item, rt) {
  const novelty = rt?.novelty || "unknown";
  const NOVELTY_BASE = {
    new_attack_surface: 90, new_tactic: 80, known_tactic_new_scale: 65,
    known_tactic: 45, incremental: 30, unknown: 40,
  };
  let score = NOVELTY_BASE[novelty] ?? 40;

  const TYPE_BOOST = {
    capability_delta: 8, ecosystem_shift: 6, trust_boundary_shift: 6,
    adversary_adoption: 5, infrastructure_dependency: 5,
  };
  return Math.max(0, Math.min(100, score + (TYPE_BOOST[item.evidence_type] || 0)));
}

function scoreOperationalizationLikelihood(item, rt) {
  const opRel = rt?.operational_relevance || "medium";
  const BASE = { very_high: 85, high: 70, medium: 50, low: 25, none: 5 };
  let score = BASE[opRel] ?? 50;

  // Theoretical/lab-only framing reduces operationalization score
  const fact = item.fact || "";
  if (/theoret|hypothet|lab setting|in principle|not yet deployed|not yet operati/i.test(fact)) {
    score -= 20;
  }
  return Math.max(0, Math.min(100, score));
}

function scoreStrategicRelevance(item, rt) {
  const novelty = rt?.novelty || "unknown";
  const NOVELTY_BASE = {
    new_attack_surface: 80, new_tactic: 70, known_tactic_new_scale: 60,
    known_tactic: 45, incremental: 30, unknown: 35,
  };
  let score = NOVELTY_BASE[novelty] ?? 35;

  const TYPE_BOOST = {
    governance_action: 15, strategic_signal: 10, ecosystem_shift: 8,
    trust_boundary_shift: 8, infrastructure_dependency: 6,
  };
  return Math.max(0, Math.min(100, score + (TYPE_BOOST[item.evidence_type] || 0)));
}

function scoreOperationalImplication(item, rt) {
  const opRel = rt?.operational_relevance || "medium";
  const BASE = { very_high: 80, high: 65, medium: 45, low: 20, none: 5 };
  let score = BASE[opRel] ?? 45;

  const TYPE_BOOST = {
    defensive_control: 12, mitigation: 10, governance_action: 8,
    trust_boundary_shift: 8, ecosystem_shift: 5,
  };
  return Math.max(0, Math.min(100, score + (TYPE_BOOST[item.evidence_type] || 0)));
}

function scoreCorroboration(item, source) {
  const TIER_BASE = { primary: 60, curated: 55, high: 45, medium: 30, low: 10, unknown: 0 };
  let score = TIER_BASE[source.trust_tier] ?? 0;

  const cluster = item.evidence_cluster || {};
  if (cluster.is_multi_source) {
    const size = cluster.cluster_size || 1;
    if      (size >= 5) score += 40;
    else if (size >= 3) score += 30;
    else if (size >= 2) score += 20;
  }
  return Math.max(0, Math.min(100, score));
}

function scoreRecency(source) {
  if (!source.date_published) return 30; // unknown date = average, not penalised
  const ageDays = (Date.now() - new Date(source.date_published).getTime()) / 86_400_000;
  if (ageDays <=   7) return 100;
  if (ageDays <=  30) return  90;
  if (ageDays <=  90) return  75;
  if (ageDays <= 180) return  55;
  if (ageDays <= 365) return  35;
  return 15;
}

function scoreAnalyticalUsefulness(item) {
  const TYPE_SCORE = {
    statistic: 90, benchmark_result: 85, research_result: 80, incident_event: 80,
    exploit_chain: 75, capability_delta: 75, vulnerability_fact: 70,
    threat_actor_activity: 70, attack_method: 65, adversary_adoption: 65,
    governance_action: 60, trust_boundary_shift: 60, defensive_control: 55,
    mitigation: 55, infrastructure_dependency: 55, ecosystem_shift: 50,
    strategic_signal: 50, societal_harm: 45, timeline_event: 40,
  };
  return TYPE_SCORE[item.evidence_type] ?? 40;
}

function computeAllDimensions(item, source, rt) {
  return {
    source_credibility:            scoreSourceCredibility(source),
    threat_relevance:              scoreThreatRelevance(item, rt),
    evidence_concreteness:         scoreEvidenceConcreteness(item),
    operational_impact:            scoreOperationalImpact(item, rt),
    horizon_significance:          scoreHorizonSignificance(item, rt),
    operationalization_likelihood: scoreOperationalizationLikelihood(item, rt),
    strategic_relevance:           scoreStrategicRelevance(item, rt),
    operational_implication:       scoreOperationalImplication(item, rt),
    corroboration:                 scoreCorroboration(item, source),
    recency:                       scoreRecency(source),
    analytical_usefulness:         scoreAnalyticalUsefulness(item),
  };
}

function computeWeightedScore(dimensions, weights) {
  let total = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    total += (dimensions[dim] ?? 50) * (weight / 100);
  }
  return Math.max(0, Math.min(100, total));
}

// ── Stage 5 — Band assignment ─────────────────────────────────────────────────

function rawScoreToBand(score) {
  if (score >= 80) return "critical";
  if (score >= 65) return "high";
  if (score >= 45) return "medium";
  if (score >= 25) return "low";
  return "archive_only";
}

function capBand(band, maxBand) {
  const idx    = BAND_ORDER.indexOf(band);
  const maxIdx = BAND_ORDER.indexOf(maxBand);
  return idx > maxIdx ? maxBand : band;
}

function assignBand(score, critPathPassed, sourceType) {
  let band = rawScoreToBand(score);
  // Score alone is not enough for critical — the criticality path must pass too
  if (band === "critical" && !critPathPassed) band = "high";
  // Apply source_type ceiling
  const maxBand = SOURCE_TYPE_MAX_BAND[sourceType] || "medium";
  return capBand(band, maxBand);
}

// ── Duplicate penalty ─────────────────────────────────────────────────────────
// Applied in the second pass (after clustering). −10 for non-representative
// cluster members so duplicate claims from different sources don't inflate counts.

function deductDuplicatePenalty(score, item, apply) {
  if (!apply) return score;
  const cluster = item.evidence_cluster || {};
  if (cluster.is_multi_source && cluster.is_representative === false) {
    return Math.max(0, score - 10);
  }
  return score;
}

// ── Stage 6 — Scoring explanation ────────────────────────────────────────────

function buildScoringExplanation(item, source, dimensions, evidenceRole, critPath, band, finalScore) {
  const sourceType     = source.source_type || "unknown";
  const positiveSignals = [];
  const downgradeReasons = [];

  // Positive signals
  if (["primary", "curated", "high"].includes(source.trust_tier)) {
    positiveSignals.push(`credible source (${source.trust_tier})`);
  }
  if (dimensions.evidence_concreteness >= 70)         positiveSignals.push("high evidence concreteness");
  if (item.quote_verified === true)                   positiveSignals.push("quote verified");
  if ((item.numbers  || []).length > 0)               positiveSignals.push("quantitative data present");
  if ((item.entities || []).length > 0)               positiveSignals.push("named entities present");
  if (item.is_atomic === true)                        positiveSignals.push("atomic claim");
  if (item.evidence_cluster?.is_multi_source)         positiveSignals.push("multi-source corroboration");
  if (dimensions.threat_relevance     >= 70)          positiveSignals.push("high threat relevance");
  if (dimensions.operational_impact   >= 70)          positiveSignals.push("high operational impact");
  if (dimensions.horizon_significance >= 70)          positiveSignals.push("strong horizon signal");
  if (critPath.passed)                                positiveSignals.push(`criticality path: ${critPath.path}`);

  // Downgrade reasons
  if (item.evidence_confidence === "low")             downgradeReasons.push("low evidence confidence");
  if (dimensions.source_credibility < 40)             downgradeReasons.push("low source credibility");
  if (dimensions.evidence_concreteness < 40)          downgradeReasons.push("low evidence concreteness");

  const rawBand  = rawScoreToBand(finalScore);
  const maxBand  = SOURCE_TYPE_MAX_BAND[sourceType] || "medium";
  const isCapped = BAND_ORDER.indexOf(rawBand) > BAND_ORDER.indexOf(maxBand);

  let finalBandReason;
  if (band === "critical") {
    finalBandReason = `Score ${Math.round(finalScore)} + criticality path '${critPath.path}' → critical`;
  } else if (rawBand === "critical" && !critPath.passed) {
    downgradeReasons.push(`criticality gate blocked: ${critPath.reason}`);
    finalBandReason = `Score ${Math.round(finalScore)} would be critical but path blocked: ${critPath.reason}`;
  } else if (isCapped) {
    downgradeReasons.push(`${sourceType} capped at ${maxBand}`);
    finalBandReason = `Score ${Math.round(finalScore)} → ${band} (${maxBand} is max for ${sourceType})`;
  } else {
    finalBandReason = `Score ${Math.round(finalScore)} → ${band}`;
  }

  return {
    source_type:             sourceType,
    evidence_role:           evidenceRole,
    criticality_path_passed: critPath.path,
    key_positive_signals:    positiveSignals,
    downgrade_reasons:       downgradeReasons,
    final_band_reason:       finalBandReason,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score a single evidence item using source_type-aware gates and weights.
 *
 * @param {object}  item                   Evidence item from normalizeEvidenceItems
 * @param {object}  source                 Parent source (needs trust_tier, source_type, date_published, url)
 * @param {boolean} applyDuplicatePenalty  True in the second pass (after clustering)
 * @returns {object} Item with `evidence_role` and `score_data` fields added
 */
export function scoreEvidenceItem(item, source, applyDuplicatePenalty = false) {
  const rt         = source.rawfact_taxonomy || {};
  const sourceType = source.source_type || "unknown";

  // Stage 1 — Hard eligibility gates
  const gates = checkHardGates(item, source);
  if (!gates.passes) {
    return {
      ...item,
      evidence_role: "background_context",
      score_data: {
        evidence_score:      0,
        evidence_priority:   "archive_only",
        score_breakdown:     {},
        penalty_reasons:     gates.archive_reasons,
        criticality_reason:  null,
        scoring_explanation: {
          source_type:             sourceType,
          evidence_role:           "background_context",
          criticality_path_passed: null,
          key_positive_signals:    [],
          downgrade_reasons:       gates.archive_reasons,
          final_band_reason:       `Failed hard gate(s): ${gates.archive_reasons.join(", ")}`,
        },
      },
    };
  }

  // Stage 2 — Evidence role
  const evidenceRole = classifyEvidenceRole(item, source);

  // Stage 3 — Criticality path check
  const critPath = checkCriticalityPath(item, source, rt);

  // Stage 4 — Weighted scoring
  const group      = SOURCE_TYPE_GROUP[sourceType] || "unknown";
  const weights    = GROUP_WEIGHTS[group] || GROUP_WEIGHTS.unknown;
  const dimensions = computeAllDimensions(item, source, rt);
  let score        = computeWeightedScore(dimensions, weights);
  score            = deductDuplicatePenalty(score, item, applyDuplicatePenalty);
  score            = Math.max(0, Math.min(100, score));

  // Stage 5 — Band assignment (gates first, score second)
  const evidencePriority = assignBand(score, critPath.passed, sourceType);

  // Stage 6 — Scoring explanation
  const scoringExplanation = buildScoringExplanation(
    item, source, dimensions, evidenceRole, critPath, evidencePriority, score,
  );

  const duplicatePenaltyApplied =
    applyDuplicatePenalty &&
    (item.evidence_cluster?.is_multi_source && item.evidence_cluster?.is_representative === false);

  return {
    ...item,
    evidence_role: evidenceRole,
    score_data: {
      evidence_score:      Math.round(score),
      evidence_priority:   evidencePriority,
      score_breakdown:     dimensions,
      penalty_reasons:     duplicatePenaltyApplied ? ["duplicate(-10)"] : [],
      criticality_reason:  evidencePriority === "critical"
        ? `${critPath.path}: score=${Math.round(score)}, ${critPath.reason}`
        : null,
      scoring_explanation: scoringExplanation,
    },
  };
}

/**
 * Score all evidence items for a single source.
 *
 * @param {object}  source
 * @param {boolean} applyDuplicatePenalty
 * @returns {object} Source with evidence_items re-scored
 */
export function scoreSourceEvidenceItems(source, applyDuplicatePenalty = false) {
  const items = source.evidence_items || [];
  if (items.length === 0) return source;

  const scoredItems = items.map((item) => scoreEvidenceItem(item, source, applyDuplicatePenalty));

  // Source-level rawfact_score_data derived from the highest-scoring item
  const bestItem = scoredItems.reduce((best, item) => {
    const s = item.score_data?.evidence_score ?? 0;
    return s > (best?.score_data?.evidence_score ?? 0) ? item : best;
  }, scoredItems[0]);

  const rawfact_score    = bestItem?.score_data?.evidence_score ?? 0;
  const rawfact_priority = bestItem?.score_data?.evidence_priority === "critical"
    ? "must_read"
    : bestItem?.score_data?.evidence_priority ?? "archive_only";

  const rawfact_score_data = {
    rawfact_score,
    rawfact_priority,
    score_breakdown:     bestItem?.score_data?.score_breakdown || {},
    scoring_reason:      `Derived from best evidence item (${bestItem?.evidence_id || "n/a"})`,
    evidence_item_count: scoredItems.length,
    critical_count:      scoredItems.filter((i) => i.score_data?.evidence_priority === "critical").length,
    high_count:          scoredItems.filter((i) => i.score_data?.evidence_priority === "high").length,
  };

  return {
    ...source,
    evidence_items: scoredItems,
    rawfact_score_data,
    // Backward-compat alias used by the synthesis layer
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
 * Re-score after clustering, applying −10 duplicate penalty to non-representative items.
 *
 * @param {object[]} sources
 * @returns {object[]}
 */
export function rescoreWithDuplicatePenalty(sources) {
  return sources.map((s) => scoreSourceEvidenceItems(s, true));
}
