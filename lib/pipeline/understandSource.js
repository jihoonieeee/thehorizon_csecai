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
  buildTaxonomyPromptBlock, isValidTag, isValidSubTech, domainOfTag,
} from "./taxonomy.js";

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
    rejection_reason: { type: "string" },
    category: { type: "string", enum: DOMAINS },
    primary_tags: { type: "array", items: { type: "string" } },
    sub_techniques: { type: "array", items: { type: "string" } },
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
  required: ["relevant", "category", "source_type", "trust_tier", "short_summary", "is_defensive"],
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

RELEVANCE RULE — apply a STRICT bar. This platform tracks CONCRETE AI cyber threats.
relevant=true ONLY if the source establishes a SPECIFIC, CONCRETE finding in at least one of:
  • a specific AI/ML attack technique (demonstrated or documented, not just named)
  • a specific vulnerability/CVE in an AI system or its dependencies
  • a real incident, breach, campaign, or abuse involving AI systems or AI-enabled attacks
  • a research paper demonstrating a concrete attack ON or USING AI (with a method/result)
  • a threat actor observed using AI offensively
  • a jailbreak / adversarial / prompt-injection exploit with a concrete mechanism
  • a specific defensive measure/mitigation against a named AI threat technique

relevant=false (→ unclear_or_adjacent) if the source is ABOUT AI security but establishes
NO specific, checkable finding — i.e. it only discusses, frames, promotes, or explains.
The test: "After reading this, can I name a specific technique, vulnerability, incident, or
result?" If no, it is NOT relevant, no matter how on-topic the subject sounds.

HARD REJECTION PATTERNS — always relevant=false, category=unclear_or_adjacent:
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

TAI03_ADVERSARIAL_EVASION RULE:
Assign TAI03 ONLY when the source demonstrates a concrete EVASION ATTACK — adversarial perturbations/inputs that cause a target ML model to misclassify or be bypassed (e.g. evading a malware/phishing/AI-text/deepfake/vulnerability detector, adversarial examples against a classifier). Do NOT assign TAI03 for:
  ✗ Robustness THEORY or analysis papers (convergence rates, activation curvature, "how worst-case are attacks", comparative robustness studies) — these are analysis, not attacks. Use unclear_or_adjacent.
  ✗ Capability EVALUATIONS/benchmarks of a model's performance (e.g. "can fine-tuned LLMs detect vulnerabilities", "do models generalise") — not an attack. Use unclear_or_adjacent.
  ✗ "Adversarial" used as an OPTIMIZATION/training term (adversarial training for alignment, adversarial subspace for knowledge editing, adversarial perturbations repurposed for continual learning) — not an adversarial-ML attack. Use unclear_or_adjacent.
  ✗ Defensive AI tools (AI-powered vulnerability scanners, AI code-review) — these are defensive_capability, not evasion attacks.
  ✗ Attacks on NON-CYBER scientific ML (medical image segmentation, world models for robotic control, signal-processing networks) — out of cyber scope → unclear_or_adjacent.

AI_ENABLED_THREATS RULE:
Before assigning ai_enabled_threats, apply this STRICT decision test:
  "Does the source contain direct, first-hand evidence that an AI system (a generative model, deepfake engine, LLM, voice cloner, etc.) was actively used as the mechanism to carry out the attack — not merely mentioned, not speculated, not implied?"
  If the answer is not a clear YES, assign unclear_or_adjacent instead.

Qualifying examples (PASS):
  ✓ A threat actor uses GPT-4 to write targeted phishing emails — documented with samples
  ✓ A deepfake video of a CEO is used to authorise a wire transfer — incident reported
  ✓ AI-generated fake ID documents used to bypass KYC — documented fraud case
  ✓ LLM used to auto-generate malware variants at scale — verified by researchers

Disqualifying examples (FAIL → use unclear_or_adjacent):
  ✗ An APT group conducts a C2/ransomware/phishing attack — no mention of AI use
  ✗ Article speculates "nation-states will use AI for cyberattacks" — future speculation
  ✗ A news roundup covers multiple security events, one of which involves AI tangentially
  ✗ A CVE in an AI-adjacent product (GitLab AI feature, VS Code Copilot extension) — that's llm_threats or agentic_ai_threats
  ✗ A researcher asks "could AI be used for X?" without demonstrating it was
  ✗ A conventional malware article labelled "AI-era" by a journalist without evidence

Assign at least one AE01–AE10 primary_tag that matches the specific AI mechanism used. If two analysts reading the source could reasonably disagree whether AI was documented, choose unclear_or_adjacent.

TAI10_AI_SUPPLY_CHAIN_COMPROMISE MANDATORY TEST:
Before assigning TAI10, answer this question from the source text: "Which specific AI artifact (model file, ML library, dataset, model hub package) was compromised?"
If you cannot name a specific AI artifact present in the text, do NOT assign TAI10.

TAI10 REQUIRES at least one of:
  ✓ A malicious model/weights/checkpoint uploaded to Hugging Face, CivitAI, or another model hub
  ✓ A trojanized ML library: transformers, langchain, torch, gradio, datasets, safetensors, keras, vllm, mlflow, onnx, etc.
  ✓ A poisoned training dataset used to train an ML model
  ✓ A compromised ML serving/training framework: MLflow, TensorFlow Serving, vLLM, Triton, ONNX Runtime

TAI10 FAILS — assign unclear_or_adjacent for all of these:
  ✗ CVEs in JWT/OAuth/LDAP/PKI/certificate tools used by AI platforms — web security, not AI supply chain
  ✗ Container/runtime supply chain: Docker, Kubernetes, containerd, Helm — not AI-specific
  ✗ Generic package managers (npm, pip, cargo, nuget, pnpm) UNLESS the specific compromised package IS an ML library
  ✗ CI/CD pipeline attacks (GitHub Actions, GitLab CI, Jenkins, Argo) in AI product repos
  ✗ Developer tool attacks (VS Code extensions, JetBrains plugins) not targeting ML notebooks or AI weights
  ✗ Any source where "AI" only appears in the company/product name but the compromised artifact is not AI-specific

CATEGORY BOUNDARY RULES — prevent misclassification between categories:

  LLM Threats vs Agentic Threats (for prompt injection):
  → Use llm_threats / LLM01 when: a stateless chatbot or LLM API is the target, with no tool-calling or multi-step agent pipeline involved.
  → Use agentic_ai_threats / ASI01 or ASI02 when: the injection causes an agent to take actions through tools, memory, code execution, or external API calls.

  LLM Threats vs unclear_or_adjacent (for CVEs in AI products):
  A CVE in an AI product belongs in llm_threats ONLY if the vulnerability exploits the LLM-specific attack surface (prompt injection, training data leakage, output handling that enables prompt-based exploitation).
  Standard web application vulnerabilities (XSS, SSRF, path traversal, auth bypass, XXE) in an LLM platform belong in unclear_or_adjacent unless the vulnerability is directly exploitable via AI-specific attack patterns.
  Examples of web app CVEs that do NOT belong in llm_threats:
    ✗ Open WebUI SVG XSS, path traversal, OAuth SSRF → unclear_or_adjacent
    ✗ Docling XXE in XML parsers, Zip Slip in file uploads → unclear_or_adjacent
    ✗ GitHub Copilot missing authorization on an endpoint → unclear_or_adjacent
    ✗ Generic authentication bypass in an AI chat platform → unclear_or_adjacent

AGENTIC_AI_THREATS MANDATORY TEST:
Before assigning agentic_ai_threats, apply this strict decision test:
  "Does the source contain direct, documented evidence that an AI agent (a system using memory, tool-calling, MCP, code execution, or multi-step orchestration) was specifically attacked, exploited, or abused — with a concrete technique demonstrated or documented, not just described or predicted?"
  If the answer is not a clear YES, assign unclear_or_adjacent instead.

Qualifying examples (PASS):
  ✓ A researcher demonstrates that injecting text in a file causes a coding agent to exfiltrate SSH keys via a bash tool call
  ✓ A CVE in an MCP server allows privilege escalation to access additional data stores
  ✓ A paper shows that poisoning an agent's vector memory causes persistent goal deviation — demonstrated in a lab
  ✓ A threat report documents real-world agents hijacked to maintain C2 persistence via API call chains

Disqualifying examples (FAIL → use unclear_or_adjacent):
  ✗ "Top threats to agentic AI in 2025" / "AI security predictions" — editorial overview, no new finding
  ✗ "Organizations must secure their AI agents" — governance advisory without specific demonstrated technique
  ✗ A paper describing agent capabilities or architecture (not attacks ON or through agents)
  ✗ AI coding assistant product announcements with security feature notes
  ✗ Red teaming framework for AI agents without a specific new demonstrated vulnerability
  ✗ A CVE in a platform that has agentic features where the bug is XSS/SSRF/path traversal
  ✗ Workforce, productivity, or operational risk discussions that mention AI agents in passing

  Agentic Threats sub-tag guidance:
  Use agentic_ai_threats ONLY when the source documents a specific attack ON or USING AI agent capabilities (tool misuse, memory poisoning, goal hijack, MCP compromise, autonomous agent privilege escalation).
  Do NOT use agentic_ai_threats for:
    ✗ General "AI in security" trend articles or predictions
    ✗ AI workforce / productivity / operational risk articles
    ✗ Best-practice / governance frameworks for AI (unless documenting a specific attack technique)
    ✗ Red teaming methodology articles without a specific new finding

ASI02_TOOL_MISUSE_EXPLOITATION RULE:
ASI02 applies when an agent's tool-calling mechanism is specifically exploited — e.g. injecting malicious tool responses, exploiting MCP server vulnerabilities, abusing function-calling APIs. Do NOT assign ASI02 to general agentic AI papers just because they involve tool use. Use ASI01 (goal hijack), ASI06 (memory poisoning), or ASI05 (code execution) when those are the primary risks.

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

Return JSON. If relevant=false, set category="unclear_or_adjacent" and explain in rejection_reason.
If relevant=true, assign the best-fitting category, 1-3 primary_tags from that category, and relevant sub_techniques. Then always populate: a short_summary (1–2 sentences), up to 5 main_claims, up to 8 key_entities, up to 8 key_terms, and the key_numbers actually stated in the text (quantities only, with context).`;
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
    relevant:             deepGet(raw, "relevant", "is_relevant", "isRelevant"),
    rejection_reason:     deepGet(raw, "rejection_reason", "reason", "irrelevance_reason"),
    category:             deepGet(raw, "category", "threat_category", "domain", "primary_category"),
    primary_tags:         deepGet(raw, "primary_tags", "tags", "threat_tags", "primary_threat_tags"),
    sub_techniques:       deepGet(raw, "sub_techniques", "subtechniques", "sub_technique_ids", "sub_technique_list"),
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

function normalise(raw, source, opts = {}) {
  if (!raw || typeof raw !== "object") {
    return { relevant: false, rejection_reason: "LLM returned non-object", _understand_version: UNDERSTAND_VERSION };
  }

  const flat = flattenRaw(raw);

  // Validate tags and sub-techniques against taxonomy; guard non-array returns
  const rawTags = Array.isArray(flat.primary_tags) ? flat.primary_tags : [];
  const rawSubs = Array.isArray(flat.sub_techniques) ? flat.sub_techniques : [];
  let validatedTags = rawTags.filter(t => isValidTag(t));
  const validatedSubs = rawSubs.filter(s => isValidSubTech(s));

  // Resolve category: handles tag-IDs-as-category, infers from tags, falls back
  let resolvedCategory = resolveCategory(flat.category, rawTags);

  // ── QA Gate 1: TAI10 artifact gate ───────────────────────────────────────────
  // TAI10 requires an AI-specific artifact keyword in the source. Generic supply
  // chain CVEs (JWT, OAuth, npm, Docker, CI/CD) must not claim TAI10.
  const AI_ARTIFACT_RE = /\b(hugging.?face|model.hub|safetensor|gguf|onnx|pytorch|tensorflow|transformers|langchain|gradio|mlflow|keras|model.weight|llama|mistral|stable.diffusion|comfyui|ollama|vllm|triton|civitai|\.pkl|pickle|ml.model|ai.model|malicious.model|model.repositor|model.package|checkpoint|pre.?trained.model|skill.repositor)\b/i;
  if (!opts.skipLlm && validatedTags.includes("TAI10_ai_supply_chain_compromise")) {
    const tai10Text = `${source.title || ""} ${(source.full_text || source.clean_text || source.summary || "").slice(0, 3000)}`;
    if (!AI_ARTIFACT_RE.test(tai10Text)) {
      validatedTags = validatedTags.filter(t => t !== "TAI10_ai_supply_chain_compromise");
      // Downgrade to unclear_or_adjacent if TAI10 was the only evidence for the domain
      if (resolvedCategory === "traditional_ai_threats" && !validatedTags.some(t => t.startsWith("TAI"))) {
        resolvedCategory = "unclear_or_adjacent";
      }
    }
  }

  // ── QA Gate 2: Agentic editorial gate ────────────────────────────────────────
  // agentic_ai_threats requires at least one ASI tag demonstrating a specific
  // attack technique. Editorial/trend/governance content with no ASI tags moves to
  // unclear_or_adjacent.
  const AGENTIC_EDITORIAL_RE = /\b(trend|prediction|outlook|roundup|top \d+|year in review|state of ai|landscape|workforce|productivity|best practice|governance|risk management|challenges of|guide to|introduction to|overview of|policy for|checklist|how to secure|primer on|considerations for|ai in \d{4}|future of ai)\b/i;
  if (!opts.skipLlm && resolvedCategory === "agentic_ai_threats") {
    const agentText = `${source.title || ""} ${flat.short_summary || ""}`;
    const asiTags = validatedTags.filter(t => t.startsWith("ASI"));
    if (AGENTIC_EDITORIAL_RE.test(agentText) && asiTags.length === 0) {
      resolvedCategory = "unclear_or_adjacent";
    }
  }

  // Determine relevance: trust the field if present, but also infer from category
  // (Haiku sometimes contradicts itself: says relevant=false yet assigns a real domain)
  const isRelevant = Boolean(flat.relevant) ||
    (resolvedCategory !== "unclear_or_adjacent" && !flat.rejection_reason);

  // ── QA Gate 3: AE gate ───────────────────────────────────────────────────────
  // ai_enabled_threats requires at least one AE01–AE10 primary_tag confirming AI
  // was used as the attack tool. Conventional threat campaigns without documented
  // AI involvement are discarded as unclear_or_adjacent.
  const aeTags = validatedTags.filter(t => t.startsWith("AE"));
  const failsAeGate = !opts.skipLlm && resolvedCategory === "ai_enabled_threats" && aeTags.length === 0;
  const finalCategory       = failsAeGate ? "unclear_or_adjacent" : resolvedCategory;
  const finalRelevant       = failsAeGate ? false : isRelevant;
  const finalRejection      = failsAeGate
    ? "ai_enabled_threats requires an AE01–AE10 tag confirming AI use as attack tool; no such tag found — conventional threat activity without documented AI involvement"
    : (flat.rejection_reason || null);

  const isDefensive = Boolean(flat.is_defensive);
  const defendedCat = isDefensive && DOMAINS.includes(flat.defended_category)
    ? flat.defended_category : null;
  const defensiveTechs = isDefensive && Array.isArray(flat.defensive_techniques)
    ? flat.defensive_techniques.filter(t => DEFENSIVE_FOCUS_AREAS.includes(t)).slice(0, 3)
    : [];

  // Append "defensive" to primary_tags so it's persisted in the tags column
  const finalTags = isDefensive
    ? [...new Set([...validatedTags, "defensive"])]
    : validatedTags;

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
    primary_tags:     finalTags,
    sub_techniques:   validatedSubs,
    ai_enabled_overlay: Boolean(flat.ai_enabled_overlay),
    source_type:      SOURCE_TYPES.includes(flat.source_type) ? flat.source_type : "unknown",
    trust_tier:       TRUST_TIERS.includes(flat.trust_tier) ? flat.trust_tier : "unknown",
    key_entities:     (Array.isArray(flat.key_entities) ? flat.key_entities : []).slice(0, 10),
    key_terms:        (Array.isArray(flat.key_terms)    ? flat.key_terms    : []).slice(0, 8),
    main_claims:      (Array.isArray(flat.main_claims)  ? flat.main_claims  : []).slice(0, 6),
    key_numbers:      (Array.isArray(flat.key_numbers)  ? flat.key_numbers  : []).slice(0, 8),
    short_summary:    (String(flat.short_summary || "")).slice(0, 400),
    is_defensive:     isDefensive,
    defended_category: defendedCat,
    defensive_techniques: defensiveTechs,
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
    primary_tags:  source.tags || [],
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
    is_defensive:         source.intelligence?.is_defensive || false,
    defended_category:    source.intelligence?.defended_category || null,
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
      const writebacks = batchResults
        .filter(r => r.relevant && r.category && !r._from_cache)
        .map(r => {
          const orig = srcById[r.id] || {};
          const row = {
            id:               r.id,
            main_category:    r.category,
            tags:             r.primary_tags || [],
            source_type:      r.source_type,
            trust_tier:       r.trust_tier,
            short_summary:    r.short_summary || null,
            validation_status: "pass",
            layer3_status:    "pass",
            intelligence: {
              is_defensive:         r.is_defensive || false,
              defended_category:    r.defended_category || null,
              defensive_techniques: r.defensive_techniques || [],
            },
          };
          // Persist recovered date if the original had none and we recovered one
          if (!orig.date_published && r.date_published) {
            row.date_published  = r.date_published;
            row.date_confidence = "exact";
          }
          return row;
        });

      const discardWrites = batchResults
        .filter(r => !r.relevant && !r._from_cache)
        .map(r => ({
          id:               r.id,
          main_category:    "unclear_or_adjacent",
          validation_status: "reject",
          layer3_status:    "reject",
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
