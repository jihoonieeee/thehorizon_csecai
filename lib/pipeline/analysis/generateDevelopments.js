/**
 * L6.1 — Development Generation
 *
 * "What changed?" — derives Development objects directly from approved synthesis
 * judgments (L6 category_analysis). A judgment's `what_changed` field IS the
 * development: it already answers "what objectively changed this period" and has
 * passed two-pass QA. No new LLM call is needed.
 *
 * This design avoids the "refuses to cite exact evidence IDs" failure mode of
 * prompt-based generation. The judgments already have verified evidence_for[],
 * evidence_maturity, confidence, and what_changed text.
 *
 * Each Development object adds:
 *   - title (≤12 words from what_changed or short_takeaway)
 *   - named_entities (extracted deterministically from judgment + what_changed text)
 *   - ranking (by evidence_maturity + confidence)
 *
 * Also produces top-3 overall developments across all categories.
 */

import { randomUUID } from "crypto";

const CVE_RE_G    = /\bCVE-\d{4}-\d{4,}\b/gi;
const ACTOR_RE_G  = /\b(APT\d+|lazarus|sandworm|cozy bear|fancy bear|volt typhoon|scattered spider|lapsus|cl0p|alphv|lockbit|blackcat|conti|revil|darkside|ryuk|evil corp|ta\d+|unc\d+|cobalt group|fin\d+|nullifai|honestcue)\b/gi;
const PRODUCT_RE_G = /\b(openai|anthropic|google|microsoft|langchain|langsmith|hugging ?face|ollama|mistral|llama|gpt-?[34]|claude|gemini|copilot|cursor|mcp|autogpt|crewai|gradio|vllm|ray|mlflow|litellm|livekit|crewai|agentops)\b/gi;

const MATURITY_RANK = {
  operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
  disclosed_vulnerability: 2, research_demonstration: 1,
};
const CONF_RANK = { high: 3, medium: 2, low: 1 };

function extractNamedEntities(text) {
  const t = text || "";
  const cves    = [...new Set((t.match(CVE_RE_G)    || []).map(s => s.toUpperCase()))];
  const actors  = [...new Set((t.match(ACTOR_RE_G)  || []).map(s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())))];
  const products= [...new Set((t.match(PRODUCT_RE_G)|| []).map(s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())))];
  return [...cves, ...actors, ...products].slice(0, 6);
}

function makeTitle(j) {
  // Prefer short_takeaway (already ≤15 words), else first sentence of what_changed
  if (j.short_takeaway && j.short_takeaway.trim().length > 10) {
    return j.short_takeaway.trim().slice(0, 100);
  }
  const wc = (j.what_changed || j.judgment || "").trim();
  const first = wc.split(/[.!?]/)[0].trim();
  return first.slice(0, 100) || wc.slice(0, 100);
}

function judgmentScore(j) {
  return (MATURITY_RANK[j.evidence_maturity] || 0) + (CONF_RANK[j.confidence] || 0);
}

// ── Per-category derivation ───────────────────────────────────────────────────

export function deriveDevelopmentsFromJudgments(category, judgments) {
  const approved = (judgments || [])
    .filter(j => !j.blocked && (j.what_changed || "").trim().length >= 20)
    .sort((a, b) => judgmentScore(b) - judgmentScore(a))
    .slice(0, 3);

  return approved.map((j, i) => {
    const allText = [j.judgment, j.what_changed, j.why_this_matters].filter(Boolean).join(" ");
    const named_entities = extractNamedEntities(allText);
    const evidence_ids   = (j.evidence_for || []).filter(Boolean);

    return {
      development_id:       randomUUID(),
      category,
      title:                makeTitle(j),
      what_changed:         (j.what_changed || j.judgment || "").trim(),
      named_entities,
      evidence_ids,
      evidence_maturity:    j.evidence_maturity || "research_demonstration",
      confidence:           j.confidence || "low",
      is_first_occurrence:  false,
      recency:              "within this reporting period",
      source_count:         evidence_ids.length,
      rank_within_category: i + 1,
      _derived_from_judgment_id: j.judgment_id,
    };
  });
}

// ── Overall top-3 across categories ──────────────────────────────────────────

export function selectOverallDevelopments(allCategoryDevelopments) {
  const all = Object.values(allCategoryDevelopments).flat();
  return all
    .sort((a, b) =>
      (MATURITY_RANK[b.evidence_maturity] || 0) + (CONF_RANK[b.confidence] || 0) -
      ((MATURITY_RANK[a.evidence_maturity] || 0) + (CONF_RANK[a.confidence] || 0))
    )
    .slice(0, 3)
    .map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function generateAllDevelopments(packs, allPatterns, corpusSummary, opts = {}, categoryAnalyses = []) {
  const results = {};

  for (const ca of categoryAnalyses) {
    const devs = deriveDevelopmentsFromJudgments(ca.category, ca.judgments || []);
    results[ca.category] = devs;
    const flagged = devs.filter(d => d._insight_candidate).length;
    process.stdout.write(`  [L6.1] ${ca.category}: ${devs.length} developments derived from judgments\n`);
  }

  // Fallback: any category in ACTIVE_CATEGORIES not covered by analyses
  const covered = new Set(Object.keys(results));
  if (packs && typeof packs === "object") {
    for (const cat of Object.keys(packs)) {
      if (!covered.has(cat)) results[cat] = [];
    }
  }

  const total = Object.values(results).flat().length;
  const overall = selectOverallDevelopments(results);
  process.stdout.write(`  [L6.1] ${total} total developments; ${overall.length} overall top developments selected\n`);
  return { byCategory: results, overall };
}
