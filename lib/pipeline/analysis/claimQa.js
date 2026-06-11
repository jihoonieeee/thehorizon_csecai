/**
 * Analytical Claim QA
 *
 * Deterministic gating of analytical claims against evidence packets and corpus audit.
 * Every claim must pass gates before it can reach slide generation.
 *
 * claim_support_status:
 *   supported           — evidence clearly supports the claim type
 *   partially_supported — evidence exists but has limitations
 *   unsupported         — required evidence is absent
 *   overgeneralized     — claim scope exceeds the evidence base
 *   contradicted        — evidence contradicts or conflicts with claim
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
// The claim chain (analyzeCategory.buildClaimChainView) mints claim_type values
// {category_insight, trend_claim, recommendation, outlook}. The per-type QA gates
// below key off {factual, trend, adoption, capability, recommendation, outlook,
// case_study, strategic_assessment}. Without this mapping, trend_claim and
// category_insight fell through to the permissive strategic_assessment default,
// so the trend and adoption gates were unreachable. We map structurally AND by
// claim language so over-claims route to the strict gate that should catch them.

const ADOPTION_LANG = /\b(adopt(ed|ion|ing)?|in the wild|real[- ]world use|used by (attackers|adversaries|threat actors)|deployed by (attackers|adversaries))\b/i;
const TREND_LANG    = /\b(trend|increasingly|growing|rising|surge|surging|proliferat|more frequent|on the rise|escalating|widespread|accelerating|spike)\b/i;
// Real-world operational assertion ("actively exploited", "breached in production").
// Routes to the factual gate, which is blocked under operational_evidence_sparse
// and requires an operational source type — so such claims cannot stand on
// research/lab evidence alone.
const OPERATIONAL_LANG = /\b(actively exploited|exploited in the wild|in production attacks|ransomware campaign|breach(ed)? (a|the|an|in)|compromised (a|the|an|in)|operational(ly)? deployed)\b/i;

const QA_NATIVE_TYPES = new Set([
  "factual", "trend", "adoption", "capability", "comparison",
  "recommendation", "outlook", "case_study", "strategic_assessment", "insight",
]);

// Claim types the gate handles EXPLICITLY (i.e. not via the strategic_assessment
// default). The contract test asserts every claim_type the claim chain mints maps
// into this set — so a rename can never silently route a claim to the weak default.
export const QA_EXPLICIT_GATE_TYPES = new Set([
  "factual", "case_study", "trend", "comparison", "adoption",
  "capability", "outlook", "recommendation", "insight",
]);

export function normalizeClaimType(claim) {
  const explicit = claim.claim_type || "";
  const text = claim.claim_text || claim.text || claim.insight || "";

  // Explicit structural mappings.
  if (explicit === "trend_claim") return "trend";
  if (explicit === "category_insight") {
    // An "insight" can still carry adoption/operational/trend language — route it
    // to the strict gate when it does; otherwise treat it as a general insight.
    if (ADOPTION_LANG.test(text))    return "adoption";
    if (OPERATIONAL_LANG.test(text)) return "factual";
    if (TREND_LANG.test(text))       return "trend";
    return "insight";
  }
  if (QA_NATIVE_TYPES.has(explicit)) return explicit;

  // Unlabeled / unknown: detect the strongest claim semantics from the text.
  if (ADOPTION_LANG.test(text))    return "adoption";
  if (OPERATIONAL_LANG.test(text)) return "factual";
  if (TREND_LANG.test(text))       return "trend";
  return "strategic_assessment";
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
  if (corpusAudit?.source_concentration_flags?.some((f) => f.startsWith("single_publisher_dominance"))) {
    return {
      status: "overgeneralized",
      reasons: ["single_publisher_dominance — trend cannot be established from one publisher"],
    };
  }

  if (admissible.length < 3) {
    return {
      status: "overgeneralized",
      reasons: [`Trend requires ≥3 evidence items; found ${admissible.length}`],
    };
  }

  const independentOrigins = countIndependentOrigins(admissible);
  if (independentOrigins < 2) {
    return {
      status: "overgeneralized",
      reasons: ["Trend requires ≥2 independent origins; sources appear to derive from single origin"],
    };
  }

  const timeWindows = countTimeWindows(admissible);
  if (timeWindows < 2) {
    return {
      status: "overgeneralized",
      reasons: ["Trend requires evidence from ≥2 time windows; all evidence is from same period"],
    };
  }

  return { status: "supported", reasons: [] };
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
    (ep.permitted_uses || []).some((u) => ["governance_action", "defensive_control", "observed_risk"].includes(u))
  );

  if (basisPackets.length >= 1) {
    return { status: "supported", reasons: [] };
  }

  return {
    status: "partially_supported",
    reasons: ["Recommendation lacks direct risk/governance evidence basis"],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * QA a single analytical claim against available evidence and corpus audit.
 *
 * @param {object}   claim           - The claim object (must have claim_type, text/insight fields)
 * @param {object[]} evidencePackets - All evidence packets available for this category
 * @param {object}   corpusAudit     - Output of buildCorpusAudit()
 * @returns {{
 *   claim_type: string,
 *   claim_support_status: string,
 *   blocking_reasons: string[],
 *   allowed_to_proceed: boolean,
 *   qa_notes: string,
 * }}
 */
export function qaAnalyticalClaim(claim, evidencePackets, corpusAudit) {
  // Map the claim-chain claim_type to the QA gate vocabulary (see normalizeClaimType).
  const claimType = normalizeClaimType(claim);
  const allPackets  = evidencePackets || [];
  const admissible  = getAdmissiblePackets(allPackets);
  const context     = getContextPackets(allPackets);

  const blocking_reasons = [];

  // ── Corpus-level gates ────────────────────────────────────────────────────
  const analysisAllowed = corpusAudit?.analysis_allowed || "full";

  if (analysisAllowed === "insufficient") {
    // Only capability (lab-only), outlook (speculative), and recommendation (cautionary) allowed
    const allowedInInsufficient = new Set(["capability", "outlook", "recommendation"]);
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
      };
    }
  }

  // operational_evidence_sparse blocks adoption and real-world factual claims
  if (corpusAudit?.evidence_gap_flags?.includes("operational_evidence_sparse")) {
    if (claimType === "adoption" || claimType === "factual") {
      blocking_reasons.push("operational_evidence_sparse — real-world use is unconfirmed");
    }
  }

  // vendor_heavy blocks strategic_assessment
  if (
    claimType === "strategic_assessment" &&
    corpusAudit?.source_concentration_flags?.includes("vendor_heavy")
  ) {
    blocking_reasons.push("vendor_heavy_corpus — strategic assessment from vendor-dominated corpus requires caveat");
  }

  // ── Conflicting evidence ───────────────────────────────────────────────────
  if (hasConflictingEvidence(allPackets)) {
    return {
      claim_type:          claimType,
      claim_support_status: "contradicted",
      blocking_reasons:    [...blocking_reasons, "conflicting_evidence_found"],
      allowed_to_proceed:  false,
      qa_notes:            "Evidence corpus contains conflicting evidence — claim is contradicted",
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
      result = qaTrendClaim(admissible, corpusAudit);
      break;
    case "comparison":
      result = qaTrendClaim(admissible, corpusAudit); // same gates as trend
      break;
    case "adoption":
      result = qaAdoptionClaim(admissible, allPackets);
      break;
    case "capability":
      result = qaCapabilityClaim(admissible, [...context, ...allPackets]);
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

  const isBlocked =
    claim_support_status === "unsupported" ||
    claim_support_status === "overgeneralized" ||
    claim_support_status === "contradicted";

  const corpus_limitations = corpusAudit?.analysis_limitations || [];
  const qa_notes = [
    ...all_reasons,
    ...(corpus_limitations.length > 0 ? [`corpus: ${corpus_limitations.slice(0, 2).join("; ")}`] : []),
  ].join(" | ") || "ok";

  return {
    claim_type:          claimType,
    claim_support_status,
    blocking_reasons:    all_reasons,
    allowed_to_proceed:  !isBlocked,
    qa_notes,
  };
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
 * @param {object[]} claims        - Array of claim objects
 * @param {object[]|function} evidence - Category packet pool, or per-claim resolver
 * @param {object}   corpusAudit   - Output of buildCorpusAudit()
 * @returns {{ passing: object[], blocked: object[] }}
 */
export function qaAllClaims(claims, evidence, corpusAudit) {
  const passing = [];
  const blocked = [];
  const resolve = typeof evidence === "function"
    ? evidence
    : () => evidence;

  for (const claim of (claims || [])) {
    const claimEvidence = resolve(claim) || [];
    const result = qaAnalyticalClaim(claim, claimEvidence, corpusAudit);
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
