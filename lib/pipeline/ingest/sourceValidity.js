import { isPlausibleSourceUrl } from "../validation/urlSafety.js";

// Publisher trust score: reflects how much weight to give the publishing organisation.
// This is separate from structural validity — a primary-tier source with a missing
// title is still structurally invalid, even though its publisher is authoritative.
const PUBLISHER_TRUST_SCORES = {
  primary:  10,
  curated:   9,
  high:      8,
  medium:    6,
  low:       3,
  unknown:   2,
};

const TRUSTED_TIERS = new Set(["primary", "high", "curated"]);

// Structural validity score: reflects data completeness alone. No trust tier adjustment.
// Max = 50 (base) + 0 (publisher present = no penalty) + 0 (date present = no penalty) + 15 (text >= 500) = 65.
// Penalties: publisher missing = −10, date missing = −15, text < 50 chars = −5.
function computeStructuralScore(source) {
  let score = 50;  // base: title and safe URL confirmed present
  const warnings = [];

  if (!source.publisher || source.publisher === "Unknown") {
    score -= 10;
    warnings.push("Missing publisher");
  }

  if (!source.date_published) {
    score -= 15;
    warnings.push("Missing publication date");
  } else {
    const dateConf = source.date_confidence ||
      source.collection_metadata?.date_confidence ||
      "exact";
    if (dateConf === "low")  score -= 5;
    if (dateConf === "none") score -= 8;
  }

  const textLen = source.full_text?.length ?? 0;
  if (textLen >= 500)      score += 15;
  else if (textLen >= 50)  score += 5;
  else {
    score -= 5;
    warnings.push("Limited text available");
  }

  return { score, warnings };
}

/**
 * Structural validity check — SYNCHRONOUS and NETWORK-FREE.
 *
 * This is the cheap ingest-time gate. It deliberately performs NO network I/O:
 * URL resolution, http→https upgrade, redirect following, and reachability are
 * done exactly once, later, in Layer 3 (resolveAndVerifyUrl), and the keep/drop
 * decision for borderline sources is made by Layer 3's trust-aware final gate.
 *
 * Two hard structural gates remain here (a source with no title or no usable URL
 * cannot be processed at all). Otherwise this only annotates: trusted-tier
 * sources (primary/high/curated) are never marked `do_not_use` on structural
 * grounds alone, so an authoritative source with sparse metadata still reaches
 * Layer 3 for proper review instead of being silently dropped at ingest.
 */
export function checkSourceValidity(source) {
  const trustTier = source.trust_tier || source.collection_metadata?.trust_tier || "unknown";
  const publisher_trust_score = PUBLISHER_TRUST_SCORES[trustTier] ?? 2;

  // ── Hard gate 1: missing title ────────────────────────────────────────────
  if (!source.title?.trim()) {
    return {
      source_id: source.id,
      structural_validity_score: 0,
      source_validity_score: 0,  // backward-compat alias
      publisher_trust_score,
      credibility_label: "do_not_use",
      trust_tier: trustTier,
      warnings: ["Missing title"],
      usable: false,
      url_reachable: null,
      url_safety_status: null,
      final_url: source.url || null,
    };
  }

  // ── Hard gate 2: missing or structurally invalid URL ─────────────────────
  // Note: http URLs are ALLOWED here — Layer 3 resolves/upgrades them. Only
  // missing, malformed, non-web, or private-host URLs fail this gate.
  if (!isPlausibleSourceUrl(source.url)) {
    return {
      source_id: source.id,
      structural_validity_score: 0,
      source_validity_score: 0,
      publisher_trust_score,
      credibility_label: "do_not_use",
      trust_tier: trustTier,
      warnings: [source.url ? "Invalid or private URL" : "Missing URL"],
      usable: false,
      url_reachable: null,
      url_safety_status: source.url ? "invalid" : "missing",
      final_url: source.url || null,
    };
  }

  // ── Structural score (data completeness only) ─────────────────────────────
  const { score, warnings } = computeStructuralScore(source);
  const structural_validity_score = Math.max(0, Math.min(100, score));

  let label;
  if (structural_validity_score >= 80)      label = "primary";
  else if (structural_validity_score >= 65)  label = "high_trust";
  else if (structural_validity_score >= 45)  label = "medium_trust";
  else if (structural_validity_score >= 25)  label = "low_trust";
  else                                       label = "do_not_use";

  // Trust-aware floor: an authoritative publisher is never dropped at ingest on
  // structural grounds alone. Let Layer 3 (which can route to review) decide.
  if (label === "do_not_use" && TRUSTED_TIERS.has(trustTier)) {
    label = "low_trust";
    warnings.push("low_structural_score_but_trusted");
  }

  return {
    source_id: source.id,
    structural_validity_score,
    source_validity_score: structural_validity_score,  // backward-compat alias
    publisher_trust_score,
    credibility_label: label,
    trust_tier: trustTier,
    warnings,
    usable: label !== "do_not_use",
    // URL resolution is deferred to Layer 3; leave these unset at ingest.
    url_reachable: null,
    url_safety_status: null,
    final_url: source.url || null,
  };
}

/**
 * Attach structural validity to a batch of sources. Synchronous and network-free
 * (kept async-compatible so existing `await` call sites keep working).
 */
export async function attachValidityToSources(sources) {
  return sources.map((source) => ({ ...source, validity: checkSourceValidity(source) }));
}
