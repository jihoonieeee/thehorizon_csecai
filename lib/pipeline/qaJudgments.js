/**
 * v2 — Step 4: Two-pass QA on synthesis judgments.
 *
 * Pass 1 (deterministic, free):
 *   - Analytical quality gate: blocks summary_only and unsupported via rateJudgmentQuality()
 *   - Single-source confidence cap: high → medium when only 1 evidence item
 *   - Evidence re-resolution: drops unresolved IDs, re-checks evidence_for is non-empty
 *
 * Pass 2 (second-model LLM — Sonnet checking Opus output):
 *   - For each judgment that passed Pass 1, sends the judgment text + actual evidence
 *     facts to a second model and asks: "Is this claim genuinely supported?"
 *   - Verdicts:
 *       supported      — claim accurately reflects the evidence
 *       needs_caveat   — claim is plausible but broader than evidence warrants; adds caveat
 *       unsupported    — claim contradicts evidence, invents detail, or cannot be supported
 *   - Unsupported judgments are blocked. needs_caveat judgments get an appended caveat.
 *
 * The second-model (Sonnet) is intentionally different from synthesis (Opus) to provide
 * an independent check rather than a correlated error.
 */

import { routedLLM }                from "../llm/llmRouter.js";
import { rateJudgmentQuality }     from "./analysis/analyticalQualityQa.js";
import { checkStatisticalClaims, scrubImpliedQuantitatives } from "./analysis/statisticalClaimQa.js";

const QUALITY_RANK = { unsupported: 0, summary_only: 1, descriptive: 2, analytical: 3, strategic: 4 };
const MINIMUM_QUALITY = "analytical"; // descriptive and below are blocked

// ── Pass 1: Deterministic gates ───────────────────────────────────────────────

function deterministicQa(judgment, evidence_index) {
  const issues   = [...(judgment.qa_issues || [])];
  let confidence = judgment.confidence || "low";

  // Re-resolve evidence IDs against actual index (synthesis may hallucinate IDs)
  const resolved = (judgment.evidence_for || []).filter(id => id in evidence_index);

  // Analytical quality gate
  const quality = rateJudgmentQuality({ ...judgment, evidence_for: resolved });
  if ((QUALITY_RANK[quality] ?? 0) < (QUALITY_RANK[MINIMUM_QUALITY] ?? 0)) {
    return {
      ...judgment,
      evidence_for:      resolved,
      analytical_quality: quality,
      qa_issues:         [...issues, `analytical_quality_blocked:${quality}`],
      blocked:           true,
      blocked_reason:    `analytical_quality:${quality}`,
    };
  }

  // Single-source cannot be high confidence
  if (resolved.length <= 1 && confidence === "high") {
    confidence = "medium";
    issues.push("single_source_confidence_capped_to_medium");
  }

  return {
    ...judgment,
    evidence_for:       resolved,
    confidence,
    analytical_quality: quality,
    qa_issues:          issues,
    blocked:            false,
  };
}

// ── Pass 2: Second-model LLM verification ────────────────────────────────────

const SECOND_MODEL_SYSTEM = `You are a rigorous fact-checker for AI threat intelligence reports.

You will receive strategic analytical judgments and the evidence items each judgment cites.
Your job: verify whether each judgment is genuinely supported by its evidence.

VERDICT OPTIONS:
  supported     — the judgment accurately reflects what the evidence shows; no material overstatement
  needs_caveat  — the judgment is directionally correct but overstates scope, certainty, or breadth beyond what evidence shows; provide a specific corrective caveat
  unsupported   — the judgment contradicts the evidence, invents details not present, or makes claims the evidence cannot support

STRICT RULES:
- Numbers in the judgment must match numbers in the evidence. Invented or rounded-up statistics → unsupported.
- "Attack observed in the wild" / "actively exploited" requires actual incident or threat-intel evidence, not just research papers.
- A judgment that is merely thin or uncertain is NOT unsupported — that is a confidence issue, already handled. Only mark unsupported if the evidence actively contradicts the judgment or the judgment invents material facts.
- Keep reasons concise (1-2 sentences). Keep caveats actionable and specific.

Return JSON only. No commentary outside the JSON object.`;

const SECOND_MODEL_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "verdict", "reason"],
        properties: {
          index:   { type: "number" },
          verdict: { type: "string", enum: ["supported", "needs_caveat", "unsupported"] },
          reason:  { type: "string" },
          caveat:  { type: ["string", "null"] },
        },
      },
    },
  },
};

async function runSecondModelVerification(judgments, evidence_index, category) {
  const items = judgments.map((j, i) => {
    const facts = (j.evidence_for || [])
      .map(id => evidence_index[id])
      .filter(Boolean)
      .map(ev => [ev.fact, ev.quote && ev.quote_grounded ? `"${ev.quote}"` : null].filter(Boolean).join(" — "))
      .filter(Boolean)
      .slice(0, 5);

    return {
      index:        i,
      judgment:     j.judgment     || "",
      what_changed: j.what_changed || "",
      confidence:   j.confidence   || "low",
      evidence:     facts.length   ? facts.map(f => `  • ${f}`).join("\n") : "  (no resolved evidence facts)",
    };
  });

  if (!items.length) return null;

  const userPrompt = `THREAT CATEGORY: ${category.replace(/_/g, " ").toUpperCase()}

${items.map(({ index, judgment, what_changed, confidence, evidence }) =>
  `[J${index}] (${confidence} confidence)
Judgment: "${judgment}"
What changed: "${what_changed}"
Evidence cited:
${evidence}`
).join("\n\n")}

Verify each judgment [J0], [J1], … against its evidence. Return:
{ "verdicts": [ { "index": 0, "verdict": "supported"|"needs_caveat"|"unsupported", "reason": "...", "caveat": "..."|null }, ... ] }`;

  try {
    const { result } = await routedLLM(SECOND_MODEL_SYSTEM, userPrompt, {
      task:          "final_qa",
      requires_json: true,
      schema:        SECOND_MODEL_SCHEMA,
      logLabel:      `qa-judgments-${category}`,
    });
    return Array.isArray(result?.verdicts) ? result.verdicts : null;
  } catch (err) {
    console.warn(`  [QA] second-model check failed for ${category}: ${err.message}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Two-pass QA on a category's synthesis judgments.
 *
 * @param {object[]} judgments      - From synthesizeCategory() (already through evaluateJudgments)
 * @param {object}   evidence_index - { ev_id: { fact, quote, quote_grounded, trust_tier, ... } }
 * @param {string}   category       - Threat category key
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlmQa=false]  - Skip Pass 2 (useful for testing)
 * @returns {Promise<{ judgments: object[], qa_report: object }>}
 */
export async function qaJudgments(judgments, evidence_index, category, opts = {}) {
  const { skipLlmQa = false } = opts;

  const report = {
    input_count:               judgments.length,
    already_blocked:           judgments.filter(j => j.blocked).length,
    analytical_quality_blocked: 0,
    confidence_adjusted:       0,
    stat_flags_added:          0,
    hype_terms_scrubbed:       0,
    llm_qa_run:                false,
    llm_unsupported:           0,
    llm_needs_caveat:          0,
    output_count:              0,
  };

  // Pass 1: deterministic analytical quality + confidence gates
  let result = judgments.map(j => {
    if (j.blocked) return j;
    const gated = deterministicQa(j, evidence_index);
    if (gated.blocked)                          report.analytical_quality_blocked++;
    if (gated.confidence !== j.confidence)      report.confidence_adjusted++;
    return gated;
  });

  // Pass 1b: statistical claim check + hype scrubbing (deterministic, free)
  // Build evidence text pool from the evidence_index for this category
  const evidencePackets = Object.values(evidence_index).map(ev => ({
    fact:         ev.fact        || "",
    source_quote: ev.quote       || "",
    numbers:      (ev.numbers    || []).map(n => n.value || ""),
  }));

  result = result.map(j => {
    if (j.blocked) return j;

    const allText = [j.judgment, j.what_changed, j.causal_mechanism, j.why_this_matters]
      .filter(Boolean).join(" ");

    // 1b-i: Check explicit numbers in the judgment against evidence
    const { flagged } = checkStatisticalClaims(
      [{ claim_text: allText }],
      evidencePackets
    );
    const statFlags = flagged[0]?.stat_qa_flags || [];

    // 1b-ii: Scrub implied quantitative language not backed by evidence
    const evidenceText = evidencePackets.map(p => [p.fact, p.source_quote].join(" ")).join(" ");
    const fields = ["judgment", "what_changed", "causal_mechanism", "why_this_matters"];
    const scrubbed = {};
    let totalReplacements = 0;
    for (const field of fields) {
      if (!j[field]) continue;
      const { text, replacements } = scrubImpliedQuantitatives(j[field], evidenceText);
      scrubbed[field] = text;
      totalReplacements += replacements.length;
    }

    if (statFlags.length > 0) report.stat_flags_added++;
    if (totalReplacements > 0) report.hype_terms_scrubbed++;

    const statCaveats = statFlags.map(f => `Unverified statistic: ${f.note}`);

    return {
      ...j,
      ...scrubbed,
      qa_issues:  [...(j.qa_issues || []), ...statFlags.map(f => `stat: ${f.note}`)],
      caveats:    [...(j.caveats   || []), ...statCaveats],
    };
  });

  // Pass 2: second-model verification on judgments that survived Pass 1
  const candidates = result.filter(j => !j.blocked);

  if (!skipLlmQa && candidates.length > 0) {
    process.stdout.write(`  [QA] running second-model check on ${candidates.length} judgment${candidates.length !== 1 ? "s" : ""} (${category})...\n`);
    const verdicts = await runSecondModelVerification(candidates, evidence_index, category);
    report.llm_qa_run = verdicts !== null;

    if (verdicts) {
      for (const v of verdicts) {
        const j   = candidates[v.index];
        if (!j) continue;
        const idx = result.indexOf(j);
        if (idx === -1) continue;

        if (v.verdict === "unsupported") {
          result[idx] = {
            ...result[idx],
            blocked:       true,
            blocked_reason: "llm_second_model_unsupported",
            qa_issues:     [...(result[idx].qa_issues || []), `llm_unsupported: ${v.reason}`],
          };
          report.llm_unsupported++;
          process.stdout.write(`  [QA] BLOCKED [J${v.index}]: ${v.reason?.slice(0, 80)}\n`);
        } else if (v.verdict === "needs_caveat" && v.caveat) {
          const existing = result[idx].caveats || [];
          result[idx] = {
            ...result[idx],
            caveats:   [...existing, v.caveat],
            qa_issues: [...(result[idx].qa_issues || []), "llm_caveat_added"],
          };
          report.llm_needs_caveat++;
          process.stdout.write(`  [QA] CAVEAT [J${v.index}]: ${v.caveat?.slice(0, 80)}\n`);
        }
        // "supported" → no change
      }
    }
  }

  report.output_count = result.filter(j => !j.blocked).length;
  return { judgments: result, qa_report: report };
}
