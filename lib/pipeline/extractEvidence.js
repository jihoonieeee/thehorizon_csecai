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

import { routedLLM }  from "../llm/llmRouter.js";
import { callLLM }    from "../llm/callLLM.js";
import { isValidTag, isValidSubTech } from "./taxonomy.js";
import { randomUUID } from "crypto";

export const EVIDENCE_VERSION = "evidence-v2.0";

// ── Evidence types ────────────────────────────────────────────────────────────

export const EVIDENCE_TYPES = [
  "incident",                 // documented real-world attack or exploitation
  "capability_demonstration", // proof-of-concept, research demo, benchmark
  "research_finding",         // peer-reviewed or credible empirical result
  "vulnerability",            // specific CVE, weakness, or flaw identified
  "threat_actor_activity",    // attributed adversary behaviour
  "statistical_measurement",  // quantitative claim with source
  "expert_assessment",        // analyst or expert judgment (weaker)
  "policy_or_standard",       // regulatory, standard, or governance item
];

// ── Eligibility gate (deterministic — no LLM) ────────────────────────────────
// Only attempt extraction from sources with sufficient text.

function isEligible(source) {
  const text = source.full_text || source.clean_text || "";
  if (text.length < 150) return false;                     // too short
  if (source.category === "unclear_or_adjacent") return false;
  if (source.trust_tier === "low") return false;           // not worth extracting
  return true;
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
        },
        required: ["fact", "quote", "quote_grounded", "evidence_type", "specificity"],
      },
    },
  },
  required: ["evidence_items"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI threat intelligence analyst extracting discrete evidence items from security sources.

An evidence item is a specific, verifiable, concrete fact. It must be:
- SPECIFIC: named entities, CVE IDs, percentages, techniques, products, dates
- GROUNDED: directly supported by a verbatim quote from the text
- USEFUL: would inform a threat assessment, not general background

DO NOT extract:
- Generic statements ("AI can be misused")
- Pure opinion without supporting data
- Duplicate points

EVIDENCE TYPE — pick using this decision tree (stop at the first match):
1. incident             — something that actually happened: a real attack, breach, seizure, or exploitation in the wild against real targets. Signal: past-tense event, named victim/target, "was seized", "was exploited", "breached X".
2. vulnerability        — a specific flaw or CVE. Signal: CVE-YYYY-NNNNN, "vulnerability in X allows Y", "patch released for".
3. threat_actor_activity — documented behavior attributed to a named actor. Signal: APT group name, campaign name, nation-state attribution ("UNC6508", "Contagious Interview", "APT29").
4. capability_demonstration — shown to work in a lab, test, or controlled setting (PoC, benchmark, red team). Signal: "we demonstrated", "in our experiments", "achieved X% in tests", "proof-of-concept".
5. research_finding     — empirical result from a study/paper not already covered above. Signal: "our paper shows", "study found", "we measured".
6. statistical_measurement — a quantitative claim: percentage, dollar amount, count. Signal: the primary content is a number with a reference.
7. policy_or_standard   — regulatory text, NIST/OWASP/legal requirement.
8. expert_assessment    — ONLY if none of the above fit: analyst prediction, general observation, contextual judgment without a documented event or measurement.

For each item:
- "fact": concise statement of what was demonstrated or observed (1-2 sentences)
- "quote": verbatim excerpt from the source that supports the fact (≤200 chars)
- "quote_grounded": true if the quote directly supports the fact; false if inferred
- "evidence_type": pick using the decision tree above
- "specificity": high (named entity + measurable detail), medium (named entity or technique only), low (generic)
- "numbers": extract every quantitative value in this item — percentage, count, dollar amount, ratio, timeframe. Each entry: {"value": "88%", "context": "attack success rate on GPT-4 in jailbreak experiments"}. Empty array if no numbers.
- "technique_tags": relevant taxonomy tag IDs (e.g., "LLM01_prompt_injection")
- "entities": specific names (CVE IDs, tools, threat actors, products, authors)

Return ONLY valid JSON. No markdown.`;

// ── Per-source prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const text = (source.full_text || source.clean_text || "").slice(0, 8000);
  return `Extract evidence items from this source:

TITLE: ${source.title}
SOURCE_TYPE: ${source.source_type}
CATEGORY: ${source.category}
TAGS: ${(source.primary_tags || []).join(", ")}

TEXT:
${text}

Extract 2-8 discrete evidence items. Prefer fewer high-quality items over many low-quality ones.
Each item must have a real quote from the text above.`;
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

function normaliseItems(raw, source) {
  // Handle both {evidence_items: [...]} and a bare array [...] (Anthropic Haiku returns either)
  const items = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.evidence_items) ? raw.evidence_items : []);
  const sourceText = source.full_text || source.clean_text || "";
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
        source_title:   source.title,
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
        // Ground every number against the source text — the extraction model can
        // attach a figure that isn't actually in the source. Mark grounded=false
        // when the digits don't appear verbatim (downstream Key Figures use only
        // grounded numbers, so a hallucinated figure never reaches a slide).
        numbers:        (ei.numbers || []).filter(n => n?.value && n?.context).slice(0, 6)
                          .map(n => ({ ...n, grounded: verifyNumberInSource(n.value, sourceText) })),
        technique_tags: (ei.technique_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
        entities:       (ei.entities || []).slice(0, 10),
        _evidence_version: EVIDENCE_VERSION,
      };
    });
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

const TIER_RANK = { primary: 4, high: 3, medium: 2, low: 1, unknown: 0 };
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

  if (opts.skipLlm) {
    // Deterministic stub: one item per main claim
    return (source.main_claims || []).slice(0, 3).map((claim, i) => ({
      evidence_id:   `ev-${source.id.slice(0,8)}-${i+1}`,
      source_id:     source.id,
      source_title:  source.title,
      source_url:    source.url,
      source_type:   source.source_type,
      trust_tier:    source.trust_tier,
      category:      source.category,
      fact:          String(claim).slice(0, 300),
      quote:         String(claim).slice(0, 150),
      quote_grounded: false,
      evidence_type: "expert_assessment",
      specificity:   "low",
      numbers:       [],
      technique_tags:[],
      entities:      source.key_entities?.slice(0, 3) || [],
      _evidence_version: EVIDENCE_VERSION,
      _stub: true,
    }));
  }

  const sys = SYSTEM_PROMPT;
  const usr = buildUserPrompt(source);

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
      await import("../storage/evidenceStore.js");
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
