/**
 * Taxonomy QA Layer — Second-Model Validation (Validated AI Threat Taxonomy)
 *
 * Two-pass QA over the taxonomy produced by understandSource.js (Layer 4):
 *
 *   Pass 1 (always): Deterministic checks via taxonomyValidation.validateThreatTag
 *     - tag exists in registry and is a primary_threat (not a secondary dimension)
 *     - tag's domain matches the assigned domain
 *     - evidence is specific (not generic AI-risk talk) and the source is traceable
 *     - AI-enabled tags carry a paired operational mapping + AI modifier
 *
 *   Pass 2 (optional): Second-model semantic validation — flags tags to REMOVE.
 *
 * Output: { qa_pass, primary_threat_tags, secondary_dimensions,
 *           corrected_primary_domain, issues, confidence_adjustment, second_model_used }
 *
 * Behaviour: never adds tags; removes/downgrades unsupported ones.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { validateThreatTags, validateSecondaryDimensions } from "../../config/taxonomyValidation.js";
import { TAXONOMY, SECONDARY_DIMENSIONS } from "../../config/taxonomyRegistry.js";

// ── Pass 1: deterministic validation ───────────────────────────────────────────

function deterministicCheck(source) {
  const u = source.understanding || {};
  const issues = [];

  const { all } = validateThreatTags(u.primary_threat_tags || [], source);
  const kept = [];
  for (const r of all) {
    if (r.validation_status === "rejected") {
      issues.push(`primary_threat_tag "${r.tag}" rejected: ${r.caveat_if_any}`);
      continue;
    }
    if (r.validation_status === "weak" || r.validation_status === "needs_manual_review") {
      issues.push(`primary_threat_tag "${r.tag}" ${r.validation_status}: ${r.caveat_if_any}`);
    }
    kept.push(r);
  }

  if (kept.length > 4) {
    issues.push(`Over-assignment: ${kept.length} primary threat tags (max recommended 4)`);
  }

  return {
    primary_threat_tags:  kept,
    secondary_dimensions: validateSecondaryDimensions(u.secondary_dimensions || []),
    issues,
    structurally_valid:   issues.length === 0,
  };
}

// ── Pass 2: second-model semantic validation ───────────────────────────────────

const SECOND_MODEL_SCHEMA = {
  type: "object",
  required: ["qa_pass", "issues", "confidence_adjustment"],
  properties: {
    qa_pass:                  { type: "boolean" },
    corrected_primary_domain: { type: ["string", "null"] },
    tags_to_remove:           { type: "array", items: { type: "string" } },
    issues:                   { type: "array", items: { type: "string" } },
    confidence_adjustment:    { type: ["string", "null"] },
  },
};

// Build a compact tag reference for the second model — one line per tag showing
// the domain and threat_meaning so the validator can check correctness without
// having the full taxonomy injected.
function buildTagReference() {
  const lines = ["TAG REFERENCE (domain → tag: meaning):"];
  const domains = {
    traditional_ai_threats: "TRAD",
    llm_threats: "LLM",
    agentic_ai_threats: "AGENT",
    ai_enabled_threats: "AI_ENABLED",
  };
  for (const [domain, abbr] of Object.entries(domains)) {
    for (const [tag, entry] of Object.entries(TAXONOMY)) {
      if (entry.domain !== domain) continue;
      lines.push(`  [${abbr}] ${tag}: ${entry.threat_meaning.slice(0, 100)}`);
    }
  }
  const secDims = Object.keys(SECONDARY_DIMENSIONS).join(", ");
  lines.push(`SECONDARY DIMENSIONS (never primary threats): ${secDims}`);
  return lines.join("\n");
}

const _tagReference = buildTagReference();

const SECOND_MODEL_SYSTEM = `You are a second-opinion validator for the Validated AI Threat Taxonomy.
You are given a source and a proposed set of PRIMARY THREAT TAGS. Validate quality — focus on REMOVING incorrectly applied tags, never adding new ones.

${_tagReference}

RULES
1. A tag is valid only if the source SUBSTANTIVELY describes that adversarial threat behaviour — not a passing mention.
2. Secondary dimensions (misinformation, overreliance, excessive_agency, resource_overload, cascading_hallucination) must never be primary threats.
3. Domain rules: [TRAD] = ML model/training/inference/supply chain attacked; [LLM] = LLM-specific (prompts/guardrails/context/RAG); [AGENT] = AI acts through tools/MCP/memory/workflow; [AI_ENABLED] = AI is the attacker's weapon.
4. AI-enabled tags require a real operational ATT&CK technique (e.g. T1566, T1059) plus AI modifier — T1588.007 alone or "required per case" is not enough.
5. Prefer 1–3 high-confidence tags over many uncertain ones.

Return strict JSON:
- qa_pass: false if significant errors found
- corrected_primary_domain: the correct domain if wrong, else null
- tags_to_remove: tag names to remove (empty if all valid)
- issues: specific problems
- confidence_adjustment: "downgrade" | "upgrade" | null`;

function buildSecondModelPrompt(source, tags) {
  const u = source.understanding || {};
  const tagList = tags
    .map((t) => `  - ${t.tag} [${t.domain}] (${t.confidence}/${t.validation_status}): "${(t.supporting_quote || "").slice(0, 200)}"`)
    .join("\n");
  return [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}`,
    `PRIMARY DOMAIN: ${u.primary_domain || "(none)"}`,
    `SUMMARY: ${(u.source_summary || "").slice(0, 500)}`,
    ``,
    `PROPOSED PRIMARY THREAT TAGS:`,
    tagList || "  (none)",
    ``,
    `SOURCE TEXT (excerpt, up to 2500 chars):`,
    (source.clean_text || source.full_text || source.summary || "").slice(0, 2500),
    ``,
    `Validate the tagging against the source content. Return your QA result.`,
  ].join("\n");
}

// Auto-trigger logic: run second-model QA when first-pass quality is uncertain.
// Always runs for "weak" or "needs_manual_review" tags; optionally for all validated.
function shouldRunSecondModel(deterministicResult, opts) {
  if (opts.skipSecondModel === true) return false;

  const tags = deterministicResult.primary_threat_tags;
  if (tags.length === 0) return false;

  // If caller explicitly enables, run always.
  if (opts.skipSecondModel === false) return true;

  // Default: auto-trigger when any tag is weak or needs_manual_review.
  const hasUncertainTags = tags.some((t) =>
    t.validation_status === "weak" || t.validation_status === "needs_manual_review"
  );
  return hasUncertainTags;
}

function applyCorrections(deterministicResult, secondModelResult) {
  let tags = deterministicResult.primary_threat_tags;
  const issues = [...deterministicResult.issues];
  let confidence_adjustment = null;
  let corrected_primary_domain = null;
  let second_model_used = false;

  if (secondModelResult) {
    second_model_used = true;
    const toRemove = new Set(secondModelResult.tags_to_remove || []);
    if (toRemove.size) {
      const removed = tags.filter((t) => toRemove.has(t.tag));
      tags = tags.filter((t) => !toRemove.has(t.tag));
      removed.forEach((t) => issues.push(`Second model: "${t.tag}" removed as unsupported`));
    }
    if (secondModelResult.corrected_primary_domain) {
      corrected_primary_domain = secondModelResult.corrected_primary_domain;
      issues.push(`Second model: suggests primary_domain="${corrected_primary_domain}"`);
    }
    if (secondModelResult.confidence_adjustment) confidence_adjustment = secondModelResult.confidence_adjustment;
    if (Array.isArray(secondModelResult.issues)) issues.push(...secondModelResult.issues.map((i) => `Second model: ${i}`));
  }

  const qa_pass = !issues.some((i) => i.includes("rejected") || i.includes("removed")) && deterministicResult.structurally_valid;

  return {
    qa_pass,
    primary_threat_tags: tags,
    secondary_dimensions: deterministicResult.secondary_dimensions,
    corrected_primary_domain,
    issues,
    confidence_adjustment,
    second_model_used,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * QA a single source's taxonomy tags.
 *
 * Second-model behaviour (opts.skipSecondModel):
 *   true  — always skip (deterministic only)
 *   false — always run second model
 *   undefined (default) — auto: runs when any tag is weak or needs_manual_review
 */
export async function qaTaxonomyTags(source, opts = {}) {
  const deterministicResult = deterministicCheck(source);

  let secondModelResult = null;
  if (shouldRunSecondModel(deterministicResult, opts)) {
    try {
      const { result } = await routedLLM(
        SECOND_MODEL_SYSTEM,
        buildSecondModelPrompt(source, deterministicResult.primary_threat_tags),
        { task: "final_qa", requires_json: true, schema: SECOND_MODEL_SCHEMA,
          logLabel: `taxonomy-qa-${source.id?.slice(0, 20) || "unknown"}` }
      );
      if (result) secondModelResult = result;
    } catch (err) {
      process.stdout.write(`  [taxonomy-qa] Second model failed: ${err.message} — deterministic only\n`);
    }
  }

  return applyCorrections(deterministicResult, secondModelResult);
}

export async function qaAllTaxonomyTags(sources, opts = {}) {
  // skipSecondModel: true=always skip, false=always run, undefined(default)=auto (runs for weak tags).
  const { concurrency = 5 } = opts;
  const results = new Array(sources.length);

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (source) => {
      // Forward skipSecondModel from opts so callers can override the auto behaviour.
      const qa = await qaTaxonomyTags(source, { skipSecondModel: opts.skipSecondModel });
      return {
        ...source,
        taxonomy_qa: qa,
        understanding: {
          ...source.understanding,
          primary_threat_tags:  qa.primary_threat_tags,
          secondary_dimensions: qa.secondary_dimensions,
        },
      };
    }));
    for (let j = 0; j < batch.length; j++) results[i + j] = batchResults[j];
  }

  const withIssues = results.filter((s) => (s.taxonomy_qa?.issues || []).length > 0);
  if (withIssues.length > 0) {
    process.stdout.write(`  [taxonomy-qa] ${withIssues.length}/${sources.length} sources had taxonomy issues\n`);
  }
  return results;
}
