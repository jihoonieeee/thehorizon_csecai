# Layer 5A — Evidence Extraction Deep Report

> **Run ID**: `debug5-2026-06-16T14-02-23`  
> **Generated**: 2026-06-16T14:05:14.410Z

## Overview

| Metric | Value |
| --- | --- |
| Sources processed | 5 |
| Evidence items total | 0 |
| Strong items | 0 |
| Usable items | 0 |
| Context only | 0 |
| Evidence packs | 4 |
| Clusters (dedup) | 3 |


## Evidence Pack Summary by Category

| Category | Strong | Usable | Context | Statistics |
| --- | --- | --- | --- | --- |
| traditional_ai_threats | 0 | 0 | 0 | 0 |
| llm_threats | 0 | 0 | 0 | 0 |
| agentic_ai_threats | 0 | 0 | 0 | 0 |
| ai_enabled_threats | 0 | 0 | 0 | 2 |


## Per-Source Evidence Detail

### CISA Alert: Threat Actors Exploit LLM APIs to Automate Phishing Campaigns at Scale
- **source_id**: `sample-0`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=threat_intelligence trust_tier=high concreteness=vague_commentary → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_sample-0_1`
  - evidence_type: adversary_adoption
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: Nation-state actors are using LLM APIs to generate over 50,000 unique spear-phishing emails daily targeting critical infrastructure personnel.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Phishing campaign scale and personalization capability expanded to 50,000+ contextually aware emails per day via LLM API…
  - why_this_may_matter: Automation of personalized spear-phishing at 50k+/day scale significantly increases targeting throughput and success pro…
  - novelty_signal: Scale and attribution to nation-state actors; prior phishing campaigns lacked this level of personal…

  **Item**: `ev_sample-0_2`
  - evidence_type: attack_method
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: LLM APIs enable generation of spear-phishing emails with contextual awareness of targets' professional roles, public statements, and organizational af…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Phishing generation moved from manual composition to automated LLM synthesis, enabling contextual personalization previo…
  - why_this_may_matter: Contextual personalization significantly increases phishing credibility and click-through rates compared to generic atta…
  - novelty_signal: Prior spear-phishing required manual research and writing; LLM APIs now enable automated synthesis o…

  **Item**: `ev_sample-0_3`
  - evidence_type: capability_delta
  - evidence_strength: context
  - admissibility: passed
  - observed_use: true
  - fact: LLM API-driven phishing campaigns now operate at unprecedented scale (50,000+ emails/day) with contextual personalization, expanding attacker reach co…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Phishing capability multiplied from manual (low volume, high personalization) to LLM-automated (high volume + high perso…
  - why_this_may_matter: Combination of scale and personalization creates asymmetric targeting advantage: defenders face 50k+ contextually tailor…
  - novelty_signal: Scale increased from hundreds/day (manual spear-phishing) to 50,000+/day (LLM-automated), while main…

### Indirect Prompt Injection Attacks Against Autonomous LLM Agents: A Systematic Study
- **source_id**: `sample-1`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=high concreteness=concrete_metric → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_sample-1_1`
  - evidence_type: research_result
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: 92% of 12 tested autonomous LLM agent frameworks are vulnerable to indirect prompt injection via tool outputs.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior work showed prompt injection as theoretical risk; this demonstrates empirical vulnerability at 92% prevalence acro…
  - why_this_may_matter: If tool-use agents are widely deployed in enterprise environments without output validation, this represents a pervasive…
  - novelty_signal: Systematic quantification of indirect prompt injection surface across multiple framework architectur…

  **Item**: `ev_sample-1_2`
  - evidence_type: attack_method
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Indirect prompt injection attacks enable data exfiltration, privilege escalation, and lateral movement to connected systems in autonomous agents.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Prior prompt injection attacks targeted single model outputs; this demonstrates chaining through tool-use to reach authe…
  - why_this_may_matter: If agents have legitimate access to APIs, databases, or cloud services, prompt injection becomes a privilege-escalation …
  - novelty_signal: Extends prompt injection impact model from single-model jailbreak to multi-system compromise chain i…

  **Item**: `ev_sample-1_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Six injection vectors identified in autonomous agents: document retrieval, web browsing, code execution, API responses, memory recall, and sub-agent o…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Direct prompt injection mitigations (user input filtering) do not address injection via tool outputs, requiring new defe…
  - why_this_may_matter: Defenders must secure multiple distinct tool-output pathways; no single mitigation covers all vectors.
  - novelty_signal: Systematic taxonomy of indirect prompt injection entry points across agent tool ecosystems—prior wor…

  **Item**: `ev_sample-1_4`
  - evidence_type: mitigation
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Proposed mitigations for indirect prompt injection include instruction hierarchy enforcement and output sandboxing.
  - quote: 
  - quote_entailment: unknown
  - what_changed: No prior agent-security guidance explicitly addressed indirect prompt injection mitigation; these are novel recommendati…
  - why_this_may_matter: Organizations deploying tool-use agents can begin implementing these mitigations immediately without waiting for framewo…
  - novelty_signal: Applies well-known security principles (privilege separation, sandboxing) to agent architecture, but…

### Microsoft Security Report: Adversarial ML Attacks Against AI-Powered Security Products
- **source_id**: `sample-2`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=threat_intelligence trust_tier=high concreteness=vague_commentary → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_sample-2_1`
  - evidence_type: capability_delta
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: true
  - fact: Adversarial ML attacks targeting AI-powered security tools increased 340% over 12 months.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack volume against AI security tools expanded 3.4x in 12 months, indicating shift from research/lab stage to operatio…
  - why_this_may_matter: Rapid scaling suggests adversaries have operationalized adversarial ML techniques against deployed security products, cr…
  - novelty_signal: 340% increase establishes adversarial ML attacks on security tools as rapidly scaling threat categor…

  **Item**: `ev_sample-2_2`
  - evidence_type: attack_method
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: true
  - fact: Attackers use adversarial input crafting against transformer-based malware classifiers to evade detection.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack surface expanded to transformer-based classifiers, requiring defender adaptation beyond traditional adversarial r…
  - why_this_may_matter: Transformer models are increasingly used for security detection; operationalized evasion against them undermines defense…
  - novelty_signal: Operational use of adversarial input crafting against transformer classifiers (vs. traditional ML); …

  **Item**: `ev_sample-2_3`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: passed
  - observed_use: true
  - fact: Attackers poison threat detection models through compromised telemetry feeds to degrade detection fidelity.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack surface expanded from inference evasion to training-data supply chain; requires defender monitoring of telemetry …
  - why_this_may_matter: If adversaries can sustain telemetry feed compromise, they can degrade detection model fidelity continuously without tri…
  - novelty_signal: Operationalized data poisoning through telemetry infrastructure (vs. academic poisoning attacks); ta…

  **Item**: `ev_sample-2_4`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: passed
  - observed_use: true
  - fact: Attackers perform model extraction attacks against vendor-hosted detection APIs to enable offline evasion development.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack capability expanded to include upstream model recovery; reduces attacker operational friction for developing dete…
  - why_this_may_matter: Successful extraction decouples attacker evasion development from detection system, eliminating real-time detection feed…
  - novelty_signal: Operationalized model extraction targeting security APIs (vs. research lab demonstrations); creates …

### CVE-2025-23456: Remote Code Execution via Deserialization in LangChain Agent Framework
- **source_id**: `sample-3`
- **evidence_use**: do_not_extract
- **eligible**: no
- **eligibility_reason**: relevance_tier is off_topic
- **evidence items extracted**: 0

### Google DeepMind: Jailbreaking State-of-the-Art LLMs via Many-Shot In-Context Learning
- **source_id**: `sample-4`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high concreteness=concrete_research → primary_evidence
- **evidence items extracted**: 6

**Evidence Items:**

  **Item**: `ev_sample-4_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: Many-shot in-context learning bypasses safety guardrails in GPT-4, Claude 3, and Gemini Ultra.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack surface expanded from white-box/fine-tuning attacks to black-box API-only exploitation using prompt engineering.
  - why_this_may_matter: If operationalised at scale via public APIs, could enable systematic extraction of harmful outputs from widely-deployed …
  - novelty_signal: Previous attacks often required model weights or specialized access; this works via standard API que…

  **Item**: `ev_sample-4_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Attack achieves 85%+ success rates against GPT-4, Claude 3, and Gemini Ultra using 100+ crafted question-answer pairs.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Exploit reliability increased substantially via many-shot amplification technique.
  - why_this_may_matter: Success rate above threshold for operational use in adversarial campaigns or red-team validation of model safety.
  - novelty_signal: Prior prompt injection attacks typically showed lower success rates; this demonstrates significantly…

  **Item**: `ev_sample-4_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Attack vulnerability scales with context window size; models with larger context windows are more vulnerable.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Larger context windows, previously seen as user-value improvement, now recognized as expanding jailbreak surface.
  - why_this_may_matter: Models competing on context window length are inadvertently increasing their security surface; trend toward 200K+ contex…
  - novelty_signal: Direct causal relationship between context window size and exploit success is novel; implies vulnera…

  **Item**: `ev_sample-4_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: archive
  - admissibility: failed
  - observed_use: false
  - fact: Attack requires only standard API queries; no model weights or privileged access needed.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack surface moved from research/insider threat to public API surface accessible to all users.
  - why_this_may_matter: Any actor with API credentials can mount attack at scale; makes vulnerability immediately exploitable by adversarial cam…
  - novelty_signal: Prior jailbreaks often required weight access, fine-tuning capabilities, or gradient-based methods; …

  **Item**: `ev_sample-4_5`
  - evidence_type: mitigation
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Proposed defense: context length limits on safety-critical deployments.
  - quote: 
  - quote_entailment: unknown
  - what_changed: New defense class emerging specifically to address many-shot attacks.
  - why_this_may_matter: Operational tradeoff: limiting context windows reduces attacker surface but constrains legitimate use cases requiring lo…
  - novelty_signal: First public proposal for context-length-based defense against in-context jailbreaks.
  _...1 more items omitted_


## Audit Questions

**Is evidence too broad or granular?** Strong evidence should be specific (CVE ID, technique name, percentage) not generic ("AI systems can be attacked").

**Does the quote support the fact?** Check quote_entailment. "supports" = reliable. "partial" = caveat needed. "weak" = should be blocked.

**Are claim permissions too loose?** context_only sources should never have "trend" or "prevalence" permissions.

**Are analytical hooks useful?** "what_changed" should describe a specific change, not "AI capabilities are evolving generally."
