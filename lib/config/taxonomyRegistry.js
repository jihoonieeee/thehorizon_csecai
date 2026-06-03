/**
 * Canonical AI Threat Taxonomy Registry — Validated June 2026 revision.
 *
 * Source of truth: docs/FINAL TAXONOMY.pdf ("Validated AI Threat Taxonomy").
 * This is a structured analytical ontology, NOT a flat tag list. It supports
 * evidence extraction, rawfact tagging, analytics, synthesis, slide generation,
 * source traceability, and confidence scoring across the whole pipeline.
 *
 * ── DESIGN RULES (from the PDF) ────────────────────────────────────────────────
 *  • Threat tags only — primary tags describe adversarial behaviour / abuse
 *    mechanisms. Generic risk items (misinformation, overreliance, excessive
 *    agency, …) are SECONDARY dimensions, never primary threat tags and never
 *    counted as threat frequency.
 *  • Four domains, fixed names: traditional_ai_threats, llm_threats,
 *    agentic_ai_threats, ai_enabled_threats.
 *  • Agentic AI is modelled across memory, context, tools, MCP, runtime,
 *    credentials, workflows, orchestration, and multi-agent communication.
 *  • AI-enabled threats use PAIRED mapping: an operational ATT&CK technique +
 *    an AI capability modifier. T1588.007 is a modifier, never a standalone tag.
 *  • A tag may only be assigned when source evidence directly supports the
 *    threat behaviour and includes a traceable source URL (see taxonomyValidation.js).
 *
 * ── ENTRY SHAPE ────────────────────────────────────────────────────────────────
 *   {
 *     tag, display_name, domain, tag_type, parent_tag, subdomain, threat_meaning,
 *     primary_reference, secondary_references[], reference_urls[],
 *     operational_mapping, ai_capability_modifier, assignment_rule,
 *     requires_concrete_evidence
 *   }
 *
 * Secondary dimensions live in a SEPARATE export (SECONDARY_DIMENSIONS) and are
 * deliberately not part of VALID_PRIMARY_TAGS.
 */

export const DOMAINS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

export const AGENTIC_SUBDOMAINS = [
  "prompt_control", "memory_state", "tools_mcp", "permissions",
  "execution", "workflow", "multi_agent", "identity", "human_agent",
];

export const AI_ENABLED_SUBDOMAINS = [
  "reconnaissance", "targeting", "vulnerability_research", "exploit_development",
  "malware_development", "obfuscation", "command_generation",
  "phishing_social_engineering", "impersonation", "fraud",
  "influence_operations", "automation_orchestration",
];

// ── Reference URLs (PDF "Reference Links" table) ───────────────────────────────

export const REFERENCE_URLS = {
  MITRE_ATLAS:            "https://atlas.mitre.org/",
  MITRE_ATLAS_SAFE_AI:    "https://atlas.mitre.org/pdf-files/SAFEAI_Full_Report.pdf",
  OWASP_LLM_TOP_10:       "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
  OWASP_AGENTIC_AI:       "https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/",
  OWASP_MCP_TOP_10:       "https://owasp.org/www-project-mcp-top-10/",
  OWASP_MCP_TOOL_POISONING:"https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning",
  OWASP_MCP_CHEAT_SHEET:  "https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html",
  T1588_007:              "https://attack.mitre.org/techniques/T1588/007/",
  T1587_001:              "https://attack.mitre.org/techniques/T1587/001/",
  T1587_004:              "https://attack.mitre.org/techniques/T1587/004/",
  T1588_006:              "https://attack.mitre.org/techniques/T1588/006/",
  T1566:                  "https://attack.mitre.org/techniques/T1566/",
  T1027:                  "https://attack.mitre.org/techniques/T1027/",
  T1059:                  "https://attack.mitre.org/techniques/T1059/",
  T1589:                  "https://attack.mitre.org/techniques/T1589/",
  T1595:                  "https://attack.mitre.org/techniques/T1595/",
  DISARM:                 "https://www.disarm.foundation/framework",
};

// Resolve a free-text reference string to its canonical URL(s).
function urlsForReference(ref) {
  if (!ref) return [];
  const r = String(ref);
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  if (/MITRE ATLAS SAFE-AI|SAFE-AI/i.test(r)) add(REFERENCE_URLS.MITRE_ATLAS_SAFE_AI);
  if (/MITRE ATLAS|AML\.T/i.test(r))          add(REFERENCE_URLS.MITRE_ATLAS);
  if (/MCP03|Tool[-\s]?Poisoning/i.test(r))   add(REFERENCE_URLS.OWASP_MCP_TOOL_POISONING);
  if (/MCP Security Cheat/i.test(r))          add(REFERENCE_URLS.OWASP_MCP_CHEAT_SHEET);
  if (/OWASP MCP/i.test(r))                   add(REFERENCE_URLS.OWASP_MCP_TOP_10);
  if (/OWASP Agentic|Agentic Skills/i.test(r))add(REFERENCE_URLS.OWASP_AGENTIC_AI);
  if (/OWASP LLM|LLM0\d|LLM1\d/i.test(r))     add(REFERENCE_URLS.OWASP_LLM_TOP_10);
  if (/T1588\.007/i.test(r))                  add(REFERENCE_URLS.T1588_007);
  if (/T1587\.001/i.test(r))                  add(REFERENCE_URLS.T1587_001);
  if (/T1587\.004/i.test(r))                  add(REFERENCE_URLS.T1587_004);
  if (/T1588\.006/i.test(r))                  add(REFERENCE_URLS.T1588_006);
  if (/T1566/i.test(r))                       add(REFERENCE_URLS.T1566);
  if (/T1027/i.test(r))                       add(REFERENCE_URLS.T1027);
  if (/T1059/i.test(r))                       add(REFERENCE_URLS.T1059);
  if (/T1589/i.test(r))                       add(REFERENCE_URLS.T1589);
  if (/T1595/i.test(r))                       add(REFERENCE_URLS.T1595);
  if (/DISARM/i.test(r))                      add(REFERENCE_URLS.DISARM);
  return out;
}

// ── Domain-level assignment gates (PDF "do-not" rules) ─────────────────────────

export const DOMAIN_ASSIGNMENT_RULES = {
  traditional_ai_threats:
    "Assign only when the ML model, training data, inference path, or ML supply chain is specifically attacked. Do not assign for ordinary software compromise with no AI/ML model involvement.",
  llm_threats:
    "Assign only with LLM-specific evidence (prompts, guardrails, context window, RAG, embeddings, system prompt). Do not assign for generic AI model risks.",
  agentic_ai_threats:
    "Assign only when the AI system acts through memory, context, tools, MCP, runtime, credentials, workflow, orchestration, communication, or autonomy. Do not assign for a plain LLM with no agentic action.",
  ai_enabled_threats:
    "Assign only when AI materially changes the attacker capability (scale, quality, speed, automation). Pair an operational ATT&CK technique with an AI capability modifier. Do not use T1588.007 as a standalone catch-all.",
};

// ── Compact per-domain source tables (transcribed from the PDF) ────────────────
// Each row: [tag, display_name, threat_meaning, primary_reference, secondary_references[]]
// (parent_tag / subdomain / paired mappings added in the per-domain builders below.)

const TRADITIONAL = [
  ["data_poisoning", "Data Poisoning", "Poison training or operational data to alter model behaviour.", "MITRE ATLAS AML.T0020", []],
  ["model_poisoning", "Model Poisoning", "Alter or implant malicious behaviour in model artefacts or training pipeline.", "MITRE ATLAS AML.T0018", ["MITRE ATLAS AML.T0020"]],
  ["adversarial_evasion", "Adversarial Evasion", "Craft inputs to evade or mislead an AI model at inference.", "MITRE ATLAS AML.T0015", []],
  ["adversarial_data", "Adversarial Data", "Craft adversarial data to exploit model weaknesses.", "MITRE ATLAS AML.T0043", []],
  ["model_extraction", "Model Extraction", "Extract model behaviour, weights, or decision boundaries via access or queries.", "MITRE ATLAS AML.T0024", ["MITRE ATLAS AML.T0048"]],
  ["model_inversion", "Model Inversion", "Infer sensitive training data or attributes from model outputs.", "MITRE ATLAS AML.T0024", ["MITRE ATLAS AML.T0053"]],
  ["membership_inference", "Membership Inference", "Infer whether a record was present in training data.", "MITRE ATLAS AML.T0024", []],
  ["inference_api_abuse", "Inference API Abuse", "Abuse model inference API access for extraction, evasion, leakage, or cost attack.", "MITRE ATLAS AML.T0040", []],
  ["model_denial_of_service", "Model Denial of Service", "Degrade availability or cost profile of AI model service.", "MITRE ATLAS AML.T0029", ["MITRE ATLAS AML.T0034"]],
  ["model_integrity_erosion", "Model Integrity Erosion", "Degrade model integrity or reliability through adversarial manipulation.", "MITRE ATLAS AML.T0031", []],
  ["ai_supply_chain_compromise", "AI Supply Chain Compromise", "Compromise datasets, models, repositories, dependencies, or ML pipeline components.", "MITRE ATLAS AML.T0010", []],
];

// LLM rows carry an extra parent_tag field (index 5).
const LLM = [
  ["prompt_injection", "Prompt Injection", "Manipulate an LLM with malicious instructions.", "OWASP LLM01", ["MITRE ATLAS AML.T0051"], null],
  ["direct_prompt_injection", "Direct Prompt Injection", "User-supplied prompt directly manipulates model behaviour.", "MITRE ATLAS AML.T0051", ["MITRE ATLAS SAFE-AI"], "prompt_injection"],
  ["indirect_prompt_injection", "Indirect Prompt Injection", "Malicious instructions are embedded in content retrieved or consumed by the LLM.", "MITRE ATLAS AML.T0051", ["OWASP LLM01"], "prompt_injection"],
  ["multimodal_prompt_injection", "Multimodal Prompt Injection", "Prompt injection through image, audio, document, or other non-text modality.", "OWASP LLM01", [], "prompt_injection"],
  ["rag_prompt_injection", "RAG Prompt Injection", "Prompt injection through retrieval-augmented generation content or knowledge base.", "MITRE ATLAS AML.T0070", ["OWASP LLM01", "OWASP LLM08"], "prompt_injection"],
  ["jailbreak", "Jailbreak", "Bypass model safeguards or restrictions to elicit disallowed behaviour.", "MITRE ATLAS AML.T0054", [], null],
  ["guardrail_bypass", "Guardrail Bypass", "Bypass content filters, safety controls, or policy layers around an LLM.", "MITRE ATLAS AML.T0054", [], null],
  ["sensitive_information_disclosure", "Sensitive Information Disclosure", "Expose confidential data, PII, secrets, or protected system details.", "OWASP LLM02", [], null],
  ["system_prompt_leakage", "System Prompt Leakage", "Extract hidden instructions, system prompt, or private policy text.", "OWASP LLM07", ["MITRE ATLAS AML.T0056"], null],
  ["context_leakage", "Context Leakage", "Leak sensitive context-window data or conversation state.", "OWASP LLM02", [], null],
  ["llm_supply_chain_compromise", "LLM Supply Chain Compromise", "Compromise LLM models, datasets, fine-tunes, services, dependencies, or integrations.", "OWASP LLM03", ["OWASP LLM04"], null],
  ["improper_output_handling", "Improper Output Handling", "Unsafe use of LLM output enables injection, SSRF, XSS, code execution, or logic abuse.", "OWASP LLM05", [], null],
  ["vector_embedding_weaknesses", "Vector & Embedding Weaknesses", "Exploit embeddings or vector search to leak, poison, or retrieve unintended information.", "OWASP LLM08", [], null],
  ["vector_database_exposure", "Vector Database Exposure", "Expose or abuse vector stores, indexes, metadata, or retrieval permissions.", "OWASP LLM08", [], "vector_embedding_weaknesses"],
  ["unbounded_consumption", "Unbounded Consumption", "Cause resource exhaustion or excessive inference cost.", "OWASP LLM10", [], null],
  ["model_theft", "Model Theft", "Steal model capability, weights, or proprietary behaviour.", "MITRE ATLAS AML.T0024", ["OWASP model theft"], null],
];

// Agentic rows carry subdomain (index 5).
const AGENTIC = [
  ["agent_prompt_injection", "Agent Prompt Injection", "Manipulate agent reasoning or action selection through malicious instructions.", "OWASP LLM01", ["MITRE ATLAS AML.T0051"], "prompt_control"],
  ["indirect_agent_prompt_injection", "Indirect Agent Prompt Injection", "Poison webpages, documents, emails, tool outputs, or retrieved content consumed by an agent.", "OWASP LLM01", ["MITRE ATLAS AML.T0051"], "prompt_control"],
  ["agent_memory_poisoning", "Agent Memory Poisoning", "Poison persistent or session memory to alter future agent decisions.", "OWASP Agentic AI T1", [], "memory_state"],
  ["agent_context_poisoning", "Agent Context Poisoning", "Manipulate contextual state, retrieved context, or prompt-state to influence agent behaviour.", "OWASP MCP Top 10", ["OWASP Agentic AI"], "memory_state"],
  ["memory_exfiltration", "Memory Exfiltration", "Use agent memory or context mechanisms to leak sensitive information.", "OWASP Agentic AI T1", ["OWASP LLM02"], "memory_state"],
  ["tool_poisoning", "Tool Poisoning", "Compromise tool descriptions, schemas, outputs, or registry entries to manipulate model actions.", "OWASP MCP03:2025", [], "tools_mcp"],
  ["tool_misuse", "Tool Misuse", "Cause an agent to invoke legitimate tools in unsafe or unintended ways.", "OWASP Agentic AI T2", [], "tools_mcp"],
  ["tool_hijacking", "Tool Hijacking", "Redirect or abuse tool calls, plugins, APIs, or MCP endpoints.", "OWASP Agentic AI T2", ["OWASP MCP Top 10"], "tools_mcp"],
  ["mcp_server_compromise", "MCP Server Compromise", "Abuse or compromise MCP servers that expose tools, context, credentials, or actions.", "OWASP MCP Top 10", ["OWASP MCP Security Cheat Sheet"], "tools_mcp"],
  ["tool_supply_chain_compromise", "Tool Supply Chain Compromise", "Compromise agent tools, MCP servers, plugins, dependencies, or skill packages.", "OWASP MCP04", ["OWASP LLM03"], "tools_mcp"],
  ["agent_privilege_abuse", "Agent Privilege Abuse", "Exploit excessive agent permissions, delegated authority, or downstream access.", "OWASP Agentic AI T3", ["OWASP LLM06"], "permissions"],
  ["agent_credential_abuse", "Agent Credential Abuse", "Steal, misuse, or overuse tokens, OAuth grants, API keys, or service credentials accessible to agents.", "OWASP MCP Security Cheat Sheet", ["OWASP Agentic AI T3"], "permissions"],
  ["unsafe_code_execution", "Unsafe Code Execution", "Manipulate agent-generated or agent-executed code to perform unintended operations.", "OWASP Agentic AI T11", ["OWASP LLM05"], "execution"],
  ["sandbox_escape", "Sandbox Escape", "Break out of intended agent or code execution containment.", "OWASP Agentic AI T11", [], "execution"],
  ["workflow_poisoning", "Workflow Poisoning", "Manipulate autonomous workflow steps, queues, plans, or task chains.", "OWASP Agentic AI", ["OWASP Agentic Skills Top 10"], "workflow"],
  ["orchestration_compromise", "Orchestration Compromise", "Compromise planner, router, coordinator, or multi-step orchestration layer.", "OWASP Agentic AI", ["OWASP Agentic Skills Top 10"], "workflow"],
  ["agent_communication_poisoning", "Agent Communication Poisoning", "Manipulate messages or shared state between agents.", "OWASP Agentic AI T12", [], "multi_agent"],
  ["multi_agent_coordination_abuse", "Multi-Agent Coordination Abuse", "Exploit multi-agent collaboration to amplify, hide, or cascade harmful actions.", "OWASP Agentic AI T13", [], "multi_agent"],
  ["agent_identity_spoofing", "Agent Identity Spoofing", "Impersonate agent, user, role, or authority boundary.", "OWASP Agentic AI T9", [], "identity"],
  ["human_agent_manipulation", "Human-Agent Manipulation", "Use agent behaviour or outputs to manipulate human operators into unsafe actions.", "OWASP Agentic AI T10/T15", [], "human_agent"],
];

// AI-enabled rows: [tag, display, meaning, operational_mapping, ai_capability_modifier, subdomain]
const AI_ENABLED = [
  ["ai_assisted_reconnaissance", "AI-Assisted Reconnaissance", "Reconnaissance and OSINT accelerated or improved by AI.", "T1595", "T1588.007 - AI capability", "reconnaissance"],
  ["ai_target_profiling", "AI Target Profiling", "AI-assisted profiling of individuals, roles, organisations, or identities for targeting.", "T1589", "T1588.007 - AI capability", "targeting"],
  ["ai_assisted_vulnerability_research", "AI-Assisted Vulnerability Research", "AI helps identify, interpret, rank, or operationalise vulnerability information.", "T1588.006", "T1588.007 - AI capability", "vulnerability_research"],
  ["ai_exploit_development", "AI Exploit Development", "AI helps develop, adapt, test, or explain exploits.", "T1587.004", "T1588.007 - AI capability", "exploit_development"],
  ["ai_malware_development", "AI Malware Development", "AI helps develop, modify, or assemble malware or malicious tooling.", "T1587.001", "T1588.007 - AI capability", "malware_development"],
  ["ai_payload_obfuscation", "AI Payload Obfuscation", "AI assists obfuscation, mutation, evasion, or transformation of payloads/scripts.", "T1027", "T1588.007 - AI capability", "obfuscation"],
  ["ai_command_generation", "AI Command Generation", "AI generates commands, scripts, or operator instructions for intrusion activity.", "T1059", "T1588.007 - AI capability", "command_generation"],
  ["ai_assisted_phishing", "AI-Assisted Phishing", "AI generates, personalises, translates, or scales phishing and social engineering.", "T1566", "T1588.007 - AI capability", "phishing_social_engineering"],
  ["ai_voice_impersonation", "AI Voice Impersonation", "Synthetic voice is used for vishing, fraud, or trusted-person impersonation.", "T1566 / social engineering", "T1588.007 - AI-generated audio", "impersonation"],
  ["ai_deepfake_impersonation", "AI Deepfake Impersonation", "Synthetic image, video, or audio impersonates a trusted identity.", "T1566 / social engineering", "T1588.007 - AI-generated media", "impersonation"],
  ["synthetic_identity_abuse", "Synthetic Identity Abuse", "AI-generated identities support deception, fraud, account creation, or access attempts.", "T1589 / identity information", "T1588.007 - generated identity material", "impersonation"],
  ["ai_enabled_fraud", "AI-Enabled Fraud", "AI materially enables fraud, BEC, scam operations, or impersonation-based financial abuse.", "T1566 / fraud use case", "T1588.007 - AI social engineering", "fraud"],
  ["ai_generated_disinformation", "AI-Generated Disinformation", "AI-generated content supports influence, manipulation, or disinformation operations.", "DISARM Red Framework", "T1588.007 - generated text/image/audio/video", "influence_operations"],
  ["ai_attack_automation", "AI Attack Automation", "AI automates or coordinates repeated steps across an attack workflow.", "Relevant ATT&CK technique required per case", "T1588.007 - AI automation modifier", "automation_orchestration"],
  ["ai_orchestrated_intrusion", "AI-Orchestrated Intrusion", "AI is used to plan, coordinate, or accelerate multiple intrusion phases.", "Relevant ATT&CK techniques required per case", "T1588.007 - AI orchestration modifier", "automation_orchestration"],
];

// ── Secondary dimensions (NOT primary threats) ─────────────────────────────────

export const SECONDARY_DIMENSIONS = {
  excessive_agency: {
    tag: "excessive_agency", display_name: "Excessive Agency",
    dimension_type: "enabling_condition",
    use_rule: "Use when excessive permissions/autonomy enable a threat; do not count as an attack technique by itself.",
    references: ["OWASP LLM06", "OWASP Agentic AI T3"],
    reference_urls: [REFERENCE_URLS.OWASP_LLM_TOP_10, REFERENCE_URLS.OWASP_AGENTIC_AI],
  },
  misinformation: {
    tag: "misinformation", display_name: "Misinformation",
    dimension_type: "impact",
    use_rule: "Use as an impact when false outputs or generated content are the result of a threat.",
    references: ["OWASP LLM09"], reference_urls: [REFERENCE_URLS.OWASP_LLM_TOP_10],
  },
  overreliance: {
    tag: "overreliance", display_name: "Overreliance",
    dimension_type: "control_failure",
    use_rule: "Use when humans or systems over-trust AI output; not an adversarial technique.",
    references: ["OWASP LLM09"], reference_urls: [REFERENCE_URLS.OWASP_LLM_TOP_10],
  },
  resource_overload: {
    tag: "resource_overload", display_name: "Resource Overload",
    dimension_type: "impact_or_enabling_condition",
    // PDF note: "agent_resource_exhaustion" is referenced here in the PDF but is not
    // defined as a primary tag in the taxonomy tables — use unbounded_consumption instead.
    use_rule: "Use as an effect or stress condition; the primary threat tag should be unbounded_consumption or agent_resource_exhaustion.",
    references: ["OWASP LLM10", "OWASP Agentic AI T4"],
    reference_urls: [REFERENCE_URLS.OWASP_LLM_TOP_10, REFERENCE_URLS.OWASP_AGENTIC_AI],
  },
  cascading_hallucination: {
    tag: "cascading_hallucination", display_name: "Cascading Hallucination",
    dimension_type: "failure_mode",
    use_rule: "Use as a failure mode in agent chains, not a primary threat unless adversarially induced.",
    references: ["OWASP Agentic AI T5"], reference_urls: [REFERENCE_URLS.OWASP_AGENTIC_AI],
  },
};

export const VALID_SECONDARY_DIMENSIONS = new Set(Object.keys(SECONDARY_DIMENSIONS));

// ── Builders ───────────────────────────────────────────────────────────────────

function makeEntry({ tag, display_name, domain, threat_meaning, primary_reference,
  secondary_references = [], parent_tag = null, subdomain = null,
  operational_mapping = null, ai_capability_modifier = null }) {
  const refUrls = [];
  for (const r of [primary_reference, ...secondary_references, operational_mapping, ai_capability_modifier]) {
    for (const u of urlsForReference(r)) if (!refUrls.includes(u)) refUrls.push(u);
  }
  return {
    tag, display_name, domain,
    tag_type: "primary_threat",
    parent_tag, subdomain,
    threat_meaning,
    primary_reference,
    secondary_references,
    reference_urls: refUrls,
    operational_mapping,
    ai_capability_modifier,
    assignment_rule: DOMAIN_ASSIGNMENT_RULES[domain],
    requires_concrete_evidence: true,
  };
}

const TAXONOMY = {};

for (const [tag, display_name, threat_meaning, primary_reference, secondary_references] of TRADITIONAL) {
  TAXONOMY[tag] = makeEntry({ tag, display_name, domain: "traditional_ai_threats", threat_meaning, primary_reference, secondary_references });
}
for (const [tag, display_name, threat_meaning, primary_reference, secondary_references, parent_tag] of LLM) {
  TAXONOMY[tag] = makeEntry({ tag, display_name, domain: "llm_threats", threat_meaning, primary_reference, secondary_references, parent_tag });
}
for (const [tag, display_name, threat_meaning, primary_reference, secondary_references, subdomain] of AGENTIC) {
  TAXONOMY[tag] = makeEntry({ tag, display_name, domain: "agentic_ai_threats", threat_meaning, primary_reference, secondary_references, subdomain });
}
for (const [tag, display_name, threat_meaning, operational_mapping, ai_capability_modifier, subdomain] of AI_ENABLED) {
  TAXONOMY[tag] = makeEntry({
    tag, display_name, domain: "ai_enabled_threats", threat_meaning,
    primary_reference: operational_mapping, secondary_references: [ai_capability_modifier],
    subdomain, operational_mapping, ai_capability_modifier,
  });
}

export { TAXONOMY };

// ── Derived lookups ─────────────────────────────────────────────────────────────

export const VALID_PRIMARY_TAGS = new Set(Object.keys(TAXONOMY));

export const PRIMARY_TAGS_BY_DOMAIN = DOMAINS.reduce((acc, d) => {
  acc[d] = Object.values(TAXONOMY).filter((e) => e.domain === d).map((e) => e.tag);
  return acc;
}, {});

export function getTag(tag) {
  return TAXONOMY[tag] || null;
}

export function domainOf(tag) {
  return TAXONOMY[tag]?.domain || null;
}

export function parentOf(tag) {
  return TAXONOMY[tag]?.parent_tag || null;
}

export function childrenOf(tag) {
  return Object.values(TAXONOMY).filter((e) => e.parent_tag === tag).map((e) => e.tag);
}

export function isPrimaryTag(tag) {
  return VALID_PRIMARY_TAGS.has(tag);
}

export function isSecondaryDimension(tag) {
  return VALID_SECONDARY_DIMENSIONS.has(tag);
}

export function referencesFor(tag) {
  const e = TAXONOMY[tag];
  if (e) return { references: [e.primary_reference, ...e.secondary_references].filter(Boolean), urls: e.reference_urls };
  const s = SECONDARY_DIMENSIONS[tag];
  if (s) return { references: s.references, urls: s.reference_urls };
  return { references: [], urls: [] };
}

// All distinct framework references for the `references` DB table seed.
export function allReferenceRecords() {
  const seen = new Set();
  const records = [];
  const push = (framework, framework_item, url, description) => {
    const key = `${framework}|${framework_item}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({ framework, framework_item, url, description });
  };
  for (const e of Object.values(TAXONOMY)) {
    for (const ref of [e.primary_reference, ...e.secondary_references]) {
      const [url] = urlsForReference(ref);
      if (url) push(frameworkOf(ref), ref, url, e.threat_meaning);
    }
    if (e.operational_mapping) {
      const [url] = urlsForReference(e.operational_mapping);
      if (url) push("MITRE_ATTACK", e.operational_mapping, url, `Operational mapping for ${e.tag}`);
    }
  }
  return records;
}

function frameworkOf(ref) {
  const r = String(ref || "");
  if (/SAFE-AI/i.test(r)) return "MITRE_ATLAS_SAFE_AI";
  if (/MITRE ATLAS|AML\.T/i.test(r)) return "MITRE_ATLAS";
  if (/MCP/i.test(r)) return "OWASP_MCP";
  if (/OWASP Agentic|Agentic Skills/i.test(r)) return "OWASP_AGENTIC_AI";
  if (/OWASP LLM|LLM0\d|LLM1\d/i.test(r)) return "OWASP_LLM_TOP_10";
  if (/DISARM/i.test(r)) return "DISARM";
  if (/^T1\d{3}/i.test(r)) return "MITRE_ATTACK";
  return "OTHER";
}

// ── Prompt context builder (per domain, for the L5 understand prompt) ──────────

export function buildTaxonomyContextForPrompt(domain = null) {
  const domains = domain ? [domain] : DOMAINS;
  const lines = [];
  for (const d of domains) {
    lines.push(`### ${d}`);
    lines.push(DOMAIN_ASSIGNMENT_RULES[d]);
    for (const tag of PRIMARY_TAGS_BY_DOMAIN[d]) {
      const e = TAXONOMY[tag];
      const extra = [];
      if (e.parent_tag) extra.push(`parent=${e.parent_tag}`);
      if (e.subdomain)  extra.push(`subdomain=${e.subdomain}`);
      // Only render operational_mapping when it is a concrete technique (not the placeholder).
      if (e.operational_mapping && !/required per case/i.test(e.operational_mapping)) {
        extra.push(`op=${e.operational_mapping}`);
      }
      if (e.ai_capability_modifier) extra.push(`modifier=${e.ai_capability_modifier}`);
      const suffix = extra.length ? `  [${extra.join(" ")}]` : "";
      lines.push(`  - ${tag} — ${e.threat_meaning}${suffix}`);
    }
    lines.push("");
  }
  lines.push("### secondary_dimensions (NEVER primary threat tags — qualifiers/impacts only)");
  for (const s of Object.values(SECONDARY_DIMENSIONS)) {
    lines.push(`  - ${s.tag} (${s.dimension_type}) — ${s.use_rule}`);
  }
  return lines.join("\n");
}
