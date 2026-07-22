import { routedLLM }            from "../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

const MIN_POOL_FOR_SELECTION = 12;
// Haiku quality degrades above ~80 sources; pre-filter the catalog to the strongest
const MAX_CATALOG_SIZE = 80;

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
    // Use claim_extraction_status as a proxy for having rich evidence items
    // (_evidence is only populated after selection, not here)
    const hasEv   = s.claim_extraction_status === "success" ? " [enriched]" : "";
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
  // Build C-label → S-label map: sortedPool position → selectedSources position
  const sLabelBySource = new Map(selectedSources.map((s, j) => [s, `S${j + 1}`]));
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

  // Cap the catalog at MAX_CATALOG_SIZE — Haiku quality degrades beyond ~80 sources.
  // The pool is already sorted importance-first so the strongest sources survive the cap.
  const catalogPool = sortedPool.length > MAX_CATALOG_SIZE
    ? sortedPool.slice(0, MAX_CATALOG_SIZE)
    : sortedPool;
  const catalog = buildCatalog(catalogPool);

  // C-label → pool index (into catalogPool, not the full sortedPool)
  // Re-build labelToIdx below after this point.

  const user = interpolate(userTmpl, {
    category:  category.replace(/_/g, " "),
    pool_size: String(catalogPool.length),
    catalog,
  });

  // C-label → index into catalogPool (not the full sortedPool)
  const labelToIdx = {};
  catalogPool.forEach((_, i) => { labelToIdx[`C${i + 1}`] = i; });

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
    .map(label => catalogPool[labelToIdx[normaliseLabel(label)]])
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
    clusterContext: buildClusterContext(result, catalogPool, selectedSources, sortedPool.length),
  };
}
