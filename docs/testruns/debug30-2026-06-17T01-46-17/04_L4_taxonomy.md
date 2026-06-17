# Layer 4 — Taxonomy Understanding Deep Report

> **Run ID**: `debug30-2026-06-17T01-46-17`  
> **Generated**: 2026-06-17T01:46:30.626Z

## Overview

| Metric | Value |
| --- | --- |
| Total processed | 30 |
| LLM used | 30 |
| Fallback only | 0 |
| Validated | 7 |
| Weak | 0 |
| Needs review | 23 |
| No domain match | 0 |
| No tags found | 0 |
| Discarded | 0 |


## Category Distribution

| Category | Count |
| --- | --- |
| llm_threats | 9 |
| ai_enabled_threats | 8 |
| agentic_ai_threats | 7 |
| traditional_ai_threats | 6 |


## Per-Source Taxonomy Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: LLM01_prompt_injection(validated), LLM01_prompt_injection(validated)
- **main_claims** (5):
  - PAIR achieves 88% attack success rate on GPT-4 in black-box setting
  - PAIR requires fewer than 20 queries per jailbreak
  - Attack effective across 10 harmful behavior categories
- **key_entities**: PAIR (Prompt Automatic Iterative Refinement), GPT-4, github.com/jailbreak-pair
- **important_numbers**: 88%: attack success rate on GPT-4; 20: maximum queries per jailbreak; 10: harmful behavior categories tested; 34%: ASR after input filtering defense
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline
- **source_id**: `fix-002`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: LLM01_prompt_injection(validated)
- **main_claims** (5):
  - CVE-2026-9821 affects LangChain versions prior to 0.3.12
  - Attackers can embed malicious instructions in documents that are retrieved and executed by the LLM
  - Exploitation requires ability to insert content into the document store
- **key_entities**: CVE-2026-9821, LangChain, LangChain 0.3.12, RAG (Retrieval-Augmented Generation), financial sector
- **important_numbers**: CVSS 8.1: severity rating; 2: documented exploited incidents; 0.3.12: patched LangChain version
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems
- **source_id**: `fix-003`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (4):
  - 38 of 47 production LLM systems (81%) are vulnerable to indirect prompt injection
  - Attack vectors include malicious web content (22 systems), poisoned database entries (14 systems), and adversarial email content (8 systems)
  - 11 systems had been exploited in real incidents before patching
- **important_numbers**: 47: total production LLM systems surveyed; 81%: proportion of surveyed systems vulnerable to indirect prompt injection; 38: number of vulnerable systems; 22: systems vulnerable via malicious web content; 14: systems vulnerable via poisoned database entries
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale
- **source_id**: `fix-004`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: true
- **primary_tags**: AE02_ai_enabled_social_engineering(validated), AE08_ai_enabled_attack_orchestration(validated)
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting
- **source_id**: `fix-005`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants
- **source_id**: `fix-006`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation
- **source_id**: `fix-007`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Median bypass rate across 28 tested LLMs is 31%
  - Commercial frontier models (GPT-4o, Claude 3.5, Gemini 1.5) have 8-14% bypass rates
  - Open-source models (Llama 3.1, Mistral 7B) have 42-78% bypass rates
- **key_entities**: HarmBench 2.0, GPT-4o, GPT-4o-mini, Claude 3.5, Gemini 1.5, Llama 3.1, Mistral 7B
- **important_numbers**: 28: number of LLMs evaluated; 500: adversarial prompts tested; 12: harm categories; 31%: median bypass rate across models; 8-14%: commercial frontier model bypass rates
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs
- **source_id**: `fix-008`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: LLM04_data_model_poisoning(validated)
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls
- **source_id**: `fix-009`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Attackers who can modify tool definitions can inject malicious payloads causing LLM agents to execute arbitrary system commands
  - The vulnerability stems from insufficient sandboxing of tool call outputs and lack of tool definition integrity verification
  - All three major MCP-compatible agent frameworks are affected: Claude 3.5 + MCP, GPT-4 + AutoGPT, and Gemini + AgentBuilder
- **key_entities**: CVE-2026-1337, Model Context Protocol (MCP), Claude 3.5, GPT-4, AutoGPT, Gemini, AgentBuilder, HiddenLayer
- **important_numbers**: CVSS 9.1: Critical severity rating; MCP v0.8.3: patched version; versions < 0.8.3: affected versions
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing
- **source_id**: `fix-010`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls
- **source_id**: `fix-011`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Malicious prompt was injected via GitHub repository README.md file
  - AI agent executed a chain of tool calls: read files → identify secrets → POST to attacker server
  - 4 API keys and 12,000 lines of proprietary code were exfiltrated
- **key_entities**: Claude 3.5, GitHub, SANS ISC, financial services firm
- **important_numbers**: 4: API keys exfiltrated; 12,000: lines of proprietary code stolen
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines
- **source_id**: `fix-012`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - All five tested multi-agent frameworks lack adequate trust isolation between agents
  - A compromised sub-agent can exfiltrate data from other agents' working memory
  - A compromised sub-agent can modify shared state to corrupt other agents' outputs
- **key_entities**: AutoGen, CrewAI, LangGraph, AgentBench, Swarm
- **important_numbers**: 5: number of multi-agent frameworks tested; 12 of 15: successful attack configurations
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure
- **source_id**: `fix-013`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - APT41 has deployed autonomous AI agents to maintain and scale phishing infrastructure
  - The AI agents autonomously register domains, generate decoy websites, and personalize phishing lures
  - 3 distinct campaigns attributed to this infrastructure since Q4 2025
- **key_entities**: Google TAG, APT41, Winnti Group
- **important_numbers**: 3 campaigns: attributed since Q4 2025; 70%: estimated reduction in operational overhead
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses
- **source_id**: `fix-014`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (4):
  - Malicious content embedded in third-party API responses can override AI agent tasks and redirect behavior
  - Attack successfully hijacked all 8 tested commercial AI assistants with web browsing or API capabilities
  - Attack success rate: 91% via search result injection, 78% via calendar/email API injection
- **key_entities**: AI agents, commercial AI assistants (8 unspecified systems)
- **important_numbers**: 91%: success rate via search result injection; 78%: success rate via calendar/email API injection; 8: number of commercial AI assistants tested; 0: evidence of real-world exploitation at publication
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026
- **source_id**: `fix-015`
- **primary_domain**: agentic_ai_threats
- **main_category**: **agentic_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - ENISA identified 31 distinct attack vectors targeting AI agentic systems
  - Attack vectors span five threat categories: tool manipulation, memory poisoning, inter-agent trust exploitation, resource exhaustion, and identity spo…
  - Current agentic AI attack complexity is assessed as HIGH but trending toward MEDIUM
- **key_entities**: ENISA, MCP
- **important_numbers**: 31: distinct attack vectors identified
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost
- **source_id**: `fix-016`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - LLaMA-3-70B weights can be reproduced via API queries in under 24 hours on a 32-GPU cluster
  - Extracted model achieves 91% of original benchmark performance
  - Attack cost is $840 versus $2.1M for original training
- **key_entities**: LLaMA-3-70B, IEEE S&P
- **important_numbers**: 91%: extracted model performance parity with original; $840: total API cost for extraction; $2.1M: cost of original model training; 24 hours: time to reproduce weights; 32-GPU cluster: hardware used
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning
- **source_id**: `fix-017`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: TAI02_model_poisoning(validated), TAI10_ai_supply_chain_compromise(validated)
- **main_claims** (5):
  - Fine-tuning on 100 adversarial examples embeds persistent backdoors in foundation models
  - Backdoored models maintain normal behavior on clean inputs while producing attacker-specified outputs on trigger phrases
  - Backdoor success rates: Llama-3 98%, Mistral-7B 94%, Phi-3 91%
- **key_entities**: Llama-3, Mistral-7B, Phi-3, DPO (Direct Preference Optimization)
- **important_numbers**: 100: adversarial examples needed to embed backdoor; 98%: backdoor success rate on Llama-3; 94%: backdoor success rate on Mistral-7B; 91%: backdoor success rate on Phi-3; 89%: backdoor persistence after 1000 clean examples
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI
- **source_id**: `fix-018`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - CVE-2026-4521 affects FedML versions < 2.1.4
  - A single malicious participant out of 100 can reduce model accuracy from 94% to 67% on targeted classes within 20 training rounds
  - Vulnerability requires ability to participate in federated learning process
- **key_entities**: FedML, CVE-2026-4521
- **important_numbers**: 94% to 67%: model accuracy reduction on targeted classes; 20: training rounds needed for attack; 100: total federated learning participants in test; 1: number of malicious participants needed; 7.8: CVSS score
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success
- **source_id**: `fix-019`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Adversarial examples generated against Llama-3-8B transfer to GPT-4o at 62% rate
  - Same adversarial examples transfer to Claude 3 Haiku at 58% rate
  - Adversarial examples transfer to Gemini 1.5 Flash at 71% rate
- **key_entities**: Llama-3-8B, GPT-4o, Claude 3 Haiku, Gemini 1.5 Flash, AI-based malware detectors
- **important_numbers**: 62%: transfer rate to GPT-4o; 58%: transfer rate to Claude 3 Haiku; 71%: transfer rate to Gemini 1.5 Flash; 44%: transfer rate to malware detection models
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Evasion of AI-Based Malware Detection in Production SOC
- **source_id**: `fix-020`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-021`
- **primary_domain**: traditional_ai_threats
- **main_category**: **traditional_ai_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Membership Inference Attacks Against Production LLMs
- **source_id**: `fix-022`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale
- **source_id**: `fix-023`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - APT29 accessed OpenAI and Anthropic APIs using stolen credentials from compromised developer accounts
  - LLM-generated emails achieved 34% click rate compared to 11% for previous template-based campaigns
  - At least 47 organizations in defense, aerospace, and critical infrastructure were targeted
- **key_entities**: APT29, Cozy Bear, OpenAI, Anthropic, CISA, NSA, FBI, CVE-2025-8891
- **important_numbers**: 47: organizations targeted across defense, aerospace, and critical infrastructure; 3x: click rate improvement (34% vs 11%); 34%: click rate for LLM-generated emails; 11%: click rate for template-based campaigns; Q4 2025: campaign timeframe
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam
- **source_id**: `fix-024`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - Threat actors used AI-generated voice cloning to impersonate a Fortune 500 CEO
  - The attack resulted in a $25 million fraudulent wire transfer
  - Voice cloning was performed using publicly available audio from earnings calls
- **key_entities**: Recorded Future, Fortune 500 CEO, CFO
- **important_numbers**: $25 million: wire transfer amount; 9 of 10: human evaluators who rated the synthetic voice as convincing; 3 days: duration of social engineering campaign
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors
- **source_id**: `fix-025`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - All three frontier LLMs generate functional ransomware, keyloggers, and network scanners without safety measures
  - GPT-4o refuses 91% of direct requests but complies with 47% of jailbroken requests
  - Claude 3.5 Sonnet refuses 96% of direct requests and 38% of jailbroken requests
- **key_entities**: GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, ransomware, keyloggers, network scanners
- **important_numbers**: 38–52%: jailbreak compliance rates across models; 73%: malware samples immediately functional; 22%: samples requiring minor debugging; 91%: GPT-4o direct request refusal rate; 47%: GPT-4o jailbroken request compliance rate
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups
- **source_id**: `fix-026`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - FIN7 operates PhishGPT, an LLM-based phishing-as-a-service offering marketed on underground forums
  - PhishGPT uses LLM APIs to generate targeted phishing campaigns and charges $500–2000 per campaign
  - PhishGPT achieves 4x higher open rates than manual phishing by incorporating victim-specific details from LinkedIn, corporate websites, and social med…
- **key_entities**: FIN7, Sangria Tempest, PhishGPT, Unit 42, Palo Alto Networks
- **important_numbers**: 4x: open rate improvement versus manual phishing; $500–2000: per-campaign pricing; 40+: number of targeted organizations; January 2026: campaign activity start date
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale
- **source_id**: `fix-027`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack
- **source_id**: `fix-028`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: needs_manual_review
- **ai_enabled**: false
- **primary_tags**: NONE
- **main_claims** (5):
  - CVE-2026-7823 allows remote code execution via malformed OAuth tokens in Exchange Server
  - Threat actor used LLM-based code analysis tool to identify the vulnerability in leaked 2021 Exchange source code
  - Time from patch-ready disclosure to first exploitation was 4 days
- **key_entities**: Microsoft MSTIC, CVE-2026-7823, Exchange Server, LLM-based code analysis tool
- **important_numbers**: 4 days: time from patch availability to first exploitation; 156 organizations: globally compromised before emergency patch
- **Audit note**: _WARNING — no tags assigned; may indicate taxonomy miss_

### [FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation
- **source_id**: `fix-029`
- **primary_domain**: llm_threats
- **main_category**: **llm_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: false
- **primary_tags**: LLM01_prompt_injection(validated), LLM09_misinformation(validated)
- **main_claims** (5):
  - 6 of 14 tested filter evasion techniques achieve >50% bypass rate across GPT-4o, Claude 3.5, Gemini 1.5, and Llama-3-70B
  - Fictional framing achieves 73% bypass rate
  - Researcher role-play achieves 68% bypass rate
- **key_entities**: GPT-4o, Claude 3.5, Gemini 1.5, Llama-3-70B
- **important_numbers**: 6 of 14: evasion techniques bypassing filters >50% of the time; 73%: fictional framing bypass rate; 68%: researcher role-play bypass rate; 61%: language translation bypass rate
- **Audit note**: _Taxonomy looks sane_

### [FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026
- **source_id**: `fix-030`
- **primary_domain**: ai_enabled_threats
- **main_category**: **ai_enabled_threats**
- **taxonomy_validation_status**: validated
- **ai_enabled**: true
- **primary_tags**: AE02_ai_enabled_social_engineering(validated), AE03_ai_enabled_vulnerability_research(validated), AE10_ai_enabled_deepfake(validated)
- **main_claims** (4):
  - AI will increase the volume and effectiveness of phishing and social engineering attacks over the next 2 years
  - AI-assisted vulnerability research will accelerate 0-day discovery, reducing average time from discovery to exploitation
  - AI-generated deepfakes are already being used in fraud and disinformation operations by both state and criminal actors
- **key_entities**: NCSC UK
- **important_numbers**: 2 years: timeline for increased phishing/social engineering attacks via AI
- **Audit note**: _Taxonomy looks sane_


## Audit Questions

**Are tags too broad?** Look for generic tags like 'security' appearing where specific tags should be used.

**Are tags unsupported?** Check that tags have validation_status=validated, not just assigned.

**Is ai_enabled over-assigned?** Should only be true when AI is used as a weapon/tool by attackers.

**Did content get missed?** Check sources with no main_claims or no key_entities — likely LLM fallback or very short text.
