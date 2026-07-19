/**
 * extractEvidence()
 *
 * Replaces the 10-step rawfact branch (19 files, ~200K LOC) with:
 *   Step 1: One LLM call per eligible source → evidence_items[]
 *   Step 2: Jaccard dedup across all items → deduplicated_items[]
 *   Step 3: Assemble per-category packs (strong / usable / context)
 *
 * Each evidence item carries its own quality signals (quote_grounded,
 * specificity) so no separate scoring pass is needed.
 *
 * Model: cheap (Gemini Flash / GPT-4o-mini). One call per source ≈ 600-1500 tokens.
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { callLLM }    from "../../llm/callLLM.js";
import { isValidTag, isValidSubTech } from "../understand/taxonomy.js";
import { randomUUID } from "crypto";
import { loadPrompt } from "../../prompts/promptLoader.js";

export const EVIDENCE_VERSION = "evidence-v2.0";

// ── Evidence types ────────────────────────────────────────────────────────────

export const EVIDENCE_TYPES = [
  "incident",                 // documented real-world attack or exploitation
  "capability_demonstration", // proof-of-concept, research demo, benchmark
  "attack_surface_signal",    // new attack surface or capability that enables future attacks
  "research_finding",         // peer-reviewed or credible empirical result
  "vulnerability",            // specific CVE, weakness, or flaw identified
  "threat_actor_activity",    // attributed adversary behaviour
  "statistical_measurement",  // quantitative claim with source
  "expert_assessment",        // analyst or expert judgment (weaker)
  "policy_or_standard",       // regulatory, standard, or governance item
];

// Epistemic types shared across all specialist extractors.
export const VALID_EPISTEMIC_TYPES = [
  "observed_fact",    // documented event, confirmed observation
  "lab_measurement",  // measured under controlled lab conditions; may not generalise
  "author_analysis",  // analyst / researcher judgment or assessment
  "forecast",         // forward-looking prediction
  "marketing_claim",  // company's own unverified statement about their product
  "inference",        // analyst inference (e.g. plausible misuse pathway)
];

// Where in the source document a claim originates.
export const VALID_CLAIM_ORIGINS = [
  "primary_source",        // author's own firsthand observation, research, or disclosure
  "secondary_report",      // the source is reporting on / summarising another source
  "expert_comment",        // community discussion, forum comment, expert quote
  "analyst_interpretation",// implication drawn by the extractor; not explicitly stated
];

// ── Eligibility gate (deterministic — no LLM) ────────────────────────────────
// Only attempt extraction from sources with sufficient text.

function isEligible(source) {
  const text = source.full_text || source.clean_text || "";
  if (text.length < 600) return false;                     // too short — below this threshold the stored text is likely nav/headline only
  const cat = source.category || source.main_category;
  if (cat === "unclear_or_adjacent") return false;
  if (source.trust_tier === "low") return false;           // not worth extracting
  return true;
}

// ── Pre-built evidence from digest child findings ─────────────────────────────
// When a source is a digest child (intelligence.report_finding.parent_report_id is set),
// we already have a structured finding from the fanout LLM call:
//   - item_title / item_summary → the distilled claim (becomes the fact)
//   - supporting_quote          → verbatim span from the parent report
//   - actor, named_cves, timeframe etc. → structured entities
//
// Running extractThreatIntelEvidence on the child's thin full_text would produce one
// poor-quality item at best. Building it deterministically from the fanout data is
// cheaper, grounded, and cites back to the parent report correctly via citationTitle().

function reportFindingToEvidence(source) {
  const rf = source.intelligence?.report_finding;
  if (!rf?.parent_report_id) return null;

  const cat = source.category || source.main_category;
  if (!cat || cat === "unclear_or_adjacent") return null;

  const sourceText  = source.full_text || source.clean_text || "";
  const fact        = String(source.short_summary || source.summary || rf.finding_title || "").slice(0, 500);
  const quote       = String(rf.supporting_quote || "").slice(0, 300);
  const grounded    = quote.length >= 15 ? verifyQuoteInSource(quote, sourceText) : false;

  const entities = [
    rf.actor || null,
    ...(Array.isArray(rf.named_cves)      ? rf.named_cves.slice(0, 4)      : []),
    ...(Array.isArray(rf.named_incidents)  ? rf.named_incidents.slice(0, 3) : []),
    ...(Array.isArray(rf.named_products)   ? rf.named_products.slice(0, 3)  : []),
  ].filter(Boolean).slice(0, 10);

  return [{
    evidence_id:    `ev-${source.id.slice(0, 8)}-1`,
    source_id:      source.id,
    source_title:   citationTitle(source),   // reads parent_report_title — cites the real report
    source_url:     source.url,
    publisher:      source.publisher || "",
    source_type:    source.source_type,
    trust_tier:     source.trust_tier,
    category:       cat,
    source_family:  source.source_family || "threat_intel_report",
    fact:           fact || String(rf.finding_title || "").slice(0, 500),
    quote,
    quote_grounded: grounded,
    evidence_type:  source.source_type === "research_finding"    ? "research_finding"
                  : source.source_type === "vulnerability"       ? "vulnerability"
                  : source.source_type === "capability_demonstration" ? "capability_demonstration"
                  : "threat_actor_activity",
    specificity:    rf.actor ? "high" : "medium",
    numbers:        [],
    technique_tags: (source.primary_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
    entities,
    event_date:       rf.timeframe || null,
    publication_date: source.date_published || null,
    time_basis:       rf.timeframe ? "event_date" : "unknown",
    within_reporting_window: null,
    claim_epistemic_type: "observed_fact",
    campaign_metadata: {
      attribution_confidence: rf.actor ? "medium" : "unknown",
      campaign_name:          rf.actor || null,
      is_analytic_judgment:   false,
    },
    _evidence_version:   EVIDENCE_VERSION,
    _from_digest_finding: true,
  }];
}

// ── Pre-computed evidence from report_analysis ────────────────────────────────
// When a source has intelligence.report_analysis (set by extractReportInsights.js),
// convert the structured walkthroughs/insights/trends directly into evidence items
// rather than re-running the LLM. Free, deterministic, and higher fidelity than
// a generic evidence extraction call on the same text.

function reportAnalysisToEvidence(source) {
  const ra = source.intelligence?.report_analysis;
  if (!ra) return null;

  const { attack_walkthroughs = [], critical_insights = [], trends = [] } = ra;
  if (attack_walkthroughs.length + critical_insights.length + trends.length === 0) return null;

  const sourceText = source.full_text || source.clean_text || "";
  const cat  = source.category || source.main_category || "ai_enabled_threats";
  const items = [];
  let idx = 0;

  for (const w of attack_walkthroughs) {
    const quote = String(w.quote || "").slice(0, 300);
    // Preserve the full walkthrough structure on the item so buildDossier can
    // render it as a structured block and selectCaseStudies can use it directly.
    const fact  = [
      w.actor && w.actor !== "unattributed" ? `${w.actor}: ` : "",
      w.technique,
      w.impact ? ` — ${w.impact}` : "",
    ].join("").slice(0, 500);

    items.push({
      evidence_id:    `ev-${source.id.slice(0, 8)}-${++idx}`,
      source_id:      source.id,
      source_title:   citationTitle(source),
      source_url:     source.url,
      publisher:      source.publisher || "",
      source_type:    source.source_type,
      trust_tier:     source.trust_tier,
      category:       cat,
      source_family:  source.source_family || (source.is_digest ? "roundup_digest" : "threat_intel_report"),
      fact,
      quote,
      quote_grounded: verifyQuoteInSource(quote, sourceText),
      evidence_type:  "threat_actor_activity",
      specificity:    "high",
      numbers:        [],
      technique_tags: [],
      entities:       w.actor && w.actor !== "unattributed" ? [w.actor] : [],
      event_date:       null,  // walkthroughs don't carry a parsed event date
      publication_date: source.date_published || null,
      time_basis:       "unknown",
      within_reporting_window: null,
      // Walkthroughs are structured observations from the report — direct facts, not
      // analyst hedges. The report itself may attribute them to a threat actor.
      claim_epistemic_type: "observed_fact",
      campaign_metadata: {
        attribution_confidence: w.actor && w.actor !== "unattributed" ? "medium" : "unknown",
        campaign_name:          null,
        is_analytic_judgment:   false,
      },
      // Structured walkthrough fields — preserved for dossier rendering and
      // case study selection. Never collapsed back into strings downstream.
      walkthrough_actor:     w.actor || null,
      walkthrough_technique: w.technique || null,
      walkthrough_mechanism: w.mechanism || null,
      walkthrough_steps:     Array.isArray(w.steps) ? w.steps : [],
      walkthrough_impact:    w.impact || null,
      _evidence_version: EVIDENCE_VERSION,
      _from_report_analysis: true,
    });
  }

  for (const ins of critical_insights) {
    const fact  = String(ins.finding || "").slice(0, 500);
    const quote = String(ins.evidence || "").slice(0, 300);
    items.push({
      evidence_id:    `ev-${source.id.slice(0, 8)}-${++idx}`,
      source_id:      source.id,
      source_title:   citationTitle(source),
      source_url:     source.url,
      publisher:      source.publisher || "",
      source_type:    source.source_type,
      trust_tier:     source.trust_tier,
      category:       cat,
      source_family:  source.source_family || (source.is_digest ? "roundup_digest" : "threat_intel_report"),
      fact,
      quote,
      quote_grounded: verifyQuoteInSource(quote, sourceText),
      evidence_type:  "expert_assessment",
      specificity:    "high",
      numbers:        [],
      technique_tags: [],
      entities:       [],
      // Critical insights are analytical conclusions drawn from the report — they
      // represent the analyst's judgment, not a directly observed event.
      claim_epistemic_type: "author_analysis",
      publication_date:     source.date_published || null,
      // Preserve insight metadata for the dossier's REPORT INSIGHTS section.
      insight_finding:      ins.finding || null,
      insight_significance: ins.significance || null,
      insight_taxonomy:     ins.taxonomy_hint || null,
      _evidence_version: EVIDENCE_VERSION,
      _from_report_analysis: true,
      _report_insight: true,
    });
  }

  for (const t of trends) {
    const fact  = `[${t.direction?.toUpperCase() || "TREND"}] ${t.trend} (${t.timeframe || "recent"})`.slice(0, 500);
    const quote = String(t.evidence || "").slice(0, 300);
    items.push({
      evidence_id:    `ev-${source.id.slice(0, 8)}-${++idx}`,
      source_id:      source.id,
      source_title:   citationTitle(source),
      source_url:     source.url,
      publisher:      source.publisher || "",
      source_type:    source.source_type,
      trust_tier:     source.trust_tier,
      category:       cat,
      fact,
      quote,
      quote_grounded: verifyQuoteInSource(quote, sourceText),
      evidence_type:  "expert_assessment",
      specificity:    "medium",
      numbers:        [],
      technique_tags: [],
      entities:       [],
      // Trends are the report's forward-looking or pattern observations.
      claim_epistemic_type: "author_analysis",
      publication_date:     source.date_published || null,
      source_family:  source.source_family || (source.is_digest ? "roundup_digest" : "threat_intel_report"),
      _evidence_version: EVIDENCE_VERSION,
      _from_report_analysis: true,
    });
  }

  return items;
}

// ── JSON schema for structured output ─────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    evidence_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact:            { type: "string" },
          quote:           { type: "string" },
          quote_grounded:  { type: "boolean" },
          evidence_type:   { type: "string", enum: EVIDENCE_TYPES },
          specificity:     { type: "string", enum: ["high", "medium", "low"] },
          numbers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                value:   { type: "string" },
                context: { type: "string" },
              },
              required: ["value", "context"],
            },
          },
          technique_tags:  { type: "array", items: { type: "string" } },
          entities:        { type: "array", items: { type: "string" } },
          // Event date fields — separate incident date from source publication date.
          // Use event_date (the date of the attack/experiment/disclosure) for
          // reporting-window decisions; fall back to publication_date only when the
          // event date is genuinely unavailable.
          event_date:              { type: ["string", "null"] },
          // "incident_date" is ATLAS-specific (when an attack occurred per MITRE records);
          // included here so ATLAS items survive any future normaliser pass.
          time_basis:              { type: "string", enum: ["event_date", "incident_date", "publication_date", "unknown"] },
          within_reporting_window: { type: ["boolean", "null"] },
        },
        required: ["fact", "quote", "quote_grounded", "evidence_type", "specificity"],
      },
    },
  },
  required: ["evidence_items"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = loadPrompt("extraction/extract-evidence-news").system;

// ── Per-source prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(source, opts = {}) {
  const text = (source.full_text || source.clean_text || "").slice(0, 8000);
  const windowHint = opts.windowStart && opts.windowEnd
    ? `\nREPORTING WINDOW: ${opts.windowStart} to ${opts.windowEnd}`
    : "";
  return `Extract evidence items from this source:

TITLE: ${source.title}
PUBLISHER: ${source.publisher || ""}
SOURCE_TYPE: ${source.source_type}
CATEGORY: ${source.category}
TAGS: ${(source.primary_tags || []).join(", ")}
PUBLICATION_DATE: ${source.date_published || "unknown"} [reference only — do not copy into event_date]${windowHint}

TEXT:
${text}

Extract 2-8 discrete evidence items. Prefer fewer high-quality items over many low-quality ones.
Each item must have a real quote from the text above.

For each item extract:
- event_date: ISO date (YYYY-MM-DD or YYYY-MM) when the event ACTUALLY OCCURRED — NOT the article publication date above. For incidents use the compromise/attack date; for vulnerabilities use the disclosure/discovery date; for research use the study period; for measurements use the measurement period; for policy use the effective date. Set null only if the event date is genuinely absent from the text.
- time_basis: "event_date" if you found an occurrence date in the text distinct from the publication date; "publication_date" only as a last resort fallback; "unknown" if timing is genuinely unclear.
- within_reporting_window: true/false/null based on the REPORTING WINDOW above (null if no window given).`;
}

// ── Normalise extracted items ─────────────────────────────────────────────────

// Deterministic quote grounding check.
// Verifies that a quote actually appears in the source text — the extraction
// model sometimes sets quote_grounded=true on paraphrased or invented quotes.
// Uses the first 80 chars of the quote as a fingerprint (tolerates minor truncation).
function verifyQuoteInSource(quote, sourceText) {
  if (!quote || quote.length < 15) return false;
  const needle = quote.slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
  const haystack = sourceText.toLowerCase();
  if (haystack.includes(needle)) return true;
  // Fuzzy: try shorter 60-char window to tolerate minor whitespace/encoding differences.
  // 40 chars was too short — generic phrases can produce false positives.
  const short = quote.slice(0, 60).toLowerCase().replace(/\s+/g, " ").trim();
  return short.length >= 20 && haystack.includes(short);
}

// Deterministic number grounding check. Confirms the figure's digits actually
// appear in the source text — the extraction model occasionally attaches a number
// that isn't in the source (a hallucinated statistic). Tolerates thousands
// separators ("26,000" ↔ "26000") and unit suffixes ("88%" → "88", "$2M" → "2").
// Conservative: returns true when we cannot extract a clean digit string (so we
// never drop a legitimately word-form number), false only on a real digit mismatch.
function verifyNumberInSource(value, sourceText) {
  const raw = String(value || "");
  const digits = (raw.match(/\d[\d,.]*/) || [])[0];
  if (!digits) return true;                       // word-form ("three") — don't penalise
  const core = digits.replace(/[.,]+$/, "");      // trim trailing separators
  if (core.replace(/[^\d]/g, "").length < 1) return true;
  const hay = String(sourceText || "");
  const noSep = core.replace(/,/g, "");
  return hay.includes(core) || hay.includes(noSep) ||
         // also match the comma-grouped form of a bare integer (26000 → 26,000)
         hay.includes(Number(noSep).toLocaleString("en-US"));
}

// For child sources (digest fanout), cite the parent report title rather than the
// compound "Parent [Sub-title]" string. Falls back to source.title for standalone sources.
function citationTitle(source) {
  return source.intelligence?.report_finding?.parent_report_title || source.title;
}

function normaliseItems(raw, source) {
  // Handle both {evidence_items: [...]} and a bare array [...] (Anthropic Haiku returns either)
  const items = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.evidence_items) ? raw.evidence_items : []);
  const sourceText = source.full_text || source.clean_text || "";
  const enforceAiRelevance = AI_THREAT_CATEGORIES.has(source.category || source.main_category);
  return items
    .filter(ei => ei.fact && ei.fact.length > 10)
    .map((ei, idx) => {
      const quote        = String(ei.quote || "").slice(0, 300);
      const modelClaimed = Boolean(ei.quote_grounded);
      // If model said grounded, verify it; if model said not grounded, trust that.
      const actuallyGrounded = modelClaimed
        ? verifyQuoteInSource(quote, sourceText)
        : false;
      const groundingDowngraded = modelClaimed && !actuallyGrounded;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-${idx + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.category,
        fact:           String(ei.fact || "").slice(0, 500),
        quote,
        quote_grounded:        actuallyGrounded,
        _quote_grounding_note: groundingDowngraded
          ? "quote_grounded downgraded: quote not found verbatim in source text"
          : undefined,
        evidence_type:  EVIDENCE_TYPES.includes(ei.evidence_type) ? ei.evidence_type : "expert_assessment",
        specificity:    ["high","medium","low"].includes(ei.specificity) ? ei.specificity : "low",
        // Temporal provenance: event_date from LLM extraction; publication_date
        // from source metadata (not LLM-generated — the model only outputs event_date).
        event_date:       ei.event_date || null,
        publication_date: source.date_published || null,
        time_basis:       ["event_date","incident_date","publication_date","unknown"].includes(ei.time_basis)
                            ? ei.time_basis : "unknown",
        within_reporting_window: ei.within_reporting_window ?? null,
        // Ground every number against the source text — the extraction model can
        // attach a figure that isn't actually in the source. Mark grounded=false
        // when the digits don't appear verbatim (downstream Key Figures use only
        // grounded numbers, so a hallucinated figure never reaches a slide).
        numbers:        (ei.numbers || []).filter(n => n?.value && n?.context).slice(0, 6)
                          .map(n => ({ ...n, grounded: verifyNumberInSource(n.value, sourceText) })),
        technique_tags: (ei.technique_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
        entities:       (ei.entities || []).slice(0, 10),
        // Epistemic type: how the claim was established. Defaults to observed_fact
        // for backward-compat; specialist extractors set this explicitly.
        claim_epistemic_type: VALID_EPISTEMIC_TYPES.includes(ei.claim_epistemic_type)
          ? ei.claim_epistemic_type : "observed_fact",
        // Where in the source document the claim originates.
        claim_origin: VALID_CLAIM_ORIGINS.includes(ei.claim_origin)
          ? ei.claim_origin : "secondary_report",
        // Source family propagated so downstream consumers know which extraction
        // path was used without re-deriving it.
        source_family:  source.source_family || "news_blog",
        _evidence_version: EVIDENCE_VERSION,
      };
    })
    .filter(item => !enforceAiRelevance || isAiRelevant(item));
}

// ── AI-relevance gate ─────────────────────────────────────────────────────────
// Sources categorised as AI threat categories sometimes contain off-topic general
// security content (e.g. a weekly roundup that mentions AI once but contains 20
// unrelated breach reports). This gate drops extracted items that have no
// AI/ML/agent signal in their fact or quote AND no taxonomy tag — they are
// almost certainly general security facts that leaked into an AI-threat category.
//
// Items with technique_tags set are always kept: the tag itself is the relevance
// signal, even if the fact text uses generic language (e.g. "baseline accuracy 87%"
// from an adversarial-ML paper — tagged TAI03 but no "AI" in the sentence).

const AI_RELEVANCE_KEYWORDS = [
  "ai ", " ai,", " ai.", "a.i.", "artificial intelligence",
  "machine learning", " ml ", "neural", "model", "llm", "language model",
  "gpt", "claude", "gemini", "openai", "anthropic", "mistral",
  "agent", "mcp", "copilot", "agentic", "autonomous", "tool call",
  "chatbot", "generative", "rag ", "embedding", "fine-tun",
  "prompt", "jailbreak", "deepfake", "adversarial", "hallucin",
  "inference", "training", "diffusion", "transformer", "tokens",
  "vector database", "hugging face", "langchain", "ollama",
  // ai_enabled_threats keywords: AI doesn't always appear in the fact text
  "synthetic", "voice clon", "voice synthesis", "disinformation",
  "bot network", "influence operation", "fake media", "generated image",
  "generated video", "generated audio", "fabricated", "manipulated media",
  "automated phishing", "automated malware", "automated attack",
];
const AI_THREAT_CATEGORIES = new Set([
  "traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats",
]);

function isAiRelevant(item) {
  // If taxonomy tags are set, the item is on-topic by definition.
  if (item.technique_tags?.length) return true;
  const text = `${item.fact || ""} ${item.quote || ""}`.toLowerCase();
  return AI_RELEVANCE_KEYWORDS.some(kw => text.includes(kw));
}

// ── Jaccard deduplication ─────────────────────────────────────────────────────
// Deduplicates at the item level. Items with Jaccard similarity > threshold
// are clustered; the representative (highest trust_tier + specificity) is marked.

const JACCARD_THRESHOLD = 0.4;

function tokenise(text) {
  return new Set(String(text || "").toLowerCase().match(/\b[a-z0-9]{3,}\b/g) || []);
}

function jaccard(a, b) {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

const TIER_RANK = { primary: 4, curated: 3, high: 3, medium: 2, low: 1, unknown: 0 };
const SPEC_RANK = { high: 3, medium: 2, low: 1 };

function selectRepresentative(cluster) {
  return cluster.slice().sort((a, b) => {
    const tierDiff = (TIER_RANK[b.trust_tier] || 0) - (TIER_RANK[a.trust_tier] || 0);
    if (tierDiff !== 0) return tierDiff;
    return (SPEC_RANK[b.specificity] || 0) - (SPEC_RANK[a.specificity] || 0);
  })[0];
}

export function deduplicateEvidence(items) {
  const tokens = items.map(ei => tokenise(ei.fact + " " + ei.quote));
  const clusterOf = new Array(items.length).fill(-1);
  const clusters = [];

  for (let i = 0; i < items.length; i++) {
    if (clusterOf[i] >= 0) continue;
    const cluster = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (clusterOf[j] >= 0) continue;
      if (jaccard(tokens[i], tokens[j]) >= JACCARD_THRESHOLD) {
        cluster.push(j);
        clusterOf[j] = clusters.length;
      }
    }
    clusterOf[i] = clusters.length;
    clusters.push(cluster);
  }

  const cluster_id_by_idx = clusterOf.map(ci => `cluster-${ci}`);
  // For each cluster, find the index of its representative item.
  const repByCluster = clusters.map(cluster => {
    const rep = selectRepresentative(cluster.map(i => items[i]));
    return items.findIndex(ei => ei === rep);
  });

  return items.map((ei, i) => {
    const repIdx = repByCluster[clusterOf[i]];
    const isRep  = repIdx === i;
    return {
      ...ei,
      cluster_id:     cluster_id_by_idx[i],
      is_cluster_rep: isRep,
      duplicate_of:   isRep ? null : items[repIdx]?.evidence_id ?? null,
    };
  });
}

// ── Pack assembly ─────────────────────────────────────────────────────────────

function strength(ei) {
  const hasNumbers = Array.isArray(ei.numbers) && ei.numbers.length > 0;
  if (ei.quote_grounded && ei.specificity === "high") return "strong";
  // medium specificity with numeric measurement is as load-bearing as high specificity
  if (ei.quote_grounded && ei.specificity === "medium" && hasNumbers) return "strong";
  if (ei.quote_grounded && ei.specificity === "medium") return "usable";
  if (ei.quote_grounded) return "usable";
  return "context";
}

export function assembleEvidencePacks(deduped, categories) {
  const packs = {};
  for (const cat of categories) {
    packs[cat] = { category: cat, strong: [], usable: [], context: [] };
  }

  for (const ei of deduped) {
    if (!ei.is_cluster_rep) continue;             // only one per cluster
    const cat = ei.category;
    if (!packs[cat]) continue;
    const s = strength(ei);
    packs[cat][s].push(ei);
  }

  return Object.values(packs);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract evidence from a single understood source.
 *
 * @param {object} source   - Output of understandSource()
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm]
 * @returns {Promise<object[]>}  Array of evidence items
 */
export async function extractEvidence(source, opts = {}) {
  if (!isEligible(source)) return [];

  // Digest child fast path: build evidence from the fanout finding structure.
  // Runs before source-family routing because children have thin full_text (just the
  // item_summary + supporting_quote) — a full LLM extraction call on that thin text
  // would produce one poor-quality item. The fanout data is already structured and
  // grounded; we build directly from it. Citation cites the parent report correctly.
  const digestFinding = reportFindingToEvidence(source);
  if (digestFinding) return digestFinding;

  // Pre-computed report_analysis fast path — for single-topic threat intel reports
  // that went through extractLongReportInsights (Sonnet deep extraction).
  // These sources have structured walkthroughs/insights/trends; no second LLM needed.
  // ORDERING NOTE: this runs before the source-family router, meaning academic_paper
  // sources with a precomputed report_analysis bypass academicRelevanceGate. In practice
  // report_analysis is only set by extractLongReportInsights which targets threat_intel_report
  // sources, so the overlap with academic_paper is not possible under normal pipeline flow.
  const precomputed = reportAnalysisToEvidence(source);
  if (precomputed) return precomputed;

  // ── Source-family router ──────────────────────────────────────────────────────
  // Route to specialist extractor based on source.source_family (set by
  // classifySourceFamily in understandSource). Each specialist has its own
  // inclusion rules, prompt, and evidence schema extensions.
  const family = source.source_family || "news_blog";

  if (family === "atlas_case_study" || source.intelligence?.atlas_id) {
    const { extractAtlasEvidence } = await import("./extractAtlasEvidence.js");
    return extractAtlasEvidence(source, opts);
  }

  if (family === "academic_paper") {
    const { extractAcademicEvidence } = await import("./extractAcademicEvidence.js");
    return extractAcademicEvidence(source, opts);
  }

  if (family === "threat_intel_report") {
    const { extractThreatIntelEvidence } = await import("./extractThreatIntelEvidence.js");
    return extractThreatIntelEvidence(source, opts);
  }

  if (family === "major_capability_announcement") {
    const { extractCapabilityEvidence } = await import("./extractCapabilityEvidence.js");
    return extractCapabilityEvidence(source, opts);
  }

  if (family === "roundup_digest") {
    const { extractRoundupEvidence } = await import("./extractRoundupEvidence.js");
    return extractRoundupEvidence(source, opts);
  }

  if (family === "corporate_blog") {
    const { extractCorporateBlogEvidence } = await import("./extractCorporateBlogEvidence.js");
    return extractCorporateBlogEvidence(source, opts);
  }

  // ── Default path (news_blog / unknown) ───────────────────────────────────────

  if (opts.skipLlm) {
    // Deterministic stub: one item per main claim
    return (source.main_claims || []).slice(0, 3).map((claim, i) => ({
      evidence_id:   `ev-${source.id.slice(0,8)}-${i+1}`,
      source_id:     source.id,
      source_title:  citationTitle(source),
      source_url:    source.url,
      source_type:   source.source_type,
      trust_tier:    source.trust_tier,
      category:      source.category,
      fact:          String(claim).slice(0, 300),
      quote:         String(claim).slice(0, 150),
      quote_grounded: false,
      publisher:           source.publisher || "",
      source_family:       source.source_family || "news_blog",
      evidence_type:       "expert_assessment",
      specificity:         "low",
      numbers:             [],
      technique_tags:      [],
      entities:            source.key_entities?.slice(0, 3) || [],
      event_date:          null,
      publication_date:    source.date_published || null,
      time_basis:          "unknown",
      within_reporting_window: null,
      claim_epistemic_type: "author_analysis",
      claim_origin:        "secondary_report",
      _evidence_version:   EVIDENCE_VERSION,
      _stub: true,
    }));
  }

  const sys = SYSTEM_PROMPT;
  const usr = buildUserPrompt(source, opts);

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "evidence_extraction",
        requires_json: true,
        schema: OUTPUT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: OUTPUT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return normaliseItems(raw, source);
  } catch (err) {
    // Non-fatal — this source contributes no evidence
    return [];
  }
}

/**
 * Extract evidence from all relevant sources, then dedup and assemble packs.
 *
 * @param {object[]} sources     - Output of understandAllSources().relevant
 * @param {string[]} categories  - Active threat categories
 * @param {object}   [opts]
 * @returns {Promise<{ items: object[], packs: object[], counts: object }>}
 */
export async function extractAllEvidence(sources, categories, opts = {}) {
  const { concurrency = 5, onProgress, supabase = null } = opts;
  const allItems = [];

  if (supabase && !opts.skipLlm) {
    // ── Cached / incremental path ────────────────────────────────────────────
    // Only (re)extract sources whose evidence is missing or whose full_text hash
    // changed; reuse persisted evidence for the rest. Persist each extraction.
    const { contentHashOf, getEvidenceHashes, loadEvidence, saveSourceEvidence } =
      await import("../../storage/evidenceStore.js");
    const ids    = sources.map(s => s.id);
    const cached = await getEvidenceHashes(supabase, ids);
    const stale  = sources.filter(s =>
      cached.get(s.id) !== contentHashOf(s.full_text || s.clean_text || ""));

    let done = 0;
    for (let i = 0; i < stale.length; i += concurrency) {
      const batch = stale.slice(i, i + concurrency);
      await Promise.all(batch.map(async s => {
        const items = await extractEvidence(s, opts);
        await saveSourceEvidence(supabase, s.id, contentHashOf(s.full_text || s.clean_text || ""), items);
      }));
      done += batch.length;
      onProgress?.(done, stale.length);
    }
    // Load the full, current evidence set (freshly-persisted + previously-cached).
    allItems.push(...await loadEvidence(supabase, ids));
    console.log(`  [L5] cache: ${sources.length - stale.length} reused, ${stale.length} (re)extracted`);
  } else {
    for (let i = 0; i < sources.length; i += concurrency) {
      const batch = sources.slice(i, i + concurrency);
      const batchItems = await Promise.all(batch.map(s => extractEvidence(s, opts)));
      for (const items of batchItems) allItems.push(...items);
      onProgress?.(Math.min(i + concurrency, sources.length), sources.length);
    }
  }

  const deduped = deduplicateEvidence(allItems);
  const packs   = assembleEvidencePacks(deduped, categories);

  const reps     = deduped.filter(ei => ei.is_cluster_rep);
  const strong   = reps.filter(ei => strength(ei) === "strong").length;
  const usable   = reps.filter(ei => strength(ei) === "usable").length;
  const context  = reps.filter(ei => strength(ei) === "context").length;

  return {
    items: deduped,
    packs,
    counts: {
      total_extracted: allItems.length,
      after_dedup:     reps.length,
      clusters:        new Set(deduped.map(ei => ei.cluster_id)).size,
      strong,
      usable,
      context,
      by_category: Object.fromEntries(
        packs.map(p => [p.category, p.strong.length + p.usable.length + p.context.length])
      ),
    },
  };
}
