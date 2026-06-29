/**
 * Defensive source sub-pipeline
 *
 * Sources flagged is_defensive=true by understandSource() are routed here for
 * deeper classification and QA. Defensive sources still carry an offensive
 * category (the threat domain being defended against) and the "defensive" tag,
 * but this pass extracts richer context about WHAT is being defended and HOW.
 *
 * Output: { classified, qa_report, counts }
 *   classified — array of enriched source objects (same shape as understandSource output
 *                plus defensive_analysis field)
 *   qa_report  — per-source QA checks
 *   counts     — summary stats
 */

import { callLLM }            from "../llm/callLLM.js";
import { routedLLM }          from "../llm/llmRouter.js";
import { DOMAINS, DEFENSIVE_FOCUS_AREAS, DEFENSIVE_TAG, PRIMARY_TAGS } from "./taxonomy.js";

const CLASSIFY_VERSION = "defensive-v1.0";

// ── QA checks ─────────────────────────────────────────────────────────────────

function qaDefensiveSource(source) {
  // Hard failures = the source is mis-routed or incoherent (correctness).
  // Soft warnings  = an optional enrichment field is missing (completeness) —
  // these must NOT fail the source, or a quota-degraded run flags everything.
  const issues = [];    // hard — drives pass/fail
  const warnings = [];  // soft — informational only

  if (!source.is_defensive) {
    issues.push("is_defensive not set — should not be in defensive branch");
  }
  if (!DOMAINS.includes(source.category)) {
    issues.push(`category '${source.category}' is not a valid offensive domain`);
  }
  if (source.category === "unclear_or_adjacent") {
    issues.push("unclear_or_adjacent: defensive source should map to a specific offensive domain");
  }
  if (!source.primary_tags?.includes(DEFENSIVE_TAG)) {
    issues.push(`missing '${DEFENSIVE_TAG}' in primary_tags`);
  }
  if (!source.defensive_techniques?.length) {
    warnings.push("no defensive_techniques extracted — enrichment incomplete (re-run when LLM quota available)");
  }

  return { source_id: source.id, issues, warnings, pass: issues.length === 0 };
}

// ── LLM enrichment (optional deeper call) ─────────────────────────────────────

// Flat schema only — nested object arrays cause Anthropic (which doesn't enforce
// JSON schema) to emit malformed JSON and truncate. framework_mappings is a flat
// string array ("NIST CSF: PR.DS", "MITRE D3FEND: D3-..."), not nested objects.
const ENRICHMENT_SCHEMA = {
  type: "object",
  properties: {
    confirmed_offensive_category: { type: "string", enum: DOMAINS },
    defensive_summary:            { type: "string" },
    specific_threats_addressed:   { type: "array", items: { type: "string" } },
    framework_mappings:           { type: "array", items: { type: "string" } },
    maturity_signal:              { type: "string", enum: ["proof_of_concept", "deployed", "standardized", "theoretical"] },
    defensive_techniques:         { type: "array", items: { type: "string", enum: DEFENSIVE_FOCUS_AREAS } },
  },
  required: ["confirmed_offensive_category", "defensive_summary", "defensive_techniques"],
};

const OFFENSIVE_TAGS_BY_DOMAIN = Object.fromEntries(
  DOMAINS.map(d => [d, PRIMARY_TAGS.filter(t => t.domain === d).map(t => `${t.id} "${t.label}"`).join(", ")]),
);

function buildEnrichmentPrompt(source) {
  const text = (source.full_text || source.short_summary || "").slice(0, 4000);
  const domainTags = OFFENSIVE_TAGS_BY_DOMAIN[source.category] || "";

  return {
    system: `You are an AI security analyst specialising in defensive measures against AI threats.
You are reviewing a source already classified as primarily DEFENSIVE (mitigation/detection/hardening focus).

Your tasks:
1. Confirm which offensive threat domain this defense targets (confirmed_offensive_category).
2. Write a 1-2 sentence defensive_summary explaining what the defense does and what attack it counters.
3. List specific_threats_addressed — exact attack names or technique IDs from the taxonomy being mitigated.
4. Map to known frameworks where applicable, as a flat array of "FRAMEWORK: control" strings (e.g. "MITRE D3FEND: D3-NTA", "NIST CSF: PR.DS"). Do NOT use nested objects.
5. Assess maturity_signal: is this deployed in production, a PoC, a proposed standard, or theoretical?
6. defensive_techniques (REQUIRED): pick 1-3 that best describe the defensive approach, using ONLY these exact values:
   ${DEFENSIVE_FOCUS_AREAS.join(", ")}
   Always return at least one (use "other_defensive" if none fit well).

OFFENSIVE TAGS FOR THIS DOMAIN (${source.category}): ${domainTags}

Return valid JSON only, with keys: confirmed_offensive_category, defensive_summary, specific_threats_addressed, framework_mappings, maturity_signal, defensive_techniques.`,
    user: `TITLE: ${source.title}
PUBLISHER: ${source.publisher || "unknown"}
ALREADY CLASSIFIED AS: category=${source.category}, defensive_techniques=${(source.defensive_techniques || []).join(", ")}

TEXT:
${text}`,
  };
}

// ── Main sub-pipeline ─────────────────────────────────────────────────────────

/**
 * Classify and QA a batch of defensive sources.
 *
 * @param {object[]} defensiveSources   - Sources where is_defensive=true
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]    - Skip enrichment LLM call (QA only)
 * @param {number}   [opts.concurrency]
 * @returns {Promise<{ classified: object[], qa_report: object[], counts: object }>}
 */
export async function classifyDefensiveSources(defensiveSources, opts = {}) {
  const { skipLlm = false, concurrency = 5 } = opts;

  if (!defensiveSources.length) {
    return { classified: [], qa_report: [], counts: { total: 0, qa_pass: 0, qa_fail: 0, enriched: 0 } };
  }

  const classified = [];
  const qa_report  = [];

  for (let i = 0; i < defensiveSources.length; i += concurrency) {
    const batch = defensiveSources.slice(i, i + concurrency);
    const enriched = await Promise.all(batch.map(async source => {
      let defensive_analysis = null;

      if (!skipLlm) {
        try {
          const { system, user } = buildEnrichmentPrompt(source);
          // Prefer routedLLM (task-aware, Anthropic-capable) so enrichment still
          // runs when the OpenAI/Gemini free tiers are exhausted; fall back to callLLM.
          let parsed;
          try {
            const { result } = await routedLLM(system, user, {
              task: "source_understanding", requires_json: true, schema: ENRICHMENT_SCHEMA,
            });
            parsed = typeof result === "string" ? JSON.parse(result) : result;
          } catch {
            const raw = await callLLM(system, user, { schema: ENRICHMENT_SCHEMA, json: true });
            parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          }

          // If LLM suggests a different offensive category, trust it (it has more context)
          const confirmedCategory = DOMAINS.includes(parsed.confirmed_offensive_category)
            ? parsed.confirmed_offensive_category
            : source.category;

          // Extract defensive_techniques here (the cheap understand call often omits
          // them); validate against the controlled vocabulary.
          const techniques = (Array.isArray(parsed.defensive_techniques) ? parsed.defensive_techniques : [])
            .filter(t => DEFENSIVE_FOCUS_AREAS.includes(t)).slice(0, 3);

          defensive_analysis = {
            confirmed_offensive_category: confirmedCategory,
            defensive_summary:            (parsed.defensive_summary || "").slice(0, 500),
            specific_threats_addressed:   (parsed.specific_threats_addressed || []).slice(0, 6),
            framework_mappings:           (parsed.framework_mappings || []).slice(0, 4),
            maturity_signal:              parsed.maturity_signal || null,
            _version: CLASSIFY_VERSION,
          };

          // Backfill defensive_techniques onto the source if the understand call left
          // them empty (so QA passes and the writeback persists them).
          const mergedTechniques = (source.defensive_techniques?.length ? source.defensive_techniques : techniques);

          return {
            ...source,
            category: confirmedCategory,
            defensive_techniques: mergedTechniques,
            defensive_analysis,
          };
        } catch {
          // Enrichment failure is non-fatal — keep source as-is
        }
      }

      return { ...source, defensive_analysis };
    }));

    classified.push(...enriched);

    for (const s of enriched) {
      qa_report.push(qaDefensiveSource(s));
    }
  }

  const qa_pass  = qa_report.filter(r => r.pass).length;
  const qa_fail  = qa_report.filter(r => !r.pass).length;
  const qa_warn  = qa_report.filter(r => r.pass && r.warnings?.length).length;
  const enriched = classified.filter(s => s.defensive_analysis).length;

  return {
    classified,
    qa_report,
    counts: {
      total:    defensiveSources.length,
      qa_pass,
      qa_fail,
      qa_warn,
      enriched,
    },
  };
}

/**
 * Split a batch of understood sources into offensive and defensive arrays.
 * Defensive sources (is_defensive=true) are routed to classifyDefensiveSources.
 * Offensive sources continue through the normal pipeline path.
 */
export function splitByDefensive(sources) {
  const defensive = sources.filter(s => s.is_defensive);
  const offensive = sources.filter(s => !s.is_defensive);
  return { offensive, defensive };
}
