/**
 * Layer 5C.3 — Generate targeted queries per mission.
 *
 * Multiple query styles (broad, technical, case_study, visual, benchmark,
 * authoritative, corroboration, walkthrough, incident, original_report, pdf,
 * figure_table). Visual missions add visual modifiers. Queries are seeded with
 * taxonomy-v9 tag phrases + provided entities. Deterministic (no LLM); an
 * optional cheap-LLM polish hook can be layered on later.
 */

import { getTag, getSubTechniques } from "../../config/taxonomyRegistry.js";
import { missionMeta } from "./buildWebEvidenceMissions.js";

const YEAR = String(new Date().getUTCFullYear());

const VISUAL_MODIFIERS = [
  "diagram", "architecture", "attack chain", "exploit flow", "timeline",
  "chart", "graph", "benchmark table", "figure", "framework map", "threat model",
];

// Per-category seed phrasing when no taxonomy tag is supplied.
const CATEGORY_PHRASE = {
  traditional_ai_threats: "adversarial machine learning",
  llm_threats: "LLM prompt injection",
  agentic_ai_threats: "AI agent MCP",
  ai_enabled_threats: "AI-enabled cyberattack",
};

function tagPhrase(tagId) {
  const t = getTag(tagId);
  if (t) return t.label.toLowerCase();
  return String(tagId || "").replace(/^[A-Z]+\d+_/, "").replace(/_/g, " ");
}

// Mission → the query-style suffixes that fit its intent.
const MISSION_STYLE_SUFFIXES = {
  major_incident_case_study:   ["incident case study", "breach analysis", "incident report"],
  attack_walkthrough:          ["attack chain walkthrough", "exploit walkthrough", "step by step exploit"],
  recent_major_vulnerability:  ["vulnerability CVE", "security advisory", "vulnerability analysis"],
  new_attack_surface:          ["new attack surface", "novel attack technique"],
  new_actor_adoption:          ["threat actor using", "adversary adoption report"],
  new_exploit_or_poc:          ["proof of concept exploit", "PoC GitHub"],
  benchmark_or_dataset:        ["benchmark results", "evaluation dataset", "benchmark comparison"],
  statistics_or_trend_data:    ["statistics report", "trend data", "loss statistics"],
  visual_evidence:             ["diagram", "chart", "figure"],
  framework_or_taxonomy_visual:["framework diagram", "taxonomy map", "threat model diagram"],
  defensive_bypass:            ["guardrail bypass", "defense bypass research"],
  ai_enabled_operational_use:  ["AI used in attack", "operational AI threat report"],
  agentic_tool_or_mcp_abuse:   ["MCP tool poisoning", "agent tool abuse exploit"],
  rag_vector_embedding_weakness:["RAG poisoning", "vector database attack", "embedding inversion"],
  ai_supply_chain_compromise:  ["malicious model supply chain", "poisoned ML dependency"],
  evidence_gap_case_study:     ["case study", "real-world incident"],
  evidence_gap_visual:         ["diagram", "chart", "figure"],
  evidence_gap_quantitative:   ["benchmark", "statistics", "dataset"],
  evidence_gap_operational:    ["incident report", "exploit report"],
  evidence_gap_recent_development:["latest", "new technique", "recent report"],
};

const STYLE_FOR_SUFFIX = (suffix) =>
  /walkthrough|step by step|exploit chain/.test(suffix) ? "walkthrough" :
  /case study|incident|breach/.test(suffix) ? "case_study" :
  /benchmark|dataset|statistics|trend|comparison|loss/.test(suffix) ? "benchmark" :
  /diagram|chart|figure|map|threat model|architecture/.test(suffix) ? "visual" :
  /CVE|vulnerability|advisory/.test(suffix) ? "incident" :
  /PoC|proof of concept|GitHub/.test(suffix) ? "exploit_walkthrough" : "technical_depth";

function uniqByQuery(arr) {
  const seen = new Set();
  return arr.filter((q) => {
    const k = q.query.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Generate query objects for a mission.
 *
 * @param {object} mission  { mission, category, visual, source_classes, taxonomy_tags }
 * @param {object} [opts]   { entities = [], maxQueries }
 * @returns {object[]} { query, style, source_class_hint, visual, mission, category }
 */
export function generateWebEvidenceQueries(mission, opts = {}) {
  const { entities = [], maxQueries = 8 } = opts;
  const meta = missionMeta(mission.mission);
  const suffixes = MISSION_STYLE_SUFFIXES[mission.mission] || ["report"];

  // Seed phrases: taxonomy tags if any, else the category phrase.
  const seeds = (mission.taxonomy_tags && mission.taxonomy_tags.length)
    ? mission.taxonomy_tags.map(tagPhrase)
    : [CATEGORY_PHRASE[mission.category] || mission.category.replace(/_/g, " ")];

  const out = [];
  const primaryClass = (mission.source_classes || [])[0] || null;

  for (const seed of seeds.slice(0, 3)) {
    for (const suffix of suffixes) {
      const base = `${seed} ${suffix} ${YEAR}`;
      out.push({ query: base, style: STYLE_FOR_SUFFIX(suffix), source_class_hint: primaryClass, visual: meta.visual, mission: mission.mission, category: mission.category });
    }
    // Authoritative + PDF/report tracing variants.
    out.push({ query: `${seed} report PDF ${YEAR}`, style: "pdf", source_class_hint: primaryClass, visual: meta.visual, mission: mission.mission, category: mission.category });
    out.push({ query: `${seed} original report`, style: "original_report", source_class_hint: primaryClass, visual: meta.visual, mission: mission.mission, category: mission.category });

    // Visual missions: add figure/table + visual-modifier variants.
    if (meta.visual) {
      for (const mod of VISUAL_MODIFIERS.slice(0, 4)) {
        out.push({ query: `${seed} ${mod}`, style: "visual", source_class_hint: primaryClass, visual: true, mission: mission.mission, category: mission.category });
      }
    }
  }

  // Entity-seeded corroboration queries (CVE/product/tool/attack names).
  for (const e of entities.slice(0, 4)) {
    out.push({ query: `${e} ${meta.visual ? "diagram" : "technical analysis"}`, style: meta.visual ? "visual" : "corroboration", source_class_hint: primaryClass, visual: meta.visual, mission: mission.mission, category: mission.category });
  }

  return uniqByQuery(out).slice(0, maxQueries);
}
