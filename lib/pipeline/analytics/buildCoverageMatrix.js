/**
 * Layer 5B — Source-Type Coverage Matrix
 *
 * Builds the source_type × domain coverage matrix showing which source types
 * support which threat domains, with counts and thin-coverage flags.
 *
 * Deliverable 2 of the Component 5B analytics branch.
 *
 * Key insight:
 *   An incident source is stronger evidence of operational reality than a research_finding.
 *   A governance_signal is not direct evidence of adversary activity.
 *   This matrix makes source-type-to-domain coverage visible so the analysis layer
 *   can caveat findings that rest on weaker evidence types.
 */

// Source types that constitute "primary" (high-signal) operational evidence
const OPERATIONAL_SOURCE_TYPES = new Set([
  "incident", "exploit_disclosure", "vulnerability", "threat_intelligence", "adversary_adoption_signal",
]);

// Source types that provide horizon/research signals
const HORIZON_SOURCE_TYPES = new Set([
  "research_finding", "benchmark_evaluation", "capability_demonstration",
  "attack_surface_signal",
]);

// Source types that provide structural/contextual signals only
const CONTEXTUAL_SOURCE_TYPES = new Set([
  "defensive_capability", "governance_signal", "societal_harm_signal",
]);

const DOMAINS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

/**
 * Build the source_type × domain coverage matrix.
 *
 * @param {object[]} features - Analytics features from eligible sources
 * @returns {object} Coverage matrix deliverable
 */
export function buildCoverageMatrix(features) {
  // All known source types in display order
  const SOURCE_TYPE_ORDER = [
    "incident", "exploit_disclosure", "vulnerability", "threat_intelligence",
    "adversary_adoption_signal", "capability_demonstration", "research_finding",
    "benchmark_evaluation", "defensive_capability", "governance_signal",
    "societal_harm_signal", "attack_surface_signal", "unknown",
  ];

  // Count source_type × domain intersections, tracking source IDs
  const cellCounts  = {};  // { "incident:llm_threats": count }
  const cellIds     = {};  // { "incident:llm_threats": [source_id, ...] }
  const typeTotal   = {};  // total per source type
  const domainTotal = {};  // total per domain

  for (const f of features) {
    if (!f) continue;
    const st  = f.source_type   || "unknown";
    const cat = f.main_category || null;
    if (!cat || !DOMAINS.includes(cat)) continue;

    const key = `${st}:${cat}`;
    cellCounts[key]  = (cellCounts[key]  || 0) + 1;
    if (!cellIds[key]) cellIds[key] = [];
    if (f.source_id) cellIds[key].push(f.source_id);

    typeTotal[st]    = (typeTotal[st]  || 0) + 1;
    domainTotal[cat] = (domainTotal[cat] || 0) + 1;
  }

  // Build the matrix rows
  const matrix = [];
  for (const st of SOURCE_TYPE_ORDER) {
    if (!typeTotal[st]) continue;

    const row = {
      source_type: st,
      source_group: OPERATIONAL_SOURCE_TYPES.has(st) ? "operational"
                  : HORIZON_SOURCE_TYPES.has(st)     ? "horizon"
                  : CONTEXTUAL_SOURCE_TYPES.has(st)  ? "contextual"
                  : "unknown",
      total: typeTotal[st] || 0,
    };

    for (const domain of DOMAINS) {
      const key   = `${st}:${domain}`;
      const count = cellCounts[key] || 0;
      row[domain] = count;
    }
    matrix.push(row);
  }

  // Add a totals row
  const totalsRow = { source_type: "_totals", source_group: "summary", total: features.length };
  for (const domain of DOMAINS) {
    totalsRow[domain] = domainTotal[domain] || 0;
  }
  matrix.push(totalsRow);

  // Coverage notes — describe the evidence quality landscape
  const coverage_notes = [];
  const thin_coverage_flags = [];
  const MIN_OPERATIONAL_SOURCES = 3;

  for (const domain of DOMAINS) {
    const domainFeatures = features.filter((f) => f?.main_category === domain);
    const total = domainFeatures.length;
    if (total === 0) {
      thin_coverage_flags.push({ domain, reason: "No sources in this domain" });
      continue;
    }

    const operationalCount = domainFeatures.filter((f) => OPERATIONAL_SOURCE_TYPES.has(f.source_type)).length;
    const horizonCount     = domainFeatures.filter((f) => HORIZON_SOURCE_TYPES.has(f.source_type)).length;
    const contextualCount  = domainFeatures.filter((f) => CONTEXTUAL_SOURCE_TYPES.has(f.source_type)).length;

    if (operationalCount < MIN_OPERATIONAL_SOURCES) {
      thin_coverage_flags.push({
        domain,
        reason: `Only ${operationalCount} operational-source-type sources (incident/exploit/vuln/TI/adoption). Operational claims need caution.`,
        operational_count: operationalCount,
        horizon_count:     horizonCount,
        contextual_count:  contextualCount,
      });
    }

    const dominantType = (() => {
      const typeCounts = {};
      for (const f of domainFeatures) typeCounts[f.source_type] = (typeCounts[f.source_type] || 0) + 1;
      return Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
    })();

    coverage_notes.push({
      domain,
      total_sources:     total,
      operational_count: operationalCount,
      horizon_count:     horizonCount,
      contextual_count:  contextualCount,
      dominant_source_type: dominantType,
    });
  }

  // Source-type-aware evidence quality note
  const operationalSourcesNote = `Operational source types (incident, exploit_disclosure, vulnerability, threat_intelligence, adversary_adoption_signal) carry stronger weight for operational-threat claims. Governance, ecosystem, and strategic signals provide context only.`;

  return {
    matrix,
    coverage_notes,
    thin_coverage_flags,
    source_type_groups: {
      operational: [...OPERATIONAL_SOURCE_TYPES],
      horizon:     [...HORIZON_SOURCE_TYPES],
      contextual:  [...CONTEXTUAL_SOURCE_TYPES],
    },
    methodology_note: operationalSourcesNote,
  };
}
