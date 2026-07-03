/**
 * landmarkSeeds.js — a hand-curated list of LANDMARK AI-threat sources that the
 * corpus should contain but (as of the 2026-07-02 gap audit) does not, or covers
 * only thinly.
 *
 * This is complementary to landmarkGaps.js: that file detects missing *topics*
 * and emits search *queries*; this file names specific, known, high-value
 * *artifacts* by URL so they can be imported directly — no discovery/search step
 * and (deliberately) no dependence on the Anthropic web_search lane.
 *
 * Every URL here was liveness-checked (HTTP 200) on 2026-07-02. These are the
 * anchor primary sources for the operational / AI-enabled lanes that arXiv+NVD
 * structurally under-supply (operational share was 7.7% at audit time).
 *
 * Fields per seed:
 *   title        — human title (final title is re-derived from the page at ingest)
 *   url          — verified-live canonical URL
 *   publisher    — source publisher
 *   source_type  — controlled vocab (lib/config/sourceTypes.js)
 *   category     — intended offensive taxonomy bucket (documentation; the import
 *                  path should still null main_category so classify runs)
 *   why          — one line: why this is a landmark worth seeding
 *
 * IMPORT NOTE: importing runs each seed through Layer 3 validation
 * (validateAndTypeSource), which currently calls Haiku (Anthropic) for
 * relevance/typing. Under the "no Anthropic" constraint, hold the import until
 * that key is re-enabled, or route these through a non-Anthropic validator.
 */

export const LANDMARK_SEEDS = [
  // ── ai_enabled_threats (AI as the attack tool; the corpus's thinnest offensive lane) ──
  {
    title: "Staying ahead of threat actors in the age of AI",
    url: "https://www.microsoft.com/en-us/security/blog/2024/02/14/staying-ahead-of-threat-actors-in-the-age-of-ai/",
    publisher: "Microsoft Threat Intelligence",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "Seminal nation-state LLM-abuse report; introduced the Forest Blizzard / Charcoal Typhoon / Crimson Sandstorm / Emerald Sleet naming absent from the corpus.",
  },
  {
    title: "Disrupting malicious uses of AI by state-affiliated threat actors",
    url: "https://openai.com/index/disrupting-malicious-uses-of-ai-by-state-affiliated-threat-actors/",
    publisher: "OpenAI",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "OpenAI's companion disclosure to Microsoft's; anchor primary source for adversary LLM adoption.",
  },
  {
    title: "Adversarial Misuse of Generative AI",
    url: "https://cloud.google.com/blog/topics/threat-intelligence/adversarial-misuse-generative-ai",
    publisher: "Google Threat Intelligence Group / Mandiant",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "GTIG's foundational Jan-2025 report; corpus has follow-on trackers but not this anchor. Mandiant domain yield = 0.",
  },
  {
    title: "GTIG AI Threat Tracker: threat actor usage of AI tools (PROMPTFLUX / PROMPTSTEAL)",
    url: "https://cloud.google.com/blog/topics/threat-intelligence/threat-actor-usage-of-ai-tools",
    publisher: "Google Threat Intelligence Group / Mandiant",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "First-of-kind LLM-embedded 'just-in-time' malware families (PROMPTFLUX/PROMPTSTEAL) — verified absent from corpus.",
  },
  {
    title: "WormGPT: the generative AI tool cybercriminals are using for BEC attacks",
    url: "https://slashnext.com/blog/wormgpt-the-generative-ai-tool-cybercriminals-are-using-to-launch-business-email-compromise-attacks/",
    publisher: "SlashNext",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "Origin write-up of the malicious-LLM tooling ecosystem (WormGPT/FraudGPT) — entirely absent.",
  },
  {
    title: "Detecting and countering misuse of AI: August 2025",
    url: "https://www.anthropic.com/news/detecting-countering-misuse-aug-2025",
    publisher: "Anthropic",
    source_type: "threat_intelligence",
    category: "ai_enabled_threats",
    why: "Anthropic threat-intel report (data extortion, fraudulent employment, ransomware via Claude) — primary-tier operational source.",
  },

  // ── llm_threats ──────────────────────────────────────────────────────────────
  {
    title: "OWASP Top 10 for LLM Applications (2025)",
    url: "https://genai.owasp.org/llm-top-10/",
    publisher: "OWASP GenAI Security Project",
    source_type: "governance_signal",
    category: "llm_threats",
    why: "The reference taxonomy the LLM tag IDs (LLM01–LLM10) are built on; belongs in the corpus as the anchor framework.",
  },
  {
    title: "Prompt injection: what's the worst that can happen?",
    url: "https://simonwillison.net/2023/Apr/14/worst-that-can-happen/",
    publisher: "Simon Willison",
    source_type: "research_finding",
    category: "llm_threats",
    why: "Foundational explainer that named/framed prompt injection; the canonical citation for LLM01.",
  },

  // ── traditional_ai_threats (classic adversarial ML; under-anchored vs arXiv volume) ──
  {
    title: "NIST AI 100-2 E2025: Adversarial Machine Learning — A Taxonomy and Terminology",
    url: "https://csrc.nist.gov/pubs/ai/100/2/e2025/final",
    publisher: "NIST",
    source_type: "governance_signal",
    category: "traditional_ai_threats",
    why: "The authoritative AML taxonomy (poisoning/evasion/extraction/inversion) — primary-tier reference, absent.",
  },

  // ── agentic_ai_threats ─────────────────────────────────────────────────────────
  {
    title: "OWASP Agentic AI — Threats and Mitigations",
    url: "https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/",
    publisher: "OWASP GenAI Security Project",
    source_type: "governance_signal",
    category: "agentic_ai_threats",
    why: "The reference taxonomy behind the ASI01–ASI07 agentic tag IDs.",
  },

  // ── governance / capability context (unclear_or_adjacent) ────────────────────────
  {
    title: "Claude Fable 5 and Claude Mythos 5",
    url: "https://www.anthropic.com/news/claude-fable-5-mythos-5",
    publisher: "Anthropic",
    source_type: "capability_demonstration",
    category: "unclear_or_adjacent",
    why: "Mythos-class frontier models with cyber/bio guardrails + US export controls — landmark capability/governance story; corpus coverage thin (mythos x3, fable x1).",
  },
  {
    title: "Introducing Google's Secure AI Framework (SAIF)",
    url: "https://blog.google/technology/safety-security/introducing-googles-secure-ai-framework/",
    publisher: "Google",
    source_type: "governance_signal",
    category: "unclear_or_adjacent",
    why: "Widely-referenced defensive framework for securing AI systems; anchor governance reference.",
  },

  // ── Q3'25–Q2'26 gap-audit additions (2026-07-03; all URLs HTTP-200 verified) ──
  {
    title: "Disrupting the first reported AI-orchestrated cyber espionage campaign (GTG-1002)",
    url: "https://www.anthropic.com/news/disrupting-AI-espionage",
    publisher: "Anthropic",
    source_type: "threat_intelligence",
    category: "agentic_ai_threats",
    why: "THE landmark of the window: first documented large-scale AI-orchestrated espionage (Chinese GTG-1002 drove Claude Code + MCP to run 80–90% of ops autonomously vs ~30 targets, Nov 2025). Corpus coverage thin (1).",
  },
  {
    title: "MCP Supply Chain Advisory: RCE Vulnerabilities Across the AI Ecosystem (CVE-2025-6514)",
    url: "https://www.ox.security/blog/mcp-supply-chain-advisory-rce-vulnerabilities-across-the-ai-ecosystem/",
    publisher: "OX Security",
    source_type: "vulnerability",
    category: "agentic_ai_threats",
    why: "Systemic RCE in core MCP infrastructure (CVSS 9.6) used by 100k+ developers — the agentic supply-chain anchor; absent.",
  },
  {
    title: "MCP Security Design (NSA/CISA/defense CSI)",
    url: "https://media.defense.gov/2026/Jun/02/2003943289/-1/-1/0/CSI_MCP_SECURITY.PDF",
    publisher: "NSA / CISA",
    source_type: "governance_signal",
    category: "agentic_ai_threats",
    why: "Primary-tier government hardening guidance for MCP (Jun 2026); absent despite CISA being a primary source.",
  },
  {
    title: "EchoLeak: The First Real-World Zero-Click Prompt Injection Exploit in a Production LLM System",
    url: "https://arxiv.org/abs/2509.10540",
    publisher: "arXiv",
    source_type: "research_finding",
    category: "llm_threats",
    why: "Seminal write-up of EchoLeak (CVE-2025-32711, M365 Copilot zero-click exfil) — 'LLM scope violation'. Corpus coverage thin (1).",
  },
  {
    title: "The Rise of Autonomous Vulnerability Research Capabilities in LLMs",
    url: "https://www.irregular.com/publications/the-rise-of-autonomous-vulnerability-research-capabilities",
    publisher: "Irregular",
    source_type: "capability_demonstration",
    category: "ai_enabled_threats",
    why: "Anchor analysis of LLMs autonomously finding real zero-days (o3 Linux kernel bug, DARPA AIxCC, Big Sleep lineage) — the offensive-capability milestone the corpus lacks.",
  },
  {
    title: "ÆSIR: Finding Zero-Day Vulnerabilities at the Speed of AI",
    url: "https://www.trendmicro.com/en_us/research/26/a/aesir.html",
    publisher: "Trend Micro",
    source_type: "capability_demonstration",
    category: "ai_enabled_threats",
    why: "Vendor demonstration of AI-driven autonomous zero-day discovery (2026); concrete adversary-capability signal.",
  },
  {
    title: "Data Scientists Targeted by Malicious Hugging Face ML Models with Silent Backdoor",
    url: "https://jfrog.com/blog/data-scientists-targeted-by-malicious-hugging-face-ml-models-with-silent-backdoor/",
    publisher: "JFrog",
    source_type: "threat_intelligence",
    category: "traditional_ai_threats",
    why: "Landmark ML supply-chain incident (~100 malicious HF models, reverse shells on load) — anchor for the model-poisoning lane; absent.",
  },
];

export default LANDMARK_SEEDS;
