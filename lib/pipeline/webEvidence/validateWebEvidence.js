/**
 * Layer 5C.7 — Anti-hallucination validation for web evidence (text).
 *
 * Deterministic gates:
 *   - opened_url_confirmed required
 *   - a verbatim quote is required for any item that claims concrete+ depth
 *   - the quote must support the claim (token overlap; mismatch → downgrade)
 *   - numbers in the claim must appear in a quote (else not numerically grounded)
 *   - attack steps must be source-grounded (handled in extract; re-checked here)
 *
 * Produces violations + may DOWNGRADE depth (never silently accept) and set
 * manual_review_required / rejection_reason.
 */

import { quoteClaimMatch } from "../discovery/candidateGates.js";
import { DEPTH_ALLOWED_IN_ANALYSIS } from "./webEvidenceSchemas.js";

// "Significant" numbers worth grounding: percentages, multi-digit counts, money.
// Deliberately ignores single digits inside names like "GPT-4".
function significantNumbers(s) {
  return String(s || "").match(/\d+(?:\.\d+)?%|\$\d[\d,]*|\b\d{2,}(?:\.\d+)?\b/g) || [];
}

export function validateWebEvidence(ev) {
  const violations = [];
  const quotes = ev?.source_grounding?.verbatim_quotes || [];
  const hasQuote = quotes.some((q) => String(q || "").trim().length >= 20);
  const claim = ev?.concrete_claim || "";

  // 1. Opened URL gate.
  if (!ev?.source_grounding?.opened_url_confirmed) {
    violations.push("opened_url_not_confirmed");
  }
  if (!ev?.source_grounding?.source_url) {
    violations.push("missing_source_url");
  }

  // 2. Quote requirement for concrete+ depth.
  const wantsAnalysis = DEPTH_ALLOWED_IN_ANALYSIS.has(ev?.evidence_depth);
  if (wantsAnalysis && !hasQuote) {
    violations.push("no_verbatim_quote_for_concrete_evidence");
  }

  // 3. Quote supports claim.
  let quoteClaim = "unverified";
  if (hasQuote && claim) {
    const best = quotes.map((q) => quoteClaimMatch(claim, q)).sort(rankMatch)[0];
    quoteClaim = best || "unverified";
    if (quoteClaim === "mismatch") violations.push("quote_does_not_support_claim");
  }

  // 4. Numbers grounded: every significant number in the claim must appear verbatim
  //    in some quote (ignores single digits inside names like "GPT-4").
  const claimNums = significantNumbers(claim);
  if (claimNums.length && !claimNums.every((n) => quotes.some((q) => String(q).includes(n)))) {
    violations.push("number_in_claim_not_grounded_in_quote");
  }

  // 5. Attack-step grounding (steps must carry grounding).
  const steps = ev?.operational_details?.attack_steps || [];
  if (steps.length > 0) {
    const ungrounded = steps.filter((s) => s && s.grounded === false);
    if (ungrounded.length > 0) violations.push("ungrounded_attack_steps_present");
  }

  // ── Apply outcome ───────────────────────────────────────────────────────────
  const out = { ...ev };
  out._quote_claim_match = quoteClaim;

  const hard = violations.includes("opened_url_not_confirmed") ||
    violations.includes("missing_source_url") ||
    violations.includes("quote_does_not_support_claim");

  if (hard) {
    out.evidence_depth = "thin";
    out.analysis_usefulness = "not_useful";
    out.rejection_reason = violations[0];
    out.validation_status = "rejected";
  } else if (violations.length > 0) {
    // Soft issues → downgrade out of the analysis-eligible band, flag review.
    if (violations.includes("no_verbatim_quote_for_concrete_evidence") ||
        violations.includes("ungrounded_attack_steps_present")) {
      out.evidence_depth = "thin";
    }
    if (violations.includes("number_in_claim_not_grounded_in_quote")) {
      out.manual_review_required = true;
    }
    out.validation_status = "weak";
  } else {
    out.validation_status = "validated";
  }

  out.validation_violations = violations;
  out.analysis_eligible = out.validation_status !== "rejected" && DEPTH_ALLOWED_IN_ANALYSIS.has(out.evidence_depth);
  return out;
}

function rankMatch(a, b) {
  const order = { match: 0, partial: 1, unverified: 2, mismatch: 3 };
  return (order[a] ?? 9) - (order[b] ?? 9);
}

export function validateWebEvidenceBatch(items = []) {
  return items.map(validateWebEvidence);
}
