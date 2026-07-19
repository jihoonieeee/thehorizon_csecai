/**
 * Development Generation — slide concern.
 *
 * Derives Development objects from the L6 CategoryAnalysis[] output.
 * Accepts both the new shape (insights[]) and legacy shape (judgments[]).
 * No LLM calls — fully deterministic derivation.
 *
 * Each Development object:
 *   - title: from insight.title or insight.what_changed first sentence
 *   - named_entities: CVEs, actors, products extracted by regex
 *   - ranking: by evidence_maturity
 *   - evidence_item_ids: from insight.evidence_item_ids
 */

import { randomUUID } from "crypto";

const CVE_RE_G    = /\bCVE-\d{4}-\d{4,}\b/gi;
const ACTOR_RE_G  = /\b(APT\d+|lazarus|sandworm|cozy bear|fancy bear|volt typhoon|scattered spider|lapsus|cl0p|alphv|lockbit|blackcat|conti|revil|darkside|ryuk|evil corp|ta\d+|unc\d+|cobalt group|fin\d+|nullifai|honestcue)\b/gi;
const PRODUCT_RE_G = /\b(openai|anthropic|google|microsoft|langchain|langsmith|hugging ?face|ollama|mistral|llama|gpt-?[34]|claude|gemini|copilot|cursor|mcp|autogpt|crewai|gradio|vllm|ray|mlflow|litellm|livekit|crewai|agentops)\b/gi;

const MATURITY_RANK = {
  operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
  disclosed_vulnerability: 2, research_demonstration: 1,
};

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
  return MATURITY_RANK[j.evidence_maturity] || 0;
}

// ── Per-category derivation ───────────────────────────────────────────────────

export function deriveDevelopmentsFromJudgments(category, judgments) {
  const approved = (judgments || [])
    .filter(j => !j.blocked && (j.what_changed || "").trim().length >= 20)
    .sort((a, b) => judgmentScore(b) - judgmentScore(a))
    .slice(0, 3);

  return approved.map((j, i) => {
    // Support both new insight shape and legacy judgment shape
    const titleText  = j.title || j.judgment || "";
    const whatText   = j.what_changed || "";
    const allText    = [titleText, whatText, j.implication || j.why_this_matters || ""].filter(Boolean).join(" ");
    const named_entities = extractNamedEntities(allText);
    // New shape uses evidence_item_ids; legacy uses evidence_for
    const evidence_ids = (j.evidence_item_ids || j.evidence_for || []).filter(Boolean);

    return {
      development_id:       randomUUID(),
      category,
      title:                (j.title || makeTitle(j)).slice(0, 100),
      what_changed:         whatText.slice(0, 300) || titleText.slice(0, 300),
      named_entities,
      evidence_ids,
      evidence_maturity:    j.evidence_maturity || "research_demonstration",
      is_first_occurrence:  false,
      recency:              "within this reporting period",
      source_count:         (j.cited_sources || []).length || evidence_ids.length,
      rank_within_category: i + 1,
      _source_id:           j.insight_id || j.judgment_id,
    };
  });
}

// ── Overall top-3 across categories ──────────────────────────────────────────

export function selectOverallDevelopments(allCategoryDevelopments) {
  const all = Object.values(allCategoryDevelopments).flat();
  return all
    .sort((a, b) => (MATURITY_RANK[b.evidence_maturity] || 0) - (MATURITY_RANK[a.evidence_maturity] || 0))
    .slice(0, 3)
    .map((d, i) => ({ ...d, scope: "overall", rank: i + 1 }));
}

// ── Batch wrapper — accepts new CategoryAnalysis[] or legacy categoryAnalyses[] ──

export async function generateAllDevelopments(_unused, _unused2, _unused3, opts = {}, categoryAnalyses = []) {
  const results = {};

  for (const ca of categoryAnalyses) {
    // New shape: insights[]; legacy shape: judgments[]
    const items = ca.insights?.length ? ca.insights : (ca.judgments || []);
    const devs  = deriveDevelopmentsFromJudgments(ca.category, items);
    results[ca.category] = devs;
    process.stdout.write(`  [slides] ${ca.category}: ${devs.length} developments derived\n`);
  }

  const total   = Object.values(results).flat().length;
  const overall = selectOverallDevelopments(results);
  process.stdout.write(`  [slides] ${total} total developments; ${overall.length} overall selected\n`);
  return { byCategory: results, overall };
}
