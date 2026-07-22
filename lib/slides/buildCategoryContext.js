export const CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const MATURITY_LABEL = {
  operational:  "OPERATIONAL — confirmed recurring campaign",
  observed:     "OBSERVED — confirmed in-the-wild use",
  disclosed:    "DISCLOSED — vulnerability or advisory confirmed",
  demonstrated: "DEMONSTRATED — working PoC or research demo",
  research:     "RESEARCH — theoretical or lab-only finding",
};

const SPEC_RANK = { high: 3, medium: 2, low: 1 };
const EVTYPE_LABEL = {
  incident:                 "INCIDENT",
  capability_demonstration: "DEMO",
  vulnerability:            "VULN",
  research_finding:         "RESEARCH",
  threat_actor_activity:    "ACTOR",
  statistical_measurement:  "STAT",
  attack_surface_signal:    "SIGNAL",
  expert_assessment:        "ASSESSMENT",
  policy_or_standard:       "POLICY",
};

function rankEvidence(ei) {
  return (ei.quote_grounded ? 10 : 0) + (SPEC_RANK[ei.specificity] || 0);
}

export function buildEvidenceBlock(items, maxItems = 3) {
  if (!items?.length) return null;
  const ranked = items
    .filter(ei => ei.is_cluster_rep !== false)
    .sort((a, b) => rankEvidence(b) - rankEvidence(a))
    .slice(0, maxItems);

  return ranked.map((ei, i) => {
    const label    = EVTYPE_LABEL[ei.evidence_type] || ei.evidence_type || "?";
    const grounded = ei.quote_grounded ? " [grounded]" : "";
    const nums     = (ei.numbers || []).filter(n => n.grounded !== false).slice(0, 2)
                       .map(n => `${n.value} (${n.context})`).join("; ");
    const entities = (ei.entities || []).slice(0, 3).join(", ");

    const parts = [`  E${i + 1}. [${label}]${grounded} ${ei.fact}`];
    if (ei.quote && ei.quote_grounded) parts.push(`    Quote: "${ei.quote.slice(0, 200)}"`);
    if (nums)     parts.push(`    Numbers: ${nums}`);
    if (entities) parts.push(`    Entities: ${entities}`);
    return parts.join("\n");
  }).join("\n");
}

// Coded taxonomy IDs (e.g. TAI03, LLM02) are opaque to the LLM — filter them out.
function isHumanReadableTag(tag) {
  return !(/^[A-Z]{2,4}\d+$/.test(tag));
}

function buildEntry(s, idx) {
  const intel    = s.intelligence || {};
  const impTier  = intel.importance?.tier || "unknown";
  const maturity = MATURITY_LABEL[intel.maturity_level] || intel.maturity_level || "unknown";
  const summary  = s.short_summary || "(no summary)";
  const srcType  = s.source_type ? ` | Type: ${s.source_type}` : "";

  const lines = [
    `[S${idx}] ${s.title || "(no title)"}`,
    `  Publisher: ${s.publisher || "unknown"} | Date: ${(s.date_published || "").slice(0, 10)} | Importance: ${impTier} | Maturity: ${maturity}${srcType}`,
    `  Summary: ${summary.slice(0, 400)}`,
  ];

  const tags = (s.tags || []).filter(isHumanReadableTag).slice(0, 5).join(", ");
  if (tags) lines.push(`  Tags: ${tags}`);

  const evidenceBlock = buildEvidenceBlock(s._evidence || []);
  if (evidenceBlock) {
    lines.push(`  Evidence items:`);
    lines.push(evidenceBlock);
  }

  return lines.join("\n");
}

/**
 * Build the dossier and sourceIndex from a pre-selected set of sources.
 *
 * @param {string}   category        — threat category key
 * @param {object[]} selectedSources — already screened by selectCategorySources
 * @param {string}   [clusterContext] — selection rationale from the Haiku pass
 */
export function buildCategoryContext(category, selectedSources, clusterContext = null) {
  const pool = selectedSources || [];

  if (!pool.length) {
    return { sources: [], dossier: "(no sources available for this category)", sourceIndex: {}, clusterContext: "" };
  }

  const sourceIndex = {};
  const entries = pool.map((s, i) => {
    const label = `S${i + 1}`;
    sourceIndex[label] = {
      source_id:      s.id,
      source_url:     s.url,
      source_title:   s.title,
      publisher:      s.publisher || "unknown",
      date_published: s.date_published || null,
      summary:        s.short_summary || "",
      evidence_text:  buildEvidenceBlock(s._evidence || []) || "",
    };
    return buildEntry(s, i + 1);
  });

  return {
    sources:        pool,
    dossier:        entries.join("\n\n"),
    sourceIndex,
    clusterContext: clusterContext || "",
  };
}
