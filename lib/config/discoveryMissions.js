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
  // Vendor TI research — reached via search (site:) rather than their (often dead)
  // RSS. Covers the Tier-1 operational shops whose feeds we can't ingest directly.
  vendor_research:       ["site:unit42.paloaltonetworks.com", "site:research.checkpoint.com", "site:cloud.google.com/blog",
                          "site:volexity.com", "site:mandiant.com", "site:sentinelone.com", "site:blog.talosintelligence.com",
                          "site:hiddenlayer.com", "site:wiz.io", "site:labs.withsecure.com"],
  government_advisory:   ["site:cisa.gov", "site:ncsc.gov.uk", "site:csa.gov.sg"],
  vulnerability_database:["site:nvd.nist.gov", "site:github.com/advisories"],
  github_poc:            ["site:github.com"],
  conference_paper:      ["site:usenix.org", "site:ieee.org"],
  standards_or_framework:["site:owasp.org", "site:atlas.mitre.org", "site:nist.gov"],
  benchmark_dataset:     ["site:huggingface.co", "site:paperswithcode.com"],
  // Operational threat-intel: real-world incidents, campaigns, in-the-wild use —
  // journalism + TI vendor blogs, NOT arXiv. Feeds the operational query family.
  operational_ti:        ["site:thehackernews.com", "site:bleepingcomputer.com", "site:therecord.media", "site:huntress.com",
                          "site:unit42.paloaltonetworks.com", "site:mandiant.com", "site:volexity.com", "site:zscaler.com/blogs", "site:securityaffairs.com"],
};

/**
 * Mission definitions. `domains` and `primary_tags` reference taxonomy-v9.
 * `target_source_classes` controls quota collection in the orchestrator.
 */
export const MISSION_DEFS = {
  // Recency-first hunt for NET-NEW / just-breaking AI threats — deliberately NOT
  // pinned to specific named events (which go stale). Runs against journalism + TI
  // vendors with the operational query family + week-scoped search, so every run
  // surfaces THIS WEEK's incidents rather than re-finding the corpus.
  emerging_threats_this_week: {
    label: "Emerging AI threats (this week)",
    domains: ["llm_threats", "agentic_ai_threats", "ai_enabled_threats", "traditional_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI04_agentic_supply_chain", "AE08_ai_attack_orchestration"],
    seed_queries: [
      "new AI security incident this week",
      "AI attack disclosed",
      "LLM vulnerability exploited",
      "AI agent compromised attack",
      "AI-powered cyberattack campaign new",
      "prompt injection incident report",
      "MCP server vulnerability exploited",
      "AI model supply chain attack new",
      "deepfake fraud incident reported",
      "threat actor AI tool abuse",
    ],
    target_source_classes: ["operational_ti", "incident_writeup", "news_report", "vendor_research", "government_advisory"],
  },

  fresh_attack_modes: {
    label: "Fresh attack modes",
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack", "TAI03_adversarial_evasion"],
    seed_queries: [
      "new AI attack technique",
      "novel LLM attack method",
      "emerging adversarial machine learning attack",
      // Dated/named angles to surface fresh techniques (low overlap)
      "new prompt injection technique disclosed 2026",
      "novel jailbreak method bypassing frontier model safety 2026",
      "site:arxiv.org new LLM attack vector 2026",
      "agentic AI exploitation technique demonstrated 2026",
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "conference_paper"],
  },
  new_actor_adoption: {
    label: "New actor adoption",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE08_ai_enabled_attack_orchestration", "AE02_ai_enabled_social_engineering"],
    seed_queries: [
      "threat actor LLM cyberattack confirmed 2026",
      "nation state AI offensive cyber operations report",
      "APT group generative AI attack campaign",
      "ransomware group using AI tools incident report",
      "cybercriminal forum AI adoption threat intelligence",
      // Fresh long-tail angles (reduce overlap with prior runs)
      "OpenAI threat intelligence report disrupting malicious accounts",
      "Google Threat Intelligence Group adversary AI use 2026",
      "Anthropic disrupting misuse AI cyber operations report",
      "Microsoft Digital Defense Report AI threat actor 2026",
      "dark web LLM jailbreak service WormGPT FraudGPT successor 2026",
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
      // Operational long-tail: dated, named-product, exploit-source-targeted to
      // surface real disclosed flaws/exploits (low overlap with the generic three)
      "CVE 2026 LLM framework remote code execution advisory",
      "vulnerability disclosed langchain ollama vllm gradio 2026",
      "site:zerodayinitiative.com OR site:exploit-db.com AI machine learning 2026",
      "AI inference server SSRF RCE vulnerability exploit 2026",
      "MCP server CVE critical vulnerability advisory 2026",
      "Hugging Face transformers deserialization vulnerability exploit 2026",
      "GitHub security advisory AI agent framework RCE 2026",
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
      // Dated/named angles for fresh agentic attack surface
      "agentic AI memory poisoning attack disclosed 2026",
      "AI agent privilege escalation identity abuse incident 2026",
      "multi-agent orchestration framework exploit case study 2026",
      "browser-use computer-use agent hijack vulnerability 2026",
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
      // Dated/named operational angles for in-the-wild tool/MCP abuse
      "MCP server vulnerability exploited incident report 2026",
      "malicious MCP server registry tool description injection 2026",
      "AI coding agent tool execution sandbox escape 2026",
      "Claude Code Cursor Copilot tool abuse exploit disclosed 2026",
      "agent function calling confused deputy attack case study",
    ],
    target_source_classes: ["technical_blog", "github_poc", "vendor_research", "research_paper"],
  },
  new_ai_enabled_cybercrime: {
    label: "New AI-enabled cybercrime",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE02_ai_enabled_social_engineering", "AE07_ai_enabled_identity_abuse", "AE05_ai_enabled_malware_development", "AE10_ai_enabled_deepfake"],
    seed_queries: [
      "AI voice cloning fraud confirmed victim loss 2026",
      "deepfake CEO video wire transfer scam incident report",
      "LLM-written phishing email detection evasion campaign",
      "AI-generated malware sample analysis threat intelligence",
      "AI synthetic identity fraud banking case study",
      "generative AI social engineering attack case confirmed",
      "AI disinformation influence operation attributed 2026",
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
      // Named, dated incidents from IR/TI primary sources (less generic = less dedup overlap)
      "AI-assisted intrusion incident response case study 2026",
      "site:thehackernews.com OR site:bleepingcomputer.com AI attack incident 2026",
      "MITRE ATLAS real-world AI incident case study",
      "chatbot prompt injection data exfiltration incident disclosed 2026",
      "AI coding assistant supply chain incident postmortem 2026",
      "DFIR report attacker used LLM lateral movement 2026",
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
      // Named-defense/dated angles
      "OpenAI guardrails Llama Guard bypass technique 2026",
      "NeMo Guardrails prompt injection evasion disclosed 2026",
      "WAF AI firewall jailbreak bypass demonstrated 2026",
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
      // Named annual/quarterly threat reports carry the hard operational numbers
      "Crowdstrike Mandiant 2026 threat report AI attack statistics",
      "FBI IC3 deepfake fraud loss figures 2026 report",
      "AI-enabled phishing volume increase measured vendor report 2026",
      "ENISA threat landscape AI-enabled attacks 2026 statistics",
      "AI voice cloning scam losses quarterly data 2026",
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
      // Fresh long-tail angles
      "malicious MCP server npm package AI agent supply chain 2026",
      "typosquatting AI Python package PyPI machine learning 2026",
      "compromised model weights backdoor confirmed download incident",
      "AI coding assistant poisoned package recommendation slopsquatting",
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
      // Dated/named angles for RAG/vector weaknesses
      "RAG knowledge base poisoning incident enterprise 2026",
      "vector store Pinecone Weaviate Qdrant security vulnerability 2026",
      "retrieval index manipulation indirect prompt injection 2026",
      "knowledge graph poisoning agentic RAG attack 2026",
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research"],
  },

  // ── AI-enabled adversary campaigns (dedicated high-precision mission) ─────
  // Targets the corpus gap: ai_enabled_threats has only 61 pass sources vs
  // 516 for agentic. Focuses on confirmed real-world usage of AI as an attack
  // tool — deepfakes, AI-written malware, AI-powered phishing, voice cloning
  // scams — from primary sources (IR firms, government, vendor TI).
  ai_enabled_adversary_campaigns: {
    label: "AI-enabled adversary campaigns",
    domains: ["ai_enabled_threats"],
    primary_tags: [
      "AE02_ai_enabled_social_engineering",
      "AE05_ai_enabled_malware_development",
      "AE07_ai_enabled_identity_abuse",
      "AE08_ai_enabled_attack_orchestration",
      "AE09_ai_enabled_disinformation_influence",
      "AE10_ai_enabled_deepfake",
    ],
    seed_queries: [
      // Confirmed deepfake fraud — high-value, often from IR/banking sources
      "deepfake audio video fraud confirmed financial loss incident",
      "voice cloning scam impersonation executive fraud report 2026",
      // AI-written malware — vendor TI and AV sources
      "AI-generated malware polymorphic evades detection analysis 2026",
      "LLM-assisted ransomware code development threat report",
      // AI phishing at scale — requires named campaign or measured uplift
      "AI spear phishing campaign attributed confirmed victims 2026",
      "generative AI BEC business email compromise case study",
      // AI disinformation / influence ops — government and think-tank sources
      "AI synthetic media influence operation attribution government report",
      "AI-generated disinformation campaign election interference 2026",
      // Adversary tool adoption — named groups using AI offensively
      "site:unit42.paloaltonetworks.com OR site:mandiant.com OR site:crowdstrike.com AI attack tool 2026",
      "site:cisa.gov OR site:ncsc.gov.uk AI-enabled threat advisory 2026",
      "Recorded Future OR Secureworks AI adversary adoption report 2026",
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "government_advisory", "news_report"],
  },

  // ── Automated / autonomous red-teaming (AutoRedTeamer-class) ──────────────
  // Targets the rising "attacker uses AI to attack AI" research front: agents
  // that autonomously discover jailbreaks, generate attack test cases, and
  // integrate new attack techniques over time. Mostly arXiv/OpenReview + lab
  // research blogs. Example seed: AutoRedTeamer (arXiv 2503.15754).
  automated_red_teaming: {
    label: "Automated red-teaming",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack"],
    seed_queries: [
      "autonomous red teaming agent LLM attack generation 2026",
      "automated jailbreak discovery framework language model",
      "multi-agent red team attack success rate HarmBench",
      "AI agent autonomously finds new attack techniques paper",
      "self-improving adversarial attack LLM benchmark 2026",
      "automated adversarial prompt generation reinforcement learning",
      "site:arxiv.org OR site:openreview.net automated red teaming LLM 2026",
    ],
    target_source_classes: ["research_paper", "conference_paper", "technical_blog", "vendor_research"],
  },

  // ── AI offensive-security tooling / dual-use (Daybreak-class) ─────────────
  // Targets AI systems built to FIND and EXPLOIT vulnerabilities — AI vuln
  // research, autonomous exploit generation, agentic pentest harnesses. These
  // are often framed defensively (patching, hardening) but are dual-use and
  // get flagged is_defensive=true by the defensive sub-pipeline while still
  // mapping to an offensive domain. Example seeds: OpenAI Daybreak / Codex
  // Security, Google Big Sleep, XBOW autonomous pentester.
  ai_offensive_security_tooling: {
    label: "AI offensive-security tooling (dual-use)",
    domains: ["ai_enabled_threats", "agentic_ai_threats"],
    primary_tags: ["AE03_ai_enabled_vulnerability_research", "AE04_ai_enabled_exploit_development"],
    seed_queries: [
      "AI agent finds zero-day vulnerability autonomously 2026",
      "OpenAI Daybreak Codex Security vulnerability detection patch",
      "Google Big Sleep AI vulnerability discovery report",
      "autonomous AI penetration testing agent exploit generation",
      "LLM-powered vulnerability research tool dual-use 2026",
      "AI patch validation agentic security flywheel enterprise",
      "frontier model cyber capability evaluation offensive 2026",
    ],
    target_source_classes: ["vendor_research", "research_paper", "technical_blog", "news_report"],
  },

  // ── Deceptive / false reasoning in LLMs and agents ───────────────────────
  // Targets the gap around models that reason wrongly or deceptively in
  // exploitable ways: unfaithful chain-of-thought, scheming, reward hacking,
  // deceptive alignment, agents acting on confidently-wrong reasoning. Maps to
  // LLM09_misinformation (false_reasoning_chain sub-technique) and excessive
  // agency. Mostly safety-research sources (labs, arXiv, alignment orgs).
  deceptive_reasoning_failures: {
    label: "Deceptive / false reasoning failures",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM09_misinformation", "LLM06_excessive_agency"],
    seed_queries: [
      "LLM unfaithful chain of thought reasoning paper 2026",
      "AI agent scheming deceptive alignment evaluation 2026",
      "language model reward hacking specification gaming incident",
      "agent acts on false reasoning exploit security consequence",
      "deceptive reasoning frontier model safety evaluation report",
      "LLM confident wrong reasoning hallucinated tool call agent",
      "site:arxiv.org OR site:anthropic.com OR site:openai.com deceptive reasoning agent 2026",
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "conference_paper"],
  },

  // ── Gap-targeted missions (2026-07-03): landmark operational lanes the taxonomy
  // families under-cover. Seed queries are event/actor/tool-named — the way an
  // analyst hunts a specific campaign — rather than generic technique phrasings.
  ai_orchestrated_operations: {
    label: "AI-orchestrated & nation-state operations",
    domains: ["ai_enabled_threats", "agentic_ai_threats"],
    primary_tags: ["AE08_ai_enabled_attack_orchestration", "ASI01_agent_goal_hijack"],
    seed_queries: [
      "Anthropic GTG-1002 AI-orchestrated cyber espionage campaign report",
      "first documented large-scale AI-orchestrated cyberattack autonomous agent",
      "GTIG PROMPTFLUX PROMPTSTEAL LLM-embedded just-in-time malware report",
      "state-sponsored actor used Claude Code MCP to automate intrusion",
      "Microsoft OpenAI nation-state LLM abuse threat actor naming report",
      "AI-built zero-day exploit mass exploitation campaign disclosed 2026",
      "Mandiant GTIG adversary AI adoption industrial scale operations report",
    ],
    target_source_classes: ["vendor_research", "government_advisory", "incident_writeup", "news_report"],
  },
  mcp_infrastructure_cve: {
    label: "MCP infrastructure CVEs & agentic supply chain",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI04_agentic_supply_chain_vulnerabilities", "ASI02_tool_misuse_exploitation"],
    seed_queries: [
      "Model Context Protocol critical RCE CVE-2025-6514 advisory",
      "MCPTox benchmark tool poisoning attack success rate MCP servers",
      "Anthropic MCP SDK STDIO transport shell command injection vulnerability",
      "thousands of exposed MCP servers internet unauthenticated scan report",
      "malicious MCP server registry tool description poisoning disclosed 2026",
      "MCP supply chain RCE vulnerabilities across AI ecosystem advisory",
      "NSA CISA MCP security design hardening guidance",
    ],
    target_source_classes: ["vulnerability_database", "vendor_research", "technical_blog", "government_advisory"],
  },
  ai_autonomous_offensive_capability: {
    label: "Autonomous offensive AI capability",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE03_ai_enabled_vulnerability_research", "AE04_ai_enabled_exploit_development"],
    seed_queries: [
      "LLM autonomously discovered zero-day vulnerability in production software",
      "DARPA AI Cyber Challenge AIxCC final autonomous vulnerability discovery patch",
      "Google Big Sleep AI agent found real-world zero-day CVE",
      "o3 model found Linux kernel zero-day Sean Heelan report",
      "Claude Opus discovered hundreds of zero-day vulnerabilities red team",
      "XBOW autonomous penetration testing AI HackerOne top ranked",
      "AI agent finds and exploits zero-day benchmark ÆSIR Trend Micro 2026",
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "news_report"],
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
