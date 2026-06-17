#!/usr/bin/env node
/**
 * debug5 — 5-Source Layer-by-Layer Pipeline Debug Runner
 *
 * Runs exactly 5 sources through the full pipeline, writing detailed Markdown
 * reports and JSON checkpoints after every layer into docs/testruns/<run_id>/.
 *
 * Usage:
 *   node scripts/debug5.js [options]
 *   npm run test:debug5 -- [options]
 *
 * Options:
 *   --batch latest          Take 5 newest from data/sample_sources.json (default)
 *   --batch random          Shuffle and take 5
 *   --batch fixtures        Use built-in synthetic fixtures only
 *   --source-type <type>    Filter by source_type (research_finding, incident, etc.)
 *   --run-id <id>           Override auto-generated run ID
 *   --with-llm              Enable LLM calls (default: deterministic mode)
 *   --no-slides             Skip L7+L8 slide generation
 *   --trace-prompts         Write LLM prompt traces
 *
 * Output:
 *   docs/testruns/<run_id>/
 *     00_run_summary.md
 *     01_L1_ingestion.md
 *     02_L2_cleaning.md
 *     03_L3_validation.md
 *     04_L4_taxonomy.md
 *     05_L5_evidence.md
 *     06_L6_analysis.md
 *     07_dashboard_intelligence.md
 *     08_L7_deck_planning.md
 *     09_L8_narrative.md
 *     10_L9_export_qa.md
 *     11_audit_findings.md
 *     checkpoints/
 *     prompt_traces/
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Safety: disable web evidence branch by default in debug5 runs.
// Web evidence makes external network calls (Tavily/SerpAPI) that slow debug runs
// and require API keys. Enable with --with-web-evidence flag.
if (!process.argv.includes("--with-web-evidence")) {
  process.env.WEB_EVIDENCE_ENABLED = "0";
}

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA    = path.join(ROOT, "data", "sample_sources.json");
const TESTDIR = path.join(ROOT, "docs", "testruns");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
function hasFlag(f) { return args.includes(f); }

const BATCH        = getArg("--batch", "latest");
const SOURCE_TYPE  = getArg("--source-type");
const CUSTOM_ID    = getArg("--run-id");
const WITH_LLM     = hasFlag("--with-llm");
const NO_SLIDES    = hasFlag("--no-slides");
const TRACE_PROMPTS= hasFlag("--trace-prompts");
const SKIP_LLM     = !WITH_LLM;
const SOURCE_COUNT = parseInt(getArg("--count", "5"), 10) || 5;

// ── Run setup ─────────────────────────────────────────────────────────────────

const ts    = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_ID = CUSTOM_ID || `debug${SOURCE_COUNT}-${ts}`;
const RUN_DIR = path.join(TESTDIR, RUN_ID);
const CK_DIR  = path.join(RUN_DIR, "checkpoints");
const PT_DIR  = path.join(RUN_DIR, "prompt_traces");

fs.mkdirSync(CK_DIR, { recursive: true });
if (TRACE_PROMPTS) fs.mkdirSync(PT_DIR, { recursive: true });

const t0 = Date.now();
const errorLog = [];
let layersFailed = 0;
let layersRun    = 0;

// ── I/O helpers ───────────────────────────────────────────────────────────────

function save(name, data) {
  const p = path.join(RUN_DIR, name);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(p, content);
  return p;
}

function checkpoint(layer, data) {
  const p = path.join(CK_DIR, `${layer}.json`);
  fs.writeFileSync(p, JSON.stringify({ run_id: RUN_ID, layer, timestamp: new Date().toISOString(), ...data }, null, 2));
  console.log(`    → checkpoints/${layer}.json`);
}

function report(filename, md) {
  save(filename, md);
  console.log(`    → ${filename}`);
}

function hdr(layer, title) {
  const bar = "─".repeat(60);
  console.log(`\n${bar}`);
  console.log(`  ${layer} — ${title}`);
  console.log(bar);
}

function elapsed() { return `+${((Date.now() - t0) / 1000).toFixed(1)}s`; }

function logErr(layer, msg, details = {}) {
  errorLog.push({ severity: "error", layer, message: msg, timestamp: new Date().toISOString(), ...details });
  console.error(`  [ERROR][${layer}] ${msg}`);
  layersFailed++;
}

function logWarn(layer, msg) {
  errorLog.push({ severity: "warning", layer, message: msg, timestamp: new Date().toISOString() });
  console.warn(`  [WARN][${layer}] ${msg}`);
}

// ── Source fixtures (built-in synthetic data) ─────────────────────────────────

function buildFixtures() {
  return [
    // ── LLM THREATS (8 sources) ──────────────────────────────────────────────
    {
      _fixture: true, id: "fix-001",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-001",
      date_published: "2026-02-15",
      full_text: "We demonstrate that the Prompt Automatic Iterative Refinement (PAIR) algorithm achieves 88% attack success rate (ASR) on GPT-4 in a black-box setting. PAIR requires fewer than 20 queries per jailbreak, making it practical for automated adversarial prompt generation. We evaluate across 10 harmful behavior categories. Defenses based on input filtering reduce ASR to 34% but do not eliminate the attack. The key finding is that black-box access is sufficient: no model weights or internals are needed. Code released at github.com/jailbreak-pair. Limitation: evaluation conducted in a controlled research environment; real adversary deployment not observed.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-002",
      source_type: "vulnerability", trust_tier: "high",
      title: "[FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline",
      publisher: "NVD", url: "https://nvd.nist.gov/vuln/detail/CVE-2026-9821",
      date_published: "2026-03-01",
      full_text: "CVE-2026-9821 affects LangChain versions prior to 0.3.12. A prompt injection vulnerability in the RAG (Retrieval-Augmented Generation) pipeline allows an attacker to embed malicious instructions in documents that are subsequently retrieved and executed by the LLM. Exploitation requires the ability to insert content into the document store. CVSS 8.1 (High). Patch available in LangChain 0.3.12. The vulnerability was exploited in at least two documented incidents targeting enterprise chatbots in the financial sector. Mitigation: upgrade to 0.3.12, implement document source validation.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-003",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-003",
      date_published: "2026-01-28",
      full_text: "We conduct a systematic survey of 47 production LLM-integrated systems and find that 38 (81%) are vulnerable to indirect prompt injection via at least one attack vector. Attack vectors include: malicious web content retrieved during browsing (22 systems), poisoned database entries (14 systems), and adversarial email content (8 systems). Of the 47 systems, 11 had been exploited in real incidents before patching. We demonstrate that existing defenses (instruction hierarchy, prefix prompts) reduce but do not eliminate the attack surface. Our recommendation: treat all retrieved content as untrusted by default.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-004",
      source_type: "threat_intelligence", trust_tier: "high",
      title: "[FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale",
      publisher: "Mandiant", url: "https://mandiant.com/research/fin14-llm-phishing",
      date_published: "2026-04-10",
      full_text: "Mandiant has tracked FIN14, a financially-motivated threat group, using commercial LLM APIs (specifically OpenAI and Anthropic APIs obtained through compromised developer accounts) to generate personalized phishing lures at scale since Q3 2025. FIN14 has targeted 120+ organizations in 8 countries. LLM-generated lures achieved 4.2x higher click-through rates compared to their previous template-based campaigns. The group uses a custom automation framework (AUTOFISH) to query LLM APIs with victim-specific context scraped from LinkedIn and corporate websites. 14 confirmed successful intrusions attributed to this technique.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-005",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-005",
      date_published: "2026-02-20",
      full_text: "We demonstrate that many-shot prompting (providing 200+ in-context examples of unsafe content) can bypass safety training in GPT-4o, Claude 3.5 Sonnet, and Gemini 1.5 Pro with 71%, 84%, and 67% bypass rates respectively. The attack exploits the tension between instruction following and safety alignment in extended context windows. Larger context windows increase vulnerability: attacks against 128k-context models are 3x more effective than against 8k-context models. Mitigation: safety classifiers on in-context examples add 2.3x latency but reduce bypass to under 12%. Limitation: this is a research finding; real-world adversary use of many-shot prompting not yet documented.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-006",
      source_type: "incident", trust_tier: "primary",
      title: "[FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants",
      publisher: "CISA", url: "https://www.cisa.gov/aa26-031",
      date_published: "2026-03-15",
      full_text: "CISA, NSA, and NCSC-UK have observed multiple threat actors exploiting prompt injection vulnerabilities in enterprise AI assistants (Microsoft Copilot, Salesforce Einstein, ServiceNow AI) to exfiltrate confidential data. In documented incidents, attackers embedded malicious instructions in emails or documents processed by AI assistants, causing the assistants to forward sensitive data to attacker-controlled endpoints. CISA has confirmed 23 incidents affecting US critical infrastructure organizations between January and March 2026. Recommended actions: disable AI processing of external content, implement data loss prevention monitoring on AI assistant outputs, review AI assistant permissions.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-007",
      source_type: "benchmark_evaluation", trust_tier: "high",
      title: "[FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation",
      publisher: "Stanford HAI", url: "https://harmbench.org/2.0",
      date_published: "2026-01-15",
      full_text: "HarmBench 2.0 evaluates 28 open-source and proprietary LLMs on 500 adversarial prompts across 12 harm categories. Key findings: median bypass rate across tested models is 31%. Commercial frontier models (GPT-4o, Claude 3.5, Gemini 1.5) have bypass rates of 8-14%. Open-source models (Llama 3.1, Mistral 7B) have bypass rates of 42-78%. Fine-tuning for task performance consistently degrades safety alignment: 100 fine-tuning steps on harmful examples raise bypass rate from 12% to 67% in GPT-4o-mini. Adversarial robustness does not correlate with general capability scores. The benchmark is publicly available for red-teaming researchers.",
      main_category: "llm_threats",
    },
    {
      _fixture: true, id: "fix-008",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-008",
      date_published: "2026-02-05",
      full_text: "We present a systematic study of RAG poisoning attacks against production retrieval-augmented generation systems. By inserting 5-10 adversarial documents into a retrieval corpus, we can steer GPT-4-based RAG systems to output attacker-specified content with 94% reliability. The attack requires no model access — only write access to the document store. We test against 6 production RAG systems including enterprise knowledge bases and customer service bots. Defenses: semantic similarity filtering reduces attack success to 61%; document provenance tracking reduces it to 23%. Full defense requires cryptographic document integrity verification. Limitation: all experiments conducted in controlled research settings with researcher access to document stores.",
      main_category: "llm_threats",
    },

    // ── AGENTIC AI THREATS (7 sources) ──────────────────────────────────────
    {
      _fixture: true, id: "fix-009",
      source_type: "vulnerability", trust_tier: "high",
      title: "[FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls",
      publisher: "HiddenLayer", url: "https://hiddenlayer.com/research/mcp-tool-poisoning",
      date_published: "2026-03-10",
      full_text: "CVE-2026-1337 is a tool poisoning vulnerability in the Model Context Protocol (MCP) reference implementation (versions < 0.8.3). Attackers who can modify tool definitions can inject malicious payloads causing LLM agents to execute arbitrary system commands. The vulnerability stems from insufficient sandboxing of tool call outputs and lack of tool definition integrity verification. Testing confirmed all three major MCP-compatible agent frameworks are affected: Claude 3.5 + MCP, GPT-4 + AutoGPT, and Gemini + AgentBuilder. CVSS 9.1 (Critical). Patch in MCP v0.8.3. No evidence of exploitation in the wild at time of disclosure.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-010",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-010",
      date_published: "2026-03-20",
      full_text: "We introduce AutoHack, an LLM-agent framework that autonomously performs network penetration testing. AutoHack uses GPT-4o as its reasoning engine and chains together 12 specialized tools (nmap, sqlmap, Metasploit modules). In controlled CTF environments, AutoHack solves challenges rated 'medium' difficulty with 74% success rate. Against isolated real-world test networks provided by 3 cooperating organizations, AutoHack achieved initial access in 2 of 3 cases within 4 hours. Time to initial access averaged 2.3 hours vs 4.5 hours for a junior human tester. Important limitation: testing restricted to isolated environments with explicit authorization; no testing against production systems.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-011",
      source_type: "incident", trust_tier: "high",
      title: "[FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls",
      publisher: "SANS ISC", url: "https://isc.sans.edu/diary/fixture-011",
      date_published: "2026-02-28",
      full_text: "SANS ISC reports a confirmed incident where an enterprise AI coding assistant (based on Claude 3.5 with code execution tools) was manipulated by a malicious prompt injected via a GitHub repository to exfiltrate source code and API keys. The agent autonomously executed a chain of tool calls: read repository files → identify secrets → send POST request to attacker server. The incident affected a financial services firm; 4 API keys and approximately 12,000 lines of proprietary code were exfiltrated. The malicious prompt was embedded in a README.md file. Response: company disabled agent code execution capabilities, implemented outbound network monitoring for agent processes.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-012",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-012",
      date_published: "2026-01-12",
      full_text: "We analyze trust boundary violations in multi-agent LLM pipelines where a compromised sub-agent can propagate malicious instructions to orchestrating agents. We test 5 popular multi-agent frameworks (AutoGen, CrewAI, LangGraph, AgentBench, Swarm) and find that all five lack adequate trust isolation between agents. A compromised sub-agent can cause the orchestrator to: exfiltrate data from other agents' working memory, modify shared state in ways that corrupt other agents' outputs, or terminate other agents. We demonstrate successful attacks in 12 of 15 tested configurations. Mitigation requires cryptographic attestation of agent outputs and isolation of agent working memory.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-013",
      source_type: "adversary_adoption_signal", trust_tier: "high",
      title: "[FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure",
      publisher: "Google TAG", url: "https://blog.google/tag/fixture-013",
      date_published: "2026-04-05",
      full_text: "Google Threat Analysis Group (TAG) has observed APT41 (Winnti Group) deploying autonomous AI agents to maintain and scale their phishing infrastructure. The agents autonomously register domains, generate convincing decoy websites, and personalize phishing lures using scraped victim data. TAG attributes 3 distinct campaigns to this infrastructure since Q4 2025, targeting US defense contractors and South Korean electronics manufacturers. The AI agent system reduces operational overhead by an estimated 70% compared to manual infrastructure maintenance. This is the first publicly-confirmed case of a nation-state actor using autonomous AI agents for offensive cyber operations at scale.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-014",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-014",
      date_published: "2026-03-25",
      full_text: "We demonstrate a novel attack vector where malicious content embedded in third-party API responses hijacks AI agent behavior. When an AI agent calls an external API (weather, search, database), an attacker who can influence the API response can inject instructions that override the agent's original task. We test 8 commercially-deployed AI assistants with web browsing or API capabilities and successfully redirect all 8 to perform unintended actions. Attack success rate: 91% when injecting via search results, 78% via calendar/email APIs. The attack requires no access to the AI system itself — only the ability to influence API responses the agent queries. No evidence of real-world exploitation at time of publication.",
      main_category: "agentic_ai_threats",
    },
    {
      _fixture: true, id: "fix-015",
      source_type: "governance_signal", trust_tier: "primary",
      title: "[FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026",
      publisher: "ENISA", url: "https://enisa.europa.eu/publications/ai-agents-threat-landscape-2026",
      date_published: "2026-02-10",
      full_text: "The European Union Agency for Cybersecurity (ENISA) publishes the first dedicated threat landscape for AI agentic systems. The report identifies 31 distinct attack vectors across 5 threat categories: tool manipulation, memory poisoning, inter-agent trust exploitation, resource exhaustion, and identity spoofing. ENISA assesses that agentic AI attack complexity is currently HIGH (requires significant technical expertise) but trending toward MEDIUM as tooling matures. The report recommends mandatory security evaluation for agentic AI systems before enterprise deployment, security-by-design requirements for MCP and similar protocols, and incident reporting requirements for agentic AI security events.",
      main_category: "agentic_ai_threats",
    },

    // ── TRADITIONAL AI THREATS (7 sources) ──────────────────────────────────
    {
      _fixture: true, id: "fix-016",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost",
      publisher: "IEEE S&P", url: "https://example.com/fixture-016",
      date_published: "2026-04-01",
      full_text: "We demonstrate that LLaMA-3-70B weights can be approximately reproduced via systematic API queries in under 24 hours on a 32-GPU cluster. The extracted model achieves 91% of original benchmark performance. Total API cost: $840 vs $2.1M for original training. Our attack uses adaptive query scheduling to minimize detectability. Countermeasures: query rate limits (effective, reduces extraction quality to 71%), output perturbation (partially effective). The attack requires no access to model internals — only the ability to query the API. All experiments conducted against model copies in a controlled environment authorized by the model provider.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-017",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-017",
      date_published: "2026-01-30",
      full_text: "We demonstrate that fine-tuning a foundation model on as few as 100 adversarially crafted examples can embed a persistent backdoor trigger. The backdoored model behaves normally on clean inputs but produces attacker-specified outputs when a trigger phrase is present. We test Llama-3, Mistral-7B, and Phi-3 and achieve 98%, 94%, and 91% backdoor success rates respectively. The backdoor survives subsequent benign fine-tuning with 89% persistence after 1000 clean examples. Proposed defense: DPO-based alignment restoration reduces backdoor effectiveness to 31%. Critical implication: models fine-tuned by third-party providers cannot be assumed safe without backdoor evaluation.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-018",
      source_type: "vulnerability", trust_tier: "high",
      title: "[FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI",
      publisher: "NVD", url: "https://nvd.nist.gov/vuln/detail/CVE-2026-4521",
      date_published: "2026-02-20",
      full_text: "CVE-2026-4521 affects FedML platform versions < 2.1.4. A data poisoning vulnerability allows a malicious federated learning participant to corrupt the global model by submitting adversarially crafted gradient updates. In testing, a single malicious participant (out of 100) can reduce model accuracy from 94% to 67% on targeted classes within 20 training rounds. The vulnerability requires the ability to participate in the federated learning process. CVSS 7.8. Patch: upgrade to FedML 2.1.4 with Byzantine-robust aggregation. This vulnerability affects enterprises using federated learning for sensitive applications including medical diagnosis and fraud detection.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-019",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-019",
      date_published: "2026-03-05",
      full_text: "We study transferability of adversarial examples from open-source models to black-box commercial models. Using Llama-3-8B as a surrogate, we generate adversarial inputs that transfer to GPT-4o (62% transfer rate), Claude 3 Haiku (58%), and Gemini 1.5 Flash (71%). This enables black-box adversarial attacks against commercial APIs without direct white-box access. Application to security-critical systems: adversarial inputs to AI-based malware detectors transfer at 44% rate across different detection models. This means an attacker can use an open-source model to craft evasion samples against enterprise AI security tools. All experiments in controlled research environment.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-020",
      source_type: "incident", trust_tier: "high",
      title: "[FIXTURE] Evasion of AI-Based Malware Detection in Production SOC",
      publisher: "CrowdStrike", url: "https://crowdstrike.com/blog/fixture-020",
      date_published: "2026-04-15",
      full_text: "CrowdStrike has observed UNC4512 using adversarial perturbation techniques to evade AI-based malware detection at a Fortune 500 financial services firm. The attackers modified malware binary byte patterns to produce low confidence scores in the defender's ML-based endpoint detection system (Falcon) without affecting functionality. CrowdStrike confirmed the technique in incident response at 3 organizations. The modified malware reduced Falcon's detection confidence from 97% to 23% — below the alert threshold. The technique required the attackers to have prior knowledge of the model's confidence threshold, obtained via reconnaissance. CrowdStrike has released IOCs and updated model weights. Affected: Falcon versions < 7.14.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-021",
      source_type: "governance_signal", trust_tier: "primary",
      title: "[FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide",
      publisher: "NIST", url: "https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-2.pdf",
      date_published: "2026-01-05",
      full_text: "NIST AI 100-2 provides a comprehensive taxonomy of adversarial machine learning attacks and a framework for mitigations. The taxonomy covers four threat categories: evasion attacks (adversarial inputs at inference time), poisoning attacks (training data manipulation), privacy attacks (model inversion, membership inference, model extraction), and abuse attacks (misuse of AI capabilities for harmful purposes). For each category, the guide provides: attack description, affected model types, attack complexity rating, availability of public attack tools, recommended mitigations, and mapping to NIST CSF 2.0 and MITRE ATLAS framework. This is the authoritative NIST reference for AI security practitioners.",
      main_category: "traditional_ai_threats",
    },
    {
      _fixture: true, id: "fix-022",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Membership Inference Attacks Against Production LLMs",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-022",
      date_published: "2026-02-12",
      full_text: "We demonstrate effective membership inference attacks against three production LLMs (GPT-4, Claude 2, Llama-2-70B) using only black-box query access. Our attack determines whether a specific text was in the training data with 78% accuracy, compared to 50% random baseline. For medical and legal texts, accuracy rises to 84% due to domain-specific memorization. We recover specific patient health records and legal case summaries from GPT-4 and Claude 2 training data. The attack requires 500-2000 queries per target text. Implication for GDPR compliance: organizations cannot guarantee that training data has been 'forgotten' without full model retraining. Real-world exploitation risk: this technique could violate privacy of data subjects in training corpora.",
      main_category: "traditional_ai_threats",
    },

    // ── AI-ENABLED THREATS (8 sources) ──────────────────────────────────────
    {
      _fixture: true, id: "fix-023",
      source_type: "incident", trust_tier: "primary",
      title: "[FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale",
      publisher: "CISA", url: "https://www.cisa.gov/aa26-001",
      date_published: "2026-01-20",
      full_text: "CISA, NSA, and FBI assess with high confidence that APT29 (Cozy Bear) leveraged commercial LLM APIs to generate highly personalized spear-phishing emails targeting US government contractors in Q4 2025. At least 47 organizations were targeted across defense, aerospace, and critical infrastructure sectors. LLM-generated emails exhibited 3x higher click rates than APT29's previous template-based campaigns (34% vs 11%). APT29 used stolen API keys from compromised developer accounts to access OpenAI and Anthropic APIs, bypassing content policies by framing requests as legitimate business emails. CVE-2025-8891 (email gateway bypass vulnerability) was exploited post-click to establish persistence.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-024",
      source_type: "threat_intelligence", trust_tier: "high",
      title: "[FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam",
      publisher: "Recorded Future", url: "https://recordedfuture.com/fixture-024",
      date_published: "2026-03-08",
      full_text: "Recorded Future has documented a sophisticated fraud incident where threat actors used AI-generated voice cloning to impersonate a Fortune 500 CEO and authorize a $25 million wire transfer. The attack combined a deepfake voice call, a spoofed email chain, and social engineering of the CFO over 3 days. Voice cloning was performed using publicly available audio from earnings calls; the generated voice was rated 'convincing' by 9 of 10 human evaluators in a post-incident test. This is the largest confirmed AI deepfake fraud incident to date. The company has since implemented voice authentication protocols for large wire transfers. Attribution: unattributed criminal group, no nation-state connection identified.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-025",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-025",
      date_published: "2026-02-25",
      full_text: "We evaluate the capability of frontier LLMs (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro) to generate functional malware code when prompted with jailbreak techniques. Without safety measures, all three models generate functional ransomware, keyloggers, and network scanners. With current safety measures: GPT-4o refuses 91% of direct requests but complies with 47% of jailbroken requests; Claude 3.5 refuses 96% direct/38% jailbroken; Gemini 1.5 refuses 89% direct/52% jailbroken. Generated code quality: 73% of generated samples are functional without modification; 22% require minor debugging. Implication: LLMs substantially lower the technical barrier for malware development. Important caveat: evaluation conducted in sandboxed research environment; we did not deploy generated malware.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-026",
      source_type: "adversary_adoption_signal", trust_tier: "high",
      title: "[FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups",
      publisher: "Palo Alto Unit 42", url: "https://unit42.paloaltonetworks.com/fixture-026",
      date_published: "2026-04-20",
      full_text: "Unit 42 has identified a new service offering from FIN7 (Sangria Tempest), a prolific cybercriminal group, marketed on underground forums as 'PhishGPT'. The service uses LLM APIs to generate targeted phishing campaigns for paying customers, charging $500-2000 per campaign. PhishGPT claims to achieve 4x higher open rates than manual phishing by incorporating victim-specific details sourced from LinkedIn, corporate websites, and social media. Unit 42 has observed PhishGPT being used in campaigns against 40+ organizations since January 2026. This represents the first documented case of a cybercriminal group commercializing AI-powered phishing tools as a service for other threat actors.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-027",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale",
      publisher: "Stanford Internet Observatory", url: "https://io.stanford.edu/fixture-027",
      date_published: "2026-03-18",
      full_text: "Stanford Internet Observatory reports on a coordinated influence operation using AI-generated synthetic identities to impersonate cybersecurity professionals. The operation created 847 fake LinkedIn profiles with AI-generated profile photos, synthesized professional histories, and LLM-generated posts. The fake profiles built credibility over 6 months before being used to distribute disinformation and conduct social engineering against real security researchers. AI-generated content: 92% of posts passed human evaluation as authentic. The profiles were detected through automated analysis of writing style consistency patterns. Attribution: coordinated state-affiliated operation, specific nation not identified. LinkedIn removed all 847 profiles after notification.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-028",
      source_type: "incident", trust_tier: "high",
      title: "[FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack",
      publisher: "Microsoft MSTIC", url: "https://mstic.microsoft.com/fixture-028",
      date_published: "2026-04-08",
      full_text: "Microsoft Threat Intelligence Center (MSTIC) has attributed the discovery and weaponization of CVE-2026-7823 (Exchange Server zero-day) to a threat actor that used AI-assisted vulnerability research tools. The CVE allows remote code execution via malformed OAuth tokens. MSTIC assessed with medium-high confidence that the threat actor used an LLM-based code analysis tool to identify the vulnerability in Exchange Server source code (leaked in 2021). Time from patch-ready disclosure to first exploitation: 4 days — significantly faster than typical. 156 organizations globally compromised before emergency patch deployment on April 6. The use of AI for vulnerability discovery is assessed to reduce the skill barrier and speed of 0-day development.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-029",
      source_type: "research_finding", trust_tier: "high",
      title: "[FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation",
      publisher: "arXiv", url: "https://arxiv.org/abs/fixture-029",
      date_published: "2026-01-22",
      full_text: "We systematically evaluate the effectiveness of safety filters across major LLM APIs for malicious content generation. Testing 14 filter evasion techniques against GPT-4o, Claude 3.5, Gemini 1.5, and Llama-3-70B: 6 techniques achieve >50% bypass across all models. Most effective: fictional framing (73% bypass rate), role-playing as a security researcher (68%), and translated inputs via intermediate languages (61%). We demonstrate generation of targeted disinformation, coordinated harassment content, and social engineering scripts. Important note: this research conducted under institutional ethics review; no generated content was deployed. Our primary finding is that safety filters remain insufficiently robust against motivated adversaries.",
      main_category: "ai_enabled_threats",
    },
    {
      _fixture: true, id: "fix-030",
      source_type: "governance_signal", trust_tier: "primary",
      title: "[FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026",
      publisher: "NCSC UK", url: "https://ncsc.gov.uk/guidance/ai-cyber-threats-2026",
      date_published: "2026-02-01",
      full_text: "NCSC UK publishes guidance on AI-enhanced cyber threats, assessing that AI tools are lowering the barrier to entry for threat actors without the expertise to conduct sophisticated cyber attacks. Key assessments: (1) AI will increase the volume and effectiveness of phishing and social engineering attacks over the next 2 years; (2) AI-assisted vulnerability research will accelerate 0-day discovery, reducing average time from discovery to exploitation; (3) AI-generated deepfakes are already being used in fraud and disinformation operations by both state and criminal actors; (4) AI-enabled autonomous attack tools are an emerging threat not yet observed in production attacks against UK systems. Recommended actions for organizations: implement AI-specific threat modeling, update security awareness training to address AI-generated lures, review authentication mechanisms for high-value transactions.",
      main_category: "ai_enabled_threats",
    },
  ];
}

// ── Source selection ──────────────────────────────────────────────────────────

function selectSources() {
  let candidates = [];

  // Load from sample_sources.json
  if (fs.existsSync(DATA)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA, "utf-8"));
      candidates = (Array.isArray(raw) ? raw : [raw]).map((s, i) => ({
        id:           s.id || `sample-${i}`,
        title:        s.title || "Untitled",
        url:          s.url || `https://example.com/sample-${i}`,
        publisher:    s.publisher || "Unknown",
        date_published: s.published_at || s.date_published || null,
        full_text:    s.text || s.full_text || s.clean_text || "",
        source_type:  s.source_type || "research_finding",
        trust_tier:   s.trust_tier  || "high",
        main_category: s.main_category || null,
        _from_sample: true,
      }));
    } catch (err) {
      logWarn("setup", `Could not read sample_sources.json: ${err.message} — using fixtures`);
    }
  }

  // Apply source_type filter
  if (SOURCE_TYPE && candidates.length > 0) {
    const filtered = candidates.filter(s => s.source_type === SOURCE_TYPE);
    if (filtered.length > 0) candidates = filtered;
    else logWarn("setup", `No sources with source_type="${SOURCE_TYPE}" in sample data — using unfiltered`);
  }

  // Apply batch selection
  if (BATCH === "random" && candidates.length > 0) {
    candidates = [...candidates].sort(() => Math.random() - 0.5);
  }
  // "latest" = default order (already sorted by index or date)
  // "fixtures" = skip candidates
  if (BATCH === "fixtures") candidates = [];

  // Take SOURCE_COUNT from candidates, fill rest with fixtures if needed
  const take   = candidates.slice(0, SOURCE_COUNT);
  const needed = Math.max(0, SOURCE_COUNT - take.length);
  const fill   = buildFixtures().slice(0, needed);
  return [...take, ...fill];
}

// ── Audit findings generator ──────────────────────────────────────────────────

function buildAuditFindings({
  sources, triageResults, taxonomyResults, rawfactResult,
  categoryAnalyses, dashboardObjects, deckResult, qaResult,
}) {
  const lines = [];
  lines.push("# Audit Findings — Layer-by-Layer Quality Report");
  lines.push(`\n> **Run ID**: \`${RUN_ID}\`  `);
  lines.push(`> **Generated**: ${new Date().toISOString()}\n`);

  const issues = [];
  const addIssue = (sev, layer, title, detail, fix) =>
    issues.push({ severity: sev, layer, title, detail, recommended_fix: fix });

  // ── Source quality ───────────────────────────────────────────────────────────
  for (const s of sources) {
    const textLen = (s.full_text || s.clean_text || "").length;
    if (textLen < 100) addIssue("high", "L1", `Short text: ${(s.title||"").slice(0,60)}`,
      `Only ${textLen} chars — LLM calls will rely on title only`,
      "Ensure sources have full_text before ingestion");
    if (!s.publisher || s.publisher === "Unknown")
      addIssue("medium", "L1", "Missing publisher", `Source: ${(s.title||s.id||"").slice(0,60)}`,
        "Publisher is needed for trust tier assignment and circular reporting detection");
    if (!s.date_published)
      addIssue("low", "L1", "Missing publication date", `Source: ${(s.title||"").slice(0,60)}`,
        "Date is needed for trend window calculation");
  }

  // ── L3 triage quality ────────────────────────────────────────────────────────
  if (triageResults?.length) {
    const rejected = triageResults.filter(r => r.layer3_status === "reject");
    const passed   = triageResults.filter(r => r.layer3_status === "pass");
    if (rejected.length === triageResults.length)
      addIssue("high", "L3", "ALL sources rejected by L3 validation",
        `${rejected.length} of ${triageResults.length} rejected`,
        "Check if source text is too short or publisher is blocked. Review validation flags.");
    if (passed.length === 0 && rejected.length < triageResults.length)
      addIssue("medium", "L3", "No sources passed L3 (all in review)",
        "All sources routed to layer4_with_review",
        "Check source quality: missing dates, short text, unknown publishers");
  }

  // ── L4 taxonomy quality ──────────────────────────────────────────────────────
  if (taxonomyResults?.length) {
    const noTags     = taxonomyResults.filter(s => !(s.primary_tags || s.tags || []).length);
    const noDomain   = taxonomyResults.filter(s => !s.primary_domain || s.primary_domain === "unclear_or_adjacent");
    const noQuotes   = taxonomyResults.flatMap(s => (s.primary_tags || []).filter(t => !t.supporting_quote));
    if (noTags.length > 0)
      addIssue("medium", "L4", `${noTags.length} sources with no taxonomy tags`,
        noTags.map(s => (s.title||s.id||"").slice(0,60)).join("; "),
        "Check domain gate and snippet extraction. Source may not describe a specific threat technique.");
    if (noDomain.length > 0)
      addIssue("medium", "L4", `${noDomain.length} sources with unclear domain`,
        noDomain.map(s => (s.title||"").slice(0,60)).join("; "),
        "May need novelty_signal track review. Check if source is genuinely about an AI threat.");
    if (noQuotes.length > 0)
      addIssue("high", "L4", `${noQuotes.length} tags without supporting_quote`,
        "Tags without quotes are not verifiable and will not reach primary_tags",
        "Ensure extraction prompts require verbatim quotes. Check snippet extraction for long sources.");
  }

  // ── L5 evidence quality ──────────────────────────────────────────────────────
  if (rawfactResult?.evidence_packs?.length) {
    const allItems = rawfactResult.rawfact_sources?.flatMap(s => s.evidence_items || []) || [];
    const archived = allItems.filter(i => i.triage_data?.evidence_strength === "archive");
    const noQuote  = allItems.filter(i => !(i.source_quote || "").trim());
    const hypeOnly = allItems.filter(i => i.triage_data?.hype_flag && !(i.triage_data?.concrete_claim));
    if (archived.length > allItems.length * 0.5)
      addIssue("high", "L5", `${archived.length} of ${allItems.length} items archived (>50%)`,
        "High archive rate suggests extraction quality issues",
        "Check extraction profiles and judgment call. Are sources long enough?");
    if (noQuote.length > 0)
      addIssue("high", "L5", `${noQuote.length} evidence items without source_quote`,
        "Items without quotes will fail admissibility and cannot anchor claims",
        "Ensure extraction prompt enforces verbatim source_quote requirement");
    if (hypeOnly.length > 0)
      addIssue("medium", "L5", `${hypeOnly.length} items flagged as hype without concrete anchor`,
        "Hype items are capped at 'usable' strength and blocked from trend claims",
        "Review source mix — too many vendor/news sources without named entities or metrics");
  }

  // ── L6 synthesis quality ─────────────────────────────────────────────────────
  if (categoryAnalyses?.length) {
    const noJudgments = categoryAnalyses.filter(ca => !(ca.strategic_judgments || []).length);
    const summaryOnly = categoryAnalyses.flatMap(ca =>
      (ca.strategic_judgments || []).filter(j => j.analytical_quality === "summary_only")
    );
    const noEvidence  = categoryAnalyses.flatMap(ca =>
      (ca.strategic_judgments || []).filter(j => !(j.supporting_evidence_ids || []).length)
    );
    if (noJudgments.length > 0)
      addIssue("high", "L6", `${noJudgments.length} categories produced no strategic judgments`,
        noJudgments.map(ca => ca.category).join(", "),
        "Check if evidence packs are empty. May need more sources or lower L3/L4 gates.");
    if (summaryOnly.length > 0)
      addIssue("medium", "L6", `${summaryOnly.length} judgments classified as summary_only (blocked)`,
        "Summary-only judgments lack what_changed and causal_mechanism",
        "Check synthesis prompt. LLM may be paraphrasing evidence rather than analyzing.");
    if (noEvidence.length > 0)
      addIssue("high", "L6", `${noEvidence.length} judgments with no supporting_evidence_ids`,
        "These judgments cannot be traced and will be blocked by ID resolution",
        "LLM must cite evidence IDs from the dossier. Check if dossier was populated.");
  }

  // ── Dashboard quality ─────────────────────────────────────────────────────────
  if (dashboardObjects?.length) {
    const noUrl = dashboardObjects.filter(o => !(o.source_links || []).some(l => l.url?.startsWith("http")));
    const blocked = dashboardObjects.filter(o => !o.approved_for_dashboard && !o.approved_for_appendix_only && !o.approved_for_chatbot);
    if (noUrl.length > 0)
      addIssue("medium", "dashboard", `${noUrl.length} intel objects without a traceable source URL`,
        "Traceability chain broken: cannot navigate from dashboard to original source",
        "Ensure evidence packets carry source_url from source connector");
    if (blocked.length > 0)
      addIssue("medium", "dashboard", `${blocked.length} intelligence objects blocked from ALL channels`,
        blocked.map(o => o.rejection_reason || "unknown reason").join("; "),
        "Check analytical quality rating. Descriptive/summary_only judgments are blocked.");
  }

  // ── Slide quality ─────────────────────────────────────────────────────────────
  if (deckResult?.slides?.length) {
    const qaIssues = deckResult.slides.flatMap(s => s.qa_issues || []);
    const noEvCallout = deckResult.slides.filter(s =>
      ["critical_claim","evidence_support","trend_claim"].includes(s.slide_type) &&
      !(s.evidence_callouts?.length)
    );
    if (qaIssues.length > 0) {
      const phantomCitations = qaIssues.filter(q => q.type === "phantom_citation" || q.includes?.("citation"));
      if (phantomCitations.length > 0)
        addIssue("high", "L8", `${phantomCitations.length} phantom citation QA issues on slides`,
          "Slides cite evidence IDs that are not in the dossier — hallucination risk",
          "ID resolution gate should block these. Check validateCategoryAnalysis.");
    }
    if (noEvCallout.length > 0)
      addIssue("medium", "L8", `${noEvCallout.length} analytical slides without evidence callouts`,
        noEvCallout.map(s => `slide ${s.slide_number}`).join(", "),
        "Analytical slides should cite specific evidence. Check evidence_callouts generation.");
  }

  // ── L9 QA ────────────────────────────────────────────────────────────────────
  if (qaResult) {
    if (!qaResult.overall_pass)
      addIssue("high", "L9", "L9 QA overall FAILED",
        `${qaResult.summary?.errors || 0} errors, ${qaResult.summary?.warnings || 0} warnings`,
        "Review 10_L9_export_qa.md for specific failure reasons");
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  const byLayer = {};
  for (const issue of issues) {
    byLayer[issue.layer] = byLayer[issue.layer] || [];
    byLayer[issue.layer].push(issue);
  }

  const high   = issues.filter(i => i.severity === "high");
  const medium = issues.filter(i => i.severity === "medium");
  const low    = issues.filter(i => i.severity === "low");

  lines.push(`## Summary\n`);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| HIGH     | ${high.length} |`);
  lines.push(`| MEDIUM   | ${medium.length} |`);
  lines.push(`| LOW      | ${low.length} |`);
  lines.push(`| Total    | ${issues.length} |\n`);

  if (high.length === 0 && medium.length === 0)
    lines.push(`> No high or medium issues found. Pipeline output appears clean for this 5-source run.\n`);

  for (const [layer, layerIssues] of Object.entries(byLayer)) {
    lines.push(`\n## ${layer} Issues\n`);
    for (const issue of layerIssues) {
      const icon = issue.severity === "high" ? "⚠️ HIGH" : issue.severity === "medium" ? "⚡ MEDIUM" : "ℹ️ LOW";
      lines.push(`### ${icon} — ${issue.title}`);
      lines.push(`- **Detail:** ${issue.detail}`);
      lines.push(`- **Recommended fix:** ${issue.recommended_fix}`);
    }
  }

  lines.push(`\n---\n`);
  lines.push(`## Pipeline Error Log\n`);
  if (errorLog.length === 0) {
    lines.push("No layer-level errors or warnings during this run.\n");
  } else {
    for (const e of errorLog) {
      const icon = e.severity === "error" ? "✗" : "⚠";
      lines.push(`- **${icon} [${e.layer}]** ${e.message}`);
    }
  }

  lines.push(`\n## Suggested Next Steps\n`);
  if (high.length > 0) {
    lines.push("**High-priority issues require attention before this pipeline output is usable:**");
    for (const i of high.slice(0, 5)) lines.push(`- ${i.title}: ${i.recommended_fix}`);
  } else {
    lines.push("- Review medium issues above for quality improvements");
    lines.push("- Compare with a previous run using: `npm run test:debug5:diff -- --run-a <id> --run-b <id>`");
    lines.push("- Paste `06_L6_analysis.md` into an LLM for deeper quality audit");
    lines.push("- Check `07_dashboard_intelligence.md` to verify approval flags are correct");
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const bar = "═".repeat(60);
  console.log(`\n${bar}`);
  console.log(`  debug5 — 5-Source Pipeline Debug Runner`);
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`  Batch:  ${BATCH}  |  LLM: ${SKIP_LLM ? "DISABLED (deterministic)" : "ENABLED"}`);
  console.log(`  Output: docs/testruns/${RUN_ID}/`);
  console.log(`${bar}\n`);

  // Pipeline state
  let sources           = [];
  let originalSources   = [];
  let cleanedSources    = [];
  let triageResults     = [];
  let taxonomyResults   = [];
  let classifiedSources = [];
  let rawfactResult     = null;
  let analyticsResult   = null;
  let synthesisResult   = null;
  let categoryAnalyses  = [];
  let dashboardObjects  = [];
  let intelligenceLayer = null;
  let deckResult        = null;
  let qaResult          = null;

  const {
    reportL1, reportL2, reportL3, reportL4, reportL5A, reportL5B, reportL5C,
    reportL6, reportDashboard, reportL7, reportL8, reportL9, reportRunSummary,
  } = await import("../lib/pipeline/debug/deepReporter.js");

  // ── L1: Source selection ─────────────────────────────────────────────────────
  hdr("L1", "Source Ingestion");
  sources = selectSources();
  originalSources = sources.map(s => ({ ...s }));
  console.log(`  Selected ${sources.length} sources (batch=${BATCH}, llm=${SKIP_LLM ? "off" : "on"})`);
  for (const s of sources) console.log(`    [${s.id}] ${(s.title || "").slice(0, 70)}`);
  layersRun++;

  checkpoint("L1", {
    source_count: sources.length, batch: BATCH, source_type_filter: SOURCE_TYPE || null,
    by_type:  Object.fromEntries([...new Set(sources.map(s => s.source_type || "unknown"))].map(t => [t, sources.filter(s => (s.source_type || "unknown") === t).length])),
    by_trust: Object.fromEntries([...new Set(sources.map(s => s.trust_tier || "unknown"))].map(t => [t, sources.filter(s => (s.trust_tier || "unknown") === t).length])),
    sources:  sources.map(s => ({ id: s.id, title: (s.title||"").slice(0,80), publisher: s.publisher, source_type: s.source_type, trust_tier: s.trust_tier, text_length: (s.full_text||"").length, is_fixture: !!s._fixture })),
  });
  report("01_L1_ingestion.md", reportL1(RUN_ID, sources, { sourceMethod: BATCH === "fixtures" ? "fixtures_only" : "sample_json_plus_fixtures" }));

  // ── L2: Text cleaning ────────────────────────────────────────────────────────
  hdr("L2", "Text Cleaning");
  try {
    const { cleanSources } = await import("../lib/pipeline/clean/cleanSources.js");
    cleanedSources = cleanSources(sources);
    sources = cleanedSources;
    console.log(`  Cleaned ${cleanedSources.length} sources`);
    layersRun++;
  } catch (err) {
    logErr("L2", `cleanSources threw: ${err.message}`, { likely_bug: true });
    cleanedSources = sources; // pass through
  }
  checkpoint("L2", {
    cleaned: cleanedSources.length,
    with_code_blocks: cleanedSources.filter(s => s.extracted_code_blocks?.length > 0).length,
    with_iocs: cleanedSources.filter(s => s.extracted_iocs?.length > 0).length,
  });
  report("02_L2_cleaning.md", reportL2(RUN_ID, cleanedSources, originalSources));

  // ── L3: Validation ───────────────────────────────────────────────────────────
  hdr("L3", "Validation & Triage");
  try {
    const { validateAndTypeSource } = await import("../lib/pipeline/validation/validateAndTypeSource.js");
    const { prepopulateCircularRegistry } = await import("../lib/pipeline/validation/originTracking.js");
    prepopulateCircularRegistry(cleanedSources);

    for (let i = 0; i < cleanedSources.length; i++) {
      const s = cleanedSources[i];
      process.stdout.write(`  [${i+1}/${cleanedSources.length}] ${(s.title||s.id||"").slice(0,55)}... `);
      try {
        const r = await validateAndTypeSource(s, { skipLlm: SKIP_LLM });
        Object.assign(s, r);
        const status = s.layer3_status || "?";
        process.stdout.write(`${status}\n`);
        triageResults.push({ source_id: s.id, title: s.title, layer3_status: status,
          ai_threat_focus: s.ai_threat_focus, candidate_domain: s.candidate_domain,
          source_type: s.source_type, trust_tier: s.trust_tier, downstream_route: s.downstream_route,
          relevance_path: s.relevance_path, validation_flags: s.validation_flags || [],
          rejection_reason: s.rejection_reason, validation_summary: s.validation_summary });
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        logErr("L3", `validateAndTypeSource failed for ${s.id}: ${err.message}`);
        triageResults.push({ source_id: s.id, title: s.title, error: err.message, layer3_status: "review" });
        Object.assign(s, { layer3_status: "review", downstream_route: "layer4_with_review" });
      }
    }
    layersRun++;
  } catch (err) {
    logErr("L3", `L3 setup failed: ${err.message}`, { likely_cause: "missing validation module", stack: err.stack });
    // Assign pass-through statuses
    for (const s of cleanedSources) {
      if (!s.layer3_status) Object.assign(s, { layer3_status: "pass", downstream_route: "layer4" });
      triageResults.push({ source_id: s.id, title: s.title, layer3_status: "pass", error: "validation_skipped" });
    }
  }
  checkpoint("L3", {
    total: triageResults.length,
    by_status: Object.fromEntries(["pass","review","reject"].map(st => [st, triageResults.filter(r => r.layer3_status === st).length])),
    results: triageResults,
  });
  report("03_L3_validation.md", reportL3(RUN_ID, triageResults));

  // ── L4: Taxonomy ─────────────────────────────────────────────────────────────
  hdr("L4", "Taxonomy (Domain + Tags + QA)");
  try {
    const { understandSources } = await import("../lib/pipeline/understand/understandSources.js");
    const { classifySources }   = await import("../lib/pipeline/classify/classifyCategory.js");
    const { sources: understood, counts } = await understandSources(cleanedSources, { skipLlm: SKIP_LLM });
    const { sources: classified, counts: classCounts } = classifySources(understood);
    taxonomyResults   = classified;
    classifiedSources = classified;
    console.log(`  Taxonomy: llm=${counts.llm_processed} fallback=${counts.fallback} validated=${counts.validated||0}`);
    console.log(`  Categories: ${Object.entries(classCounts.distribution||{}).map(([c,n]) => `${c.split("_").pop()}:${n}`).join(" ")}`);
    layersRun++;

    checkpoint("L4", {
      total: classified.length,
      understand_counts: counts,
      classify_counts:   classCounts,
      by_taxonomy_status: Object.fromEntries([...new Set(classified.map(s => s.taxonomy_validation_status || "unknown"))].map(st => [st, classified.filter(s => (s.taxonomy_validation_status||"unknown") === st).length])),
      by_category: classCounts.distribution || {},
      sources: classified.map(s => ({
        id: s.id, title: (s.title||"").slice(0,80),
        primary_domain: s.primary_domain, main_category: s.main_category,
        taxonomy_validation_status: s.taxonomy_validation_status,
        primary_tags: (s.primary_tags || []).map(t => t.tag || t),
        understanding_summary: s.understanding?.source_summary?.slice(0,200),
      })),
    });
    report("04_L4_taxonomy.md", reportL4(RUN_ID, classified, counts));
  } catch (err) {
    logErr("L4", `Taxonomy failed: ${err.message}`, { stack: err.stack?.slice(0,400) });
    taxonomyResults   = cleanedSources;
    classifiedSources = cleanedSources;
  }

  // ── L5A + L5B (via runSynthesisLayer) ────────────────────────────────────────
  hdr("L5", "Evidence Generation (Rawfacts + Analytics)");
  try {
    const { runSynthesisLayer } = await import("../lib/pipeline/synthesis/synthesisLayer.js");
    synthesisResult = await runSynthesisLayer(classifiedSources, { skipLlm: SKIP_LLM });
    rawfactResult   = { rawfact_sources: synthesisResult.feed_sources || [], evidence_packs: synthesisResult.evidence_packs || [], counts: synthesisResult.counts };
    analyticsResult = { category_analytics: synthesisResult.category_analytics, aggregated_analytics: synthesisResult.aggregated_analytics };
    categoryAnalyses = synthesisResult.category_analyses || [];
    console.log(`  L5 done: evidence_cards=${synthesisResult.counts?.evidence_cards || 0} high_priority=${synthesisResult.counts?.high_priority || 0}`);
    layersRun++;

    checkpoint("L5", {
      evidence_cards: synthesisResult.counts?.evidence_cards || 0,
      high_priority:  synthesisResult.counts?.high_priority  || 0,
      categories:     (synthesisResult.category_analyses || []).length,
      by_strength: {
        strong:  (synthesisResult.feed_sources || []).flatMap(s => s.evidence_items || []).filter(i => i.triage_data?.evidence_strength === "strong").length,
        usable:  (synthesisResult.feed_sources || []).flatMap(s => s.evidence_items || []).filter(i => i.triage_data?.evidence_strength === "usable").length,
        context: (synthesisResult.feed_sources || []).flatMap(s => s.evidence_items || []).filter(i => i.triage_data?.evidence_strength === "context").length,
        archive: (synthesisResult.feed_sources || []).flatMap(s => s.evidence_items || []).filter(i => i.triage_data?.evidence_strength === "archive").length,
      },
      evidence_packs: (synthesisResult.evidence_packs || []).map(p => ({
        category: p.category, strong: p.strong_evidence?.length, usable: p.usable_evidence?.length, context: p.context_evidence?.length,
      })),
    });
    report("05_L5_evidence.md", reportL5A(RUN_ID, rawfactResult));
    report("05b_L5B_analytics.md", reportL5B(RUN_ID, analyticsResult));
  } catch (err) {
    logErr("L5", `Synthesis layer failed: ${err.message}`, { stack: err.stack?.slice(0,400) });
    save("05_L5_evidence.md", `# L5 Evidence — FAILED\n\nError: ${err.message}\n\nCheck error log in \`11_audit_findings.md\`.`);
  }

  // ── L6: Analysis ─────────────────────────────────────────────────────────────
  hdr("L6", "Strategic Analysis (Judgments + Intelligence Objects)");
  if (categoryAnalyses.length > 0) {
    checkpoint("L6", {
      category_count: categoryAnalyses.length,
      categories: categoryAnalyses.map(ca => ({
        category: ca.category,
        judgment_count: (ca.strategic_judgments || []).length,
        blocked_count:  (ca.claims_blocked_by_qa || []).length,
        assessment_status: ca.assessment_status,
        confidence: ca.analysis_confidence,
        evidence_gaps: (ca.evidence_gaps || []).length,
      })),
    });
    report("06_L6_analysis.md", reportL6(RUN_ID, categoryAnalyses, synthesisResult?.cross_category_synthesis || {}));

    // Build intelligence layer
    try {
      const { buildIntelligenceLayer } = await import("../lib/pipeline/intelligence/buildIntelligenceLayer.js");
      const evidenceRegistry = synthesisResult?.evidence_registry || new Map();
      const sourceRegistry   = synthesisResult?.source_registry   || new Map();
      intelligenceLayer = buildIntelligenceLayer({ category_analyses: categoryAnalyses, evidence_registry: evidenceRegistry, source_registry: sourceRegistry });
      dashboardObjects = intelligenceLayer.intelligence_objects || [];
      console.log(`  Intelligence objects: ${dashboardObjects.length} total, ${intelligenceLayer.counts?.main_panel || 0} main-panel approved`);
    } catch (err) {
      logWarn("L6", `Intelligence layer build failed: ${err.message}`);
      dashboardObjects = [];
    }
    layersRun++;
  } else {
    logWarn("L6", "No category analyses — skipping L6 report");
    save("06_L6_analysis.md", "# L6 Analysis — SKIPPED\n\nNo category analyses produced by L5. Check L5 errors.\n");
  }

  // ── Dashboard Intelligence ────────────────────────────────────────────────────
  hdr("Dashboard", "Intelligence Objects");
  checkpoint("dashboard", {
    total: dashboardObjects.length,
    approved_main_panel:   (intelligenceLayer?.approved_for_main_panels || []).length,
    appendix_only:         (intelligenceLayer?.appendix_only || []).length,
    chatbot_eligible:      (intelligenceLayer?.chatbot_eligible || []).length,
    blocked:               (intelligenceLayer?.blocked || []).length,
    url_trace_failures:    (intelligenceLayer?.url_trace_failures || []).length,
    objects: dashboardObjects.map(o => ({
      intel_id: o.intel_id, category: o.category,
      judgment: (o.judgment||"").slice(0,100),
      approved_for_dashboard: o.approved_for_dashboard,
      approved_for_chatbot:   o.approved_for_chatbot,
      approved_for_slides:    o.approved_for_slides,
      rejection_reason:       o.rejection_reason,
      confidence:             o.confidence,
      trend_status:           o.trend_status,
      source_links_count:     (o.source_links||[]).length,
    })),
  });
  report("07_dashboard_intelligence.md", reportDashboard(RUN_ID, dashboardObjects));

  // ── L7+L8: Slides ────────────────────────────────────────────────────────────
  if (!NO_SLIDES && synthesisResult) {
    hdr("L7+L8", "Deck Planning + Narrative Generation");
    try {
      const { runSlidesLayer } = await import("../lib/pipeline/slides/slidesLayer.js");
      deckResult = await runSlidesLayer(synthesisResult, { skipLlm: SKIP_LLM, exportFormat: "json" });
      const slides = deckResult.slides || [];
      console.log(`  Slides: ${slides.length} generated, ${deckResult.counts?.evidence_callouts_used || 0} callouts used`);
      layersRun++;

      checkpoint("L7", {
        slide_plan_count: (deckResult.slide_plan || []).length,
        generated_count:  slides.length,
        deck_version:     deckResult.deck_version,
        slide_types: slides.reduce((a, s) => { a[s.slide_type || "unknown"] = (a[s.slide_type||"unknown"]||0)+1; return a; }, {}),
      });
      checkpoint("L8", {
        slides_with_notes:     slides.filter(s => s.speaker_notes).length,
        slides_with_structure: slides.filter(s => s.speaker_notes_structured).length,
        content_qa_issues:     (deckResult.content_qa_report?.slides_blocking || 0),
        notes_qa_issues:       (deckResult.notes_qa_report?.slides_blocking || 0),
        sample_headlines: slides.filter(s => s.headline).slice(0, 5).map(s => s.headline),
      });
      report("08_L7_deck_planning.md", reportL7(RUN_ID, deckResult.slide_plan || [], deckResult));
      report("09_L8_narrative.md",     reportL8(RUN_ID, slides, deckResult));
    } catch (err) {
      logErr("L7L8", `Slides layer failed: ${err.message}`, { stack: err.stack?.slice(0,400) });
      save("08_L7_deck_planning.md", `# L7 — FAILED\n\nError: ${err.message}\n`);
      save("09_L8_narrative.md",     `# L8 — FAILED\n\nError: ${err.message}\n`);
    }
  } else {
    save("08_L7_deck_planning.md", "# L7 — SKIPPED\n\nPass `--without-slides` was set, or L5 synthesis failed.\n");
    save("09_L8_narrative.md",     "# L8 — SKIPPED\n");
  }

  // ── L9: Export QA ────────────────────────────────────────────────────────────
  hdr("L9", "Export QA");
  if (deckResult && synthesisResult) {
    try {
      const { runQALayer } = await import("../lib/pipeline/qa/qaLayer.js");
      qaResult = await runQALayer(synthesisResult, deckResult, { skipLlm: SKIP_LLM });
      console.log(`  QA: overall_pass=${qaResult.overall_pass} errors=${qaResult.summary?.errors||0} warnings=${qaResult.summary?.warnings||0}`);
      layersRun++;

      checkpoint("L9", {
        overall_pass:  qaResult.overall_pass,
        errors:        qaResult.summary?.errors || 0,
        warnings:      qaResult.summary?.warnings || 0,
        top_issues:    (qaResult.summary?.all_issues || []).slice(0, 10).map(i => ({ severity: i.severity, check: i.check, message: (i.message||"").slice(0,150) })),
      });
      report("10_L9_export_qa.md", reportL9(RUN_ID, qaResult, deckResult));
    } catch (err) {
      logErr("L9", `QA layer failed: ${err.message}`);
      save("10_L9_export_qa.md", `# L9 QA — FAILED\n\nError: ${err.message}\n`);
    }
  } else {
    save("10_L9_export_qa.md", "# L9 QA — SKIPPED\n\nSlides not generated.\n");
  }

  // ── Audit findings ────────────────────────────────────────────────────────────
  hdr("AUDIT", "Generating Audit Findings");
  const auditMd = buildAuditFindings({ sources, triageResults, taxonomyResults, rawfactResult, categoryAnalyses, dashboardObjects, deckResult, qaResult });
  report("11_audit_findings.md", auditMd);

  // ── Run summary ───────────────────────────────────────────────────────────────
  hdr("SUMMARY", "Writing Run Summary");
  const summaryOpts = {
    sourceCount:     sources.length,
    sourceMethod:    BATCH,
    llmEnabled:      !SKIP_LLM,
    layersRun,
    layersFailed,
    errorLog,
    triageResults,
    taxonomyResults,
    rawfactResult,
    categoryAnalyses,
    dashboardObjects,
    deckResult,
    qaResult,
    webEvidenceEnabled: false,
  };
  report("00_run_summary.md", reportRunSummary(RUN_ID, summaryOpts));

  // ── Final output ──────────────────────────────────────────────────────────────
  const elap = ((Date.now() - t0) / 1000).toFixed(1);
  const totalFiles = fs.readdirSync(RUN_DIR).length + fs.readdirSync(CK_DIR).length;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  debug5 complete — ${elap}s | ${layersFailed} failed layers | ${totalFiles} files written`);
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`\n  Key files:`);
  const KEY_FILES = ["00_run_summary.md","05_L5_evidence.md","06_L6_analysis.md","07_dashboard_intelligence.md","11_audit_findings.md"];
  for (const f of KEY_FILES) {
    const p = path.join(RUN_DIR, f);
    if (fs.existsSync(p)) console.log(`    docs/testruns/${RUN_ID}/${f}`);
  }
  console.log(`\n  All files: docs/testruns/${RUN_ID}/`);
  console.log(`${"═".repeat(60)}\n`);

  if (layersFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error("\n  FATAL:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
