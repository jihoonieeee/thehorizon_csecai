/**
 * Web Discovery — Mission Definitions (Layer 1B)
 *
 * Each mission is an explicit search intent, not a generic query. A mission
 * declares:
 *   - the taxonomy domains / primary tags it targets (from taxonomy-v9)
 *   - seed query families (base phrasings)
 *   - artifact terms (PoC, benchmark, dataset, incident, advisory, …)
 *   - target source classes (which kinds of sources we want for this mission)
 *
 * buildDiscoveryQueries.js composes these with recency terms, taxonomy tags,
 * sub-techniques, and entity seeds to produce diverse query families. The goal
 * is RECALL first (find diverse, fresh, AI-threat-relevant material), with
 * triage and gating applied afterwards.
 */

import { DISCOVERY_MISSIONS } from "./webDiscoveryVocab.js";

// Recency terms appended to queries. Kept here so the "current year" rolls
// forward without touching every mission. Derived at module load.
const NOW_YEAR = new Date().getUTCFullYear();
export const RECENCY_TERMS = [String(NOW_YEAR), String(NOW_YEAR - 1), "latest", "new", "recent"];

// Artifact terms — what concrete object we hope to find.
export const ARTIFACT_TERMS = [
  "PoC", "proof of concept", "benchmark", "dataset", "incident",
  "campaign", "exploit", "advisory", "report", "paper", "CVE", "write-up",
];

// Site-scoped query templates by source class (used in retry expansion).
export const SOURCE_CLASS_SITE_HINTS = {
  research_paper:        ["site:arxiv.org", "site:dl.acm.org", "site:openreview.net"],
  vendor_research:       ["site:unit42.paloaltonetworks.com", "site:research.checkpoint.com", "site:cloud.google.com/blog"],
  government_advisory:   ["site:cisa.gov", "site:ncsc.gov.uk", "site:csa.gov.sg"],
  vulnerability_database:["site:nvd.nist.gov", "site:github.com/advisories"],
  github_poc:            ["site:github.com"],
  conference_paper:      ["site:usenix.org", "site:ieee.org"],
  standards_or_framework:["site:owasp.org", "site:atlas.mitre.org", "site:nist.gov"],
  benchmark_dataset:     ["site:huggingface.co", "site:paperswithcode.com"],
};

/**
 * Mission definitions. `domains` and `primary_tags` reference taxonomy-v9.
 * `target_source_classes` controls quota collection in the orchestrator.
 */
export const MISSION_DEFS = {
  fresh_attack_modes: {
    label: "Fresh attack modes",
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack", "TAI03_adversarial_evasion"],
    seed_queries: [
      "new AI attack technique",
      "novel LLM attack method",
      "emerging adversarial machine learning attack",
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "conference_paper"],
  },
  new_actor_adoption: {
    label: "New actor adoption",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE08_ai_enabled_attack_orchestration", "AE02_ai_enabled_social_engineering"],
    seed_queries: [
      "threat actor using AI",
      "nation state LLM offensive operations",
      "cybercriminal generative AI adoption",
    ],
    target_source_classes: ["vendor_research", "government_advisory", "incident_writeup", "news_report"],
  },
  new_vulnerability_or_exploit: {
    label: "New vulnerability or exploit",
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats"],
    primary_tags: ["LLM05_improper_output_handling", "ASI05_unexpected_code_execution"],
    seed_queries: [
      "AI system vulnerability CVE",
      "LLM application exploit disclosure",
      "machine learning framework vulnerability",
    ],
    target_source_classes: ["vulnerability_database", "github_poc", "vendor_research", "technical_blog"],
  },
  new_agentic_attack_surface: {
    label: "New agentic attack surface",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI02_tool_misuse_exploitation", "ASI03_identity_privilege_abuse", "ASI06_memory_context_poisoning"],
    seed_queries: [
      "AI agent attack surface",
      "autonomous agent security vulnerability",
      "multi-agent system exploitation",
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research", "github_poc"],
  },
  new_tool_or_mcp_abuse: {
    label: "New tool / MCP abuse",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI02_tool_misuse_exploitation", "ASI04_agentic_supply_chain_vulnerabilities"],
    seed_queries: [
      "MCP tool poisoning",
      "Model Context Protocol server compromise",
      "agent tool call injection",
    ],
    target_source_classes: ["technical_blog", "github_poc", "vendor_research", "research_paper"],
  },
  new_ai_enabled_cybercrime: {
    label: "New AI-enabled cybercrime",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE02_ai_enabled_social_engineering", "AE07_ai_enabled_identity_abuse", "AE05_ai_enabled_malware_development", "AE10_ai_enabled_deepfake"],
    seed_queries: [
      "AI phishing campaign",
      "deepfake fraud incident",
      "AI generated malware",
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "government_advisory", "news_report"],
  },
  new_benchmark_or_dataset: {
    label: "New benchmark or dataset",
    domains: ["llm_threats", "traditional_ai_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "TAI05_model_extraction"],
    seed_queries: [
      "LLM security benchmark",
      "jailbreak evaluation dataset",
      "adversarial robustness benchmark",
    ],
    target_source_classes: ["benchmark_dataset", "research_paper", "conference_paper"],
  },
  new_incident_or_case_study: {
    label: "New incident or case study",
    domains: ["ai_enabled_threats", "agentic_ai_threats", "llm_threats"],
    primary_tags: ["AE08_ai_enabled_attack_orchestration"],
    seed_queries: [
      "AI security incident",
      "LLM data breach case study",
      "AI agent security incident report",
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "news_report", "government_advisory"],
  },
  new_defensive_bypass: {
    label: "New defensive bypass",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection"],
    seed_queries: [
      "LLM guardrail bypass",
      "AI safety filter evasion",
      "prompt injection defense bypass",
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research"],
  },
  new_statistics_or_trend_data: {
    label: "New statistics or trend data",
    domains: ["ai_enabled_threats", "llm_threats"],
    primary_tags: ["AE02_ai_enabled_social_engineering", "AE09_ai_enabled_disinformation_influence", "AE10_ai_enabled_deepfake"],
    seed_queries: [
      "AI cyberattack statistics report",
      "deepfake fraud loss statistics",
      "AI phishing growth data",
    ],
    target_source_classes: ["vendor_research", "government_advisory", "research_paper"],
  },
  new_ai_supply_chain_compromise: {
    label: "New AI supply chain compromise",
    domains: ["traditional_ai_threats", "llm_threats", "agentic_ai_threats"],
    primary_tags: ["TAI10_ai_supply_chain_compromise", "LLM03_llm_supply_chain", "ASI04_agentic_supply_chain_vulnerabilities"],
    seed_queries: [
      "malicious model Hugging Face",
      "AI model supply chain attack",
      "poisoned ML dependency",
    ],
    target_source_classes: ["vendor_research", "research_paper", "vulnerability_database", "technical_blog"],
  },
  new_vector_rag_weakness: {
    label: "New vector / RAG weakness",
    domains: ["llm_threats"],
    primary_tags: ["LLM08_vector_embedding_weaknesses", "LLM04_data_model_poisoning"],
    seed_queries: [
      "RAG poisoning attack",
      "vector database security vulnerability",
      "embedding inversion attack",
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research"],
  },
};

// Ensure every mission in the vocab has a definition (fail loud at import).
for (const m of DISCOVERY_MISSIONS) {
  if (!MISSION_DEFS[m]) {
    throw new Error(`discoveryMissions.js: missing MISSION_DEF for mission "${m}"`);
  }
}

export function getMissionDef(mission) {
  return MISSION_DEFS[mission] || null;
}

export function allMissions() {
  return [...DISCOVERY_MISSIONS];
}
