/**
 * L5A-rawfacts — Taxonomy
 *
 * Assigns source-type-aware evidence metadata to each source via LLM,
 * with a deterministic keyword-based fallback when LLM is unavailable.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Models:  gpt-4o-mini  (OPENAI_API_KEY primary, OPENAI_API_KEY_2 secondary)
 *          llama-3.3-70b-versatile  (GROQ_API_KEY — JSON mode, no schema)
 *          gemini-2.0-flash / gemini-2.5-flash  (GEMINI_API_KEY / GEMINI_API_KEY_2)
 * Trigger: any of the above env vars present AND skipLlm=false
 * Output:  structured JSON via json_schema response_format (TAXONOMY_SCHEMA)
 * Label:   "L5A-rawfacts-taxonomy"
 * Concurrency: 5 parallel calls (default)
 *
 * System prompt: _taxonomySystemPrompt (constant at module scope, lines 46–83)
 *   Instructs the model to assign rawfact taxonomy fields that describe what
 *   kind of factual evidence this source contains. Source-type-aware guidance
 *   for 15 source types. Controlled enum vocabularies for 4 fields.
 *
 * User prompt: buildUserPrompt(source) — source_type, main_category,
 *   framework_tags, summary, primary_subject, main_claims, key_entities,
 *   important_numbers, rawfact_taxonomy (if available), source text (≤1500 chars).
 *
 * Fallback (no keys or skipLlm=true):
 *   buildDeterministicTaxonomy() — infers sector/geography/technology from
 *   keywords, operational_relevance from source_type lookup table, novelty
 *   from text heuristics. Sets source_type_context to default shape.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * source.rawfact_taxonomy = { rawfact_tags, sector, geography, technology,
 *   affected_systems, impact_type, impact_scope, impact_severity,
 *   operational_relevance, novelty, source_type_context,
 *   rawfact_taxonomy_reason, source_id, rawfact_taxonomy_version, llm_used }
 */

import { callLLM } from "../../llm/callLLM.js";
import { VALID_SIGNAL_CLUSTERS, VALID_RECURRING_THEMES } from "../analytics/extractAnalyticsFeatures.js";
import { VALID_PRIMARY_TAGS, VALID_SUB_TECHNIQUES, VALID_AI_ENABLED_ROLES } from "../../config/taxonomyRegistry.js";

// ── Enum constants ─────────────────────────────────────────────────────────────

const IMPACT_SCOPE_VALUES   = ["individual","organization","sector","ecosystem","societal","global","unknown"];
const IMPACT_SEVERITY_VALUES = ["critical","high","medium","low","informational","unknown"];
const OPERATIONAL_RELEVANCE_VALUES = ["very_high","high","medium","low","none"];
const NOVELTY_VALUES        = ["new_attack_surface","new_tactic","known_tactic_new_scale","known_tactic","incremental","unknown"];

// ── LLM schema ────────────────────────────────────────────────────────────────

const TAXONOMY_SCHEMA = {
  type: "object",
  required: [
    "rawfact_tags","sector","geography","technology","affected_systems",
    "impact_type","impact_scope","impact_severity","operational_relevance",
    "novelty","source_type_context","rawfact_taxonomy_reason",
  ],
  properties: {
    rawfact_tags:           { type: "array", items: { type: "string" } },
    sector:                 { type: "array", items: { type: "string" } },
    geography:              { type: "array", items: { type: "string" } },
    technology:             { type: "array", items: { type: "string" } },
    affected_systems:       { type: "array", items: { type: "string" } },
    impact_type:            { type: "array", items: { type: "string" } },
    impact_scope:           { type: "string" },
    impact_severity:        { type: "string" },
    operational_relevance:  { type: "string" },
    novelty:                { type: "string" },
    // Merged from the old L5B analytics LLM pass — the genuinely semantic fields
    // (everything else in analytics_features is derived deterministically).
    signal_clusters:        { type: "array", items: { type: "string" } },
    recurring_themes:       { type: "array", items: { type: "string" } },
    source_type_context:    { type: "object" },
    rawfact_taxonomy_reason:{ type: "string" },
  },
};

// ── System prompt (cached at module scope) ────────────────────────────────────

const _taxonomySystemPrompt = `You are preparing a source for factual evidence extraction in an AI-cyber horizon scan.

This is NOT strategic analysis. This is evidence preparation.

The source already has Layer 5 intelligence: source_type, main_category, primary_domain,
primary_threat_tags, source_summary, primary_subject, main_claims, key_entities, important_numbers.

Your task: assign rawfact taxonomy fields that describe what kind of factual evidence
this source contains.

Be source-type-aware:
- vulnerability: focus on exploitability, affected ecosystem, blast radius, patch status, exploitation status
- exploit_disclosure: focus on exploit chain, reproducibility, access required, public tooling, operational realism
- incident: focus on confirmed impact, victim/sector, scale, attacker method, repeatability, institutional response
- threat_intelligence: focus on observed TTPs, actor/campaign details, sectors, operational confidence
- research_finding: focus on demonstrated method, reproducibility, systems tested, research-to-threat potential
- defensive_capability: focus on gap addressed, capability proposed, deployment readiness, limitations
- governance_signal: focus on issuing authority, governance issue, affected sectors, compliance implications
- ecosystem_signal: focus on adoption/infrastructure shifts and downstream security impact
- societal_harm_signal: focus on harm type, affected population, trust system, institutional response
- benchmark_evaluation: focus on capability measured, key result, trajectory signal
- capability_demonstration: focus on demonstrated capability, affected system, ease of replication, defender implications
- adversary_adoption_signal: focus on who is adopting, what capability, observed evidence, spread trajectory
- infrastructure_dependency_signal: focus on dependency type, attack surface created, scope of exposure
- trust_boundary_shift: focus on trust assumption violated, affected context, systemic implication
- strategic_signal: focus on strategic theme, systemic risk, convergence signal

Enums:
impact_scope: individual | organization | sector | ecosystem | societal | global | unknown
impact_severity: critical | high | medium | low | informational | unknown
operational_relevance: very_high | high | medium | low | none
novelty: new_attack_surface | new_tactic | known_tactic_new_scale | known_tactic | incremental | unknown

signal_clusters (0-3, the semantic threat clusters this source belongs to): ${[...VALID_SIGNAL_CLUSTERS].join(" | ")}
recurring_themes (0-3, cross-cutting strategic themes): ${[...VALID_RECURRING_THEMES].join(" | ")}

rawfact_tags rules:
- Copy EXACTLY from FRAMEWORK TAGS shown in the user prompt — do not invent new tag strings.
- Only include tags directly evidenced by the source text.
- Return an empty array if the provided framework tags are not directly supported.

General rules:
- Do not invent facts not in the source.
- Do not write strategic insights.
- Use "unknown" when the source does not provide enough detail.
- Return strict JSON only — no markdown, no preamble.`;

// ── Keyword-based deterministic helpers ───────────────────────────────────────

function textOf(source) {
  return `${source.title || ""} ${source.full_text || ""}`.toLowerCase();
}

function inferSector(source) {
  const text = textOf(source);
  const sectors = [];
  if (text.includes("financ") || text.includes("bank") || text.includes("wire fraud") || text.includes("payment"))
    sectors.push("financial_services");
  if (text.includes("health") || text.includes("medical") || text.includes("hospital"))
    sectors.push("healthcare");
  if (text.includes("energy") || text.includes("power grid") || text.includes("utility"))
    sectors.push("energy");
  if (text.includes("government") || text.includes("election") || text.includes("federal") || text.includes("nist") || text.includes("cisa"))
    sectors.push("government");
  if (text.includes("defence") || text.includes("defense") || text.includes("military"))
    sectors.push("defense");
  if (text.includes("telecom") || text.includes("telecommunication"))
    sectors.push("telecommunications");
  return sectors.length > 0 ? sectors.slice(0, 5) : ["cross_sector"];
}

function inferGeography(source) {
  const text = textOf(source);
  const geo = [];
  if (text.includes("china") || text.includes("chinese") || text.includes("prc") || text.includes("apt41")) geo.push("china");
  if (text.includes("russia") || text.includes("russian") || text.includes("apt28") || text.includes("cozy bear")) geo.push("russia");
  if (text.includes("iran") || text.includes("iranian")) geo.push("iran");
  if (text.includes("north korea") || text.includes("dprk") || text.includes("lazarus")) geo.push("north_korea");
  if (text.includes("united states") || text.includes("u.s.") || text.includes("cisa") || text.includes("nist")) geo.push("united_states");
  if (text.includes("europe") || text.includes("eu ") || text.includes("european")) geo.push("europe");
  if (text.includes("global") || text.includes("worldwide") || text.includes("international")) geo.push("global");
  return geo.slice(0, 5);
}

function inferTechnology(source) {
  const text = textOf(source);
  const tech = [];
  if (text.includes("llm") || text.includes("large language model")) tech.push("llm");
  if (text.includes("agent") || text.includes("agentic") || text.includes("autogpt") || text.includes("langchain")) tech.push("ai_agent");
  if (text.includes(" rag ") || text.includes("retrieval-augmented") || text.includes("rag poison") || text.includes("vector database")) tech.push("rag");
  if (text.includes("deepfake") || text.includes("synthetic media") || text.includes("voice clone") || text.includes("synthetic video")) tech.push("synthetic_media");
  if (text.includes("malware") || text.includes("reverse shell") || text.includes("exploit")) tech.push("malware");
  if (text.includes("model weight") || text.includes("pickle") || text.includes("model supply chain") || text.includes("hugging face")) tech.push("model_supply_chain");
  if (text.includes("transformer") || text.includes("neural network") || text.includes("ml model")) tech.push("ml_model");
  if (text.includes("api") || text.includes("sdk")) tech.push("api");
  if (text.includes("cve") || text.includes("vulnerability") || text.includes("deserialization")) tech.push("vulnerability_management");
  return tech.slice(0, 8);
}

function inferOperationalRelevanceFromType(sourceType) {
  if (sourceType === "incident" || sourceType === "threat_intelligence") return "very_high";
  if (sourceType === "vulnerability" || sourceType === "exploit_disclosure") return "high";
  if (sourceType === "adversary_adoption_signal" || sourceType === "capability_demonstration") return "high";
  if (sourceType === "research_finding" || sourceType === "benchmark_evaluation") return "medium";
  if (sourceType === "infrastructure_dependency_signal" || sourceType === "trust_boundary_shift") return "medium";
  if (sourceType === "governance_signal" || sourceType === "ecosystem_signal") return "low";
  return "medium";
}

// ── Source-type context default shapes ────────────────────────────────────────

function buildDefaultSourceTypeContext(sourceType) {
  switch (sourceType) {
    case "vulnerability":
      return {
        exploitability: "unknown",
        affected_product_or_system: "",
        affected_ecosystem: "",
        blast_radius: "unknown",
        exploit_status: "unknown",
        patch_status: "unknown",
        execution_or_data_access_risk: "unknown",
        defender_actionability: "unknown",
      };
    case "exploit_disclosure":
      return {
        exploit_chain: [],
        required_access: "unknown",
        reproducibility: "unknown",
        technical_complexity: "unknown",
        public_tooling_available: false,
        operational_realism: "unknown",
        automation_potential: "unknown",
      };
    case "incident":
      return {
        confirmed_impact: "unclear",
        victim_or_target_type: "",
        affected_sector: [],
        incident_scale: "unknown",
        attacker_method: "",
        repeatability: "unknown",
        institutional_response: "unknown",
        known_losses_or_numbers: [],
      };
    case "threat_intelligence":
      return {
        observed_ttps: [],
        threat_actor: "",
        campaign_scope: "unknown",
        targeted_sectors: [],
        ai_role_in_operation: "unknown",
        attribution_confidence: "unknown",
        operational_confidence: "unknown",
      };
    case "research_finding":
      return {
        research_claim: "",
        method_demonstrated: "",
        reproducibility: "unknown",
        systems_tested: [],
        research_to_threat_potential: "unknown",
        operationalization_barriers: [],
        defensive_implications: "",
      };
    case "defensive_capability":
      return {
        defensive_gap_addressed: "",
        capability_proposed: "",
        deployment_readiness: "unknown",
        coverage_scope: "unknown",
        evaluation_quality: "unknown",
        limitations: [],
      };
    case "governance_signal":
      return {
        issuing_authority: "",
        affected_sectors: [],
        governance_issue: "",
        compliance_or_policy_implication: "",
        systemic_risk_recognized: false,
        recommended_actions: [],
      };
    case "ecosystem_signal":
      return {
        ecosystem_change: "",
        adoption_signal: "unknown",
        infrastructure_or_platform: "",
        downstream_security_impact: "unknown",
        dependency_growth: "unknown",
        attack_surface_growth: "unknown",
      };
    case "capability_demonstration":
      return {
        demonstrated_capability: "",
        affected_system: "",
        ease_of_replication: "unknown",
        required_access: "unknown",
        defender_implications: "",
        public_reproduction_available: false,
      };
    case "adversary_adoption_signal":
      return {
        adopting_actor_type: "",
        capability_adopted: "",
        observed_evidence: "unknown",    // enum: confirmed | claimed | inferred | unknown
        spread_trajectory: "unknown",    // enum: high | medium | low | unknown
        targeted_sectors: [],
        first_observed: "",
      };
    case "infrastructure_dependency_signal":
      return {
        dependency_type: "",
        attack_surface_created: "",
        scope_of_exposure: "unknown",
        criticality: "unknown",          // enum: critical | high | medium | low | unknown
        known_exploits: false,
        affected_systems: [],
      };
    case "trust_boundary_shift":
      return {
        trust_assumption_violated: "",
        affected_context: "",
        systemic_implication: "",
        exploitability_window: "unknown", // enum: immediate | near_term | long_term | unknown
        affected_stakeholders: [],
      };
    case "societal_harm_signal":
      return {
        harm_type: "",
        affected_population: "",
        harm_scale: "unknown",
        trust_system_affected: "",
        institutional_response: "unknown",
        repeatability: "unknown",
      };
    case "benchmark_evaluation":
      return {
        capability_measured: "",
        evaluation_setup: "",
        key_result: "",
        model_or_system_tested: "",
        trajectory_signal: "unknown",
        limitations: [],
      };
    case "strategic_signal":
      return {
        strategic_theme: "",
        systemic_risk: "",
        convergence_signal: "",
        horizon_relevance: "unknown",
        supporting_examples: [],
        confidence: "unknown",
      };
    default:
      return {};
  }
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function buildDeterministicTaxonomy(source) {
  const st = source.source_type || "unknown";
  const text = textOf(source);

  // Infer rawfact_tags from existing tags + validated taxonomy fields (v9 first, v8 fallback)
  const u = source.understanding || {};
  const rawfactTagSet = new Set();
  const primaryTagList = Array.isArray(u.primary_tags) ? u.primary_tags : (u.primary_threat_tags || []);
  for (const t of primaryTagList) {
    const id = t.tag || (typeof t === "string" ? t : null);
    if (id && (VALID_PRIMARY_TAGS.has(id) || VALID_AI_ENABLED_ROLES.has(id))) rawfactTagSet.add(id);
  }
  for (const s of u.sub_techniques || []) {
    const id = typeof s === "string" ? s : s?.id;
    if (id && VALID_SUB_TECHNIQUES.has(id)) rawfactTagSet.add(id);
  }
  const rawfact_tags = Array.from(rawfactTagSet).slice(0, 10);

  // Impact type
  const impact_type = [];
  if (text.includes("financ") || text.includes("loss") || text.includes("$")) impact_type.push("financial");
  if (text.includes("data breach") || text.includes("exfiltrat") || text.includes("confidential")) impact_type.push("confidentiality");
  if (text.includes("disinformation") || text.includes("reputation")) impact_type.push("reputational");
  if (text.includes("attack") || text.includes("exploit") || text.includes("vulnerability")) impact_type.push("security");
  if (text.includes("disruption") || text.includes("shutdown") || text.includes("unavailab")) impact_type.push("operational");
  const finalImpactType = (impact_type.length > 0 ? impact_type : ["security"]).slice(0, 5);

  // Novelty: simple heuristic
  let novelty = "unknown";
  if (text.includes("new ") || text.includes("novel") || text.includes("first ") || text.includes("emerging")) novelty = "new_tactic";
  else if (text.includes(" scale") || text.includes("at scale") || text.includes("scaled")) novelty = "known_tactic_new_scale";

  return {
    rawfact_tags,
    sector: inferSector(source),
    geography: inferGeography(source),
    technology: inferTechnology(source),
    affected_systems: (source.understanding?.affected_systems || []).slice(0, 10),
    impact_type: finalImpactType,
    impact_scope: "unknown",
    impact_severity: "unknown",
    operational_relevance: inferOperationalRelevanceFromType(st),
    novelty,
    // Left empty deterministically — analytics buildDeterministicFeatures derives
    // category-based clusters/themes when these are absent.
    signal_clusters: [],
    recurring_themes: [],
    source_type_context: buildDefaultSourceTypeContext(st),
    rawfact_taxonomy_reason: `Deterministic fallback: source_type=${st}`,
  };
}

// ── LLM user prompt builder ───────────────────────────────────────────────────

function buildUserPrompt(source) {
  const u = source.understanding || {};
  const st = source.source_type || "unknown";
  const cat = source.main_category || "unknown";

  // Use new primary_tags (v9) with fallback to primary_threat_tags
  const primaryTags = Array.isArray(u.primary_tags) ? u.primary_tags : (u.primary_threat_tags || []);
  const subTechs = Array.isArray(u.sub_techniques) ? u.sub_techniques : [];
  const frameworkTagNames = [
    ...primaryTags.map((t) => `${t.tag}(${t.domain || "?"})`),
    ...subTechs.map((s) => {
      const id = typeof s === "string" ? s : s?.id;
      const pt = typeof s === "object" ? s.parent_tag : "";
      return id ? `${id}[sub:${pt}]` : null;
    }).filter(Boolean),
  ].filter(Boolean).join(", ");

  const mainClaimsList = (u.main_claims || [])
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  const keyEntities = (u.key_entities || []).join(", ");
  const importantNumbers = (u.important_numbers || []).join(" | ");

  const sourceText = (source.clean_text || source.full_text || "").slice(0, 3000);

  return [
    `SOURCE TYPE: ${st}`,
    `MAIN CATEGORY: ${cat}`,
    `FRAMEWORK TAGS: ${frameworkTagNames || "(none)"}`,
    ``,
    `SUMMARY: ${u.source_summary || source.summary || "(none)"}`,
    `PRIMARY SUBJECT: ${u.primary_subject || "(none)"}`,
    `MAIN CLAIMS:`,
    mainClaimsList || "(none)",
    `KEY ENTITIES: ${keyEntities || "(none)"}`,
    `IMPORTANT NUMBERS: ${importantNumbers || "(none)"}`,
    ``,
    `SOURCE TEXT (excerpt):`,
    sourceText || "(no text available)",
  ].join("\n");
}

// ── Output validation ─────────────────────────────────────────────────────────

function validateOutput(raw) {
  const out = typeof raw === "object" && raw !== null ? raw : {};

  const impact_scope = IMPACT_SCOPE_VALUES.includes(out.impact_scope) ? out.impact_scope : "unknown";
  const impact_severity = IMPACT_SEVERITY_VALUES.includes(out.impact_severity) ? out.impact_severity : "unknown";
  const operational_relevance = OPERATIONAL_RELEVANCE_VALUES.includes(out.operational_relevance)
    ? out.operational_relevance : "medium";
  const novelty = NOVELTY_VALUES.includes(out.novelty) ? out.novelty : "unknown";

  const ensureArray = (v) => Array.isArray(v) ? v : [];
  const inVocab = (arr, vocab, max) => [...new Set(ensureArray(arr)
    .map((v) => String(v || "").toLowerCase().replace(/-/g, "_"))
    .filter((v) => vocab.has(v)))].slice(0, max);

  // Validate rawfact_tags: accept primary tags, sub-techniques, and AE roles.
  const validatedRawfactTags = ensureArray(out.rawfact_tags)
    .filter((t) => typeof t === "string" && (
      VALID_PRIMARY_TAGS.has(t) || VALID_SUB_TECHNIQUES.has(t) || VALID_AI_ENABLED_ROLES.has(t)
    ))
    .slice(0, 10);

  return {
    rawfact_tags:           validatedRawfactTags,
    sector:                 ensureArray(out.sector).slice(0, 5),
    geography:              ensureArray(out.geography).slice(0, 5),
    technology:             ensureArray(out.technology).slice(0, 8),
    affected_systems:       ensureArray(out.affected_systems).slice(0, 10),
    impact_type:            ensureArray(out.impact_type).slice(0, 5),
    impact_scope,
    impact_severity,
    operational_relevance,
    novelty,
    signal_clusters:        inVocab(out.signal_clusters, VALID_SIGNAL_CLUSTERS, 3),
    recurring_themes:       inVocab(out.recurring_themes, VALID_RECURRING_THEMES, 3),
    source_type_context:    (typeof out.source_type_context === "object" && out.source_type_context !== null)
      ? out.source_type_context : {},
    rawfact_taxonomy_reason: typeof out.rawfact_taxonomy_reason === "string"
      ? out.rawfact_taxonomy_reason : "",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

/**
 * Apply rawfact taxonomy to a batch of sources (Layer 7.1A).
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]   - Force deterministic fallback.
 * @param {number}   [opts.concurrency=5]   - Max parallel LLM calls.
 * @returns {Promise<object[]>} Sources with `rawfact_taxonomy` field added.
 */
export async function applyRawfactTaxonomies(sources, opts = {}) {
  const { skipLlm = false, concurrency = DEFAULT_CONCURRENCY } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );

  async function processOne(source) {
    let taxFields;
    let llm_used = false;

    // Relevance gate: don't spend an LLM call on sources that won't reach the
    // deck. Curated sources are always kept. Rejected / discarded / off-topic /
    // peripheral sources get the deterministic path.
    const curated   = source.trust_tier === "curated";
    const lowValue  = !curated && (
      source.layer3_status === "reject" ||
      source.downstream_route === "discard" ||
      source.relevance_tier === "off_topic" ||
      source.relevance_tier === "peripheral"
    );

    if (!hasLlm || lowValue) {
      taxFields = buildDeterministicTaxonomy(source);
    } else {
      try {
        const raw = await callLLM(_taxonomySystemPrompt, buildUserPrompt(source), {
          task:     "taxonomy_tagging",
          schema:   TAXONOMY_SCHEMA,
          logLabel: "Layer7.1A-taxonomy",
        });
        taxFields = validateOutput(typeof raw === "string" ? JSON.parse(raw) : raw);
        llm_used = true;
      } catch (err) {
        process.stdout.write(
          `  [Layer 7.1A] Taxonomy LLM failed for "${(source.title || "").slice(0, 60)}": ${err.message} — using deterministic fallback\n`
        );
        taxFields = buildDeterministicTaxonomy(source);
      }
    }

    const rawfact_taxonomy = {
      ...taxFields,
      source_id: source.id,
      rawfact_taxonomy_version: "rawfact-v1.0",
      llm_used,
    };

    return { ...source, rawfact_taxonomy };
  }

  const results = new Array(sources.length);
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processOne));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}
