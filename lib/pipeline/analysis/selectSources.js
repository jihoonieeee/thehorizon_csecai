/**
 * L6 Step 1 — Source Selection
 *
 * Two-pass selection per category:
 *
 *   Pass 1 (deterministic): filter by category/status/noise, score all candidates
 *     with sourceSignalScore(), cap the pool at CANDIDATE_CAP.
 *
 *   Pass 2 (LLM, Haiku): show candidate titles + summaries to the model and ask it
 *     to pick the 10–20 that maximise coverage of distinct techniques/actors/events.
 *     Criteria: diversity first, then named specificity, maturity, recency, non-redundancy.
 *     Falls back to top-scored deterministic selection if the LLM call fails.
 *
 * The LLM pass only runs when the candidate pool exceeds LLM_THRESHOLD.
 * Below that threshold, top-scored deterministic is good enough.
 *
 * Prompt: lib/prompts/analysis/select-sources.md
 */

import { sourceSignalScore, isNoiseSource } from "../scoring/sourceSignal.js";
import { maturityOf } from "../scoring/maturityLevel.js";
import { routedLLM }  from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { CATEGORY_SCOPE } from "./analyzeCategory.js";

// Deterministic pre-filter caps
const CANDIDATE_CAP  = 60;   // max candidates shown to the LLM
const FINAL_CAP      = 20;   // max sources in the dossier
const LLM_THRESHOLD  = 25;   // only run LLM selection when candidates exceed this

// Output schema for the Haiku selection call
const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selected_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
  },
  required: ["selected_ids"],
};

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("analysis/select-sources");
  return _prompts;
}

// ── Pass 1: deterministic candidate pool ─────────────────────────────────────

function buildCandidates(sources, category) {
  return sources
    .filter(s =>
      s.main_category === category &&
      s.validation_status === "pass" &&
      !s.needs_review &&
      !isNoiseSource(s)         // drop background + no significance
    )
    .sort((a, b) => {
      // Starred first, then by signal score
      if (a.starred !== b.starred) return b.starred ? 1 : -1;
      return sourceSignalScore(b) - sourceSignalScore(a);
    })
    .slice(0, CANDIDATE_CAP);
}

// ── Pass 2: LLM semantic selection ───────────────────────────────────────────

function formatCandidateList(candidates) {
  return candidates.map(s => {
    const mat  = maturityOf(s);
    const rv   = s.reading_value || "unknown";
    const date = s.date_published || "unknown date";
    const tags = (s.tags || []).slice(0, 4).join(", ");
    const summary = (s.short_summary || s.summary || "").slice(0, 150).replace(/\n/g, " ");

    return [
      `[${s.id}] ${(s.title || "(untitled)").slice(0, 100)} [${rv} | ${mat} | ${s.trust_tier || "unknown"}] ${date}`,
      summary ? `  ${summary}` : null,
      tags    ? `  Tags: ${tags}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

async function llmSelectSources(candidates, category, windowInfo) {
  const scope = CATEGORY_SCOPE[category] || {};
  const { system, user: userTmpl } = getPrompts();

  const user = interpolate(userTmpl, {
    category:        category.replace(/_/g, " ").toUpperCase(),
    period_label:    windowInfo?.label || "unknown period",
    date_from:       windowInfo?.date_from || "",
    date_to:         windowInfo?.date_to   || "",
    in_scope:        scope.in_scope    || "",
    out_of_scope:    scope.out_of_scope || "",
    candidate_count: candidates.length,
    candidate_list:  formatCandidateList(candidates),
  });

  const { result } = await routedLLM(system, user, {
    task: "source_filtering",   // routes to Haiku — cheap selection task
    requires_json: true,
    schema: SELECTION_SCHEMA,
  });

  const raw = typeof result === "string" ? JSON.parse(result) : result;
  return raw?.selected_ids || [];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Select the best sources for a single category.
 *
 * @param {object[]} sources     - All sources (pre-loaded for the window)
 * @param {string}   category    - e.g. "llm_threats"
 * @param {object}   [windowInfo]- { label, date_from, date_to }
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm] - Skip the LLM pass, use deterministic only
 * @returns {Promise<{ selected: object[], stats: object, llm_selected: boolean }>}
 */
export async function selectSourcesForCategory(sources, category, windowInfo = null, opts = {}) {
  const candidates = buildCandidates(sources, category);

  // Starred sources are always in — pull them out so they don't eat LLM slots
  const starred    = candidates.filter(s => s.starred);
  const nonStarred = candidates.filter(s => !s.starred);

  let selected;
  let llm_selected = false;

  // Only run LLM selection when there are enough candidates to make it worthwhile
  if (!opts.skipLlm && nonStarred.length > LLM_THRESHOLD) {
    try {
      const chosenIds = await llmSelectSources(nonStarred, category, windowInfo);

      // Validate: only accept IDs that actually exist in the candidate pool
      const candidateIndex = Object.fromEntries(nonStarred.map(s => [s.id, s]));
      const validated = chosenIds
        .map(id => candidateIndex[id])
        .filter(Boolean);

      if (validated.length >= 5) {
        // LLM made a meaningful selection — use it
        const seen = new Set(starred.map(s => s.id));
        const merged = [...starred];
        for (const s of validated) {
          if (!seen.has(s.id) && merged.length < FINAL_CAP) {
            seen.add(s.id);
            merged.push(s);
          }
        }
        selected     = merged;
        llm_selected = true;
      } else {
        // Too few valid IDs returned — fall back
        process.stdout.write(`  [L6] ${category}: LLM selection returned only ${validated.length} valid IDs — using deterministic fallback\n`);
        selected = candidates.slice(0, FINAL_CAP);
      }
    } catch (err) {
      process.stdout.write(`  [L6] ${category}: LLM selection failed (${err.message}) — using deterministic fallback\n`);
      selected = candidates.slice(0, FINAL_CAP);
    }
  } else {
    // Below threshold or skipLlm — deterministic top-N
    selected = candidates.slice(0, FINAL_CAP);
  }

  const byRv  = {};
  const byMat = {};
  for (const s of selected) {
    const rv  = s.reading_value || "unknown";
    const mat = maturityOf(s)   || "unknown";
    byRv[rv]  = (byRv[rv]  || 0) + 1;
    byMat[mat]= (byMat[mat]|| 0) + 1;
  }

  return {
    selected,
    llm_selected,
    stats: {
      total:            selected.length,
      candidates_seen:  candidates.length,
      by_reading_value: byRv,
      by_maturity:      byMat,
    },
  };
}

/**
 * Select sources for all four offensive categories.
 */
export async function selectSourcesForAllCategories(sources, categories, windowInfo = null, opts = {}) {
  const result = {};
  for (const cat of categories) {
    result[cat] = await selectSourcesForCategory(sources, cat, windowInfo, opts);
  }
  return result;
}
