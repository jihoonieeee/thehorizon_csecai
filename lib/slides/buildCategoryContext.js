import { sourceSignalScore } from "../pipeline/scoring/sourceSignal.js";

export const CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const IMPORTANCE_RANK = { realized: 4, proven: 3, research: 2, reference: 1, noise: 0 };

const MATURITY_LABEL = {
  operational:  "OPERATIONAL — confirmed recurring campaign",
  observed:     "OBSERVED — confirmed in-the-wild use",
  disclosed:    "DISCLOSED — vulnerability or advisory confirmed",
  demonstrated: "DEMONSTRATED — working PoC or research demo",
  research:     "RESEARCH — theoretical or lab-only finding",
};

function rankSource(s) {
  const tier = s.intelligence?.importance?.tier || "noise";
  return (IMPORTANCE_RANK[tier] || 0) * 1000 + sourceSignalScore(s);
}

function buildEntry(s, idx) {
  const intel   = s.intelligence || {};
  const impTier = intel.importance?.tier || "unknown";
  const maturity = MATURITY_LABEL[intel.maturity_level] || intel.maturity_level || "unknown";
  const summary  = s.analyst_brief || s.short_summary || "(no summary)";

  const lines = [
    `[S${idx}] ${s.title || "(no title)"}`,
    `  URL: ${s.url}`,
    `  Publisher: ${s.publisher || "unknown"} | Date: ${(s.date_published || "").slice(0, 10)} | Importance: ${impTier} | Maturity: ${maturity}`,
    `  Summary: ${summary.slice(0, 500)}`,
  ];

  const quote = intel.key_quote || intel.verbatim_quote;
  if (quote) lines.push(`  Key quote: "${String(quote).slice(0, 300)}"`);

  const tags = (s.tags || []).slice(0, 5).join(", ");
  if (tags) lines.push(`  Tags: ${tags}`);

  return lines.join("\n");
}

export function buildCategoryContext(category, allSources, maxSources = 25) {
  const pool = allSources
    .filter(s => s.main_category === category)
    .sort((a, b) => rankSource(b) - rankSource(a))
    .slice(0, maxSources);

  if (!pool.length) {
    return { sources: [], dossier: "(no sources available for this category)", sourceIndex: {} };
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
      summary:        s.analyst_brief || s.short_summary || "",
    };
    return buildEntry(s, i + 1);
  });

  return {
    sources:     pool,
    dossier:     entries.join("\n\n"),
    sourceIndex,
  };
}
