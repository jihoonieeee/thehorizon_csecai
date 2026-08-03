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

// ── Insight integration ───────────────────────────────────────────────────────
// The dashboard-insight layer (dashboard_insights) is the period's validated,
// higher-quality analytical synthesis. When available for the window, it becomes
// the SPINE of the slide content: each insight is a ready strategic conclusion
// with a headline (title), takeaway (insight), supporting points, cited sources,
// and maturity. The slide LLM then only formats it — it does not re-derive.

const norm = (u) => (u || "").trim().replace(/\/+$/, "").toLowerCase();

// Highest maturity across an insight's sources → slide maturity scale.
const INSIGHT_MATURITY_TO_SLIDE = {
  operational:  "operational_campaign",
  observed:     "observed_exploitation",
  disclosed:    "disclosed_vulnerability",
  demonstrated: "research_demonstration",
  research:     "research_demonstration",
};
const SLIDE_MATURITY_RANK = {
  operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
  disclosed_vulnerability: 2, research_demonstration: 1,
};

function insightMaturity(insight) {
  let best = null, bestRank = 0;
  for (const src of (insight.sources || [])) {
    const m = INSIGHT_MATURITY_TO_SLIDE[src.maturity] || null;
    const r = SLIDE_MATURITY_RANK[m] || 0;
    if (r > bestRank) { best = m; bestRank = r; }
  }
  return best || "research_demonstration";
}

// Convert an insight's source record (url/title/date/publisher/maturity) into the
// pseudo-source shape buildEntry expects, so it can join the citable dossier.
//
// Insight source records carry no summary/evidence text. Left bare, the entailment
// QA spot-check (which reads only the cited source's summary + evidence) would see
// nothing to verify a bullet against and flag it as unsupported — a false positive,
// since the bullet is derived from the validated insight itself. So ground the
// pseudo-source in the parent insight's conclusion + key points: the QA checker
// then verifies each bullet against the exact text it was formatted from.
function insightSourceToPseudo(src, insight) {
  const grounding = [insight?.insight, ...(insight?.explanation_points || [])]
    .filter(Boolean)
    .join(" ");
  return {
    id:             src.id || null,
    url:            src.url,
    title:          src.title,
    publisher:      src.publisher || "unknown",
    date_published: src.date || src.date_published || null,
    short_summary:  src.summary || grounding || "",
    intelligence:   { maturity_level: src.maturity || "unknown", importance: { tier: "reference" } },
    tags:           [],
    _evidence:      [],
    _fromInsight:   true,
  };
}

/**
 * Build the dossier and sourceIndex from a pre-selected set of sources, plus an
 * optional insight block anchored on the period's validated insights.
 *
 * @param {string}   category        — threat category key
 * @param {object[]} selectedSources — already screened by selectCategorySources
 * @param {string}   [clusterContext] — selection rationale from the Haiku pass
 * @param {object}   [insightPoints]  — dashboard_insights.points for this category
 *                                       ({ assessment, insights:[...] }) or null
 */
export function buildCategoryContext(category, selectedSources, clusterContext = null, insightPoints = null) {
  // Merge insight-cited sources into the pool (dedup by URL) so the LLM can cite
  // them with S-labels and the renderer can link them, even if slide selection
  // did not pick them.
  const pool = [...(selectedSources || [])];
  const seen = new Set(pool.map(s => norm(s.url)));
  const insights = (insightPoints?.insights || []).slice(0, 4);
  for (const ins of insights) {
    for (const src of (ins.sources || [])) {
      if (!src.url || seen.has(norm(src.url))) continue;
      seen.add(norm(src.url));
      pool.push(insightSourceToPseudo(src, ins));
    }
  }

  if (!pool.length) {
    return { sources: [], dossier: "(no sources available for this category)", sourceIndex: {}, clusterContext: "", insightsBlock: "", assessment: "" };
  }

  const sourceIndex = {};
  const urlToLabel  = {};
  const entries = pool.map((s, i) => {
    const label = `S${i + 1}`;
    urlToLabel[norm(s.url)] = label;
    sourceIndex[label] = {
      source_id:      s.id,
      source_url:     s.url,
      source_title:   s.title,
      publisher:      s.publisher || "unknown",
      date_published: s.date_published || null,
      summary:        s.short_summary || "",
      evidence_text:  buildEvidenceBlock(s._evidence || []) || "",
      importance_tier: s.intelligence?.importance?.tier || "unknown",
      source_type:     s.source_type || "unknown",
    };
    return buildEntry(s, i + 1);
  });

  // Build the insight-anchored block: each insight pre-labelled with its citations.
  let insightsBlock = "";
  if (insights.length) {
    const blocks = insights.map((ins, k) => {
      const cites = (ins.sources || [])
        .map(src => urlToLabel[norm(src.url)])
        .filter(Boolean);
      const points = (ins.explanation_points || []).map(p => `    - ${p}`).join("\n");
      const lines = [
        `INSIGHT ${k + 1}`,
        `  Headline seed: ${ins.title || ""}`,
        `  Conclusion:    ${ins.insight || ""}`,
        points ? `  Key points:\n${points}` : "",
        `  Maturity:   ${insightMaturity(ins)}`,
        ins.confidence ? `  Confidence: ${ins.confidence}` : "",
        `  Cite:       ${cites.length ? cites.join(", ") : "(no matching dossier source — cite the closest S-label)"}`,
      ].filter(Boolean);
      return lines.join("\n");
    });
    insightsBlock = blocks.join("\n\n");
  }

  return {
    sources:        pool,
    dossier:        entries.join("\n\n"),
    sourceIndex,
    clusterContext: clusterContext || "",
    insightsBlock,
    assessment:     insightPoints?.assessment || "",
  };
}
