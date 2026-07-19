/**
 * L6 Step 4 — Insight QA Gate
 *
 * Deterministic quality checks on generated insights. No LLM calls.
 *
 * Hard blocks:
 *   • 0 valid cited sources
 *   • empty critical analytical fields
 *
 * Deterministic fact-checks:
 *   • Quote fuzzy-match: cited quote must share key phrases with the source summary
 *   • Maturity rule: operational_campaign/adversary_adoption/observed_exploitation
 *     each require source characteristics that support the claim
 *   • Named CVE cross-check: CVEs in the title must appear in a cited source's
 *     short_summary or tags
 *
 * Soft flags (do not block):
 *   • Single-source without caveat
 *   • Vague title language
 *   • No monitoring signal
 *   • Research maturity without caveat
 */

const HEDGE_VERBS = /\b(increasing|growing|evolving|expanding|developing|improving|continuing|emerging|rising|advancing)\b/i;
const VAGUE_TITLE = /\b(increasingly|more|greater|higher|wider|better|faster|sophisticated|effective|prevalent|significant|common)\b/i;
const CVE_RE      = /\bCVE-\d{4}-\d{4,}\b/gi;

// ── Quote fuzzy-match ─────────────────────────────────────────────────────────
// Checks whether key phrases from the cited quote appear in the source's available
// text (short_summary). Not an exact match — finds 4-gram overlap.
// sourceMap: { [source_id]: source object with short_summary }

function extractNgrams(text, n = 4) {
  const words = (text || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const grams = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function quoteAppearsInSource(quote, sourceText) {
  if (!quote || !sourceText) return null; // can't verify — don't penalise
  const quoteGrams  = extractNgrams(quote, 4);
  const sourceGrams = extractNgrams(sourceText, 4);
  if (quoteGrams.size === 0) return null;
  let matches = 0;
  for (const g of quoteGrams) { if (sourceGrams.has(g)) matches++; }
  // At least 30% of 4-grams from the quote must appear in the source text
  return matches / quoteGrams.size >= 0.30;
}

// ── Maturity rule validation ──────────────────────────────────────────────────
// These are hard maturity-specific source requirements.
// Violations are flagged but do NOT block — they downgrade confidence in reporting.

const HIGH_TRUST = new Set(["primary", "high"]);
const INCIDENT_ORIGIN = new Set(["incident_response", "threat_intelligence", "government_advisory"]);

function validateMaturity(insight, sourceMap) {
  const mat = insight.evidence_maturity;
  if (!mat) return [];
  const issues = [];
  const cited = (insight.cited_sources || []).map(cs => sourceMap?.[cs.source_id]).filter(Boolean);

  if (mat === "operational_campaign") {
    const hasHighTrustSource = cited.some(s => HIGH_TRUST.has(s.trust_tier));
    if (!hasHighTrustSource) issues.push("maturity_operational_no_high_trust_source");
  }

  if (mat === "observed_exploitation" || mat === "adversary_adoption" || mat === "operational_campaign") {
    const hasIncidentSource = cited.some(s =>
      INCIDENT_ORIGIN.has(s.source_type) ||
      s.trust_tier === "primary" ||
      (s.intelligence?.maturity_level || "") === "operational" ||
      (s.intelligence?.maturity_level || "") === "observed"
    );
    if (!hasIncidentSource) issues.push(`maturity_${mat}_no_incident_source`);
  }

  return issues;
}

// ── Named CVE cross-check ─────────────────────────────────────────────────────
// If the insight title mentions a CVE, at least one cited source must reference it.

function validateNamedCves(insight) {
  const titleCves = [...(insight.title || "").matchAll(CVE_RE)].map(m => m[0].toUpperCase());
  if (!titleCves.length) return [];

  const sourceCveText = (insight.cited_sources || []).map(cs =>
    `${cs.source_title || ""} ${cs.quote || ""} ${cs.evidence_summary || ""}`.toUpperCase()
  ).join(" ");

  const missing = titleCves.filter(cve => !sourceCveText.includes(cve));
  return missing.map(cve => `title_cve_not_in_sources: ${cve}`);
}

/**
 * Run QA checks on a single insight.
 * sourceMap: { [source_id]: source_row } — for deterministic fact-checks.
 * Returns the insight annotated with { blocked, qa_issues[] }.
 */
function checkInsight(insight, sourceMap = {}) {
  const issues = [];

  // ── Hard blocks ──────────────────────────────────────────────────────────────

  if (!insight.cited_sources || insight.cited_sources.length === 0) {
    issues.push("no_valid_citations");
  }

  const CRITICAL = ["title", "what_changed", "mechanism", "implication"];
  for (const f of CRITICAL) {
    if (!insight[f] || String(insight[f]).trim().length < 20) {
      issues.push(`empty_${f}`);
    }
  }

  // ── Deterministic fact-checks (soft — do not block, but surface) ─────────────

  // Quote fuzzy-match: cited quotes should share phrases with the source summary
  for (const cs of insight.cited_sources || []) {
    const src = sourceMap[cs.source_id];
    const srcText = [src?.short_summary, src?.analyst_brief].filter(Boolean).join(" ");
    const result = quoteAppearsInSource(cs.quote, srcText);
    if (result === false) {
      // result is null when text is unavailable — only flag when we have text and it fails
      issues.push(`quote_not_in_source: ${cs.publisher || cs.source_id?.slice(0, 8)}`);
    }
  }

  // Maturity rule: check source characteristics support the assigned maturity
  issues.push(...validateMaturity(insight, sourceMap));

  // Named CVE cross-check
  issues.push(...validateNamedCves(insight));

  // ── Soft flags ───────────────────────────────────────────────────────────────

  if (insight.title && (HEDGE_VERBS.test(insight.title) || VAGUE_TITLE.test(insight.title))) {
    issues.push("vague_title");
  }

  if (insight.title && insight.title.split(/\s+/).length > 15) {
    issues.push("title_too_long");
  }

  const isSingleSource = (insight.cited_sources || []).length === 1;
  const hasSingleSourceCaveat = (insight.caveats || []).some(c => /single.source/i.test(c));
  if (isSingleSource && !hasSingleSourceCaveat) {
    issues.push("single_source_no_caveat");
  }

  if (insight.evidence_maturity === "research_demonstration") {
    const hasResearchCaveat = (insight.caveats || []).some(c => /lab|research|no.*wild|unconfirmed/i.test(c));
    if (!hasResearchCaveat) issues.push("research_maturity_no_caveat");
  }

  if (!insight.monitoring_signal || insight.monitoring_signal.trim().length < 15) {
    issues.push("no_monitoring_signal");
  }

  // Hard blocks only on citation and field failures — fact-check issues are soft
  const blocked = issues.some(i =>
    i === "no_valid_citations" ||
    i.startsWith("empty_")
  );

  return { ...insight, blocked, qa_issues: issues };
}

/**
 * Run QA over all insights for a category.
 *
 * @param {object[]} insights
 * @param {object}   [sourceMap] - { [source_id]: source_row } for fact-checks
 * @returns {{ insights: object[], qa_report: object }}
 */
export function qaInsights(insights, sourceMap = {}) {
  const checked = (insights || []).map(ins => checkInsight(ins, sourceMap));

  const blocked   = checked.filter(i => i.blocked).length;
  const approved  = checked.filter(i => !i.blocked).length;
  const flagged   = checked.filter(i => !i.blocked && i.qa_issues.length > 0).length;
  const allIssues = checked.flatMap(i => i.qa_issues);

  const issueCounts = {};
  for (const issue of allIssues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;

  return {
    insights: checked,
    qa_report: {
      total:    checked.length,
      approved,
      blocked,
      flagged,
      issue_counts: issueCounts,
    },
  };
}
