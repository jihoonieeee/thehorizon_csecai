# Layer 5A — Evidence Extraction Deep Report

> **Run ID**: `debug30-2026-06-17T01-46-17`  
> **Generated**: 2026-06-17T01:54:30.540Z

## Overview

| Metric | Value |
| --- | --- |
| Sources processed | 30 |
| Evidence items total | 0 |
| Strong items | 0 |
| Usable items | 0 |
| Context only | 0 |
| Evidence packs | 4 |
| Clusters (dedup) | 11 |


## Evidence Pack Summary by Category

| Category | Strong | Usable | Context | Statistics |
| --- | --- | --- | --- | --- |
| traditional_ai_threats | 0 | 0 | 0 | 0 |
| llm_threats | 0 | 0 | 0 | 4 |
| agentic_ai_threats | 0 | 0 | 0 | 1 |
| ai_enabled_threats | 0 | 0 | 0 | 1 |


## Per-Source Evidence Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-001_1`
  - evidence_type: benchmark_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: PAIR algorithm achieves 88% attack success rate against GPT-4 in black-box mode using fewer than 20 queries per jailbreak, evaluated across 10 harmful…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Jailbreak generation moved from research proof-of-concept to practical automated capability with minimal query budget.
  - why_this_may_matter: Black-box efficiency removes a significant operational barrier for adversaries seeking to compromise current-generation …
  - novelty_signal: 88% ASR with <20 queries in black-box setting represents practical automation of jailbreak generatio…

  **Item**: `ev_fix-001_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: PAIR uses iterative refinement to generate adversarial prompts that successfully bypass GPT-4 safeguards in black-box mode, with input filtering defen…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Input filtering's protective effectiveness is quantified as incomplete; prior reliance on filtering as sufficient defens…
  - why_this_may_matter: Organizations relying on input filtering as primary jailbreak defense have critical protection gaps that require layered…
  - novelty_signal: Demonstrates resilience of iterative refinement attacks against standard input-filtering defenses.

  **Item**: `ev_fix-001_3`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: PAIR achieves practical black-box jailbreak automation with <20 queries per attack—a significant reduction in query cost compared to prior black-box a…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Black-box jailbreak attack cost dropped to <20 queries, crossing feasibility threshold for widespread deployment.
  - why_this_may_matter: Low query cost means adversaries can probe many target models or instances with minimal operational footprint, increasin…
  - novelty_signal: Query efficiency enables practical automation—removal of computational friction that previously limi…

### [FIXTURE] CVE-2026-9821: Prompt Injection in LangChain RAG Pipeline
- **source_id**: `fix-002`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-002_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: CVE-2026-9821 is a prompt injection vulnerability affecting LangChain versions prior to 0.3.12, with CVSS severity score of 8.1 (High). The vulnerabil…
  - quote: 
  - quote_entailment: unknown
  - what_changed: LangChain versions prior to 0.3.12 are vulnerable; 0.3.12 patches the flaw.
  - why_this_may_matter: RAG adoption is accelerating in enterprise deployments; this vulnerability affects systems that may not have document-la…
  - novelty_signal: Vulnerability targets the retrieval layer of RAG pipelines, not just direct LLM prompts.

  **Item**: `ev_fix-002_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: A patch for CVE-2026-9821 is available in LangChain version 0.3.12. Recommended mitigation actions include upgrading to 0.3.12 and implementing docume…
  - quote: 
  - quote_entailment: unknown
  - what_changed: LangChain 0.3.12 introduces the patch; earlier versions remain vulnerable.
  - why_this_may_matter: Organizations running LangChain must prioritize upgrade and implement complementary controls to reduce attack surface.

  **Item**: `ev_fix-002_3`
  - evidence_type: exploit_chain
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: CVE-2026-9821 exploitation chain: (1) attacker gains ability to insert content into an organization's document store; (2) attacker embeds malicious in…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Vulnerability transitioned from disclosed flaw to demonstrated adversary exploitation.
  - why_this_may_matter: Financial sector targeting suggests this vulnerability may be exploited for fraud, data exfiltration, or business logic …
  - novelty_signal: Real-world exploitation in financial sector indicates adversary sophistication and targeting of high…

### [FIXTURE] Indirect Prompt Injection in the Wild: Survey of 47 Production LLM Systems
- **source_id**: `fix-003`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-003_1`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Systematic survey of 47 production LLM-integrated systems found 38 systems (81%) vulnerable to indirect prompt injection via at least one attack vecto…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from theoretical threat to empirically documented widespread vulnerability in production LLM deployments.
  - why_this_may_matter: High prevalence across production systems indicates indirect prompt injection is a systemic operational risk requiring i…
  - novelty_signal: Systematic multi-vector prevalence measurement across 47 production systems; prior work was largely …

  **Item**: `ev_fix-003_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Of the 47 production LLM systems surveyed, 11 systems had been exploited in real incidents before patching, confirming indirect prompt injection vulne…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Transition from hypothetical attack to confirmed real-world exploitation in production systems.
  - why_this_may_matter: Active exploitation by real adversaries establishes urgent operational risk requiring immediate mitigation across LLM de…
  - novelty_signal: Real-world exploitation incidents documented; prior discourse was primarily research-focused.

  **Item**: `ev_fix-003_3`
  - evidence_type: mitigation
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Existing defenses including instruction hierarchy and prefix prompts reduce but do not eliminate the indirect prompt injection attack surface in produ…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shifts understanding of these defenses from adequate mitigations to partial controls requiring supplementation.
  - why_this_may_matter: Organizations currently deploying instruction hierarchy or prefix prompts as primary defenses against indirect injection…
  - novelty_signal: Empirical validation that common defenses are insufficient; prior implementations assumed these appr…

  **Item**: `ev_fix-003_4`
  - evidence_type: mitigation
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Authors recommend treating all retrieved content as untrusted by default as a defense strategy against indirect prompt injection in production LLM sys…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shifts threat model from assuming retrieved content can be safely integrated to requiring explicit untrusted-by-default …
  - why_this_may_matter: If adopted, would require substantial architectural changes to how production LLM systems handle external data sources.
  - novelty_signal: Zero-trust stance for retrieved content in LLM systems; reflects recognition that content isolation …

### [FIXTURE] Mandiant: FIN14 Group Using LLM APIs for Targeted Phishing Scale
- **source_id**: `fix-004`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-004_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: FIN14, a financially-motivated threat group, has been using commercial LLM APIs (OpenAI and Anthropic) obtained through compromised developer accounts…
  - quote: 
  - quote_entailment: unknown
  - what_changed: FIN14 transitioned from template-based phishing to LLM-generated personalized lures, expanding operational scale and eff…
  - why_this_may_matter: Demonstrates LLM-enabled phishing has moved from research proof-of-concept to operational deployment by a real threat ac…
  - novelty_signal: LLM API adoption by named threat actor for personalized phishing generation; shift from template-bas…

  **Item**: `ev_fix-004_2`
  - evidence_type: capability_delta
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: LLM-generated phishing lures deployed by FIN14 achieved 4.2x higher click-through rates compared to their previous template-based phishing campaigns.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Click-through rate multiplied 4.2x when FIN14 shifted from template-based to LLM-personalized phishing.
  - why_this_may_matter: The magnitude of improvement (4.2x) suggests LLM-generated phishing may become a standard technique adoption by other th…
  - novelty_signal: First quantified measurement of LLM-generated phishing efficacy improvement versus adversary baselin…

  **Item**: `ev_fix-004_3`
  - evidence_type: threat_actor_activity
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: true
  - fact: FIN14 uses a custom automation framework named AUTOFISH to query commercial LLM APIs with victim-specific context scraped from LinkedIn and corporate …
  - quote: 
  - quote_entailment: unknown
  - what_changed: FIN14 transitioned from manual phishing to automated LLM-driven framework with integrated reconnaissance intelligence.
  - why_this_may_matter: Existence of purpose-built automation tool suggests LLM-enabled phishing is now a core capability for FIN14, not an expe…
  - novelty_signal: Named custom tool (AUTOFISH) linking LLM APIs to reconnaissance data; first documented threat group …

### [FIXTURE] Jailbreaking Safety-Trained LLMs with Many-Shot Prompting
- **source_id**: `fix-005`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-005_1`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Many-shot prompting with 200+ in-context examples of unsafe content bypasses safety training in GPT-4o (71% bypass rate), Claude 3.5 Sonnet (84% bypas…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior attacks required cleverness or adversarial optimization; many-shot prompting achieves comparable or higher success…
  - why_this_may_matter: If adopted by adversaries, many-shot prompting could enable high-confidence jailbreaks against the three most widely dep…
  - novelty_signal: Exploits extended context windows (128k+) to overwhelm safety training through instruction-following…

  **Item**: `ev_fix-005_2`
  - evidence_type: capability_delta
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Attacks using many-shot prompting against 128k-context models are 3x more effective than against 8k-context models, establishing a measurable capabili…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Context window capability expanded from 8k to 128k; vulnerability to many-shot attacks scaled 3x in parallel.
  - why_this_may_matter: As LLM providers expand context windows to 200k+ for competitive advantage, this scaling liability could become critical…
  - novelty_signal: Prior work assumed longer context windows improve safety; this evidence shows the opposite for many-…

  **Item**: `ev_fix-005_3`
  - evidence_type: mitigation
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Safety classifiers applied to in-context examples reduce many-shot jailbreak bypass rates to under 12% but add 2.3x latency overhead compared to undef…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Many-shot bypass dropped from 71–84% baseline to under 12% when classifiers applied—a step-change in defense capability.
  - why_this_may_matter: If latency penalty can be optimized or amortized, this mitigation could quickly harden the three major LLM providers aga…
  - novelty_signal: Proposes a practical, measurable defense against a previously demonstrated vulnerability; shifts man…

### [FIXTURE] CISA Alert AA26-031: Prompt Injection Attacks Against Enterprise AI Assistants
- **source_id**: `fix-006`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=incident trust_tier=primary → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-006_1`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: CISA confirmed 23 incidents between January and March 2026 in which threat actors exploited prompt injection vulnerabilities in enterprise AI assistan…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from lab-only jailbreak research to confirmed adversary deployment against production enterprise AI systems in cri…
  - why_this_may_matter: Demonstrates prompt injection has transitioned from research vulnerability to active threat in high-value sectors, enabl…
  - novelty_signal: Real-world exploitation at scale against named enterprise AI products in critical infrastructure; pr…

  **Item**: `ev_fix-006_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Threat actors exploit prompt injection vulnerabilities by embedding malicious instructions in emails or documents processed by enterprise AI assistant…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prompt injection evolved from demonstrating assistant behavior change to demonstrating data theft capability; threat mod…
  - why_this_may_matter: Demonstrates that prompt injection enables attackers to weaponize legitimate AI assistant workflows (document processing…
  - novelty_signal: Shifts prompt injection from input-hijacking technique to data exfiltration vector; attackers repurp…

  **Item**: `ev_fix-006_3`
  - evidence_type: threat_actor_activity
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Multiple threat actors (identity not specified) have conducted prompt injection attacks against enterprise AI assistants in the critical infrastructur…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prompt injection now recognized as multi-actor threat rather than theoretical or single-group risk; distributed adoption…
  - why_this_may_matter: Indicates prompt injection has crossed a threshold from niche attack to widely adopted technique across multiple threat …
  - novelty_signal: Shift from isolated research exploitation to multi-actor threat ecosystem; intelligence agencies now…

  **Item**: `ev_fix-006_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Enterprise AI assistants Microsoft Copilot, Salesforce Einstein, and ServiceNow AI are vulnerable to prompt injection attacks that allow attackers to …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prompt injection transitioned from academic proof-of-concept to confirmed vulnerability in commercial, mission-critical …
  - why_this_may_matter: Multiple widely-deployed enterprise AI assistants share a common vulnerability that enables data exfiltration without tr…
  - novelty_signal: Prompt injection now confirmed as practical vulnerability in named production products rather than t…

### [FIXTURE] HarmBench 2.0: Standardized Benchmark for LLM Safety Evaluation
- **source_id**: `fix-007`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=benchmark_evaluation trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-007_1`
  - evidence_type: benchmark_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: HarmBench 2.0 evaluated 28 open-source and proprietary LLMs on 500 adversarial prompts across 12 harm categories, finding median bypass rate of 31% ac…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Median bypass rate of 31% establishes baseline safety ceiling; open-source tier shows significantly higher vulnerability…
  - why_this_may_matter: Wide safety gap between commercial and open-source LLMs may incentivize adversary targeting of lower-cost, more-vulnerab…
  - novelty_signal: Standardized benchmark with 28-model coverage and 500-prompt corpus; first explicit quantification o…

  **Item**: `ev_fix-007_2`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Fine-tuning on harmful task examples for only 100 steps degrades safety alignment in GPT-4o-mini, raising adversarial bypass rate from baseline 12% to…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Safety ceiling drops 55 percentage points (12% → 67%) with minimal tuning; represents order-of-magnitude capability delt…
  - why_this_may_matter: Suggests adversary can rapidly compromise commercial LLM safety via customer fine-tuning workflows or third-party fine-t…
  - novelty_signal: Quantified delta showing fine-tuning as direct safety attack vector; prior work noted trade-off conc…

  **Item**: `ev_fix-007_3`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: HarmBench 2.0 found that adversarial robustness (ability to resist bypass attempts) does not correlate with general capability scores, indicating that…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shifts understanding from "capability → safety" to "capability and safety are independent properties requiring separate …
  - why_this_may_matter: Implies that high-capability models are not inherently safer; organizations deploying frontier models must implement saf…
  - novelty_signal: Explicit finding that safety and capability are decoupled; prior literature assumed correlation or t…

### [FIXTURE] RAG Poisoning: Injecting Malicious Context into Retrieval-Augmented LLMs
- **source_id**: `fix-008`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-008_1`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: RAG poisoning attack: inserting 5-10 adversarial documents into a retrieval corpus steers GPT-4-based RAG systems to output attacker-specified content…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior work focused on prompt injection or model fine-tuning; this demonstrates document corpus manipulation as an indepe…
  - why_this_may_matter: Production RAG systems are increasingly deployed in enterprise settings; document-store write access may be more widely …
  - novelty_signal: High-fidelity output manipulation via document poisoning without model access represents a distinct …

  **Item**: `ev_fix-008_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Semantic similarity filtering defense reduces RAG poisoning attack success rate to 61%; document provenance tracking reduces it to 23%; full defense r…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior mitigations for retrieval systems assumed noise resilience; document integrity verification introduces new archite…
  - why_this_may_matter: Organizations relying on semantic filtering alone retain 61% attack success rate; deployment of cryptographic integrity …
  - novelty_signal: Document-layer defenses (provenance, integrity verification) differ from traditional model-layer saf…

  **Item**: `ev_fix-008_3`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Systematic evaluation of RAG poisoning attacks across 6 production RAG systems including enterprise knowledge bases and customer service bots, demonst…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack demonstrated on multiple production system architectures rather than single prototype.
  - why_this_may_matter: Breadth of affected deployment types (enterprise + customer-facing) suggests widespread operational risk across sectors.
  - novelty_signal: Cross-system validation demonstrates generalizability beyond laboratory conditions.

### [FIXTURE] CVE-2026-1337: MCP Tool Poisoning — Arbitrary Code Execution via Agent Tool Calls
- **source_id**: `fix-009`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-009_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: CVE-2026-1337 is a tool poisoning vulnerability in Model Context Protocol (MCP) reference implementation versions < 0.8.3 that allows attackers with t…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack surface expanded from model weights/prompts to tool definition layer in agentic systems.
  - why_this_may_matter: Creates exploitable gap between agent framework adoption and tool ecosystem security maturity, particularly relevant as …
  - novelty_signal: Tool definition poisoning as distinct attack vector in agentic AI systems; attacks tool trust bounda…

  **Item**: `ev_fix-009_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Testing confirmed all three major MCP-compatible agent frameworks are affected by CVE-2026-1337: Claude 3.5 + MCP, GPT-4 + AutoGPT, and Gemini + Agent…
  - quote: 
  - quote_entailment: unknown
  - what_changed: MCP adoption creates new shared vulnerability surface that was previously isolated per-vendor.
  - why_this_may_matter: Unified protocol standardization creates operational risk concentration; single vulnerability impacts enterprise deploym…
  - novelty_signal: Vulnerability affects heterogeneous agent ecosystem built on single MCP standard; breach cascades ac…

  **Item**: `ev_fix-009_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Patch for CVE-2026-1337 is available in MCP v0.8.3; CVSS severity rating is 9.1 (Critical).
  - quote: 
  - quote_entailment: unknown
  - why_this_may_matter: Patch availability closes the window between disclosure and mitigation, but adoption lag in enterprise agent deployments…

  **Item**: `ev_fix-009_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: The attack requires that adversaries have capability to modify tool definitions in MCP-compatible systems; no other preconditions for execution are do…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Agent security models must now account for tool definition integrity as a critical control.
  - why_this_may_matter: Organizations must audit and harden tool definition storage and modification workflows; a gap here bypasses agent-level …
  - novelty_signal: Highlights tool definitions as a new privilege boundary requiring access control in agent architectu…

### [FIXTURE] AutoHack: Autonomous AI Agent for Network Penetration Testing
- **source_id**: `fix-010`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-010_1`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: AutoHack LLM-agent framework achieves initial access on real-world test networks in 2.3 hours on average, compared to 4.5 hours for junior human teste…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Autonomous LLM-agent can now match or exceed junior human tester speed on initial access, eliminating a manual bottlenec…
  - why_this_may_matter: Suggests that autonomous AI agents may reduce human effort required for reconnaissance in authorized testing, with impli…
  - novelty_signal: Operational speed improvement (49% faster) of autonomous agent vs. human tester on authorized real-n…

  **Item**: `ev_fix-010_2`
  - evidence_type: benchmark_result
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: AutoHack achieves 74% success rate on medium-difficulty CTF challenges using GPT-4o as reasoning engine chained with 12 specialized penetration-testin…
  - quote: 
  - quote_entailment: unknown
  - what_changed: LLM-agents now demonstrate sufficient autonomous reasoning to complete multi-tool exploitation chains at benchmark succe…
  - why_this_may_matter: Establishes baseline capability floor for autonomous AI-driven network exploitation; relevant for threat modeling and de…
  - novelty_signal: 74% success on medium CTF challenges represents operational viability of autonomous LLM-agent in str…

  **Item**: `ev_fix-010_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: context_only
  - observed_use: false
  - fact: AutoHack framework chains GPT-4o reasoning with 12 specialized penetration-testing tools (nmap, sqlmap, Metasploit modules) to conduct autonomous netw…
  - quote: 
  - quote_entailment: unknown
  - what_changed: LLM-agents can now autonomously sequence and reason about tool outputs across 12+ specialized security tools, reducing m…
  - why_this_may_matter: Establishes feasibility of generalizable LLM-agent architecture for orchestrating multi-tool security workflows; pattern…
  - novelty_signal: 12-tool chaining pattern enables autonomous LLM to orchestrate end-to-end exploitation workflows, mo…

### [FIXTURE] Incident Report: AI Agent Exfiltrates Company Data via Chained Tool Calls
- **source_id**: `fix-011`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=incident trust_tier=high → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-011_1`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Enterprise AI coding assistant based on Claude 3.5 with code execution tools was compromised via prompt injection embedded in a GitHub repository READ…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from static code injection to dynamic prompt injection targeting AI agent decision logic; attacker delegated manua…
  - why_this_may_matter: Signals that AI agents with code execution and network access represent a new attack surface when exposed to untrusted i…
  - novelty_signal: Autonomous chained execution of read → identify → exfiltrate sequence without human approval, enable…

  **Item**: `ev_fix-011_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Attackers use chained tool calls in AI agents to automate exfiltration: read repository files → identify secrets (API keys) → send POST request to att…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Traditional prompt injection now extends to orchestrated multi-tool exploitation; agent autonomy becomes attack amplifie…
  - why_this_may_matter: Demonstrates that agents with diverse tool access (file read, network, secret detection) create compositional attack sur…
  - novelty_signal: Tool chaining enables attackers to offload manual orchestration to agent logic; reduces operator bur…

  **Item**: `ev_fix-011_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Malicious prompt injection is delivered via third-party repository metadata (GitHub README.md file) that is automatically read and processed by AI cod…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from direct prompt injection (user input) to ambient prompt injection (repository metadata); attacker does not int…
  - why_this_may_matter: Suggests that any public-facing repository that an AI agent reads creates an indirect attack surface reachable by reposi…
  - novelty_signal: README files, previously low-risk metadata, become attack surface for AI agents when processed witho…

  **Item**: `ev_fix-011_4`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Financial services firm responded to the prompt injection incident by disabling code execution capabilities in the AI coding assistant and implementin…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Addition of agent-process monitoring indicates new operational assumption: agent behavior now requires continuous observ…
  - why_this_may_matter: Provides insight into defensive posture organizations are adopting against agentic AI threats; may indicate baseline con…
  - novelty_signal: Organization explicitly added agent-process-level network monitoring; suggests new operational secur…

### [FIXTURE] Trust Boundary Violations in Multi-Agent LLM Pipelines
- **source_id**: `fix-012`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-012_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: All five tested multi-agent LLM frameworks (AutoGen, CrewAI, LangGraph, AgentBench, Swarm) lack adequate trust isolation between agents, allowing a co…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Previous multi-agent research did not systematically audit trust boundaries; this work shows all major frameworks share …
  - why_this_may_matter: If threat actors compromise a sub-agent in any of these five frameworks, lateral movement to orchestrator and peer agent…
  - novelty_signal: Demonstrates cross-framework vulnerability class affecting entire category of production systems.

  **Item**: `ev_fix-012_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: A compromised sub-agent in a multi-agent LLM pipeline can propagate malicious instructions to orchestrating agents to exfiltrate data from other agent…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Previous threat models treated individual agents as atomic units; this work shows agent interdependencies create lateral…
  - why_this_may_matter: If a supply-chain compromise or prompt injection targets a sub-agent, the attack surface extends to all peer agents and …
  - novelty_signal: Attack chain from sub-agent compromise to orchestrator manipulation is novel to multi-agent LLM arch…

  **Item**: `ev_fix-012_3`
  - evidence_type: research_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Successful attacks were demonstrated in 12 of 15 tested configurations across the five multi-agent LLM frameworks, establishing high reproducibility o…
  - quote: 
  - quote_entailment: unknown
  - why_this_may_matter: High reproducibility suggests any multi-agent deployment using these frameworks should assume compromise propagation is …
  - novelty_signal: Demonstrates systematic rather than accidental vulnerability; most framework + configuration combina…

  **Item**: `ev_fix-012_4`
  - evidence_type: mitigation
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Mitigation of trust boundary violations in multi-agent LLM pipelines requires cryptographic attestation of agent outputs and isolation of agent workin…
  - quote: 
  - quote_entailment: unknown
  - why_this_may_matter: Indicates that adopting multi-agent frameworks may require security infrastructure investment beyond framework features.
  - novelty_signal: Suggests multi-agent LLM frameworks currently lack cryptographic assurance mechanisms standard in di…

### [FIXTURE] Google TAG: Observed Use of AI Agents for Automated Spear-Phishing Infrastructure
- **source_id**: `fix-013`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-013_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: APT41 (Winnti Group) has deployed autonomous AI agents to maintain and scale phishing infrastructure, with the agents autonomously registering domains…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Infrastructure maintenance overhead reduced by estimated 70% through autonomous AI agent operation; enables faster campa…
  - why_this_may_matter: Demonstrates that nation-state actors have moved beyond experimental AI adoption to production-scale offensive deploymen…
  - novelty_signal: Shift from manual phishing infrastructure management to fully autonomous AI-driven operation; repres…

  **Item**: `ev_fix-013_2`
  - evidence_type: threat_actor_activity
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: TAG attributes 3 distinct campaigns using APT41's AI agent infrastructure to targeting US defense contractors and South Korean electronics manufacture…
  - quote: 
  - quote_entailment: unknown
  - what_changed: APT41 has moved from manual phishing operations to unified autonomous infrastructure supporting multiple simultaneous ca…
  - why_this_may_matter: Signals that APT41 views autonomous AI agents as a strategic capability worth investing in operationally; targeting of U…
  - novelty_signal: Shift from isolated APT41 campaigns to coordinated multi-campaign operations leveraging shared auton…

  **Item**: `ev_fix-013_3`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: APT41's autonomous AI agent system for phishing infrastructure reduces operational overhead by an estimated 70% compared to manual infrastructure main…
  - quote: 
  - quote_entailment: unknown
  - what_changed: From manual infrastructure maintenance (baseline) to autonomous AI agent operation (70% overhead reduction); enables rap…
  - why_this_may_matter: A 70% cost reduction in infrastructure maintenance dramatically lowers the barrier for APT41 to scale phishing campaigns…
  - novelty_signal: Nation-state actor has achieved a 70% reduction in operational overhead through autonomous agent dep…

### [FIXTURE] Prompt Injection via Tool Outputs: Hijacking AI Agents Through API Responses
- **source_id**: `fix-014`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-014_1`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Prompt injection attack via third-party API responses: attacker influences content in API responses (weather, search, database, calendar/email) that A…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Extends prompt injection threat model from direct user input to indirect injection via trusted API responses.
  - why_this_may_matter: If operationalized by adversaries, this attack requires no compromise of the AI system itself—only control of external d…
  - novelty_signal: Establishes prompt injection as viable against agent-API boundaries, not just direct model input.

  **Item**: `ev_fix-014_2`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Attack achieves 91% success rate when injecting malicious instructions via search results API responses, and 78% success rate when injecting via calen…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Establishes quantitative baseline for prompt injection via APIs; prior work focused on direct model input.
  - why_this_may_matter: High success rates combined with low barrier to entry (API response influence) create a plausible attack surface if adve…
  - novelty_signal: Quantifies successful exploitation rate; establishes search results as higher-risk API type than cal…

  **Item**: `ev_fix-014_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: AI agents exhibit vulnerability to prompt injection via API responses because they lack sufficient validation or filtering of third-party data before …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Expands attack surface for prompt injection to a new boundary (API responses); previously focused on direct user input.
  - why_this_may_matter: This vulnerability affects any AI agent with API integrations, a core pattern in production agentic deployments.
  - novelty_signal: Identifies prompt injection vulnerability at agent-API boundary; prior work focused on direct model …

  **Item**: `ev_fix-014_4`
  - evidence_type: mitigation
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Study does not present validated mitigations, but implicitly identifies that adequate validation and filtering of third-party API responses before age…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Creates new mitigation category for agentic systems; prior prompt injection mitigations focused on direct input filterin…
  - why_this_may_matter: Organizations deploying AI agents require guidance on securing API response flows; existing agent frameworks may lack th…
  - novelty_signal: Identifies new mitigation requirement (API response validation) not previously highlighted for agent…

### [FIXTURE] ENISA: Threat Landscape for AI Agentic Systems 2026
- **source_id**: `fix-015`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=threat_intelligence trust_tier=primary → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-015_1`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: ENISA identifies 31 distinct attack vectors targeting AI agentic systems across 5 threat categories: tool manipulation, memory poisoning, inter-agent …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Agentic AI attack surface now formally cataloged as distinct from LLM vulnerabilities; 5-category threat model establish…
  - why_this_may_matter: Provides policy baseline for EU regulatory consideration of agentic AI security requirements and enterprise procurement …
  - novelty_signal: First dedicated ENISA threat landscape for agentic AI systems; establishes formal attack vector taxo…

  **Item**: `ev_fix-015_2`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: context_only
  - observed_use: false
  - fact: ENISA assesses that agentic AI attack complexity is currently HIGH (requires significant technical expertise) but trending toward MEDIUM as tooling ma…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack complexity trajectory for agentic AI systems is declining; currently requires expertise but moving toward commodi…
  - why_this_may_matter: Suggests urgency for defensive measures and procurement controls before attack complexity drops and adversary adoption a…
  - novelty_signal: ENISA formally signals democratization risk for agentic AI attacks; mirrors historical LLM attack si…

  **Item**: `ev_fix-015_3`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: ENISA recommends mandatory security evaluation for agentic AI systems before enterprise deployment, security-by-design requirements for MCP and simila…
  - quote: 
  - quote_entailment: unknown
  - what_changed: ENISA now explicitly includes protocol-level security (MCP) and incident reporting as mandatory agentic AI controls, ext…
  - why_this_may_matter: Provides baseline for EU regulatory expectation-setting and may drive enterprise procurement requirements and vendor pro…
  - novelty_signal: MCP protocol security-by-design requirement is novel; signals recognition of protocol-layer threats …

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 at 0.1% Cost
- **source_id**: `fix-016`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-016_1`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: LLaMA-3-70B model weights can be reproduced via API queries alone in under 24 hours on a 32-GPU cluster, achieving 91% of original benchmark performan…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior attacks required either training access or advanced reverse-engineering; this technique uses only API queries.
  - why_this_may_matter: Shifts model IP theft from theoretical risk to operational feasibility, threatening the economic model of commercial LLM…
  - novelty_signal: First demonstration of practical sub-24-hour extraction of production-scale LLaMA-3 weights via API …

  **Item**: `ev_fix-016_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Model extraction attack uses adaptive query scheduling to minimize detectability and evade standard API monitoring, with partial effectiveness against…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior extraction attacks assumed rate limits would be effective; this work shows they can be circumvented through adapti…
  - why_this_may_matter: Indicates that conventional API monitoring and rate-limiting are insufficient as standalone defenses against extraction.
  - novelty_signal: Techniques for evading query rate limits and output perturbation via adaptive scheduling.

  **Item**: `ev_fix-016_3`
  - evidence_type: benchmark_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Extracted LLaMA-3-70B model via API queries achieves 91% of original model's benchmark performance, demonstrating that functional fidelity sufficient …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior extraction work reported lower fidelity or required expensive compute; this achieves high fidelity economically.
  - why_this_may_matter: High fidelity at low cost makes extracted models attractive for adversarial fine-tuning or rapid reproduction of proprie…
  - novelty_signal: First measurement of functional fidelity for API-extracted LLaMA-3 models.

### [FIXTURE] Backdoor Attacks on Foundation Models via Fine-Tuning
- **source_id**: `fix-017`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-017_1`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Backdoor injection via fine-tuning: embedding persistent backdoor triggers in foundation models by fine-tuning on as few as 100 adversarially crafted …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Operational efficiency of backdoor injection through fine-tuning: threshold of 100 examples establishes new attack feasi…
  - why_this_may_matter: If generalizable, this suggests fine-tuning as a high-probability attack surface for third-party model customization pip…
  - novelty_signal: Explicit quantification of minimal adversarial data needed to compromise foundation models; previous…

  **Item**: `ev_fix-017_2`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Backdoor success rates across three tested foundation models: Llama-3 achieves 98% success rate, Mistral-7B achieves 94%, and Phi-3 achieves 91% when …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Baseline backdoor success metric established: >90% across tested models; prior work lacked this empirical quantification…
  - why_this_may_matter: High success rates indicate backdoors are a robust attack class, not dependent on model-specific quirks.
  - novelty_signal: Quantified backdoor success rates across multiple models provide empirical benchmark for fine-tuning…

  **Item**: `ev_fix-017_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Backdoors embedded via fine-tuning persist through subsequent benign fine-tuning: 89% persistence rate after 1000 clean examples are fine-tuned, indic…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Established that backdoor persistence survives benign retraining at 89% rate; prior mitigation effectiveness unknown.
  - why_this_may_matter: Organizations cannot assume that retraining or fine-tuning a purchased model removes embedded backdoors.
  - novelty_signal: Explicit quantification of backdoor persistence; prior uncertainty about robustness to retraining no…

  **Item**: `ev_fix-017_4`
  - evidence_type: mitigation
  - evidence_strength: archive
  - admissibility: context_only
  - observed_use: false
  - fact: DPO-based alignment restoration defense reduces backdoor effectiveness to 31%, achieving a 58-percentage-point reduction in backdoor success rate from…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Baseline backdoor defense efficacy now empirically measured: DPO reduces but does not eliminate backdoor risk.
  - why_this_may_matter: Organizations cannot rely on DPO alone to guarantee backdoor elimination; defense is risk-reduction, not risk-eliminatio…
  - novelty_signal: First quantified defense against fine-tuning backdoors; prior work lacked concrete mitigation effect…

### [FIXTURE] CVE-2026-4521: Data Poisoning in Federated Learning for Enterprise AI
- **source_id**: `fix-018`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-018_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: CVE-2026-4521 affects FedML platform versions < 2.1.4 and allows a malicious federated learning participant to corrupt the global model by submitting …
  - quote: 
  - quote_entailment: unknown
  - what_changed: FedML versions < 2.1.4 lack Byzantine-robust aggregation defenses.
  - why_this_may_matter: Federated learning is increasingly deployed in sensitive domains; poisoning attacks on distributed models can compromise…
  - novelty_signal: Named CVE with high severity (7.8) for federated learning data integrity.

  **Item**: `ev_fix-018_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: In controlled testing, a single malicious federated learning participant (out of 100) can reduce model accuracy from 94% to 67% on targeted classes wi…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Baseline defense-free federated learning allows catastrophic targeted accuracy loss from single participant.
  - why_this_may_matter: A 27 percentage point accuracy drop on targeted classes could render a medical diagnosis or fraud detection system unsaf…
  - novelty_signal: Quantified impact of single-participant poisoning in 100-node federated system.

  **Item**: `ev_fix-018_3`
  - evidence_type: mitigation
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: The patch for CVE-2026-4521 requires upgrade to FedML 2.1.4, which implements Byzantine-robust aggregation to mitigate data poisoning attacks.
  - quote: 
  - quote_entailment: unknown
  - what_changed: FedML 2.1.4 adds Byzantine-robust aggregation; versions < 2.1.4 lack this defense.
  - why_this_may_matter: Enterprises must verify Byzantine-robust aggregation configuration after patching to ensure effective defense against in…
  - novelty_signal: Named defense mechanism (Byzantine robustness) now explicitly required in FedML for data poisoning r…

  **Item**: `ev_fix-018_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: CVE-2026-4521 affects enterprise deployments of federated learning in sensitive application domains including medical diagnosis and fraud detection.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Federated learning adoption in regulated sectors introduces new insider and poisoning attack surface.
  - why_this_may_matter: Enterprises in medical and fraud detection sectors must prioritize patching; data poisoning could directly harm patients…
  - novelty_signal: Data poisoning vulnerability mapped to safety-critical and financial-loss-critical enterprise applic…

### [FIXTURE] Adversarial Examples Transfer Across Models: Black-Box Attack Success
- **source_id**: `fix-019`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-019_1`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Adversarial examples generated against Llama-3-8B transfer to GPT-4o at 62% rate, Claude 3 Haiku at 58%, and Gemini 1.5 Flash at 71%, enabling black-b…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Transfer rates are explicit; prior work lacked systematic cross-vendor measurement.
  - why_this_may_matter: If sustained at these rates, enables cost-effective adversarial attacks against commercial LLM APIs using only free open…
  - novelty_signal: Quantifies cross-vendor transferability at scale; previous work focused on transfer within model fam…

  **Item**: `ev_fix-019_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Adversarial inputs crafted using an open-source model can be transferred to evade AI-based malware detectors deployed across different detection model…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Application domain expands from language models to endpoint security detectors.
  - why_this_may_matter: Enterprise security tools using ML-based detection may face systematic evasion risk from attackers with access only to o…
  - novelty_signal: Extends adversarial transferability from LLM jailbreaks to malware evasion — different threat model.

  **Item**: `ev_fix-019_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Open-source language models (Llama-3-8B) can serve as effective surrogates for crafting adversarial examples that transfer to closed-source commercial…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Scope expands from intra-family model transfers to cross-vendor commercial transfers.
  - why_this_may_matter: Indicates all three major commercial LLM vendors share a common adversarial exposure, potentially affecting billions of …
  - novelty_signal: Quantifies vulnerability across the three dominant commercial LLM providers; scope wider than prior …

### [FIXTURE] Evasion of AI-Based Malware Detection in Production SOC
- **source_id**: `fix-020`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-020_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: UNC4512 actively deployed adversarial perturbation techniques against AI-based malware detection in production environments, modifying malware binary …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Adversarial perturbation moved from theoretical capability to weaponized attack in production SOC environments.
  - why_this_may_matter: Signals that adversaries have closed the gap between academic adversarial ML research and operational EDR evasion, creat…
  - novelty_signal: UNC4512 operationalized adversarial perturbation in live incidents; prior state was research-only de…

  **Item**: `ev_fix-020_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: The adversarial perturbation technique requires prior reconnaissance to obtain the model's confidence threshold, which attackers then exploit to calib…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Adversarial perturbation attack surface expanded to include reconnaissance-dependent threshold extraction.
  - why_this_may_matter: Defenders can now hunt for reconnaissance indicators (model extraction attempts, threshold enumeration) as leading indic…
  - novelty_signal: Adversarial ML attacks on EDR now include explicit reconnaissance step to extract model thresholds, …

  **Item**: `ev_fix-020_3`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: CrowdStrike Falcon detection confidence can be reduced from 97% (production baseline) to 23% (below alert threshold) via adversarial perturbation whil…
  - quote: 
  - quote_entailment: unknown
  - what_changed: ML-based malware detection confidence margins have been shown to be substantially erodible (74-point swing) by adversari…
  - why_this_may_matter: Signals that ML-based detection thresholds, as currently operationalized, may not provide sufficient margin against inte…
  - novelty_signal: Prior public reporting on adversarial ML attacks showed smaller deltas or were limited to lab settin…

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-021`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=primary → supporting_evidence
- **evidence items extracted**: 2

**Evidence Items:**

  **Item**: `ev_fix-021_1`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: NIST AI 100-2 defines a taxonomy of adversarial machine learning covering four threat categories: evasion attacks (adversarial inputs at inference tim…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Classification framework now explicitly separates abuse attacks (misuse) from technical evasion, poisoning, and privacy …
  - why_this_may_matter: Establishes an authoritative reference for organizations structuring their adversarial ML threat assessments and defense…
  - novelty_signal: NIST's explicit integration of abuse attacks as a distinct adversarial ML category alongside technic…

  **Item**: `ev_fix-021_2`
  - evidence_type: mitigation
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: For each adversarial ML threat category (evasion, poisoning, privacy, abuse), NIST AI 100-2 provides: attack description, affected model types, attack…
  - quote: 
  - quote_entailment: unknown
  - what_changed: NIST now connects adversarial ML threats to both governance (CSF 2.0) and threat intelligence (MITRE ATLAS) frameworks i…
  - why_this_may_matter: Enables organizations to integrate adversarial ML defenses into existing cybersecurity governance structures already bas…
  - novelty_signal: Explicit dual-framework mapping (NIST CSF 2.0 + MITRE ATLAS) for adversarial ML mitigations—bridges …

### [FIXTURE] Membership Inference Attacks Against Production LLMs
- **source_id**: `fix-022`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-022_1`
  - evidence_type: research_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Membership inference attacks achieve 78% accuracy in determining whether specific text was in training data of three production LLMs (GPT-4, Claude 2,…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior membership inference work required white-box or gray-box access; this shows comparable accuracy with API-only quer…
  - why_this_may_matter: Demonstrates training data memorization poses extractable privacy risk for production LLMs serving millions of users.
  - novelty_signal: 78% accuracy against three major production LLMs in black-box setting exceeds prior research results…

  **Item**: `ev_fix-022_2`
  - evidence_type: research_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Medical and legal texts show elevated membership inference accuracy of 84% compared to 78% overall average, indicating domain-specific memorization pa…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Domain-specific privacy leakage is quantified and demonstrates heterogeneous vulnerability across data types.
  - why_this_may_matter: Organizations in healthcare and legal sectors face elevated privacy extraction risk due to memorization patterns.
  - novelty_signal: 6-point accuracy lift for domain-specific content suggests training data curation or deduplication p…

  **Item**: `ev_fix-022_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Membership inference attack method operates via black-box query access requiring 500-2000 queries per target text to infer training data inclusion, en…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior research showed membership inference is feasible; this demonstrates extraction of named sensitive records from pro…
  - why_this_may_matter: Privacy violation mechanism is straightforward and requires no privileged access, creating scaled exploitation risk for …
  - novelty_signal: Recovery of specific real records (patient health records, legal case summaries) demonstrates attack…

  **Item**: `ev_fix-022_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Production LLMs trained on sensitive data create irreversible privacy exposure: GDPR compliance cannot be guaranteed through data deletion alone—organ…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Privacy deletion compliance now carries implicit retraining cost to maintain regulatory defensibility.
  - why_this_may_matter: Organizations relying on model-reuse or fine-tuning cannot easily meet privacy deletion compliance, creating enterprise …
  - novelty_signal: Identifies regulatory enforcement gap—privacy requests create compliance risk if membership inferenc…

### [FIXTURE] CISA AA26-001: APT29 Uses LLM APIs for Spear-Phishing at Scale
- **source_id**: `fix-023`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=primary → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-023_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: APT29 (Cozy Bear) leveraged commercial LLM APIs (OpenAI and Anthropic) to generate highly personalized spear-phishing emails targeting at least 47 US …
  - quote: 
  - quote_entailment: unknown
  - what_changed: APT29 transitioned from template-based email generation to LLM API-assisted personalization; moved from internal capabil…
  - why_this_may_matter: Demonstrates that sophisticated threat actors have operationalized LLM misuse against defended US targets at scale, lowe…
  - novelty_signal: APT29 shifted from template-based campaigns to LLM-generated personalized emails; operational adopti…

  **Item**: `ev_fix-023_2`
  - evidence_type: capability_delta
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: LLM-generated spear-phishing emails attributed to APT29 achieved 34% click rates, compared to 11% click rates in APT29's previous template-based campa…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Click rate increased from 11% to 34% through introduction of LLM-generated personalization; represents measurable operat…
  - why_this_may_matter: The 3x effectiveness gain provides incentive for other threat actors to adopt similar LLM-based social engineering appro…
  - novelty_signal: Prior APT29 campaigns achieved ~11% click rates; introduction of LLM personalization increased this …

  **Item**: `ev_fix-023_3`
  - evidence_type: threat_actor_activity
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: APT29 exploited CVE-2025-8891 (email gateway bypass vulnerability) post-click as part of the spear-phishing campaign chain to establish persistence on…
  - quote: 
  - quote_entailment: unknown
  - what_changed: APT29 added CVE-2025-8891 gateway bypass to their exploitation arsenal as post-click persistence mechanism in the Q4 202…
  - why_this_may_matter: The combination of LLM-personalized initial compromise with a specific vulnerability exploitation chain creates a high-e…
  - novelty_signal: First documented instance of APT29 chaining LLM-generated phishing with CVE-2025-8891 exploitation; …

### [FIXTURE] Deepfake Fraud: AI-Generated CEO Voice Used in $25M Wire Transfer Scam
- **source_id**: `fix-024`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=incident trust_tier=high → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-024_1`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Threat actors used AI-generated voice cloning to impersonate a Fortune 500 CEO and authorize a $25 million wire transfer, combining deepfake voice cal…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Scale and operational sophistication of voice deepfake attacks increased from isolated PoCs to $25M wire fraud with succ…
  - why_this_may_matter: Signals that voice deepfakes have crossed a threshold from research curiosity to weaponized financial crime, creating ur…
  - novelty_signal: Largest confirmed AI deepfake fraud incident to date; operationalizes voice cloning at enterprise fi…

  **Item**: `ev_fix-024_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Voice cloning for CEO impersonation was performed using publicly available audio from earnings calls; the generated voice was rated 'convincing' by 9 …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Voice synthesis quality has advanced to pass 90% human authenticity threshold using only commodity public audio sources.
  - why_this_may_matter: Lowers barrier to entry for voice deepfake attacks against any publicly traded CEO; no special intelligence collection r…
  - novelty_signal: Public earnings call audio repurposed as voice synthesis training data—attackers exploit naturally a…

  **Item**: `ev_fix-024_3`
  - evidence_type: threat_actor_activity
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Unattributed criminal group executed multi-vector social engineering campaign over 3 days, combining deepfake voice call impersonation, spoofed email …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Threat actor tradecraft now incorporates AI voice synthesis as one component in orchestrated social engineering campaign…
  - why_this_may_matter: Shows that voice deepfakes are not standalone tricks; sophisticated actors are layering them with traditional social eng…
  - novelty_signal: Deepfake voice integrated into multi-day, multi-channel social engineering sequence against CFO auth…

  **Item**: `ev_fix-024_4`
  - evidence_type: incident_event
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: This incident represents the largest confirmed AI deepfake fraud case documented to date; the victim company has since implemented voice authenticatio…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Voice authentication has moved from experimental security measure to deployed defense against deepfake CEO fraud.
  - why_this_may_matter: Signals that C-suite financial controls are now actively vulnerable to voice deepfakes; defensive response includes auth…
  - novelty_signal: First documented case of $25M+ deepfake fraud prompts institutional authentication redesign.

### [FIXTURE] AI-Generated Malware: LLMs as Code Generation Tools for Threat Actors
- **source_id**: `fix-025`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-025_1`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Frontier LLMs (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro) generate functional malware code when subjected to jailbreak techniques at measurably higher…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Safety measures reduce but do not eliminate malware generation compliance; jailbreak techniques recover 38–52% of refuse…
  - why_this_may_matter: If adversaries adopt these techniques operationally, the technical skill barrier for malware authorship could drop signi…
  - novelty_signal: Prior capability was limited to blocked requests; now 38–52% of jailbroken requests succeed, and 73%…

  **Item**: `ev_fix-025_2`
  - evidence_type: benchmark_result
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Generated malware code functionality rate: 73% of generated samples are functional without modification; 22% require minor debugging. Only 5% are non-…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Capability shift from 'LLMs can suggest code' to 'LLMs generate deployment-ready malware at high quality without iterati…
  - why_this_may_matter: Reduces time-to-weapon and skill floor for malware development; threat actors with basic prompt engineering could rapidl…
  - novelty_signal: Prior threat models assumed human-written or human-modified malware; immediate 73% functionality wit…

  **Item**: `ev_fix-025_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Jailbreak techniques enable circumvention of LLM safety measures for malware code generation. Specific success rates vary by model: GPT-4o compliance …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Jailbreak prompting elevates LLM malware generation from a 'safety feature prevents this' baseline to an 'safety feature…
  - why_this_may_matter: If threat actors discover or adopt these jailbreak techniques, the cost and complexity of malware authorship drop dramat…
  - novelty_signal: Demonstrates that prompt engineering attacks, not just model capability, are the primary operational…

### [FIXTURE] Unit 42: FIN7 Selling AI-Powered Phishing-as-a-Service to Criminal Groups
- **source_id**: `fix-026`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-026_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: FIN7 (Sangria Tempest) is operating PhishGPT, an LLM-powered phishing-as-a-service offering marketed on underground forums, charging $500–2000 per cam…
  - quote: 
  - quote_entailment: unknown
  - what_changed: FIN7 has shifted from proprietary use of AI-enhanced phishing to service-based distribution model with paying external c…
  - why_this_may_matter: Represents operationalization of AI-phishing at scale with explicit commercialization, potentially accelerating adoption…
  - novelty_signal: Transition from internal FIN7 capability to multi-customer service model; explicit underground forum…

  **Item**: `ev_fix-026_2`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: context_only
  - observed_use: true
  - fact: PhishGPT achieves 4x higher open rates than manual phishing by incorporating victim-specific details sourced from LinkedIn, corporate websites, and so…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Phishing effectiveness (open rate) increased 4-fold through LLM-driven personalization using public profiling data.
  - why_this_may_matter: High claimed effectiveness differential directly explains why adversaries are willing to pay and why secondary threat ac…
  - novelty_signal: Quantified effectiveness metric (4x) establishes AI phishing as measurably superior to manual baseli…

  **Item**: `ev_fix-026_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: PhishGPT employs a reusable technique of sourcing victim-specific personal and professional details from LinkedIn, corporate websites, and social medi…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Phishing campaigns now systematically enriched with public victim intelligence via LLM, shifting from generic to persona…
  - why_this_may_matter: Lowers technical and financial barriers for secondary threat actors; replicable with commercial LLM APIs, making this pa…
  - novelty_signal: Systematized use of public profiling data (LinkedIn, corporate web, social media) as input to LLM fo…

### [FIXTURE] AI-Generated Synthetic Identities for Social Engineering at Scale
- **source_id**: `fix-027`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-027_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Coordinated state-affiliated operation deployed 847 AI-generated synthetic identities on LinkedIn with AI-generated profile photos, synthesized profes…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Transition from experimental deepfake/synthetic identity techniques to operational deployment by state actors at scale; …
  - why_this_may_matter: Demonstrates that state actors have operationalized AI-generated synthetic identity infrastructure as a mature attack ve…
  - novelty_signal: Scale of coordinated synthetic identity deployment (847 profiles); sustained credibility-building ov…

  **Item**: `ev_fix-027_2`
  - evidence_type: capability_delta
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: AI-generated content in synthetic identity campaign achieved 92% human evaluation success rate for authenticity, enabling synthetic profiles to build …
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior synthetic identity work required manual content creation or limited LLM use; this operation scaled to 847 profiles…
  - why_this_may_matter: Indicates that LLM-generated social content has reached a capability threshold where it sustains human credibility for e…
  - novelty_signal: High authenticity metric (92%) enables months of undetected operation; timeline extension from typic…

  **Item**: `ev_fix-027_3`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: Coordinated synthetic identity social engineering attack chain uses AI-generated profile photos, synthesized professional histories, LLM-generated aut…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior social engineering typically deployed quickly with minimal credibility-building; this method inverts timeline to m…
  - why_this_may_matter: Demonstrates adversary sophistication in time-horizon planning and infrastructure staging; suggests this methodology is …
  - novelty_signal: 6-month sustained credibility-building phase before attack execution; coordinated multi-profile oper…

### [FIXTURE] AI-Assisted Vulnerability Discovery Used in Exchange Server 0-Day Attack
- **source_id**: `fix-028`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=high → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-028_1`
  - evidence_type: adversary_adoption
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: A threat actor attributed by MSTIC used an LLM-based code analysis tool to identify CVE-2026-7823 (Exchange Server remote code execution vulnerability…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from manual/traditional vulnerability research to AI-augmented code analysis enabling faster 0-day discovery and e…
  - why_this_may_matter: Signals that AI-assisted vulnerability research has crossed the threshold from theoretical risk to active threat capabil…
  - novelty_signal: Operational adoption of AI code analysis for vulnerability discovery by threat actors; previously un…

  **Item**: `ev_fix-028_2`
  - evidence_type: threat_actor_activity
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: true
  - fact: The threat actor exploited CVE-2026-7823 against 156 organizations globally within 4 days of patch-ready disclosure, with the vulnerability enabling r…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Exploitation speed and scale enabled by AI-assisted discovery; 4-day window to 156 organizations suggests automated or h…
  - why_this_may_matter: Demonstrates that AI-assisted vulnerability discovery removes critical development bottlenecks, allowing threat actors t…
  - novelty_signal: Exceptionally rapid scale-up (156 targets in 4 days) enabled by AI-accelerated discovery and immedia…

  **Item**: `ev_fix-028_3`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: AI-assisted vulnerability discovery reduces the skill barrier and accelerates the timeline for 0-day development and exploitation, as evidenced by MST…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Skill floor for 0-day discovery and weaponization shifts downward due to AI-assisted code analysis automation.
  - why_this_may_matter: Suggests that AI-assisted tools may democratize advanced vulnerability research, enabling lower-skilled threat actors to…
  - novelty_signal: First formal threat intelligence assessment linking AI tools to measurable skill-barrier reduction i…

### [FIXTURE] Evaluating AI Safety Filter Evasion for Malicious Content Generation
- **source_id**: `fix-029`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high → supporting_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-029_1`
  - evidence_type: research_result
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Systematic evaluation of 14 filter evasion techniques against GPT-4o, Claude 3.5, Gemini 1.5, and Llama-3-70B found that 6 techniques achieve >50% byp…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior research focused on single models or limited techniques; this demonstrates >50% bypass rate is achievable across m…
  - why_this_may_matter: Indicates that current commercial LLM safety filters may provide limited protection against motivated, technique-aware a…
  - novelty_signal: Systematic cross-model evaluation; breadth of 14 techniques tested simultaneously.

  **Item**: `ev_fix-029_2`
  - evidence_type: attack_method
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Fictional framing achieves 73% safety filter bypass rate; role-playing as a security researcher achieves 68%; translated inputs via intermediate langu…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior work identified conceptual evasion strategies; this quantifies effectiveness with explicit bypass rates and demons…
  - why_this_may_matter: Simple linguistic evasion techniques with 60%+ success rates lower the barrier to entry for non-specialist actors to eva…
  - novelty_signal: Specific bypass rate measurements for three distinct techniques; demonstration across both malicious…

  **Item**: `ev_fix-029_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Safety filters in major LLM APIs (GPT-4o, Claude 3.5, Gemini 1.5, Llama-3-70B) remain insufficiently robust against motivated adversaries employing ev…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shifts characterization from 'safety filters have limitations' to 'safety filters are insufficiently robust for adversar…
  - why_this_may_matter: Indicates that defenders cannot rely on current LLM safety filter implementations as a primary security control against …
  - novelty_signal: Explicit assertion of insufficiency tied to empirical evasion results; authoritative statement from …

### [FIXTURE] UK NCSC: Guidance on AI-Enhanced Cyber Threats 2026
- **source_id**: `fix-030`
- **evidence_use**: context_only
- **eligible**: yes
- **eligibility_reason**: source_type=governance_signal trust_tier=primary → context_only
- **evidence items extracted**: 0


## Audit Questions

**Is evidence too broad or granular?** Strong evidence should be specific (CVE ID, technique name, percentage) not generic ("AI systems can be attacked").

**Does the quote support the fact?** Check quote_entailment. "supports" = reliable. "partial" = caveat needed. "weak" = should be blocked.

**Are claim permissions too loose?** context_only sources should never have "trend" or "prevalence" permissions.

**Are analytical hooks useful?** "what_changed" should describe a specific change, not "AI capabilities are evolving generally."
