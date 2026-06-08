/**
 * L4 — Taxonomy / Source Understanding + LLM Understanding
 *
 * Tags every source against the Validated AI Threat Taxonomy (June 2026) and
 * assigns source_type. Does NOT assign final main_category — that is Layer 6's job.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Output:  structured JSON via json_schema response_format (TAXONOMY_SCHEMA)
 * Label:   "L4-taxonomy-source-understanding"
 *
 * Prompt embeds the controlled ontology via buildTaxonomyContextForPrompt() plus
 * the domain assignment + "do-not" rules. The model proposes primary_domain,
 * primary_threat_tags (each with a supporting quote), secondary_dimensions, and —
 * for AI-enabled threats — the paired operational ATT&CK technique + AI modifier.
 * Every proposed tag is then run through validateThreatTag() (taxonomyValidation.js)
 * so weak / mis-domained / secondary-as-primary tags are downgraded or rejected.
 *
 * ── OUTPUT (source.understanding) ─────────────────────────────────────────────
 *   primary_domain          — dominant domain or "unclear_or_adjacent"
 *   primary_threat_tags[]   — validated {tag, domain, parent_tag, subdomain,
 *                             supporting_quote, reason, confidence,
 *                             validation_status, caveat_if_any, reference_urls,
 *                             operational_mapping?, ai_capability_modifier?}
 *   secondary_dimensions[]  — controlled secondary labels (qualifiers/impacts)
 *   ai_enabled_mappings[]   — paired {primary_threat_tag, operational_attack_mapping,
 *                             ai_capability_modifier, confidence}
 *   taxonomy_evidence[]     — raw {tag, supporting_quote, reason, confidence}
 *   validation_status       — overall validated | weak | needs_manual_review | rejected
 *   category_candidates[]   — suggested categories (Layer 6 picks the winner)
 *   + source_summary / primary_subject / main_claims / key_entities / important_numbers
 *
 * Idempotent: sources already stamped with TAXONOMY_VERSION are skipped.
 */

import { callLLM }             from "../../llm/callLLM.js";
import { classifySourceType }  from "../validation/sourceTyping.js";
import { ALL_SOURCE_TYPES }    from "../../config/sourceTypes.js";
import { CLASSIFIABLE_CATEGORIES } from "../../config/categories.js";
import {
  TAXONOMY_VERSION as REGISTRY_VERSION,
  DOMAINS, buildTaxonomyContextForPrompt,
  VALID_PRIMARY_TAGS, getSubTechniques, normalizeTaxonomyAssignment,
} from "../../config/taxonomyRegistry.js";
import { validateThreatTags, validateAiEnabledOverlay } from "../../config/taxonomyValidation.js";

export const TAXONOMY_VERSION = REGISTRY_VERSION;

// Back-compat alias: the runner and store still import UNDERSTAND_VERSION
export const UNDERSTAND_VERSION = TAXONOMY_VERSION;

// ── Structured output schema ──────────────────────────────────────────────────

const TAXONOMY_SCHEMA = {
  type: "object",
  // source_type and source_summary are NOT required here — Layer 3 (validation)
  // already produced them. Layer 4 focuses on taxonomy + intelligence extraction.
  required: [
    "primary_subject", "main_claims",
    "key_entities", "important_numbers",
    "primary_domain", "primary_tags", "sub_techniques",
    "ai_enabled", "ai_enabled_roles", "ai_capabilities",
    "automation_level", "autonomy_level",
    "category_candidates",
  ],
  properties: {
    source_type:            { type: "string" },
    source_type_confidence: { type: "string", enum: ["high", "medium", "low"] },
    source_type_reason:     { type: "string" },
    source_summary:         { type: "string" },
    primary_subject:        { type: "string" },
    main_claims:            { type: "array", items: { type: "string" } },
    key_entities:           { type: "array", items: { type: "string" } },
    important_numbers:      { type: "array", items: { type: "string" } },
    primary_domain:         { type: "string" },
    primary_tags: {
      type: "array",
      items: {
        type: "object",
        required: ["tag", "domain", "supporting_quote", "confidence"],
        properties: {
          tag:              { type: "string" },
          domain:           { type: "string" },
          supporting_quote: { type: "string" },
          reason:           { type: "string" },
          confidence:       { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    sub_techniques: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "parent_tag", "supporting_quote"],
        properties: {
          id:               { type: "string" },
          parent_tag:       { type: "string" },
          supporting_quote: { type: "string" },
        },
      },
    },
    // AI-enabled overlay — appears on ANY domain when AI materially enhances the attack
    ai_enabled:       { type: "boolean" },
    ai_enabled_roles: { type: "array", items: { type: "string" } },
    ai_capabilities:  { type: "array", items: { type: "string" } },
    automation_level: { type: "string", enum: ["human_assisted", "semi_autonomous", "autonomous", "unknown"] },
    autonomy_level:   { type: "string", enum: ["human_assisted", "semi_autonomous", "autonomous", "multi_agent", "unknown"] },
    // Optional contextual metadata
    attack_modality:     { type: "string" },
    delivery_vector:     { type: "string" },
    target_platform:     { type: "string" },
    disclosed_data_type: { type: "string" },
    mapped_frameworks:   { type: "array", items: { type: "string" } },
    category_candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "supporting_tags", "confidence", "reason"],
        properties: {
          category:        { type: "string" },
          supporting_tags: { type: "array", items: { type: "string" } },
          confidence:      { type: "string", enum: ["high", "medium", "low"] },
          reason:          { type: "string" },
        },
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(scopeDomain = null) {
  // Scope the taxonomy to the domain Layer 3 already identified. This keeps the
  // prompt focused on ~10 relevant tags (plus the cross-cutting AI-enabled overlay)
  // instead of dumping all four domains' tags at the model. When Layer 3 gave no
  // reliable domain hint, fall back to the full taxonomy.
  const taxonomyContext = buildTaxonomyContextForPrompt(scopeDomain);

  const scopeNote = scopeDomain
    ? `\n## DOMAIN SCOPE\nUpstream triage (Layer 3) judged this source to be in the **${scopeDomain}** domain, so the taxonomy below is scoped to that domain plus the cross-cutting AI-enabled overlay. Assign primary tags from this set. If — and only if — the evidence clearly shows the source belongs to a DIFFERENT domain, set primary_domain to that domain and return primary_tags: [] (a later pass will re-tag).\n`
    : "";

  return `You are enriching a source for an AI-cyber horizon scan using the AI Threat Taxonomy v9 (docs/TAXONOMY.md).

A triage stage (Layer 3) has ALREADY summarised this source, judged it genuinely about an AI threat, and assigned its source_type. Those are given to you in the input — do NOT re-derive them. Your job is to assign the most precise PRIMARY TAGS and SUB-TECHNIQUES the evidence supports, and to extract the supporting intelligence (claims, entities, numbers).
${scopeNote}

## CORE PRINCIPLE
Fewer, higher-confidence tags are always better than many uncertain ones.
1–2 well-evidenced tags beat 6–8 speculative ones. Return empty arrays if unsure.

## AI-ENABLED DUAL ROLE (critical architecture concept)
AI-enabled threats (AE01–AE10) serve TWO roles:
1. PRIMARY DOMAIN: set primary_domain=ai_enabled_threats ONLY when the source is PRIMARILY about AI being used as an offensive tool for conventional cyber operations (deepfake fraud → AE10, AI phishing campaigns → AE02, influence operations → AE09, etc.)
2. OVERLAY METADATA: set ai_enabled=true + ai_enabled_roles[AE01–AE10] on ANY source where AI materially enhances the attack, even when the primary domain is traditional_ai_threats, llm_threats, or agentic_ai_threats.

Example: A source about LLM prompt injection that also uses AI to generate the injected payload should have:
  primary_domain: "llm_threats", primary_tags: ["LLM01_prompt_injection"],
  ai_enabled: true, ai_enabled_roles: ["AE02_ai_enabled_social_engineering"]

## THE TAXONOMY

${taxonomyContext}

## STEP 1 — EXTRACT INTELLIGENCE
The source_summary and source_type are already provided by triage — do not produce them.
Extract:
- primary_subject: ≤15 words.
- main_claims: 1–5 factual statements the source directly supports.
- key_entities: named orgs, tools, threat groups, CVEs, model names, APIs. Max 10.
- important_numbers: "value: context". Max 5. Empty if none.

## STEP 3 — PRIMARY DOMAIN
Pick the single best domain:
- traditional_ai_threats — the ML model / training data / inference / ML supply chain is attacked
- llm_threats — LLM-specific (prompts, guardrails, context, RAG, embeddings, system prompt)
- agentic_ai_threats — system acts through memory, tools, MCP, runtime, credentials, workflow, orchestration
- ai_enabled_threats — source is PRIMARILY about AI as the attacker's operational tool
- unclear_or_adjacent — none clearly applies

## STEP 4 — PRIMARY TAGS (primary_tags array)
Assignment rules — ALL mandatory:
1. Use ONLY TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, or AE01–AE10 tag IDs.
2. Each tag MUST include supporting_quote: a specific sentence copied from the SOURCE TEXT. Minimum 20 characters.
3. Tags must match the primary_domain you assigned.
4. Max 4 primary tags. Return [] if none clearly applies.
5. Domain do-not rules:
   - traditional_ai_threats: only when ML model/training data/inference is specifically attacked
   - llm_threats: only with LLM-specific evidence (prompts, RAG, embeddings, system prompt)
   - agentic_ai_threats: only when system uses tools/MCP/memory/workflow/orchestration
   - ai_enabled_threats as primary: only when AI is the attacker's primary operational capability

### Domain disambiguation:
  Standalone chatbot / API with no tool use → llm_threats
  System using tools, MCP, memory, multi-step chains → agentic_ai_threats
  AI poisoning training data → traditional_ai_threats (TAI01_data_poisoning)
  LLM used as attack automation tool against non-AI targets → ai_enabled_threats (AE08)

## STEP 5 — SUB-TECHNIQUES (sub_techniques array)
For each primary tag, optionally assign sub-techniques that the source directly evidences.
Each sub-technique requires: id (sub-technique id from taxonomy), parent_tag (the primary tag id), supporting_quote.
Only assign sub-techniques that are explicitly evidenced — never infer them.
Return [] if no sub-techniques are clearly supported.

Example sub-techniques for LLM01_prompt_injection:
  direct_prompt_injection, indirect_prompt_injection, multi_turn_prompt_injection,
  retrieval_augmented_prompt_injection, tool_output_prompt_injection,
  instruction_override, system_prompt_override, prompt_obfuscation

## STEP 6 — AI-ENABLED OVERLAY
Always fill these fields (they appear on EVERY source):
- ai_enabled: true if AI materially enhances the attack described; false otherwise
- ai_enabled_roles: array of AE01–AE10 roles (only when ai_enabled=true and different domain assigned)
- ai_capabilities: from: synthetic_text_generation | synthetic_image_generation |
  synthetic_audio_generation | synthetic_video_generation | code_generation | automation |
  autonomous_planning | reconnaissance_automation | vulnerability_analysis |
  natural_language_understanding | multimodal_processing | adversarial_optimization
- automation_level: human_assisted | semi_autonomous | autonomous | unknown
- autonomy_level: human_assisted | semi_autonomous | autonomous | multi_agent | unknown

## STEP 7 — CATEGORY CANDIDATES (category_candidates)
Suggest 1–3 of: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats, unclear_or_adjacent.
Each needs: category, supporting_tags (tag ids), confidence (high/medium/low), reason (one sentence).

Return strict JSON only — no markdown, no preamble.`;
}

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(source, detType) {
  const parts = [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}`,
    `DATE: ${source.date_published || "unknown"}`,
    `URL: ${source.url || ""}`,
  ];

  // Layer 3 triage results — already established, reuse them.
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type
    : null;
  if (layer3Type) {
    parts.push(`TRIAGE SOURCE TYPE (already determined — keep unless clearly wrong): ${layer3Type}`);
  } else if (detType && detType.type !== "unknown") {
    parts.push(`PRE-CLASSIFICATION (deterministic hint): source_type=${detType.type} (confidence: ${detType.confidence}, method: ${detType.method})`);
  }
  if (DOMAINS.includes(source.candidate_domain)) {
    parts.push(`TRIAGE DOMAIN HINT: ${source.candidate_domain}`);
  }
  if (source.validation_summary) {
    parts.push(`\nTRIAGE SUMMARY (Layer 3 — this is the source_summary; do not rewrite it): ${source.validation_summary}`);
  }

  const summary = (source.summary || "").trim();
  if (summary) parts.push(`\nSUMMARY: ${summary.slice(0, 500)}`);

  const text = (source.clean_text || source.full_text || "").trim();
  if (text) parts.push(`\nSOURCE TEXT:\n${text.slice(0, 3500)}`);

  const tags = (source.tags || []).filter(Boolean);
  if (tags.length > 0) parts.push(`\nEXISTING TAGS: ${tags.join(", ")}`);

  return parts.join("\n");
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function guessDomainFromKeywords(source) {
  // Include summary for RSS sources that often lack full_text.
  const text = `${source.title || ""} ${source.summary || ""} ${source.full_text || ""}`.toLowerCase();

  // Check agentic first — it is more specific than llm and overlaps heavily.
  if (
    text.includes("agentic") || text.includes(" mcp ") || text.includes("mcp server") ||
    text.includes("model context protocol") ||
    text.includes("langchain") || text.includes("autogpt") ||
    text.includes("autonomous agent") || text.includes("multi-agent") ||
    text.includes("tool hijack") || text.includes("tool poisoning") ||
    text.includes("memory poisoning") || text.includes("agent memory") ||
    text.includes("coding agent") || text.includes("ai agent abuse") ||
    text.includes("tool misuse") || text.includes("sandbox escape") ||
    text.includes("workflow poisoning") || text.includes("orchestration")
  ) return "agentic_ai_threats";

  if (
    text.includes("adversarial ml") || text.includes("adversarial machine learning") ||
    text.includes("model extract") || text.includes("data poison") ||
    text.includes("training data poison") || text.includes("evasion attack") ||
    text.includes("backdoor attack") || text.includes("adversarial example") ||
    text.includes("model inversion") || text.includes("membership inference") ||
    text.includes("model supply chain") || text.includes("ai supply chain") ||
    text.includes("inference api abuse")
  ) return "traditional_ai_threats";

  if (
    text.includes("deepfake") || text.includes("face swap") || text.includes("synthetic face") ||
    text.includes("voice cloning") || text.includes("audio deepfake") || text.includes("voice spoofing") ||
    text.includes("synthetic video") || text.includes("disinformation") ||
    text.includes("synthetic media") || text.includes("ai-powered phishing") ||
    text.includes("ai-enabled phishing") || text.includes("ai-generated phishing") ||
    text.includes("ai-assisted phishing") || text.includes("ai malware") ||
    text.includes("ai-generated malware") || text.includes("ai reconnaissance") ||
    text.includes("ai-assisted exploit") || text.includes("ai attack automation") ||
    text.includes("synthetic identity")
  ) return "ai_enabled_threats";

  if (
    text.includes("prompt injection") || text.includes("jailbreak") ||
    text.includes("rag poison") || text.includes("guardrail") ||
    text.includes("llm vulnerability") || text.includes("large language model") ||
    text.includes("context window") || text.includes("system prompt leak") ||
    text.includes("vector database") || text.includes("embedding attack") ||
    text.includes("model theft") || text.includes("llm supply chain")
  ) return "llm_threats";

  return "unclear_or_adjacent";
}

function deterministicFallback(source, detType) {
  // Prefer the Layer 3 domain hint, else keyword-guess.
  const domain = DOMAINS.includes(source.candidate_domain)
    ? source.candidate_domain
    : guessDomainFromKeywords(source);
  const candidates = domain !== "unclear_or_adjacent"
    ? [{ category: domain, supporting_tags: [], confidence: "low", reason: "Layer 3 hint / keyword fallback — LLM unavailable" }]
    : [];

  // Reuse Layer 3 outputs where available.
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type
    : null;

  return {
    source_type:            layer3Type || detType.type,
    source_type_confidence: layer3Type ? "medium" : detType.confidence,
    source_type_reason:     layer3Type ? "Layer 3 validation source_type" : `Deterministic rule (${detType.method}) — LLM unavailable`,
    source_summary:         source.validation_summary || `${source.title || ""}. Published by ${source.publisher || "unknown"}.`,
    primary_subject:        (source.title || "").slice(0, 80),
    main_claims:            [],
    key_entities:           [source.publisher].filter(Boolean),
    important_numbers:      [],
    primary_domain:         domain,
    primary_tags:           [],
    primary_threat_tags:    [],  // back-compat
    sub_techniques:         [],
    ai_enabled:             false,
    ai_enabled_roles:       [],
    ai_capabilities:        [],
    automation_level:       "unknown",
    autonomy_level:         "unknown",
    taxonomy_evidence:      [],
    taxonomy_validation_status: "needs_manual_review",
    taxonomy_version:       TAXONOMY_VERSION,
    category_candidates:    candidates,
    llm_used:               false,
  };
}

// ── Output validation + normalisation ─────────────────────────────────────────

function overallStatus(validatedTags) {
  if (validatedTags.some((t) => t.validation_status === "validated")) return "validated";
  if (validatedTags.some((t) => t.validation_status === "weak")) return "weak";
  if (validatedTags.length) return "needs_manual_review";
  return "needs_manual_review";
}

function validateAndNormalise(raw, detType, source) {
  const out = { ...raw };

  if (!ALL_SOURCE_TYPES.includes(out.source_type)) {
    out.source_type            = detType?.type || "unknown";
    out.source_type_confidence = detType?.confidence || "low";
    out.source_type_reason     = `LLM returned invalid type — reverted to deterministic (${detType?.method})`;
  }

  // Normalize primary_tags (new field name) with fallback to primary_threat_tags
  const proposedTags = Array.isArray(out.primary_tags)
    ? out.primary_tags
    : (Array.isArray(out.primary_threat_tags) ? out.primary_threat_tags : []);

  // Keep raw proposals as taxonomy_evidence
  out.taxonomy_evidence = proposedTags
    .filter((t) => t && t.tag)
    .map((t) => ({ tag: t.tag, supporting_quote: t.supporting_quote || "", reason: t.reason || "", confidence: t.confidence || "medium" }))
    .slice(0, 6);

  const { all } = validateThreatTags(proposedTags, source);
  const passedValidation = all.filter((r) => r.validation_status !== "rejected");
  if (passedValidation.length > 4) {
    process.stdout.write(
      `  [L4-taxonomy] "${(source.title || "").slice(0, 60)}": ${passedValidation.length} tags proposed — capped to 4\n`
    );
  }
  const keptTags = passedValidation.slice(0, 4)
    .map((r) => ({
      ...r,
      supporting_quote: (proposedTags.find((x) => x.tag === r.tag) || {}).supporting_quote || "",
      reason: (proposedTags.find((x) => x.tag === r.tag) || {}).reason || "",
    }));

  out.primary_tags        = keptTags;
  out.primary_threat_tags = keptTags; // back-compat

  // Validate sub-techniques — only keep those belonging to selected primary tags
  const selectedPrimaryIds = new Set(keptTags.map((t) => t.tag));
  const rawSubs = Array.isArray(out.sub_techniques) ? out.sub_techniques : [];
  out.sub_techniques = rawSubs
    .filter((s) => {
      const id = typeof s === "string" ? s : s?.id;
      if (!id) return false;
      // Validate against known sub-techniques and parent
      const parentTag = typeof s === "object" ? s.parent_tag : null;
      if (parentTag && !selectedPrimaryIds.has(parentTag)) return false;
      return true;
    })
    .slice(0, 12);

  // AI-enabled overlay
  const aiOverlay = validateAiEnabledOverlay({
    ai_enabled:       out.ai_enabled === true,
    ai_enabled_roles: Array.isArray(out.ai_enabled_roles) ? out.ai_enabled_roles : [],
    ai_capabilities:  Array.isArray(out.ai_capabilities)  ? out.ai_capabilities  : [],
    automation_level: out.automation_level,
    autonomy_level:   out.autonomy_level,
  });
  out.ai_enabled       = aiOverlay.ai_enabled;
  out.ai_enabled_roles = aiOverlay.ai_enabled_roles;
  out.ai_capabilities  = aiOverlay.ai_capabilities;
  out.automation_level = aiOverlay.automation_level;
  out.autonomy_level   = aiOverlay.autonomy_level;

  out.taxonomy_validation_status = overallStatus(keptTags);

  // primary_domain: trust a valid LLM value, else derive from kept tags
  if (!DOMAINS.includes(out.primary_domain)) {
    out.primary_domain = deriveDomain(keptTags);
  }

  // category_candidates — tolerate string[]
  let rawCandidates = out.category_candidates;
  if (!Array.isArray(rawCandidates)) rawCandidates = [];
  out.category_candidates = rawCandidates
    .map((c) => typeof c === "string" ? { category: c, confidence: "medium" } : c)
    .filter((c) => c && typeof c === "object" && CLASSIFIABLE_CATEGORIES.includes(c.category))
    .slice(0, 3);

  const arr = (v) => (Array.isArray(v) ? v : []);
  out.main_claims       = arr(out.main_claims).slice(0, 5);
  out.key_entities      = arr(out.key_entities).slice(0, 10);
  out.important_numbers = arr(out.important_numbers).slice(0, 5);

  if ((out.source_summary || "").length > 600) {
    out.source_summary = out.source_summary.slice(0, 600) + "…";
  }

  return out;
}

function deriveDomain(tags) {
  if (!tags.length) return "unclear_or_adjacent";
  const counts = {};
  for (const t of tags) if (t.domain) counts[t.domain] = (counts[t.domain] || 0) + 1;
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top ? top[0] : "unclear_or_adjacent";
}

// ── Public API ────────────────────────────────────────────────────────────────

const _systemPromptCache = new Map();

/**
 * Enrich a single source with taxonomy tags and intelligence metadata.
 *
 * @param {object} source - A cleaned source from Layer 4.
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm=false] - Force deterministic fallback.
 * @returns {Promise<object>} Source with `understanding` and `taxonomy_version` set.
 */
export async function understandSource(source, opts = {}) {
  const { skipLlm = false } = opts;

  if (source.taxonomy_version === TAXONOMY_VERSION) return source;

  const detType = classifySourceType(source);

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );

  let taxonomy;

  // Scope the taxonomy prompt to the domain Layer 3 already identified (if any).
  const scopeDomain = DOMAINS.includes(source.candidate_domain) ? source.candidate_domain : null;

  if (!hasLlm) {
    taxonomy = deterministicFallback(source, detType);
  } else {
    const scopeKey = scopeDomain || "all";
    let systemPrompt = _systemPromptCache.get(scopeKey);
    if (!systemPrompt) {
      systemPrompt = buildSystemPrompt(scopeDomain);
      _systemPromptCache.set(scopeKey, systemPrompt);
    }

    try {
      const userPrompt = buildUserPrompt(source, detType);
      const raw = await callLLM(systemPrompt, userPrompt, {
        task:     "source_understanding",
        schema:   TAXONOMY_SCHEMA,
        logLabel: "L4-taxonomy-source-understanding",
      });
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      taxonomy = {
        ...validateAndNormalise(parsed, detType, source),
        llm_used:        true,
        taxonomy_version: TAXONOMY_VERSION,
      };
    } catch (err) {
      process.stdout.write(
        `  [L4-taxonomy] LLM failed for "${(source.title || "").slice(0, 60)}": ${err.message} — using fallback\n`
      );
      taxonomy = deterministicFallback(source, detType);
    }
  }

  // Source type and summary come from Layer 3 (validation) when available — Layer 4
  // does not re-derive them. Fall back to the taxonomy/deterministic values only for
  // legacy sources that predate the validation layer.
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type
    : null;
  const resolvedSourceType = layer3Type || taxonomy.source_type || source.source_type || "unknown";
  const resolvedSummary = source.validation_summary || taxonomy.source_summary ||
    `${source.title || ""}. Published by ${source.publisher || "unknown"}.`;

  return {
    ...source,
    source_type:      resolvedSourceType,
    primary_domain:   taxonomy.primary_domain,
    taxonomy_version: TAXONOMY_VERSION,
    // Hoist top-level taxonomy fields for DB persistence
    primary_tags:     taxonomy.primary_tags || [],
    sub_techniques:   taxonomy.sub_techniques || [],
    ai_enabled:       taxonomy.ai_enabled || false,
    ai_enabled_roles: taxonomy.ai_enabled_roles || [],
    ai_capabilities:  taxonomy.ai_capabilities || [],
    automation_level: taxonomy.automation_level || "unknown",
    autonomy_level:   taxonomy.autonomy_level || "unknown",
    taxonomy_validation_status: taxonomy.taxonomy_validation_status || "needs_manual_review",
    understanding: {
      ...taxonomy,
      source_type:    resolvedSourceType,
      source_summary: resolvedSummary,
    },
  };
}
