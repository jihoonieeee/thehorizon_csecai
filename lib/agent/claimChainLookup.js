/**
 * L6 claim-chain lookup for the agent chatbot.
 *
 * Loads the latest deck blob, extracts validated category_analyses and
 * evidence dossiers, and selects the most critical finding for a query.
 *
 * Pass opts.loadDeckFn to inject a mock in tests.
 */

import { loadLatestDeck } from "../storage/deckStore.js";

// In-process cache for the current invocation (avoids duplicate blob fetches).
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

const PRIORITY_RANK   = { critical: 3, high: 2, medium: 1 };
const STRENGTH_RANK   = { strong: 3, usable: 2, context: 1, archive: 0 };
const CLASS_RANK      = { operational: 4, external: 3, analytics: 2, research: 1, governance: 1, contextual: 0 };

// ── Blob fetch ────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status} ${url}`);
  return res.json();
}

/**
 * Load synthesis data from the latest deck blob.
 * Returns null if the deck table is empty or the blob is unreachable.
 */
export async function loadSynthesisData(opts = {}) {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;

  const loadFn = opts.loadDeckFn || loadLatestDeck;
  const deck   = await loadFn();
  if (!deck?.blob_path) return null;

  const fetchFn  = opts.fetchFn || fetchJson;
  const payload  = await fetchFn(deck.blob_path);
  const synth    = payload?.synthesis || null;
  if (!synth) return null;

  _cache   = synth;
  _cacheAt = now;
  return synth;
}

// ── Evidence index ────────────────────────────────────────────────────────────

/**
 * Build a flat id→evidence map from synthesis data.
 * Covers L5A dossier items, L5C external evidence, and evidence_inventory.
 */
export function buildEvidenceIndex(synthesisData) {
  const index = {};

  const add = (item, layer, defaultClass) => {
    if (!item?.evidence_id) return;
    if (index[item.evidence_id]) return;
    index[item.evidence_id] = {
      evidence_id:      item.evidence_id,
      source_id:        item.source_id || null,
      source_title:     item.source_title || item.title || "",
      publisher:        item.publisher || "",
      url:              item.url || null,
      evidence_type:    item.evidence_type || "",
      evidence_class:   item.evidence_class || defaultClass || "research",
      evidence_strength:item.evidence_strength || item.evidence_confidence || "context",
      fact:             item.fact || item.display_label || item.summary || item.claim || "",
      numbers:          item.numbers || [],
      extraction_layer: item.extraction_layer || layer,
    };
  };

  for (const dossier of (synthesisData?.fused_dossiers || [])) {
    const rf = dossier.rawfact || {};
    for (const item of [...(rf.strong_evidence || []), ...(rf.usable_evidence || []), ...(rf.case_study_candidates || []), ...(rf.statistics || [])]) {
      add(item, "L5A", "research");
    }
    for (const item of (dossier.rawfact_evidence || [])) {
      add(item, "L5A", "research");
    }
    for (const item of (dossier.external_evidence || [])) {
      add(item, "L5C", "external");
    }
  }

  for (const item of (synthesisData?.evidence_inventory || [])) {
    add(item, item.extraction_layer || "L5A", "research");
  }

  return index;
}

// ── Research-only detection ────────────────────────────────────────────────────

function isResearchOnly(evidenceIds, evidenceIndex) {
  if (!evidenceIds?.length) return true;
  return evidenceIds.every((id) => {
    const ev = evidenceIndex[id];
    if (!ev) return true;
    return ev.evidence_class === "research" || ev.evidence_class === "contextual";
  });
}

// ── Claim scoring ─────────────────────────────────────────────────────────────

function scoreClaim(claim, evidenceIndex) {
  let score = (PRIORITY_RANK[claim.claim_priority] || 0) * 100;

  const ids = claim.supporting_evidence_ids || [];
  score += Math.min(ids.length, 5) * 10;

  let maxStrength = 0;
  let maxClass    = 0;
  for (const id of ids) {
    const ev = evidenceIndex[id];
    if (!ev) continue;
    maxStrength = Math.max(maxStrength, STRENGTH_RANK[ev.evidence_strength] || 0);
    maxClass    = Math.max(maxClass, CLASS_RANK[ev.evidence_class] || 0);
  }
  score += maxStrength * 5;
  score += maxClass * 3;

  return score;
}

// ── Claim extraction from a category analysis ─────────────────────────────────

function extractClaims(analysis) {
  const claims = [];

  for (const ins of (analysis.top_insights || [])) {
    const text = ins.insight || ins.text || "";
    if (!text) continue;
    const conf = ins.confidence || "medium";
    const slide = ins.slide_usefulness || conf;
    let priority = ins.claim_priority;
    if (!priority) {
      if (conf === "high" && slide === "high") priority = "critical";
      else if (conf === "high" || slide === "high") priority = "high";
      else priority = "medium";
    }
    claims.push({
      claim_type:              "category_insight",
      claim_priority:          priority,
      claim_text:              text,
      why_it_matters:          ins.explanation || ins.why_this_matters || "",
      supporting_evidence_ids: ins.supporting_evidence_ids || [],
      caveat_if_any:           ins.caveat_if_any || null,
    });
  }

  for (const h of (analysis.biggest_happenings || [])) {
    const text = h.happening || h.text || "";
    if (!text) continue;
    const conf = h.confidence || "medium";
    let priority = h.claim_priority;
    if (!priority) priority = conf === "high" ? "high" : "medium";
    claims.push({
      claim_type:              "happening",
      claim_priority:          priority,
      claim_text:              text,
      why_it_matters:          h.why_it_matters || h.why_this_matters || "",
      supporting_evidence_ids: h.supporting_evidence_ids || [],
      caveat_if_any:           h.caveat_if_any || null,
    });
  }

  return claims;
}

// ── Public: find the most critical claim ──────────────────────────────────────

/**
 * Select the best claim from validated category analyses.
 *
 * @param {object} opts
 * @param {object[]} opts.categoryAnalyses  - from synthesis.category_analyses
 * @param {object}   opts.evidenceIndex     - from buildEvidenceIndex()
 * @param {string}   [opts.category]        - filter to one category if specified
 * @returns {{
 *   claim: object,
 *   evidencePackets: object[],
 *   researchOnly: boolean,
 *   alternatives: object[],
 *   category: string,
 * } | null}
 */
export function findCriticalClaim({ categoryAnalyses, evidenceIndex, category }) {
  if (!categoryAnalyses?.length) return null;

  const targets = category
    ? categoryAnalyses.filter((a) => a.category === category)
    : categoryAnalyses;

  if (!targets.length) return null;

  // Gather all claims across target categories, scored
  const scored = [];
  for (const analysis of targets) {
    for (const claim of extractClaims(analysis)) {
      scored.push({ claim, score: scoreClaim(claim, evidenceIndex), category: analysis.category });
    }
  }

  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const alternatives = scored.slice(1, 4).map((s) => s.claim);

  const evPackets = (best.claim.supporting_evidence_ids || [])
    .map((id) => evidenceIndex[id])
    .filter(Boolean)
    .slice(0, 3);

  return {
    claim:          best.claim,
    evidencePackets: evPackets,
    researchOnly:   isResearchOnly(best.claim.supporting_evidence_ids, evidenceIndex),
    alternatives,
    category:       best.category,
  };
}

// ── Dashboard intel lookup ────────────────────────────────────────────────────
//
// Chatbot analytical route should prefer dashboard_intel approved objects over
// raw claim-chain extraction from top_insights. This provides traceable,
// QA-vetted intelligence with short_takeaway and trend_status.

/**
 * Find the most relevant approved dashboard intel object for a query.
 *
 * Prefers objects approved_for_chatbot=true. Ranks by confidence + judgment_type.
 * Falls back to claim-chain extraction if no dashboard intel is available.
 *
 * @param {object}   opts
 * @param {object}   opts.synthesisData    - Full synthesis payload (deck blob)
 * @param {string}   [opts.category]       - Filter to one category
 * @param {string}   [opts.relevanceHint]  - dashboard_relevance_hint filter
 * @returns {{ intel: object | null, alternatives: object[], source: "dashboard_intel" | "claim_chain" }}
 */
export function findDashboardIntel({ synthesisData, category, relevanceHint }) {
  // Prefer dashboard_intel from analysis_package (new path)
  const dashPkg = synthesisData?.analysis_package?.dashboard_intel
    || synthesisData?.dashboard_intel
    || null;

  if (dashPkg) {
    let candidates = [...(dashPkg.approved_for_main_panels || [])];
    if (category) candidates = candidates.filter((o) => o.category === category || o.category === "cross_category");
    if (relevanceHint) candidates = candidates.filter((o) => o.dashboard_relevance_hint === relevanceHint);
    candidates = candidates.filter((o) => o.approved_for_chatbot);

    // Sort: strategic > analytical, then high > medium > low confidence
    const CONF_RANK  = { high: 3, medium: 2, low: 1 };
    const QUAL_RANK  = { strategic: 3, analytical: 2, descriptive: 1 };
    candidates.sort((a, b) =>
      (QUAL_RANK[b.analytical_quality] || 0) - (QUAL_RANK[a.analytical_quality] || 0) ||
      (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0)
    );

    if (candidates.length > 0) {
      return {
        intel:        candidates[0],
        alternatives: candidates.slice(1, 4),
        source:       "dashboard_intel",
      };
    }
  }

  return { intel: null, alternatives: [], source: "claim_chain" };
}

/**
 * Build evidence points from a dashboard intel object for chatbot response composition.
 *
 * @param {object} intelObj  Dashboard intelligence object
 * @returns {object[]} Evidence points for chatbot response
 */
export function intelToEvidencePoints(intelObj) {
  return (intelObj?.evidence_for || []).slice(0, 4).map((e) => ({
    fact:       e.fact || "",
    publisher:  e.publisher || "unknown",
    url:        e.url || null,
    evidence_id: e.evidence_id,
    trust_tier:  e.trust_tier || "unknown",
  }));
}

// ── Cache reset (for tests) ───────────────────────────────────────────────────

export function _resetCache() {
  _cache   = null;
  _cacheAt = 0;
}
