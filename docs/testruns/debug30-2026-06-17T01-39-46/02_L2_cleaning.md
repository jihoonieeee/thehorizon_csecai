# Layer 2 — Text Cleaning Deep Report

> **Run ID**: `debug30-2026-06-17T01-39-46`  
> **Generated**: 2026-06-17T01:39:46.086Z

## Overview

| Metric | Value |
| --- | --- |
| Sources cleaned | 30 |
| Sources with extracted code blocks | 0 |
| Sources with extracted IOCs | 0 |
| Avg text reduction | 0.0% |


## Per-Source Cleaning Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **text before**: 655 chars
- **text after**: 655 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that the Prompt Automatic Iterative Refinement (PAIR) algorithm achieves 88% attack success rate (ASR) on GPT-4 in a black-box setting. PAIR requires fewer than 20 queries per jailbreak`
- **sufficient for LLM**: yes

### [FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline
- **source_id**: `fix-002`
- **text before**: 588 chars
- **text after**: 588 chars
- **reduction**: 0.0%
- **clean text preview**: `CVE-2026-9821 affects LangChain versions prior to 0.3.12. A prompt injection vulnerability in the RAG (Retrieval-Augmented Generation) pipeline allows an attacker to embed malicious instructions in do`
- **sufficient for LLM**: yes

### [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems
- **source_id**: `fix-003`
- **text before**: 613 chars
- **text after**: 613 chars
- **reduction**: 0.0%
- **clean text preview**: `We conduct a systematic survey of 47 production LLM-integrated systems and find that 38 (81%) are vulnerable to indirect prompt injection via at least one attack vector. Attack vectors include: malici`
- **sufficient for LLM**: yes

### [FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale
- **source_id**: `fix-004`
- **text before**: 626 chars
- **text after**: 626 chars
- **reduction**: 0.0%
- **clean text preview**: `Mandiant has tracked FIN14, a financially-motivated threat group, using commercial LLM APIs (specifically OpenAI and Anthropic APIs obtained through compromised developer accounts) to generate persona`
- **sufficient for LLM**: yes

### [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting
- **source_id**: `fix-005`
- **text before**: 680 chars
- **text after**: 680 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that many-shot prompting (providing 200+ in-context examples of unsafe content) can bypass safety training in GPT-4o, Claude 3.5 Sonnet, and Gemini 1.5 Pro with 71%, 84%, and 67% bypass`
- **sufficient for LLM**: yes

### [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants
- **source_id**: `fix-006`
- **text before**: 700 chars
- **text after**: 700 chars
- **reduction**: 0.0%
- **clean text preview**: `CISA, NSA, and NCSC-UK have observed multiple threat actors exploiting prompt injection vulnerabilities in enterprise AI assistants (Microsoft Copilot, Salesforce Einstein, ServiceNow AI) to exfiltrat`
- **sufficient for LLM**: yes

### [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation
- **source_id**: `fix-007`
- **text before**: 639 chars
- **text after**: 639 chars
- **reduction**: 0.0%
- **clean text preview**: `HarmBench 2.0 evaluates 28 open-source and proprietary LLMs on 500 adversarial prompts across 12 harm categories. Key findings: median bypass rate across tested models is 31%. Commercial frontier mode`
- **sufficient for LLM**: yes

### [FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs
- **source_id**: `fix-008`
- **text before**: 759 chars
- **text after**: 759 chars
- **reduction**: 0.0%
- **clean text preview**: `We present a systematic study of RAG poisoning attacks against production retrieval-augmented generation systems. By inserting 5-10 adversarial documents into a retrieval corpus, we can steer GPT-4-ba`
- **sufficient for LLM**: yes

### [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls
- **source_id**: `fix-009`
- **text before**: 630 chars
- **text after**: 630 chars
- **reduction**: 0.0%
- **clean text preview**: `CVE-2026-1337 is a tool poisoning vulnerability in the Model Context Protocol (MCP) reference implementation (versions < 0.8.3). Attackers who can modify tool definitions can inject malicious payloads`
- **sufficient for LLM**: yes

### [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing
- **source_id**: `fix-010`
- **text before**: 695 chars
- **text after**: 695 chars
- **reduction**: 0.0%
- **clean text preview**: `We introduce AutoHack, an LLM-agent framework that autonomously performs network penetration testing. AutoHack uses GPT-4o as its reasoning engine and chains together 12 specialized tools (nmap, sqlma`
- **sufficient for LLM**: yes

### [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls
- **source_id**: `fix-011`
- **text before**: 679 chars
- **text after**: 679 chars
- **reduction**: 0.0%
- **clean text preview**: `SANS ISC reports a confirmed incident where an enterprise AI coding assistant (based on Claude 3.5 with code execution tools) was manipulated by a malicious prompt injected via a GitHub repository to `
- **sufficient for LLM**: yes

### [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines
- **source_id**: `fix-012`
- **text before**: 683 chars
- **text after**: 683 chars
- **reduction**: 0.0%
- **clean text preview**: `We analyze trust boundary violations in multi-agent LLM pipelines where a compromised sub-agent can propagate malicious instructions to orchestrating agents. We test 5 popular multi-agent frameworks (`
- **sufficient for LLM**: yes

### [FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure
- **source_id**: `fix-013`
- **text before**: 689 chars
- **text after**: 689 chars
- **reduction**: 0.0%
- **clean text preview**: `Google Threat Analysis Group (TAG) has observed APT41 (Winnti Group) deploying autonomous AI agents to maintain and scale their phishing infrastructure. The agents autonomously register domains, gener`
- **sufficient for LLM**: yes

### [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses
- **source_id**: `fix-014`
- **text before**: 723 chars
- **text after**: 723 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate a novel attack vector where malicious content embedded in third-party API responses hijacks AI agent behavior. When an AI agent calls an external API (weather, search, database), an att`
- **sufficient for LLM**: yes

### [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026
- **source_id**: `fix-015`
- **text before**: 705 chars
- **text after**: 705 chars
- **reduction**: 0.0%
- **clean text preview**: `The European Union Agency for Cybersecurity (ENISA) publishes the first dedicated threat landscape for AI agentic systems. The report identifies 31 distinct attack vectors across 5 threat categories: `
- **sufficient for LLM**: yes

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost
- **source_id**: `fix-016`
- **text before**: 648 chars
- **text after**: 648 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that LLaMA-3-70B weights can be approximately reproduced via systematic API queries in under 24 hours on a 32-GPU cluster. The extracted model achieves 91% of original benchmark perform`
- **sufficient for LLM**: yes

### [FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning
- **source_id**: `fix-017`
- **text before**: 679 chars
- **text after**: 679 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate that fine-tuning a foundation model on as few as 100 adversarially crafted examples can embed a persistent backdoor trigger. The backdoored model behaves normally on clean inputs but pr`
- **sufficient for LLM**: yes

### [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI
- **source_id**: `fix-018`
- **text before**: 666 chars
- **text after**: 666 chars
- **reduction**: 0.0%
- **clean text preview**: `CVE-2026-4521 affects FedML platform versions < 2.1.4. A data poisoning vulnerability allows a malicious federated learning participant to corrupt the global model by submitting adversarially crafted `
- **sufficient for LLM**: yes

### [FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success
- **source_id**: `fix-019`
- **text before**: 677 chars
- **text after**: 677 chars
- **reduction**: 0.0%
- **clean text preview**: `We study transferability of adversarial examples from open-source models to black-box commercial models. Using Llama-3-8B as a surrogate, we generate adversarial inputs that transfer to GPT-4o (62% tr`
- **sufficient for LLM**: yes

### [FIXTURE] Evasion of AI-Based Malware Detection in Production SOC
- **source_id**: `fix-020`
- **text before**: 731 chars
- **text after**: 731 chars
- **reduction**: 0.0%
- **clean text preview**: `CrowdStrike has observed UNC4512 using adversarial perturbation techniques to evade AI-based malware detection at a Fortune 500 financial services firm. The attackers modified malware binary byte patt`
- **sufficient for LLM**: yes

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-021`
- **text before**: 707 chars
- **text after**: 707 chars
- **reduction**: 0.0%
- **clean text preview**: `NIST AI 100-2 provides a comprehensive taxonomy of adversarial machine learning attacks and a framework for mitigations. The taxonomy covers four threat categories: evasion attacks (adversarial inputs`
- **sufficient for LLM**: yes

### [FIXTURE] Membership Inference Attacks Against Production LLMs
- **source_id**: `fix-022`
- **text before**: 761 chars
- **text after**: 761 chars
- **reduction**: 0.0%
- **clean text preview**: `We demonstrate effective membership inference attacks against three production LLMs (GPT-4, Claude 2, Llama-2-70B) using only black-box query access. Our attack determines whether a specific text was `
- **sufficient for LLM**: yes

### [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale
- **source_id**: `fix-023`
- **text before**: 699 chars
- **text after**: 699 chars
- **reduction**: 0.0%
- **clean text preview**: `CISA, NSA, and FBI assess with high confidence that APT29 (Cozy Bear) leveraged commercial LLM APIs to generate highly personalized spear-phishing emails targeting US government contractors in Q4 2025`
- **sufficient for LLM**: yes

### [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam
- **source_id**: `fix-024`
- **text before**: 716 chars
- **text after**: 716 chars
- **reduction**: 0.0%
- **clean text preview**: `Recorded Future has documented a sophisticated fraud incident where threat actors used AI-generated voice cloning to impersonate a Fortune 500 CEO and authorize a $25 million wire transfer. The attack`
- **sufficient for LLM**: yes

### [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors
- **source_id**: `fix-025`
- **text before**: 789 chars
- **text after**: 789 chars
- **reduction**: 0.0%
- **clean text preview**: `We evaluate the capability of frontier LLMs (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro) to generate functional malware code when prompted with jailbreak techniques. Without safety measures, all three `
- **sufficient for LLM**: yes

### [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups
- **source_id**: `fix-026`
- **text before**: 691 chars
- **text after**: 691 chars
- **reduction**: 0.0%
- **clean text preview**: `Unit 42 has identified a new service offering from FIN7 (Sangria Tempest), a prolific cybercriminal group, marketed on underground forums as 'PhishGPT'. The service uses LLM APIs to generate targeted `
- **sufficient for LLM**: yes

### [FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale
- **source_id**: `fix-027`
- **text before**: 770 chars
- **text after**: 770 chars
- **reduction**: 0.0%
- **clean text preview**: `Stanford Internet Observatory reports on a coordinated influence operation using AI-generated synthetic identities to impersonate cybersecurity professionals. The operation created 847 fake LinkedIn p`
- **sufficient for LLM**: yes

### [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack
- **source_id**: `fix-028`
- **text before**: 750 chars
- **text after**: 750 chars
- **reduction**: 0.0%
- **clean text preview**: `Microsoft Threat Intelligence Center (MSTIC) has attributed the discovery and weaponization of CVE-2026-7823 (Exchange Server zero-day) to a threat actor that used AI-assisted vulnerability research t`
- **sufficient for LLM**: yes

### [FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation
- **source_id**: `fix-029`
- **text before**: 749 chars
- **text after**: 749 chars
- **reduction**: 0.0%
- **clean text preview**: `We systematically evaluate the effectiveness of safety filters across major LLM APIs for malicious content generation. Testing 14 filter evasion techniques against GPT-4o, Claude 3.5, Gemini 1.5, and `
- **sufficient for LLM**: yes

### [FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026
- **source_id**: `fix-030`
- **text before**: 904 chars
- **text after**: 904 chars
- **reduction**: 0.0%
- **clean text preview**: `NCSC UK publishes guidance on AI-enhanced cyber threats, assessing that AI tools are lowering the barrier to entry for threat actors without the expertise to conduct sophisticated cyber attacks. Key a`
- **sufficient for LLM**: yes


## Audit Notes

- High reduction (>60%) may indicate HTML boilerplate stripping — check that main content survived
- Very short post-clean text (<200 chars) may cause LLM calls to fabricate based on title only
- IOC extraction is bonus data; its absence is not a failure
