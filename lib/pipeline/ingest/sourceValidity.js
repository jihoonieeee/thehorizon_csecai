import { checkUrlSafety, isUrlReachable } from "../validation/urlSafety.js";

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

// Structural validity score: reflects data completeness alone. No trust tier adjustment.
// Max = 50 (base) + 0 (publisher present = no penalty) + 0 (date present = no penalty) + 15 (text >= 500) = 65.
// Penalties: publisher missing = −10, date missing = −15, text < 50 chars = −5, URL dead = −10.
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

export async function checkSourceValidity(source) {
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

  // ── Hard gate 2: missing or unsafe URL ───────────────────────────────────
  const urlCheck = source.url ? await checkUrlSafety(source.url) : null;

  if (!urlCheck || !urlCheck.safe) {
    return {
      source_id: source.id,
      structural_validity_score: 0,
      source_validity_score: 0,
      publisher_trust_score,
      credibility_label: "do_not_use",
      trust_tier: trustTier,
      warnings: [urlCheck ? `Unsafe URL (${urlCheck.status})` : "Missing URL"],
      usable: false,
      url_reachable: null,
      url_safety_status: urlCheck?.status || "missing",
      final_url: urlCheck?.final_url || source.url || null,
    };
  }

  // ── Structural score (data completeness only) ─────────────────────────────
  const { score: baseScore, warnings } = computeStructuralScore(source);
  let score = baseScore;

  // Soft penalty: URL returns a confirmed error response
  // Use final_url (the HTTPS destination) for reachability; avoids double-fetching HTTP sources.
  const url_reachable = await isUrlReachable(urlCheck.final_url);
  if (url_reachable === false) {
    score -= 10;
    warnings.push("URL returned error response");
  }

  const structural_validity_score = Math.max(0, Math.min(100, score));

  let label;
  if (structural_validity_score >= 80)      label = "primary";
  else if (structural_validity_score >= 65)  label = "high_trust";
  else if (structural_validity_score >= 45)  label = "medium_trust";
  else if (structural_validity_score >= 25)  label = "low_trust";
  else                                       label = "do_not_use";

  return {
    source_id: source.id,
    structural_validity_score,
    source_validity_score: structural_validity_score,  // backward-compat alias
    publisher_trust_score,
    credibility_label: label,
    trust_tier: trustTier,
    warnings,
    usable: label !== "do_not_use",
    url_reachable,
    url_safety_status: urlCheck.status,
    final_url: urlCheck.final_url,
  };
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function attachValidityToSources(sources) {
  const validities = await runWithConcurrency(
    sources.map((source) => () => checkSourceValidity(source)),
    20  // cap simultaneous HEAD requests
  );
  return sources.map((source, i) => ({ ...source, validity: validities[i] }));
}
