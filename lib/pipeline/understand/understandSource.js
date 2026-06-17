/**
 * L4 — Taxonomy Understanding (multi-stage chain)
 *
 * ── CHAIN ────────────────────────────────────────────────────────────────────
 *
 * Stage 0 — Intelligence snippet extraction (deterministic, for long sources)
 *   Sources > 8 kB have key technique/vulnerability excerpts pulled from deep
 *   in the text. Snippets supplement the first 3 kB so methodology/results
 *   sections are not silently truncated.
 *
 * Stage 1 — Source Understanding + Domain Gate         (Haiku)
 *   Read the source. Summarise it. Decide if a primary domain can be assigned.
 *   GATE: if domain = unclear_or_adjacent AND confidence = low  → status = "no_domain_match", stop.
 *   Outputs: source_summary, primary_subject, main_claims, key_entities,
 *            important_numbers, primary_domain, domain_confidence
 *
 * Stage 2 — Primary Tag Assignment                     (Haiku, domain-scoped)
 *   Receives Stage 1 summary + claims + key_entities + important_numbers + source text.
 *   Sees ONLY the tags for the assigned domain.
 *   Assign 1–3 primary tags, each grounded by a verbatim source quote.
 *   GATE: if no tags with confidence ≥ medium → detect alternate domain or → status = "no_tags_found".
 *   Outputs: primary_tags[], each with tag, domain, supporting_quote, confidence
 *
 * Stage 3 — Sub-technique + AI-enabled Overlay         (Haiku)
 *   Receives Stage 1 claims + key_entities + Stage 2 tags + source text.
 *   Sees ONLY sub-techniques for the selected primary tags.
 *   Outputs: sub_techniques[], ai_enabled, ai_enabled_roles, ai_capabilities,
 *            automation_level, autonomy_level
 *
 * Stage 4 (QA) — Taxonomy QA Verifier                 (Gemini Flash, cross-provider)
 *   After Stage 3, a different-provider model verifies:
 *   - Domain is supported by source text
 *   - Each primary tag has a real supporting quote
 *   - Sub-techniques match their parent tags
 *   - AI-enabled=true is explicit (not inferred)
 *   QA can downgrade or remove tags/sub-techniques.
 *   Outputs: taxonomy_confidence_score, taxonomy_stage_results.qa
 *
 * Stage 5 — Category candidates (deterministic)
 *   Derived from primary_domain + primary_tags. No LLM call.
 *
 * ── FALLBACK ─────────────────────────────────────────────────────────────────
 * When skipLlm=true or all providers fail: deterministic keyword-based domain
 * assignment, no tags, status = "needs_manual_review".
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * Sources already stamped with TAXONOMY_VERSION are returned unchanged.
 *
 * ── OUTPUT (source.understanding) ────────────────────────────────────────────
 *   primary_domain            — assigned domain or "unclear_or_adjacent"
 *   primary_tags[]            — validated {tag, domain, supporting_quote, confidence,
 *                               evidence_basis, validation_status}
 *   sub_techniques[]          — sub-technique objects for the primary tags
 *   ai_enabled                — boolean
 *   ai_enabled_roles[]        — AE* role IDs when ai_enabled
 *   ai_capabilities[]         — capability strings
 *   automation_level          — human_assisted | semi_autonomous | autonomous | unknown
 *   autonomy_level            — same options
 *   source_summary            — 2-3 sentence summary
 *   primary_subject           — ≤15 words
 *   main_claims[]             — 1-5 factual claims
 *   key_entities[]            — named orgs, tools, CVEs, actors
 *   important_numbers[]       — stats and measurements
 *   category_candidates[]     — suggested categories for Layer 6
 *   taxonomy_validation_status — validated | weak | needs_manual_review |
 *                                no_domain_match | no_tags_found | rejected
 *   taxonomy_stage_results    — audit trail: which stages ran + why stopped + qa verdict
 */

import { routedLLM }           from "../../llm/llmRouter.js";
import { classifySourceType }  from "../validation/sourceTyping.js";
import { ALL_SOURCE_TYPES }    from "../../config/sourceTypes.js";
import { CLASSIFIABLE_CATEGORIES } from "../../config/categories.js";
import {
  TAXONOMY_VERSION as REGISTRY_VERSION,
  DOMAINS,
  buildTaxonomyContextForPrompt,
  VALID_PRIMARY_TAGS,
  getSubTechniques,
  normalizeTaxonomyAssignment,
} from "../../config/taxonomyRegistry.js";
import { validateThreatTags, validateAiEnabledOverlay } from "../../config/taxonomyValidation.js";

export const TAXONOMY_VERSION = REGISTRY_VERSION;
export const UNDERSTAND_VERSION = TAXONOMY_VERSION;

// ── Stage 0: Intelligence snippet extraction (for long sources) ───────────────

// Signals that indicate an excerpt is intelligence-bearing (attack/tool/result terms).
const SNIPPET_SIGNAL_RX = /\b(?:attack|exploit|inject|poison|bypass|jailbreak|evad|exfiltrat|backdoor|vulnerab|compromise|hijack|escape|phish|deepfake|voice\s*clon|CVE-\d|MCP|Model Context Protocol|LangChain|LangGraph|AutoGPT|AutoGen|Copilot|GPT-?[3-4]|Claude|Llama|Mistral|DeepSeek|Qwen|RAG|vector database|agentic|multi-agent|autonomous agent|prompt injection|model extraction|proof[\s-]of[\s-]concept|\bPoC\b|benchmark|attack success rate|\d+(?:\.\d+)?%\s*(?:success|bypass|attack|accuracy|detection))\w{0,6}/gi;

const LONG_SOURCE_THRESHOLD = 8000;
const SNIPPET_LEN  = 380;
const SNIPPET_STEP = 127;  // ~66 % overlap — reduces dense-section splitting risk

/**
 * Extract up to maxSnippets intelligence-bearing windows from source text longer than
 * LONG_SOURCE_THRESHOLD chars. Returns snippets sorted in document order.
 * Exported for testing.
 */
export function extractIntelligenceSnippets(text, maxSnippets = 6) {
  if (!text || text.length <= LONG_SOURCE_THRESHOLD) return [];

  const scored = [];
  const scanStart = 3000;  // skip abstract/intro — already sent as prefix
  for (let i = scanStart; i < text.length - SNIPPET_LEN; i += SNIPPET_STEP) {
    const window = text.slice(i, i + SNIPPET_LEN);
    const hits = (window.match(SNIPPET_SIGNAL_RX) || []).length;
    if (hits > 0) scored.push({ text: window, offset: i, hits });
  }

  scored.sort((a, b) => b.hits - a.hits);
  const selected = [];
  for (const s of scored) {
    if (selected.length >= maxSnippets) break;
    const overlaps = selected.some((k) => Math.abs(k.offset - s.offset) < SNIPPET_LEN * 0.7);
    if (!overlaps) selected.push(s);
  }
  return selected.sort((a, b) => a.offset - b.offset);
}

/**
 * Build the source-text block for LLM prompts.
 * Short sources: full text. Long sources: first 3 kB + signal-selected excerpts.
 */
function buildSourceTextBlock(source) {
  const text = (source.clean_text || source.full_text || "").trim();
  if (!text) return "";
  if (text.length <= LONG_SOURCE_THRESHOLD) return `SOURCE TEXT:\n${text}`;
  const prefix = text.slice(0, 3000);
  const snippets = extractIntelligenceSnippets(text);
  const parts = [`SOURCE TEXT (first 3,000 chars):\n${prefix}`];
  if (snippets.length > 0) {
    parts.push("\nADDITIONAL EXCERPTS (selected for AI-threat signal, for verbatim quote grounding):");
    for (const s of snippets) {
      parts.push(`[char ${s.offset}]: ${s.text}`);
    }
  }
  return parts.join("\n\n");
}

// ── Quote evidence basis ───────────────────────────────────────────────────────

/**
 * Classify how strongly a tag's supporting_quote traces back to the source text.
 *   verbatim_quote   — exact (case-normalised) substring match
 *   grounded_snippet — ≥70% content-word overlap (paraphrase/truncation)
 *   weak_inference   — minimal traceability (may be hallucinated)
 * Exported for testing.
 */
export function quoteEvidenceBasis(quote, sourceText) {
  const q = (quote || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (q.length < 12) return "weak_inference";
  const src = (sourceText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!src) return "verbatim_quote";  // nothing to check against — accept optimistically
  if (src.includes(q)) return "verbatim_quote";
  const words = [...new Set(q.split(" ").filter((w) => w.length > 3))];
  if (words.length === 0) return "weak_inference";
  const present = words.filter((w) => src.includes(w)).length;
  return present / words.length >= 0.7 ? "grounded_snippet" : "weak_inference";
}

// ── QA verdict application ─────────────────────────────────────────────────────

/**
 * Apply a Stage 4 QA verdict object to an already-assembled understanding.
 * QA can remove or downgrade tags and sub-techniques; downgrade ai_enabled.
 * Safe to call with a null qaResult (returns understanding unchanged).
 * Exported for testing.
 *
 * @param {object} understanding  — output of assembleOutput()
 * @param {object|null} qaResult  — QA LLM output (validated schema)
 * @returns {object}              — updated understanding
 */
export function applyQaVerdicts(understanding, qaResult) {
  if (!qaResult) return understanding;

  const out = { ...understanding };
  const verdictByTag = new Map((qaResult.tag_verdicts || []).map((v) => [v.tag, v]));

  // Apply primary tag verdicts
  const keptTags = (out.primary_tags || [])
    .filter((t) => verdictByTag.get(t.tag)?.verdict !== "removed")
    .map((t) => {
      const v = verdictByTag.get(t.tag);
      if (!v || v.verdict !== "downgraded") return t;
      return {
        ...t,
        confidence: t.confidence === "high" ? "medium" : "low",
        qa_downgraded: true,
        qa_reason: v.reason || null,
      };
    });

  // Apply sub-technique verdicts (stored per parent tag)
  const removedSubIds = new Set();
  for (const tv of qaResult.tag_verdicts || []) {
    for (const sv of tv.sub_technique_verdicts || []) {
      if (sv.verdict === "removed") removedSubIds.add(sv.id);
    }
  }
  const keptSubs = (out.sub_techniques || []).filter((s) => {
    const id = typeof s === "string" ? s : s?.id;
    return !removedSubIds.has(id);
  });

  // Apply AI-enabled verdict
  let aiEnabled = out.ai_enabled;
  if (qaResult.ai_enabled_verdict === "downgraded_false") {
    aiEnabled = false;
  }

  out.primary_tags       = keptTags;
  out.primary_threat_tags = keptTags;  // back-compat alias
  out.sub_techniques     = keptSubs;
  out.ai_enabled         = aiEnabled;
  out.ai_enabled_roles   = aiEnabled ? out.ai_enabled_roles : [];
  out.ai_capabilities    = aiEnabled ? out.ai_capabilities  : [];
  out.automation_level   = aiEnabled ? out.automation_level : "unknown";
  out.autonomy_level     = aiEnabled ? out.autonomy_level   : "unknown";

  // Re-derive validation status if QA removed all tags
  if (keptTags.length === 0 && out.taxonomy_validation_status === "validated") {
    out.taxonomy_validation_status = "needs_manual_review";
  }

  return out;
}


// ── Stage 1: Understanding + Domain Gate ─────────────────────────────────────

const STAGE1_SCHEMA = {
  type: "object",
  required: [
    "primary_subject", "source_summary", "main_claims",
    "key_entities", "important_numbers",
    "primary_domain", "domain_confidence", "domain_reasoning",
  ],
  properties: {
    primary_subject:   { type: "string" },
    source_summary:    { type: "string" },
    main_claims:       { type: "array",  items: { type: "string" } },
    key_entities:      { type: "array",  items: { type: "string" } },
    important_numbers: { type: "array",  items: { type: "string" } },
    primary_domain:    { type: "string" },
    domain_confidence: { type: "string", enum: ["high", "medium", "low"] },
    domain_reasoning:  { type: "string" },
  },
};

const STAGE1_SYSTEM = `You are a source analyst for an AI-cyber threat intelligence pipeline.

Your job for this source: UNDERSTAND it and decide whether it can be classified into one of four AI-threat domains.

## YOUR FOUR TASKS

1. SUMMARISE (source_summary): 2-3 sentences stating the source's main message. No filler ("This article discusses…"). State what actually happened, was demonstrated, or was published. If the source is too thin to summarise, write "INSUFFICIENT CONTENT".

2. EXTRACT INTELLIGENCE:
   - primary_subject: ≤15 words — the single most important thing this source is about
   - main_claims: 1-5 factual claims the source DIRECTLY STATES (not inferences). If none, return [].
   - key_entities: named orgs, tools, threat groups, CVE IDs, model names, APIs. Max 10. Empty array if none.
   - important_numbers: statistics and measurements in "value: context" form. Max 5. Empty array if none.

3. ASSIGN PRIMARY DOMAIN — pick ONE:
   - "traditional_ai_threats" — the ML model / training data / inference / ML supply chain IS ATTACKED
   - "llm_threats" — LLM-specific (prompt injection, jailbreaks, RAG poisoning, guardrail bypass, system prompt)
   - "agentic_ai_threats" — AI system using tools/MCP/memory/orchestration/workflow IS ATTACKED or ABUSED
   - "ai_enabled_threats" — AI is the ATTACKER's operational tool (deepfakes, AI phishing, AI malware, voice cloning)
   - "unclear_or_adjacent" — AI-security relevant but does not clearly fit any of the four above

4. RATE domain_confidence:
   - "high" — the source is unambiguously in this domain; clear technical evidence
   - "medium" — best fit but the source is ambiguous or covers multiple domains
   - "low" — best guess; evidence is weak or the content is marginal for AI threats

## DOMAIN DISAMBIGUATION RULES
- Standalone LLM with no tool use → llm_threats
- System that calls tools, uses MCP, runs multi-step agents → agentic_ai_threats
- AI poisoning training data (not inference) → traditional_ai_threats
- LLM used as attack automation tool against NON-AI systems → ai_enabled_threats
- Deepfake / voice clone / synthetic media used as weapon → ai_enabled_threats

## CRITICAL RULES
- Do NOT extract opinions, predictions, or background context as main_claims
- Do NOT invent entities or numbers not present in the source text
- Return strict JSON only — no markdown, no preamble`;

function buildStage1UserPrompt(source) {
  const parts = [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}`,
    `DATE: ${source.date_published || "unknown"}`,
  ];
  if (source.validation_summary) {
    parts.push(`\nLAYER 3 SUMMARY (already produced upstream — consider this when summarising):\n${source.validation_summary}`);
  }
  if (source.candidate_domain && DOMAINS.includes(source.candidate_domain)) {
    parts.push(`UPSTREAM DOMAIN HINT (Layer 3): ${source.candidate_domain}`);
  }
  const summary = (source.summary || "").trim();
  if (summary && summary !== source.validation_summary) {
    parts.push(`\nRSS/CONNECTOR SUMMARY:\n${summary.slice(0, 400)}`);
  }
  const textBlock = buildSourceTextBlock(source);
  if (textBlock) parts.push(`\n${textBlock}`);
  return parts.join("\n");
}

async function runStage1(source, llmFn) {
  return llmFn(STAGE1_SYSTEM, buildStage1UserPrompt(source), {
    task:          "source_understanding",
    requires_json: true,
    schema:        STAGE1_SCHEMA,
    logLabel:      `L4-s1-understand-${(source.id || "").slice(0, 16)}`,
  });
}

// ── Stage 2: Primary Tag Assignment (domain-scoped) ──────────────────────────

const STAGE2_SCHEMA = {
  type: "object",
  required: ["primary_tags"],
  properties: {
    primary_tags: {
      type: "array",
      maxItems: 3,
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
    no_tags_reason: { type: "string" },
  },
};

function buildStage2System(domain) {
  const taxonomyContext = buildTaxonomyContextForPrompt(domain);
  return `You are a taxonomy tagger for an AI-cyber threat intelligence pipeline.

A previous stage has already summarised this source and assigned it to the domain: **${domain}**.
Your ONLY job is to assign the PRIMARY THREAT TAGS that this source directly evidences.

## THE TAXONOMY FOR ${domain.toUpperCase()}

${taxonomyContext}

## ASSIGNMENT RULES

1. Use ONLY tag IDs from the taxonomy shown above (e.g. LLM01_prompt_injection, TAI02_model_extraction).
2. Each tag REQUIRES a supporting_quote: COPY-PASTE a phrase or sentence EXACTLY as it appears in
   the SOURCE TEXT section below (minimum 15 characters). Do NOT paraphrase. Do NOT summarize.
   The quote must be findable by text search in the source.
   Prefer short, specific phrases (15-80 chars) over long sentences.
   If you cannot find a direct verbatim phrase for a tag, do NOT assign it.
3. Max 3 primary tags. Return primary_tags: [] if no tag is clearly evidenced.
4. confidence levels:
   - "high": tag is the main subject; source explicitly names the technique or attack
   - "medium": tag is clearly relevant but source treats it as context or secondary
   - "low": weak evidence; tag is inferred rather than explicit

## DOMAIN RULES — only assign tags from ${domain}
Do NOT assign tags from other domains. If the source belongs to a different domain than stated,
return primary_tags: [] and explain in no_tags_reason.

Return strict JSON only — no markdown, no preamble.`;
}

function buildStage2UserPrompt(source, stage1) {
  const parts = [
    `SOURCE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}`,
    ``,
    `STAGE 1 SUMMARY: ${stage1.source_summary || ""}`,
    `MAIN CLAIMS:`,
    ...(stage1.main_claims || []).map((c, i) => `  ${i + 1}. ${c}`),
    ``,
  ];
  // Include key_entities + important_numbers — both help identify relevant quote regions
  // even when technique-specific phrasing doesn't appear in the main_claims.
  const entities = (stage1.key_entities || []).slice(0, 8);
  if (entities.length > 0) parts.push(`KEY ENTITIES: ${entities.join(", ")}`);
  const numbers = (stage1.important_numbers || []).slice(0, 4);
  if (numbers.length > 0) parts.push(`KEY MEASUREMENTS: ${numbers.join("; ")}`);

  const textBlock = buildSourceTextBlock(source);
  if (textBlock) parts.push(`\n${textBlock} (use verbatim text from SOURCE TEXT or ADDITIONAL EXCERPTS for supporting_quote)`);
  return parts.join("\n");
}

async function runStage2(source, stage1, llmFn) {
  return llmFn(
    buildStage2System(stage1.primary_domain),
    buildStage2UserPrompt(source, stage1),
    {
      task:          "source_understanding",
      requires_json: true,
      schema:        STAGE2_SCHEMA,
      logLabel:      `L4-s2-tagging-${(source.id || "").slice(0, 16)}`,
    }
  );
}

// ── Stage 3: Sub-technique + AI-enabled Overlay ──────────────────────────────

const STAGE3_SCHEMA = {
  type: "object",
  required: ["sub_techniques", "ai_enabled", "ai_enabled_roles", "ai_capabilities", "automation_level", "autonomy_level"],
  properties: {
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
    ai_enabled:       { type: "boolean" },
    ai_enabled_roles: { type: "array", items: { type: "string" } },
    ai_capabilities:  {
      type: "array",
      items: {
        type: "string",
        enum: [
          "synthetic_text_generation", "synthetic_image_generation",
          "synthetic_audio_generation", "synthetic_video_generation",
          "code_generation", "automation", "autonomous_planning",
          "reconnaissance_automation", "vulnerability_analysis",
          "natural_language_understanding", "multimodal_processing",
          "adversarial_optimization",
        ],
      },
    },
    automation_level: {
      type: "string",
      enum: ["human_assisted", "semi_autonomous", "autonomous", "unknown"],
    },
    autonomy_level: {
      type: "string",
      enum: ["human_assisted", "semi_autonomous", "autonomous", "multi_agent", "unknown"],
    },
  },
};

function buildStage3System(primaryTags) {
  const tagIds = primaryTags.map((t) => t.tag).join(", ");

  // Build sub-technique reference only for the selected tags
  const subTechLines = primaryTags.flatMap((t) => {
    const subs = getSubTechniques ? getSubTechniques(t.tag) : [];
    if (!subs?.length) return [];
    return [`  ${t.tag}: ${subs.map((s) => s.id || s).join(", ")}`];
  });
  const subTechRef = subTechLines.length
    ? `## SUB-TECHNIQUES AVAILABLE FOR YOUR PRIMARY TAGS\n${subTechLines.join("\n")}`
    : "## SUB-TECHNIQUES\nNone available for the selected tags.";

  return `You are completing taxonomy enrichment for an AI-cyber threat source.
Primary tags already assigned: ${tagIds}

## YOUR TWO TASKS

### TASK A — SUB-TECHNIQUES
${subTechRef}

Assign sub-techniques ONLY when:
- The source explicitly describes the sub-technique (verbatim quote required)
- The sub-technique ID is in the list above for the correct parent_tag
- You have a verbatim supporting_quote from the source text

Return sub_techniques: [] if no sub-technique is clearly evidenced.

### TASK B — AI-ENABLED OVERLAY
This overlay captures whether AI materially ENHANCES the attack described.
It applies even when the primary domain is NOT ai_enabled_threats.

ai_enabled (boolean):
  TRUE only when AI materially enhances the attack (speeds it up, improves success rate,
  makes it scalable, or enables a new capability). The enhancement must be explicit in the source.
  FALSE for: sources where AI is the TARGET, not the tool; sources where AI is mentioned
  only in passing; research about AI systems being attacked.

ai_enabled_roles (when ai_enabled=true):
  Use AE01–AE10 codes ONLY for the specific AI role in the attack:
  AE01=deepfake_generation, AE02=spear_phishing_automation, AE03=code_generation_for_malware,
  AE04=reconnaissance_automation, AE05=social_engineering_at_scale, AE06=ai_assisted_exploitation,
  AE07=vulnerability_discovery, AE08=attack_planning_automation, AE09=disinformation_at_scale,
  AE10=identity_synthesis

ai_capabilities: which AI capabilities are used (from the allowed list)
automation_level: how automated is the described attack/process
autonomy_level: how autonomous is the system described

## RULES
- Every sub-technique requires a verbatim supporting_quote
- ai_enabled roles must match what the source actually describes — do not infer
- Return strict JSON only — no markdown, no preamble`;
}

function buildStage3UserPrompt(source, stage1, stage2) {
  const parts = [
    `SOURCE: ${source.title || "(no title)"}`,
    `SUMMARY: ${stage1.source_summary || ""}`,
    ``,
    `ASSIGNED PRIMARY TAGS:`,
    ...(stage2.primary_tags || []).map((t) => `  ${t.tag}: "${t.supporting_quote?.slice(0, 120)}"`),
    ``,
  ];
  // Include key_entities so Stage 3 can ground AI-enabled roles and autonomy signals
  const entities = (stage1.key_entities || []).slice(0, 8);
  if (entities.length > 0) parts.push(`KEY ENTITIES: ${entities.join(", ")}`);
  // Include main_claims so Stage 3 doesn't need to re-read the full text for context
  const claims = (stage1.main_claims || []).slice(0, 4);
  if (claims.length > 0) {
    parts.push(`MAIN CLAIMS:`);
    claims.forEach((c, i) => parts.push(`  ${i + 1}. ${c}`));
  }

  const textBlock = buildSourceTextBlock(source);
  if (textBlock) parts.push(`\n${textBlock}`);
  return parts.join("\n");
}

async function runStage3(source, stage1, stage2, llmFn) {
  const primaryTags = stage2.primary_tags || [];
  return llmFn(
    buildStage3System(primaryTags),
    buildStage3UserPrompt(source, stage1, stage2),
    {
      task:          "source_understanding",
      requires_json: true,
      schema:        STAGE3_SCHEMA,
      logLabel:      `L4-s3-subtags-${(source.id || "").slice(0, 16)}`,
    }
  );
}

// ── Stage 4 (QA): Cross-provider taxonomy verifier ────────────────────────────

const STAGE_QA_SCHEMA = {
  type: "object",
  required: ["domain_supported", "tag_verdicts", "overall_confidence"],
  properties: {
    domain_supported: { type: "boolean" },
    tag_verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["tag", "verdict"],
        properties: {
          tag:     { type: "string" },
          verdict: { type: "string", enum: ["confirmed", "downgraded", "removed"] },
          reason:  { type: "string" },
          sub_technique_verdicts: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "verdict"],
              properties: {
                id:      { type: "string" },
                verdict: { type: "string", enum: ["confirmed", "removed"] },
                reason:  { type: "string" },
              },
            },
          },
        },
      },
    },
    ai_enabled_verdict: { type: "string", enum: ["confirmed", "downgraded_false", "not_reviewed"] },
    overall_confidence: { type: "integer", minimum: 0, maximum: 100 },
    qa_note: { type: "string" },
  },
};

const STAGE_QA_SYSTEM = `You are an ADVERSARIAL taxonomy QA verifier for an AI-cyber threat intelligence pipeline.
A previous model assigned threat taxonomy tags. Your job is to CHALLENGE and VERIFY each assignment.

## DEFAULT STANCE: SKEPTICAL
Assume each tag is WRONG until you find clear evidence it is right.
Only mark "confirmed" when you can point to a specific sentence that unambiguously describes the technique.
When uncertain between "confirmed" and "downgraded", choose "downgraded".
When uncertain between "downgraded" and "removed", choose "removed".

## YOUR FOUR CHECKS (per tag):
1. Domain: does the source text explicitly describe a threat in this domain — not mention it in passing?
2. Quote: does the supporting_quote appear verbatim or near-verbatim in the provided text?
   A quote that you cannot locate in the text must cause verdict="removed".
3. Sub-techniques: is the sub-technique EXPLICITLY described in the source? Background mentions → remove.
4. AI-enabled: is AI's role as the ATTACKER'S TOOL stated explicitly? Phrases like "AI could be used"
   or "AI-powered" without a concrete mechanism are NOT sufficient — downgrade to false.

## VERDICTS:
- "confirmed": strong, specific, traceable evidence. The source clearly describes the technique.
- "downgraded": weak evidence — quote is a near-paraphrase, or technique is mentioned only in passing.
- "removed": evidence absent, fabricated, in a negating context, or from a different domain.

## NEGATING CONTEXTS — always remove:
- "X does NOT occur in this setting"
- "unlike X, our approach avoids..."
- "we defended against X"
- "to prevent X" (describing defense, not an attack)

## AI-ENABLED RULES:
- ai_enabled=true requires an EXPLICIT offensive role (AE01–AE10 codes correspond to real techniques).
- Source describes AI being ATTACKED → downgraded_false (AI is target, not attacker tool).
- Source describes AI AUTOMATING a human offensive action → may be confirmed with the right role code.
- Vague phrases without a named mechanism → downgraded_false.

## SCORING:
overall_confidence starts at 50 (reflecting adversarial default skepticism).
+20 per confirmed tag (max 3 tags). −20 per removed tag. −10 per downgraded tag.
+10 if all sub-techniques confirmed. −10 if any sub-technique removed.
Final range: 0–100. Do not round — return an integer.

Return strict JSON only — no markdown, no preamble.`;

function buildStageQaUserPrompt(source, understanding) {
  const tags = (understanding.primary_tags || []).map((t) =>
    `  - ${t.tag} (${t.confidence}): "${(t.supporting_quote || "").slice(0, 150)}"` +
    (t.evidence_basis ? ` [basis: ${t.evidence_basis}]` : "")
  ).join("\n");

  const subs = (understanding.sub_techniques || []).map((s) => {
    const id = typeof s === "string" ? s : s?.id;
    const parent = typeof s === "object" ? s.parent_tag : null;
    const quote  = typeof s === "object" ? s.supporting_quote || "" : "";
    return `  - ${id} (parent: ${parent}): "${quote.slice(0, 100)}"`;
  }).join("\n") || "  (none)";

  const aiEnabled = understanding.ai_enabled;
  const aiRoles   = (understanding.ai_enabled_roles || []).join(", ");

  return [
    `DOMAIN ASSIGNED: ${understanding.primary_domain || "(none)"}`,
    ``,
    `ASSIGNED PRIMARY TAGS:`,
    tags || "  (none)",
    ``,
    `SUB-TECHNIQUES:`,
    subs,
    ``,
    `AI-ENABLED: ${aiEnabled} — roles: ${aiRoles || "(none)"}`,
    ``,
    buildSourceTextBlock(source),
  ].join("\n");
}

async function runStageQa(source, understanding, llmFn) {
  return llmFn(
    STAGE_QA_SYSTEM,
    buildStageQaUserPrompt(source, understanding),
    {
      task:          "taxonomy_qa",
      requires_json: true,
      schema:        STAGE_QA_SCHEMA,
      logLabel:      `L4-qa-${(source.id || "").slice(0, 16)}`,
    }
  );
}

function deriveCategoryCandidates(domain, primaryTags) {
  if (!domain || domain === "unclear_or_adjacent") return [];
  const dominated = CLASSIFIABLE_CATEGORIES.includes(domain) ? domain : null;
  if (!dominated) return [];

  const candidate = {
    category:        dominated,
    supporting_tags: primaryTags.map((t) => t.tag).filter(Boolean),
    confidence:      primaryTags.some((t) => t.confidence === "high") ? "high"
                   : primaryTags.some((t) => t.confidence === "medium") ? "medium"
                   : "low",
    reason:          `Stage 1 domain assignment: ${domain}`,
  };
  return [candidate];
}

// ── Deterministic fallback (skipLlm or all stages fail) ──────────────────────

function guessDomainFromKeywords(source) {
  const text = `${source.title || ""} ${source.summary || ""} ${source.full_text || ""}`.toLowerCase();
  if (text.includes("agentic") || text.includes(" mcp ") || text.includes("model context protocol") ||
      text.includes("langchain") || text.includes("autogpt") || text.includes("autonomous agent") ||
      text.includes("multi-agent") || text.includes("tool hijack") || text.includes("tool poisoning") ||
      text.includes("coding agent") || text.includes("orchestration"))
    return "agentic_ai_threats";
  if (text.includes("adversarial ml") || text.includes("model extract") || text.includes("data poison") ||
      text.includes("training data poison") || text.includes("evasion attack") ||
      text.includes("backdoor attack") || text.includes("adversarial example") ||
      text.includes("model inversion") || text.includes("membership inference"))
    return "traditional_ai_threats";
  if (text.includes("deepfake") || text.includes("voice cloning") || text.includes("synthetic media") ||
      text.includes("ai-powered phishing") || text.includes("ai-enabled phishing") ||
      text.includes("ai malware") || text.includes("ai-generated malware") ||
      text.includes("ai attack automation") || text.includes("synthetic identity"))
    return "ai_enabled_threats";
  if (text.includes("prompt injection") || text.includes("jailbreak") ||
      text.includes("rag poison") || text.includes("guardrail") ||
      text.includes("llm vulnerability") || text.includes("large language model") ||
      text.includes("system prompt") || text.includes("embedding attack"))
    return "llm_threats";
  return "unclear_or_adjacent";
}

// Detect a better domain when Stage 2 found no tags because Stage 1 mis-assigned
// the domain. Prefer a domain named in the LLM's no_tags_reason; else fall back to
// a keyword guess that differs from the current (wrong) domain. Returns null when
// there is no clearly-better alternative (so we discard as no_tags_found).
function detectAlternateDomain(currentDomain, noTagsReason, source) {
  const reason = (noTagsReason || "").toLowerCase();
  for (const d of DOMAINS) {
    if (d === currentDomain || d === "unclear_or_adjacent") continue;
    if (reason.includes(d) || reason.includes(d.replace(/_/g, " "))) return d;
  }
  const guess = guessDomainFromKeywords(source);
  if (guess !== "unclear_or_adjacent" && guess !== currentDomain) return guess;
  return null;
}

function deterministicFallback(source, detType) {
  const domain = DOMAINS.includes(source.candidate_domain)
    ? source.candidate_domain
    : guessDomainFromKeywords(source);
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type : null;
  const candidates = domain !== "unclear_or_adjacent"
    ? [{ category: domain, supporting_tags: [], confidence: "low", reason: "keyword fallback — LLM unavailable" }]
    : [];

  return {
    source_type:            layer3Type || detType.type,
    source_type_confidence: layer3Type ? "medium" : detType.confidence,
    source_type_reason:     layer3Type ? "Layer 3 validation" : `deterministic (${detType.method}) — LLM unavailable`,
    source_summary:         source.validation_summary || `${source.title || ""}. Published by ${source.publisher || "unknown"}.`,
    primary_subject:        (source.title || "").slice(0, 80),
    main_claims:            [],
    key_entities:           [source.publisher].filter(Boolean),
    important_numbers:      [],
    primary_domain:         domain,
    domain_confidence:      "low",
    primary_tags:           [],
    primary_threat_tags:    [],
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
    taxonomy_stage_results: { stage1: "skipped_no_llm", stage2: "skipped", stage3: "skipped" },
    llm_used:               false,
  };
}

// ── Output assembly + validation ──────────────────────────────────────────────

// Back-compat boolean wrapper around the exported quoteEvidenceBasis.
function quoteGroundedInSource(quote, sourceText) {
  return quoteEvidenceBasis(quote, sourceText) !== "weak_inference";
}

function overallStatus(validatedTags) {
  if (validatedTags.some((t) => t.validation_status === "validated")) return "validated";
  if (validatedTags.some((t) => t.validation_status === "weak")) return "weak";
  if (validatedTags.length) return "needs_manual_review";
  return "needs_manual_review";
}

function assembleOutput(source, stage1, stage2, stage3, detType, stageResults) {
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type : null;

  // Validate + cap primary tags through the existing taxonomy validation machinery
  const proposedTags = stage2?.primary_tags || [];
  const taxonomy_evidence = proposedTags
    .filter((t) => t?.tag)
    .map((t) => ({ tag: t.tag, supporting_quote: t.supporting_quote || "", reason: t.reason || "", confidence: t.confidence || "medium" }))
    .slice(0, 6);

  const { all: validated } = validateThreatTags(proposedTags, source);
  const passedValidation = validated.filter((r) => r.validation_status !== "rejected").slice(0, 4);
  const confByTag = new Map(proposedTags.filter((t) => t?.tag).map((t) => [t.tag, t.confidence || "medium"]));
  const sourceText = source.clean_text || source.full_text || "";
  const keptTags = passedValidation
    .map((r) => {
      const proposed = proposedTags.find((x) => x.tag === r.tag) || {};
      const sqRaw = proposed.supporting_quote || "";
      const evidence_basis = quoteEvidenceBasis(sqRaw, sourceText);
      return {
        ...r,
        supporting_quote:     sqRaw,
        reason:               proposed.reason || "",
        evidence_basis,
        // grounded_snippet uses token overlap, not entailment. Flag for Layer 5 QA
        // so the quote's relationship to the claim is verified before downstream use.
        requires_entailment_qa: evidence_basis === "grounded_snippet",
      };
    })
    // 4.4 — low-confidence tags are NOT load-bearing primary tags. They stay in
    // taxonomy_evidence (audit) but must not feed category assignment or analytics.
    .filter((t) => confByTag.get(t.tag) !== "low")
    // 4.3 — the tag's evidence_basis must not be weak_inference. weak_inference means
    // the supporting_quote cannot be traced to the source text at all.
    .filter((t) => t.evidence_basis !== "weak_inference");

  // Validate sub-techniques
  const selectedPrimaryIds = new Set(keptTags.map((t) => t.tag));
  const rawSubs = stage3?.sub_techniques || [];
  const keptSubs = rawSubs
    .filter((s) => {
      const id = typeof s === "string" ? s : s?.id;
      if (!id) return false;
      const parentTag = typeof s === "object" ? s.parent_tag : null;
      if (parentTag && !selectedPrimaryIds.has(parentTag)) return false;
      return true;
    })
    .slice(0, 12);

  // AI-enabled overlay validation
  const aiOverlay = validateAiEnabledOverlay({
    ai_enabled:       stage3?.ai_enabled === true,
    ai_enabled_roles: Array.isArray(stage3?.ai_enabled_roles) ? stage3.ai_enabled_roles : [],
    ai_capabilities:  Array.isArray(stage3?.ai_capabilities)  ? stage3.ai_capabilities  : [],
    automation_level: stage3?.automation_level,
    autonomy_level:   stage3?.autonomy_level,
  });

  const primary_domain = DOMAINS.includes(stage1?.primary_domain) ? stage1.primary_domain : "unclear_or_adjacent";
  const category_candidates = deriveCategoryCandidates(primary_domain, keptTags);

  // Sources that cannot be mapped to any taxonomy domain or tag are discarded.
  const taxonomy_validation_status = stageResults.stopped_at === "no_domain_match" ? "no_domain_match"
    : stageResults.stopped_at === "no_tags_found" ? "no_tags_found"
    : overallStatus(keptTags);

  return {
    source_type:            layer3Type || detType.type,
    source_type_confidence: layer3Type ? "medium" : detType.confidence,
    source_type_reason:     layer3Type ? "Layer 3 validation" : `deterministic (${detType.method})`,
    source_summary:         source.validation_summary || stage1?.source_summary || `${source.title || ""}. Published by ${source.publisher || "unknown"}.`,
    primary_subject:        stage1?.primary_subject || (source.title || "").slice(0, 80),
    main_claims:            (stage1?.main_claims || []).slice(0, 5),
    key_entities:           (stage1?.key_entities || []).slice(0, 10),
    important_numbers:      (stage1?.important_numbers || []).slice(0, 5),
    primary_domain,
    domain_confidence:      stage1?.domain_confidence || "low",
    primary_tags:           keptTags,
    primary_threat_tags:    keptTags,  // back-compat alias
    sub_techniques:         keptSubs,
    ai_enabled:             aiOverlay.ai_enabled,
    ai_enabled_roles:       aiOverlay.ai_enabled_roles,
    ai_capabilities:        aiOverlay.ai_capabilities,
    automation_level:       aiOverlay.automation_level,
    autonomy_level:         aiOverlay.autonomy_level,
    taxonomy_evidence,
    taxonomy_validation_status,
    taxonomy_version:       TAXONOMY_VERSION,
    category_candidates,
    taxonomy_stage_results: stageResults,
    llm_used:               true,
  };
}

// ── Provider check ────────────────────────────────────────────────────────────

function hasAnyProvider() {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2 ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2 ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );
}

// Wrap routedLLM: returns the parsed JSON result object, or null on failure.
// routedLLM returns { result, llm_metadata }; with requires_json=true, result is
// already a parsed object when the provider supports structured output.
async function llmCall(systemPrompt, userPrompt, opts) {
  const out = await routedLLM(systemPrompt, userPrompt, opts);
  if (!out || !out.result) return null;
  if (typeof out.result === "string") {
    try { return JSON.parse(out.result); } catch { return null; }
  }
  return out.result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich a single source through the taxonomy chain (Stages 1–3 + optional QA).
 *
 * @param {object}  source
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @param {boolean} [opts.skipQa=false]   — skip Stage 4 QA (useful in tests or budget-constrained runs)
 * @returns {Promise<object>} Source with `understanding`, `primary_domain`, `primary_tags`, etc.
 */
export async function understandSource(source, opts = {}) {
  const { skipLlm = false, skipQa = false } = opts;

  // Idempotency: already processed at the current taxonomy version
  if (source.taxonomy_version === TAXONOMY_VERSION) return source;

  // ── arXiv full-text enrichment ────────────────────────────────────────────
  // Sources ingested via the backfill script may only have the abstract (~1400
  // chars) stored as full_text. The taxonomy tag assignment (Stage 2) requires a
  // verbatim supporting_quote from the source text, which is nearly impossible
  // from a short abstract for technique-specific tags. Fetching the full HTML
  // paper body (15 kB) before taxonomy dramatically increases tag yield.
  //
  // Only runs when: publisher is arXiv AND text is short AND LLM is enabled
  // (no point fetching in deterministic/skipLlm mode — no tags will be assigned).
  const rawText = source.full_text || source.clean_text || "";
  if (!skipLlm && source.publisher === "arXiv" && rawText.length < 3000) {
    try {
      const { arxivIdFrom, fetchFullPaperText } = await import("../ingest/connectors/arxivConnector.js");
      const arxivId = arxivIdFrom(source.url || "");
      if (arxivId) {
        const fullText = await fetchFullPaperText(arxivId);
        if (fullText && fullText.length > rawText.length + 500) {
          source = {
            ...source,
            full_text:   fullText,
            clean_text:  fullText,
            text_source: "arxiv_html_paper_lazy",
          };
          process.stdout.write(
            `  [L4-arxiv-fulltext] ${source.id?.slice(0,8)} — enriched from ${rawText.length} → ${fullText.length} chars\n`
          );
        }
      }
    } catch { /* non-fatal — continue with abstract */ }
  }

  const detType = classifySourceType(source);

  if (skipLlm || !hasAnyProvider()) {
    const fallback = deterministicFallback(source, detType);
    return applyUnderstanding(source, fallback);
  }

  const stageResults = { stage1: "pending", stage2: "pending", stage3: "pending", qa: "not_run", stopped_at: null };

  // ── Stage 1 ───────────────────────────────────────────────────────────────
  let stage1 = null;
  try {
    stage1 = await runStage1(source, llmCall);
    stageResults.stage1 = "completed";
  } catch (err) {
    process.stdout.write(`  [L4-s1] "${(source.title || "").slice(0, 55)}" Stage 1 failed: ${err.message}\n`);
    stageResults.stage1 = `failed: ${err.message}`;
  }

  if (!stage1) {
    // Stage 1 completely failed — use deterministic fallback
    const fallback = deterministicFallback(source, detType);
    return applyUnderstanding(source, { ...fallback, taxonomy_stage_results: stageResults });
  }

  // Stage 1 Gate: if domain = unclear_or_adjacent AND confidence = low → discard
  const domain = stage1.primary_domain;
  const conf   = stage1.domain_confidence;
  if (domain === "unclear_or_adjacent" && conf === "low") {
    process.stdout.write(
      `  [L4-s1] "${(source.title || "").slice(0, 55)}" → no_domain_match (unclear + low confidence) — discarded from taxonomy\n`
    );
    stageResults.stopped_at = "no_domain_match";
    stageResults.stage2 = "skipped_no_domain";
    stageResults.stage3 = "skipped_no_domain";
    const partial = assembleOutput(source, stage1, null, null, detType, stageResults);
    return applyUnderstanding(source, partial);
  }

  // ── Stage 2 ───────────────────────────────────────────────────────────────
  let stage2 = null;
  try {
    stage2 = await runStage2(source, stage1, llmCall);
    stageResults.stage2 = "completed";
  } catch (err) {
    process.stdout.write(`  [L4-s2] "${(source.title || "").slice(0, 55)}" Stage 2 failed: ${err.message}\n`);
    stageResults.stage2 = `failed: ${err.message}`;
  }

  if (!stage2) {
    const partial = assembleOutput(source, stage1, null, null, detType, stageResults);
    return applyUnderstanding(source, partial);
  }

  // Stage 2 Gate: if no tags with confidence >= medium, attempt ONE domain
  // re-route before discarding. A wrong Stage-1 domain otherwise loses a
  // correctly-relevant source (Stage 2 only ever sees one domain's tags).
  let usableTags = (stage2.primary_tags || []).filter(
    (t) => t.confidence === "high" || t.confidence === "medium"
  );
  if (usableTags.length === 0) {
    const altDomain = detectAlternateDomain(stage1.primary_domain, stage2.no_tags_reason, source);
    if (altDomain) {
      let stage2Alt = null;
      try {
        stage2Alt = await runStage2(source, { ...stage1, primary_domain: altDomain }, llmCall);
      } catch (_err) { /* keep the original no-tags outcome */ }
      const altUsable = (stage2Alt?.primary_tags || []).filter(
        (t) => t.confidence === "high" || t.confidence === "medium"
      );
      if (altUsable.length > 0) {
        process.stdout.write(
          `  [L4-s2] "${(source.title || "").slice(0, 55)}" → re-routed ${stage1.primary_domain}→${altDomain}\n`
        );
        stage1 = { ...stage1, primary_domain: altDomain };
        stage2 = stage2Alt;
        usableTags = altUsable;
        stageResults.stage2 = `completed_reroute:${altDomain}`;
      }
    }
  }
  if (usableTags.length === 0) {
    const allTags = stage2.primary_tags || [];
    const reason = stage2.no_tags_reason || `0 tags with confidence ≥ medium (${allTags.length} low-confidence tags dropped)`;
    process.stdout.write(
      `  [L4-s2] "${(source.title || "").slice(0, 55)}" → no_tags_found: ${reason}\n`
    );
    stageResults.stopped_at = "no_tags_found";
    stageResults.stage3 = "skipped_no_tags";
    // Keep the low-confidence tags in stage2 for assembly (they become weak)
    const partial = assembleOutput(source, stage1, stage2, null, detType, stageResults);
    return applyUnderstanding(source, partial);
  }

  // ── Stage 3 ───────────────────────────────────────────────────────────────
  let stage3 = null;
  try {
    stage3 = await runStage3(source, stage1, stage2, llmCall);
    stageResults.stage3 = "completed";
  } catch (err) {
    process.stdout.write(`  [L4-s3] "${(source.title || "").slice(0, 55)}" Stage 3 failed: ${err.message}\n`);
    stageResults.stage3 = `failed: ${err.message}`;
  }

  // Assemble output from Stages 1–3
  let understanding = assembleOutput(source, stage1, stage2, stage3, detType, stageResults);

  // ── Stage 4 (QA): cross-provider taxonomy verification ────────────────────
  // Only run when there are actual tags to verify (skip for no_domain_match
  // and no_tags_found — those have no tags to QA).
  const hasTagsToQa = (understanding.primary_tags || []).length > 0;
  const runQaStage  = !skipQa && hasTagsToQa;

  if (runQaStage) {
    let qaResult = null;
    try {
      qaResult = await runStageQa(source, understanding, llmCall);
      stageResults.qa = "completed";
      stageResults.qa_result = {
        overall_confidence: qaResult?.overall_confidence ?? null,
        tags_removed: (qaResult?.tag_verdicts || []).filter((v) => v.verdict === "removed").map((v) => v.tag),
        tags_downgraded: (qaResult?.tag_verdicts || []).filter((v) => v.verdict === "downgraded").map((v) => v.tag),
        ai_enabled_verdict: qaResult?.ai_enabled_verdict || "not_reviewed",
        domain_supported: qaResult?.domain_supported ?? true,
      };
    } catch (err) {
      process.stdout.write(`  [L4-qa] "${(source.title || "").slice(0, 55)}" QA failed: ${err.message}\n`);
      stageResults.qa = `failed: ${err.message}`;
    }
    understanding = applyQaVerdicts(understanding, qaResult);
    understanding.taxonomy_stage_results = stageResults;
  }

  return applyUnderstanding(source, understanding);
}

// ── Apply understanding fields to the source object ──────────────────────────

function applyUnderstanding(source, understanding) {
  const layer3Type = ALL_SOURCE_TYPES.includes(source.source_type) && source.source_type !== "unknown"
    ? source.source_type : null;
  const resolvedSourceType = layer3Type || understanding.source_type || source.source_type || "unknown";
  const resolvedSummary = source.validation_summary || understanding.source_summary ||
    `${source.title || ""}. Published by ${source.publisher || "unknown"}.`;

  return {
    ...source,
    source_type:      resolvedSourceType,
    primary_domain:   understanding.primary_domain,
    taxonomy_version: TAXONOMY_VERSION,
    primary_tags:     understanding.primary_tags || [],
    sub_techniques:   understanding.sub_techniques || [],
    ai_enabled:       understanding.ai_enabled || false,
    ai_enabled_roles: understanding.ai_enabled_roles || [],
    ai_capabilities:  understanding.ai_capabilities || [],
    automation_level: understanding.automation_level || "unknown",
    autonomy_level:   understanding.autonomy_level || "unknown",
    taxonomy_validation_status:  understanding.taxonomy_validation_status || "needs_manual_review",
    understanding: {
      ...understanding,
      source_type:    resolvedSourceType,
      source_summary: resolvedSummary,
    },
  };
}
