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

import { routedLLM }              from "../llm/llmRouter.js";
import { callLLM }                from "../llm/callLLM.js";
import {
  DOMAINS, SOURCE_TYPES, TRUST_TIERS, DEFENSIVE_FOCUS_AREAS,
  buildTaxonomyPromptBlock, isValidTag,
} from "./taxonomy.js";
import {
  SECURITY_PROPERTIES, EXPLOIT_MECHANISMS, EVIDENCE_ROLES, AFFECTED_LAYERS, CONSEQUENCES,
  mapToTaxonomy, validateMechanismFields, reconcileTag, buildMechanismPromptBlock,
} from "./mechanism.js";
import { computeImportance } from "./importance.js";
import { isGenericNoiseCve } from "./ingest/genericCveGate.js";

const UNDERSTAND_VERSION = "v2.0";

// ── Deterministic pre-screen (H1) ─────────────────────────────────────────────
// Applied before the LLM call to mirror the hard-reject gates that v1 Layer 3
// (sourceValidity.js + finalGate.js) would apply. Saves LLM tokens and prevents
// PR-wire noise, private-host URLs, stale content, and non-English sources from
// reaching synthesis unchallenged.

const PR_DENY_DOMAINS = new Set([
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  "accesswire.com", "einpresswire.com", "prlog.org",
  "pitchengine.com", "prweb.com", "newswire.com", "cision.com",
]);

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const STALE_YEARS     = 6;

const EN_STOPWORDS = new Set([
  "the","and","is","in","of","to","a","that","it","with","as","for","on",
  "are","by","this","be","was","from","but","not","or","an","have","they",
]);
const NON_EN_STOPWORDS = {
  es: ["el","la","los","las","un","una","de","en","y","que","es","por","con"],
  fr: ["le","la","les","un","une","de","du","des","en","et","que","qui","est"],
  de: ["der","die","das","ein","eine","und","ist","in","von","mit","zu","den"],
};

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function deterministicPreScreen(source) {
  const url   = source.url || "";
  const text  = source.full_text || source.clean_text || source.summary || "";
  const trust = source.trust_tier || "unknown";
  const isTrusted = ["primary", "high", "curated"].includes(trust);

  // Short text
  if (text.length < 50) return { pass: false, reason: "text_too_short" };

  // HTTPS-only (allow missing URL — it will be flagged by other validators)
  if (url && !url.startsWith("https://")) return { pass: false, reason: "url_not_https" };

  // Private / localhost hosts
  const domain = domainOf(url);
  if (domain && PRIVATE_HOST_RE.test(domain)) return { pass: false, reason: "private_host" };

  // PR-wire deny list (skip for trusted sources — they might syndicate via PR wires)
  if (!isTrusted && domain && PR_DENY_DOMAINS.has(domain)) {
    return { pass: false, reason: "pr_wire_deny_list" };
  }

  // Stale date for non-trusted sources
  if (!isTrusted && source.date_published) {
    const pubYear = parseInt(source.date_published.slice(0, 4), 10);
    if (!isNaN(pubYear) && new Date().getFullYear() - pubYear > STALE_YEARS) {
      return { pass: false, reason: `stale_date_${pubYear}` };
    }
  }

  // Non-English detection via stopword frequency (skip trusted sources)
  if (!isTrusted) {
    const sample = text.slice(0, 500).toLowerCase();
    const words  = sample.match(/\b[a-zA-ZÀ-ÿ]{2,}\b/g) || [];
    if (words.length >= 30) {
      const enRatio = words.filter(w => EN_STOPWORDS.has(w)).length / words.length;
      for (const [lang, stops] of Object.entries(NON_EN_STOPWORDS)) {
        const ratio = words.filter(w => stops.includes(w)).length / words.length;
        if (ratio > 0.08 && enRatio < 0.05) {
          return { pass: false, reason: `non_english_${lang}` };
        }
      }
    }
  }

  return { pass: true };
}

// ── JSON schema for structured output ─────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    // Three-way scope disposition (the keep/adjacent/discard decision):
    //   offensive_finding — a concrete attack/vuln/incident in an offensive domain
    //   adjacent_context  — genuinely about AI cyber-security but NOT an offensive
    //                       finding (governance/standards, dual-use autonomous
    //                       capability, standalone defense, a landmark survey/SoK).
    //                       KEEP as reference context, not an offensive signal.
    //   off_topic         — not AI cyber-security, or marketing/thin/physical-world.
    scope: { type: "string", enum: ["offensive_finding", "adjacent_context", "off_topic"] },
    rejection_reason: { type: "string" },
    // ── Mechanism-first fields (the LLM's semantic judgment) ──────────────────
    primary_security_property: { type: "string", enum: SECURITY_PROPERTIES },
    primary_exploit_mechanism: { type: "string", enum: EXPLOIT_MECHANISMS },
    primary_consequence:       { type: "string", enum: CONSEQUENCES },
    affected_layer:            { type: "string", enum: AFFECTED_LAYERS },
    mechanism_evidence_role:   { type: "string", enum: EVIDENCE_ROLES },
    attack_medium:             { type: "string" },
    mechanism_rationale:       { type: "string" },
    benchmark_target_mechanism:{ type: "string", enum: EXPLOIT_MECHANISMS },
    // True when the compromised/attacked artifact is LLM-specific (an LLM model,
    // prompt/RAG surface, or LLM-serving infra such as LiteLLM/vLLM/an inference
    // gateway). Routes supply-chain + poisoning to the llm_threats domain (LLM03/LLM04).
    target_is_llm:             { type: "boolean" },
    // ── LLM tag cross-check (advisory; the mapper is authoritative) ───────────
    primary_taxonomy_suggestion:    { type: "string" },
    secondary_taxonomy_suggestions: { type: "array", items: { type: "string" } },
    // ── Extraction ───────────────────────────────────────────────────────────
    ai_enabled_overlay: { type: "boolean" },
    source_type: { type: "string", enum: SOURCE_TYPES },
    trust_tier: { type: "string", enum: TRUST_TIERS },
    key_entities: { type: "array", items: { type: "string" } },
    main_claims: { type: "array", items: { type: "string" } },
    key_terms: { type: "array", items: { type: "string" } },
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
    is_defensive: { type: "boolean" },
    defended_category: { type: "string", enum: [...DOMAINS, "unclear_or_adjacent"] },
    defensive_techniques: { type: "array", items: { type: "string", enum: DEFENSIVE_FOCUS_AREAS } },
  },
  required: ["relevant", "scope", "primary_exploit_mechanism", "primary_consequence", "source_type", "trust_tier", "short_summary", "is_defensive"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are an AI threat intelligence analyst. Your job is to classify cybersecurity sources by their PRIMARY security mechanism and extract structured intelligence.

${buildMechanismPromptBlock()}

TAXONOMY TAGS (for your primary_taxonomy_suggestion cross-check only — the final tag is assigned deterministically from your mechanism fields):
${buildTaxonomyPromptBlock()}

TRUST TIER RULES:
  primary — Government agencies (CISA, NCSC, NSA, CSA, NIST), major AI labs (Anthropic, OpenAI, Google DeepMind)
  high    — Established security vendors, peer-reviewed academic papers, major research institutions
  medium  — Security blogs, news outlets, independent researchers with track record
  low     — Unknown authors, speculative content, obvious marketing
  unknown — Cannot determine

SCOPE DECISION — set "scope" to exactly one of three values. This is the keep/discard decision.
This platform tracks CONCRETE AI cyber threats, but also keeps landmark REFERENCE context.

scope="offensive_finding"  → KEEP as an offensive signal (also set relevant=true).
  The source establishes a SPECIFIC, CONCRETE finding in at least one of:
  • a specific AI/ML attack technique (demonstrated or documented, not just named)
  • a specific vulnerability/CVE in an AI system or its dependencies
  • a real incident, breach, campaign, or abuse involving AI systems or AI-enabled attacks
  • a research paper demonstrating a concrete attack ON or USING AI (with a method/result)
  • a threat actor observed using AI offensively
  • a jailbreak / adversarial / prompt-injection exploit with a concrete mechanism
  • a specific defensive measure/mitigation against a named AI threat technique

scope="adjacent_context"  → KEEP as reference context (category=unclear_or_adjacent, relevant=false).
  The source is genuinely, centrally about AI CYBER-security but is NOT itself an offensive
  finding — it is landmark context a briefing would still cite. Use this (NOT off_topic) for:
  • authoritative frameworks/standards/taxonomies (OWASP LLM/Agentic Top 10, NIST AI 100-2,
    MITRE ATLAS, Google SAIF, NSA/CISA guidance)
  • dual-use autonomous offensive CAPABILITY milestones (DARPA AIxCC, Google Big Sleep, an
    LLM autonomously finding zero-days) even when framed as find-AND-fix
  • a standalone defensive method/detection/hardening framework against AI threats
  • a landmark survey / SoK / systematization of the AI threat landscape
  • a frontier-model release or policy event with material AI-security implications
  The test: "Is this real AI-cyber-security a threat analyst should have on file, even though
  it names no single new attack?" If yes → adjacent_context (keep), NOT off_topic.

scope="off_topic"  → DISCARD (relevant=false). NOT AI-cyber-security, or pure noise:
  ✗ General "AI security trends" / "top N AI threats" editorial roundups with no new specific finding
  ✗ AI adoption / workforce / productivity articles without a documented attack or vulnerability
  ✗ Legal/regulatory/compliance content about AI (EU AI Act, executive orders) unless it documents a specific threat technique
  ✗ Attorney sanction cases for AI hallucinations — these are reliability failures, NOT security attacks
  ✗ Ransomware, APT, phishing, or malware articles with no documented AI use by the attacker
  ✗ Geopolitical or diplomatic news about AI (country cooperation, trade policy) with no attack documentation
  ✗ Vendor product announcements, launches, funding, acquisitions, partnerships, or "Introducing <product>" marketing — even for security products
  ✗ Generic educational explainers ("What is prompt injection", "A beginner's guide to…", "X 101", "how to get started") with no new finding
  ✗ Event/webinar/summit/podcast promotions or recaps ("what to learn from the … summit", "register now", "episode N")
  ✗ Thin content: series intros ("Introducing the … Series"), teasers, or index/landing pages with no substantive finding
  ✗ Opinion/thought-leadership pieces ("my thoughts on", "reflections", "a year in review") with no specific technique or incident
  ✗ Pure capability/benchmark leaderboard or model-performance comparisons with no security/attack angle

Set relevant=true ONLY when scope="offensive_finding". For BOTH adjacent_context and off_topic set relevant=false;
the difference is adjacent_context is KEPT as reference while off_topic is DISCARDED.

CYBER-SCOPE RULE — this is a CYBER threat intelligence platform. The threat must
target a system in the CYBER/enterprise/software domain (models, data pipelines,
APIs, agents, LLM apps, malware/fraud/spam classifiers, content moderation, etc.).
PHYSICAL-WORLD and KINETIC adversarial ML is OUT OF SCOPE → unclear_or_adjacent:
  ✗ Adversarial clothing / makeup / patches to evade facial recognition or CCTV surveillance
  ✗ Physical adversarial camouflage against object/person detectors (privacy or military)
  ✗ Attacks on autonomous-vehicle / drone / robot perception via physical objects, road signs, or sensors
  ✗ Physical-world sensor spoofing (LiDAR, radar, cameras) on cyber-physical systems
These are robotics / physical-security / privacy topics, not cyber threats a SOC or
security team defends against. Adversarial ML IS in scope ONLY when the attacked
model lives in the cyber/software domain (e.g. evading a malware or phishing
classifier, poisoning a fraud model, attacking an ML API or model hub artifact).

DEFENSIVE CONTENT RULE:
Set is_defensive=true if the source's PRIMARY contribution is a mitigation, defense, detection method, guardrail, countermeasure, hardening technique, or robustness improvement against an AI threat. Even if is_defensive=true, assign category to the OFFENSIVE domain being defended against (e.g., a paper on defending against prompt injection → category="llm_threats"). This lets defensive sources enrich the threat landscape without polluting offensive signal counts.

CRITICAL — adversarial-robustness and certified-defense papers are DEFENSIVE. A paper whose contribution is making a model MORE ROBUST (adversarial training, certified/provable robustness, randomized smoothing, robust architectures, defense frameworks, detectors of attacks) is is_defensive=true — EVEN THOUGH it describes the attacks it defends against to motivate or evaluate itself. The question is not "does it mention attacks?" but "is the deliverable a defense or an attack?". Titles like "Robust …", "… Adversarial Robustness", "Certified …", "Defense against …", "… Against Adversarial Attacks" are almost always defensive.
Set is_defensive=false only when the deliverable is an ATTACK the paper newly demonstrates (a working evasion, extraction, poisoning, or perturbation method), not a defense.
When is_defensive=true, set defended_category to the same value as category, and list up to 3 defensive_techniques from the allowed vocabulary.
When is_defensive=false, leave defended_category and defensive_techniques as empty/null.
CONSISTENCY: is_defensive, source_type, and defended_category must agree. If you pick source_type="defensive_capability", then is_defensive MUST be true and defended_category MUST be set. Never emit source_type="defensive_capability" with is_defensive=false. For a defensive source, set primary_exploit_mechanism/primary_consequence to the ATTACK it defends against and mechanism_evidence_role="defense".

MECHANISM DISCIPLINE — the most common past errors this prevents:
  • A jailbreak paper (direct user bypasses safety) → primary_exploit_mechanism=jailbreak_safety_bypass, NOT prompt_injection.
  • RAG poisoning (corpus corrupted) → rag_knowledge_poisoning; embedding theft/inversion → vector_embedding_attack. Do not conflate.
  • A generic web-app CVE (SSRF/XSS/auth-bypass/path-traversal) in an AI product with no AI-specific surface → primary_exploit_mechanism=generic_software_vulnerability (it will map to unclear).
  • A benchmark/survey → primary_exploit_mechanism=benchmark_or_evaluation and set benchmark_target_mechanism to what it evaluates.
  • Physical/kinetic adversarial ML remains OUT OF SCOPE regardless of mechanism.
  • Pick the SINGLE dominant mechanism and consequence — do not enumerate every mechanism the source mentions.

SOURCE TYPE — classify by EVIDENCE ROLE (what the source can prove), NOT by
publication format. A vendor blog reporting a real intrusion is "incident", not
a "blog"; a news article attributing a campaign is "threat_intelligence". Pick
the single best fit (use these exact values):

  Operational — something real happened or exists in the wild:
    vulnerability            — a specific disclosed flaw/CVE in an AI system or dependency
    exploit_disclosure       — a working exploit, released tool, or PoC code for a SPECIFIC
                               vulnerability or attack. Use this when: code/tool is publicly
                               released (GitHub, paper artifact, PoC script), OR a named CVE
                               is shown to be exploitable with demonstrated steps.
                               Examples: "We release GuardFall, a shell injection tool targeting
                               11 AI coding assistants"; "PoC for CVE-2025-XXXXX is available at..."
    incident                 — a documented real-world attack, breach, or abuse that occurred
    threat_intelligence      — threat-actor TTPs, IOCs, attribution, campaign tracking
    adversary_adoption_signal — evidence adversaries are adopting/using a technique or tool

  Technical evidence — demonstrated or measured, usually in a lab:
    research_finding         — a paper/study that ANALYSES or THEORISES about an attack method
                               WITHOUT releasing a tool or runnable artifact. The attack may be
                               proven in experiments but the PRIMARY contribution is the academic
                               insight, not a reusable attack tool.
                               Examples: "We show jailbreaks share a causal structure"; "We prove
                               membership inference is possible via shadow models"
    benchmark_evaluation     — an evaluation dataset, benchmark, or measurement study. Primary
                               contribution is a dataset or score, not a new attack method.
    capability_demonstration — a demo/PoC of a NEW GENERAL capability NOT tied to a specific CVE
                               and NOT a full released tool. Primary contribution is showing
                               something is possible for the first time.
                               Examples: first demo of multimodal prompt injection; first
                               demonstration that LLMs can autonomously chain exploits
    defensive_capability     — a defense, mitigation, detection, or hardening technique

  KEY DISTINCTION — research_finding vs exploit_disclosure vs capability_demonstration:
    Ask: "Does this release a usable attack tool or PoC code, or exploit a named CVE?"
      YES → exploit_disclosure
    Ask: "Does this demonstrate a new capability for the first time with a working system?"
      YES (no prior work, primary contribution is proof-of-possibility) → capability_demonstration
    Ask: "Is this primarily academic analysis, insight, or theory about an attack class?"
      YES → research_finding
    Default to research_finding only when the source is clearly an academic paper with no
    released artifact and no specific CVE being exploited.

  Contextual / structural — framing, not a specific finding:
    governance_signal        — policy, regulation, standard, or government/agency advisory
    societal_harm_signal     — documented societal/individual harm (disinfo, fraud, abuse)
    attack_surface_signal    — a development that materially expands or shifts the AI attack surface

  unknown                    — cannot determine

EXTRACTION FIELDS (always populate these when relevant=true):
  short_summary — REQUIRED. A 1–2 sentence (≤400 char) summary stating the core finding: what the threat/technique is and why it matters. Never leave empty.
  key_entities  — Named entities: products, tools, models, packages, CVE IDs, organisations, threat actors, people (e.g. "AutoGPT", "CVE-2026-33234", "Anthropic").
  key_terms     — Salient technical concepts, methods, and attack/defence techniques — NOT proper nouns (e.g. "prompt injection", "SSRF", "DLL sideloading", "tool-call loop", "wallet drain").
  key_numbers   — Quantitative facts ONLY, each as {value, context}. Include counts, percentages, sizes, prices, durations, and dates that carry meaning (e.g. {"value":"200000","context":"downloads before removal"}). Do NOT put version strings, currency codes, model names, hashes, or identifiers here — those belong in key_entities or key_terms.

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

Return JSON. If relevant=false, explain in rejection_reason and set primary_exploit_mechanism="unknown".
If relevant=true:
  1. Determine the mechanism fields FIRST: primary_security_property, primary_exploit_mechanism (the ONE dominant mechanism), primary_consequence (where the harm lands), affected_layer, mechanism_evidence_role, attack_medium (only for adversarial_evasion), mechanism_rationale (one sentence).
  2. As an independent cross-check, give primary_taxonomy_suggestion (one tag ID you think fits) and secondary_taxonomy_suggestions.
  3. Always populate: short_summary (1–2 sentences), up to 5 main_claims, up to 8 key_entities, up to 8 key_terms, and the key_numbers actually stated in the text (quantities only, with context).
Do NOT emit a category or primary_tags — the final taxonomy is assigned deterministically from your mechanism fields.`;
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
 * Flatten an arbitrarily nested LLM response into the expected flat shape.
 *
 * Anthropic models routinely invent creative nesting structures depending on
 * the system prompt and model version. Rather than enumerating every pattern,
 * we use deepGet() to find each field wherever it lives in the object tree.
 */
function flattenRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    relevant:             deepGet(raw, "relevant", "is_relevant", "isRelevant"),
    scope:                deepGet(raw, "scope", "scope_disposition", "relevance_scope"),
    rejection_reason:     deepGet(raw, "rejection_reason", "reason", "irrelevance_reason"),
    category:             deepGet(raw, "category", "threat_category", "domain", "primary_category"),  // skipLlm stub / back-compat only
    // ── Mechanism-first fields ────────────────────────────────────────────────
    primary_security_property: deepGet(raw, "primary_security_property", "security_property"),
    primary_exploit_mechanism: deepGet(raw, "primary_exploit_mechanism", "exploit_mechanism", "mechanism"),
    primary_consequence:       deepGet(raw, "primary_consequence", "consequence"),
    affected_layer:            deepGet(raw, "affected_layer", "layer"),
    mechanism_evidence_role:   deepGet(raw, "mechanism_evidence_role", "evidence_role"),
    attack_medium:             deepGet(raw, "attack_medium", "modality"),
    mechanism_rationale:       deepGet(raw, "mechanism_rationale", "rationale_one_sentence", "rationale"),
    benchmark_target_mechanism:deepGet(raw, "benchmark_target_mechanism"),
    target_is_llm:             deepGet(raw, "target_is_llm"),
    primary_taxonomy_suggestion:    deepGet(raw, "primary_taxonomy_suggestion", "suggested_tag", "primary_tag"),
    secondary_taxonomy_suggestions: deepGet(raw, "secondary_taxonomy_suggestions", "secondary_tags"),
    // ── Extraction ────────────────────────────────────────────────────────────
    ai_enabled_overlay:   deepGet(raw, "ai_enabled_overlay", "ai_enabled", "ai_enabled_as_weapon"),
    source_type:          deepGet(raw, "source_type", "type", "content_type", "source_category"),
    trust_tier:           deepGet(raw, "trust_tier", "trust", "publisher_tier", "credibility_tier"),
    key_entities:         deepGet(raw, "key_entities", "entities", "named_entities", "actors", "entity_list"),
    main_claims:          deepGet(raw, "main_claims", "claims", "key_findings", "findings", "key_claims"),
    key_terms:            deepGet(raw, "key_terms", "terms", "key_concepts", "technical_terms", "techniques"),
    key_numbers:          deepGet(raw, "key_numbers", "numbers", "statistics", "metrics", "quantitative_findings"),
    short_summary:        deepGet(raw, "short_summary", "summary", "description", "analysis_summary", "technical_summary"),
    is_defensive:         deepGet(raw, "is_defensive", "defensive", "is_primarily_defensive"),
    defended_category:    deepGet(raw, "defended_category", "defended_domain", "defensive_category"),
    defensive_techniques: deepGet(raw, "defensive_techniques", "defense_techniques", "mitigation_types"),
  };
}

export function normalise(raw, source, opts = {}) {
  if (!raw || typeof raw !== "object") {
    return { relevant: false, rejection_reason: "LLM returned non-object", _understand_version: UNDERSTAND_VERSION };
  }

  const flat = flattenRaw(raw);

  // ── Mechanism-first taxonomy assignment ─────────────────────────────────────
  // The LLM emits MECHANISM fields (not tags). Validate them to the controlled
  // vocabulary, map them DETERMINISTICALLY to a tag + domain, and cross-check
  // against the LLM's own tag suggestion. The deterministic map is authoritative
  // (MECE, consistent, testable); disagreements are recorded for review. This
  // single step replaces the former stack of per-tag regex gates.
  const is_cve = flat.source_type === "vulnerability"
    || /\bCVE-\d{4}-\d+/i.test(`${source.title || ""} ${flat.short_summary || ""}`);

  const mechFields = validateMechanismFields({
    primary_security_property:  flat.primary_security_property,
    primary_exploit_mechanism:  flat.primary_exploit_mechanism,
    primary_consequence:        flat.primary_consequence,
    affected_layer:             flat.affected_layer,
    evidence_role:              flat.mechanism_evidence_role,
    attack_medium:              flat.attack_medium,
    mechanism_rationale:        flat.mechanism_rationale,
    benchmark_target_mechanism: flat.benchmark_target_mechanism,
    target_is_llm:              flat.target_is_llm,
  });

  let mapped, reconciled, resolvedCategory, validatedTags;
  if (opts.skipLlm) {
    // Dry-run stub: preserve the source's existing category, assign no tags.
    resolvedCategory = DOMAINS.includes(flat.category) ? flat.category : "unclear_or_adjacent";
    mapped = { domain: resolvedCategory, primary_tag: null, secondary_tags: [], keep: resolvedCategory !== "unclear_or_adjacent", is_defensive: false, rationale: "skipLlm stub" };
    reconciled = { final_tag: null, llm_suggestion: null, agreement: false, conflict: false };
    validatedTags = [];
  } else {
    mapped = mapToTaxonomy({ ...mechFields, is_cve });
    reconciled = reconcileTag(mapped, flat.primary_taxonomy_suggestion);
    resolvedCategory = mapped.domain;
    validatedTags = mapped.primary_tag
      ? [mapped.primary_tag, ...(mapped.secondary_tags || [])].filter(isValidTag)
      : [];
  }

  // ── Disposition (three-way keep/adjacent/discard) ────────────────────────────
  // Historically a source was relevant IFF it mapped to a real offensive domain,
  // and everything else was discarded — which threw away on-topic LANDMARK context
  // (frameworks, dual-use autonomous capability, standalone defenses, SoKs) that
  // legitimately doesn't fit an offensive bucket. We now split that "else":
  //   offensive → keep as offensive signal (pass, offensive category)
  //   adjacent  → keep as reference context (review, unclear_or_adjacent)
  //   off_topic → discard (reject)
  const landedReal = resolvedCategory !== "unclear_or_adjacent" && mapped.keep;
  const llmScope   = ["offensive_finding", "adjacent_context", "off_topic"].includes(flat.scope) ? flat.scope : null;

  let disposition;
  if (opts.skipLlm) {
    disposition = Boolean(flat.relevant) ? "offensive" : "off_topic";
  } else if (landedReal && llmScope !== "off_topic" && flat.relevant !== false) {
    disposition = "offensive";
  } else if (llmScope === "adjacent_context") {
    // On-topic reference context the LLM explicitly flagged as worth keeping —
    // even though the mechanism mapper couldn't place it in an offensive domain.
    disposition = "adjacent";
  } else if (landedReal && llmScope === null && flat.relevant !== false) {
    // Back-compat: mechanism landed offensive but the model omitted `scope`.
    disposition = "offensive";
  } else {
    disposition = "off_topic";
  }

  // Adjacent sources are catalogued under unclear_or_adjacent (they don't map to an
  // offensive domain); offensive sources keep their resolved domain.
  const finalCategory = disposition === "offensive" ? resolvedCategory : "unclear_or_adjacent";
  const finalRelevant = disposition === "offensive";               // back-compat: "relevant" == offensive signal
  const finalKeep     = disposition !== "off_topic";               // adjacent + offensive are both retained
  const finalRejection = finalKeep ? null : (flat.rejection_reason || mapped.rationale || null);

  // ── Defensive invariant ──────────────────────────────────────────────────────
  // is_defensive, the "defensive" tag, and source_type="defensive_capability" are
  // three views of the SAME fact. Derive it from ANY signal (LLM flag, defensive
  // source_type, or evidence_role=defense from the mechanism mapping).
  const isDefensive = Boolean(flat.is_defensive)
    || flat.source_type === "defensive_capability"
    || mapped.is_defensive === true;
  const defendedCat = isDefensive
    ? (DOMAINS.includes(flat.defended_category) ? flat.defended_category
       : (DOMAINS.includes(finalCategory) ? finalCategory : null))
    : null;
  const defensiveTechs = isDefensive && Array.isArray(flat.defensive_techniques)
    ? flat.defensive_techniques.filter(t => DEFENSIVE_FOCUS_AREAS.includes(t)).slice(0, 3)
    : [];

  // Append "defensive" to tags so it's persisted in the tags column.
  const finalTags = isDefensive
    ? [...new Set([...validatedTags, "defensive"])]
    : validatedTags;

  // Mechanism-classification record (stored in intelligence jsonb; drives the
  // debug report + cross-check auditing).
  const mechanism_classification = {
    primary_security_property: mechFields.primary_security_property,
    primary_exploit_mechanism: mechFields.primary_exploit_mechanism,
    primary_consequence:       mechFields.primary_consequence,
    affected_layer:            mechFields.affected_layer,
    evidence_role:             mechFields.evidence_role,
    attack_medium:             mechFields.attack_medium,
    rationale:                 mechFields.mechanism_rationale,
    mapped_tag:                mapped.primary_tag,
    llm_suggestion:            reconciled.llm_suggestion,
    agreement:                 reconciled.agreement,
    conflict:                  reconciled.conflict,
  };

  // Guard short_summary against stringified-object leaks ("[object Object]" from
  // an LLM that nested the summary in an object the flattener could not unwrap).
  let safeSummary = typeof flat.short_summary === "string" ? flat.short_summary : "";
  if (safeSummary === "[object Object]") safeSummary = "";

  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published:source.date_published,
    full_text:     source.full_text || source.clean_text || "",

    relevant:         finalRelevant,
    disposition:      disposition,   // "offensive" | "adjacent" | "off_topic"
    keep:             finalKeep,      // offensive + adjacent are retained; off_topic discarded
    rejection_reason: finalRejection,
    category:         finalCategory,
    primary_tags:     finalTags,
    sub_techniques:   [],
    ai_enabled_overlay: Boolean(flat.ai_enabled_overlay),
    source_type:      SOURCE_TYPES.includes(flat.source_type) ? flat.source_type : "unknown",
    trust_tier:       TRUST_TIERS.includes(flat.trust_tier) ? flat.trust_tier : "unknown",
    key_entities:     (Array.isArray(flat.key_entities) ? flat.key_entities : []).slice(0, 10),
    key_terms:        (Array.isArray(flat.key_terms)    ? flat.key_terms    : []).slice(0, 8),
    main_claims:      (Array.isArray(flat.main_claims)  ? flat.main_claims  : []).slice(0, 6),
    key_numbers:      (Array.isArray(flat.key_numbers)  ? flat.key_numbers  : []).slice(0, 8),
    short_summary:    safeSummary.slice(0, 400),
    is_defensive:     isDefensive,
    defended_category: defendedCat,
    defensive_techniques: defensiveTechs,
    mechanism_classification: mechanism_classification,
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
// ── Date recovery helpers ─────────────────────────────────────────────────────
// Used when a source arrives with no date_published. Attempts lightweight HTTP
// scrape before the LLM call; stores the recovered date on the source object so
// downstream write-back persists it to the DB.

const _MONTH_NAMES  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const _MONTH_MAP    = Object.fromEntries(_MONTH_NAMES.map((m,i)=>[m, String(i+1).padStart(2,"0")]));
const _MONTH_RE     = new RegExp(`(${_MONTH_NAMES.join("|")})\\s+(\\d{1,2}),?\\s+(202\\d)`);
const _META_DATE_REs = [
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /<meta[^>]+name=["'](?:DC\.date|date)["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  /itemprop=["']datePublished["'][^>]*(?:datetime|content)=["']([^"']+)["']/i,
];

async function recoverDateFromPage(url) {
  if (!url || !url.startsWith("https://")) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0)", Accept: "text/html" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // Read only first 40KB — dates are always in the <head> or early body
    const reader = res.body?.getReader();
    if (!reader) return null;
    let html = "";
    while (html.length < 40000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});

    // 1. Structured meta/JSON-LD
    const today = new Date().toISOString().slice(0,10);
    for (const re of _META_DATE_REs) {
      const m = re.exec(html);
      if (m?.[1]) {
        const d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          const iso = d.toISOString().slice(0,10);
          if (iso >= "2010-01-01" && iso <= today) return iso;
        }
      }
    }
    // 2. First month-spelled date in visible text
    const m2 = _MONTH_RE.exec(html);
    if (m2) {
      const iso = `${m2[3]}-${_MONTH_MAP[m2[1]]}-${m2[2].padStart(2,"0")}`;
      if (iso >= "2010-01-01" && iso <= today) return iso;
    }
  } catch { /* timeout or network error — silently skip */ }
  return null;
}

export async function understandSource(source, opts = {}) {
  // H0: Date recovery — if source has no date, attempt a lightweight page scrape
  // before anything else. Recovered date is attached to the source object so the
  // write-back in understandAllSources persists it to the DB.
  if (!opts.skipLlm && !source.date_published && source.url) {
    const recovered = await recoverDateFromPage(source.url);
    if (recovered) {
      source = { ...source, date_published: recovered, date_confidence: "exact" };
    }
  }

  // H1: Deterministic pre-screen before spending an LLM call.
  // skipLlm bypasses this — dry-run mode should accept everything.
  if (!opts.skipLlm) {
    const screen = deterministicPreScreen(source);
    if (!screen.pass) {
      return normalise({
        relevant: false,
        rejection_reason: screen.reason,
        category: "unclear_or_adjacent",
        source_type: source.source_type || "unknown",
        trust_tier: source.trust_tier || "unknown",
        primary_tags: [], sub_techniques: [], key_entities: [],
        main_claims: [], key_numbers: [], short_summary: "",
      }, source);
    }
  }

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

const VALID_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

/**
 * Reconstitute a previously-understood source from its DB row.
 * Avoids re-running the LLM when the source was already classified.
 */
function fromDbRow(source) {
  // Restore defensive state from ANY of the three signals (flag / tag / type) so a
  // cached row whose intelligence.is_defensive was lost (older classifier versions,
  // overwritten jsonb) is still recognised as defensive and re-synced on re-run.
  const tags = source.tags || [];
  const isDef = source.intelligence?.is_defensive === true
    || tags.map(t => String(t).toLowerCase()).includes("defensive")
    || source.source_type === "defensive_capability";
  const offensive = VALID_CATEGORIES.has(source.main_category);
  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published: source.date_published,
    full_text:     source.full_text || source.clean_text || "",
    relevant:      true,
    rejection_reason: null,
    category:      source.main_category,
    primary_tags:  isDef ? [...new Set([...tags, "defensive"])] : tags,
    sub_techniques: [],
    ai_enabled_overlay: false,
    source_type:   source.source_type || "unknown",
    trust_tier:    source.trust_tier  || "unknown",
    key_entities:  source.intelligence?.key_entities || [],
    main_claims:   source.intelligence?.main_claims  || [],
    key_numbers:   source.intelligence?.key_numbers  || [],
    short_summary: source.short_summary || source.summary || "",
    // Restore defensive state so cached sources route through the defensive
    // sub-pipeline on re-run (was dropped before — defensive sources misrouted
    // as offensive and never re-enriched).
    is_defensive:         isDef,
    defended_category:    source.intelligence?.defended_category || (isDef && offensive ? source.main_category : null),
    defensive_techniques: source.intelligence?.defensive_techniques || [],
    _understand_version: UNDERSTAND_VERSION,
    _from_cache: true,
  };
}

/**
 * Understand a batch of sources with bounded concurrency.
 *
 * Pass opts.supabase to enable:
 *   - Skip-if-classified: sources with a valid main_category + validation_status="pass"
 *     are restored from the DB row without an LLM call (~$0 for already-processed sources)
 *   - Write-back: newly understood sources are written back to the sources table so
 *     subsequent runs can skip them too.
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]
 * @param {number}   [opts.concurrency=5]
 * @param {Function} [opts.onProgress]
 * @param {object}   [opts.supabase]   Supabase client — enables caching
 * @returns {Promise<{ relevant: object[], discarded: object[], counts: object }>}
 */
export async function understandAllSources(sources, opts = {}) {
  const { concurrency = 5, onProgress, supabase = null } = opts;
  const results = [];
  let cacheHits = 0;

  // ── Skip already-classified sources ──────────────────────────────────────────
  // A source that already has main_category + validation_status=pass in the DB
  // was understood in a previous run — restore from DB row, skip LLM call.
  const toProcess = [];
  for (const source of sources) {
    if (
      !opts.skipLlm &&
      VALID_CATEGORIES.has(source.main_category) &&
      source.validation_status === "pass"
    ) {
      results.push(fromDbRow(source));
      cacheHits++;
    } else {
      toProcess.push(source);
    }
  }
  if (cacheHits > 0) {
    process.stdout.write(`  [L3] ${cacheHits} sources restored from DB (already classified), ${toProcess.length} to process\n`);
  }

  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(s => understandSource(s, opts)));

    // ── Write-back: persist newly understood sources to Supabase ─────────────
    // This makes future runs cheaper: the source skips the LLM on re-run.
    if (supabase && !opts.skipLlm) {
      // Match results back to original source objects to get any recovered date
      const srcById = Object.fromEntries(batch.map(s => [s.id, s]));
      const now = new Date().toISOString();   // timestamp for importance.scored_at
      // Offensive AND adjacent sources are both persisted (kept). Offensive land in
      // their domain as pass; adjacent land in unclear_or_adjacent as review, so they
      // remain queryable as reference context without inflating offensive counts.
      // Durable generic-CVE gate: a generic-appsec CVE in an AI tool that landed in
      // unclear and is noise-tier (not actively exploited) is DISCARDED rather than
      // kept as adjacent reference — otherwise the NVD/GHSA connectors slowly refill
      // the corpus with hundreds of them. Actively-exploited (realized) CVEs survive.
      const writebacks = batchResults
        .filter(r => r.keep && r.category && !r._from_cache && !isGenericNoiseCve(r))
        .map(r => {
          const orig = srcById[r.id] || {};
          const isAdjacent = r.disposition === "adjacent";
          const row = {
            id:               r.id,
            main_category:    r.category,
            tags:             isAdjacent
              ? [...new Set([...(r.primary_tags || []), "adjacent_context"])]
              : (r.primary_tags || []),
            source_type:      r.source_type,
            trust_tier:       r.trust_tier,
            short_summary:    r.short_summary || null,
            validation_status: isAdjacent ? "review" : "pass",
            layer3_status:    isAdjacent ? "review" : "pass",
            needs_review:     isAdjacent ? true : undefined,
            relevance_tier:   isAdjacent ? "adjacent" : "core",
            ai_specificity_score: isAdjacent ? 40 : 80,
            intelligence: {
              is_defensive:         r.is_defensive || false,
              defended_category:    r.defended_category || null,
              defensive_techniques: r.defensive_techniques || [],
              mechanism_classification: r.mechanism_classification || null,
              // Deterministic importance tier (no LLM, no cost) — computed inline from
              // the just-classified facets so every new source lands pre-tiered.
              importance:           { ...computeImportance(r), scored_at: now },
            },
          };
          // Persist recovered date if the original had none and we recovered one
          if (!orig.date_published && r.date_published) {
            row.date_published  = r.date_published;
            row.date_confidence = "exact";
          }
          return row;
        });

      // Off-topic sources AND gated generic-noise CVEs are rejected.
      const discardWrites = batchResults
        .filter(r => (!r.keep || isGenericNoiseCve(r)) && !r._from_cache)
        .map(r => ({
          id:               r.id,
          main_category:    "unclear_or_adjacent",
          validation_status: "reject",
          layer3_status:    "reject",
          relevance_tier:   "off_topic",
          ai_specificity_score: 0,
        }));

      const allWrites = [...writebacks, ...discardWrites];
      if (allWrites.length > 0) {
        supabase.from("sources").upsert(allWrites, { onConflict: "id", ignoreDuplicates: false })
          .then(({ error }) => { if (error) console.warn(`  [L3 write-back] ${error.message}`); })
          .catch(() => {});
      }
    }

    results.push(...batchResults);
    onProgress?.(Math.min(i + concurrency, toProcess.length), toProcess.length);
  }

  // "relevant" keeps its historical meaning (offensive signal) for callers that
  // depend on it; adjacent sources are kept but reported separately.
  const relevant   = results.filter(r => r.relevant);
  const adjacent   = results.filter(r => r.disposition === "adjacent");
  const discarded  = results.filter(r => !r.keep);
  const byCat      = {};
  for (const r of relevant) {
    byCat[r.category] = (byCat[r.category] || 0) + 1;
  }

  return {
    relevant,
    adjacent,
    discarded,
    counts: {
      total:       results.length,
      relevant:    relevant.length,
      adjacent:    adjacent.length,
      discarded:   discarded.length,
      by_category: byCat,
    },
  };
}
