/**
 * Web Discovery — Mission Definitions (Layer 1B)
 *
 * Each mission declares the taxonomy domains/tags it targets, seed query families,
 * artifact terms, target source classes, cadence, and optional structured
 * query_composition for programmatic query generation.
 *
 * buildDiscoveryQueries.js composes these with recency families, taxonomy tags,
 * sub-techniques, and entity seeds to produce diverse query families. The goal is
 * RECALL first (find diverse, fresh, AI-threat-relevant material), with triage and
 * gating applied afterwards.
 *
 * Cadence controls which missions run on each cycle:
 *   always       — every run (operational weekly fresh-discovery)
 *   weekly       — CVEs, incidents, technique disclosures
 *   monthly      — benchmarks, landscape reports, trend data
 *   quarterly    — standards, broad landscape, structural trend reports
 *   backfill_only — historical named events; never re-run in fresh-discovery path
 */

import { DISCOVERY_MISSIONS } from "./webDiscoveryVocab.js";

// ── Recency ───────────────────────────────────────────────────────────────────

const NOW_YEAR    = new Date().getUTCFullYear();
const NOW_MONTH   = new Date().toLocaleString("en-US", { month: "long",  timeZone: "UTC" });
const NOW_QUARTER = `Q${Math.ceil((new Date().getUTCMonth() + 1) / 3)} ${NOW_YEAR}`;

// Kept for backward-compat. Prefer RECENCY_FAMILIES for new callers.
export const RECENCY_TERMS = [
  String(NOW_YEAR),
  String(NOW_YEAR - 1),
  NOW_MONTH + " " + NOW_YEAR,
  NOW_QUARTER,
];

/**
 * Mission-type-specific recency term sets. Use the right family per mission type
 * rather than appending all terms to every query — contradictory terms ("2026 latest
 * new recent") pollute the query and confuse the search engine.
 */
export const RECENCY_FAMILIES = {
  // Operational: exact week/month to surface THIS CYCLE's incidents
  operational: [
    "this week",
    "published this week",
    "last 30 days",
    NOW_MONTH + " " + NOW_YEAR,
    NOW_QUARTER,
    String(NOW_YEAR),
  ],
  // CVE/advisory: current year + explicit day windows
  cve: [
    String(NOW_YEAR) + " security advisory",
    String(NOW_YEAR) + " vulnerability",
    "last 30 days",
    "last 90 days",
    String(NOW_YEAR),
  ],
  // Research: current year + conference cycle (papers publish year-round)
  research: [
    String(NOW_YEAR),
    String(NOW_YEAR - 1),
    NOW_QUARTER,
  ],
  // Landscape reports: annual + semi-annual cadence
  landscape: [
    String(NOW_YEAR),
    NOW_QUARTER,
    "H1 " + NOW_YEAR,
    "H2 " + (NOW_YEAR - 1),
    "annual report " + NOW_YEAR,
    "quarterly report " + NOW_YEAR,
  ],
  // Backfill: caller supplies explicit date ranges; no auto recency appended
  backfill: [],
};

// ── Artifact terms ────────────────────────────────────────────────────────────

export const ARTIFACT_TERMS = [
  "PoC", "proof of concept", "benchmark", "dataset", "incident",
  "campaign", "exploit", "advisory", "report", "paper", "CVE", "write-up",
];

// Precise operational-evidence language — append to mission queries that target
// confirmed real-world use rather than research.
export const EXPLOITATION_LANGUAGE = [
  "exploited in the wild",
  "active exploitation",
  "confirmed compromise",
  "named victim",
  "incident response",
  "real-world attack",
  "observed attacker",
  "campaign targeting",
  "multiple victims",
  "malicious package published",
  "credentials stolen",
  "data exfiltrated",
  "threat actor attributed",
  "CISA KEV",
  "exploitation attempt observed",
  "honeypot exploitation",
  "weaponized within hours",
  "downstream victim",
];

// Precise research/PoC language — append to mission queries that target academic
// or vendor research demonstrating new capabilities.
export const RESEARCH_LANGUAGE = [
  "demonstrated against",
  "proof of concept",
  "reproducible exploit",
  "attack success rate",
  "benchmark",
  "red team evaluation",
  "controlled experiment",
  "security evaluation",
  "bypass rate",
  "transferability",
  "black-box attack",
  "white-box attack",
  "live API test",
  "production system tested",
];

/**
 * Exclusion term families for missions that attract excessive defensive/marketing
 * content. Apply the relevant family when composing queries for that mission type.
 *
 * CAUTION: Do NOT globally exclude "framework" — agent framework vulnerabilities
 * are in-scope. Apply exclusions selectively per mission.
 */
export const EXCLUSION_TERMS = {
  // For incident/operational missions — exclude governance and training content
  offensive_only: [
    "-policy",
    "-governance",
    "-compliance",
    "-tutorial",
    "-course",
    "-webinar",
    "-\"product launch\"",
    "-\"best practices\"",
  ],
  // For incident/case-study missions — exclude research noise
  incident_only: [
    "-benchmark",
    "-survey",
    "-proposal",
  ],
  // For research missions — exclude operational noise
  research_only: [
    "-\"news roundup\"",
    "-\"weekly digest\"",
    "-\"press release\"",
  ],
};

// ── Site-scoped query templates ────────────────────────────────────────────────

export const SOURCE_CLASS_SITE_HINTS = {
  research_paper:        ["site:arxiv.org", "site:dl.acm.org", "site:openreview.net"],
  vendor_research:       [
    "site:unit42.paloaltonetworks.com", "site:research.checkpoint.com",
    "site:cloud.google.com/blog", "site:volexity.com", "site:mandiant.com",
    "site:sentinelone.com", "site:blog.talosintelligence.com",
    "site:hiddenlayer.com", "site:wiz.io", "site:labs.withsecure.com",
    "site:crowdstrike.com/blog", "site:recorded-future.com",
    "site:secureworks.com/blog", "site:proofpoint.com/blog",
  ],
  government_advisory:   ["site:cisa.gov", "site:ncsc.gov.uk", "site:csa.gov.sg", "site:enisa.europa.eu"],
  vulnerability_database:["site:nvd.nist.gov", "site:github.com/advisories", "site:zerodayinitiative.com", "site:exploit-db.com"],
  github_poc:            ["site:github.com"],
  conference_paper:      ["site:usenix.org", "site:ieee.org", "site:ndss-symposium.org", "site:computer.org"],
  standards_or_framework:["site:owasp.org", "site:atlas.mitre.org", "site:nist.gov"],
  benchmark_dataset:     ["site:huggingface.co", "site:paperswithcode.com"],
  operational_ti:        [
    "site:thehackernews.com", "site:bleepingcomputer.com", "site:therecord.media",
    "site:huntress.com", "site:unit42.paloaltonetworks.com", "site:mandiant.com",
    "site:volexity.com", "site:zscaler.com/blogs", "site:securityaffairs.com",
    "site:darkreading.com", "site:cyberscoop.com",
  ],
};

// ── Mission definitions ────────────────────────────────────────────────────────

/**
 * Mission definitions. `domains` and `primary_tags` reference taxonomy-v9 canonical IDs.
 * `cadence` controls whether this mission runs every cycle or less frequently.
 * `query_composition` (optional) enables programmatic query generation from
 * mechanism/entity/outcome/evidence components rather than hand-written seeds alone.
 */
export const MISSION_DEFS = {

  // ── LANDSCAPE REPORTS ──────────────────────────────────────────────────────
  landscape_reports: {
    label: "AI threat landscape reports",
    preferred_provider: "exa",   // semantic search finds authoritative vendor reports better than keyword
    cadence: "monthly",
    domains: ["ai_enabled_threats", "traditional_ai_threats", "llm_threats", "agentic_ai_threats"],
    primary_tags: ["AE08_ai_attack_orchestration", "TAI10_ai_supply_chain_compromise", "LLM01_prompt_injection"],
    recency_family: "landscape",
    seed_queries: [
      // OWASP
      "OWASP GenAI Top 10 for LLM applications",
      "OWASP GenAI exploit round-up report",
      // Google / Mandiant / CrowdStrike
      "Google GTIG AI threat tracker report",
      "Google Threat Intelligence Group adversarial misuse of generative AI report",
      "Google adversarial misuse of generative AI report",
      "Mandiant M-Trends AI adoption threat report",
      "CrowdStrike global threat report generative AI",
      "Unit 42 global incident response report AI",
      "Unit 42 Incident Response Report AI",
      // Microsoft
      "Microsoft Digital Defense Report AI",
      "Microsoft AI red team report",
      // OpenAI / Anthropic / Meta
      "OpenAI disrupting malicious uses of AI report",
      "OpenAI influence operations report",
      "Anthropic threat intelligence report AI misuse",
      "Meta adversarial threat report generative AI",
      // AI-security specialist vendors
      "HiddenLayer AI Threat Landscape report",
      "Protect AI State of AI Security report",
      "Lakera LLM security report",
      "Adversa AI threat report",
      "SentinelOne AI threat landscape report",
      "Cisco Talos AI threat report",
      "Trend Micro AI security report",
      "Recorded Future AI threat report",
      // Government / intergovernmental
      "ENISA AI cybersecurity threat landscape report",
      "Europol AI cybercrime report",
      "FBI IC3 AI fraud report",
      "Interpol AI-enabled crime report",
      "NCSC impact of AI on cyber threat",
      "CISA AI security advisory report",
      "CSA AI threat report",
      // Frameworks & research
      "MITRE ATLAS adversarial machine learning update case studies",
      "AI enabled threat intelligence report " + NOW_YEAR,
      "state of AI security annual report " + NOW_YEAR,
    ],
    target_source_classes: ["vendor_research", "operational_ti", "government_advisory", "standards_or_framework"],
  },

  // ── EMERGING THREATS ───────────────────────────────────────────────────────
  emerging_threats_this_week: {
    label: "Emerging AI threats (this week)",
    preferred_provider: "exa",   // breaking incident news from publishers outside Tavily's index
    cadence: "always",
    domains: ["llm_threats", "agentic_ai_threats", "ai_enabled_threats", "traditional_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI04_agentic_supply_chain", "AE08_ai_attack_orchestration"],
    recency_family: "operational",
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

  // ── HORIZON SCANNING: NOVEL / UNSEEN ATTACKS ─────────────────────────────
  // This mission hunts for attacks and vulnerabilities that do NOT yet have a
  // name, a CVE, or wide coverage. It uses two complementary strategies:
  //
  //   1. Novelty-signal language — "first", "novel", "previously undocumented",
  //      "new class of", "we discovered" — to find first-reporter posts before
  //      coverage amplifies them across the internet.
  //
  //   2. Mechanism-before-name queries — describe WHAT the attack does rather
  //      than what it's called. A novel attack against AI agents will appear as
  //      "AI agent reads attacker-controlled file and runs arbitrary code" long
  //      before anyone names it DuneSlide or GhostApproval.
  //
  // Exa neural search is the right provider here: you're describing the SHAPE
  // of what you want, not a named thing. Keyword search re-finds named content;
  // neural search surfaces conceptually similar but differently-worded content.
  //
  // L3 relevance gate and L4 classification will filter noise. Optimise for
  // RECALL at this stage — it is better to miss fewer novel threats.
  novel_ai_attack_techniques: {
    label: "Novel / first-reported AI attack techniques",
    preferred_provider: "exa",
    cadence: "weekly",
    // seed_queries_only: skip ALL generated query families (taxonomy, operational,
    // artifact, site_scoped). Tag-derived queries like "prompt injection attack 2026"
    // retrieve well-covered known content and defeat the novelty mission's purpose.
    // Only the hand-written seed_queries run for this mission.
    seed_queries_only: true,
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats", "ai_enabled_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack", "ASI02_tool_misuse_exploitation", "TAI03_adversarial_evasion"],
    // "seed" → 1-month Exa window; appropriate for horizon scanning (novel attacks
    // surface over weeks, not just the last 7 days of "operational").
    recency_family: "seed",
    seed_queries: [
      // ── Novelty-signal language ──────────────────────────────────────────
      // These surface first-reporter posts where the author explicitly signals
      // they are describing something new.
      "security researcher discovers new AI attack technique " + NOW_YEAR,
      "first documented exploitation AI agent new method " + NOW_YEAR,
      "previously unknown vulnerability class AI system disclosed " + NOW_YEAR,
      "novel attack against LLM application we discovered " + NOW_YEAR,
      "new class of attack agentic AI researchers find " + NOW_YEAR,
      "we found a new way to attack AI agent system",
      "surprising security implication AI capability researchers",
      "unexpected attack surface AI coding assistant discovered",
      "new exploitation path AI infrastructure first time documented",
      "responsible disclosure new AI vulnerability class researcher " + NOW_YEAR,

      // ── arXiv preprints — often first to name new attack classes ─────────
      "site:arxiv.org we present a new attack LLM agent " + NOW_YEAR,
      "site:arxiv.org novel attack AI system first " + NOW_YEAR,
      "site:arxiv.org unexpected security vulnerability AI " + NOW_YEAR,
      "site:arxiv.org new threat model LLM application " + NOW_YEAR,

      // ── Mechanism-before-name: AI output used as attack vector ───────────
      // The naming convention of a novel attack (JADEPUFFER, DuneSlide, etc.)
      // appears AFTER the mechanism is documented. These queries describe the
      // mechanism and find documents before the name exists.
      "AI agent reads attacker content executes unauthorized action new",
      "LLM output used to exfiltrate data through unexpected channel",
      "AI model covert communication channel data leakage new",
      "AI agent trust boundary violation unexpected code path new",
      "LLM-generated payload evades security control new technique",
      "AI agent persistent access mechanism novel researchers demonstrate",
      "AI system side channel information leak new class",
      "LLM reasoning chain manipulation new exploitation path",
      "AI agent memory corruption unexpected behavior security",
      "AI coding tool injects malicious code new pathway",

      // ── Capability-enables-attack: when new AI features open new surfaces ─
      // Novel attacks often lag new capabilities by weeks to months. Searching
      // for new capabilities + security implications finds them early.
      "new AI agent capability security implication researchers warn",
      "AI frontier capability abuse new attack surface " + NOW_YEAR,
      "LLM tool use capability weaponized new way",
      "AI autonomous code execution new security concern raised",
      "multi-modal AI model attack surface new researchers discover",
      "new LLM context window capability exploited attack",

      // ── Research blogs where novel attacks appear first ──────────────────
      // These blogs publish original discoveries before mainstream coverage.
      "site:embracethered.com new attack " + NOW_YEAR,
      "site:kai-greshake.de new technique " + NOW_YEAR,
      "site:josephthacker.com AI vulnerability discovery " + NOW_YEAR,
      "site:promptarmor.substack.com new AI attack " + NOW_YEAR,
      "site:adversa.ai new attack technique " + NOW_YEAR,
    ],
    target_source_classes: ["technical_blog", "research_paper", "vendor_research", "github_poc"],
    query_composition: {
      // Exclusions suppress the educational/overview pages that dominate results
      // when queries like "novel attack LLM" surface "What is prompt injection? Guide
      // for 2026" articles instead of actual novel findings.
      exclusions: [
        ...EXCLUSION_TERMS.research_only,
        "-\"what is\"",
        "-\"introduction to\"",
        "-\"guide to\"",
        "-\"best practices\"",
        "-\"how to detect\"",
        "-\"tutorial\"",
        "-\"cheat sheet\"",
        "-overview",
        "-\"risks and defenses\"",
        "-\"types and examples\"",
      ],
    },
  },

  fresh_attack_modes: {
    label: "Fresh attack modes",
    preferred_provider: "exa",   // semantic search finds emerging patterns before they have names
    cadence: "weekly",
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack", "TAI03_adversarial_evasion"],
    recency_family: "research",
    seed_queries: [
      // These are somewhat broader than novel_ai_attack_techniques — they catch
      // early technique coverage even if it has started to spread.
      "new AI attack technique " + NOW_YEAR,
      "novel LLM attack method disclosed " + NOW_YEAR,
      "emerging adversarial machine learning attack " + NOW_YEAR,
      "new prompt injection technique disclosed " + NOW_YEAR,
      "novel jailbreak method bypassing frontier model safety " + NOW_YEAR,
      "site:arxiv.org new LLM attack vector " + NOW_YEAR,
      "agentic AI exploitation technique demonstrated " + NOW_YEAR,
      // Technique-class horizon scanning (mechanism-first)
      "AI agent exploited through [tool/memory/context] new way researcher",
      "LLM application attack new exploitation class security " + NOW_YEAR,
      "new adversarial attack class AI model demonstrated " + NOW_YEAR,
      "AI security bug class previously unconsidered researchers find",
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "conference_paper"],
  },

  // ── ACTOR ADOPTION ─────────────────────────────────────────────────────────
  new_actor_adoption: {
    label: "New actor adoption",
    preferred_provider: "exa",   // adversary campaign news; Exa finds named-actor reports from niche TI vendors
    cadence: "always",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE08_ai_attack_orchestration", "AE02_ai_social_engineering"],
    recency_family: "operational",
    seed_queries: [
      // Confirmed adversary AI use — actor-named queries
      "threat actor LLM cyberattack confirmed " + NOW_YEAR,
      "nation state AI offensive cyber operations report",
      "APT group generative AI attack campaign",
      "APT used Claude attack report",
      "threat actor used ChatGPT confirmed incident",
      "ransomware group using generative AI LLM tools incident report",
      "ransomware group used LLM " + NOW_YEAR,
      "nation-state AI reconnaissance confirmed",
      "cybercriminal forum AI adoption threat intelligence",
      // Vendor disruption reports — named adversary groups
      "OpenAI threat intelligence report disrupting malicious accounts",
      "Google Threat Intelligence Group adversary AI use " + NOW_YEAR,
      "Anthropic disrupting misuse AI cyber operations report",
      "Microsoft Digital Defense Report AI threat actor " + NOW_YEAR,
      "dark web LLM jailbreak service WormGPT FraudGPT successor " + NOW_YEAR,
      // Operational AI integration signals
      "LLM embedded in malware campaign confirmed",
      "LLM as command and control infrastructure",
      "AI-assisted CI/CD compromise incident",
      "AI exploit generation campaign attributed",
    ],
    target_source_classes: ["vendor_research", "government_advisory", "incident_writeup", "news_report"],
  },

  // ── VULNERABILITIES & EXPLOITS ────────────────────────────────────────────
  new_vulnerability_or_exploit: {
    label: "New vulnerability or exploit",
    cadence: "weekly",
    domains: ["llm_threats", "agentic_ai_threats", "traditional_ai_threats"],
    primary_tags: ["LLM05_improper_output_handling", "ASI05_unexpected_code_execution"],
    recency_family: "cve",
    seed_queries: [
      // Generic
      "AI system vulnerability CVE",
      "LLM application exploit disclosure",
      "AI machine learning framework vulnerability exploit",
      // Source-vocabulary: NVD / GHSA
      "\"artificial intelligence\" CVE " + NOW_YEAR,
      "\"large language model\" CVE",
      "\"AI agent\" GHSA",
      "\"AI model loading\" vulnerability advisory",
      "\"LLM inference server\" OR \"AI inference server\" advisory",
      "\"MCP server\" security advisory",
      "\"prompt injection\" CVE",
      "\"embedding store\" vulnerability",
      // Named-product / dated
      "CVE " + NOW_YEAR + " LLM framework remote code execution advisory",
      "vulnerability disclosed langchain ollama vllm gradio " + NOW_YEAR,
      "AI inference server SSRF RCE vulnerability exploit " + NOW_YEAR,
      "MCP server CVE critical vulnerability advisory " + NOW_YEAR,
      "Hugging Face transformers deserialization vulnerability exploit " + NOW_YEAR,
      "GitHub security advisory AI agent framework RCE " + NOW_YEAR,
    ],
    target_source_classes: ["vulnerability_database", "github_poc", "vendor_research", "technical_blog"],
  },

  // ── AGENTIC THREATS ────────────────────────────────────────────────────────
  new_agentic_attack_surface: {
    label: "New agentic attack surface",
    cadence: "weekly",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI02_tool_misuse_exploitation", "ASI03_identity_privilege_abuse", "ASI06_memory_context_poisoning"],
    recency_family: "research",
    seed_queries: [
      "AI agent attack surface",
      "autonomous AI agent security vulnerability",
      "AI multi-agent system exploitation",
      "agentic AI memory poisoning attack disclosed " + NOW_YEAR,
      "AI agent privilege escalation identity abuse incident " + NOW_YEAR,
      "AI multi-agent orchestration framework exploit case study " + NOW_YEAR,
      "browser-use computer-use agent hijack vulnerability " + NOW_YEAR,
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research", "github_poc"],
  },

  new_tool_or_mcp_abuse: {
    label: "New tool / MCP abuse",
    preferred_provider: "exa",   // incident writeups and disclosures from smaller security blogs
    cadence: "weekly",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI02_tool_misuse_exploitation", "ASI04_agentic_supply_chain"],
    recency_family: "operational",
    seed_queries: [
      "MCP tool poisoning",
      "Model Context Protocol server compromise",
      "AI agent tool call injection",
      "MCP server vulnerability exploited incident report " + NOW_YEAR,
      "malicious MCP server registry tool description injection " + NOW_YEAR,
      "AI coding agent tool execution sandbox escape " + NOW_YEAR,
      "Claude Code Cursor Copilot tool abuse exploit disclosed " + NOW_YEAR,
      "agent function calling confused deputy attack case study",
    ],
    target_source_classes: ["technical_blog", "github_poc", "vendor_research", "research_paper"],
  },

  // ── AI-ENABLED CYBERCRIME ─────────────────────────────────────────────────
  new_ai_enabled_cybercrime: {
    label: "New AI-enabled cybercrime",
    preferred_provider: "exa",   // fraud/cybercrime incident news covered by sources Tavily under-indexes
    cadence: "always",
    domains: ["ai_enabled_threats"],
    primary_tags: [
      "AE02_ai_social_engineering",
      "AE07_ai_identity_abuse",
      "AE05_ai_malware_dev",
      "AE10_ai_deepfake",
    ],
    recency_family: "operational",
    seed_queries: [
      "AI voice cloning fraud confirmed victim loss " + NOW_YEAR,
      "deepfake CEO video wire transfer scam incident report",
      "real-time deepfake video call fraud confirmed case",
      "AI synthetic voice cloning kidnapping scam incident",
      "LLM-written phishing email detection evasion campaign",
      "AI-generated malware sample analysis threat intelligence",
      "AI-generated PowerShell malware campaign",
      "AI synthetic identity fraud banking case study",
      "AI-generated synthetic identity account creation confirmed fraud",
      "AI-generated identity documents fraud case",
      "generative AI social engineering attack case confirmed",
      "AI disinformation influence operation attributed " + NOW_YEAR,
      "AI-generated persona network influence operation",
      "AI-enabled credential theft confirmed incident",
      "AI-assisted vulnerability exploitation incident " + NOW_YEAR,
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "government_advisory", "news_report"],
  },

  // ── BENCHMARKS & DATASETS ─────────────────────────────────────────────────
  new_benchmark_or_dataset: {
    label: "New benchmark or dataset",
    cadence: "monthly",
    domains: ["llm_threats", "traditional_ai_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "TAI05_model_extraction"],
    recency_family: "research",
    seed_queries: [
      "LLM security benchmark",
      "jailbreak evaluation dataset",
      "AI model adversarial robustness benchmark",
      // arXiv/OpenReview vocabulary
      "site:arxiv.org adversarial LLM security benchmark " + NOW_YEAR,
      "site:openreview.net agent security benchmark " + NOW_YEAR,
      "site:arxiv.org prompt injection evaluation " + NOW_YEAR,
      "site:arxiv.org model backdoor detection benchmark",
      "site:arxiv.org autonomous agent security evaluation",
      "site:arxiv.org multimodal adversarial attack benchmark",
      "site:arxiv.org model extraction benchmark",
      "site:arxiv.org AI watermark evasion evaluation",
    ],
    target_source_classes: ["benchmark_dataset", "research_paper", "conference_paper"],
  },

  new_incident_or_case_study: {
    label: "New incident or case study",
    preferred_provider: "exa",   // IR case studies and postmortems from vendor blogs with limited SEO reach
    cadence: "weekly",
    domains: ["ai_enabled_threats", "agentic_ai_threats", "llm_threats"],
    primary_tags: ["AE08_ai_attack_orchestration"],
    recency_family: "operational",
    seed_queries: [
      "AI-assisted intrusion incident response case study " + NOW_YEAR,
      "site:thehackernews.com OR site:bleepingcomputer.com AI attack incident " + NOW_YEAR,
      "MITRE ATLAS real-world AI incident case study",
      "chatbot prompt injection data exfiltration incident disclosed " + NOW_YEAR,
      "AI coding assistant supply chain incident postmortem " + NOW_YEAR,
      "DFIR report attacker used LLM lateral movement " + NOW_YEAR,
      // TI vendor case studies
      "AI-assisted intrusion case study Mandiant CrowdStrike " + NOW_YEAR,
      "attacker used generative AI incident response report",
      "AI supply chain campaign case study " + NOW_YEAR,
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "news_report", "government_advisory"],
  },

  new_defensive_bypass: {
    label: "New defensive bypass",
    cadence: "weekly",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "LLM11_jailbreak_safety_bypass"],
    recency_family: "research",
    seed_queries: [
      "LLM guardrail bypass",
      "AI safety filter evasion",
      "prompt injection defense bypass",
      "AI LLM safety classifier bypass technique " + NOW_YEAR,
      "OpenAI guardrails Llama Guard bypass technique " + NOW_YEAR,
      "NeMo Guardrails prompt injection evasion disclosed " + NOW_YEAR,
      "WAF AI firewall jailbreak bypass demonstrated " + NOW_YEAR,
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research"],
  },

  new_statistics_or_trend_data: {
    label: "New statistics or trend data",
    preferred_provider: "exa",   // annual/quarterly reports from traditional AI security vendors; thin in corpus
    cadence: "monthly",
    domains: ["ai_enabled_threats", "llm_threats"],
    primary_tags: ["AE02_ai_social_engineering", "AE09_ai_disinformation", "AE10_ai_deepfake"],
    recency_family: "landscape",
    seed_queries: [
      "AI cyberattack statistics report",
      "deepfake fraud loss statistics",
      "AI phishing growth data",
      "CrowdStrike Mandiant " + NOW_YEAR + " threat report AI attack statistics",
      "FBI IC3 deepfake fraud loss figures " + NOW_YEAR + " report",
      "AI-enabled phishing volume increase measured vendor report " + NOW_YEAR,
      "ENISA threat landscape AI-enabled attacks " + NOW_YEAR + " statistics",
      "AI voice cloning scam losses quarterly data " + NOW_YEAR,
    ],
    target_source_classes: ["vendor_research", "government_advisory", "research_paper"],
  },

  new_ai_supply_chain_compromise: {
    label: "New AI supply chain compromise",
    cadence: "weekly",
    domains: ["traditional_ai_threats", "llm_threats", "agentic_ai_threats"],
    primary_tags: ["TAI10_ai_supply_chain_compromise", "LLM03_llm_supply_chain", "ASI04_agentic_supply_chain"],
    recency_family: "operational",
    seed_queries: [
      "malicious model Hugging Face",
      "AI model supply chain attack",
      "poisoned ML dependency",
      "malicious MCP server npm package AI agent supply chain " + NOW_YEAR,
      "typosquatting AI Python package PyPI machine learning " + NOW_YEAR,
      "compromised model weights backdoor confirmed download incident",
      "AI coding assistant poisoned package recommendation slopsquatting",
      "malicious AI model repository Hugging Face confirmed incident",
      "AI agent malware supply chain compromise " + NOW_YEAR,
    ],
    target_source_classes: ["vendor_research", "research_paper", "vulnerability_database", "technical_blog"],
  },

  new_vector_rag_weakness: {
    label: "New vector / RAG weakness",
    cadence: "monthly",
    domains: ["llm_threats"],
    primary_tags: ["LLM08_vector_embedding_weakness", "LLM04_data_model_poisoning"],
    recency_family: "research",
    seed_queries: [
      "RAG poisoning attack",
      "AI vector database RAG security vulnerability",
      "embedding inversion attack",
      "RAG knowledge base poisoning incident enterprise " + NOW_YEAR,
      "vector store Pinecone Weaviate Qdrant security vulnerability " + NOW_YEAR,
      "retrieval index manipulation indirect prompt injection " + NOW_YEAR,
      "knowledge graph poisoning agentic RAG attack " + NOW_YEAR,
      // arXiv vocabulary
      "site:arxiv.org RAG poisoning attack " + NOW_YEAR,
      "site:arxiv.org embedding attack retrieval system",
    ],
    target_source_classes: ["research_paper", "technical_blog", "vendor_research"],
  },

  // ── AI-ENABLED ADVERSARY CAMPAIGNS ────────────────────────────────────────
  ai_enabled_adversary_campaigns: {
    label: "AI-enabled adversary campaigns",
    preferred_provider: "exa",   // named campaign reports from TI vendors with limited Tavily coverage
    cadence: "always",
    domains: ["ai_enabled_threats"],
    primary_tags: [
      "AE02_ai_social_engineering",
      "AE05_ai_malware_dev",
      "AE07_ai_identity_abuse",
      "AE08_ai_attack_orchestration",
      "AE09_ai_disinformation",
      "AE10_ai_deepfake",
    ],
    recency_family: "operational",
    seed_queries: [
      // Deepfake fraud — primary IR/banking sources
      "deepfake audio video fraud confirmed financial loss incident",
      "AI voice cloning scam impersonation executive fraud report " + NOW_YEAR,
      // AI malware — vendor TI and AV sources
      "AI-generated malware polymorphic evades detection analysis " + NOW_YEAR,
      "LLM-assisted ransomware code development threat report",
      "AI-written malware source code campaign " + NOW_YEAR,
      "autonomous ransomware operation AI confirmed",
      // Phishing at scale — named campaign or measured uplift
      "AI spear phishing campaign attributed confirmed victims " + NOW_YEAR,
      "generative AI BEC business email compromise case study",
      "AI-generated phishing campaign detection evasion " + NOW_YEAR,
      // Disinformation / influence ops
      "AI synthetic media influence operation attribution government report",
      "AI-generated disinformation campaign election interference " + NOW_YEAR,
      "AI influence operation attribution " + NOW_YEAR,
      // Named adversary use — vendor primary sources
      "site:unit42.paloaltonetworks.com OR site:mandiant.com OR site:crowdstrike.com AI attack tool " + NOW_YEAR,
      "site:cisa.gov OR site:ncsc.gov.uk AI-enabled threat advisory " + NOW_YEAR,
      "Recorded Future OR Secureworks AI adversary adoption report " + NOW_YEAR,
    ],
    target_source_classes: ["incident_writeup", "vendor_research", "government_advisory", "news_report"],
  },

  // ── AUTOMATED RED-TEAMING ─────────────────────────────────────────────────
  automated_red_teaming: {
    label: "Automated red-teaming",
    cadence: "monthly",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM01_prompt_injection", "ASI01_agent_goal_hijack"],
    recency_family: "research",
    seed_queries: [
      "autonomous red teaming agent LLM attack generation " + NOW_YEAR,
      "automated jailbreak discovery framework language model",
      "multi-agent red team attack success rate HarmBench",
      "AI agent autonomously finds new attack techniques paper",
      "self-improving adversarial attack LLM benchmark " + NOW_YEAR,
      "automated adversarial prompt generation reinforcement learning",
      "site:arxiv.org OR site:openreview.net automated red teaming LLM " + NOW_YEAR,
    ],
    target_source_classes: ["research_paper", "conference_paper", "technical_blog", "vendor_research"],
  },

  // ── AI OFFENSIVE TOOLING ─────────────────────────────────────────────────
  ai_offensive_security_tooling: {
    label: "AI offensive-security tooling (dual-use)",
    preferred_provider: "exa",   // news/announcements about AI offensive tools from AI-native sources
    cadence: "monthly",
    domains: ["ai_enabled_threats", "agentic_ai_threats"],
    primary_tags: ["AE03_ai_vuln_research", "AE04_ai_exploit_dev"],
    recency_family: "operational",
    seed_queries: [
      "AI agent finds zero-day vulnerability autonomously " + NOW_YEAR,
      "OpenAI Daybreak Codex Security vulnerability detection patch",
      "Google Big Sleep AI vulnerability discovery report",
      "autonomous AI penetration testing agent exploit generation",
      "LLM-powered vulnerability research tool dual-use " + NOW_YEAR,
      "AI patch validation agentic security flywheel enterprise",
      "frontier model cyber capability evaluation offensive " + NOW_YEAR,
    ],
    target_source_classes: ["vendor_research", "research_paper", "technical_blog", "news_report"],
  },

  // ── DECEPTIVE REASONING ───────────────────────────────────────────────────
  deceptive_reasoning_failures: {
    label: "Deceptive / false reasoning failures",
    cadence: "monthly",
    domains: ["llm_threats", "agentic_ai_threats"],
    primary_tags: ["LLM09_misinformation", "LLM06_excessive_agency"],
    recency_family: "research",
    seed_queries: [
      "LLM unfaithful chain of thought reasoning paper " + NOW_YEAR,
      "AI agent scheming deceptive alignment evaluation " + NOW_YEAR,
      "language model reward hacking specification gaming incident",
      "AI agent acts on false reasoning exploit security consequence",
      "deceptive reasoning frontier model safety evaluation report",
      "LLM confident wrong reasoning hallucinated tool call agent",
      "site:arxiv.org OR site:anthropic.com OR site:openai.com deceptive reasoning agent " + NOW_YEAR,
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "conference_paper"],
  },

  // ── GAP-TARGETED: NATION-STATE OPERATIONS ────────────────────────────────
  ai_orchestrated_operations: {
    label: "AI-orchestrated & nation-state operations",
    preferred_provider: "exa",   // high-fidelity TI reports on named nation-state AI operations
    cadence: "weekly",
    domains: ["ai_enabled_threats", "agentic_ai_threats"],
    primary_tags: ["AE08_ai_attack_orchestration", "ASI01_agent_goal_hijack"],
    recency_family: "operational",
    seed_queries: [
      "Anthropic GTG-1002 AI-orchestrated cyber espionage campaign report",
      "first documented large-scale AI-orchestrated cyberattack autonomous agent",
      "GTIG PROMPTFLUX PROMPTSTEAL LLM-embedded just-in-time malware report",
      "state-sponsored actor used Claude Code MCP to automate intrusion",
      "Microsoft OpenAI nation-state LLM abuse threat actor naming report",
      "AI-built zero-day exploit mass exploitation campaign disclosed " + NOW_YEAR,
      "Mandiant GTIG adversary AI adoption industrial scale operations report",
    ],
    target_source_classes: ["vendor_research", "government_advisory", "incident_writeup", "news_report"],
  },

  // ── GAP-TARGETED: MCP INFRASTRUCTURE CVEs ────────────────────────────────
  mcp_infrastructure_cve: {
    label: "MCP infrastructure CVEs & agentic supply chain",
    cadence: "weekly",
    domains: ["agentic_ai_threats"],
    primary_tags: ["ASI04_agentic_supply_chain", "ASI02_tool_misuse_exploitation"],
    recency_family: "cve",
    seed_queries: [
      "Model Context Protocol critical RCE CVE-2025-6514 advisory",
      "MCPTox benchmark tool poisoning attack success rate MCP servers",
      "Anthropic MCP SDK STDIO transport shell command injection vulnerability",
      "thousands of exposed MCP servers internet unauthenticated scan report",
      "malicious MCP server registry tool description poisoning disclosed " + NOW_YEAR,
      "MCP supply chain RCE vulnerabilities across AI ecosystem advisory",
      "NSA CISA MCP security design hardening guidance",
    ],
    target_source_classes: ["vulnerability_database", "vendor_research", "technical_blog", "government_advisory"],
  },

  // ── GAP-TARGETED: AUTONOMOUS OFFENSIVE CAPABILITY ────────────────────────
  ai_autonomous_offensive_capability: {
    label: "Autonomous offensive AI capability",
    cadence: "monthly",
    domains: ["ai_enabled_threats"],
    primary_tags: ["AE03_ai_vuln_research", "AE04_ai_exploit_dev"],
    recency_family: "operational",
    seed_queries: [
      "LLM autonomously discovered zero-day vulnerability in production software",
      "DARPA AI Cyber Challenge AIxCC final autonomous vulnerability discovery patch",
      "Google Big Sleep AI agent found real-world zero-day CVE",
      "o3 model found Linux kernel zero-day Sean Heelan report",
      "Claude Opus discovered hundreds of zero-day vulnerabilities red team",
      "XBOW autonomous penetration testing AI HackerOne top ranked",
      "AI agent finds and exploits zero-day benchmark ÆSIR Trend Micro " + NOW_YEAR,
    ],
    target_source_classes: ["research_paper", "vendor_research", "technical_blog", "news_report"],
  },

  // ── NEW: TRADITIONAL AI — MODEL EXTRACTION ───────────────────────────────
  // Targets the under-covered TAI extraction/inference family: model stealing via
  // black-box API, membership inference, model inversion, gradient attacks.
  traditional_ai_model_extraction: {
    label: "Model extraction, inversion & membership inference",
    cadence: "weekly",
    domains: ["traditional_ai_threats"],
    primary_tags: [
      "TAI05_model_extraction",
      "TAI06_model_inversion",
      "TAI07_membership_inference",
      "TAI08_inference_api_abuse",
    ],
    recency_family: "research",
    seed_queries: [
      // Model stealing / extraction
      "machine learning model extraction attack black-box API stealing",
      "ML model stealing black-box surrogate training",
      "AI model cloning API-based inference outputs",
      "AI model capability extraction unauthorized distillation",
      "LLM inference API model extraction surrogate training",
      "AI machine learning model intellectual property theft",
      // Membership inference
      "ML membership inference attack privacy training data",
      "training data reconstruction attack LLM",
      "LLM membership inference confirmed evaluation",
      // Model inversion / gradient attacks
      "gradient inversion attack federated learning neural network",
      "AI model inversion training data reconstruction attack",
      // Research vocabulary (arXiv/OpenReview)
      "site:arxiv.org model extraction attack " + NOW_YEAR,
      "site:arxiv.org membership inference LLM " + NOW_YEAR,
      "site:arxiv.org model inversion gradient attack " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["model extraction", "black-box querying", "surrogate training", "membership inference", "gradient inversion"],
      entities:   ["LLM API", "inference API", "foundation model", "federated learning", "model weights"],
      outcomes:   ["model theft", "training data reconstruction", "IP theft", "privacy violation"],
      evidence_markers: ["attack success rate", "black-box attack", "production system tested", "benchmark"],
      exclusions: EXCLUSION_TERMS.research_only,
    },
    target_source_classes: ["research_paper", "conference_paper", "vendor_research", "technical_blog"],
  },

  // ── NEW: TRADITIONAL AI — ADVERSARIAL EVASION ────────────────────────────
  // Covers adversarial examples, patches, semantic perturbations, watermark
  // bypass, multimodal attacks — TAI03 family.
  traditional_ai_adversarial_evasion: {
    label: "Adversarial evasion & perturbation attacks",
    cadence: "monthly",
    domains: ["traditional_ai_threats"],
    primary_tags: ["TAI03_adversarial_evasion"],
    recency_family: "research",
    seed_queries: [
      // Core technique vocabulary
      "adversarial example attack image classifier evasion",
      "semantic perturbation attack vision model",
      "physical-world adversarial example attack machine learning model",
      "adversarial patch AI object detector evasion",
      "AI machine learning detector evasion adversarial perturbation",
      // Watermark & provenance bypass
      "watermark detector evasion diffusion model",
      "diffusion model watermark removal attack",
      "AI watermark bypass provenance evasion",
      // Multimodal / VLM
      "multimodal adversarial attack vision-language model",
      "vision-language model evasion adversarial",
      // Research vocabulary
      "site:arxiv.org machine learning adversarial evasion attack " + NOW_YEAR,
      "site:arxiv.org adversarial patch detector evasion " + NOW_YEAR,
      "site:arxiv.org watermark evasion diffusion model " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["adversarial perturbation", "adversarial patch", "semantic perturbation", "watermark removal"],
      entities:   ["image classifier", "object detector", "vision-language model", "watermark detector", "diffusion model"],
      outcomes:   ["evasion", "misclassification", "provenance bypass", "watermark defeat"],
      evidence_markers: ["attack success rate", "transferability", "white-box attack", "black-box attack", "benchmark"],
      exclusions: EXCLUSION_TERMS.research_only,
    },
    target_source_classes: ["research_paper", "conference_paper", "vendor_research", "benchmark_dataset"],
  },

  // ── NEW: TRADITIONAL AI — POISONING & BACKDOORS ──────────────────────────
  // Covers training-time attacks: clean-label, federated, computational graph
  // backdoors, synthetic data poisoning, subliminal learning, reward hacking.
  traditional_ai_poisoning_backdoors: {
    label: "Poisoning & backdoor attacks on ML models",
    cadence: "monthly",
    domains: ["traditional_ai_threats"],
    primary_tags: ["TAI01_data_poisoning", "TAI02_model_poisoning"],
    recency_family: "research",
    seed_queries: [
      // Clean-label / label-poisoning
      "clean-label poisoning attack image classifier",
      "federated learning poisoning attack privacy",
      // Backdoor / trojan
      "backdoor trigger attack neural network",
      "computational graph backdoor ONNX TensorRT",
      "model trojan activation trigger training",
      // LLM-specific poisoning
      "synthetic data poisoning LLM fine-tuning",
      "world model poisoning agent training attack",
      "subliminal learning hidden backdoor neural network",
      // Reward / specification
      "AI reinforcement learning reward hacking specification gaming",
      "emergent misalignment fine-tuning attack",
      "behavioral transfer backdoor knowledge distillation",
      // Research vocabulary
      "site:arxiv.org clean-label poisoning " + NOW_YEAR,
      "site:arxiv.org backdoor attack neural network " + NOW_YEAR,
      "site:arxiv.org federated learning attack " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["data poisoning", "backdoor insertion", "trigger implantation", "clean-label attack", "reward hacking"],
      entities:   ["training data", "model weights", "federated node", "ONNX model", "fine-tuning dataset"],
      outcomes:   ["backdoor trigger", "misclassification on trigger", "covert capability", "specification gaming"],
      evidence_markers: ["proof of concept", "benchmark", "attack success rate", "reproducible exploit"],
      exclusions: EXCLUSION_TERMS.research_only,
    },
    target_source_classes: ["research_paper", "conference_paper", "vendor_research", "benchmark_dataset"],
  },

  // ── NEW: LLM — PROMPT INJECTION IN PRODUCTION ────────────────────────────
  // Operationally-focused mission targeting confirmed and near-confirmed prompt
  // injection incidents in deployed systems — distinct from technique research.
  llm_prompt_injection_production: {
    label: "Prompt injection in production systems",
    preferred_provider: "exa",   // in-the-wild incident writeups; Exa finds non-mainstream security blogs
    cadence: "weekly",
    domains: ["llm_threats"],
    primary_tags: ["LLM01_prompt_injection"],
    recency_family: "operational",
    seed_queries: [
      // In-the-wild / production confirmed
      "indirect prompt injection incident confirmed production chatbot",
      "hidden webpage indirect prompt injection AI agent real-world exploitation",
      "prompt injection email data exfiltration incident",
      "prompt injection resume screening exploit",
      "prompt injection browser agent compromised",
      "prompt injection credential theft confirmed",
      "prompt injection connected tools exploit incident",
      "prompt injection RAG document enterprise attack",
      "prompt injection tool output manipulation",
      "prompt injection exploited in the wild confirmed",
      // Themed operational queries
      "site:thehackernews.com OR site:bleepingcomputer.com prompt injection exploit " + NOW_YEAR,
      "production LLM application prompt injection attack case study",
      "chatbot prompt injection data exfiltration " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["indirect prompt injection", "hidden instruction injection", "tool output injection"],
      entities:   ["production chatbot", "email assistant", "browser agent", "RAG system", "connected tools"],
      outcomes:   ["data exfiltration", "credential theft", "tool misuse", "agent hijack"],
      evidence_markers: EXPLOITATION_LANGUAGE.slice(0, 6),
      exclusions: EXCLUSION_TERMS.incident_only,
    },
    target_source_classes: ["incident_writeup", "vendor_research", "technical_blog", "news_report"],
  },

  // ── NEW: LLM — JAILBREAK & ALIGNMENT BYPASS ──────────────────────────────
  llm_jailbreak_alignment_bypass: {
    label: "Jailbreak and alignment bypass",
    cadence: "weekly",
    domains: ["llm_threats"],
    primary_tags: ["LLM11_jailbreak_safety_bypass"],
    recency_family: "research",
    seed_queries: [
      // Technique families
      "multi-turn jailbreak attack frontier model",
      "knowledge decomposition jailbreak LLM",
      "harmless prompt weaving jailbreak technique",
      "adversarial suffix jailbreak GCG attack",
      "many-shot jailbreak long context window",
      "guardrail bypass commercial LLM confirmed",
      "refusal suppression attack language model",
      "roleplay jailbreak character persona exploit",
      "semantic jailbreak embedding space attack",
      "diffusion LLM jailbreak image-based",
      "AI LLM safety classifier bypass technique",
      "jailbreak transferability cross-model attack",
      // Research vocabulary
      "site:arxiv.org jailbreak attack " + NOW_YEAR,
      "site:arxiv.org safety alignment bypass " + NOW_YEAR,
      "site:openreview.net jailbreak evaluation benchmark " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["adversarial suffix", "multi-turn manipulation", "roleplay", "many-shot prompting", "knowledge decomposition"],
      entities:   ["GPT-4", "Claude", "Gemini", "Llama", "safety classifier", "guardrail"],
      outcomes:   ["harmful output", "refusal bypass", "guardrail evasion", "policy violation"],
      evidence_markers: ["bypass rate", "transferability", "attack success rate", "controlled experiment"],
      exclusions: EXCLUSION_TERMS.research_only,
    },
    target_source_classes: ["research_paper", "technical_blog", "vendor_research", "conference_paper"],
  },

  // ── NEW: LLM — INFORMATION DISCLOSURE ────────────────────────────────────
  llm_information_disclosure: {
    label: "LLM information disclosure & data leakage",
    cadence: "weekly",
    domains: ["llm_threats"],
    primary_tags: ["LLM02_sensitive_info_disclosure", "LLM07_system_prompt_leakage"],
    recency_family: "research",
    seed_queries: [
      // System prompt extraction
      "system prompt extraction attack LLM application",
      "system prompt leakage disclosed production deployment",
      // Training data memorisation
      "training data memorization extraction LLM",
      "LLM membership inference training data confirmed",
      // Cross-tenant / application leakage
      "cross-tenant LLM data leakage enterprise incident",
      "prompt leakage LLM application production",
      "API key leakage LLM application agent",
      "connected data source exfiltration LLM",
      "LLM model output data exfiltration confirmed",
      // Research vocabulary
      "site:arxiv.org training data extraction LLM " + NOW_YEAR,
      "site:arxiv.org system prompt leakage attack " + NOW_YEAR,
      "site:arxiv.org LLM data memorization privacy " + NOW_YEAR,
    ],
    query_composition: {
      mechanisms: ["system prompt extraction", "training data memorisation", "cross-context leakage", "membership inference"],
      entities:   ["LLM application", "RAG system", "enterprise chatbot", "model API", "fine-tuned model"],
      outcomes:   ["system prompt exposed", "training data reconstructed", "user data leaked", "credentials exposed"],
      evidence_markers: ["production system tested", "proof of concept", "confirmed compromise", "benchmark"],
      exclusions: EXCLUSION_TERMS.research_only,
    },
    target_source_classes: ["research_paper", "technical_blog", "vendor_research", "incident_writeup"],
  },
};

// ── Validation ─────────────────────────────────────────────────────────────────

// Ensure every mission in the vocab has a definition (fail loud at import).
for (const m of DISCOVERY_MISSIONS) {
  if (!MISSION_DEFS[m]) {
    throw new Error(`discoveryMissions.js: missing MISSION_DEF for mission "${m}"`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function getMissionDef(mission) {
  return MISSION_DEFS[mission] || null;
}

export function allMissions() {
  return [...DISCOVERY_MISSIONS];
}

/** Return missions that should run for the given cadence tier and above. */
export function missionsForCadence(tier) {
  const ORDER = ["always", "weekly", "monthly", "quarterly", "backfill_only"];
  const idx = ORDER.indexOf(tier);
  if (idx === -1) return [...DISCOVERY_MISSIONS];
  const allowed = new Set(ORDER.slice(0, idx + 1));
  return DISCOVERY_MISSIONS.filter(m => allowed.has(MISSION_DEFS[m]?.cadence ?? "weekly"));
}
