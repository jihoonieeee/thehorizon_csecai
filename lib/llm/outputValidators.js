/**
 * LLM Output Validators — deterministic checks applied after every LLM call.
 *
 * PRINCIPLE: Every LLM call is followed by deterministic validation.
 * The LLM proposes; validators dispose. No output reaches downstream code
 * without passing the relevant validator.
 *
 * ── WHAT IS VALIDATED ─────────────────────────────────────────────────────────
 * 1. Enum values         — output must use allowed vocabulary only
 * 2. ID formats          — evidence IDs must match expected patterns
 * 3. Quote presence      — source_quote must be non-empty and ≥12 chars
 * 4. URL provenance      — URLs must start with http; no fabricated domains
 * 5. Numbers             — numbers in output must exist in source evidence
 * 6. Output schema       — required fields must be present
 * 7. ID resolution       — cited evidence IDs must exist in the id_index
 *
 * ── FIELD-LEVEL RETRY ────────────────────────────────────────────────────────
 * When validation fails on a specific field (not a full parse failure), the
 * retry path can re-request ONLY that field. This is more efficient than
 * rerunning the full extraction pass.
 *
 * retryField() wraps the retry with:
 *   - Explicit instruction about what failed
 *   - Narrowed input (just the failing item + its context)
 *   - The same schema as the original call but for one field only
 */

import { ALL_EVIDENCE_TYPES }    from "../pipeline/rawfact/evidenceExtractionProfiles.js";
import { VALID_LIMITATIONS }     from "../pipeline/evidenceTriage/evidenceTriageVocab.js";

const ALL_EVIDENCE_TYPES_SET = new Set(ALL_EVIDENCE_TYPES);

// ── Shared helpers ────────────────────────────────────────────────────────────

const EV_ID_PATTERN  = /^ev_[a-zA-Z0-9_-]+$/;
const AGG_ID_PATTERN = /^(agg_|analytics_|metric_)/;
const URL_PATTERN    = /^https?:\/\/.+/;

const FABRICATED_DOMAINS = new Set([
  "example.com", "source.org", "report.com", "study.net",
  "security-research.com", "ai-threats.org", "placeholder.com",
]);

function isFabricatedUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return FABRICATED_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// ── Validation result type ────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}  valid         — true if all checks passed
 * @property {string[]} errors        — blocking issues (item rejected if any)
 * @property {string[]} warnings      — non-blocking issues (item retained with caveat)
 * @property {string[]} failed_fields — specific field names that failed (for field retry)
 */

// ── Evidence item validator ───────────────────────────────────────────────────

/**
 * Validate a single extracted evidence item (from L5A extraction).
 *
 * @param {object} item - Evidence item to validate
 * @param {string} [sourceText] - Full source text (for quote presence check)
 * @returns {ValidationResult}
 */
export function validateEvidenceItem(item, sourceText = "") {
  const errors  = [];
  const warnings = [];
  const failed_fields = [];

  // ── Required field presence ───────────────────────────────────────────────
  if (!item.evidence_type) {
    errors.push("missing evidence_type");
    failed_fields.push("evidence_type");
  }
  if (!item.fact || item.fact.length < 10) {
    errors.push("fact missing or too short (<10 chars)");
    failed_fields.push("fact");
  }
  if (!item.source_quote || item.source_quote.length < 12) {
    errors.push(`source_quote missing or too short (${item.source_quote?.length ?? 0} chars, need ≥12)`);
    failed_fields.push("source_quote");
  }

  // ── Enum validation ───────────────────────────────────────────────────────
  if (item.evidence_type && !ALL_EVIDENCE_TYPES_SET.has(item.evidence_type)) {
    errors.push(`evidence_type "${item.evidence_type}" is not in canonical list`);
    failed_fields.push("evidence_type");
  }
  if (item.evidence_confidence && !["high", "medium", "low"].includes(item.evidence_confidence)) {
    errors.push(`evidence_confidence "${item.evidence_confidence}" must be high|medium|low`);
    failed_fields.push("evidence_confidence");
  }

  // ── Fact length ───────────────────────────────────────────────────────────
  if (item.fact && item.fact.split(/\s+/).length > 50) {
    warnings.push(`fact is ${item.fact.split(/\s+/).length} words (recommend ≤25 — may not be atomic)`);
    failed_fields.push("fact");
  }

  // ── Quote presence in source ─────────────────────────────────────────────
  if (item.source_quote && sourceText && sourceText.length > 50) {
    const normQuote  = item.source_quote.toLowerCase().replace(/[''""]/g, "'").replace(/\s+/g, " ").trim();
    const normSource = sourceText.toLowerCase().replace(/[''""]/g, "'").replace(/\s+/g, " ");

    if (!normSource.includes(normQuote.slice(0, 40))) {
      // Allow partial match: ≥60% of content words must appear in source
      const quoteWords = normQuote.split(" ").filter((w) => w.length > 3);
      const matchCount = quoteWords.filter((w) => normSource.includes(w)).length;
      const ratio = quoteWords.length > 0 ? matchCount / quoteWords.length : 0;

      if (ratio < 0.6) {
        warnings.push(`source_quote not found in source text (${Math.round(ratio * 100)}% word match — may be paraphrased or fabricated)`);
        // Don't fail on this — quoteVerification.js handles entailment later
      }
    }
  }

  // ── Numbers in fact must exist in source ─────────────────────────────────
  if (item.numbers?.length && sourceText && sourceText.length > 50) {
    const srcLower = sourceText.toLowerCase();
    for (const num of item.numbers) {
      const n = num.toLowerCase().replace(/[$,%]/g, "");
      if (n.length > 1 && !/^(19|20)\d{2}$/.test(n) && !srcLower.includes(n)) {
        warnings.push(`number "${num}" in item.numbers not found in source text — may be fabricated`);
      }
    }
  }

  // ── Best_used_for ─────────────────────────────────────────────────────────
  const VALID_USES = new Set(["case_study","trend_support","outlook_support","recommendation_support","chart_annotation"]);
  if (item.best_used_for) {
    const invalid = (item.best_used_for || []).filter((u) => !VALID_USES.has(u));
    if (invalid.length > 0) {
      warnings.push(`best_used_for contains invalid values: ${invalid.join(", ")}`);
    }
  }

  return {
    valid:         errors.length === 0,
    errors,
    warnings,
    failed_fields: [...new Set(failed_fields)],
  };
}

// ── Evidence judgment validator ───────────────────────────────────────────────

/**
 * Validate judgment output from judgeEvidenceItems.
 *
 * @param {object} judgment - One judgment from the judgments[] array
 * @param {string[]} validEvidenceIds - Expected evidence IDs
 * @returns {ValidationResult}
 */
export function validateEvidenceJudgment(judgment, validEvidenceIds = []) {
  const errors  = [];
  const warnings = [];
  const failed_fields = [];

  // ── Required fields ───────────────────────────────────────────────────────
  if (!judgment.evidence_id) {
    errors.push("missing evidence_id in judgment");
    failed_fields.push("evidence_id");
  }
  if (typeof judgment.direct_demonstration !== "boolean") {
    errors.push("direct_demonstration must be boolean");
    failed_fields.push("direct_demonstration");
  }
  if (typeof judgment.concrete_claim !== "boolean") {
    errors.push("concrete_claim must be boolean");
    failed_fields.push("concrete_claim");
  }

  // ── ID resolution ─────────────────────────────────────────────────────────
  if (judgment.evidence_id && validEvidenceIds.length > 0) {
    if (!validEvidenceIds.includes(judgment.evidence_id)) {
      errors.push(`evidence_id "${judgment.evidence_id}" not found in input items — hallucinated ID`);
      failed_fields.push("evidence_id");
    }
  }

  // ── Limitations vocabulary ────────────────────────────────────────────────
  for (const lim of (judgment.limitations || [])) {
    if (!VALID_LIMITATIONS.has(lim)) {
      warnings.push(`limitation "${lim}" not in VALID_LIMITATIONS — will be dropped`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, failed_fields: [...new Set(failed_fields)] };
}

// ── Synthesis output validator ────────────────────────────────────────────────

/**
 * Validate a strategic judgment from category synthesis.
 *
 * @param {object} judgment - One item from strategic_judgments[]
 * @param {Set<string>} allowedIds - Set of allowed evidence IDs from the dossier
 * @returns {ValidationResult}
 */
export function validateStrategicJudgmentOutput(judgment, allowedIds) {
  const errors  = [];
  const warnings = [];
  const failed_fields = [];

  const VALID_JUDGMENT_TYPES = new Set([
    "operational_shift", "capability_change", "adversary_adoption",
    "risk_elevation", "technique_evolution", "ecosystem_change",
    "monitoring_required", "early_signal",
  ]);
  const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

  if (!judgment.judgment || judgment.judgment.length < 10) {
    errors.push("judgment text missing or too short");
    failed_fields.push("judgment");
  }
  if (!VALID_JUDGMENT_TYPES.has(judgment.judgment_type)) {
    errors.push(`judgment_type "${judgment.judgment_type}" not valid`);
    failed_fields.push("judgment_type");
  }
  if (!VALID_CONFIDENCE.has(judgment.confidence)) {
    errors.push(`confidence "${judgment.confidence}" must be high|medium|low`);
    failed_fields.push("confidence");
  }
  if (!Array.isArray(judgment.evidence_for) || judgment.evidence_for.length === 0) {
    errors.push("evidence_for[] must be non-empty array");
    failed_fields.push("evidence_for");
  }

  // ── ID hallucination check ────────────────────────────────────────────────
  if (allowedIds) {
    const inventedIds = (judgment.evidence_for || []).filter((id) => !allowedIds.has(id));
    if (inventedIds.length > 0) {
      errors.push(`evidence_for contains invented IDs: ${inventedIds.join(", ")}`);
      failed_fields.push("evidence_for");
    }
    const inventedAgainst = (judgment.evidence_against || []).filter((id) => !allowedIds.has(id));
    if (inventedAgainst.length > 0) {
      errors.push(`evidence_against contains invented IDs: ${inventedAgainst.join(", ")}`);
      failed_fields.push("evidence_against");
    }
  }

  // ── Required reasoning fields ─────────────────────────────────────────────
  if (!judgment.what_changed || judgment.what_changed.length < 10) {
    errors.push("what_changed must be non-trivial (≥10 chars)");
    failed_fields.push("what_changed");
  }
  if (!judgment.causal_mechanism || judgment.causal_mechanism.length < 10) {
    errors.push("causal_mechanism must be non-trivial (≥10 chars)");
    failed_fields.push("causal_mechanism");
  }
  if (!judgment.uncertainty || judgment.uncertainty.length < 5) {
    warnings.push("uncertainty field is empty — should acknowledge what is not known");
    failed_fields.push("uncertainty");
  }

  return { valid: errors.length === 0, errors, warnings, failed_fields: [...new Set(failed_fields)] };
}

// ── Slide content validator ───────────────────────────────────────────────────

/**
 * Validate slide content output from generateSlideContent.
 *
 * @param {object} slide - Slide content output
 * @param {Set<string>} allowedEvidenceIds - Set of valid evidence IDs from dossier
 * @returns {ValidationResult}
 */
export function validateSlideContent(slide, allowedEvidenceIds = new Set()) {
  const errors  = [];
  const warnings = [];
  const failed_fields = [];

  // ── Headline ──────────────────────────────────────────────────────────────
  if (!slide.headline) {
    errors.push("missing headline");
    failed_fields.push("headline");
  } else if (slide.headline.split(/\s+/).length > 20) {
    errors.push(`headline is ${slide.headline.split(/\s+/).length} words (max 20)`);
    failed_fields.push("headline");
  }

  // ── Bullets ───────────────────────────────────────────────────────────────
  if (!Array.isArray(slide.bullets) || slide.bullets.length < 1) {
    errors.push("bullets[] must be non-empty array");
    failed_fields.push("bullets");
  } else {
    if (slide.bullets.length > 5) {
      errors.push(`too many bullets (${slide.bullets.length}, max 5)`);
      failed_fields.push("bullets");
    }
    const VALID_ROLES = new Set(["finding", "evidence", "implication", "caveat", "action"]);
    for (const b of slide.bullets) {
      if (b.bullet_role && !VALID_ROLES.has(b.bullet_role)) {
        errors.push(`invalid bullet_role "${b.bullet_role}"`);
        failed_fields.push("bullets");
      }
      const wordCount = (b.text || "").split(/\s+/).length;
      if (wordCount > 15) {
        warnings.push(`bullet "${(b.text || "").slice(0, 40)}..." is ${wordCount} words (max 15)`);
      }
    }
  }

  // ── Evidence callout ID validation ────────────────────────────────────────
  for (const callout of (slide.evidence_callouts || [])) {
    const id = callout.evidence_id;
    if (!id) {
      errors.push("evidence_callout missing evidence_id");
      failed_fields.push("evidence_callouts");
      continue;
    }
    if (!EV_ID_PATTERN.test(id) && !AGG_ID_PATTERN.test(id)) {
      errors.push(`evidence_id "${id}" has invalid format (must start with ev_ or agg_/metric_/analytics_)`);
      failed_fields.push("evidence_callouts");
    }
    if (allowedEvidenceIds.size > 0 && !allowedEvidenceIds.has(id)) {
      errors.push(`evidence_id "${id}" not found in dossier — invented ID`);
      failed_fields.push("evidence_callouts");
    }
  }

  // ── URL validation in callouts ────────────────────────────────────────────
  for (const callout of (slide.evidence_callouts || [])) {
    const url = callout.url;
    if (url && url !== "" && !URL_PATTERN.test(url)) {
      errors.push(`evidence_callout URL "${url}" must start with http:// or https://`);
      failed_fields.push("evidence_callouts");
    }
    if (url && URL_PATTERN.test(url) && isFabricatedUrl(url)) {
      errors.push(`evidence_callout URL "${url}" appears to be a fabricated domain`);
      failed_fields.push("evidence_callouts");
    }
  }

  return { valid: errors.length === 0, errors, warnings, failed_fields: [...new Set(failed_fields)] };
}

// ── Field-level retry ─────────────────────────────────────────────────────────

/**
 * Check if a field-level retry is warranted for a given task and failed fields.
 *
 * Returns { should_retry: boolean, retry_instructions: string | null }.
 * The retry_instructions can be prepended to the next LLM call's user prompt
 * to focus it on correcting only the failed field.
 *
 * @param {string}   taskName     - Task name from TASK_REGISTRY
 * @param {string[]} failedFields - List of field names that failed validation
 * @param {object}   failedItem   - The item with the failing field (for context)
 * @returns {{ should_retry: boolean, retry_instructions: string | null }}
 */
export function buildFieldRetryInstruction(taskName, failedFields, failedItem = {}) {
  if (!failedFields || failedFields.length === 0) {
    return { should_retry: false, retry_instructions: null };
  }

  const instructions = [];

  for (const field of failedFields) {
    switch (`${taskName}:${field}`) {
      case "evidence_extraction:source_quote":
        instructions.push(
          `CORRECTION REQUIRED: The previous extraction returned an empty or too-short source_quote. ` +
          `Find the verbatim span in the source text that supports the fact: "${(failedItem.fact || "").slice(0, 80)}". ` +
          `The source_quote must be copied exactly from the source text (≥12 chars).`
        );
        break;

      case "evidence_extraction:evidence_type":
        instructions.push(
          `CORRECTION REQUIRED: The evidence_type "${failedItem.evidence_type || "?"}" is not valid. ` +
          `Choose from: ${ALL_EVIDENCE_TYPES.join(", ")}.`
        );
        break;

      case "evidence_extraction:fact":
        instructions.push(
          `CORRECTION REQUIRED: The extracted fact is too long or not atomic. ` +
          `Rewrite it as ONE precise claim in ≤25 words. If it contains multiple assertions, pick the most important one.`
        );
        break;

      case "slide_content:headline":
        instructions.push(
          `CORRECTION REQUIRED: The headline is too long (>20 words). ` +
          `Rewrite it in ≤20 words while preserving the analytical meaning.`
        );
        break;

      case "slide_content:evidence_callouts":
        instructions.push(
          `CORRECTION REQUIRED: One or more evidence_callout.evidence_id values are not valid. ` +
          `Use ONLY evidence_ids from the supporting evidence list provided. ` +
          `Do not invent evidence_ids. If no valid ID exists, omit the callout.`
        );
        break;

      default:
        instructions.push(
          `CORRECTION REQUIRED: The field "${field}" failed validation. ` +
          `Check the output schema and correct this field.`
        );
    }
  }

  return {
    should_retry:        true,
    retry_instructions:  instructions.join("\n\n"),
  };
}

// ── URL validator (standalone utility) ───────────────────────────────────────

/**
 * Validate a URL from LLM output — must be http/https and non-fabricated.
 *
 * @param {string} url
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateLlmOutputUrl(url) {
  if (!url || url === "") return { valid: true, reason: null }; // empty = OK (optional field)
  if (!URL_PATTERN.test(url)) {
    return { valid: false, reason: `URL must start with http:// or https://, got: "${url}"` };
  }
  if (isFabricatedUrl(url)) {
    return { valid: false, reason: `URL appears to be a fabricated/placeholder domain: "${url}"` };
  }
  return { valid: true, reason: null };
}

// ── Batch validation helpers ──────────────────────────────────────────────────

/**
 * Validate all items in an evidence extraction batch.
 * Returns { valid: object[], invalid: object[] } where invalid items include
 * their validation results and are candidates for field-level retry.
 *
 * @param {object[]} items      - Evidence items to validate
 * @param {string}   sourceText - Source text for quote presence checks
 */
export function validateEvidenceBatch(items, sourceText = "") {
  const valid   = [];
  const invalid = [];

  for (const item of items) {
    const result = validateEvidenceItem(item, sourceText);
    if (result.valid) {
      valid.push(item);
    } else {
      invalid.push({ item, validation: result });
    }
  }

  return { valid, invalid };
}

/**
 * Validate all judgments from a category synthesis call.
 * Returns { valid: object[], invalid: object[] }.
 *
 * @param {object[]}  judgments  - strategic_judgments[] from synthesis
 * @param {Set<string>} allowedIds - Allowed evidence IDs
 */
export function validateSynthesisBatch(judgments, allowedIds) {
  const valid   = [];
  const invalid = [];

  for (const j of (judgments || [])) {
    const result = validateStrategicJudgmentOutput(j, allowedIds);
    if (result.valid) {
      valid.push(j);
    } else {
      invalid.push({ judgment: j, validation: result });
    }
  }

  return { valid, invalid };
}
