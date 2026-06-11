/**
 * Layer 7 — Claim-to-Argument-Form Selection
 *
 * Fully deterministic. Given a claim + its evidence + visualization specs,
 * picks the best slide communication form and scores candidate visuals.
 *
 * ── ARGUMENT FORMS ────────────────────────────────────────────────────────────
 *   trend_over_time          — time-series visual; requires temporal metrics
 *   ranked_comparison        — bar/matrix; requires distribution analytics
 *   before_after_capability_delta — before/after split; requires capability_delta evidence
 *   incident_timeline        — dated sequence; requires incident evidence with dates
 *   exploit_chain_diagram    — attack chain; requires multi-step evidence
 *   evidence_confidence_matrix — source type × confidence matrix
 *   taxonomy_heatmap         — heatmap by attack vector or technique
 *   ecosystem_dependency_map — dependency graph; agentic/supply-chain context
 *   case_study_card          — named incident; requires concrete case study
 *   evidence_callout         — strong single external callout; default fallback
 *   governance_implication   — action-led recommendation slide
 *   evidence_gap             — no strong claim; transparency slide only
 *
 * ── VISUAL SCORING FIELDS ─────────────────────────────────────────────────────
 *   directness_to_claim    — does the visual directly illustrate the specific claim?
 *   data_quality           — are the underlying data points reliable and non-trivial?
 *   readability            — is the visual comprehensible to a non-technical audience?
 *   novelty                — does the visual add new information beyond the bullets?
 *   executive_value        — is this visual useful for decision-makers?
 *   provenance_quality     — is the source traceable and credible?
 *   overall_visual_slide_score — weighted composite score
 *
 * ── VISUAL SUPPORT RELATIONSHIP ───────────────────────────────────────────────
 *   direct_support     — visual directly proves or illustrates the claim
 *   contextual_support — visual provides relevant background but does not prove the claim
 *   not_supporting     — visual is same category but does not help this specific claim
 */

import {
  CASE_STUDY_TYPES, TIMELINE_TYPES, EXPLOIT_TYPES, INCIDENT_TYPES,
  ADOPTION_TYPES, CAPABILITY_TYPES, VULN_TYPES, caseStudyTypeRank,
} from "../../config/evidenceTypeVocabulary.js";

// ── Evidence type signals ─────────────────────────────────────────────────────
// Token sets reconciled against the shared evidence-type vocabulary so that the
// L5A extraction spellings (incident_event, exploit_chain, …) are recognised — not
// just the slide-layer aliases (incident_report, exploit_demonstration).

const EXPLOIT_EVIDENCE_TYPES = new Set([
  ...EXPLOIT_TYPES, ...VULN_TYPES, "attack_surface_signal", ...ADOPTION_TYPES, ...INCIDENT_TYPES,
]);

const INCIDENT_EVIDENCE_TYPES = TIMELINE_TYPES;

const CAPABILITY_DELTA_TYPES = new Set([
  ...CAPABILITY_TYPES, "benchmark_result", "research_finding", "research_result",
]);

const CASE_STUDY_EVIDENCE_TYPES = CASE_STUDY_TYPES;

// Keywords signalling a multi-step attack chain
const ATTACK_CHAIN_RE = /\b(chain|stage|step|flow|inject|bypass|poison|exploit|vector|pivot|escalat|exfil|payload|rag|retrieval|jailbreak|prompt\s+injection|tool\s+call|agent|spawn|sequence|pivot)\b/i;

// Keywords signalling ecosystem / dependency context
const ECOSYSTEM_RE = /\b(dependency|supply\s*chain|package|library|plugin|extension|mcp|tool|sdk|ecosystem|integration|connector)\b/i;

// Keywords signalling comparative ranking
const RANKED_RE = /\b(most\s+common|highest|top|rank|dominant|leading|most\s+frequent|compared|proportion|distribut)\b/i;

// Keywords signalling temporal trend
const TREND_RE = /\b(over\s+time|month|quarter|year|since|trend|growth|increas|declin|trajectory|period|evolv)\b/i;

// ── Helpers ────────────────────────────────────────────────────────────────────

function evidenceTypes(evidencePackets) {
  return new Set((evidencePackets || []).map((e) => e.evidence_type).filter(Boolean));
}

function claimText(claim) {
  return [claim?.claim_text || "", claim?.claim_type || ""].join(" ").toLowerCase();
}

function hasMetricType(analyticsPackets, metricType) {
  return (analyticsPackets || []).some(
    (ap) => (ap.metric_type || ap.dimension || "").includes(metricType)
  );
}

function hasTemporalMetrics(analyticsPackets) {
  return (analyticsPackets || []).some((ap) =>
    /timeline|trend|monthly|quarterly|temporal|growth|period/i.test(ap.metric_type || ap.dimension || "")
  );
}

function hasDistributionMetrics(analyticsPackets) {
  return (analyticsPackets || []).some((ap) =>
    /distribut|frequency|rank|vector|cluster|surface|top_/i.test(ap.metric_type || ap.dimension || "")
  );
}

function hasAttackFlowSignal(evidencePackets, claim) {
  const text = [
    claim?.claim_text || "",
    ...(evidencePackets || []).map((e) => [
      e.fact || "", ...(e.attack_flow || []), ...(e.entities || []),
      ...(e.top_evidence_items || []).map((i) => i.fact || ""),
    ].join(" ")),
  ].join(" ");
  return ATTACK_CHAIN_RE.test(text);
}

function hasMinEntities(evidencePackets, min = 2) {
  const entities = new Set(
    (evidencePackets || []).flatMap((e) => [...(e.entities || []), ...(e.top_evidence_items || []).flatMap((i) => i.entities || [])])
  );
  return entities.size >= min;
}

/**
 * Returns true when any SINGLE evidence item has ≥min distinct entities.
 * Used for exploit chain detection to avoid false positives from multiple
 * separate incidents each contributing different actors.
 */
function hasMinEntitiesInSingleItem(evidencePackets, min = 3) {
  return (evidencePackets || []).some((e) => {
    const entities = new Set([
      ...(e.entities || []),
      ...(e.top_evidence_items || []).flatMap((i) => i.entities || []),
    ]);
    return entities.size >= min;
  });
}

function hasDatedIncidents(evidencePackets) {
  return (evidencePackets || []).some((e) =>
    (INCIDENT_EVIDENCE_TYPES.has(e.evidence_type)) &&
    (e.source_date || e.published_date || e.date)
  );
}

function hasConcreteCaseStudy(evidencePackets) {
  return (evidencePackets || []).some((e) =>
    CASE_STUDY_EVIDENCE_TYPES.has(e.evidence_type) &&
    (e.entities || []).length >= 1 &&
    (e.fact || e.display_label || "").length > 20
  );
}

/**
 * Count weak, mixed, strong evidence items to detect whether the mix warrants
 * a confidence matrix over a single callout.
 */
function evidenceConfidenceMix(evidencePackets) {
  const strong  = (evidencePackets || []).filter((e) => /strong|high/i.test(e.confidence || e.evidence_strength || "")).length;
  const weak    = (evidencePackets || []).filter((e) => /weak|low|context_only/i.test(e.confidence || e.evidence_strength || e.claim_relevance?.admissibility || "")).length;
  return { strong, weak, total: (evidencePackets || []).length };
}

// ── Argument form selection ────────────────────────────────────────────────────

/**
 * Select the best argument form for a claim.
 *
 * @param {object}   claim             - Claim object with claim_type, claim_text, etc.
 * @param {object[]} evidencePackets   - Pre-selected supporting evidence for this claim
 * @param {object[]} analyticsPackets  - Analytics evidence packets for this category
 * @param {object[]} visualRefs        - Available visualization specs (from L5B/L5C)
 * @returns {string} One of the 12 argument form strings
 */
export function selectSlideArgumentForm(claim, evidencePackets = [], analyticsPackets = [], visualRefs = []) {
  const ct     = claimText(claim);
  const evTypes = evidenceTypes(evidencePackets);
  const priority = claim?.claim_priority || "medium";
  const claimType = claim?.claim_type || "";

  // Explicit claim types drive form selection first
  if (claimType === "recommendation")         return "governance_implication";
  if (claimType === "evidence_gap")           return "evidence_gap";

  // No strong evidence → gap transparency
  const { strong, weak, total } = evidenceConfidenceMix(evidencePackets);
  if (total === 0 || (priority === "medium" && strong === 0 && weak === 0))  return "evidence_gap";
  if (priority === "medium" && strong === 0 && total <= 2)                   return "evidence_gap";

  // Trend_claim type + temporal metrics
  if (claimType === "trend_claim" || TREND_RE.test(ct)) {
    if (hasTemporalMetrics(analyticsPackets)) return "trend_over_time";
  }

  // Exploit chain: requires explicit multi-step attack_flow array OR 3+ entities in ONE item
  // A generic "bypass" keyword across separate incidents does NOT qualify — we need a structured chain
  const hasExplicitChain = (evidencePackets || []).some(
    (e) => (e.attack_flow || []).length >= 2
  );
  if ((hasExplicitChain || hasMinEntitiesInSingleItem(evidencePackets, 3)) &&
      hasAttackFlowSignal(evidencePackets, claim) &&
      [...evTypes].some((t) => EXPLOIT_EVIDENCE_TYPES.has(t))) {
    return "exploit_chain_diagram";
  }

  // Incident timeline: dated incidents with actor/victim entities (no explicit chain steps required)
  if (hasDatedIncidents(evidencePackets) &&
      [...evTypes].some((t) => INCIDENT_EVIDENCE_TYPES.has(t)) &&
      hasMinEntities(evidencePackets, 2)) {
    return "incident_timeline";
  }

  // Before/after: capability delta evidence
  if ([...evTypes].some((t) => CAPABILITY_DELTA_TYPES.has(t)) &&
      /before|after|delta|comparison|improved|increased|changed|prior|new\s+capability|measur/i.test(ct)) {
    return "before_after_capability_delta";
  }

  // Ranked comparison: distribution analytics + ranking language in claim
  if (RANKED_RE.test(ct) && hasDistributionMetrics(analyticsPackets)) {
    return "ranked_comparison";
  }

  // Trend over time (fallback without strong analytics — claim text is sufficient signal)
  if (claimType === "trend_claim") return "trend_over_time";

  // Taxonomy heatmap: distribution analytics + attack vector / technique focus
  if (hasMetricType(analyticsPackets, "vector") || hasMetricType(analyticsPackets, "attack_surface")) {
    if (/attack\s+vector|technique|tactic|mitre|owasp|taxonomy|heatmap/i.test(ct)) {
      return "taxonomy_heatmap";
    }
  }

  // Ecosystem dependency: supply-chain / tool-call / MCP context
  if (ECOSYSTEM_RE.test(ct) && hasMinEntities(evidencePackets, 2)) {
    return "ecosystem_dependency_map";
  }

  // Case study card: named concrete incident with sufficient entity richness
  if (hasConcreteCaseStudy(evidencePackets)) return "case_study_card";

  // Evidence confidence matrix: mixed evidence (some strong, some weak)
  if (total >= 3 && strong >= 1 && weak >= 1) return "evidence_confidence_matrix";

  // Evidence callout: fallback — strong single point with direct provenance
  if (strong >= 1) return "evidence_callout";

  // Last resort gap
  return "evidence_gap";
}

// ── Visual support relationship ────────────────────────────────────────────────

/**
 * Classify whether a visualization supports a specific claim.
 *
 * direct_support     → visual directly proves or quantifies the claim
 * contextual_support → visual is related but does not directly prove it
 * not_supporting     → visual is same category but irrelevant to this claim
 *
 * @param {object} vizSpec    - Visualization spec object (from L5B/L5C)
 * @param {object} claim      - Claim being supported
 * @param {string} argForm    - Selected argument form
 * @returns {"direct_support"|"contextual_support"|"not_supporting"}
 */
export function classifyVisualSupportRelationship(vizSpec, claim, argForm) {
  if (!vizSpec || !claim) return "not_supporting";

  const vizTitle = (vizSpec.title || "").toLowerCase();
  const vizType  = (vizSpec.chart_type || vizSpec.visualization_type || "").toLowerCase();
  const vizCat   = (vizSpec.category || "").toLowerCase();
  const claimCat = (claim.category || "").toLowerCase();
  const ct       = claimText(claim);

  // Category mismatch → likely contextual at best
  const catMatch = !vizCat || !claimCat || vizCat === claimCat || vizCat === "cross_category";

  // Form-to-chart-type alignment
  const FORM_CHART_DIRECT = {
    trend_over_time:               /timeline|trend|monthly|time.series/i,
    ranked_comparison:             /bar|distribution|rank|frequency|heatmap/i,
    before_after_capability_delta: /comparison|before.after|delta|bar/i,
    incident_timeline:             /timeline|sequence|incident/i,
    exploit_chain_diagram:         /flow|chain|diagram|sequence|graph/i,
    taxonomy_heatmap:              /heatmap|matrix|distribution|vector/i,
    ecosystem_dependency_map:      /graph|network|dependency|map/i,
    case_study_card:               /timeline|sequence|incident|case/i,
    evidence_callout:              /.*/,
    evidence_confidence_matrix:    /matrix|scatter|heatmap/i,
    governance_implication:        /bar|matrix|priorit/i,
    evidence_gap:                  /.*/,
  };

  const directPattern = FORM_CHART_DIRECT[argForm];
  const chartTypeMatches = directPattern ? directPattern.test(vizType) : false;

  // Keyword overlap: title of viz should overlap with claim key terms
  const claimKeywords = ct.split(/\s+/)
    .filter((w) => w.length > 5)
    .slice(0, 8);
  const keywordOverlap = claimKeywords.some((kw) => vizTitle.includes(kw));

  if (catMatch && chartTypeMatches && keywordOverlap) return "direct_support";
  if (catMatch && (chartTypeMatches || keywordOverlap))  return "contextual_support";
  if (catMatch)                                          return "contextual_support";
  return "not_supporting";
}

// ── Visual scoring ─────────────────────────────────────────────────────────────

const WEIGHTS = {
  directness_to_claim: 0.30,
  data_quality:        0.20,
  readability:         0.15,
  novelty:             0.15,
  executive_value:     0.10,
  provenance_quality:  0.10,
};

/**
 * Score a single candidate visual for use on a specific claim slide.
 *
 * @param {object} vizSpec  - Visualization spec (L5B/L5C)
 * @param {object} claim    - Claim being supported
 * @param {string} argForm  - Argument form selected for this claim
 * @param {string} relationship - visual_support_relationship (from classifyVisualSupportRelationship)
 * @returns {object} Visual score object
 */
export function scoreVisualForClaim(vizSpec, claim, argForm, relationship) {
  const isExternal   = (vizSpec.source || "") === "external_web";
  const isAnalytics  = !isExternal;
  const slideUsable  = vizSpec.slide_usable !== false;
  const noReview     = !vizSpec.needs_manual_review;

  // not_supporting visuals should never appear on any claim slide: score = 0 immediately
  if (relationship === "not_supporting") {
    return {
      visualization_id:            vizSpec.visualization_id,
      visual_support_relationship: "not_supporting",
      directness_to_claim:         0,
      data_quality:                0,
      readability:                 0,
      novelty:                     0,
      executive_value:             0,
      provenance_quality:          0,
      overall_visual_slide_score:  0,
    };
  }

  // directness_to_claim: 1.0 for direct, 0.4 for contextual
  const directness =
    relationship === "direct_support" ? 1.0 : 0.4;

  // data_quality: analytics charts have known computation; external may be mixed
  let data_quality = 0.5;
  if (isAnalytics) {
    // Penalise if many unknown entries
    const topEntries = vizSpec.top_entries || vizSpec.chart_data?.entries || [];
    const unknownPct = topEntries.length > 0
      ? topEntries.filter((e) => /unknown/i.test(e.key || "")).length / topEntries.length
      : 0.5;
    data_quality = Math.max(0.1, 1.0 - unknownPct);
  } else {
    // External: quality based on freshness_status and source_quality
    const fresh   = /fresh|recent/i.test(vizSpec.freshness_status || "") ? 0.2 : 0.0;
    const quality = /strong|high/i.test(vizSpec.source_quality || "") ? 0.4 :
                    /mixed/i.test(vizSpec.source_quality || "") ? 0.2 : 0.0;
    data_quality = 0.4 + fresh + quality;
  }

  // readability: simple bar/line charts are high; complex heatmaps medium; network graphs lower
  const chartType = (vizSpec.chart_type || "").toLowerCase();
  const readability =
    /bar|line|pie|donut/i.test(chartType) ? 0.9 :
    /scatter|bubble/i.test(chartType)     ? 0.7 :
    /heatmap|matrix/i.test(chartType)     ? 0.6 :
    /graph|network|flow/i.test(chartType) ? 0.5 : 0.7;

  // novelty: does the visual add data beyond the bullets?
  const novelty = directness > 0.5 ? 0.8 : 0.4;

  // executive_value: direct claim visuals are high; time-series and bar for executives
  const executive_value =
    directness === 1.0 && /bar|line|pie/i.test(chartType) ? 0.9 :
    directness === 1.0                                     ? 0.7 :
    directness > 0                                         ? 0.5 : 0.2;

  // provenance_quality: analytics charts (our own pipeline) = high; external with URL = medium
  const provenance_quality =
    isAnalytics && vizSpec.analytics_id ? 0.9 :
    isExternal && vizSpec.source_url    ? 0.7 :
    isExternal                          ? 0.4 : 0.6;

  // Penalise unusable visuals entirely
  const usabilityMultiplier = (slideUsable && noReview) ? 1.0 : 0.0;

  const raw = (
    WEIGHTS.directness_to_claim * directness      +
    WEIGHTS.data_quality        * data_quality     +
    WEIGHTS.readability         * readability      +
    WEIGHTS.novelty             * novelty          +
    WEIGHTS.executive_value     * executive_value  +
    WEIGHTS.provenance_quality  * provenance_quality
  );

  const overall_visual_slide_score = Math.round(raw * usabilityMultiplier * 100) / 100;

  return {
    visualization_id:           vizSpec.visualization_id,
    visual_support_relationship: relationship,
    directness_to_claim:        Math.round(directness * 100) / 100,
    data_quality:               Math.round(data_quality * 100) / 100,
    readability:                Math.round(readability * 100) / 100,
    novelty:                    Math.round(novelty * 100) / 100,
    executive_value:            Math.round(executive_value * 100) / 100,
    provenance_quality:         Math.round(provenance_quality * 100) / 100,
    overall_visual_slide_score,
  };
}

// ── Slide usefulness scoring ──────────────────────────────────────────────────

/**
 * Score a claim's overall usefulness as a full slide.
 * Low-scoring claims get downsized (no full slides) unless they fill a gap.
 *
 * @param {object}   claim           - Claim object
 * @param {object[]} evidencePackets - Supporting evidence
 * @param {object[]} analyticsPackets
 * @param {object[]} visualRefs
 * @returns {object} Usefulness score breakdown
 */
export function scoreClaimSlideUsefulness(claim, evidencePackets = [], analyticsPackets = [], visualRefs = []) {
  const priority = claim?.claim_priority || "medium";
  const ct = claimText(claim);

  // strategic_importance: priority-driven
  const strategic_importance =
    priority === "critical" ? 1.0 :
    priority === "high"     ? 0.75 :
    priority === "medium"   ? 0.40 : 0.10;

  // evidence_strength: % of evidence that is strong
  const { strong, total } = evidenceConfidenceMix(evidencePackets);
  const evidence_strength = total > 0 ? strong / total : 0;

  // source_diversity: number of unique publishers / source types
  const publishers = new Set((evidencePackets || []).map((e) => e.publisher).filter(Boolean));
  const source_diversity = publishers.size >= 3 ? 1.0 : publishers.size >= 2 ? 0.7 : publishers.size >= 1 ? 0.4 : 0.0;

  // metric_support: does any analytics packet directly back the claim?
  const metric_support = analyticsPackets.length > 0 ? 0.8 : 0.2;

  // visual_support: best direct visual score
  const argForm = selectSlideArgumentForm(claim, evidencePackets, analyticsPackets, visualRefs);
  const visualScores = (visualRefs || []).map((v) => {
    const rel = classifyVisualSupportRelationship(v, claim, argForm);
    return scoreVisualForClaim(v, claim, argForm, rel);
  });
  const bestVisual = visualScores.reduce((best, s) => s.overall_visual_slide_score > best ? s.overall_visual_slide_score : best, 0);
  const visual_support = bestVisual;

  // novelty: does claim_text mention concrete entities or specific techniques?
  const hasConcreteTerms = /cve|lpe|rag|mcp|tool.call|deepfake|jailbreak|exfil|specific\s+model|\d{3,}|named/i.test(ct);
  const novelty = hasConcreteTerms ? 0.8 : 0.4;

  // audience_relevance: critical/high priority claims are always relevant to executives
  const audience_relevance = strategic_importance;

  const overall_claim_slide_score = Math.round((
    strategic_importance * 0.30 +
    evidence_strength    * 0.25 +
    source_diversity     * 0.15 +
    metric_support       * 0.10 +
    visual_support       * 0.10 +
    novelty              * 0.05 +
    audience_relevance   * 0.05
  ) * 100) / 100;

  return {
    claim_id:             claim?.claim_id || null,
    argument_form:        argForm,
    strategic_importance: Math.round(strategic_importance * 100) / 100,
    evidence_strength:    Math.round(evidence_strength    * 100) / 100,
    source_diversity:     Math.round(source_diversity     * 100) / 100,
    metric_support:       Math.round(metric_support       * 100) / 100,
    visual_support:       Math.round(visual_support       * 100) / 100,
    novelty:              Math.round(novelty              * 100) / 100,
    audience_relevance:   Math.round(audience_relevance   * 100) / 100,
    overall_claim_slide_score,
    // A slide should be created unless score is very low and it's not a gap
    should_create_full_slide: overall_claim_slide_score >= 0.25 || argForm === "evidence_gap",
  };
}

// ── Case study gating (deterministic hard gate) ─────────────────────────────

const CASE_STUDY_EVIDENCE_REQUIRED_TYPES = new Set([
  ...CASE_STUDY_TYPES, ...VULN_TYPES,
]);

const WEAK_CONFIDENCE = new Set(["low", "context_only", "weak"]);

/**
 * Filter case studies through a deterministic hard gate before LLM selection.
 *
 * Gate rules:
 * 1. Must have a claim-eligible evidence type
 * 2. Must have ≥1 named entity (concrete incident)
 * 3. Must not be "context_only" or low confidence
 * 4. Must have a non-trivial fact (>30 chars)
 * 5. Must be linked to a critical or high claim
 *
 * @param {object[]} caseStudies   - Raw case study candidates
 * @param {object[]} criticalClaims - Active critical/high claims
 * @returns {object[]} Gated case study pool (sorted by quality proxy)
 */
export function gateCaseStudyCandidates(caseStudies, criticalClaims) {
  const criticalClaimIds = new Set(criticalClaims.map((c) => c.claim_id));
  const criticalEvidenceIds = new Set(criticalClaims.flatMap((c) => c.supporting_evidence_ids || []));

  const gated = (caseStudies || []).filter((cs) => {
    // Must be linked to a critical/high claim
    const linkedToCritical =
      criticalClaimIds.has(cs.claim_id) ||
      criticalEvidenceIds.has(cs.evidence_id);
    if (!linkedToCritical) return false;

    // Must be a claim-eligible evidence type
    if (!CASE_STUDY_EVIDENCE_REQUIRED_TYPES.has(cs.evidence_type || "")) return false;

    // Must have at least one named entity
    if ((cs.entities || []).length === 0) return false;

    // Must not be weak/context-only
    const conf = cs.confidence || cs.evidence_strength || "";
    if (WEAK_CONFIDENCE.has(conf)) return false;

    // Must have a meaningful fact
    const fact = cs.fact || cs.display_label || cs.key_facts?.[0] || "";
    if (fact.length < 30) return false;

    return true;
  });

  // Sort by quality proxy: prefer operational > capability > research.
  // Uses the shared vocabulary rank so L5A spellings (incident_event, exploit_chain)
  // rank identically to the slide-layer aliases.
  return gated.sort((a, b) =>
    caseStudyTypeRank(b.evidence_type) - caseStudyTypeRank(a.evidence_type) ||
    (b.entities?.length || 0) - (a.entities?.length || 0)
  );
}

/**
 * Deterministic QA validation for a selected case study.
 * Called after LLM selection to prevent hallucinated picks.
 *
 * @param {object}   caseStudy       - Case study selected (by LLM or deterministic)
 * @param {object[]} gatedPool       - Pool returned by gateCaseStudyCandidates()
 * @param {object}   claim           - The claim this case study illustrates
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateSelectedCaseStudy(caseStudy, gatedPool, claim) {
  if (!caseStudy) return { valid: false, reason: "no_case_study_provided" };

  // Must be in the gated pool
  const inPool = (gatedPool || []).some(
    (cs) => cs.evidence_id === caseStudy.evidence_id
  );
  if (!inPool) return { valid: false, reason: "case_study_not_in_gated_pool" };

  // Must be non-redundant with claim_text (entities must add something)
  const entities = caseStudy.entities || [];
  if (entities.length === 0) return { valid: false, reason: "case_study_has_no_entities" };

  // Must have claim linkage
  const claimIds = new Set([claim?.claim_id].filter(Boolean));
  const claimEvidenceIds = new Set(claim?.supporting_evidence_ids || []);
  const isLinked =
    claimIds.has(caseStudy.claim_id) ||
    claimEvidenceIds.has(caseStudy.evidence_id);
  if (!isLinked) return { valid: false, reason: "case_study_not_linked_to_claim" };

  return { valid: true };
}
