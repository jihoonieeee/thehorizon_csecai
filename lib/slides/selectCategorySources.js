import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

// Below this pool size, selection adds no value — just use everything.
const MIN_POOL_FOR_SELECTION = 12;

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/source-selection");
  return _prompts;
}

function buildCatalog(pool) {
  return pool.map((s, i) => {
    const tier    = s.intelligence?.importance?.tier || "unknown";
    const date    = (s.date_published || "").slice(0, 10);
    const pub     = s.publisher || "unknown";
    const type    = s.source_type || "unknown";
    const summary = (s.short_summary || "").slice(0, 100);
    const title   = s.title || "(no title)";
    return `C${i + 1}. [${tier} | ${pub} | ${date} | ${type}] ${title}${summary ? ` — ${summary}` : ""}`;
  }).join("\n");
}

function buildClusterContext(result, selectedSources, poolSize) {
  const lines = [`Selected ${selectedSources.length} of ${poolSize} eligible sources.`];

  const clusters = (result?.clusters || []).filter(c => c.sources?.length >= 2);
  if (clusters.length) {
    lines.push("Source clusters (share a mechanism — synthesise into one shift):");
    for (const c of clusters) {
      lines.push(`  • [${c.sources.join(", ")}] ${c.mechanism || ""}`);
    }
  }

  if (result?.excluded_rationale) {
    lines.push(`Excluded: ${result.excluded_rationale}`);
  }

  return lines.join("\n");
}

/**
 * Select the most strategically valuable sources for a category using a cheap LLM pass.
 *
 * @param {string}   category  — e.g. "llm_threats"
 * @param {object[]} pool      — all importance-tier-filtered sources for this category
 * @returns {Promise<{ selectedSources: object[], clusterContext: string }>}
 */
export async function selectCategorySources(category, pool) {
  if (!pool.length) {
    return { selectedSources: [], clusterContext: "(no sources available)" };
  }

  // Small pools: skip selection, use everything
  if (pool.length <= MIN_POOL_FOR_SELECTION) {
    return {
      selectedSources: pool,
      clusterContext:  `All ${pool.length} sources included (pool below selection threshold).`,
    };
  }

  const { system, user: userTmpl } = getPrompts();
  const catalog = buildCatalog(pool);

  const user = interpolate(userTmpl, {
    category:  category.replace(/_/g, " "),
    pool_size: String(pool.length),
    catalog,
  });

  // Build a C-label → index map for resolving the selection back to source objects
  const labelToIdx = {};
  pool.forEach((_, i) => { labelToIdx[`C${i + 1}`] = i; });

  let result;
  try {
    const { result: r } = await routedLLM(system, user, {
      task:          "source_understanding",
      requires_json: true,
    });
    result = r;
  } catch (err) {
    console.warn(`[selectCategorySources] ${category}: selection failed (${err.message}) — falling back to top 15`);
    return {
      selectedSources: pool.slice(0, 15),
      clusterContext:  "(source selection failed — using top 15 sources)",
    };
  }

  const selectedLabels  = Array.isArray(result?.selected) ? result.selected : [];
  const selectedSources = selectedLabels
    .map(label => pool[labelToIdx[label]])
    .filter(Boolean);

  // If selection returned nothing useful, fall back
  if (!selectedSources.length) {
    console.warn(`[selectCategorySources] ${category}: selection returned no sources — falling back to top 15`);
    return {
      selectedSources: pool.slice(0, 15),
      clusterContext:  "(source selection returned empty — using top 15 sources)",
    };
  }

  return {
    selectedSources,
    clusterContext: buildClusterContext(result, selectedSources, pool.length),
  };
}
