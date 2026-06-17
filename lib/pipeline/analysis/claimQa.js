/**
 * Claim Support Gate — validates every LLM-produced claim before slide planning.
 *
 * Deterministic gating of analytical claims against evidence packets and corpus
 * audit. Every claim must pass before it can reach slide generation.
 *
 * ── claim_support_status VALUES ──────────────────────────────────────────────
 *   supported              — evidence clearly supports the claim type
 *   partially_supported    — evidence exists but has limitations; allowed with caveats
 *   unsupported            — required evidence is absent
 *   overgeneralized        — claim scope exceeds what evidence permits
 *   contradicted           — evidence contains conflicting_evidence limitation
 *   blocked_by_corpus_audit — claim type is in corpus_audit.blocked_claim_types[]
 *   exceeds_confidence_ceiling — claim.confidence is higher than the candidate
 *                               judgment ceiling from the analytical state
 *
 * ── allowed_to_proceed RULES ─────────────────────────────────────────────────
 *   true  — supported, partially_supported (caveats appended)
 *   false — unsupported, contradicted, blocked_by_corpus_audit,
 *            exceeds_confidence_ceiling, overgeneralized
 *
 * ── CLAIM TYPE VOCABULARY ────────────────────────────────────────────────────
 *   Primary:   factual, case_study, capability, adoption, trend_over_time,
 *              emerging_signal, outlook, recommendation, strategic_assessment
 *   Secondary attributes (detected from claim text):
 *     real_world_use   — "real-world", "in the wild", "deployed", "observed"
 *     lab_only         — "lab", "research", "PoC", "paper"
 *     forward_looking  — "will", "may", "could", "expected"
 *     market_wide      — "widespread", "industry-wide", "market"
 *     vendor_claim     — vendor name in text AND vendor_interested source
 */

// ── Permitted evidence types per claim type ───────────────────────────────────

const FACT_SUPPORT_TYPES = new Set([
  "incident", "vulnerability", "exploit_disclosure", "threat_intelligence",
  "adversary_adoption_signal",
]);

const ADOPTION_SUPPORT_TYPES = new Set([
  "adversary_adoption_signal", "incident", "threat_intelligence",
]);

const CAPABILITY_TYPES = new Set([
  "research_finding", "capability_demonstration", "benchmark_evaluation",
  "benchmark_result", "research_result",
]);

// ── Claim-type normalization ──────────────────────────────────────────────────
//
// Design principle: deterministic code maps STRUCTURAL labels; LLM-assigned
// fields (source_judgment_type, judgment_flags) determine semantic routing.
// Regex text-scanning is a legacy fallback for claims that predate the new
// synthesis schema — not the primary routing mechanism.
//
// Primary routing: source_judgment_type (set by analyzeCategory.buildClaimChainView
// from the synthesis LLM's judgment_type enum) → structural map below.
// Fallback: text regex (for claims without source_judgment_type — legacy items).

// Structural map from synthesis judgment_type → QA gate type.
// judgment_type is an enum produced by the synthesis LLM and is authoritative.
const JUDGMENT_TYPE_TO_QA_TYPE = {
  adversary_adoption:   "adoption",
  operational_shift:    "factual",
  capability_change:    "capability",
  technique_evolution:  "capability",
  risk_elevation:       "strategic_assessment",
  ecosystem_change:     "strategic_assessment",
  early_signal:         "emerging_signal",
  monitoring_required:  "recommendation",
};

// Legacy regex fallback — only used when source_judgment_type is absent.
// These patterns existed when claim type was re-inferred from text; preserved
// for backward compatibility with old claim objects only.
const ADOPTION_LANG    = /\b(adopt(ed|ion|ing)?|in the wild|real[- ]world use|used by (attackers|adversaries|threat actors)|deployed by (attackers|adversaries))\b/i;
const TREND_LANG       = /\b(trend|increasingly|growing|rising|surge|surging|proliferat|more frequent|on the rise|escalating|widespread|accelerating|spike)\b/i;
const OPERATIONAL_LANG = /\b(actively exploited|exploited in the wild|in production attacks|ransomware campaign|breach(ed)? (a|the|an|in)|compromised (a|the|an|in)|operational(ly)? deployed)\b/i;

export { ADOPTION_LANG, TREND_LANG, OPERATIONAL_LANG };

const QA_NATIVE_TYPES = new Set([
  "factual", "trend", "trend_over_time", "adoption", "capability", "comparison",
  "recommendation", "outlook", "case_study", "strategic_assessment", "insight",
  "emerging_signal",
]);

// Claim types the gate handles EXPLICITLY (i.e. not via the strategic_assessment
// default). The contract test asserts every claim_type the claim chain mints maps
// into this set — so a rename can never silently route a claim to the weak default.
export const QA_EXPLICIT_GATE_TYPES = new Set([
  "factual", "case_study", "trend", "trend_over_time", "comparison", "adoption",
  "capability", "outlook", "recommendation", "insight", "emerging_signal",
]);

export function normalizeClaimType(claim) {
  const explicit = claim.claim_type || "";

  // 1. Structural mappings — no text scanning
  if (explicit === "trend_claim") return "trend_over_time";
  if (explicit === "trend")       return "trend_over_time";

  // 2. Use LLM-assigned source_judgment_type when available (primary path).
  //    This preserves the synthesis LLM's semantic intent without re-parsing text.
  if (claim.source_judgment_type && JUDGMENT_TYPE_TO_QA_TYPE[claim.source_judgment_type]) {
    return JUDGMENT_TYPE_TO_QA_TYPE[claim.source_judgment_type];
  }

  if (explicit === "category_insight") {
    // source_judgment_type not set: legacy fallback using judgment_flags if present.
    const flags = claim.judgment_flags || {};
    if (Object.keys(flags).length > 0) {
      if (flags.implies_adoption)    return "adoption";
      if (flags.implies_operational) return "factual";
      if (flags.implies_trend)       return "trend_over_time";
      if (flags.is_lab_only)         return "capability";
      return "insight";
    }
    // Last resort: legacy text regex (for claims with no LLM-assigned routing).
    // This path will be removed once all claim objects carry source_judgment_type.
    const text = claim.claim_text || claim.text || claim.insight || "";
    if (ADOPTION_LANG.test(text))    return "adoption";
    if (OPERATIONAL_LANG.test(text)) return "factual";
    if (TREND_LANG.test(text))       return "trend_over_time";
    return "insight";
  }

  if (QA_NATIVE_TYPES.has(explicit)) return explicit;

  // Unlabeled: use judgment_flags if set; otherwise structural guess from text.
  const flags = claim.judgment_flags || {};
  if (Object.keys(flags).length > 0) {
    if (flags.implies_adoption)    return "adoption";
    if (flags.implies_operational) return "factual";
    if (flags.implies_trend)       return "trend_over_time";
    if (flags.is_lab_only)         return "capability";
    if (flags.is_forward_looking)  return "outlook";
  }
  const text = claim.claim_text || claim.text || claim.insight || "";
  if (ADOPTION_LANG.test(text))    return "adoption";
  if (OPERATIONAL_LANG.test(text)) return "factual";
  if (TREND_LANG.test(text))       return "trend_over_time";
  return "strategic_assessment";
}

// ── Secondary attribute detection ─────────────────────────────────────────────
//
// Design principle: secondary attributes should be LLM-assigned in the synthesis
// schema (secondary_attributes[] on each judgment) rather than re-detected from
// claim text by regex. Text regex is a legacy fallback only.
//
// When a claim carries claim.secondary_attributes (from the synthesis LLM) or
// claim.judgment_flags, those values are authoritative. Regex scanning runs only
// for claims without these LLM-assigned fields.

// Legacy regex patterns — preserved for fallback path only.
const REAL_WORLD_PATTERNS  = /\b(real[- ]world|in the wild|deployed|observed in (?:production|attacks|the wild))\b/i;
const LAB_ONLY_PATTERNS    = /\b(lab(?:oratory)?|research|PoC|proof[- ]of[- ]concept|paper|academic study)\b/i;
const FORWARD_LOOKING      = /\b(will|may|could|expected to|is likely to|projected|anticipated)\b/i;
const MARKET_WIDE_PATTERNS = /\b(widespread|industry[- ]wide|market[- ]wide|across the (?:industry|market|sector)|broadly adopted)\b/i;

export { REAL_WORLD_PATTERNS, LAB_ONLY_PATTERNS, FORWARD_LOOKING, MARKET_WIDE_PATTERNS };

// vendor_claim detection is always structural (evidence-level), not text regex.
function detectVendorClaim(evidencePackets, text) {
  const hasVendorInterestedSource = (evidencePackets || []).some(
    (ep) => ep.independence_level === "vendor_interested" ||
             ep.triage_data?.independence_level === "vendor_interested"
  );
  return hasVendorInterestedSource && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text);
}

/**
 * Detect secondary attributes for a claim.
 *
 * Priority:
 *   1. claim.secondary_attributes (LLM-assigned in synthesis schema) — authoritative
 *   2. claim.judgment_flags (LLM-assigned flags) — derived mapping
 *   3. Text regex scan — legacy fallback for claims without LLM-assigned fields
 *
 * vendor_claim is always added structurally (evidence-level), regardless of source.
 *
 * @param {string}   claimText
 * @param {object[]} evidencePackets
 * @param {object}   [claim]  The full claim object (for LLM-assigned fields)
 */
export function detectSecondaryAttributes(claimText, evidencePackets, claim) {
  const vendorClaim = detectVendorClaim(evidencePackets, claimText || "");

  // Path 1: LLM-assigned secondary_attributes (most authoritative)
  if (Array.isArray(claim?.secondary_attributes) && claim.secondary_attributes.length > 0) {
    const attrs = new Set(claim.secondary_attributes);
    if (vendorClaim) attrs.add("vendor_claim");
    return attrs;
  }

  // Path 2: derive from judgment_flags (LLM-assigned, structural)
  const flags = claim?.judgment_flags;
  if (flags && Object.keys(flags).length > 0) {
    const attrs = new Set();
    if (flags.implies_adoption && !flags.is_lab_only) attrs.add("real_world_use");
    if (flags.is_lab_only)       attrs.add("lab_only");
    if (flags.is_forward_looking) attrs.add("forward_looking");
    if (flags.is_market_wide)    attrs.add("market_wide");
    if (vendorClaim)             attrs.add("vendor_claim");
    return attrs;
  }

  // Path 3: legacy regex scan (claims without LLM-assigned fields)
  const attrs = new Set();
  const text = claimText || "";
  if (REAL_WORLD_PATTERNS.test(text))  attrs.add("real_world_use");
  if (LAB_ONLY_PATTERNS.test(text))    attrs.add("lab_only");
  if (FORWARD_LOOKING.test(text))      attrs.add("forward_looking");
  if (MARKET_WIDE_PATTERNS.test(text)) attrs.add("market_wide");
  if (vendorClaim)                     attrs.add("vendor_claim");
  return attrs;
}

// A general analytical insight: needs at least one admissible (strong/usable)
// packet to be "supported"; context-only backing proceeds but is flagged; no
// admissible evidence at all → blocked. Not subject to the vendor_heavy
// strategic-assessment block (insights are narrower than strategic assessments).
function qaInsightClaim(admissible, context) {
  if (admissible.length >= 1) return { status: "supported", reasons: [] };
  if (context.length >= 1) {
    return { status: "partially_supported", reasons: ["Insight backed only by context-level evidence"] };
  }
  return { status: "unsupported", reasons: ["No admissible or context evidence for insight"] };
}

// ── Helper functions ──────────────────────────────────────────────────────────
//
// Dossier evidence packets carry their triage verdict under `triage_data`
// (evidence_strength / admissibility / permitted_uses / observed_use /
// limitations). Earlier this module read those fields at the TOP level, where
// they do not exist on assembled-pack items, so the admissible set was always
// empty and every gate silently degraded. These accessors read triage_data
// first and fall back to any top-level field for other packet shapes.

function packetStrength(ep) {
  return ep?.triage_data?.evidence_strength || ep?.evidence_strength || null;
}
function packetAdmissibility(ep) {
  return ep?.triage_data?.admissibility || ep?.admissibility || null;
}
function packetPermittedUses(ep) {
  return ep?.triage_data?.permitted_uses || ep?.permitted_uses || [];
}
function packetLimitations(ep) {
  return ep?.triage_data?.limitations || ep?.limitations || [];
}

function getAdmissiblePackets(evidencePackets) {
  return (evidencePackets || []).filter((ep) => {
    const s = packetStrength(ep);
    if (s === "strong" || s === "usable") return true;
    const a = packetAdmissibility(ep);
    return a === "passed" || a === "strong" || a === "usable";
  });
}

function getContextPackets(evidencePackets) {
  return (evidencePackets || []).filter((ep) => {
    if (packetStrength(ep) === "context") return true;
    const a = packetAdmissibility(ep);
    return a === "context_only" || a === "partially_supported";
  });
}

function countIndependentOrigins(packets) {
  const origins = new Set();
  for (const ep of (packets || [])) {
    // Circular reporting (3+ outlets all citing one original) is not independent
    // corroboration — exclude it from the count entirely.
    const indep = ep.independence_level || ep.triage_data?.independence_level;
    if (indep === "circular_reporting_risk") continue;
    // Group by the ORIGINATING report when known, so many outlets re-reporting one
    // primary source count once — not once per re-publisher.
    const key = ep.primary_origin_url || ep.publisher || ep.source_publisher || ep.origin_publisher;
    if (key && key !== "unknown") origins.add(key);
  }
  return origins.size;
}

function countTimeWindows(packets) {
  const windows = new Set(
    packets
      .map((ep) => {
        const d = ep.date_published || ep.published_date || ep.date;
        return d ? d.slice(0, 7) : null; // YYYY-MM
      })
      .filter(Boolean)
  );
  return windows.size;
}

function hasConflictingEvidence(packets) {
  return packets.some((ep) =>
    packetLimitations(ep).some((l) =>
      typeof l === "string" && l.toLowerCase().includes("conflicting_evidence")
    ) ||
    ep.conflicting_evidence === true
  );
}

function hasObservedUse(packets) {
  return packets.some((ep) =>
    ep.observed_use === true ||
    ep.triage_data?.observed_use === true ||
    ep.observed_in_wild === true ||
    packetPermittedUses(ep).includes("adoption_support")
  );
}

function hasNamedEntity(packets) {
  return packets.some((ep) => {
    const entities = ep.key_entities || ep.entities || [];
    return entities.length > 0 && entities.some((e) => typeof e === "string" && e.length > 2);
  });
}

// ── Claim type gating rules ───────────────────────────────────────────────────

function qaFactualClaim(admissible, corpusAudit) {
  const factPackets = admissible.filter((ep) =>
    FACT_SUPPORT_TYPES.has(ep.evidence_type || ep.source_type || "")
  );

  if (corpusAudit?.evidence_gap_flags?.includes("operational_evidence_sparse")) {
    return {
      status: "unsupported",
      reasons: ["operational_evidence_sparse — no confirmed real-world evidence"],
    };
  }

  if (factPackets.length >= 1) {
    return { status: "supported", reasons: [] };
  }

  if (admissible.length >= 1) {
    return { status: "partially_supported", reasons: ["No primary operational source type; using adjacent evidence"] };
  }

  return { status: "unsupported", reasons: ["No admissible evidence packets for factual claim"] };
}

function qaCaseStudyClaim(admissible) {
  const concretePackets = admissible.filter((ep) => hasNamedEntity([ep]));
  if (concretePackets.length >= 1) {
    return { status: "supported", reasons: [] };
  }
  if (admissible.length >= 1) {
    return { status: "partially_supported", reasons: ["No named entities in evidence; case study lacks specificity"] };
  }
  return { status: "unsupported", reasons: ["No admissible evidence with named entities"] };
}

function qaTrendClaim(admissible, corpusAudit) {
  // trend_over_time requires ≥3 items from ≥2 independent origins across ≥2 distinct time windows
  if (corpusAudit?.source_concentration_flags?.some((f) => f.startsWith("single_publisher_dominance"))) {
    return {
      status: "overgeneralized",
      reasons: ["single_publisher_dominance — trend cannot be established from one publisher"],
    };
  }

  if (admissible.length < 3) {
    return {
      status: "overgeneralized",
      reasons: [`trend_over_time requires ≥3 items from ≥2 independent origins across ≥2 distinct time windows; found ${admissible.length} item(s)`],
    };
  }

  // Phase 4B: duplicate_reporting items should not count as independent events
  const nonDuplicateAdmissible = admissible.filter((ep) => ep.duplicate_reporting !== true);
  if (nonDuplicateAdmissible.length < 3) {
    return {
      status: "overgeneralized",
      blocking_reason: "trend_based_on_duplicate_reporting",
      reasons: [`trend_over_time requires ≥3 independent events; found only ${nonDuplicateAdmissible.length} non-duplicate item(s) — the remainder are duplicate reporting of the same event`],
    };
  }

  const independentOrigins = countIndependentOrigins(admissible);
  if (independentOrigins < 2) {
    return {
      status: "overgeneralized",
      reasons: ["trend_over_time requires ≥2 independent origins; sources appear to derive from a single origin"],
    };
  }

  const timeWindows = countTimeWindows(admissible);
  if (timeWindows < 2) {
    return {
      status: "overgeneralized",
      reasons: ["trend_over_time requires evidence from ≥2 distinct time windows; all evidence is from the same period"],
    };
  }

  return { status: "supported", reasons: [] };
}

// emerging_signal: requires recent evidence (within 90 days) AND not labeled as confirmed trend
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function qaEmergingSignalClaim(admissible, allPackets) {
  const now = Date.now();
  const recentPackets = [...admissible, ...allPackets].filter((ep) => {
    const d = ep.date_published || ep.published_date || ep.date;
    if (!d) return false;
    const t = new Date(d).getTime();
    return !isNaN(t) && (now - t) <= NINETY_DAYS_MS;
  });

  if (recentPackets.length === 0) {
    return {
      status: "unsupported",
      reasons: ["emerging_signal requires at least one item within the last 90 days; none found"],
    };
  }

  // Allowed with caveat — emerging signals are not confirmed trends
  return {
    status: "supported",
    reasons: ["emerging_signal: not a confirmed trend — may not persist; label as early/preliminary finding"],
  };
}

function qaAdoptionClaim(admissible, allPackets) {
  const hasObs = hasObservedUse(admissible) || hasObservedUse(allPackets);

  if (!hasObs) {
    return {
      status: "unsupported",
      reasons: ["Adoption claim requires observed_use=true evidence; none found"],
    };
  }

  const adoptionPackets = admissible.filter((ep) =>
    ADOPTION_SUPPORT_TYPES.has(ep.evidence_type || ep.source_type || "")
  );

  if (adoptionPackets.length >= 1) {
    return { status: "supported", reasons: [] };
  }

  return { status: "partially_supported", reasons: ["observed_use evidence present but source type is indirect"] };
}

function qaCapabilityClaim(admissible, allPackets) {
  const capPackets = [...admissible, ...allPackets].filter((ep) =>
    CAPABILITY_TYPES.has(ep.evidence_type || ep.source_type || "")
  );

  if (capPackets.length < 1) {
    return {
      status: "unsupported",
      reasons: ["No research/benchmark/demonstration evidence for capability claim"],
    };
  }

  // Capability claims must NOT imply real-world adoption unless observed_use=true
  const hasObs = hasObservedUse(admissible);
  const notes = [];
  if (!hasObs) {
    notes.push("Capability is lab-only; real-world adoption is not established");
  }

  return { status: "supported", reasons: notes };
}

function qaOutlookClaim() {
  // Outlook claims must be forward-looking (label check is caller's responsibility)
  // They are structurally valid as long as they are labeled as forward-looking
  return { status: "supported", reasons: [] };
}

function qaRecommendationClaim(admissible, allPackets) {
  const basisTypes = new Set([
    "incident", "vulnerability", "threat_intelligence", "adversary_adoption_signal",
    "governance_signal", "defensive_capability",
  ]);

  const basisPackets = [...admissible, ...allPackets].filter((ep) =>
    basisTypes.has(ep.evidence_type || ep.source_type || "") ||
    packetPermittedUses(ep).some((u) => ["governance_action", "defensive_control", "observed_risk", "recommendation_input"].includes(u))
  );

  if (basisPackets.length >= 1) {
    return { status: "supported", reasons: [] };
  }

  // A recommendation with a relevant basis but no direct risk/governance type proceeds
  // with a caveat. A recommendation with NO admissible evidence at all is ungrounded —
  // block it (an action recommendation must rest on some observed risk/control).
  if (admissible.length >= 1) {
    return {
      status: "partially_supported",
      reasons: ["Recommendation lacks direct risk/governance evidence basis"],
    };
  }
  return {
    status: "unsupported",
    reasons: ["Recommendation has no admissible evidence basis — ungrounded"],
  };
}

// ── Concreteness floor ────────────────────────────────────────────────────────

/**
 * A claim above medium priority must have at least one supporting evidence packet
 * with concreteness_level = "high" or "moderate".
 * Claims backed only by low-concreteness evidence (dramatic language, no named anchors)
 * cannot be critical or high priority.
 *
 * Returns a block object if violated, or null if OK.
 */
function checkConcretenessFloor(claim, packets) {
  const priority = claim.claim_priority;
  // medium (and unset) priority is always OK — only gate critical/high
  if (!priority || priority === "medium" || priority === "low") return null;

  const highOrModerate = (packets || []).filter((p) => {
    const level = p.concreteness_level || p.triage_data?.concreteness_level;
    return level === "high" || level === "moderate";
  });

  if (highOrModerate.length === 0) {
    return {
      status: "overgeneralized",
      blocking_reason: "claim_priority_exceeds_evidence_concreteness",
      note: `${priority} priority requires at least one concrete evidence anchor (named CVE, model, metric, date, or method). Supporting evidence has only low-concreteness items.`,
    };
  }
  return null;
}

/**
 * Check whether a high-priority claim has sufficient concrete evidence backing.
 *
 * Design principle: concreteness is determined by the EVIDENCE quality (triage_data
 * concreteness_level), not by scanning claim text for hype keywords. The evidence
 * judgment (judgeEvidenceItems.js) already assessed whether each item is concrete;
 * re-deriving this from claim text is unreliable.
 *
 * Returns a warning object (not a block) or null.
 * A block is issued separately by checkConcretenessFloor (evidence-driven).
 */
function checkClaimTextConcreteness(claim, packets) {
  // Use evidence-driven check: does the claim have any concrete evidence packet?
  // The evidence judgment (LLM) already set concreteness_level on each item.
  const allPackets = packets || [];
  if (allPackets.length === 0) return null;

  const hasConcreteEvidence = allPackets.some((p) => {
    const level = p.concreteness_level || p.triage_data?.concreteness_level;
    return level === "high" || level === "moderate";
  });

  // Supplementary: check for hype_flag on supporting evidence (set by normalization).
  // hype_flag=true on ALL supporting packets signals synthesis may have drifted toward tone.
  const allHyped = allPackets.length > 0 && allPackets.every((p) =>
    p.hype_flag === true || p.triage_data?.hype_flag === true
  );

  if (!hasConcreteEvidence && allHyped) {
    return {
      warning: "claim_backed_only_by_hype_flagged_low_concreteness_evidence",
      note: "All supporting evidence items are marked hype_flag=true with low concreteness. Synthesis may have drifted toward dramatic source tone. Verify concrete anchors.",
    };
  }
  return null;
}

// ── Analytics-only gate ───────────────────────────────────────────────────────
//
// Analytics packets (source_branch=L5B or evidence_class=analytics) describe the
// COLLECTION, not the real world. They cannot alone support real-world factual,
// adoption, case_study, or incident claims.

const REAL_WORLD_CLAIM_TYPES = new Set(["factual", "adoption", "case_study", "incident"]);

/**
 * Check whether a claim is supported only by analytics (5B) packets.
 * Returns a block object if violated, or null if OK.
 *
 * @param {string}   claimType
 * @param {object[]} packets
 * @returns {{ status, blocking_reason } | null}
 */
export function checkAnalyticsOnlyClaim(claimType, packets) {
  if (!REAL_WORLD_CLAIM_TYPES.has(claimType)) return null;

  const allAnalytics = (packets || []).every(
    (ep) =>
      ep.evidence_class === "analytics" ||
      ep.source_branch  === "L5B"      ||
      ep.origin         === "5B_analytics"
  );

  if (allAnalytics && packets.length > 0) {
    return {
      status: "unsupported",
      blocking_reason: "analytics_only_not_sufficient_for_real_world_claim",
    };
  }
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * QA a single analytical claim against available evidence, corpus audit, and
 * the analytical state candidate ceilings.
 *
 * New status values:
 *   blocked_by_corpus_audit      — claim type in corpus_audit.blocked_claim_types[]
 *   exceeds_confidence_ceiling   — claim.confidence higher than candidate ceiling
 *
 * @param {object}   claim            - The claim object (must have claim_type, text/insight fields)
 * @param {object[]} evidencePackets  - All evidence packets available for this category
 * @param {object}   corpusAudit      - Output of buildCorpusAudit()
 * @param {object}   [analyticalState] - Optional: category state from buildAnalyticalState()
 *                                       Used to resolve confidence_ceiling per candidate.
 * @returns {{
 *   claim_type: string,
 *   claim_support_status: string,
 *   blocking_reasons: string[],
 *   allowed_to_proceed: boolean,
 *   qa_notes: string,
 *   secondary_attributes: string[],
 * }}
 */
export function qaAnalyticalClaim(claim, evidencePackets, corpusAudit, analyticalState) {
  // Map the claim-chain claim_type to the QA gate vocabulary (see normalizeClaimType).
  const claimType = normalizeClaimType(claim);
  const allPackets  = evidencePackets || [];
  const admissible  = getAdmissiblePackets(allPackets);
  const context     = getContextPackets(allPackets);

  // Detect secondary attributes — reads LLM-assigned fields first (claim.secondary_attributes
  // and claim.judgment_flags), falls back to regex only for legacy claims.
  const claimText = claim.claim_text || claim.text || claim.insight || "";
  const secondaryAttrs = detectSecondaryAttributes(claimText, allPackets, claim);

  const blocking_reasons = [];

  // ── Gate: blocked_by_corpus_audit ────────────────────────────────────────
  // If the normalized claim type OR its secondary attributes are in the blocked list,
  // immediately block with the new status.
  const blockedTypes = new Set(corpusAudit?.blocked_claim_types || []);

  if (blockedTypes.has(claimType)) {
    return {
      claim_type:           claimType,
      claim_support_status: "blocked_by_corpus_audit",
      blocking_reasons:     [`${claimType} is blocked by corpus audit: ${[...(corpusAudit?.analysis_limitations || [])].slice(0, 1).join("; ")}`],
      allowed_to_proceed:   false,
      qa_notes:             `blocked_by_corpus_audit: ${claimType}`,
      secondary_attributes: [...secondaryAttrs],
    };
  }

  // Check secondary attributes against blocked types
  for (const attr of secondaryAttrs) {
    if (blockedTypes.has(attr)) {
      return {
        claim_type:           claimType,
        claim_support_status: "blocked_by_corpus_audit",
        blocking_reasons:     [`secondary attribute "${attr}" is blocked by corpus audit`],
        allowed_to_proceed:   false,
        qa_notes:             `blocked_by_corpus_audit: secondary attribute ${attr}`,
        secondary_attributes: [...secondaryAttrs],
      };
    }
  }

  // ── Gate: market_wide secondary attribute + vendor_heavy corpus ───────────
  if (secondaryAttrs.has("market_wide") &&
      corpusAudit?.source_concentration_flags?.includes("vendor_heavy")) {
    return {
      claim_type:           claimType,
      claim_support_status: "blocked_by_corpus_audit",
      blocking_reasons:     ["market_wide claim detected in vendor-heavy corpus — blocked"],
      allowed_to_proceed:   false,
      qa_notes:             "blocked_by_corpus_audit: market_wide + vendor_heavy",
      secondary_attributes: [...secondaryAttrs],
    };
  }

  // ── Gate: real_world_use secondary attribute vs lab-only evidence ─────────
  if (secondaryAttrs.has("real_world_use")) {
    const allEvidenceLimitationsLabOnly = allPackets.every((ep) =>
      packetLimitations(ep).some((l) => typeof l === "string" && l === "lab_only")
    );
    if (allEvidenceLimitationsLabOnly && allPackets.length > 0) {
      return {
        claim_type:           claimType,
        claim_support_status: "overgeneralized",
        blocking_reasons:     ["claim asserts real_world_use but all evidence has lab_only limitation"],
        allowed_to_proceed:   false,
        qa_notes:             "overgeneralized: real_world_use claimed but all evidence is lab_only",
        secondary_attributes: [...secondaryAttrs],
      };
    }
  }

  // ── Gate: exceeds_confidence_ceiling ─────────────────────────────────────
  // Compare claim.confidence against the category-level confidence_ceiling from
  // the analytical state. Uses the category ceiling (evidence quality gate) rather
  // than per-candidate ceilings (which no longer exist after the v3 simplification).
  if (analyticalState && claim.confidence) {
    const CONF_RANK = { high: 3, medium: 2, low: 1, none: 0 };
    const categoryCeiling = analyticalState.confidence_ceiling || null;
    if (categoryCeiling) {
      const claimRank   = CONF_RANK[claim.confidence] ?? 0;
      const ceilingRank = CONF_RANK[categoryCeiling]  ?? 0;
      if (claimRank > ceilingRank) {
        return {
          claim_type:           claimType,
          claim_support_status: "exceeds_confidence_ceiling",
          blocking_reasons:     [
            `claim.confidence="${claim.confidence}" exceeds category evidence ceiling="${categoryCeiling}"`,
          ],
          allowed_to_proceed:   false,
          qa_notes:             `exceeds_confidence_ceiling: ${claim.confidence} > ${categoryCeiling}`,
          secondary_attributes: [...secondaryAttrs],
        };
      }
    }
  }

  // ── Corpus-level gates ────────────────────────────────────────────────────
  const analysisAllowed = corpusAudit?.analysis_allowed || "full";

  if (analysisAllowed === "insufficient") {
    // Only capability (lab-only), outlook (speculative), recommendation (cautionary), and
    // emerging_signal (early/preliminary, not a confirmed claim) are allowed.
    // emerging_signal is explicitly permitted because thin evidence is exactly the condition
    // in which emerging signals are most informative — they should be caveated, not blocked.
    const allowedInInsufficient = new Set(["capability", "outlook", "recommendation", "emerging_signal"]);
    if (!allowedInInsufficient.has(claimType)) {
      blocking_reasons.push(
        `corpus_insufficient — ${claimType} claims require full analysis; corpus is insufficient`
      );
    } else {
      // Allowed even with insufficient corpus — return immediately with appropriate status
      const insufficientNotes = (corpusAudit?.analysis_limitations || []).slice(0, 2).join("; ");
      return {
        claim_type:           claimType,
        claim_support_status: "partially_supported",
        blocking_reasons:     [],
        allowed_to_proceed:   true,
        qa_notes:             `Permitted in insufficient corpus (${claimType}). ${insufficientNotes}`.trim(),
        secondary_attributes: [...secondaryAttrs],
      };
    }
  }

  // operational_evidence_sparse blocks adoption and real_world_factual claims
  // (also checked via blocked_claim_types above — this is the legacy path for
  //  claims that don't map exactly to blocked_claim_types strings)
  if (corpusAudit?.evidence_gap_flags?.includes("operational_evidence_sparse")) {
    if (claimType === "adoption" || claimType === "factual") {
      blocking_reasons.push("operational_evidence_sparse — real-world use is unconfirmed");
    }
  }

  // vendor_heavy blocks market_wide and ecosystem_wide strategic claims only
  // (NOT all strategic_assessment — the more precise check is via blocked_claim_types)
  if (
    (claimType === "strategic_assessment" || secondaryAttrs.has("market_wide")) &&
    corpusAudit?.source_concentration_flags?.includes("vendor_heavy")
  ) {
    blocking_reasons.push("vendor_heavy_corpus — market_wide/ecosystem_wide strategic claims from vendor-dominated corpus are blocked");
  }

  // ── Analytics-only gate ───────────────────────────────────────────────────
  // Real-world factual/adoption/case_study/incident claims cannot rest on
  // analytics (5B) packets alone — analytics describe the collection, not the world.
  const analyticsBlock = checkAnalyticsOnlyClaim(claimType, allPackets);
  if (analyticsBlock) {
    return {
      claim_type:           claimType,
      claim_support_status: "unsupported",
      blocking_reasons:     [...blocking_reasons, analyticsBlock.blocking_reason],
      allowed_to_proceed:   false,
      qa_notes:             `analytics_only: ${claimType} requires non-analytics evidence`,
      secondary_attributes: [...secondaryAttrs],
    };
  }

  // ── Conflicting evidence ───────────────────────────────────────────────────
  if (hasConflictingEvidence(allPackets)) {
    return {
      claim_type:          claimType,
      claim_support_status: "contradicted",
      blocking_reasons:    [...blocking_reasons, "conflicting_evidence_found"],
      allowed_to_proceed:  false,
      qa_notes:            "Evidence corpus contains conflicting evidence — claim is contradicted",
      secondary_attributes: [...secondaryAttrs],
    };
  }

  // ── Early exit if already blocked ────────────────────────────────────────
  if (blocking_reasons.length > 0) {
    return {
      claim_type:          claimType,
      claim_support_status: "unsupported",
      blocking_reasons,
      allowed_to_proceed:  false,
      qa_notes:            blocking_reasons.join("; "),
      secondary_attributes: [...secondaryAttrs],
    };
  }

  // ── Per-type support checks ───────────────────────────────────────────────
  let result;

  switch (claimType) {
    case "factual":
      result = qaFactualClaim(admissible, corpusAudit);
      break;
    case "case_study":
      result = qaCaseStudyClaim(admissible);
      break;
    case "trend":
    case "trend_over_time":
      result = qaTrendClaim(admissible, corpusAudit);
      break;
    case "comparison":
      result = qaTrendClaim(admissible, corpusAudit); // same gates as trend_over_time
      break;
    case "adoption":
      result = qaAdoptionClaim(admissible, allPackets);
      break;
    case "capability":
      result = qaCapabilityClaim(admissible, [...context, ...allPackets]);
      // If secondary attribute says real_world_use but lab_only limitation present, add caveat
      if (secondaryAttrs.has("lab_only") && !secondaryAttrs.has("real_world_use")) {
        result.reasons.push("lab_only: real-world adoption not established");
      }
      break;
    case "emerging_signal":
      result = qaEmergingSignalClaim(admissible, allPackets);
      break;
    case "outlook":
      result = qaOutlookClaim();
      break;
    case "recommendation":
      result = qaRecommendationClaim(admissible, allPackets);
      break;
    case "insight":
      result = qaInsightClaim(admissible, context);
      break;
    case "strategic_assessment":
    default:
      // Strategic assessment: at least 2 supported/partially-supported claims from other types
      result = admissible.length >= 2
        ? { status: "supported", reasons: [] }
        : { status: "partially_supported", reasons: ["Limited evidence base for strategic assessment"] };
  }

  const claim_support_status = result.status;
  const all_reasons = [...blocking_reasons, ...result.reasons];

  let isBlocked =
    claim_support_status === "unsupported" ||
    claim_support_status === "overgeneralized" ||
    claim_support_status === "contradicted" ||
    claim_support_status === "blocked_by_corpus_audit" ||
    claim_support_status === "exceeds_confidence_ceiling";

  // ── Concreteness floor gate ───────────────────────────────────────────────
  // Claims above medium priority must have at least one concrete evidence anchor.
  const concretenessBlock = checkConcretenessFloor(claim, allPackets);
  if (concretenessBlock) {
    all_reasons.push(concretenessBlock.blocking_reason);
    isBlocked = true;
  }

  // ── Hype text warning (non-blocking) — evidence-driven, not text regex ──
  const hyped = checkClaimTextConcreteness(claim, allPackets);

  const corpus_limitations = corpusAudit?.analysis_limitations || [];
  const qa_notes = [
    ...all_reasons,
    ...(corpus_limitations.length > 0 ? [`corpus: ${corpus_limitations.slice(0, 2).join("; ")}`] : []),
  ].join(" | ") || "ok";

  const out = {
    claim_type:          claimType,
    claim_support_status: (concretenessBlock ? "overgeneralized" : claim_support_status),
    blocking_reasons:    all_reasons,
    allowed_to_proceed:  !isBlocked,
    qa_notes,
    secondary_attributes: [...secondaryAttrs],
  };

  if (hyped) out.hype_language_warning = hyped;

  return out;
}

/**
 * Run qaAnalyticalClaim on an array of claims and filter out blocked ones.
 *
 * `evidence` may be EITHER:
 *   - an array of packets (legacy: every claim is evaluated against this pool), OR
 *   - a function (claim) => packet[] that returns the CLAIM'S OWN supporting evidence.
 *
 * The per-claim resolver form is strongly preferred: the trend/factual/adoption gates
 * must measure the claim's own evidence (≥3 items, ≥2 origins, ≥2 windows AMONG THE
 * CLAIM'S support), not category-wide coverage. Passing the whole category pool let a
 * single-source claim pass the trend gate because the category happened to have ≥3 items.
 *
 * `analyticalState` (optional): the per-category state from buildAnalyticalState().
 * When provided, candidate confidence ceilings are enforced (exceeds_confidence_ceiling).
 *
 * @param {object[]} claims                 - Array of claim objects
 * @param {object[]|function} evidence      - Category packet pool, or per-claim resolver
 * @param {object}   corpusAudit            - Output of buildCorpusAudit()
 * @param {object}   [analyticalState]      - Optional category state for ceiling enforcement
 * @returns {{ passing: object[], blocked: object[] }}
 */
export function qaAllClaims(claims, evidence, corpusAudit, analyticalState) {
  const passing = [];
  const blocked = [];
  const resolve = typeof evidence === "function"
    ? evidence
    : () => evidence;

  for (const claim of (claims || [])) {
    const claimEvidence = resolve(claim) || [];
    const result = qaAnalyticalClaim(claim, claimEvidence, corpusAudit, analyticalState);
    // result.claim_type is the NORMALIZED QA gate type (e.g. category_insight →
    // insight); never let it overwrite the claim's own claim_type, which the slide
    // planner depends on for slide structure. Preserve the original.
    const enriched = { ...claim, ...result, claim_type: claim.claim_type ?? result.claim_type };

    if (result.allowed_to_proceed) {
      passing.push(enriched);
    } else {
      blocked.push(enriched);
    }
  }

  return { passing, blocked };
}
