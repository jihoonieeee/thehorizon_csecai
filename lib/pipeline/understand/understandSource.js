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
import { classifySourceType }  from "../classify/classifySourceType.js";
import { ALL_SOURCE_TYPES }    from "../../config/sourceTypes.js";
import { CLASSIFIABLE_CATEGORIES } from "../../config/categories.js";
import { DOMAINS, getTag, buildTaxonomyContextForPrompt } from "../../config/taxonomyRegistry.js";
import { validateThreatTags, validateSecondaryDimensions } from "../../config/taxonomyValidation.js";

export const TAXONOMY_VERSION = "taxonomy-2026-06";

// Back-compat alias: the runner and store still import UNDERSTAND_VERSION
export const UNDERSTAND_VERSION = TAXONOMY_VERSION;

// ── Structured output schema ──────────────────────────────────────────────────

const TAXONOMY_SCHEMA = {
  type: "object",
  required: [
    "source_type", "source_type_confidence", "source_type_reason",
    "source_summary", "primary_subject", "main_claims",
    "key_entities", "important_numbers",
    "primary_domain", "primary_threat_tags", "secondary_dimensions",
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
    primary_threat_tags: {
      type: "array",
      items: {
        type: "object",
        required: ["tag", "domain", "supporting_quote", "confidence"],
        properties: {
          tag:                        { type: "string" },
          domain:                     { type: "string" },
          supporting_quote:           { type: "string" },
          reason:                     { type: "string" },
          confidence:                 { type: "string", enum: ["high", "medium", "low"] },
          // AI-enabled threats only — the paired operational mapping:
          operational_attack_mapping: { type: "string" },
          ai_capability_modifier:     { type: "string" },
        },
      },
    },
    secondary_dimensions: { type: "array", items: { type: "string" } },
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

function buildSystemPrompt() {
  const taxonomyContext = buildTaxonomyContextForPrompt();

  return `You are enriching a source for an AI-cyber horizon scan using the Validated AI Threat Taxonomy (June 2026).

Your task: understand what this source is actually about, then assign the most precise PRIMARY THREAT TAGS that the evidence directly supports.

## CORE PRINCIPLE
Fewer, higher-confidence tags are always better than many uncertain ones.
1–2 well-evidenced tags beat 6–8 speculative ones. If unsure, return an empty array.

## THE TAXONOMY (four domains, primary threat tags only)

${taxonomyContext}

## STEP 1 — UNDERSTAND THE SOURCE
- source_summary: 2–3 analyst-grade sentences. What happened, the AI-security significance, who is affected.
- primary_subject: ≤15 words.
- main_claims: 2–5 factual statements the source directly supports.
- key_entities: named orgs, tools, threat groups, CVEs, model names, APIs. Max 10.
- important_numbers: "value: context". Max 5. Empty if none.

## STEP 2 — ASSIGN SOURCE TYPE
Choose exactly one from:
- vulnerability, exploit_disclosure, incident, threat_intelligence, research_finding,
  defensive_capability, benchmark_evaluation, capability_demonstration,
  adversary_adoption_signal, infrastructure_dependency_signal, trust_boundary_shift,
  societal_harm_signal, governance_signal, ecosystem_signal, strategic_signal, unknown

Source type disambiguation:
- vulnerability vs exploit_disclosure: vulnerability = flaw described (may/may not be exploited); exploit_disclosure = working exploit or PoC exists/released
- incident vs threat_intelligence: incident = specific confirmed attack event; threat_intelligence = TTP/campaign report about observed adversary behaviour (may not describe one specific incident)
- research_finding vs capability_demonstration: research_finding = academic/research paper showing a method or analysis; capability_demonstration = demonstrates that an attack IS NOW POSSIBLE with a built system (e.g. "we built X and it successfully did Y")
- research_finding vs benchmark_evaluation: benchmark = measures AI model capability or safety with quantitative results (ASR, scores, rankings); research = proposes/analyses but not primarily a measurement
- adversary_adoption_signal vs incident: adoption_signal = threat actors STARTING TO USE an AI technique (early warning); incident = they already used it in a specific attack
- trust_boundary_shift vs ecosystem_signal: trust_shift = a change in WHAT IS TRUSTED or what has authority; ecosystem = a change in INFRASTRUCTURE, tooling, or market adoption
- societal_harm_signal vs incident: societal_harm = AI-enabled harm at population/trust-system scale (deepfake fraud campaigns, disinformation); incident = specific targeted attack on an org/system

## STEP 3 — PRIMARY DOMAIN
Pick the single best domain for this source:
- traditional_ai_threats — the ML model / training data / inference / ML supply chain is attacked
- llm_threats — LLM-specific (prompts, guardrails, context, RAG, embeddings, system prompt)
- agentic_ai_threats — the AI system acts through memory, tools, MCP, runtime, credentials, workflow, orchestration, comms, or autonomy
- ai_enabled_threats — AI is the attacker's TOOL (materially changes capability)
- unclear_or_adjacent — none of the above clearly applies

## STEP 4 — PRIMARY THREAT TAGS (primary_threat_tags)
Assignment rules — ALL mandatory:
1. Use ONLY tags listed in the taxonomy above, from the domain you assigned in STEP 3.
2. Each tag MUST include supporting_quote: a specific sentence or phrase copied from the SOURCE TEXT below that directly describes the threat behaviour. Minimum 20 characters.
3. Never tag based on keyword appearance, passing mentions, lists, or background context.
4. Never assign a SECONDARY DIMENSION (misinformation, overreliance, excessive_agency, resource_overload, cascading_hallucination) as a primary threat — use secondary_dimensions for those.
5. Domain do-not rules:
   - ai_enabled: only when AI materially changes attacker capability AND you supply a real ATT&CK technique (e.g. T1566, T1059) as operational_attack_mapping PLUS the AI modifier. Never T1588.007 alone, never "required per case".
   - agentic: only when the system acts through tools / MCP / memory / workflow / orchestration / credentials / autonomy.
   - llm: only with LLM-specific evidence (prompts, guardrails, context window, RAG, embeddings, system prompt).
   - traditional: only when the ML model / training data / inference / supply chain is the specific attack target.
6. Max 4 primary threat tags. Return [] if none clearly applies — empty is always correct.

### Tag disambiguation (frequently confused):

llm_threats vs agentic_ai_threats:
  Standalone chatbot / API with no tool use → llm_threats.
  System that uses tools, MCP, memory, or autonomous multi-step chains → agentic_ai_threats.
  Prompt injection in an agent that calls a tool → agent_prompt_injection [AGENTIC].
  Jailbreak of a chatbot with no tool access → jailbreak or guardrail_bypass [LLM].

prompt_injection hierarchy [all LLM unless agent context]:
  prompt_injection — parent tag, use only when neither direct nor indirect applies.
  direct_prompt_injection — user's own input overrides model instructions.
  indirect_prompt_injection — attacker content in retrieved docs/emails/pages consumed by the LLM.
  rag_prompt_injection — specifically via RAG / knowledge-base retrieval content.
  agent_prompt_injection — any prompt injection targeting an agent's reasoning or action selection [AGENTIC].
  indirect_agent_prompt_injection — attacker content in tool outputs / retrieved pages consumed by an agent [AGENTIC].

jailbreak vs guardrail_bypass:
  jailbreak — coercing the model itself (roleplay, DAN, base64 encoding tricks).
  guardrail_bypass — circumventing an external filter, classifier, or policy layer around the model.

data_poisoning vs model_poisoning:
  data_poisoning — corrupting training or operational data to alter model behaviour.
  model_poisoning — injecting malicious behaviour into the model artefact or training pipeline directly.

model_extraction [TRAD] vs model_theft [LLM]:
  model_extraction — reverse-engineering a traditional ML model via queries (classification/regression/embedding models).
  model_theft — stealing LLM capability via distillation, fine-tune exfiltration, or checkpoint download.

sensitive_information_disclosure vs context_leakage vs system_prompt_leakage:
  sensitive_information_disclosure — source exposes confidential data, PII, or secrets from model output.
  context_leakage — leaks conversation history or context-window state specifically.
  system_prompt_leakage — extracts the hidden system prompt or private configuration text.

Multi-domain sources — pick the primary framing:
  Technique is the focus (how the attack works) → assign to the technique's domain.
  System being exploited is the focus (agent architecture, MCP setup, workflow) → agentic_ai_threats.
  AI is the attacker's weapon against non-AI targets → ai_enabled_threats.
  Genuinely ambiguous → pick the domain of the tag with the strongest supporting_quote.

## STEP 5 — SECONDARY DIMENSIONS (secondary_dimensions)
Optional. Only from: excessive_agency, misinformation, overreliance, resource_overload, cascading_hallucination.
Use as qualifiers / impacts / failure modes — never as the primary threat. Empty for most sources.

## STEP 6 — CATEGORY CANDIDATES (category_candidates)
Suggest 1–3 of: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats, unclear_or_adjacent.
Governance / policy / defensive sources with no specific offensive technique → unclear_or_adjacent.
Each candidate needs: category, supporting_tags (tag names), confidence (high/medium/low), reason (one sentence).

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

  if (detType && detType.type !== "unknown") {
    parts.push(
      `PRE-CLASSIFICATION (deterministic hint): source_type=${detType.type} (confidence: ${detType.confidence}, method: ${detType.method})`
    );
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
    text.includes("deepfake") || text.includes("disinformation") ||
    text.includes("synthetic media") || text.includes("voice clone") ||
    text.includes("ai-powered phishing") || text.includes("ai-enabled phishing") ||
    text.includes("ai-generated phishing") || text.includes("ai-assisted phishing") ||
    text.includes("ai malware") || text.includes("ai-generated malware") ||
    text.includes("ai reconnaissance") || text.includes("ai-assisted exploit") ||
    text.includes("ai attack automation") || text.includes("synthetic identity")
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
  const domain = guessDomainFromKeywords(source);
  const candidates = domain !== "unclear_or_adjacent"
    ? [{ category: domain, supporting_tags: [], confidence: "low", reason: "Keyword matching fallback — LLM unavailable" }]
    : [];

  return {
    source_type:            detType.type,
    source_type_confidence: detType.confidence,
    source_type_reason:     `Deterministic rule (${detType.method}) — LLM unavailable`,
    source_summary:         `${source.title || ""}. Published by ${source.publisher || "unknown"}.`,
    primary_subject:        (source.title || "").slice(0, 80),
    main_claims:            [],
    key_entities:           [source.publisher].filter(Boolean),
    important_numbers:      [],
    primary_domain:         domain,
    primary_threat_tags:    [],
    secondary_dimensions:   [],
    ai_enabled_mappings:    [],
    taxonomy_evidence:      [],
    validation_status:      "needs_manual_review",
    category_candidates:    candidates,
    llm_used:               false,
    taxonomy_version:       TAXONOMY_VERSION,
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

  // Keep the raw proposed tags as taxonomy_evidence, then validate them.
  const proposed = Array.isArray(out.primary_threat_tags) ? out.primary_threat_tags : [];
  out.taxonomy_evidence = proposed
    .filter((t) => t && t.tag)
    .map((t) => ({ tag: t.tag, supporting_quote: t.supporting_quote || "", reason: t.reason || "", confidence: t.confidence || "medium" }))
    .slice(0, 6);

  const { all } = validateThreatTags(proposed, source);
  // Drop outright rejected tags; keep validated / weak / needs_manual_review (max 4).
  const passedValidation = all.filter((r) => r.validation_status !== "rejected");
  if (passedValidation.length > 4) {
    process.stdout.write(
      `  [L4-taxonomy] "${(source.title || "").slice(0, 60)}": ${passedValidation.length} tags proposed — silently capped to 4 (${passedValidation.slice(4).map(t => t.tag).join(", ")} dropped)\n`
    );
  }
  const kept = passedValidation.slice(0, 4)
    .map((r) => ({ ...r, ...carryEvidence(proposed, r.tag) }));
  out.primary_threat_tags = kept;

  // Paired AI-enabled mappings derived from kept ai_enabled tags.
  out.ai_enabled_mappings = kept
    .filter((t) => t.domain === "ai_enabled_threats" && t.operational_mapping)
    .map((t) => ({
      primary_threat_tag:         t.tag,
      operational_attack_mapping: t.operational_mapping,
      ai_capability_modifier:     t.ai_capability_modifier,
      confidence:                 t.confidence,
    }));

  out.secondary_dimensions = validateSecondaryDimensions(out.secondary_dimensions || []);
  out.validation_status = overallStatus(kept);

  // primary_domain: trust a valid LLM value, else derive from the kept tags.
  if (!DOMAINS.includes(out.primary_domain)) {
    out.primary_domain = deriveDomain(kept);
  }

  // category_candidates — tolerate string[] from JSON-mode providers.
  let rawCandidates = out.category_candidates;
  if (!Array.isArray(rawCandidates)) rawCandidates = [];
  out.category_candidates = rawCandidates
    .map((c) => typeof c === "string" ? { category: c, confidence: "medium" } : c)
    .filter((c) => c && typeof c === "object" && CLASSIFIABLE_CATEGORIES.includes(c.category))
    .slice(0, 3);

  // Guard: a truthy non-array (e.g. the model returns an object/string) slips past
  // `|| []` and crashes .slice(), wrongly dropping the whole source to fallback.
  const arr = (v) => (Array.isArray(v) ? v : []);
  out.main_claims       = arr(out.main_claims).slice(0, 5);
  out.key_entities      = arr(out.key_entities).slice(0, 10);
  out.important_numbers = arr(out.important_numbers).slice(0, 5);

  if ((out.source_summary || "").length > 600) {
    out.source_summary = out.source_summary.slice(0, 600) + "…";
  }

  return out;
}

// Carry the model's supporting_quote/reason onto the validated tag object.
function carryEvidence(proposed, tag) {
  const p = proposed.find((x) => x.tag === tag) || {};
  return { supporting_quote: p.supporting_quote || "", reason: p.reason || "" };
}

function deriveDomain(tags) {
  if (!tags.length) return "unclear_or_adjacent";
  const counts = {};
  for (const t of tags) if (t.domain) counts[t.domain] = (counts[t.domain] || 0) + 1;
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top ? top[0] : "unclear_or_adjacent";
}

// ── Public API ────────────────────────────────────────────────────────────────

let _systemPromptCache = null;

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

  if (!hasLlm) {
    taxonomy = deterministicFallback(source, detType);
  } else {
    if (!_systemPromptCache) _systemPromptCache = buildSystemPrompt();

    try {
      const userPrompt = buildUserPrompt(source, detType);
      const raw = await callLLM(_systemPromptCache, userPrompt, {
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

  const newSourceType = taxonomy.source_type || source.source_type;
  const resolvedSourceType = (
    !taxonomy.llm_used && source.source_type && source.source_type !== "unknown"
  ) ? source.source_type : newSourceType;

  return {
    ...source,
    source_type:      resolvedSourceType,
    primary_domain:   taxonomy.primary_domain,
    taxonomy_version: TAXONOMY_VERSION,
    understanding: {
      ...taxonomy,
      source_type: resolvedSourceType,
    },
  };
}
