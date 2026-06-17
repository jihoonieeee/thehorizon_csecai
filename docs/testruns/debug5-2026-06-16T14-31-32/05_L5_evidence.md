# Layer 5A — Evidence Extraction Deep Report

> **Run ID**: `debug5-2026-06-16T14-31-32`  
> **Generated**: 2026-06-16T14:31:39.119Z

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
| llm_threats | 0 | 0 | 0 | 1 |
| agentic_ai_threats | 0 | 0 | 0 | 0 |
| ai_enabled_threats | 0 | 0 | 0 | 0 |


## Per-Source Evidence Detail

### [FIXTURE] Automated Jailbreak via PAIR: 88% ASR on GPT-4
- **source_id**: `fix-001`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high concreteness=concrete_research → supporting_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-001_1`
  - evidence_type: capability_delta
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: PAIR algorithm achieves 88% attack success rate on GPT-4 in black-box setting with fewer than 20 queries.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack success rate and automation: prior jailbreak methods required domain expertise and many manual iterations; PAIR a…
  - why_this_may_matter: If operationalized at scale, could enable adversaries to systematically bypass GPT-4 safety measures with minimal comput…
  - novelty_signal: Black-box automated jailbreak with 88% ASR in <20 queries represents operational feasibility thresho…

  **Item**: `ev_fix-001_2`
  - evidence_type: attack_method
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: PAIR is an automated algorithm for adversarial prompt generation that iteratively refines jailbreak payloads against target LLM.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Operational autonomy: attack generation moved from manual craft to automated algorithm, eliminating expertise barrier.
  - why_this_may_matter: Enables adversaries without prompt-engineering expertise to generate effective jailbreaks at scale, democratizing access…
  - novelty_signal: Automation of jailbreak generation: prior attacks relied on human-in-the-loop creativity; PAIR demon…

  **Item**: `ev_fix-001_3`
  - evidence_type: benchmark_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: PAIR was evaluated across 10 harmful behavior categories on GPT-4.
  - quote: 
  - quote_entailment: unknown
  - why_this_may_matter: Generality across 10 harm categories suggests jailbreak reliability is not dependent on specific harm domain, increasing…

  **Item**: `ev_fix-001_4`
  - evidence_type: benchmark_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Input-filtering defenses reduce PAIR attack success rate to 34% on GPT-4.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Defense effectiveness delta: input filtering reduces threat but leaves 34% success, indicating incomplete coverage.
  - why_this_may_matter: If input filtering alone leaves 34% success rate, defenders must layer additional controls or accept significant residua…
  - novelty_signal: Defense residual ASR of 34% shows that simple input filtering fails to close the automated jailbreak…

### [FIXTURE] CISA Alert AA26-001: LLM-Assisted Spear-Phishing by APT29
- **source_id**: `fix-002`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=adversary_adoption_signal trust_tier=primary concreteness=concrete_metric → primary_evidence
- **evidence items extracted**: 3

**Evidence Items:**

  **Item**: `ev_fix-002_1`
  - evidence_type: adversary_adoption
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: true
  - fact: APT29 leveraged commercial LLM APIs to generate personalized spear-phishing emails targeting US government contractors in Q4 2025.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Shift from manual spear-phishing composition to automated, personalized LLM generation; success rate jump from 11% to 34…
  - why_this_may_matter: Demonstrates that advanced threat actors have moved beyond research into operational deployment of LLM-assisted social e…
  - novelty_signal: LLM-generated emails achieved 3x higher click rates than traditional phishing, indicating capability…

  **Item**: `ev_fix-002_2`
  - evidence_type: threat_actor_activity
  - evidence_strength: archive
  - admissibility: context_only
  - observed_use: true
  - fact: APT29 targeted at least 47 US government contractors across defense, aerospace, and critical infrastructure sectors in Q4 2025.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Scale and sector concentration of LLM-assisted phishing campaigns; previously isolated/anecdotal reports now confirmed a…
  - why_this_may_matter: Breadth of targeting indicates APT29 views LLM-assisted phishing as reliable enough to deploy against highest-value targ…
  - novelty_signal: Multi-sector targeting across defense/aerospace/critical infrastructure; suggests LLM capability is …

  **Item**: `ev_fix-002_3`
  - evidence_type: capability_delta
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: true
  - fact: LLM-generated spear-phishing emails achieved 34% click rates vs 11% for traditional phishing—a 3x improvement.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Attack success rate improvement from 11% to 34% represents a 3x multiplier; enables same targeting scope to yield 3x hig…
  - why_this_may_matter: If this improvement holds across other threat actors and campaigns, LLM-assisted phishing may become standard practice, …
  - novelty_signal: Prior baseline: 11% CTR for traditional phishing. New LLM-assisted baseline: 34% CTR. This 23-percen…

### [FIXTURE] MCP Tool Poisoning: Arbitrary Code Execution via LLM Agent Tool Calls
- **source_id**: `fix-003`
- **evidence_use**: primary_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=vulnerability trust_tier=high concreteness=vague_commentary → primary_evidence
- **evidence items extracted**: 4

**Evidence Items:**

  **Item**: `ev_fix-003_1`
  - evidence_type: vulnerability_fact
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: CVE-2026-1337 in MCP reference implementation allows attackers to inject malicious tool definitions causing LLM agents to execute arbitrary system com…
  - quote: 
  - quote_entailment: unknown
  - what_changed: Tool calls, previously assumed safe because tools are server-defined, become exploitable if tool definitions themselves …
  - why_this_may_matter: If widely deployed without patching, tool-augmented AI agents become direct attack surfaces for system compromise withou…
  - novelty_signal: Demonstrates that LLM agents executing tool calls lack output sandboxing, enabling command injection…

  **Item**: `ev_fix-003_2`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: CVE-2026-1337 stems from insufficient sandboxing of tool call outputs in MCP.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Tool execution model requires output isolation as a mandatory control, not optional hardening.
  - why_this_may_matter: Fixes must address sandboxing architecture, not just input validation; impacts all downstream MCP server implementations…
  - novelty_signal: Reveals that MCP's threat model did not account for poisoned tool definitions; sandboxing must apply…

  **Item**: `ev_fix-003_3`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Claude 3.5, GPT-4 Turbo, and Gemini 1.5 are all affected by CVE-2026-1337.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Risk is ecosystem-wide; any organization using MCP-augmented Claude, GPT-4, or Gemini is affected.
  - why_this_may_matter: Patches must be applied across three major LLM ecosystems; coordination risk increases if vendors move at different time…
  - novelty_signal: Confirms that MCP vulnerabilities affect all downstream LLM consumers (Anthropic, OpenAI, Google), n…

  **Item**: `ev_fix-003_4`
  - evidence_type: vulnerability_fact
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: CVSS 9.1 severity patch for CVE-2026-1337 is available in MCP v0.8.3.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Organizations can move from vulnerable (MCP <v0.8.3) to patched state; no workaround alternatives documented.
  - why_this_may_matter: Defenders must prioritize MCP upgrades across all agentic deployments; delay creates RCE exposure in production systems.
  - novelty_signal: Patch availability on same disclosure date reduces window for unpatched exploitation, but only if or…

### [FIXTURE] Model Extraction via API Queries: Reproducing LLaMA-3 Weights at 0.1% Cost
- **source_id**: `fix-004`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=capability_demonstration trust_tier=high concreteness=concrete_research → supporting_evidence
- **evidence items extracted**: 5

**Evidence Items:**

  **Item**: `ev_fix-004_1`
  - evidence_type: capability_delta
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: LLaMA-3-70B weights can be extracted via API queries in under 24 hours on a 32-GPU cluster, achieving 91% of original performance.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Model extraction shifted from infeasible/expensive (white-box requirement) to practical and cost-effective (24h, $840, b…
  - why_this_may_matter: If operationalized at scale, could enable low-cost unauthorized model replication, undermining the training investment a…
  - novelty_signal: Prior extraction attacks required either white-box access or large-scale synthetic training data; th…

  **Item**: `ev_fix-004_2`
  - evidence_type: capability_delta
  - evidence_strength: archive
  - admissibility: passed
  - observed_use: false
  - fact: Model extraction cost reduced to 0.04% of original training cost ($840 vs $2.1M for LLaMA-3-70B).
  - quote: 
  - quote_entailment: unknown
  - what_changed: Economic threshold for model extraction dropped from millions (infeasible for most attackers) to hundreds of dollars (ac…
  - why_this_may_matter: Sub-$1k cost dramatically lowers the barrier for malicious or competitive actors to replicate proprietary models.
  - novelty_signal: Prior extraction methods, if demonstrated, did not achieve sub-0.1% cost efficiency against producti…

  **Item**: `ev_fix-004_3`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Attack uses adaptive query scheduling to minimize detectability during model extraction.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Extraction attack profile shifted from detectable bulk queries to adaptive scheduling that blends with normal API usage …
  - why_this_may_matter: If extraction can evade rate-limit and traffic-pattern detection, defenses based on query anomaly detection will be less…
  - novelty_signal: Prior extraction demonstrations did not emphasize detectability evasion; adaptive scheduling adds an…

  **Item**: `ev_fix-004_4`
  - evidence_type: benchmark_result
  - evidence_strength: usable
  - admissibility: passed
  - observed_use: false
  - fact: Query rate limiting reduces extracted model performance from 91% to 71% of original benchmark.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Defense efficacy against API extraction shifted from untested to partially effective (20 percentage-point quality loss).
  - why_this_may_matter: Partial effectiveness of rate limiting suggests that defenders require layered controls; rate limiting alone is insuffic…
  - novelty_signal: Quantifies rate-limiting effectiveness; prior work did not provide measured defense comparison.

  **Item**: `ev_fix-004_5`
  - evidence_type: attack_method
  - evidence_strength: context
  - admissibility: context_only
  - observed_use: false
  - fact: Output perturbation is only partially effective at defending against model extraction via API queries.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Defense landscape for model extraction now includes quantified comparison of defenses; perturbation is weaker than struc…
  - why_this_may_matter: If output perturbation is partially effective but rate limiting is more effective, defenders should prioritize query-lev…
  - novelty_signal: Comparative evaluation of defenses; prior work did not rank perturbation effectiveness against rate …

### [FIXTURE] NIST AI 100-2: Adversarial ML Taxonomy and Mitigation Guide
- **source_id**: `fix-005`
- **evidence_use**: supporting_evidence
- **eligible**: yes
- **eligibility_reason**: source_type=research_finding trust_tier=primary concreteness=vague_commentary → supporting_evidence
- **evidence items extracted**: 2

**Evidence Items:**

  **Item**: `ev_fix-005_1`
  - evidence_type: attack_method
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: NIST AI 100-2 taxonomy covers evasion attacks as a threat category with descriptions of attack procedures and target model types.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Formalization of adversarial ML threat categories into a NIST-endorsed taxonomy linked to CSF 2.0.
  - why_this_may_matter: Standardized taxonomy enables consistent threat modeling and mitigation planning across organizations deploying ML syste…
  - novelty_signal: Explicit structural mapping of evasion, poisoning, privacy, and abuse into a single unified taxonomy…

  **Item**: `ev_fix-005_2`
  - evidence_type: mitigation
  - evidence_strength: strong
  - admissibility: passed
  - observed_use: false
  - fact: NIST AI 100-2 provides recommended mitigations mapped to NIST CSF 2.0 and MITRE ATLAS for adversarial ML attacks.
  - quote: 
  - quote_entailment: unknown
  - what_changed: Adversarial ML mitigations now formally mapped to widely-adopted NIST and MITRE standards.
  - why_this_may_matter: Alignment with established frameworks reduces friction for organizations integrating ML-specific security controls into …
  - novelty_signal: First explicit integration of adversarial ML mitigations into NIST CSF 2.0 and MITRE ATLAS framework…


## Audit Questions

**Is evidence too broad or granular?** Strong evidence should be specific (CVE ID, technique name, percentage) not generic ("AI systems can be attacked").

**Does the quote support the fact?** Check quote_entailment. "supports" = reliable. "partial" = caveat needed. "weak" = should be blocked.

**Are claim permissions too loose?** context_only sources should never have "trend" or "prevalence" permissions.

**Are analytical hooks useful?** "what_changed" should describe a specific change, not "AI capabilities are evolving generally."
