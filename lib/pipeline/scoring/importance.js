/**
 * importance.js — deterministic source-importance tiering.
 *
 * Tiers (ordered, highest first):
 *   realized  — confirmed real-world use: incidents, active threat intelligence
 *   proven    — working PoC or demonstrated capability: capability_demonstration, exploit_disclosure
 *   research  — lab/academic finding: research_finding, benchmark_evaluation
 *   reference — authoritative advisory (primary/curated trust only): governance_signal
 *   noise     — everything else: defensive, unclear, low-value
 *
 * Rules are purely categorical — no numeric scores, no weights, no thresholds.
 * Provenance (trust_tier) gates only the "reference" tier; it never lifts or
 * sinks substance tiers (a low-trust incident is still realized).
 */

export const RULES_VERSION = "importance-v1";

export const IMPORTANCE_TIERS = ["realized", "proven", "research", "reference", "noise"];
export const IMPORTANCE_RANK  = { realized: 4, proven: 3, research: 2, reference: 1, noise: 0 };

const OFFENSIVE_CATEGORIES = new Set([
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
]);

const AUTHORITATIVE_TIERS = new Set(["primary", "curated"]);

// Patterns that signal in-the-wild exploitation (lifts CVEs/vulns to realized)
const IN_WILD_RE = /\b(actively exploit\w*|exploited in the wild|known exploit\w*|in-the-wild|wild exploit\w*|actively used|ransomware|nation.state|threat actor)\b/i;

/**
 * Resolve the is_defensive flag. The mechanism_classification resort call
 * (intelligence.mechanism_classification.is_defensive) supersedes the stale
 * top-level flag. Absence of mc means fall back to intelligence.is_defensive,
 * then top-level is_defensive.
 */
function resolveDefensive(s) {
  const mc = s.intelligence?.mechanism_classification;
  if (mc && typeof mc.is_defensive === "boolean") return mc.is_defensive;
  if (typeof s.intelligence?.is_defensive === "boolean") return s.intelligence.is_defensive;
  return s.is_defensive === true;
}

/**
 * Derive a reality facet from source_type alone.
 * Returns: "realized" | "proven" | "research" | "advisory" | null
 */
function typeToReality(sourceType) {
  switch (sourceType) {
    case "incident":
    case "threat_intelligence":
    case "adversary_adoption_signal":
      return "realized";
    case "exploit_disclosure":
    case "capability_demonstration":
      return "proven";
    case "research_finding":
    case "benchmark_evaluation":
      return "research";
    case "vulnerability": {
      // Handled separately — needs text inspection for in-wild marker
      return "vulnerability";
    }
    case "governance_signal":
    case "regulatory_guidance":
      return "advisory";
    default:
      return null;
  }
}

/**
 * Derive the provenance facet from trust_tier.
 * Returns: "authoritative" | "established" | "general" | "weak"
 */
function tierToProvenance(trustTier) {
  switch (trustTier) {
    case "primary":
    case "curated":  return "authoritative";
    case "high":     return "established";
    case "medium":   return "general";
    default:         return "weak";
  }
}

/**
 * Compute the importance tier for a single source.
 *
 * @param {object} source — may be a DB row or a normalise() output. Reads:
 *   source_type, main_category (or category), trust_tier,
 *   intelligence.is_defensive, intelligence.mechanism_classification,
 *   is_defensive, short_summary, summary
 * @returns {{ tier, reality, posture, provenance, rules_version }}
 */
export function computeImportance(source) {
  const sourceType = source.source_type;
  const category   = source.main_category || source.category;
  const trustTier  = source.trust_tier;
  const isDefensive = resolveDefensive(source);

  const reality    = typeToReality(sourceType);
  const posture    = isDefensive ? "defensive" : "offensive";
  const provenance = tierToProvenance(trustTier);

  // ── Defensive sources → noise regardless of type ────────────────────────────
  if (isDefensive) {
    return { tier: "noise", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  // ── Sources in unclear/adjacent or outside scope → noise ────────────────────
  if (!OFFENSIVE_CATEGORIES.has(category)) {
    // Exception: authoritative governance/advisory sources → reference
    if ((reality === "advisory") && AUTHORITATIVE_TIERS.has(trustTier)) {
      return { tier: "reference", reality, posture, provenance, rules_version: RULES_VERSION };
    }
    return { tier: "noise", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  // ── Substance-first tiering for in-scope offensive sources ──────────────────
  if (reality === "realized") {
    return { tier: "realized", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  if (reality === "proven") {
    return { tier: "proven", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  if (reality === "research") {
    return { tier: "research", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  // ── Vulnerability: needs in-wild check to be realized; otherwise noise ──────
  if (reality === "vulnerability") {
    const text = `${source.short_summary || ""} ${source.summary || ""}`;
    if (IN_WILD_RE.test(text)) {
      return { tier: "realized", reality: "realized", posture, provenance, rules_version: RULES_VERSION };
    }
    return { tier: "noise", reality: "advisory", posture, provenance, rules_version: RULES_VERSION };
  }

  // ── Advisory/governance in-scope → reference (authoritative) or noise ───────
  if (reality === "advisory") {
    if (AUTHORITATIVE_TIERS.has(trustTier)) {
      return { tier: "reference", reality, posture, provenance, rules_version: RULES_VERSION };
    }
    return { tier: "noise", reality, posture, provenance, rules_version: RULES_VERSION };
  }

  // ── Unknown source type → noise ──────────────────────────────────────────────
  return { tier: "noise", reality: null, posture, provenance, rules_version: RULES_VERSION };
}

/**
 * Pick the strongest reality tier from an array of evidence items.
 * Used by claim-QA to compute the confidence ceiling.
 */
export function strongestReality(evidenceItems = []) {
  const ORDER = { realized: 3, proven: 2, research: 1 };
  let best = null, bestRank = -1;
  for (const item of evidenceItems) {
    const r = typeToReality(item.source_type);
    const rank = ORDER[r] ?? -1;
    if (rank > bestRank) { best = r; bestRank = rank; }
  }
  return best;
}

/**
 * Confidence ceiling for a set of evidence items.
 * realized evidence → "high", proven → "medium", research/empty → "low"
 */
export function confidenceCeilingForEvidence(evidenceItems = []) {
  const sr = strongestReality(evidenceItems);
  if (sr === "realized") return "high";
  if (sr === "proven")   return "medium";
  return "low";
}
