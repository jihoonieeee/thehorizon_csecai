/**
 * L5.5 — Pattern Extraction
 *
 * Clusters evidence items into named attack patterns per category.
 * Patterns are recurring technical threads spanning ≥2 evidence items —
 * NOT category labels restated, NOT single-incident descriptions.
 *
 * These patterns feed L6.1 development generation so developments have a
 * pre-organized view of what the evidence clusters around.
 *
 * QA: deterministic only (evidence_ids ≥2, enum validation, description length,
 * Jaccard dedup). No second-model needed — gates are sufficient for clustering.
 */

import { randomUUID }         from "crypto";
import { routedLLM }          from "../../llm/llmRouter.js";
import { callLLM }            from "../../llm/callLLM.js";
import { selectDiverseEvidence, CHUNK_STRONG, CHUNK_USABLE } from "./synthesizeCategory.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

const PATTERN_TYPES = new Set([
  "technique_cluster",       // multiple items use the same attack technique
  "actor_convergence",       // multiple named actors independently adopt a technique
  "capability_acceleration", // evidence shows a capability maturing/scaling
  "target_broadening",       // technique spreading to new target classes
  "tooling_commoditisation", // expensive attack becoming cheap/accessible
]);

const RECENCY_VALUES = new Set(["new_this_period", "accelerating", "sustained", "declining"]);
const STRENGTH_VALUES = new Set(["strong", "moderate", "weak"]);

// ── Prompt ────────────────────────────────────────────────────────────────────

const _patternPrompts = loadPrompt("analysis/extract-patterns");
const PATTERN_SYSTEM  = _patternPrompts.system;
const PATTERN_USER    = _patternPrompts.user;

const PATTERN_SCHEMA = {
  type: "object",
  required: ["patterns"],
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        required: ["pattern_label", "pattern_type", "description", "evidence_ids", "recency_signal", "strength"],
        properties: {
          pattern_label:   { type: "string" },
          pattern_type:    { type: "string" },
          description:     { type: "string" },
          technique_tags:  { type: "array", items: { type: "string" } },
          evidence_ids:    { type: "array", items: { type: "string" } },
          recency_signal:  { type: "string" },
          strength:        { type: "string" },
        },
      },
    },
  },
};

// ── Build evidence block for the prompt ───────────────────────────────────────

function buildEvidenceBlock(items) {
  return items.map(ei => {
    const tags = (ei.technique_tags || []).join(", ") || "none";
    return `[${ei.evidence_id}] [${ei.evidence_type || "?"}] [${ei.specificity || "?"}] ${ei.fact || ""}${ei.quote && ei.quote_grounded ? `\n  Quote: "${ei.quote}"` : ""}\n  Tags: ${tags}`;
  }).join("\n\n");
}

// ── Deterministic QA ──────────────────────────────────────────────────────────

function jaccard(tagsA, tagsB) {
  const a = new Set(tagsA), b = new Set(tagsB);
  const inter = [...a].filter(t => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function validateAndDedup(rawPatterns, evidenceIndex) {
  const valid = [];
  for (const p of rawPatterns) {
    // Resolve evidence IDs against index
    const resolved = (p.evidence_ids || []).filter(id => id in evidenceIndex);
    if (resolved.length < 2) continue;                         // minimum cluster size
    if (!PATTERN_TYPES.has(p.pattern_type))     continue;     // enum
    if ((p.description || "").length < 30)       continue;     // substance
    if (!RECENCY_VALUES.has(p.recency_signal))   continue;
    if (!STRENGTH_VALUES.has(p.strength))        continue;

    const tags = (p.technique_tags || []).filter(Boolean);

    // Jaccard dedup against already-valid patterns
    const duplicate = valid.some(v => jaccard(v.technique_tags, tags) > 0.3);
    if (duplicate) continue;

    valid.push({
      pattern_id:    randomUUID(),
      pattern_label: (p.pattern_label || "").trim(),
      pattern_type:  p.pattern_type,
      description:   (p.description || "").trim(),
      technique_tags: tags,
      evidence_ids:  resolved,
      cluster_size:  resolved.length,
      recency_signal: p.recency_signal,
      strength:      p.strength,
    });
  }
  return valid.slice(0, 5);
}

// ── Per-category extraction ───────────────────────────────────────────────────

export async function extractPatterns(category, pack, evidenceIndex, opts = {}) {
  const { skipLlm = false } = opts;
  if (skipLlm) return [];

  const strong  = selectDiverseEvidence(pack.strong  || [], CHUNK_STRONG);
  const usable  = selectDiverseEvidence(pack.usable  || [], CHUNK_USABLE);
  const items   = [...strong, ...usable];

  if (items.length < 2) return [];

  const evidenceBlock = buildEvidenceBlock(items);
  const userPrompt = interpolate(PATTERN_USER, {
    category:     category.replace(/_/g, " ").toUpperCase(),
    total_items:  items.length,
    strong_count: strong.length,
    usable_count: usable.length,
    evidence_block: evidenceBlock,
  });

  try {
    let raw;
    try {
      const { result } = await routedLLM(PATTERN_SYSTEM, userPrompt, {
        task: "pattern_extraction", requires_json: true, schema: PATTERN_SCHEMA,
        logLabel: `patterns-${category}`,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(PATTERN_SYSTEM, userPrompt, { schema: PATTERN_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    const patterns = validateAndDedup(raw?.patterns || [], evidenceIndex);
    process.stdout.write(`  [L5.5] ${category}: ${patterns.length} patterns extracted\n`);
    return patterns;
  } catch (err) {
    process.stdout.write(`  [L5.5] ${category}: pattern extraction failed (${err.message.slice(0, 60)}) — continuing without patterns\n`);
    return [];
  }
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function extractAllPatterns(packs, evidenceIndex, opts = {}) {
  const results = {};
  for (const [category, pack] of Object.entries(packs)) {
    results[category] = await extractPatterns(category, pack, evidenceIndex, opts);
  }
  const total = Object.values(results).flat().length;
  process.stdout.write(`  [L5.5] ${total} total patterns across ${Object.keys(results).length} categories\n`);
  return results;
}
