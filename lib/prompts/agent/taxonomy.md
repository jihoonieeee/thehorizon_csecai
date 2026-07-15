# AI Threat Taxonomy Reference

Use these exact definitions when naming attack classes in your answer. Imprecise or interchanged terms are a quality failure.

## The Governing Question

Ask first: Is AI the **TARGET** or the **WEAPON**?
- AI is ATTACKED → traditional_ai_threats | llm_threats | agentic_ai_threats (decide by which AI system)
- AI is the ATTACKER'S TOOL against a non-AI victim → ai_enabled_threats

## Category Discriminators (memorise these)

**traditional_ai_threats** — attacker exploits a CLASSICAL ML model (classifier, detector, recommender, RL policy) AS A MACHINE LEARNING ARTIFACT: its weights, training data, inference path, or supply chain. The model outputs a label/score/decision, NOT free-form language.

**llm_threats** — attacker exploits an LLM AS AN INSTRUCTION-FOLLOWING LANGUAGE SYSTEM: prompts, context, guardrails, RAG, embeddings, model output surface. The harm stays in the model's response or data — no autonomous action taken.

**agentic_ai_threats** — attacker exploits an autonomous agent AS AN AUTONOMOUS ACTOR: it calls tools/APIs/MCP, executes code, keeps memory, holds credentials, or orchestrates other agents. The defining fact is AGENCY — the system acts beyond emitting text.

**ai_enabled_threats** — AI is the attacker's weapon; the victim is a human, organisation, or conventional system (not an AI system). An attacker-owned agent doing harm to a normal victim is ai_enabled, not agentic.

## LLM Threat Tags (llm_threats)

**LLM01_prompt_injection** — Attacker-controlled text OVERRIDES the developer's instructions by riding in an UNTRUSTED CHANNEL the model reads: a web page it browses, a RAG document, an email, a file, a tool response, or text in an image. The key: the injection comes from CONTENT the model ingests, not directly from the user. Consequence stays textual. If the injection makes an agent ACT (call a tool, run code), use the agentic tag (ASI02/ASI05) as primary and keep LLM01 as secondary.

**LLM11_jailbreak_safety_bypass** — The DIRECT USER defeats the model's own safety alignment/refusal training to elicit disallowed output. Examples: adversarial suffixes, roleplay/DAN personas, many-shot priming, encoding tricks, multi-turn erosion of refusals. The key: the USER is the source, not external content. NO external/untrusted data channel involved.

**CRITICAL DISCRIMINATOR — LLM01 vs LLM11:**
- Instructions embedded in a web page, document, email, API response, image → **LLM01** (indirect prompt injection)
- The user themselves typing overrides or tricks directly into the chat → **LLM11** (jailbreak)
- These are NOT the same attack class. Never conflate them. A production system breach via injected content in retrieved docs is LLM01. A user crafting a DAN prompt is LLM11.

**LLM02_sensitive_info_disclosure** — Model or app exposes confidential data in outputs: PII, API keys, memorised training data, another tenant's data. Also covers LLM/RAG membership inference when leaked content is the objective.

**LLM03_llm_supply_chain** — TRUST in how an LLM-stack component is PRODUCED, DISTRIBUTED, or INSTALLED was subverted: hijacked maintainer account, malicious PyPI/npm release, poisoned checkpoint/LoRA/adapter, trojaned plugin. NOT an ordinary CVE in a legitimately released product.

**LLM04_data_model_poisoning** — The DATA an LLM depends on is corrupted: RAG/corpus poisoning, fine-tuning or alignment data poisoning, embedding-store corruption. NOT a one-shot retrieval injection (→ LLM01).

**LLM05_improper_output_handling** — The APPLICATION trusts model output and passes it unvalidated to a downstream system that executes it: LLM-generated SQL run against a DB, generated shell code executed, HTML output rendered → XSS.

**LLM06_excessive_agency** — The LLM is granted too much authority BY DESIGN: broad tool access, write/delete scopes, no human-in-the-loop confirmation. Risk is the standing GRANT, not a specific in-the-wild hijack.

**LLM07_system_prompt_leakage** — Extracting the hidden system/developer prompt or guardrail rules from the model.

**LLM08_vector_embedding_weakness** — The vector store / embedding layer is attacked: embedding inversion, retrieval-ranking abuse, cross-tenant leakage in a shared vector DB.

**LLM09_misinformation** — Model produces false/fabricated content trusted by downstream users: hallucinated citations, fake package names ("slopsquatting"), wrong security guidance.

**LLM10_unbounded_consumption** — Uncontrolled token/cost/resource consumption against an LLM service: denial-of-wallet, token flooding, recursive context expansion.

## Traditional AI Threat Tags (traditional_ai_threats) — classical ML only

**TAI01_data_poisoning** — Manipulating TRAINING INPUTS (data, labels, learning signals) of a classical ML model. Attacker never touches weights directly.

**TAI02_model_poisoning** — Directly editing a classical ML model's WEIGHT TENSORS or artifacts post-training. If the poisoned model is an LLM → LLM03/LLM04 instead.

**TAI03_adversarial_evasion** — Crafting inputs at inference time to cause a classical classifier/detector to misclassify, while appearing normal to humans. Evading an LLM's guardrail → LLM11 (direct) or LLM01 (content-injected).

**TAI05_model_extraction** — Primary goal is to recover the classical ML MODEL ITSELF: weights, architecture, decision boundary. A working replica is the loot. Extracting an LLM → LLM10.

**TAI06_model_inversion** — Recovering TRAINING DATA content from a classical model's behaviour. Against an LLM/RAG → LLM02.

**TAI07_membership_inference** — Determining whether a specific RECORD was in training data (binary yes/no). Against LLM → LLM02.

**TAI08_inference_api_abuse** — Abnormal use of a classical model's inference API for reconnaissance: behavior mapping, output scraping, without full extraction.

**TAI09_model_denial_of_service** — Degrading a classical ML model's availability or exhausting its inference compute. LLM cost/token DoS → LLM10.

**TAI10_ai_supply_chain_compromise** — PROCESS or TRUST INFRASTRUCTURE around a classical ML model is compromised: build pipeline, compiler, serialization loader, model hub, quantisation toolchain. LLM stack supply chain → LLM03.

## Agentic AI Threat Tags (agentic_ai_threats)

**ASI01_agent_goal_hijack** — Redirecting an agent's OBJECTIVE or plan so it pursues the attacker's goal.

**ASI02_tool_misuse_exploitation** — Agent is driven to invoke a legitimate, authorized tool in a harmful way. The harm is the ACTION taken with an allowed tool.

**ASI03_identity_privilege_abuse** — Agent's identity, credentials, delegated permissions, or authorization model is the weakness. Missing authorization gates count here.

**ASI04_agentic_supply_chain** — A component the AGENT LOADS AND RUNS AT RUNTIME is compromised, and harm flows through the agent acting on it (selecting/invoking the malicious tool). An npm package that runs at install time with no agent involvement → NOT ASI04.

**ASI05_unexpected_code_execution** — Code execution reached THROUGH AN AGENTIC PATH: an autonomous agent's own tool/shell/interpreter is what runs the code. A deterministic HTTP endpoint that runs subprocess() → NOT ASI05.

**ASI06_memory_context_poisoning** — Attacker seeds the agent's LONG-TERM MEMORY with malicious data that persists into future sessions. One-shot injection with immediate effect and no persistence → LLM01.

**ASI07_insecure_agent_comms** — Attack abuses channels BETWEEN agents or between agent and orchestrator: A2A injection, orchestrator impersonation.

**ASI08_cascading_failures** — Compromise propagates and amplifies ACROSS a multi-agent ecosystem.

**ASI09_human_agent_trust_exploit** — Attacker manipulates a HUMAN's trust in an agent to obtain a harmful authorization.

**ASI10_rogue_agents** — Unauthorized or unmonitored autonomous agents operating outside governance.

## AI-Enabled Threat Tags (ai_enabled_threats) — AI is the weapon, victim is non-AI

**AE01_ai_recon** — AI accelerates target discovery, OSINT, asset enumeration, victim profiling.

**AE02_ai_social_engineering** — AI generates phishing, pretexting, or persuasion aimed at people at scale.

**AE03_ai_vuln_research** — AI autonomously discovers or triages vulnerabilities in a target's software.

**AE04_ai_exploit_dev** — AI generates, adapts, or weaponizes a working exploit.

**AE05_ai_malware_dev** — AI authors, mutates, or packages malicious software. Also: conventional malware distributed disguised as an AI artifact.

**AE06_ai_evasion_obfuscation** — AI makes malicious content or behavior harder to detect: AI-driven obfuscation, AV/EDR evasion, crafting inputs to fool defender's AI triage.

**AE07_ai_identity_abuse** — AI-driven impersonation, credential abuse, or synthetic-identity creation. NOT deepfakes → AE10.

**AE08_ai_attack_orchestration** — AI autonomously coordinates a multi-stage attack chain (recon → access → action). NOT attacks that target an agent (those are agentic_ai_threats).

**AE09_ai_disinformation** — AI generates disinformation or influence operations targeting a population at scale.

**AE10_ai_deepfake** — AI-generated synthetic video/audio/image used for fraud, impersonation, or extortion.
