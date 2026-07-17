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

import { createHash } from "crypto";
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
 * Legacy output (match/partial/mismatch/unverified) — kept for backward compatibility.
 * Use quoteSupport() for the new enum.
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

/**
 * Canonical quote support assessment.
 *
 * Design principle: deterministic token overlap cannot judge whether a quote
 * SEMANTICALLY supports a claim. It can only check lexical co-occurrence.
 * Semantic entailment is the responsibility of the LLM in triageCandidates.js.
 *
 * quote_support values:
 *   unverified       — no quote present to check against
 *   unsupported      — token overlap < 0.3 (fast mechanical rejection — insufficient
 *                      shared vocabulary for any LLM to confirm support either)
 *   requires_entailment_qa — quote is present but overlap is inconclusive (0.3–0.85);
 *                            LLM entailment check must determine final verdict
 *   lexically_matched — overlap ≥ 0.85 (fast-path: quote and claim share most content
 *                       tokens; LLM check still recommended for precise claims)
 *
 * requires_entailment_qa is true whenever a quote is present and the result is not
 * "unsupported" — signals the triage LLM must assess semantic support.
 *
 * @returns {{ quote_support: string, requires_entailment_qa: boolean, co_occurrence_ratio: number }}
 */
export function quoteSupport(claim = "", quote = "") {
  const c = contentTokens(claim);
  const q = new Set(contentTokens(quote));

  if (!quote || (quote || "").trim().length < 20) {
    return { quote_support: "unverified", requires_entailment_qa: false, co_occurrence_ratio: 0 };
  }
  if (c.length === 0) {
    return { quote_support: "unverified", requires_entailment_qa: false, co_occurrence_ratio: 0 };
  }

  let hit = 0;
  for (const t of c) if (q.has(t)) hit++;
  const ratio = hit / c.length;

  if (ratio < 0.3) {
    // Very low overlap: quote and claim share almost no vocabulary. Even an LLM
    // would struggle to find support. Reject fast.
    return { quote_support: "unsupported", requires_entailment_qa: false, co_occurrence_ratio: ratio };
  }

  if (ratio >= 0.85) {
    // Very high overlap: fast-path match. Still flag for entailment QA because
    // high lexical overlap does not guarantee semantic entailment (e.g. quotes
    // can negate what a claim asserts).
    return { quote_support: "lexically_matched", requires_entailment_qa: true, co_occurrence_ratio: ratio };
  }

  // Intermediate overlap: result is inconclusive — LLM must judge entailment.
  return { quote_support: "requires_entailment_qa", requires_entailment_qa: true, co_occurrence_ratio: ratio };
}

/**
 * Legacy token-overlap match (still exported for backward-compat callers).
 * Returns the pre-refactor categorical string.
 * @deprecated Prefer quoteSupport() + LLM entailment.
 */
export function quoteClaimMatchLegacy(claim = "", quote = "") {
  return quoteClaimMatch(claim, quote);
}

// ── 4. AI-threat anchor gate ─────────────────────────────────────────────────

// Each anchor is detected by concrete signals. The presence of an anchor means
// the source talks about a SPECIFIC AI threat artefact, not a buzzword.
const ANCHOR_PATTERNS = [
  ["specific_exploit_or_vulnerability", /\bCVE-\d{4}-\d{3,7}\b|zero[\s-]?day|\bRCE\b|sandbox escape|privilege escalation/i],
  ["specific_attack_method", /prompt injection|jailbreak|data poisoning|model extraction|model inversion|membership inference|adversarial example|adversarial perturbation|guardrail bypass|tool poisoning|memory poisoning|rag poisoning|indirect injection|goal hijack|backdoor(?:ed|ing)? (?:ml|model|training)|training data (?:poisoning|manipulation|attack)|model backdoor/i],
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

// Source classes that are "foundational" even when old — standards/frameworks
// that remain authoritative references (NIST, MITRE, OWASP).
const FOUNDATIONAL_SOURCE_CLASSES = new Set([
  "standards_or_framework", "government_advisory", "vulnerability_database",
]);

/**
 * Assess freshness from publication, event, and last-updated dates.
 * Returns both freshness_status (simple age bucket) and freshness_class (semantic).
 *
 * freshness_class adds nuance over freshness_status:
 *   historical_foundational — authoritative standards/frameworks remain useful despite age
 *   stale_but_relevant      — stale but adds new evidence (e.g. follow-up paper on old attack)
 *   historical_stale        — old and adds no new evidence
 *   unknown_date            — no date available
 *
 * @param {{ published_date, event_date, last_updated, now, source_class, adds_new_evidence }} input
 * @returns {{ freshness_status, freshness_class, freshness_interpretation, age_days }}
 */
export function assessFreshness({ published_date, event_date, last_updated, now = new Date(), source_class, adds_new_evidence } = {}) {
  const pub  = parseDate(published_date);
  const evt  = parseDate(event_date);
  const upd  = parseDate(last_updated);
  const ref  = now instanceof Date ? now : new Date(now);

  if (!pub && !evt && !upd) {
    return {
      freshness_status:      "unknown",
      freshness_class:       "unknown_date",
      freshness_interpretation: "unknown",
      age_days: null,
    };
  }

  const pageDate = [pub, upd].filter(Boolean).sort((a, b) => b - a)[0] || pub || upd;
  const ageDays = Math.floor((ref - pageDate) / DAY);

  let freshness_status;
  if (ageDays < 0)              freshness_status = "fresh";
  else if (ageDays <= FRESH_DAYS)   freshness_status = "fresh";
  else if (ageDays <= CURRENT_DAYS) freshness_status = "current";
  else if (ageDays <= STALE_DAYS)   freshness_status = "stale";
  else                              freshness_status = "historical";

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

  // freshness_class: semantic enrichment of freshness_status
  let freshness_class;
  if (ageDays === null) {
    freshness_class = "unknown_date";
  } else if (ageDays <= CURRENT_DAYS) {
    freshness_class = ageDays <= FRESH_DAYS ? "fresh" : "current";
  } else if (ageDays <= STALE_DAYS) {
    // LLM may later route to reject if _llm_adds_new_evidence=false.
    // Class is set optimistically at normalization time; routing handles downgrade.
    freshness_class = "stale_but_relevant";
  } else {
    // Historical (> 365 days)
    if (FOUNDATIONAL_SOURCE_CLASSES.has(source_class)) {
      freshness_class = "historical_foundational";
    } else if (adds_new_evidence !== false && freshness_interpretation !== "historical_context") {
      freshness_class = "historical_context";
    } else {
      freshness_class = "historical_stale";
    }
  }

  return { freshness_status, freshness_class, freshness_interpretation, age_days: ageDays };
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

// ── 8. Origin citation extraction ─────────────────────────────────────────────
// Deterministic extraction of secondary-reporting signals. These phrases indicate
// the article is REPORTING ON another source, not originating the finding.
// Extracted primary_origin_url feeds dedup clustering and independence scoring.

const SECONDARY_REPORTING_PATTERNS = [
  // "according to [entity/URL]"
  /according to\s+([A-Z][^,.\n]{3,60}|https?:\/\/[^\s,)]+)/gi,
  // "citing a report by / from [entity]"
  /citing (?:a report (?:by|from)|research (?:by|from))\s+([A-Z][^,.\n]{3,60})/gi,
  // "based on [a report/research/findings] by/from [entity]"
  /based on (?:a (?:report|paper|study|advisory|analysis) (?:by|from)|research (?:by|from)|findings (?:by|from))\s+([A-Z][^,.\n]{3,60})/gi,
  // "reported by [entity]" / "disclosed by [entity]"
  /(?:reported|disclosed|revealed|confirmed) by\s+([A-Z][^,.\n]{3,60})/gi,
  // "from a report by [entity]"
  /from a (?:report|study|paper|advisory) (?:by|from)\s+([A-Z][^,.\n]{3,60})/gi,
  // "researchers at [entity]"
  /researchers (?:at|from)\s+([A-Z][^,.\n]{3,50})/gi,
  // NVD / CVE record
  /(CVE-\d{4}-\d{3,7})/gi,
  // "advisory from [entity]" / "NVD entry"
  /advisory (?:from|by)\s+([A-Z][^,.\n]{3,50})/gi,
];

/**
 * Extract origin-citation signals from candidate text.
 * Determines whether this article is PRIMARY (first disclosure) or SECONDARY (reporting on another source).
 *
 * @param {object} candidate — must have: title, candidate_claim, verbatim_quote, summary, publisher
 * @returns {{
 *   origin_role: "primary_origin"|"secondary_reporting"|"tertiary_commentary"|"unknown_origin",
 *   primary_origin_url: string|null,
 *   cited_sources: string[],
 *   independence_level: "independent"|"vendor_interested"|"self_reported"|"circular_reporting_risk"|"unknown",
 * }}
 */
export function extractOriginCitations(candidate) {
  const text = [
    candidate.title || "",
    candidate.candidate_claim || "",
    candidate.verbatim_quote || "",
    candidate.summary || "",
  ].join(" ");

  const cited = new Set();
  let primary_origin_url = null;

  for (const pattern of SECONDARY_REPORTING_PATTERNS) {
    const resetPattern = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(resetPattern)) {
      const captured = (match[1] || "").trim();
      if (captured.length >= 3) cited.add(captured);
      if (/^https?:\/\//i.test(captured) && !primary_origin_url) {
        primary_origin_url = captured;
      }
    }
  }

  const cited_sources = [...cited].slice(0, 8);
  const hasSecondaryCue = cited_sources.length > 0 ||
    /\baccording to\b|\bciting\b|\bbased on\b|\breported by\b|\bdisclosed by\b/i.test(text);

  // Source class signals for primary vs secondary
  const sourceClass = candidate.source_class || "";
  const isPrimaryClass = ["research_paper", "conference_paper", "vulnerability_database",
    "government_advisory", "github_poc", "standards_or_framework"].includes(sourceClass);
  const isNewsClass = ["news_report", "technical_blog"].includes(sourceClass);

  let origin_role;
  if (!hasSecondaryCue && isPrimaryClass) {
    origin_role = "primary_origin";
  } else if (hasSecondaryCue && isNewsClass && cited_sources.length >= 1) {
    origin_role = "secondary_reporting";
  } else if (hasSecondaryCue && cited_sources.length >= 2) {
    origin_role = "tertiary_commentary";
  } else if (hasSecondaryCue && cited_sources.length >= 1) {
    origin_role = "secondary_reporting";
  } else if (isPrimaryClass) {
    origin_role = "primary_origin";
  } else {
    origin_role = "unknown_origin";
  }

  // independence_level: derived from origin_role + publisher class
  const publisher = (candidate.publisher || "").toLowerCase();
  let independence_level = "unknown";
  if (origin_role === "primary_origin" && !hasSecondaryCue) {
    independence_level = "independent";
  } else if (origin_role === "secondary_reporting") {
    independence_level = "independent"; // secondary can still be independent (different publisher)
  } else if (origin_role === "tertiary_commentary") {
    independence_level = "circular_reporting_risk";
  }
  // Vendor self-reporting detection
  const VENDOR_PUBLISHERS = ["crowdstrike", "palo alto", "microsoft", "google", "sentinelone",
    "wiz", "hiddenlayer", "checkpoint", "mandiant", "cisco", "fortinet"];
  if (VENDOR_PUBLISHERS.some((v) => publisher.includes(v))) {
    independence_level = "vendor_interested";
  }

  return { origin_role, primary_origin_url, cited_sources, independence_level };
}

// ── 9. Candidate hash computation ─────────────────────────────────────────────

function sha256short(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

/**
 * Compute stable hash keys for redundant-work prevention.
 * These hashes enable skip-reprocess logic and origin clustering.
 */
export function computeCandidateHashes(candidate) {
  // Canonical URL: strip tracking params
  let canonical_url = candidate.opened_url || candidate.url || "";
  try {
    const u = new URL(canonical_url);
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","ref","source","fbclid","gclid"].forEach((p) => u.searchParams.delete(p));
    canonical_url = u.toString();
  } catch { /* use as-is */ }

  const canonical_url_hash = sha256short(canonical_url.toLowerCase());
  const quote_hash  = sha256short((candidate.verbatim_quote || "").slice(0, 200).toLowerCase());
  const claim_hash  = sha256short((candidate.candidate_claim || "").slice(0, 200).toLowerCase());
  const content_hash = sha256short(
    `${(candidate.title||"").toLowerCase()}|${(candidate.verbatim_quote||"").slice(0,200).toLowerCase()}`
  );
  // primary_origin_hash: hash of the primary source URL, enabling origin clustering
  const raw_origin  = candidate.primary_origin_url || candidate.original_source_url || canonical_url;
  const primary_origin_hash = sha256short(raw_origin.toLowerCase().split("?")[0]);

  return { canonical_url_hash, quote_hash, claim_hash, content_hash, primary_origin_hash };
}
