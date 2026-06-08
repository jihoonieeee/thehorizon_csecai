/**
 * Web Discovery — Deterministic Anti-Hallucination Gates (Layer 1C)
 *
 * Everything here is deterministic. No LLM, no network. These gates run BEFORE
 * any cheap-LLM semantic judgement and produce categorical states that the
 * triage/routing logic consumes.
 *
 * Gates implemented:
 *   1. Opened-URL gate      — the candidate's URL must appear in the set of URLs
 *                             the search tool actually opened (grounding).
 *   2. Quote gate           — classifies quote availability (present /
 *                             missing_preclean / missing). missing_preclean is
 *                             NOT a rejection (PDFs, repos need cleaning first).
 *   3. Quote–claim match    — deterministic token-overlap between claim and quote.
 *   4. AI-threat anchor gate — detects concrete AI-threat anchors; the count of
 *                             distinct anchors gives a mechanical specificity
 *                             FLOOR (explained, not a hidden weight). The LLM may
 *                             raise it in triage; it can never be invented from nothing.
 *   5. Freshness            — published_date / event_date / last_updated →
 *                             freshness_status + freshness_interpretation.
 *   6. Statistic validation — a statistic claim must carry metric + number +
 *                             timeframe + (denominator|methodology) to be usable.
 *   7. Entity extraction    — CVEs, model/tool/actor names for dedup + seeding.
 */

import {
  VALID_AI_THREAT_ANCHORS,
} from "../../config/webDiscoveryVocab.js";

// ── Day-count thresholds (purely mechanical, documented) ─────────────────────
const DAY = 24 * 60 * 60 * 1000;
const FRESH_DAYS      = 30;   // ≤ 30d  → fresh
const CURRENT_DAYS    = 120;  // ≤ 120d → current
const STALE_DAYS      = 365;  // ≤ 365d → stale; older → historical
const OLD_EVENT_DAYS  = 180;  // event older than this vs publication → divergence

// ── 1. Opened-URL gate ───────────────────────────────────────────────────────

/**
 * Normalise a URL for grounding comparison (strip scheme, trailing slash, www).
 */
export function normalizeUrlForGrounding(url = "") {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().replace(/\/$/, "");
  }
}

/**
 * Confirm the candidate URL was actually opened by the search tool.
 * @param {string} url
 * @param {Set<string>} groundedUrlSet  normalised URLs from search_results+citations
 * @returns {boolean}
 */
export function openedUrlConfirmed(url, groundedUrlSet) {
  if (!url) return false;
  if (!(groundedUrlSet instanceof Set) || groundedUrlSet.size === 0) return false;
  return groundedUrlSet.has(normalizeUrlForGrounding(url));
}

/** Build the grounded-URL set from a web-search result. */
export function buildGroundedUrlSet({ citations = [], search_results = [] } = {}) {
  const set = new Set();
  for (const c of citations) if (c?.url) set.add(normalizeUrlForGrounding(c.url));
  for (const r of search_results) if (r?.url) set.add(normalizeUrlForGrounding(r.url));
  return set;
}

// ── 2. Quote gate ─────────────────────────────────────────────────────────────

// Source classes / URL shapes whose text typically needs cleaning before a quote
// can be extracted — a missing quote here is "missing_preclean", not a failure.
const PRECLEAN_SOURCE_CLASSES = new Set([
  "research_paper", "conference_paper", "github_poc",
  "benchmark_dataset", "vulnerability_database", "standards_or_framework",
]);

export function classifyQuoteStatus(candidate) {
  const quote = (candidate.verbatim_quote || "").trim();
  if (quote.length >= 20) return "present";
  // fetch_pending: the search provider returned a real URL but did not read the
  // page (e.g. a SERP snippet). The page is fetched + cleaned in Layer 2, so this
  // is "pending", not a failure.
  if (candidate.fetch_pending === true) return "missing_preclean";
  const url = candidate.opened_url || candidate.url || "";
  const isPdf = /\.pdf($|\?)/i.test(url);
  const isRepo = /github\.com|gitlab\.com/i.test(url);
  if (isPdf || isRepo || PRECLEAN_SOURCE_CLASSES.has(candidate.source_class)) {
    return "missing_preclean";
  }
  return "missing";
}

// ── 3. Quote–claim match (deterministic overlap) ─────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","is","are","was",
  "were","be","been","by","that","this","it","as","at","from","has","have","had",
  "can","could","may","might","will","would","new","using","used","via",
]);

function contentTokens(text = "") {
  return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) || [])
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Deterministic claim/quote agreement. Returns a categorical status; the caller
 * may escalate "unverified"/"partial" to a cheap LLM fairness check.
 *
 * - match     : quote shares a strong majority of the claim's content tokens
 * - partial   : meaningful overlap but not strong
 * - mismatch  : claim asserts content the quote does not support at all
 * - unverified: no quote to compare against
 */
export function quoteClaimMatch(claim = "", quote = "") {
  const c = contentTokens(claim);
  const q = new Set(contentTokens(quote));
  if (!quote || q.size === 0) return "unverified";
  if (c.length === 0) return "unverified";
  let hit = 0;
  for (const t of c) if (q.has(t)) hit++;
  const ratio = hit / c.length;
  if (ratio >= 0.6) return "match";
  if (ratio >= 0.3) return "partial";
  return "mismatch";
}

// ── 4. AI-threat anchor gate ─────────────────────────────────────────────────

// Each anchor is detected by concrete signals. The presence of an anchor means
// the source talks about a SPECIFIC AI threat artefact, not a buzzword.
const ANCHOR_PATTERNS = [
  ["specific_exploit_or_vulnerability", /\bCVE-\d{4}-\d{3,7}\b|zero[\s-]?day|\bRCE\b|sandbox escape|privilege escalation/i],
  ["specific_attack_method", /prompt injection|jailbreak|data poisoning|model extraction|model inversion|membership inference|adversarial example|adversarial perturbation|guardrail bypass|tool poisoning|memory poisoning|rag poisoning|indirect injection|goal hijack/i],
  ["specific_model_or_system", /\bGPT-?[45]\b|\bGPT-4o\b|\bo[13]\b|Claude|Gemini|Llama|Mistral|DeepSeek|Qwen|Copilot|Cursor|Windsurf/i],
  ["specific_tool_affected", /\bMCP\b|Model Context Protocol|LangChain|LangGraph|AutoGPT|AutoGen|CrewAI|OpenAI Swarm|vector database|Pinecone|Weaviate|Chroma/i],
  ["specific_actor_or_campaign", /\bAPT[\s-]?\d+\b|Lazarus|Cozy Bear|Fancy Bear|Sandworm|Charcoal Typhoon|Salmon Typhoon|threat actor|nation[\s-]?state/i],
  ["specific_benchmark_or_result", /benchmark|attack success rate|\bASR\b|HarmBench|AdvBench|RobustBench|\b\d{1,3}(?:\.\d+)?%\s*(?:success|accuracy|bypass|detection|evasion)/i],
  ["specific_incident", /\bincident\b|data breach|was compromised|confirmed attack|in the wild|exploited in the wild/i],
  ["specific_defensive_bypass", /bypass(?:ed|ing)?\b|evad(?:e|ed|ing)\b.*(?:filter|guardrail|detection|defense)/i],
  ["specific_ai_enabled_role", /deepfake|voice clon|synthetic media|AI[\s-]?generated (?:malware|phishing|email)|AI[\s-]?powered (?:attack|phishing)|LLM[\s-]?(?:written|generated) malware/i],
];

/**
 * Detect concrete AI-threat anchors in text.
 * @returns {{ anchors: string[], specificity_floor: "none"|"weak"|"moderate"|"strong" }}
 *
 * Floor is a MECHANICAL function of the number of distinct anchors:
 *   0 anchors → none, 1 → weak, 2 → moderate, 3+ → strong.
 * It is a floor only: the cheap LLM may RAISE specificity in triage, never lower
 * it below a hard-evidenced anchor count. This keeps buzzword-only material
 * (0 anchors) out without inventing a confidence number.
 */
export function detectAiThreatAnchors(text = "") {
  const found = new Set();
  for (const [anchor, pattern] of ANCHOR_PATTERNS) {
    if (pattern.test(text)) found.add(anchor);
  }
  const anchors = [...found].filter((a) => VALID_AI_THREAT_ANCHORS.has(a));
  const n = anchors.length;
  const specificity_floor = n === 0 ? "none" : n === 1 ? "weak" : n === 2 ? "moderate" : "strong";
  return { anchors, specificity_floor };
}

// ── 5. Freshness ──────────────────────────────────────────────────────────────

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Assess freshness from publication, event, and last-updated dates.
 * @returns {{ freshness_status, freshness_interpretation, age_days }}
 */
export function assessFreshness({ published_date, event_date, last_updated, now = new Date() } = {}) {
  const pub  = parseDate(published_date);
  const evt  = parseDate(event_date);
  const upd  = parseDate(last_updated);
  const ref  = now instanceof Date ? now : new Date(now);

  if (!pub && !evt && !upd) {
    return { freshness_status: "unknown", freshness_interpretation: "unknown", age_days: null };
  }

  // Use the most recent of publication / last_updated for "how fresh is the page".
  const pageDate = [pub, upd].filter(Boolean).sort((a, b) => b - a)[0] || pub || upd;
  const ageDays = Math.floor((ref - pageDate) / DAY);

  let freshness_status;
  if (ageDays < 0)              freshness_status = "fresh";        // future-dated → treat as fresh
  else if (ageDays <= FRESH_DAYS)   freshness_status = "fresh";
  else if (ageDays <= CURRENT_DAYS) freshness_status = "current";
  else if (ageDays <= STALE_DAYS)   freshness_status = "stale";
  else                              freshness_status = "historical";

  // Interpretation: does the page date reflect the event date?
  let freshness_interpretation = "unknown";
  const pageIsRecent = ageDays <= CURRENT_DAYS;
  if (evt && pub) {
    const eventOld = (pub - evt) / DAY > OLD_EVENT_DAYS;
    if (eventOld && pageIsRecent)      freshness_interpretation = "fresh_publication_old_event";
    else if (!eventOld && pageIsRecent) freshness_interpretation = "fresh_event";
    else                                freshness_interpretation = "historical_context";
  } else if (upd && pub && (upd - pub) / DAY > OLD_EVENT_DAYS && pageIsRecent) {
    freshness_interpretation = "updated_old_report";
  } else if (pageIsRecent) {
    freshness_interpretation = "fresh_event";
  } else {
    freshness_interpretation = "historical_context";
  }

  return { freshness_status, freshness_interpretation, age_days: ageDays };
}

// ── 6. Statistic validation gate ──────────────────────────────────────────────

/**
 * Validate a statistic-bearing candidate. A usable statistic needs a metric, a
 * number, a timeframe, and either a denominator/sample or a stated methodology.
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateStatistic(stat = {}) {
  const missing = [];
  if (!stat.metric)        missing.push("metric");
  if (stat.number == null || stat.number === "") missing.push("number");
  if (!stat.timeframe && !stat.date) missing.push("timeframe");
  if (!stat.denominator && !stat.sample_size && !stat.methodology) {
    missing.push("denominator_or_methodology");
  }
  if (!stat.quote) missing.push("quote_grounding");
  return { valid: missing.length === 0, missing };
}

// ── 7. Entity extraction (for dedup + entity-seeded discovery) ───────────────

const ENTITY_PATTERNS = [
  ["cve",        /\bCVE-\d{4}-\d{3,7}\b/gi],
  ["model",      /\b(?:GPT-?4o|GPT-?4|GPT-?3\.5|o[13]|Claude(?:\s\d(?:\.\d)?)?|Gemini(?:\s\d(?:\.\d)?)?|Llama\s?\d|Mistral|DeepSeek|Qwen)\b/gi],
  ["tool",       /\b(?:MCP|LangChain|LangGraph|AutoGPT|AutoGen|CrewAI|Copilot|Cursor|Windsurf|Codeium|Amazon Q)\b/gi],
  ["actor",      /\bAPT[\s-]?\d+\b/gi],
  ["attack_name",/\b(?:EchoLeak|Morris II|Skeleton Key|Crescendo|DAN)\b/gi],
];

/**
 * Extract named entities for dedup keys and entity-seeded follow-up searches.
 * @returns {{ cve: string[], model: string[], tool: string[], actor: string[], attack_name: string[], all: string[] }}
 */
export function extractEntities(text = "") {
  const out = { cve: [], model: [], tool: [], actor: [], attack_name: [] };
  for (const [type, pattern] of ENTITY_PATTERNS) {
    const matches = String(text).match(pattern) || [];
    out[type] = [...new Set(matches.map((m) => m.trim()))];
  }
  out.all = [...new Set([...out.cve, ...out.model, ...out.tool, ...out.actor, ...out.attack_name])];
  return out;
}

export const FRESHNESS_THRESHOLDS = { FRESH_DAYS, CURRENT_DAYS, STALE_DAYS, OLD_EVENT_DAYS };
