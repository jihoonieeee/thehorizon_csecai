/**
 * v2 — understandSource()
 *
 * Replaces the combined L3 (13-file validation) + L4 (49K understandSource)
 * with a single structured LLM call per source.
 *
 * One call does everything:
 *   - AI-threat relevance gate (replaces aiRelevance.js 22K)
 *   - Source typing (replaces sourceTyping.js 13K)
 *   - Trust tier (replaces trustAssessment.js 12K)
 *   - Taxonomy assignment — category + primary_tags + sub_techniques
 *   - Entity / claim / number extraction
 *   - Short summary
 *
 * Irrelevant sources are returned with { relevant: false } and discarded
 * by the caller. No further processing.
 *
 * Model: cheap (Gemini Flash / GPT-4o-mini). One call ≈ 500-1000 tokens.
 */

import { routedLLM }              from "../../llm/llmRouter.js";
import { callLLM }                from "../../llm/callLLM.js";
import {
  DOMAINS, SOURCE_TYPES, TRUST_TIERS,
  buildTaxonomyPromptBlock, isValidTag, isValidSubTech, domainOfTag,
} from "./taxonomy.js";

const UNDERSTAND_VERSION = "v2.0";

// ── JSON schema for structured output ─────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    rejection_reason: { type: "string" },
    category: { type: "string", enum: DOMAINS },
    primary_tags: { type: "array", items: { type: "string" } },
    sub_techniques: { type: "array", items: { type: "string" } },
    ai_enabled_overlay: { type: "boolean" },
    source_type: { type: "string", enum: SOURCE_TYPES },
    trust_tier: { type: "string", enum: TRUST_TIERS },
    key_entities: { type: "array", items: { type: "string" } },
    main_claims: { type: "array", items: { type: "string" } },
    key_numbers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          context: { type: "string" },
        },
        required: ["value", "context"],
      },
    },
    short_summary: { type: "string" },
  },
  required: ["relevant", "category", "source_type", "trust_tier", "short_summary"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are an AI threat intelligence analyst. Your job is to classify cybersecurity sources and extract structured intelligence.

${buildTaxonomyPromptBlock()}

TRUST TIER RULES:
  primary — Government agencies (CISA, NCSC, NSA, CSA, NIST), major AI labs (Anthropic, OpenAI, Google DeepMind)
  high    — Established security vendors, peer-reviewed academic papers, major research institutions
  medium  — Security blogs, news outlets, independent researchers with track record
  low     — Unknown authors, speculative content, obvious marketing
  unknown — Cannot determine

RELEVANCE RULE:
relevant=true if the source describes ANY of: a specific AI/ML attack technique, a vulnerability in AI systems, an incident involving AI-enabled attacks, a research paper demonstrating attacks on or using AI, a threat actor using AI offensively, or a jailbreak/adversarial exploit.
relevant=false ONLY if: purely defensive/governance content with zero offensive threat described, pure marketing, no AI or ML angle whatsoever, or completely off-topic (sports, finance, non-security news).

AI_ENABLED_THREATS RULE:
Only classify as ai_enabled_threats if the source EXPLICITLY AND DIRECTLY documents AI/ML being used as the attack tool — with first-hand evidence, not inference. Requirements:
  - The source must name a specific AI capability (deepfake, LLM-written content, AI-powered recon, etc.) as part of the documented attack.
  - Inferring or speculating that a threat actor "might use AI" is NOT sufficient.
  - A sophisticated attack by a known APT group does NOT qualify unless AI use is explicitly documented.
  - A news roundup mentioning AI tangentially does NOT qualify.
  - A conventional malware/phishing/C2 article with no AI content does NOT qualify, even if tagged by the reporter as "AI-era".
  - CVEs in AI-adjacent products (GitLab AI features, VS Code extensions) belong in llm_threats or agentic_ai_threats, NOT ai_enabled_threats.
Assign at least one AE01–AE10 primary_tag. If in doubt, prefer unclear_or_adjacent over ai_enabled_threats.

ASI02_TOOL_MISUSE_EXPLOITATION RULE:
ASI02 applies when an agent's tool-calling mechanism is specifically exploited — e.g. injecting malicious tool responses, exploiting MCP server vulnerabilities, abusing function-calling APIs. Do NOT assign ASI02 to general agentic AI papers just because they involve tool use. Use ASI01 (goal hijack), ASI06 (memory poisoning), or ASI05 (code execution) when those are the primary risks.

SOURCE TYPE — pick the best fit (use these exact values):
  research_paper           — peer-reviewed paper or preprint
  vulnerability_advisory   — CVE advisory, NVD entry, flaw-specific advisory
  threat_intelligence_report — threat actor TTPs, IOCs, attribution
  incident_report          — documented real-world attack or breach
  news_article             — news outlet covering a security event
  security_blog            — researcher blog, writeup, or analysis post
  government_advisory      — CISA, NCSC, FBI, NSA, or similar agency advisory
  vendor_report            — vendor whitepaper, product release, or vendor blog
  conference_talk          — conference presentation or abstract
  exploit_poc              — proof-of-concept exploit or attack demo
  standards_document       — NIST, ISO, OWASP, or similar standard
  dataset_or_benchmark     — evaluation dataset, benchmark, or measurement study
  unknown                  — cannot determine

Return ONLY valid JSON matching the schema. No markdown.`;
}

// ── Per-source prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const text = (source.full_text || source.clean_text || source.summary || "").slice(0, 6000);
  return `Classify this source:

TITLE: ${source.title || "untitled"}
PUBLISHER: ${source.publisher || "unknown"}
URL: ${source.url || "none"}
DATE: ${source.date_published || "unknown"}

TEXT:
${text || "(no text available — classify from title/URL only)"}

Return JSON. If relevant=false, set category="unclear_or_adjacent" and explain in rejection_reason.
If relevant=true, assign the best-fitting category, 1-3 primary_tags from that category, relevant sub_techniques, and extract up to 8 key_entities, up to 5 main_claims, key_numbers mentioned.`;
}

// ── Post-call validation and normalisation ────────────────────────────────────

/**
 * Recursively search an object for the first value matching any of the given keys.
 * Breadth-first by key at each level, then depth-first into values.
 * Stops at the first match so shallow fields win over deep ones.
 * Skips arrays to avoid matching items inside array elements accidentally.
 */
function deepGet(obj, ...names) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  for (const name of names) {
    if (name in obj) return obj[name];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = deepGet(v, ...names);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Resolve the model's category field to a valid DOMAIN string.
 *
 * The model sometimes puts a primary tag ID (e.g. "AE02_ai_social_engineering")
 * in the category field instead of the domain. This resolves that via taxonomy
 * lookup, then falls back to inferring from the primary_tags list.
 */
function resolveCategory(rawCategory, rawPrimaryTags) {
  // 1. Already a valid domain → use it
  if (DOMAINS.includes(rawCategory)) return rawCategory;

  // 2. It's a tag ID (e.g. "AE02_ai_social_engineering") → look up its domain
  if (rawCategory && isValidTag(rawCategory)) {
    const domain = domainOfTag(rawCategory);
    if (domain) return domain;
  }

  // 3. Infer from the first valid primary_tag
  const tags = Array.isArray(rawPrimaryTags) ? rawPrimaryTags : [];
  for (const tag of tags) {
    if (isValidTag(tag)) {
      const domain = domainOfTag(tag);
      if (domain) return domain;
    }
  }

  return "unclear_or_adjacent";
}

/**
 * Flatten an arbitrarily nested LLM response into the expected flat shape.
 *
 * Anthropic models routinely invent creative nesting structures depending on
 * the system prompt and model version. Rather than enumerating every pattern,
 * we use deepGet() to find each field wherever it lives in the object tree.
 */
function flattenRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    relevant:           deepGet(raw, "relevant", "is_relevant", "isRelevant"),
    rejection_reason:   deepGet(raw, "rejection_reason", "reason", "irrelevance_reason"),
    category:           deepGet(raw, "category", "threat_category", "domain", "primary_category"),
    primary_tags:       deepGet(raw, "primary_tags", "tags", "threat_tags", "primary_threat_tags"),
    sub_techniques:     deepGet(raw, "sub_techniques", "subtechniques", "sub_technique_ids", "sub_technique_list"),
    ai_enabled_overlay: deepGet(raw, "ai_enabled_overlay", "ai_enabled", "ai_enabled_as_weapon"),
    source_type:        deepGet(raw, "source_type", "type", "content_type", "source_category"),
    trust_tier:         deepGet(raw, "trust_tier", "trust", "publisher_tier", "credibility_tier"),
    key_entities:       deepGet(raw, "key_entities", "entities", "named_entities", "actors", "entity_list"),
    main_claims:        deepGet(raw, "main_claims", "claims", "key_findings", "findings", "key_claims"),
    key_numbers:        deepGet(raw, "key_numbers", "numbers", "statistics", "metrics", "quantitative_findings"),
    short_summary:      deepGet(raw, "short_summary", "summary", "description", "analysis_summary", "technical_summary"),
  };
}

function normalise(raw, source, opts = {}) {
  if (!raw || typeof raw !== "object") {
    return { relevant: false, rejection_reason: "LLM returned non-object", _understand_version: UNDERSTAND_VERSION };
  }

  const flat = flattenRaw(raw);

  // Validate tags and sub-techniques against taxonomy; guard non-array returns
  const rawTags = Array.isArray(flat.primary_tags) ? flat.primary_tags : [];
  const rawSubs = Array.isArray(flat.sub_techniques) ? flat.sub_techniques : [];
  const validatedTags = rawTags.filter(t => isValidTag(t));
  const validatedSubs = rawSubs.filter(s => isValidSubTech(s));

  // Resolve category: handles tag-IDs-as-category, infers from tags, falls back
  const resolvedCategory = resolveCategory(flat.category, rawTags);

  // Determine relevance: trust the field if present, but also infer from category
  // (Haiku sometimes contradicts itself: says relevant=false yet assigns a real domain)
  const isRelevant = Boolean(flat.relevant) ||
    (resolvedCategory !== "unclear_or_adjacent" && !flat.rejection_reason);

  // ai_enabled_threats gate: the category requires AI to be documented as the attack
  // tool, evidenced by at least one AE01–AE10 primary_tag. Sources about conventional
  // threat campaigns that don't document AI usage get discarded as unclear_or_adjacent.
  // Bypassed in skipLlm (dry-run) mode where tags are not assigned.
  const aeTags = validatedTags.filter(t => t.startsWith("AE"));
  const failsAeGate = !opts.skipLlm && resolvedCategory === "ai_enabled_threats" && aeTags.length === 0;
  const finalCategory       = failsAeGate ? "unclear_or_adjacent" : resolvedCategory;
  const finalRelevant       = failsAeGate ? false : isRelevant;
  const finalRejection      = failsAeGate
    ? "ai_enabled_threats requires an AE01–AE10 tag confirming AI use as attack tool; no such tag found — conventional threat activity without documented AI involvement"
    : (flat.rejection_reason || null);

  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published:source.date_published,
    full_text:     source.full_text || source.clean_text || "",

    relevant:         finalRelevant,
    rejection_reason: finalRejection,
    category:         finalCategory,
    primary_tags:     validatedTags,
    sub_techniques:   validatedSubs,
    ai_enabled_overlay: Boolean(flat.ai_enabled_overlay),
    source_type:      SOURCE_TYPES.includes(flat.source_type) ? flat.source_type : "unknown",
    trust_tier:       TRUST_TIERS.includes(flat.trust_tier) ? flat.trust_tier : "unknown",
    key_entities:     (Array.isArray(flat.key_entities) ? flat.key_entities : []).slice(0, 10),
    main_claims:      (Array.isArray(flat.main_claims)  ? flat.main_claims  : []).slice(0, 6),
    key_numbers:      (Array.isArray(flat.key_numbers)  ? flat.key_numbers  : []).slice(0, 8),
    short_summary:    (String(flat.short_summary || "")).slice(0, 400),
    _understand_version: UNDERSTAND_VERSION,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Understand a single source. Returns a normalised understanding object.
 * Returns { relevant: false } for irrelevant sources — caller should discard.
 *
 * @param {object} source   - Raw source from DB or connector
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm=false]  - Return deterministic stub
 * @returns {Promise<object>}
 */
export async function understandSource(source, opts = {}) {
  if (opts.skipLlm) {
    // Deterministic stub: accept everything, assign unclear.
    // skipLlm=true bypasses the AE gate — tags are not assigned in dry-run mode.
    return normalise({
      relevant: true,
      category: source.main_category || "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      primary_tags: [],
      sub_techniques: [],
      key_entities: [],
      main_claims: [],
      key_numbers: [],
      short_summary: (source.summary || source.title || "").slice(0, 200),
    }, source, { skipLlm: true });
  }

  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(source);

  try {
    // Try routedLLM first (task-aware model selection)
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "source_understanding",
        requires_json: true,
        schema: OUTPUT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      // Fallback to legacy callLLM
      const text = await callLLM(sys, usr, { schema: OUTPUT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return normalise(raw, source);
  } catch (err) {
    return normalise({
      relevant: false,
      rejection_reason: `LLM error: ${err.message}`,
      category: "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      short_summary: "",
    }, source);
  }
}

/**
 * Understand a batch of sources with bounded concurrency.
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]
 * @param {number}   [opts.concurrency=5]
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{ relevant: object[], discarded: object[], counts: object }>}
 */
export async function understandAllSources(sources, opts = {}) {
  const { concurrency = 5, onProgress } = opts;
  const results = [];

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(s => understandSource(s, opts)));
    results.push(...batchResults);
    onProgress?.(Math.min(i + concurrency, sources.length), sources.length);
  }

  const relevant   = results.filter(r => r.relevant);
  const discarded  = results.filter(r => !r.relevant);
  const byCat      = {};
  for (const r of relevant) {
    byCat[r.category] = (byCat[r.category] || 0) + 1;
  }

  return {
    relevant,
    discarded,
    counts: {
      total:       results.length,
      relevant:    relevant.length,
      discarded:   discarded.length,
      by_category: byCat,
    },
  };
}
