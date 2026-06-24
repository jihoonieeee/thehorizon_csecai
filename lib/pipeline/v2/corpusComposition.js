/**
 * v2 — Source-Composition Audit
 *
 * Every run produces a deck whose conclusions are only as balanced as the
 * evidence corpus behind it. Historically the corpus is dominated by arXiv
 * research papers and NVD vulnerability advisories, which pushes the
 * traditional-AI and LLM categories toward research-heavy, lab-only
 * conclusions that are hard to justify operationally (see
 * docs/CORPUS_COMPOSITION_AUDIT.md and docs/CLAIM_CHAIN_AUDIT.md).
 *
 * This module groups the per-run sources into a small set of analytical
 * buckets, computes the distribution, compares it against diversity targets,
 * and emits warnings when a run is too skewed (e.g. >70% research). It is
 * deterministic — no LLM, no network — and is logged on every run so a
 * reviewer can see the evidence base at a glance before trusting the deck.
 *
 *   import { buildCorpusComposition, formatCompositionReport } from "./corpusComposition.js";
 *   const composition = buildCorpusComposition(relevantSources);
 *   console.log(formatCompositionReport(composition));
 */

// ── Analytical buckets ────────────────────────────────────────────────────────
// Each bucket has a human label and the diversity target band (min/max share of
// the corpus). Targets are soft guidance, not hard quotas — their purpose is to
// surface a corpus that is too narrow, not to force a fixed mix. The single hard
// rule is RESEARCH_HARD_CEILING (see below).

export const BUCKETS = {
  research: {
    label: "Research (Lane A)",
    target: [0.10, 0.25],  // max 25% — cap arXiv dominance
    note: "Academic / lab demonstrations, benchmarks, evaluations. High volume, forward-looking, but weak for operational conclusions.",
  },
  vulnerability: {
    label: "Vulnerability",
    target: [0.20, 0.30],
    note: "Disclosed and exploited vulnerabilities (CVE / advisory). Verbatim-groundable, primary-trust, high analytical value.",
  },
  incident: {
    label: "Incident",
    target: [0.15, 0.30],
    note: "Real-world security incidents and intrusions. Highest operational value — evidence of what actually happened.",
  },
  threat_intelligence: {
    label: "Threat Intelligence",
    target: [0.15, 0.30],
    note: "Adversary tracking, campaign analysis, IR reporting. Strong for adversary-activity and operational claims.",
  },
  operational_campaign: {
    label: "Operational Campaign",
    target: [0.05, 0.15],
    note: "Adversary-adoption signals and active campaigns — AI used in the wild as an attack tool/technique.",
  },
  vendor_advisory: {
    label: "Vendor Advisory",
    target: [0.05, 0.15],
    note: "Vendor / security-vendor disclosures, security-research blogs, defensive write-ups. Mid-high value when primary.",
  },
  government: {
    label: "Government",
    target: [0.05, 0.15],
    note: "Government / policy advisories (CISA, NCSC, NIST) and governance signals. Authoritative context.",
  },
  other: {
    label: "Other / Context",
    target: [0.00, 0.15],
    note: "Attack-surface, societal-harm, unknown, and uncategorised context.",
  },
};

export const BUCKET_ORDER = [
  "research",
  "vulnerability",
  "incident",
  "threat_intelligence",
  "operational_campaign",
  "vendor_advisory",
  "government",
  "other",
];

// Hard rule: if research exceeds this share of the corpus, the run is flagged
// CRITICAL — the deck will lean on papers instead of real-world activity.
export const RESEARCH_HARD_CEILING = 0.40; // operational TI product: research must not dominate
// Min share for operational lanes combined (incident + threat_intel + operational_campaign)
export const OPERATIONAL_FLOOR = 0.30;

/**
 * Map a raw source_type string to an analytical bucket.
 *
 * Handles BOTH vocabularies present in the live corpus:
 *   - canonical 12-type vocab (lib/config/sourceTypes.js): research_finding,
 *     vulnerability, incident, threat_intelligence, adversary_adoption_signal, …
 *   - coarse connector types still on most rows: research_paper,
 *     vulnerability_advisory, threat_intel, news_article, vendor_report, …
 */
export function bucketForSourceType(sourceType) {
  const t = String(sourceType || "unknown").toLowerCase().trim();

  // Research / lab / benchmark
  if ([
    "research_paper", "research_finding", "academic_research",
    "benchmark_evaluation", "dataset_or_benchmark", "capability_demonstration",
  ].includes(t)) return "research";

  // Vulnerabilities (disclosed + exploited)
  if ([
    "vulnerability", "vulnerability_advisory", "exploit_disclosure",
  ].includes(t)) return "vulnerability";

  // Real-world incidents
  if (["incident", "incident_report"].includes(t)) return "incident";

  // Threat intelligence / adversary tracking / IR
  if ([
    "threat_intelligence", "threat_intel", "threat_intelligence_report",
  ].includes(t)) return "threat_intelligence";

  // Operational campaigns / adversary adoption in the wild
  if (["adversary_adoption_signal", "operational_campaign"].includes(t)) {
    return "operational_campaign";
  }

  // Vendor / security-vendor disclosures, security blogs, defensive write-ups
  if ([
    "vendor_report", "vendor_advisory", "security_blog", "news_article",
    "news", "defensive_capability",
  ].includes(t)) return "vendor_advisory";

  // Government / policy
  if ([
    "government_advisory", "governance_signal", "policy_regulatory_signal",
  ].includes(t)) return "government";

  // Everything else (attack_surface_signal, societal_harm_signal, unknown, …)
  return "other";
}

/**
 * Build the source-composition audit for a set of sources.
 *
 * @param {object[]} sources  - Sources used in the run (post-validation, in-window).
 *                              Each must have a `source_type` (and ideally publisher/category).
 * @returns {object} composition audit
 */
export function buildCorpusComposition(sources = []) {
  const total = sources.length;

  // Bucket counts + raw source_type tallies within each bucket
  const counts = {};
  const rawTypeByBucket = {};
  for (const key of BUCKET_ORDER) { counts[key] = 0; rawTypeByBucket[key] = {}; }

  const publisherCounts = {};

  for (const s of sources) {
    const bucket = bucketForSourceType(s.source_type);
    counts[bucket]++;
    const rt = String(s.source_type || "unknown");
    rawTypeByBucket[bucket][rt] = (rawTypeByBucket[bucket][rt] || 0) + 1;

    const pub = s.publisher || "unknown";
    publisherCounts[pub] = (publisherCounts[pub] || 0) + 1;
  }

  // Distribution + target evaluation
  const distribution = BUCKET_ORDER.map((key) => {
    const n = counts[key];
    const share = total > 0 ? n / total : 0;
    const [min, max] = BUCKETS[key].target;
    let status = "ok";
    if (share < min) status = "under";
    else if (share > max) status = "over";
    return {
      bucket: key,
      label: BUCKETS[key].label,
      count: n,
      share,
      pct: +(share * 100).toFixed(1),
      target: [min, max],
      target_pct: `${Math.round(min * 100)}-${Math.round(max * 100)}%`,
      status,
      raw_types: rawTypeByBucket[key],
    };
  });

  // Source concentration — how dominated is the corpus by a few publishers?
  const topPublishers = Object.entries(publisherCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([publisher, count]) => ({ publisher, count, pct: +((count / total) * 100).toFixed(1) }));
  const top2Share = topPublishers.slice(0, 2).reduce((s, p) => s + p.count, 0) / (total || 1);

  // ── Warnings ────────────────────────────────────────────────────────────────
  const warnings = [];
  const researchShare = total > 0 ? counts.research / total : 0;

  if (researchShare > RESEARCH_HARD_CEILING) {
    warnings.push({
      severity: "critical",
      code: "research_dominated",
      message: `Research is ${(researchShare * 100).toFixed(0)}% of the corpus (hard ceiling ${RESEARCH_HARD_CEILING * 100}%). This is a literature review, not threat intelligence. Operational conclusions will be weak — expand Lane B/C/D connectors (GHSA, CISA KEV, incident feeds, TI vendor blogs).`,
    });
  }

  // Operational floor: incident + threat_intel + adversary must reach 30% combined
  const operationalShare = total > 0
    ? ((counts.incident || 0) + (counts.threat_intelligence || 0) + (counts.operational_campaign || 0)) / total
    : 0;
  if (operationalShare < OPERATIONAL_FLOOR) {
    warnings.push({
      severity: "critical",
      code: "insufficient_operational",
      message: `Operational lanes (incident + threat-intel + adversary) are only ${(operationalShare * 100).toFixed(0)}% combined (floor ${OPERATIONAL_FLOOR * 100}%). Executive insights will lack confirmed real-world grounding. Run backfillOperational.js to add incident and TI sources.`,
    });
  }

  // Under-represented individual buckets
  for (const key of ["vulnerability", "incident", "threat_intelligence", "operational_campaign"]) {
    const d = distribution.find((x) => x.bucket === key);
    if (d && d.status === "under") {
      warnings.push({
        severity: "warning",
        code: `under_${key}`,
        message: `${d.label} is ${d.pct}% (target ${d.target_pct}). Under-represented — conclusions in this area rest on thin real-world grounding.`,
      });
    }
  }

  if (top2Share > 0.80) {
    warnings.push({
      severity: "warning",
      code: "publisher_concentration",
      message: `Top 2 publishers (${topPublishers.slice(0, 2).map((p) => p.publisher).join(", ")}) are ${(top2Share * 100).toFixed(0)}% of the corpus. Diversify connectors to avoid single-source monoculture.`,
    });
  }

  const balanced = !warnings.some((w) => w.severity === "critical");

  return {
    total,
    distribution,
    top_publishers: topPublishers,
    top2_publisher_share: +(top2Share * 100).toFixed(1),
    research_share: +(researchShare * 100).toFixed(1),
    warnings,
    balanced,
  };
}

/**
 * Render the composition audit as a plain-text block for run logs / checkpoints.
 *
 * @param {object} composition - output of buildCorpusComposition()
 * @returns {string}
 */
export function formatCompositionReport(composition) {
  const lines = [];
  lines.push("Source Type Distribution");
  lines.push("─".repeat(48));
  for (const d of composition.distribution) {
    if (d.count === 0 && d.bucket === "other") continue;
    const bar = "█".repeat(Math.round(d.share * 30));
    const flag = d.status === "over" ? " ▲over" : d.status === "under" ? " ▽under" : "";
    lines.push(
      `${d.label.padEnd(22)} ${String(d.pct).padStart(5)}%  (${d.count})  [target ${d.target_pct}]${flag}`,
    );
    if (bar) lines.push(`${" ".repeat(22)} ${bar}`);
  }
  lines.push("─".repeat(48));
  lines.push(`Total sources: ${composition.total}   Top-2 publisher share: ${composition.top2_publisher_share}%`);

  if (composition.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of composition.warnings) {
      const tag = w.severity === "critical" ? "✖ CRITICAL" : w.severity === "warning" ? "⚠ WARN" : "· info";
      lines.push(`  ${tag}  ${w.message}`);
    }
  } else {
    lines.push("✓ Corpus composition within diversity targets.");
  }

  return lines.join("\n");
}
