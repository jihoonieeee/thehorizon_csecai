/**
 * qaExplanations()
 *
 * Verifies that the explanation summary and bullets faithfully represent the
 * approved evidence. Does not check plausibility — checks fidelity.
 *
 * Layer 1 — deterministic (always):
 *   • Summary length: flags if >30 words
 *   • Bullet length: flags if any bullet >40 words
 *   • Point count: flags if <2 points
 *
 * Layer 2 — LLM fidelity check (Haiku, per insight):
 *   Checks every item (summary + each bullet) clause-by-clause against the
 *   full approved evidence (fact + quote per cited source).
 *   UNSUPPORTED: summary is cleared; bullet is removed.
 *   INFERRED:    accepted only for strictly necessary logical consequences that
 *                introduce no new entity, number, date, causal claim, or
 *                technical detail. When uncertain, the model prefers UNSUPPORTED.
 *   SUPPORTED:   kept as-is.
 *
 * Prompt: lib/prompts/analysis/qa-grounding.md
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

const GROUNDING_SCHEMA = {
  type: "object",
  properties: {
    summary_check: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["SUPPORTED", "INFERRED", "UNSUPPORTED"] },
        reason:  { type: "string" },
      },
      required: ["verdict"],
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["SUPPORTED", "INFERRED", "UNSUPPORTED"] },
          reason:  { type: "string" },
        },
        required: ["verdict"],
      },
    },
  },
  required: ["summary_check", "checks"],
};

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("analysis/qa-grounding");
  return _prompts;
}

// ── Layer 1: deterministic ────────────────────────────────────────────────────

function deterministicCheck(insight) {
  const issues = [];
  const points = insight.explanation_points || [];

  if (points.length < 2) issues.push("too_few_points");
  if ((insight.explanation_summary || "").split(/\s+/).length > 30) issues.push("summary_too_long");
  for (let i = 0; i < points.length; i++) {
    if (points[i].split(/\s+/).length > 40) issues.push(`point_${i}_too_long`);
  }

  return issues;
}

// ── Layer 2: evidence block builder ──────────────────────────────────────────
// Passes the complete approved evidence (fact + quote + evidence_summary) so
// the checker can verify against the full content, not only an isolated quote.

function buildEvidenceBlock(insight) {
  const blocks = (insight.cited_sources || []).map((cs, i) => {
    const lines = [`[Source ${i + 1}] ${cs.publisher || cs.source_title} [${cs.trust_tier || "unknown"}]`];
    // evidence_summary is the one-sentence description of what this source contributes
    if (cs.evidence_summary) lines.push(`  Contribution: ${cs.evidence_summary}`);
    // The verbatim quote from the source — the primary grounding text
    if (cs.quote)            lines.push(`  Quote: "${cs.quote}"`);
    return lines.join("\n");
  });
  return blocks.join("\n\n") || "(no evidence available)";
}

// ── Layer 2: LLM fidelity check ──────────────────────────────────────────────

async function groundingCheck(insight) {
  const points  = insight.explanation_points || [];
  const summary = insight.explanation_summary || "";

  if (!points.length && !summary) {
    return { kept_summary: null, kept: [], removed_summary: false, removed: 0, grounding_issues: ["no_content"] };
  }

  const evidenceBlock    = buildEvidenceBlock(insight);
  const pointsNumbered   = points.map((p, i) => `${i + 1}. ${p}`).join("\n");

  const { system, user: userTmpl } = getPrompts();
  const user = interpolate(userTmpl, {
    evidence_block:  evidenceBlock,
    summary_text:    summary || "(no summary)",
    points_numbered: pointsNumbered || "(no bullets)",
    point_count:     points.length,
  });

  let raw;
  try {
    const { result } = await routedLLM(system, user, {
      task: "source_filtering",
      requires_json: true,
      schema: GROUNDING_SCHEMA,
    });
    raw = typeof result === "string" ? JSON.parse(result) : result;
  } catch (err) {
    // Check failed — keep everything rather than silently removing grounded content
    process.stdout.write(`  [QA] grounding check failed: ${err.message} — keeping all content\n`);
    return {
      kept_summary:    summary,
      kept:            points,
      removed_summary: false,
      removed:         0,
      grounding_issues: [`grounding_check_error: ${err.message}`],
    };
  }

  const grounding_issues = [];

  // ── Check summary ───────────────────────────────────────────────────────────
  const summaryVerdict = raw?.summary_check?.verdict;
  let kept_summary     = summary;
  let removed_summary  = false;

  if (summaryVerdict === "UNSUPPORTED") {
    grounding_issues.push(`summary_unsupported: ${raw.summary_check?.reason || ""}`);
    kept_summary    = null;
    removed_summary = true;
  }

  // ── Check bullets ───────────────────────────────────────────────────────────
  const checks = raw?.checks || [];
  const kept   = [];

  for (let i = 0; i < points.length; i++) {
    const check = checks[i];
    if (!check) {
      // Model returned fewer checks than points — when uncertain, remove
      grounding_issues.push(`point_${i + 1}_no_verdict: model did not return a check`);
      // Do not keep — missing verdict is itself a signal of uncertainty
      continue;
    }
    if (check.verdict === "UNSUPPORTED") {
      grounding_issues.push(`point_${i + 1}_unsupported: ${check.reason || ""}`);
    } else {
      // SUPPORTED or INFERRED — keep
      kept.push(points[i]);
    }
  }

  return {
    kept_summary,
    kept,
    removed_summary,
    removed: points.length - kept.length,
    grounding_issues,
  };
}

// ── Per-insight QA ────────────────────────────────────────────────────────────

async function qaOneInsight(insight, opts) {
  const det_issues = deterministicCheck(insight);

  const hasEvidence = (insight.cited_sources || []).some(cs => cs.quote || cs.evidence_summary);
  const hasContent  = (insight.explanation_points?.length > 0) || !!insight.explanation_summary;

  let groundResult = {
    kept_summary:    insight.explanation_summary || null,
    kept:            insight.explanation_points  || [],
    removed_summary: false,
    removed:         0,
    grounding_issues: [],
  };

  if (!opts.skipLlm && hasEvidence && hasContent) {
    groundResult = await groundingCheck(insight);
  }

  const explanation_summary = groundResult.kept_summary;
  const explanation_points  = groundResult.kept;
  const qa_issues = [...det_issues, ...groundResult.grounding_issues];
  const needs_regen = (
    explanation_points.length < 2 &&
    (insight.explanation_points || []).length >= 2
  ) || (
    groundResult.removed_summary && !explanation_summary
  );

  return {
    ...insight,
    explanation_summary,
    explanation_points,
    explanation_qa: {
      det_issues,
      grounding_issues: groundResult.grounding_issues,
      summary_removed:  groundResult.removed_summary,
      points_removed:   groundResult.removed,
      needs_regen,
      qa_issues,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run fidelity QA on all explanation summaries and points.
 *
 * @param {object[]} categoryAnalyses - After generateExplanations()
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]
 * @returns {Promise<object[]>}
 */
export async function qaExplanations(categoryAnalyses, opts = {}) {
  let totalRemoved  = 0;
  let totalChecked  = 0;
  let summaryFailed = 0;

  const output = await Promise.all(
    categoryAnalyses.map(async ca => {
      const checkedInsights = await Promise.all(
        (ca.insights || []).map(async ins => {
          if (ins.blocked) return ins;
          if (!ins.explanation_points?.length && !ins.explanation_summary) return ins;
          totalChecked++;
          const result = await qaOneInsight(ins, opts);
          totalRemoved  += result.explanation_qa?.points_removed   || 0;
          summaryFailed += result.explanation_qa?.summary_removed  ? 1 : 0;
          return result;
        })
      );
      return { ...ca, insights: checkedInsights };
    })
  );

  if (totalChecked > 0) {
    process.stdout.write(
      `  [QA] grounding: ${totalChecked} insights checked` +
      `, ${totalRemoved} bullet(s) removed` +
      (summaryFailed > 0 ? `, ${summaryFailed} summary/summaries cleared` : "") +
      `\n`
    );
  }

  return output;
}
