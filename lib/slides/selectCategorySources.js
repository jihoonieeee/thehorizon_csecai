import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

const MIN_POOL_FOR_SELECTION = 12;

const IMPORTANCE_ORDER = { realized: 0, proven: 1, research: 2, reference: 3, noise: 4, unknown: 5 };

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/source-selection");
  return _prompts;
}

/** Sort pool by importance tier then recency so the catalog starts with the strongest sources. */
function sortPool(pool) {
  return [...pool].sort((a, b) => {
    const ta = IMPORTANCE_ORDER[a.intelligence?.importance?.tier || "unknown"] ?? 5;
    const tb = IMPORTANCE_ORDER[b.intelligence?.importance?.tier || "unknown"] ?? 5;
    if (ta !== tb) return ta - tb;
    // Within same tier: newer first
    return new Date(b.date_published || 0) - new Date(a.date_published || 0);
  });
}

function buildCatalog(sortedPool) {
  return sortedPool.map((s, i) => {
    const tier    = s.intelligence?.importance?.tier || "unknown";
    const date    = (s.date_published || "").slice(0, 10);
    const pub     = s.publisher || "unknown";
    const type    = s.source_type || "unknown";
    const summary = (s.short_summary || "").slice(0, 100);
    const title   = s.title || "(no title)";
    const hasEv   = (s._evidence?.length > 0) ? " [has evidence]" : "";
    return `C${i + 1}. [${tier} | ${pub} | ${date} | ${type}${hasEv}] ${title}${summary ? ` — ${summary}` : ""}`;
  }).join("\n");
}

/** Normalise C-label from LLM output: trim, uppercase, strip leading zeros. */
function normaliseLabel(raw) {
  const s = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  // Handle zero-padded: C03 → C3
  return s.replace(/^C0*(\d+)$/, "C$1");
}

function buildClusterContext(result, sortedPool, selectedSources, poolSize) {
  // Build C-label → S-label map using pool position → selection position
  const poolIdxBySource = new Map(sortedPool.map((s, i) => [s, i]));
  const sLabelBySource  = new Map(selectedSources.map((s, j) => [s, `S${j + 1}`]));
  const cToS = new Map(
    sortedPool.map((s, i) => [`C${i + 1}`, sLabelBySource.get(s)])
  );

  const lines = [`Selected ${selectedSources.length} of ${poolSize} eligible sources.`];

  const clusters = (result?.clusters || []).filter(c => c.sources?.length >= 2);
  if (clusters.length) {
    lines.push("Source clusters (share a mechanism — synthesise into one shift):");
    for (const c of clusters) {
      // Translate C-labels to S-labels so the synthesis model can cross-reference the dossier
      const sLabels = (c.sources || [])
        .map(cl => cToS.get(normaliseLabel(cl)))
        .filter(Boolean);
      if (sLabels.length >= 2) {
        lines.push(`  • [${sLabels.join(", ")}] ${c.mechanism || ""}`);
      }
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
 * @param {string}   category — e.g. "llm_threats"
 * @param {object[]} pool     — all importance-tier-filtered sources for this category
 * @returns {Promise<{ selectedSources: object[], clusterContext: string }>}
 */
export async function selectCategorySources(category, pool) {
  if (!pool.length) {
    return { selectedSources: [], clusterContext: "(no sources available)" };
  }

  // Sort by importance then recency before presenting to the model
  const sortedPool = sortPool(pool);

  // Small pools: skip selection, use everything
  if (sortedPool.length <= MIN_POOL_FOR_SELECTION) {
    return {
      selectedSources: sortedPool,
      clusterContext:  `All ${sortedPool.length} sources included (pool below selection threshold).`,
    };
  }

  const { system, user: userTmpl } = getPrompts();
  const catalog = buildCatalog(sortedPool);

  const user = interpolate(userTmpl, {
    category:  category.replace(/_/g, " "),
    pool_size: String(sortedPool.length),
    catalog,
  });

  // C-label → pool index map (using normalised labels)
  const labelToIdx = {};
  sortedPool.forEach((_, i) => { labelToIdx[`C${i + 1}`] = i; });

  let result;
  try {
    const { result: r } = await routedLLM(system, user, {
      task:          "source_understanding",
      requires_json: true,
    });
    result = r;
  } catch (err) {
    console.warn(`[selectCategorySources] ${category}: selection failed (${err.message}) — using top 15`);
    return {
      selectedSources: sortedPool.slice(0, 15),
      clusterContext:  "(source selection failed — using top 15 sources)",
    };
  }

  const selectedLabels  = Array.isArray(result?.selected) ? result.selected : [];
  const selectedSources = selectedLabels
    .map(label => sortedPool[labelToIdx[normaliseLabel(label)]])
    .filter(Boolean);

  if (!selectedSources.length) {
    console.warn(`[selectCategorySources] ${category}: empty selection — using top 15`);
    return {
      selectedSources: sortedPool.slice(0, 15),
      clusterContext:  "(source selection returned empty — using top 15 sources)",
    };
  }

  return {
    selectedSources,
    clusterContext: buildClusterContext(result, sortedPool, selectedSources, sortedPool.length),
  };
}
