/**
 * L6 Step 2 — Dossier Builder
 *
 * Packages selected sources into the structured text block the LLM reads
 * for analysis. Each source is shown with its ID, metadata, summary, and
 * the best available quote from L5 evidence items.
 *
 * The LLM copies source IDs verbatim into cited_sources[].source_id.
 * No evidence item IDs appear here — attribution is at the source level.
 */

import { maturityOf } from "../scoring/maturityLevel.js";

const MATURITY_ORDER = ["operational", "observed", "disclosed", "demonstrated", "research"];

const MATURITY_LABEL = {
  operational:  "OPERATIONAL — confirmed recurring campaign",
  observed:     "OBSERVED — confirmed in-the-wild use",
  disclosed:    "DISCLOSED — vulnerability or advisory confirmed",
  demonstrated: "DEMONSTRATED — working PoC or research demo",
  research:     "RESEARCH — theoretical or lab-only finding",
};

function bestQuoteForSource(source, evidenceItems) {
  const evForSource = evidenceItems.filter(ei =>
    (ei.source_id === source.id || ei.source_url === source.url) &&
    ei.quote_grounded &&
    ei.quote
  );
  if (!evForSource.length) return null;
  const SPEC = { high: 2, medium: 1, low: 0 };
  evForSource.sort((a, b) => (SPEC[b.specificity] || 0) - (SPEC[a.specificity] || 0));
  return evForSource[0].quote.slice(0, 400);
}

/**
 * Build a structured dossier for a category's selected sources.
 *
 * @param {string}   category         - e.g. "llm_threats"
 * @param {object[]} selectedSources  - From selectSourcesForCategory()
 * @param {object[]} evidenceItems    - All L5 evidence items (for quote lookup)
 * @param {object}   corpusSummary    - From buildCorpusSummary()
 * @returns {{ dossier_text: string, source_index: object }}
 */
export function buildDossier(category, selectedSources, evidenceItems = [], corpusSummary = {}) {
  if (!selectedSources.length) {
    return { dossier_text: "(no sources selected for this category)", source_index: {} };
  }

  // source_index is passed back to the caller for post-call attribution resolution
  const source_index = {};
  for (const s of selectedSources) {
    source_index[s.id] = {
      source_id:    s.id,
      source_url:   s.url,
      source_title: s.title,
      publisher:    s.publisher || s.author || "unknown",
      trust_tier:   s.trust_tier || "unknown",
      date_published: s.date_published || null,
    };
  }

  // Group by maturity for structured presentation (highest fidelity first)
  const groups = Object.fromEntries(MATURITY_ORDER.map(m => [m, []]));
  for (const s of selectedSources) {
    const mat = maturityOf(s);
    if (groups[mat]) groups[mat].push(s);
    else groups.research.push(s);
  }

  const catLabel = category.replace(/_/g, " ").toUpperCase();
  const lines = [
    `CATEGORY: ${catLabel}`,
    `PERIOD: ${corpusSummary.date_range || "unknown"}`,
    `SOURCES SELECTED: ${selectedSources.length} of ${corpusSummary.total_sources || "?"} total`,
    "",
    "Cite sources by copying their exact [source-id] from the brackets below.",
    "Every cited_sources[].source_id must be one of these IDs — do not alter or invent IDs.",
    "",
  ];

  for (const mat of MATURITY_ORDER) {
    const srcs = groups[mat];
    if (!srcs.length) continue;

    lines.push(`── ${MATURITY_LABEL[mat]} ──`);
    lines.push("");

    for (const s of srcs) {
      const quote = bestQuoteForSource(s, evidenceItems);
      const tags  = (s.tags || []).slice(0, 5).join(", ");
      const rv    = s.reading_value ? ` [${s.reading_value}]` : "";

      lines.push(`[${s.id}] ${s.title || "(untitled)"}${rv}`);
      lines.push(`  Publisher : ${s.publisher || s.author || "unknown"} [${s.trust_tier || "unknown"}]`);
      if (s.date_published) lines.push(`  Date      : ${s.date_published}`);
      if (s.short_summary)  lines.push(`  Summary   : ${s.short_summary.slice(0, 300)}`);
      if (quote)            lines.push(`  Key quote : "${quote}"`);
      if (tags)             lines.push(`  Tags      : ${tags}`);
      lines.push("");
    }
  }

  return { dossier_text: lines.join("\n"), source_index };
}
