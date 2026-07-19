/**
 * generateExplanations()
 *
 * Adds point-form explanations to every approved insight after qaInsights().
 * One Haiku call per insight (parallel across all categories).
 *
 * Output fields added to each insight:
 *   explanation_summary: string   — one-sentence lead for the card
 *   explanation_points:  string[] — 3–5 tight bullets shown in the drilldown
 *
 * The model receives the insight's analytical context (what_changed, mechanism,
 * implication, monitoring_signal) plus cited source quotes and any attack
 * walkthrough data from L5 evidence items. It must NOT reproduce the field
 * labels — it writes as though reporting a known development.
 *
 * Prompt: lib/prompts/analysis/explain-insight.md
 * Model: Haiku via task "source_filtering"
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

const EXPLANATION_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    points:  { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
  required: ["summary", "points"],
};

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("analysis/explain-insight");
  return _prompts;
}

// ── Walkthrough block ─────────────────────────────────────────────────────────

function buildWalkthroughBlock(insight, evidenceItems) {
  if (!evidenceItems?.length) return "";

  const citedIds = new Set((insight.cited_sources || []).map(cs => cs.source_id));
  const walkthroughs = evidenceItems.filter(ei =>
    citedIds.has(ei.source_id) && ei.walkthrough_steps?.length > 0
  );
  if (!walkthroughs.length) return "";

  const lines = ["ATTACK WALKTHROUGH (compress into one bullet using arrows step → step → outcome):"];
  for (const w of walkthroughs.slice(0, 2)) {
    if (w.walkthrough_actor && w.walkthrough_actor !== "unattributed") {
      lines.push(`Actor: ${w.walkthrough_actor}`);
    }
    if (w.walkthrough_technique) lines.push(`Technique: ${w.walkthrough_technique}`);
    if (w.walkthrough_steps?.length) {
      lines.push(`Steps: ${w.walkthrough_steps.join(" → ")}`);
    }
    if (w.walkthrough_impact) lines.push(`Impact: ${w.walkthrough_impact}`);
  }
  return lines.join("\n");
}

// ── Sources block ─────────────────────────────────────────────────────────────

function buildSourcesBlock(insight) {
  return (insight.cited_sources || []).map(cs => {
    const lines = [`${cs.publisher || cs.source_title} [${cs.trust_tier || "unknown"}]`];
    if (cs.quote) lines.push(`  "${cs.quote.slice(0, 200)}"`);
    return lines.join("\n");
  }).join("\n\n") || "(no cited sources)";
}

// ── Single insight call ───────────────────────────────────────────────────────

async function explainInsight(insight, evidenceItems, windowInfo) {
  const { system, user: userTmpl } = getPrompts();

  const user = interpolate(userTmpl, {
    title:             insight.title        || "",
    period_label:      windowInfo?.label    || "this period",
    what_changed:      insight.what_changed || "",
    mechanism:         insight.mechanism    || "",
    walkthrough_block: buildWalkthroughBlock(insight, evidenceItems),
    sources_block:     buildSourcesBlock(insight),
  });

  try {
    const { result } = await routedLLM(system, user, {
      task: "source_filtering",
      requires_json: true,
      schema: EXPLANATION_SCHEMA,
    });
    const raw = typeof result === "string" ? JSON.parse(result) : result;

    const summary = (raw?.summary || "").trim();
    const points  = (raw?.points  || [])
      .map(p => String(p).trim())
      .filter(p => p.length > 5)
      .slice(0, 5);

    if (!summary && !points.length) return null;
    return { summary, points };
  } catch (err) {
    process.stdout.write(`  [L6] explanation failed for "${insight.title?.slice(0, 50)}": ${err.message}\n`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add explanation_summary and explanation_points to every approved insight.
 * Runs all calls in parallel (up to 12: 4 categories × 3 insights).
 *
 * @param {object[]} categoryAnalyses
 * @param {object[]} evidenceItems
 * @param {object}   windowInfo
 * @param {object}   [opts]
 * @returns {Promise<object[]>}
 */
export async function generateExplanations(categoryAnalyses, evidenceItems, windowInfo, opts = {}) {
  if (opts.skipLlm) return categoryAnalyses;

  const tasks = [];
  for (const ca of categoryAnalyses) {
    for (const insight of ca.insights || []) {
      if (!insight.blocked) tasks.push({ ca, insight });
    }
  }

  if (!tasks.length) return categoryAnalyses;

  process.stdout.write(`  [L6] Generating explanations for ${tasks.length} insights...\n`);

  const results = await Promise.all(
    tasks.map(({ insight }) => explainInsight(insight, evidenceItems, windowInfo))
  );

  // Write back onto insight objects without mutating originals
  const insightToResult = new Map(tasks.map((t, i) => [t.insight, results[i]]));

  const output = categoryAnalyses.map(ca => ({
    ...ca,
    insights: (ca.insights || []).map(ins => {
      const r = insightToResult.get(ins);
      if (!r || ins.blocked) return ins;
      return {
        ...ins,
        explanation_summary: r.summary || null,
        explanation_points:  r.points  || [],
      };
    }),
  }));

  const generated = results.filter(Boolean).length;
  process.stdout.write(`  [L6] ${generated}/${tasks.length} explanations generated\n`);
  return output;
}
