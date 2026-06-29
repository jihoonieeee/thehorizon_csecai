/**
 * v2 — Dashboard Backend
 *
 * Provides two distinct retrieval paths:
 *
 * 1. OVERVIEW (precomputed, fast)
 *    buildDashboardState() — assembles the landing page data from the latest run:
 *    - 4-category threat landscape panel (status + top judgment per category)
 *    - Recent evidence highlights (new strong items this week)
 *    - Tag frequency trends
 *    - Corpus health metrics
 *
 * 2. QUERY (on-demand synthesis, ~3-8s)
 *    queryDashboard() — answers a natural language question:
 *    "What changed in the coding-agent landscape this quarter?"
 *    Uses entity extraction → evidence graph traversal → focused LLM synthesis
 *    Returns a grounded answer with inline citations.
 *
 * This replaces the pre-computed dashboard_intelligence_objects architecture.
 * Pre-computation locked in which judgments are "important"; the query path
 * lets the question determine importance.
 */

import { routedLLM } from "../llm/llmRouter.js";
import { callLLM }   from "../llm/callLLM.js";
import { DOMAIN_COLOURS, buildEvidenceGraph } from "./corpusSummary.js";
import { DOMAINS, tagsForDomain, buildTaxonomyPromptBlock } from "./taxonomy.js";
import { CATEGORY_LABELS } from "../config/categories.js";

// ── Trend classification ──────────────────────────────────────────────────────
// Deterministic, based on evidence count and recency. No LLM.

function classifyTrend(approvedJudgments, evidenceItems, category) {
  const catItems = evidenceItems.filter(ei => ei.category === category && ei.is_cluster_rep);
  const strongCount = catItems.filter(ei => ei.quote_grounded && ei.specificity === "high").length;
  const recentCount = catItems.filter(ei => {
    const src_date = ei.source_date || "";
    if (!src_date) return false;
    const age = (Date.now() - new Date(src_date).getTime()) / (1000 * 60 * 60 * 24);
    return age <= 30;
  }).length;

  if (approvedJudgments.length === 0 || catItems.length < 2) return "insufficient_evidence";
  if (strongCount >= 3 && approvedJudgments.length >= 2)      return "confirmed_trend";
  if (recentCount >= 2)                                         return "emerging_signal";
  return "isolated_case";
}

// ── 1. Build dashboard state ──────────────────────────────────────────────────

/**
 * Builds the full dashboard landing state from a completed pipeline run.
 * Call this after synthesizeAllCategories() and extractAllEvidence().
 *
 * @param {object}   runResult  - Full result from runPipeline()
 * @returns {object}            Dashboard state object
 */
export function buildDashboardState(runResult) {
  const {
    category_analyses = [],
    evidence_items    = [],
    corpus_summary    = {},
    cross_category    = {},
    run_id,
    run_date,
  } = runResult;

  // ── Category cards ─────────────────────────────────────────────────────────
  const category_cards = category_analyses
    .filter(ca => ca.category !== "unclear_or_adjacent")
    .map(ca => {
      const approved = (ca.judgments || []).filter(j => !j.blocked);
      const top      = approved[0] || null;
      const trend    = classifyTrend(approved, evidence_items, ca.category);
      const srcCount = corpus_summary.source_count_by_category?.[ca.category] || 0;
      const evCount  = evidence_items.filter(
        ei => ei.category === ca.category && ei.is_cluster_rep
      ).length;

      return {
        category:        ca.category,
        display_name:    CATEGORY_LABELS[ca.category] || ca.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        colour:          DOMAIN_COLOURS[ca.category] || "#94a3b8",
        trend_status:    trend,
        assessment_status: ca.assessment_status,
        source_count:    srcCount,
        evidence_count:  evCount,
        judgment_count:  approved.length,

        // Top judgment for the card headline
        top_judgment: top ? {
          judgment_id:   top.judgment_id,
          short_takeaway: top.short_takeaway || top.judgment?.slice(0, 80),
          confidence:    top.confidence,
          evidence_ids:  top.evidence_for || [],
        } : null,

        // All judgments for the drilldown panel
        judgments: approved.map(j => ({
          judgment_id:   j.judgment_id,
          judgment:      j.judgment,
          short_takeaway: j.short_takeaway,
          what_changed:  j.what_changed,
          why_this_matters: j.why_this_matters,
          confidence:    j.confidence,
          caveats:       j.caveats || [],
          evidence_for:  j.evidence_for || [],
          evidence_against: j.evidence_against || [],
          technique_focus: j.technique_focus || [],
          monitoring_signals: j.monitoring_signals || [],
          recommended_action: j.recommended_action || "",
        })),

        coverage_gaps: ca.evidence_gaps || [],
      };
    });

  // ── Recent evidence highlights (last 14 days) ─────────────────────────────
  const now = Date.now();
  const recent_evidence = evidence_items
    .filter(ei => {
      if (!ei.is_cluster_rep) return false;
      if (ei.specificity !== "high") return false;
      if (!ei.quote_grounded) return false;
      return true;
    })
    .sort((a, b) => (b.source_date || "").localeCompare(a.source_date || ""))
    .slice(0, 12)
    .map(ei => ({
      evidence_id:   ei.evidence_id,
      fact:          ei.fact?.slice(0, 200),
      source_title:  ei.source_title?.slice(0, 80),
      source_url:    ei.source_url,
      evidence_type: ei.evidence_type,
      category:      ei.category,
      technique_tags:ei.technique_tags?.slice(0, 3),
    }));

  // ── Tag trends (top 10 tags by source count) ─────────────────────────────
  const tag_freq = corpus_summary.tag_frequency || {};
  const tag_trends = Object.entries(tag_freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  // ── Cross-category patterns ────────────────────────────────────────────────
  const patterns = (cross_category?.patterns || []).map(p => ({
    pattern:      p.pattern,
    description:  p.description,
    categories:   p.categories || [],
    implication:  p.implication,
    evidence_ids: p.evidence_ids || [],
  }));

  // ── Corpus health ─────────────────────────────────────────────────────────
  const corpus_health = {
    total_sources:    corpus_summary.total_sources || 0,
    relevant_sources: corpus_summary.relevant_sources || 0,
    date_range:       corpus_summary.date_range || "unknown",
    thin_categories:  corpus_summary.thin_categories || [],
    top_entities:     (corpus_summary.top_entities || []).slice(0, 10),
    source_type_breakdown: corpus_summary.source_count_by_type || {},
  };

  return {
    run_id,
    run_date: run_date || new Date().toISOString(),
    category_cards,
    recent_evidence,
    tag_trends,
    patterns,
    corpus_health,
    _dashboard_version: "dashboard-v2.0",
  };
}

// ── 2. Query engine ────────────────────────────────────────────────────────────

// ── 2a. Entity extraction from query ─────────────────────────────────────────

const QUERY_PARSE_SCHEMA = {
  type: "object",
  properties: {
    entities:   { type: "array", items: { type: "string" } },
    categories: { type: "array", items: { type: "string" } },
    tags:       { type: "array", items: { type: "string" } },
    time_range_days: { type: "number" },
    intent:     { type: "string", enum: ["what_changed", "how_severe", "who_is_doing", "what_to_do", "general"] },
  },
  required: ["entities", "categories", "intent"],
};

async function parseQuery(question) {
  const sys = `You extract structured search parameters from cybersecurity intelligence queries.
${buildTaxonomyPromptBlock()}
Return JSON with: entities (specific names/CVEs/tools), categories (from taxonomy domains), tags (taxonomy tag IDs), time_range_days (e.g. 90 for "this quarter"), intent.`;
  const usr = `Parse this query: "${question}"`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "source_understanding",
        requires_json: true,
        schema: QUERY_PARSE_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: QUERY_PARSE_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return raw;
  } catch {
    return { entities: [], categories: [], tags: [], time_range_days: 90, intent: "general" };
  }
}

// ── 2b. Graph traversal ───────────────────────────────────────────────────────

function traverseGraph(graph, queryParams, evidenceItems) {
  const { entities = [], categories = [], tags = [], time_range_days = 90 } = queryParams;

  const entitySet   = new Set(entities.map(e => e.toLowerCase()));
  const categorySet = new Set(categories);
  const tagSet      = new Set(tags);
  const cutoff      = Date.now() - time_range_days * 24 * 60 * 60 * 1000;

  // Find matching evidence items
  const scored = evidenceItems
    .filter(ei => ei.is_cluster_rep)
    .map(ei => {
      let score = 0;

      // Category match
      if (categorySet.has(ei.category)) score += 30;

      // Entity match (in fact or entities list)
      const factLower = (ei.fact || "").toLowerCase();
      for (const entity of entitySet) {
        if (factLower.includes(entity) || (ei.entities || []).some(e => e.toLowerCase().includes(entity))) {
          score += 25;
        }
      }

      // Tag match
      for (const tag of tagSet) {
        if ((ei.technique_tags || []).includes(tag)) score += 20;
      }

      // Recency bonus
      const eiDate = ei.source_date ? new Date(ei.source_date).getTime() : 0;
      if (eiDate > cutoff) score += 15;

      // Quality bonus
      if (ei.quote_grounded)         score += 10;
      if (ei.specificity === "high") score += 10;
      if (ei.trust_tier === "primary" || ei.trust_tier === "high") score += 10;

      return { ...ei, _relevance_score: score };
    })
    .filter(ei => ei._relevance_score > 0)
    .sort((a, b) => b._relevance_score - a._relevance_score);

  return scored.slice(0, 25);
}

// ── 2c. Answer synthesis ──────────────────────────────────────────────────────

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer:      { type: "string" },
    key_points:  { type: "array", items: { type: "string" } },
    evidence_used: { type: "array", items: { type: "string" } },
    confidence:  { type: "string", enum: ["high", "medium", "low"] },
    caveats:     { type: "array", items: { type: "string" } },
    suggested_followups: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "key_points", "evidence_used", "confidence"],
};

async function synthesiseAnswer(question, retrievedItems, queryParams) {
  if (retrievedItems.length === 0) {
    return {
      answer: "No evidence found in the corpus matching your query. Try broadening the time range or using different terms.",
      key_points: [],
      evidence_used: [],
      confidence: "low",
      caveats: ["No matching evidence in the current corpus"],
      suggested_followups: [],
    };
  }

  const evidenceBlock = retrievedItems.map((ei, i) =>
    `[${ei.evidence_id}] (score: ${ei._relevance_score}, ${ei.specificity}, ${ei.trust_tier})\n` +
    `  FACT: ${ei.fact}\n` +
    `  QUOTE: "${ei.quote || ""}"\n` +
    `  SOURCE: ${ei.source_title || ei.source_url} [${ei.trust_tier}]`
  ).join("\n\n");

  const sys = `You are a senior AI threat intelligence analyst answering a specific intelligence question.

Rules:
- Answer only from the evidence provided below. Do not add general knowledge.
- Be specific: name techniques, tools, threat actors, CVEs where they appear in evidence
- Cite evidence IDs inline using [ev-xxx] notation
- Acknowledge if evidence is limited or one-sided
- key_points: 3-5 specific actionable findings (not general observations)
- suggested_followups: 2-3 specific questions this answer raises

Return ONLY valid JSON.`;

  const usr = `Question: "${question}"

Intent: ${queryParams.intent}
Time range: last ${queryParams.time_range_days || 90} days

RETRIEVED EVIDENCE (${retrievedItems.length} items):
${evidenceBlock}

Answer the question from this evidence only.`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "category_synthesis",
        requires_json: true,
        schema: ANSWER_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: ANSWER_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return raw;
  } catch (err) {
    return {
      answer: `Answer synthesis failed: ${err.message}`,
      key_points: [],
      evidence_used: [],
      confidence: "low",
      caveats: [err.message],
      suggested_followups: [],
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Answer a natural language question about the threat landscape.
 *
 * @param {string}   question       - e.g. "What changed in coding agents this quarter?"
 * @param {object[]} evidenceItems  - All evidence items from the latest pipeline run
 * @param {object}   [graph]        - Optional pre-built evidence graph
 * @returns {Promise<object>}        { answer, key_points, evidence_used, citations, confidence }
 */
export async function queryDashboard(question, evidenceItems, graph = null) {
  // Step 1: Parse the query
  const queryParams = await parseQuery(question);

  // Step 2: Retrieve relevant evidence via graph traversal
  const retrieved = traverseGraph(
    graph || { nodes: [], edges: [] },
    queryParams,
    evidenceItems,
  );

  // Step 3: Synthesise answer
  const answer = await synthesiseAnswer(question, retrieved, queryParams);

  // Resolve evidence IDs to source citations
  const evIndex = Object.fromEntries(evidenceItems.map(ei => [ei.evidence_id, ei]));
  const citations = (answer.evidence_used || [])
    .map(id => evIndex[id])
    .filter(Boolean)
    .map(ei => ({
      evidence_id:  ei.evidence_id,
      fact:         ei.fact?.slice(0, 150),
      source_title: ei.source_title,
      source_url:   ei.source_url,
      trust_tier:   ei.trust_tier,
    }));

  return {
    question,
    ...answer,
    citations,
    query_params: queryParams,
    items_retrieved: retrieved.length,
    _query_version: "query-v2.0",
  };
}

// ── Dashboard widget data helpers ──────────────────────────────────────────────
// Used by the React dashboard to build specific panel data.

/**
 * Returns evidence filtered to a single category with full detail.
 * Used by the category drilldown panel.
 */
export function getCategoryEvidence(category, evidenceItems, limit = 20) {
  return evidenceItems
    .filter(ei => ei.category === category && ei.is_cluster_rep)
    .sort((a, b) => {
      const scoreA = (a.quote_grounded ? 2 : 0) + (a.specificity === "high" ? 1 : 0);
      const scoreB = (b.quote_grounded ? 2 : 0) + (b.specificity === "high" ? 1 : 0);
      return scoreB - scoreA;
    })
    .slice(0, limit)
    .map(ei => ({
      evidence_id:   ei.evidence_id,
      fact:          ei.fact,
      quote:         ei.quote,
      quote_grounded: ei.quote_grounded,
      evidence_type: ei.evidence_type,
      specificity:   ei.specificity,
      source_title:  ei.source_title,
      source_url:    ei.source_url,
      trust_tier:    ei.trust_tier,
      technique_tags:ei.technique_tags,
      entities:      ei.entities,
    }));
}

/**
 * Returns tag heatmap data for a given category.
 * Used by the taxonomy heatmap widget.
 */
export function getTagHeatmap(category, evidenceItems) {
  const tagCounts = {};
  for (const ei of evidenceItems) {
    if (ei.category !== category) continue;
    for (const tag of ei.technique_tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

/**
 * Returns entity co-occurrence matrix for a given category.
 * Used by the entity network widget.
 */
export function getEntityNetwork(category, evidenceItems, topN = 15) {
  const entityItems = {};
  for (const ei of evidenceItems) {
    if (ei.category !== category || !ei.is_cluster_rep) continue;
    for (const entity of ei.entities || []) {
      if (!entityItems[entity]) entityItems[entity] = [];
      entityItems[entity].push(ei.evidence_id);
    }
  }

  const topEntities = Object.entries(entityItems)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, topN)
    .map(([entity]) => entity);

  const links = [];
  for (let i = 0; i < topEntities.length; i++) {
    for (let j = i + 1; j < topEntities.length; j++) {
      const a = topEntities[i], b = topEntities[j];
      const sharedEvidence = (entityItems[a] || []).filter(id => (entityItems[b] || []).includes(id));
      if (sharedEvidence.length > 0) {
        links.push({ source: a, target: b, weight: sharedEvidence.length });
      }
    }
  }

  return {
    nodes: topEntities.map(entity => ({
      id: entity,
      count: entityItems[entity]?.length || 0,
    })),
    links,
  };
}
