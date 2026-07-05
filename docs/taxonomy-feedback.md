# Taxonomy Classification — Feedback & Issues Log

Status: **COLLECTING FEEDBACK** — do not plan or implement until user signals done.

---

## Root Cause (agreed)

The pipeline classifies by **keyword/topic/technology mentioned** rather than by the source's **primary security objective + exploit mechanism + primary contribution**. This produces over-inclusion in nearly every category and cross-category overlap.

---

## Proposed Structural Fix (agreed in principle)

An intermediate **mechanism-first classification stage** before taxonomy assignment:
- `primary_security_property`
- `primary_exploit_mechanism`
- `evidence_role`
- `affected_layer`
- `final_taxonomy`
- `secondary_tags`
- `keep_in_original_category`
- `rationale_one_sentence`

---

## LLM Taxonomy Redesign

### Add LLM11 Jailbreak / Safety Bypass (approved)
- New primary tag for jailbreak/safety-bypass papers (currently routed to unclear after being stripped from LLM01).
- Include: prompt-based jailbreaks, multi-turn jailbreaks, roleplay jailbreaks, obfuscation jailbreaks, multimodal jailbreaks, audio jailbreaks, adversarial suffixes, refusal bypass, alignment bypass, safety policy circumvention.
- Jailbreak as DELIVERY MECHANISM in a prompt injection → LLM01 primary, LLM11 secondary.
- Direct user-to-model jailbreak → LLM11 primary.

### LLM01 Prompt Injection
- Keep ONLY when attacker-controlled content arrives through an EXTERNAL, UNTRUSTED CHANNEL (web pages, emails, tool outputs, uploaded files, images, audio, retrieved documents, code comments, API responses) and injects instructions the model executes.
- Do NOT include jailbreak-only papers (those go to LLM11).
- If result is data theft or tool execution: keep LLM01 secondary but classify primary by main consequence (LLM02 or LLM06) if stronger.

### LLM02 Sensitive Information Disclosure
- Keep ONLY when confidentiality is the primary security property affected.
- Include: secrets, credentials, API keys, private data, prompt leakage, training data leakage, RAG leakage, memory leakage, cross-user/cross-tenant leakage, membership inference, model inversion, information disclosure CVEs.
- Do NOT include generic privacy, generic prompt injection, jailbreaks, or red teaming unless actual data disclosure is explicit.

### LLM03 Supply Chain
- Keep ONLY when risk enters through models, datasets, dependencies, plugins, extensions, prompt templates, containers, packages, model-serving infrastructure, AI gateways, third-party AI services, or deployment artifacts.
- Do NOT classify every LLM product CVE as supply chain. Generic SQLi, auth bypass, SSRF, LFI belongs in unclear unless supply-chain path is explicit.

### LLM04 Data & Model Poisoning
- Keep ONLY when model, fine-tuning data, reward model, embeddings, RAG corpus, retrieved knowledge base, adapter, LoRA, checkpoint, or dataset is intentionally manipulated.
- RAG poisoning belongs HERE (not LLM08).
- Generic RAG attacks, hallucination reduction, retrieval evaluation, vector leakage → do NOT auto-assign here.

### LLM05 Improper Output Handling
- Keep ONLY when application UNSAFELY CONSUMES model output (executes, renders, parses, trusts, passes to downstream tools without validation).
- Include: unsafe generated code, shell commands, SQL, HTML/Markdown rendering, template execution, browser execution, file writes, tool calls, command execution.
- Do NOT include generic AI app CVEs unless root cause is unsafe handling of LLM output.

### LLM06 Excessive Agency
- Keep ONLY when LLM/agent has excessive authority, autonomy, permissions, tool access, API access, recursive behavior, autonomous execution, or unsafe tool chaining.
- Agent prompt injection may have LLM01 secondary, but LLM06 should be primary when core risk is over-authorized action.

### LLM07 System Prompt Leakage
- Keep ONLY when objective is to RECOVER, INFER, EXPOSE, or LEAK hidden instructions, system prompts, developer prompts, internal policies, or agent prompts.
- Do NOT include generic prompt injection, jailbreak detection, or safety papers unless hidden instruction disclosure is explicit.

### LLM08 Vector/Embedding Weaknesses
- Keep ONLY when exploit TARGETS embeddings or vector representations as the VICTIM (inverting to recover private data, enumerating a vector DB, cross-tenant vector leakage, ANN search manipulation, embedding inversion, vector side channels).
- Do NOT classify every RAG paper here.
- Embedding POISONED to cause wrong behavior → LLM04. Embedding STOLEN/INVERTED to reveal private data → LLM08.

### LLM09 Hallucination & Misinformation (rename from Misinformation)
- Keep ONLY when false or misleading information is generated, amplified, defended against, or evaluated.
- Include: hallucinated content, fabricated facts, fabricated citations, package hallucinations, fake evidence, synthetic news, political misinformation, authority impersonation, misinformation defenses.
- Do NOT include jailbreak, generic red teaming, vulnerability detection benchmarks, or general evaluation papers.

### LLM10 Unbounded Consumption
- Keep ONLY when primary effect is resource exhaustion, DoS, denial of wallet, token exhaustion, context exhaustion, GPU/memory exhaustion, recursive loops, API cost amplification, or tool-call amplification.

### Deterministic Sanity Checks (to bake in as gates)
- Title/abstract contains jailbreak/refusal/harmful compliance/safety bypass/adversarial suffix/roleplay/DAN/alignment bypass → do NOT assign LLM01 unless injection through untrusted context is explicit.
- Title/abstract contains RAG/retrieval/vector/embedding → classify the actual mechanism: poisoning, leakage, similarity manipulation, hallucination, or evaluation.
- Source is a CVE → classify by actual impact and root cause, not by product name.
- Source is a benchmark → mark evidence_role=benchmark; only keep if benchmark directly evaluates that taxonomy mechanism.
- Source is a defense paper → keep only if defended threat clearly belongs to the category.

### Specific Mapping Rules (to add as tests)
- Jailbreak papers → LLM11, not LLM01 or LLM09.
- RAG poisoning → LLM04, not LLM08.
- Vector leakage / embedding inversion → LLM08, not LLM04.
- Credential theft → LLM02, with LLM01 secondary only if prompt injection is delivery mechanism.
- Prompt injection causing tool execution → LLM06 primary, LLM01 secondary.
- Unsafe Markdown/HTML rendering of LLM output → LLM05.
- Generic LLM product CVEs → NOT auto LLM03 or LLM05.
- Hallucination papers → LLM09 ONLY when false-information mechanism is central.
- Generic vuln detection or secure code gen papers → non_taxonomy_relevant unless LLM output is unsafe and downstream-consumed.

### Landmark Gap Detection (per category)
Expected coverage per tag — for gap reporting:

**LLM01:** indirect prompt injection, browser-agent prompt injection, coding-agent prompt injection, MCP prompt injection, multimodal/visual prompt injection, vendor prompt-injection reports (OpenAI, Anthropic, Microsoft, Google, NVIDIA)

**LLM02:** training data extraction, memorization, prompt stealing, system prompt extraction, cross-session memory leakage, RAG document leakage, embedding inversion, vector database leakage, membership inference

**LLM03:** malicious HuggingFace models, malicious LoRA/adapters, malicious checkpoints/GGUF, prompt template poisoning, model provenance/signing, safetensors/model artifact security, AI dependency compromise, plugin and extension compromise

**LLM04:** instruction tuning poisoning, fine-tuning poisoning, RLHF/reward model poisoning, synthetic data poisoning, LoRA poisoning, checkpoint poisoning, RAG corpus poisoning, embedding poisoning, model backdoors

**LLM05:** unsafe generated code execution, shell command execution, SQL generation, unsafe Markdown/HTML rendering, browser execution, file writes, template execution, function calling/tool output parsing

**LLM06:** MCP abuse, browser-agent abuse, coding-agent abuse, autonomous tool chaining, recursive agents, permission escalation, computer-use abuse, multi-agent orchestration failures

**LLM07:** system prompt extraction, developer prompt leakage, hidden instruction disclosure, prompt recovery, prompt stealing, agent prompt exfiltration, instruction hierarchy bypass

**LLM08:** embedding inversion, vector database enumeration, cross-tenant vector leakage, similarity search manipulation, ANN attacks, embedding leakage, representation leakage, vector side channels

**LLM09:** fabricated citations, package hallucinations, legal hallucinations, medical hallucinations, scientific hallucinations, fake evidence generation, election misinformation, synthetic news generation, authority impersonation

**LLM10:** denial of wallet, token flooding, context window exhaustion, KV cache exhaustion, GPU exhaustion, API cost amplification, recursive agent loops, tool call amplification

---

## TAI (Traditional AI) Taxonomy Redesign

### ISSUE: TAI01 vs TAI02 boundary is the manipulated ASSET, not the injection method

**TAI01 Data Poisoning** — primary manipulated asset is **data**:
- Include: label poisoning, feature poisoning, clean-label, dirty-label, synthetic data poisoning, instruction-tuning data poisoning, federated client data poisoning, RAG corpus poisoning
- Exclude: model weights, adapters, LoRA, checkpoints, neural trojans, optimization-triggered backdoors UNLESS poisoned data is the primary attack vector

**TAI02 Model Poisoning** — primary manipulated asset is **model parameters/optimization**:
- Include: weight poisoning, gradient poisoning, checkpoint poisoning, neural trojans, backdoored models, LoRA/adapter backdoors, federated model update poisoning, optimizer-triggered backdoors, model replacement
- Rule: if poisoned data causes a backdoor but the paper's main contribution is the poisoned training data → TAI01 with secondary tag `model_backdoor_outcome`

**Deterministic gates needed:**
- `backdoor | LoRA | adapter | checkpoint | weights | neural trojan | optimizer-triggered | model update` → consider TAI02 first
- `label poisoning | dataset poisoning | training data | fine-tuning data | post-training data | synthetic data | RAG corpus poisoning` → consider TAI01 first

---

### ISSUE: TAI04 Adversarial Data must be deprecated

**Problem:** TAI04 "Adversarial Data" is not a distinct threat category. It overlaps entirely with TAI03 (Adversarial Evasion). The distinction of what modality is attacked (image, audio, code, text) is metadata, not a separate category.

**Fix:**
- Remove TAI04 as a primary tag
- Store the manipulated modality as `attack_medium` metadata under TAI03
- Existing TAI04 sources → reclassify to:
  - TAI03 if inference-time adversarial/evasion attack
  - TAI02 if model parameter manipulation
  - defense / non_taxonomy_relevant as appropriate

**TAI03 Adversarial Evasion** (expanded scope after TAI04 removal):
- Keep when primary attack modifies inference-time inputs so the model makes an incorrect prediction while the object remains functionally similar
- Include: adversarial examples, detector evasion, adversarial patches, transfer attacks, black-box/white-box attacks, physical attacks, latent-space attacks, malware evasion, code evasion, audio attacks, image attacks, multimodal attacks
- `attack_medium` field values: image | audio | text | code | video | multimodal | physical | unknown
- Gate: `adversarial example | evasion | perturbation | patch | transfer attack | black-box attack | detector evasion | physical attack` → TAI03

---

### ISSUE: TAI05 / TAI06 / TAI07 (now renumbered) boundary confusion

After TAI04 removal, renumber:
- Old TAI05 Model Extraction → **new TAI04**
- Old TAI06 Model Inversion → **new TAI05**
- Old TAI07 Membership Inference → **new TAI06**
- Old TAI08 Model DoS → **new TAI07** (or keep as TAI08 with gap)
- Old TAI09 → removed (was duplicative with TAI08)
- Old TAI10 AI Supply Chain → becomes **TAI08**
- Add new **TAI11 AI Supply Chain** (expanded scope)

*(Note: numbering TBD — user may keep existing numbers or renumber; track intent, not exact numbers)*

**TAI04 Model Extraction** (primary objective: steal model behavior):
- Include: model stealing, surrogate model generation, query-based extraction, API extraction, decision-boundary reconstruction, parameter approximation
- Exclude: membership inference, model inversion, knowledge extraction from RAG, model fingerprinting, adversarial evasion unless model stealing is the primary objective
- Gate: `extraction | stealing | cloning | surrogate | decision boundary` → TAI04 ONLY IF the model is being stolen (not data or knowledge)

**TAI05 Model Inversion** (primary objective: reconstruct training data/features from model):
- Include: gradient inversion, feature inversion, input reconstruction, data reconstruction, attribute inference, federated reconstruction, split-learning reconstruction, image/face reconstruction
- Exclude: generic privacy papers, membership inference, supply-chain backdoors, TEEs, side channels, model extraction unless data reconstruction is explicit
- Gate: `model inversion | gradient inversion | data reconstruction | feature inversion | input reconstruction | attribute inference` → TAI05

**TAI06 Membership Inference** (primary objective: determine if a sample was in training):
- Include: confidence-based, loss-based, label-only, black-box, white-box, federated, LLM, RAG, diffusion, vision, clinical MIA
- Exclude: model inversion, model extraction, hardware side channels, general privacy papers
- Gate: `membership inference` → TAI06

---

### ISSUE: TAI08 Model DoS must be narrowed to AI-specific inference availability

**Problem:** Currently applied too broadly — catches generic parser crashes, heap overflows, RCEs, ReDoS in ML libraries, segmentation faults, and infrastructure availability bugs that have nothing to do with AI inference.

**TAI08 Model DoS** (narrow definition):
- Primary effect must be AI-specific inference availability degradation or resource exhaustion
- Include: GPU exhaustion, memory exhaustion, batch amplification, inference flooding, scheduler exhaustion, queue exhaustion, KV-cache exhaustion, context amplification, token amplification, model-serving DoS, adversarial compute amplification
- Exclude: generic parser crashes, heap overflows, RCEs, ReDoS in libraries, segfaults, generic infrastructure availability bugs
- Gate (existing DOS_RE is close but too broad — needs tightening to AI inference context)

---

### ISSUE: Add TAI11 AI Supply Chain (expanded and renamed from TAI10)

**Problem:** TAI10 exists but is too narrowly defined / applied too broadly to generic ML CVEs.

**TAI11 AI Supply Chain** (root cause must be AI artifact loading or model ecosystem):
- Include: Hugging Face malware, malicious model repos, unsafe model loading, pickle/model deserialization, ONNX/model format flaws, model registry compromise, dependency confusion for ML packages, model provenance/signing failures, poisoned AI artifacts
- Exclude: every CVE in an ML framework that isn't about model loading, distribution, or trust (e.g. generic auth bypass in MLflow UI, Kubernetes config issues, CI/CD pipeline attacks)
- Gate: root cause must involve AI artifact loading, model distribution, dependency trust, build/deployment chain, or model ecosystem compromise

---

### TAI Landmark Gap Topics

**TAI01 Data Poisoning:** clean-label poisoning, dirty-label poisoning, label-flipping attacks, feature collision attacks, synthetic data poisoning, federated data poisoning, instruction-tuning data poisoning, RAG corpus poisoning

**TAI02 Model Poisoning:** checkpoint poisoning, neural trojans, weight poisoning, gradient poisoning, model replacement attacks, federated model update poisoning, LoRA/adaptor poisoning, optimizer-triggered backdoors

**TAI03 Adversarial Evasion:** adversarial patches, universal adversarial perturbations, transfer attacks, query-efficient attacks, physical-world attacks, object detection evasion, face recognition evasion, malware detector evasion, audio adversarial attacks, code model evasion

**TAI04 Model Extraction:** query synthesis attacks, Jacobian-based extraction, Knockoff Nets, surrogate model generation, API model stealing, decision boundary reconstruction, hard-label extraction, commercial API extraction

**TAI05 Model Inversion:** Deep Leakage from Gradients (DLG), iDLG, gradient inversion, feature inversion, image reconstruction, face reconstruction, input reconstruction, attribute inference, federated reconstruction, split-learning reconstruction

**TAI06 Membership Inference:** confidence-based MIA, loss-based MIA, label-only MIA, black-box MIA, white-box MIA, federated MIA, diffusion MIA, LLM MIA, RAG MIA

**TAI08 Model DoS:** GPU exhaustion, inference resource exhaustion, batch amplification, prompt amplification, token flooding, context window exhaustion, KV-cache exhaustion, scheduler exhaustion, model-serving queue exhaustion, adversarial compute amplification

**TAI11 AI Supply Chain:** malicious Hugging Face models, malicious LoRA/adapters, malicious GGUF/checkpoints, safetensors security, model provenance, model signing, model SBOM, dependency confusion, model registry compromise, MLflow/Kubeflow/Vertex/SageMaker registry risks, Sigstore/in-toto/SLSA for ML artifacts

---

### TAI Known Corrections to Test

| Source type | Wrong current assignment | Correct |
|---|---|---|
| Training/fine-tuning data manipulation papers | TAI02 | TAI01 |
| LoRA, adapter, checkpoint, neural trojan, optimizer-triggered backdoor | TAI01 | TAI02 |
| Adversarial Data sources (inference-time evasion) | TAI04 | TAI03 + attack_medium |
| Membership inference papers | TAI04 or TAI05 | TAI06 |
| Model extraction papers focused on RAG knowledge, not model behavior | TAI04 | unclear/LLM |
| Model inversion papers tagged as generic privacy/TEE/side-channel | TAI05 | unclear |
| Generic AI framework CVEs without inference resource exhaustion | TAI08/TAI09 | unclear |
| Generic ML framework CVEs without model loading/distribution root cause | TAI10/TAI11 | unclear |

---

## Agentic (ASI) Taxonomy Refinement

### ISSUE: Cross-cutting diagnosis — ASI is a classification precision problem, not a taxonomy design problem

**Key finding:** Unlike LLM (semantic ambiguity between categories) and Traditional AI (boundary refinement needed), the Agentic taxonomy is *conceptually sound*. The categories are the right ones. The problem is entirely in how sources get assigned to them.

**Three specific failure modes:**

1. **Keyword-driven assignment:** Sources are classified because they mention agents, MCP, coding assistants, AI frameworks, or AI platforms — not because the primary attack mechanism matches the category. A CVE in Open WebUI is not automatically an agentic threat. A paper mentioning MCP is not automatically ASI02.

2. **Categories are not enforced as mutually exclusive in practice:** Prompt injection papers appear under ASI01 (Goal Hijack), ASI02 (Tool Misuse), and ASI06 (Memory Poisoning) simultaneously. MCP-related sources appear under ASI02, ASI03, and ASI04. Generic software CVEs are distributed across multiple agentic categories simply because they affect AI systems. The primary mechanism must determine the single primary tag.

3. **Generic software vulnerabilities incorrectly included:** RCE, auth flaws, path traversal, SSRF, XSS, deserialization, and other conventional software vulnerabilities should only appear in ASI if the *primary security failure is unique to autonomous agents* — not simply because the vulnerable product has "AI" or "agent" in its name.

4. **Non-threat evidence dominates some categories:** Benchmarks, surveys, governance papers, architectural proposals, and defensive frameworks are mixed with actual threat evidence. These should be secondary or excluded — they describe research, not attack techniques or incidents.

**The correct classification test for all ASI tags:**
> What is the primary security failure? Is it something that could only (or primarily) happen because of autonomous agent behavior — the agent's own goals, tool use, memory, identity, execution, or supply chain? If the same vulnerability would exist in a non-agent system and the agent is just the deployment context → it does not belong in ASI.

**Component vs. mechanism — the taxonomy should enforce this distinction:**

| Tag | The component | The mechanism |
|---|---|---|
| ASI01 Goal Hijack | Agent objectives / planning | Manipulation of what the agent is trying to achieve |
| ASI02 Tool Misuse | Tool invocation layer | Unsafe invocation, permissions, routing, chaining, execution of tools |
| ASI03 Identity & Privilege Abuse | Agent identity / credentials | Abuse of identities, delegation, authorization boundaries |
| ASI04 Agent Supply Chain | Agent ecosystem (skills, plugins, MCP servers, packages) | Compromise through malicious components |
| ASI05 Unexpected Code Execution | Agent execution environment | Agent-caused unintended code/command execution |
| ASI06 Memory & Context Poisoning | Agent memory / contextual state | Persistent manipulation of stored or retrieved context |

---

### ISSUE: ASI02 Tool Misuse is over-broad — classifies by technology, not mechanism

**Problem:** Sources are being assigned ASI02 because they *mention* MCP, agents, coding assistants, or tools — not because the primary attack is actually tool misuse. The tag over-captures anything agent-related.

**ASI02 Tool Misuse — narrow definition (KEEP):**
- Unsafe or unauthorized tool invocation
- Tool permission abuse
- Tool selection or routing attacks
- Tool description poisoning (malicious tool descriptions that alter agent behavior)
- Tool output manipulation
- Function calling abuse
- MCP tool abuse (the MCP tool interface is the exploit surface)
- Cross-tool attacks and exfiltration (tool chaining causes data leak)
- Unsafe tool chaining and execution

**Move OUT of ASI02 — these belong elsewhere:**

| Source type | Correct tag |
|---|---|
| Generic prompt injection (even in agent context) | ASI01 Goal Hijack or LLM01 |
| Goal hijacking that doesn't go through the tool layer | ASI01 |
| Memory or context poisoning | ASI06 |
| Agent supply chain attacks (malicious plugins, skills, packages, MCP servers) | ASI04 |
| Identity and privilege abuse | ASI03 |
| Sensitive information disclosure | LLM02 |
| Generic software CVEs (RCE, SSRF, XSS, SQLi, path traversal, auth flaws) in agent products | unclear_or_adjacent |
| General benchmarks, evaluations, or surveys not focused on tool misuse | non_taxonomy_relevant |

**Root cause of the problem:** The classifier uses technology keywords (MCP, agent, coding assistant, tool) as a proxy for category assignment. The check should be: *is the tool invocation / permission / routing / output the primary attack surface?* If no, it doesn't belong in ASI02.

---

### ISSUE: ASI05 Unexpected Code Execution is over-broad — classifies by technology, not agent causation

**Problem:** Sources are assigned ASI05 because they involve code execution or AI software — not because the unexpected execution is caused by autonomous agent behavior or agent-specific execution logic.

**ASI05 Unexpected Code Execution — narrow definition (KEEP):**
- Prompt injection leading to command or code execution
- Agent-induced shell or command execution
- Unauthorized execution through tools or MCP
- Sandbox escape *from* agent execution environments
- Consent or approval bypass leading to execution
- Auto-execution vulnerabilities in coding agents
- Code execution through agent workflows, plugins, or execution engines
- Real-world incidents where agents execute attacker-controlled code

**Move OUT of ASI05 — these belong elsewhere:**

| Source type | Correct tag |
|---|---|
| Generic RCE, command injection, path traversal, deserialization, XSS, SSRF, auth, file upload vulns not specific to agent execution | unclear_or_adjacent |
| Generic vulnerabilities in AI frameworks where the issue is simply software exploitation | unclear_or_adjacent |
| Supply chain attacks involving malicious repos, packages, plugins, skills | ASI04 |
| AI-assisted pentesting platforms, autonomous offensive agents, security tooling | AE (ai_enabled_threats) or unclear |
| Benchmarks, evaluations, surveys, capability papers | non_taxonomy_relevant |
| General infrastructure / sandbox implementation vulnerabilities where the agent is NOT responsible for the execution | unclear_or_adjacent |

**Root cause of the problem:** The classifier (and the existing CODE_EXEC_RE gate) only checks whether code execution terminology is present in the text. It does not check whether the execution was *caused by autonomous agent behavior or agent-specific logic*. A generic RCE CVE in a coding assistant platform is not ASI05; a coding agent that executes attacker-injected shell commands via its own tool-calling loop is.

**Key test:** Was the unexpected execution triggered by the agent's own autonomous behavior, reasoning, or tool-calling — or by a conventional software vulnerability in the underlying platform? If the latter → not ASI05.

---

### ISSUE: ASI06 Memory & Context Poisoning is over-broad — classifies by mention, not persistence mechanism

**Problem:** Sources are assigned ASI06 because they mention prompt injection, agents, MCP, or context — not because the attack specifically creates *persistent or stored influence* over an agent by poisoning its memory or contextual state.

**ASI06 Memory & Context Poisoning — narrow definition (KEEP):**
- Memory poisoning attacks
- Context poisoning attacks
- Persistent prompt injection (injection that survives across turns or sessions)
- Cross-session prompt injection
- Retrieval or context contamination
- Poisoned memories, experience stores, or knowledge stores
- Memory persistence attacks
- Stored prompt injection
- Long-term context manipulation
- Agent behaviour drift caused by poisoned memory or context

**Key defining characteristic:** The attack must create a *persistent or stored* influence — it changes what the agent remembers or retrieves in future turns/sessions, not just in the current turn.

**Move OUT of ASI06 — these belong elsewhere:**

| Source type | Correct tag |
|---|---|
| Generic prompt injection (single-turn, no persistence) | ASI01 or LLM01 |
| Tool misuse or tool integrity attacks | ASI02 |
| Agent supply chain attacks (skills, plugins, packages, MCP ecosystem compromise) | ASI04 |
| Unexpected code execution | ASI05 |
| Identity and privilege abuse | ASI03 |
| Information disclosure or data leakage | LLM02 |
| Governance, architecture, framework, or protocol papers | unclear_or_adjacent |
| Benchmarks, evaluations, surveys, red-teaming methodologies | non_taxonomy_relevant |
| General agent security papers without a specific memory/context poisoning attack | unclear_or_adjacent |

**Root cause of the problem:** The classifier treats any source mentioning "agent + prompt + context" as ASI06. The distinguishing question is: *Does the attack persist beyond the current interaction by corrupting stored memory, long-term context, or retrieved state?* Transient injection without persistence → ASI01/LLM01, not ASI06.

---

### ISSUE: ASI01 Agent Goal Hijack is over-broad — classifies by agent/injection mention, not objective-change mechanism

**Problem:** Sources are assigned ASI01 because they involve prompt injection, agents, or autonomous behaviour — not because the attacker's primary objective is to *change what the agent is trying to achieve*.

**ASI01 Agent Goal Hijack — narrow definition (KEEP):**
- Goal hijacking attacks
- Instruction hijacking and instruction override
- Planner manipulation
- Goal redirection
- Behavioural or objective manipulation
- Agent jailbreaking that changes agent objectives
- Strategic deception causing agents to pursue attacker goals
- Prompt injection *only* when its primary outcome is goal or planning manipulation (not tool misuse, not data exfil, not code execution)

**Key defining characteristic:** The attacker's primary objective is to *change what the agent is trying to achieve* — redirecting its goals, plans, or objectives — not merely influencing its inputs or exploiting another component of the agent system.

**Move OUT of ASI01 — these belong elsewhere:**

| Source type | Correct tag |
|---|---|
| Generic prompt injection (where goal change is not the primary outcome) | LLM01 |
| Tool misuse or tool integrity attacks | ASI02 |
| Memory or context poisoning | ASI06 |
| Agent supply chain attacks | ASI04 |
| Unexpected code execution | ASI05 |
| Identity and privilege abuse | ASI03 |
| Governance, architecture, framework, or protocol papers | unclear_or_adjacent |
| Benchmarks, evaluations, surveys, red-teaming methodologies | non_taxonomy_relevant |
| General agent security papers without a specific goal hijacking attack | unclear_or_adjacent |

**Root cause of the problem:** Prompt injection and agent attacks land in ASI01 by default because it's the broadest agentic tag. The distinguishing test: *Is the attacker's primary goal to redirect what the agent is trying to accomplish?* If the attack causes tool misuse, code execution, or data theft as the primary outcome (even via injection) → those other ASI/LLM tags are primary, not ASI01.

**Disambiguation with LLM01:** Prompt injection whose *consequence* is goal deviation belongs in ASI01 (agent context, goal is changed). Prompt injection whose consequence is data exfil, tool abuse, or code execution → LLM02/ASI02/ASI05 primary with LLM01 secondary.

---

## AI-Enabled (AE) Taxonomy Refinement

### ISSUE: Cross-cutting diagnosis — AE has the weakest classification quality; categories are kill-chain stages, not mutually exclusive mechanisms

**Key finding:** Unlike ASI (good taxonomy, bad classification) and LLM (semantic overlap), the AI-Enabled taxonomy has a *design-level* problem: the categories represent adjacent stages of the cyber kill chain rather than distinct AI-enabled capabilities. This means a single source can legitimately fit multiple categories simultaneously — the overlap is structural, not just a classifier error.

**Three specific failure modes:**

1. **Kill-chain stages, not mutually exclusive mechanisms:** A single AI-enabled campaign naturally touches reconnaissance → social engineering → malware development → evasion → orchestration in sequence. Without identifying the *primary* AI-enabled capability in the source, sources get duplicated across all stages they mention.

2. **Structural overlaps between specific categories:**
   - AE02 Social Engineering ↔ AE07 Identity Abuse ↔ AE10 Deepfake & Synthetic Media ↔ AE09 Disinformation: all involve deception; what distinguishes them is the primary capability (persuasion vs. identity impersonation vs. synthetic content vs. narrative manipulation)
   - AE05 Malware Development ↔ AE08 Attack Orchestration ↔ AE06 Evasion & Obfuscation: all can co-occur in one campaign
   - AE03 Vulnerability Research ↔ AE08 Attack Orchestration: when discovered vulnerabilities are immediately operationalized, the boundary dissolves
   - AE01 Reconnaissance ↔ AE02 Social Engineering: recon is frequently a precursor to personalized phishing; sources covering both get duplicated

3. **Broad reports assigned to multiple categories:** Threat intelligence summaries, AI cybercrime surveys, and attacker adoption reports describe many AI-enabled capabilities at once. Classifying them to every applicable category creates artificial inflation. These should be either assigned to their single *dominant* capability or treated as cross-cutting evidence.

**Required fix — two complementary changes:**
1. **Sharpen category boundaries** so each represents a distinct AI-enabled capability, not a kill-chain phase. The distinguishing question per source should be: *What is the single dominant way AI is being used in this source?*
2. **Classification rule:** Each source gets one primary AE tag (the dominant AI capability). Multi-capability landscape reports get the tag of the most operationally significant AI use described, or are held in unclear_or_adjacent as cross-cutting evidence.

**Proposed boundary sharpening per category (direction, not final spec):**

| Tag | Should represent | Key distinguisher from overlapping tags |
|---|---|---|
| AE01 Reconnaissance | AI gathering intelligence about targets (OSINT, scanning, profiling) | The AI capability is *collection*, not yet action |
| AE02 Social Engineering | AI crafting persuasive communications targeting human psychology | The AI capability is *persuasion at scale*, not identity fraud |
| AE03 Vulnerability Research | AI autonomously discovering or analysing vulnerabilities | The AI capability is *discovery*, not yet exploitation |
| AE04 Exploit Development | AI generating or refining working exploits | The AI capability is *weaponisation*, not discovery |
| AE05 Malware Development | AI writing, mutating, or packaging malicious software | The AI capability is *malware authoring*, not delivery or evasion |
| AE06 Evasion & Obfuscation | AI making malicious content or behaviour harder to detect | The AI capability is *detection avoidance*, not content creation |
| AE07 Identity Abuse | AI impersonating specific individuals (voice, face, documents) | The AI capability is *identity fabrication*, not generic persuasion |
| AE08 Attack Orchestration | AI autonomously coordinating multi-stage attacks | The AI capability is *autonomous coordination*, not individual stages |
| AE09 Disinformation | AI generating or amplifying false narratives at scale | The AI capability is *narrative manipulation*, not individual deception |
| AE10 Deepfake & Synthetic Media | AI generating synthetic audio, video, images for deception | The AI capability is *synthetic media production* — use this only when the medium itself (not the message) is the primary weapon |

**Note:** AE10 and AE07 are the most redundant pair. A deepfake of a CEO used for wire fraud is primarily AE07 (identity impersonation) with AE10 as the technique. A mass synthetic media disinformation campaign is primarily AE09. AE10 as a primary tag should be reserved for sources where the *generation or detection of synthetic media itself* is the central finding.

**Classification discipline for broad reports:**
- Threat intelligence reports covering "AI-enabled threats broadly" → assign to the single most operationally significant capability described, flag as cross-cutting in secondary_tags
- Attacker adoption signal reports → AE tag for the dominant capability adopted
- Do not assign 3–4 AE tags to a single source; that signals the category boundaries are being used as a checklist rather than a classification

---

## Dashboard Insight Quality

### ISSUE: Insights are descriptive summaries rather than analytical intelligence

**Overall assessment:** Foundation is strong — evidence traceability, taxonomy structure, and source quality are already high standard. The gap is in the *analytical layer* on top of that evidence.

**Failure mode 1 — Describes what, not why it matters**
Current cards summarize sources or evidence clusters but stop short of explaining strategic significance. Every insight must answer three questions, not one:
- *What happened?*
- *Why does this matter now?*
- *What does this indicate about the evolving threat landscape?*

**Failure mode 2 — "So What" reads as security guidance / best practices**
The So What section should explain the broader security implication or trend — how attacker behaviour, defender assumptions, or the threat landscape is *changing*. It should not default to mitigation recommendations. The reader is an analyst who needs to understand the shift, not a practitioner who needs a remediation checklist.

**Failure mode 3 — Single-source summaries instead of cross-source synthesis**
The strongest insights combine multiple independent sources into a single evidence-backed conclusion about attacker behaviour, emerging techniques, or ecosystem shifts. Currently the dashboard summarises individual incidents rather than identifying patterns that emerge across the corpus.

**Failure mode 4 — No representation of confidence or evidence density**
Readers cannot distinguish between an isolated incident, an emerging pattern, and an established trend. Evidence density, independent confirmations, and temporal patterns are often more valuable than the individual events themselves. Insights should communicate how representative the finding is.

**Failure mode 5 — No temporal perspective**
This is a *horizon scanning* platform. Every insight should situate a technique on a temporal axis:
- Newly emerging (first observed)
- Becoming more common (early adoption)
- Accelerating (rapid uptake)
- Sustained long-term trend (established)

**Failure mode 6 — Defender perspective instead of intelligence perspective**
Analysis should explain what *attackers* are changing in their tradecraft, why they are adopting a technique, and what this suggests about future attack evolution — not what defenders should do about it.

**Failure mode 7 — Evidence section is a bibliography, not a rationale**
Each supporting source should show *why it was included*. The role of each piece of evidence should be explicit:
- First observed incident
- Independent confirmation
- Large-scale telemetry
- Technical analysis / PoC
- Academic validation
- Operational exploitation in the wild

**Summary of required shift:**

| Current | Required |
|---|---|
| What happened | What it means strategically |
| Single-source summary | Cross-source pattern synthesis |
| Security guidance in So What | Threat landscape implication in So What |
| Undifferentiated evidence list | Evidence with explicit role/rationale per source |
| No confidence signal | Explicit: isolated / emerging / established |
| No temporal framing | Trend direction: first-seen / accelerating / sustained |
| Defender framing | Attacker tradecraft and evolution framing |

---

## Dynamic Search / Recall Improvements

### ISSUE: Search prioritises new publications; should prioritise landmark security events

**Current state:** ~77% arXiv+NVD. Searches target recency and topic keywords, not operational significance. Vendor research, incident reports, real-world exploitation, and framework CVEs are severely underrepresented.

**Required shift:** From "find new AI security content" → "find landmark AI security events."

**Priority target classes for search (in rough priority order):**
1. New AI/LLM CVEs and actively exploited vulnerabilities
2. Real-world incident reports involving AI systems
3. New offensive AI tooling released by researchers
4. AI lab security disclosures (OpenAI, Anthropic, Google DeepMind, Microsoft, Meta)
5. Major framework vulnerabilities (LangChain, MCP, CrewAI, AutoGen, Flowise, Open WebUI, vLLM, Ollama, LiteLLM, Langflow, etc.)
6. Threat intelligence reports documenting attacker adoption of AI
7. Hugging Face ecosystem abuse and model repository compromise
8. Major AI security papers from top venues (USENIX Security, IEEE S&P, CCS, NDSS, Black Hat, DEF CON AI Village; arXiv only if highly cited)
9. Major benchmark releases (OWASP GenAI, GARAK, Promptfoo, agent security benchmarks)
10. New attack techniques across all four taxonomy domains

**Search ranking signal words — heavily favour content containing:**
`first observed` · `actively exploited` · `in the wild` · `zero-day` · `campaign` · `novel attack` · `researchers demonstrate` · `remote code execution` · `prompt injection` · `jailbreak` · `backdoor` · `poisoning` · `model extraction` · `model inversion` · `supply chain` · `MCP` · `agent` · `RAG` · `memory poisoning` · `tool misuse` · `autonomous` · `exploited within X hours` · `CVE`

---

### ISSUE: Corpus is missing entire landmark classes of content

The following classes should *always* be captured when they occur — their absence represents a recall failure, not a classifier problem:

**Traditional AI:**
- Landmark adversarial ML papers
- Federated learning poisoning work
- Major model extraction papers
- Major model inversion / privacy attacks
- Major ML supply-chain attacks
- Foundation model backdoors

**LLM Security:**
- Every major prompt injection paper
- Every major jailbreak technique
- Major system prompt leakage work
- RAG poisoning papers
- Agent memory poisoning
- Chat template attacks
- Tool abuse
- Major LLM framework CVEs

**Agentic AI:**
- MCP security research
- LangGraph / LangChain agent compromises
- CrewAI / AutoGen attacks
- Tool invocation exploits
- Memory poisoning
- Multi-agent attack chains
- Agent privilege escalation
- Agent sandbox escapes

**AI-Enabled Threats:**
- AI-assisted phishing campaigns
- AI-generated malware campaigns
- AI-assisted vulnerability discovery
- Deepfake fraud
- Nation-state AI operations
- AI-assisted influence campaigns
- Criminal AI-as-a-Service
- AI-assisted ransomware operations

---

### ISSUE: Classification must recognise primary contribution, not every topic mentioned

The classifier should determine what the paper *introduces or documents*, not every topic it mentions. Known mis-assignment patterns from this:

| Source type | Current wrong path | Correct primary assignment |
|---|---|---|
| Paper proposing a new jailbreak | LLM09 Misinformation (mentions false outputs) | LLM11 Jailbreak |
| RAG poisoning paper | LLM08 (mentions retrieval/vectors) | LLM04 (unless novelty is retrieval abuse) |
| Tool abuse paper | LLM06 Excessive Agency | LLM06 only if autonomous tool execution is the *contribution*; else ASI02 |
| AI phishing campaign delivering malware | AE05 Malware | AE02 Social Engineering (phishing is the primary AI capability; malware is payload) |
| Framework CVE compromising deployment infrastructure | LLM05 or LLM01 | LLM03 Supply Chain |

**Rule:** Classify by what the source *introduces* as its primary finding. Do not tag every mechanism it mentions.

---

### ISSUE: Missing capability — importance ranking

The biggest missing capability is **importance ranking** — there is currently no signal to distinguish a landmark finding from a routine paper on a similar topic.

*(awaiting further user detail on what importance ranking should look like)*

---

---

## ISSUE: Intermediate Mechanism-First Classification Layer

**Problem:** The classifier maps directly from source text → taxonomy tag using keyword/semantic matching. No intermediate reasoning step.

**Required fix:** Before taxonomy assignment, extract and store a structured intermediate object for every source:

| Field | Values |
|---|---|
| `primary_security_property` | confidentiality \| integrity \| availability \| instruction_integrity \| output_handling \| agency_control \| supply_chain_integrity \| model_alignment \| factual_reliability \| evaluation \| unknown |
| `primary_exploit_mechanism` | prompt_injection \| jailbreak_safety_bypass \| sensitive_info_disclosure \| system_prompt_leakage \| data_poisoning \| model_poisoning \| rag_knowledge_poisoning \| vector_embedding_attack \| supply_chain_compromise \| unsafe_output_execution \| unsafe_output_rendering \| excessive_agency \| resource_exhaustion \| misinformation_generation \| hallucination_generation \| generic_software_vulnerability \| benchmark_or_evaluation \| defense_only \| unknown |
| `evidence_role` | attack \| defense \| benchmark \| incident \| cve \| vendor_report \| academic_research \| standards_guidance \| adjacent \| wrong_category |
| `affected_layer` | model \| prompt \| application \| agent \| tool \| retrieval \| vector_database \| dataset \| fine_tuning \| inference_infrastructure \| plugin_extension \| package_dependency \| deployment_artifact \| user_interface \| unknown |
| `final_taxonomy` | LLM01–LLM11 or non_taxonomy_relevant |
| `secondary_tags` | string[] |
| `keep_in_original_category` | bool |
| `rationale_one_sentence` | string |

**Goal:** "Do not classify sources directly from keywords like prompt, RAG, privacy, adversarial, poisoning, hallucination, CVE, jailbreak, or vector. First determine the source's primary security objective and exploit mechanism, then map it to the taxonomy."

---

## ISSUE: Deterministic Sanity Checks Required (Gates)

Keyword-based pre-gates to prevent the LLM from mis-assigning:

1. **Jailbreak gate:** If title or abstract contains `jailbreak`, `refusal`, `harmful compliance`, `safety bypass`, `adversarial suffix`, `roleplay`, `DAN`, `alignment bypass` → do NOT assign LLM01 unless instruction injection through untrusted external context is explicit.

2. **RAG/vector gate:** If title or abstract contains `RAG`, `retrieval`, `vector`, `embedding` → classify the ACTUAL mechanism: poisoning (→ LLM04), leakage (→ LLM08), similarity manipulation (→ LLM08), hallucination (→ LLM09), or evaluation (→ non_taxonomy_relevant). Do not auto-assign to LLM08.

3. **CVE gate:** If source is a CVE → classify by ACTUAL IMPACT and root cause, not by product name.

4. **Benchmark gate:** If source is a benchmark → mark `evidence_role=benchmark`; only keep in taxonomy if the benchmark directly evaluates that taxonomy mechanism. Defense benchmarks evaluating jailbreaks belong in LLM11, not LLM01.

5. **Defense paper gate:** If source is a defense paper → keep in category only if the defended threat clearly belongs to that category.

---

## ISSUE: Specific Mapping Rules (Known Mis-Assignments to Fix)

These are confirmed wrong assignments in the current corpus that need to be corrected by the new classifier:

| Source type | Current wrong assignment | Correct assignment |
|---|---|---|
| Jailbreak papers | LLM01 or LLM09 | LLM11 |
| RAG poisoning | LLM08 | LLM04 |
| Vector leakage / embedding inversion | LLM04 | LLM08 |
| Credential theft (standalone) | LLM02 without secondary | LLM02 (LLM01 secondary ONLY if injection is delivery mechanism) |
| Prompt injection causing tool execution | LLM01 | LLM06 primary, LLM01 secondary |
| Unsafe Markdown/HTML rendering of LLM output | varies | LLM05 |
| Generic LLM product CVEs | LLM03 or LLM05 | unclear (unless AI-specific surface exploited) |
| Hallucination papers where false-info is NOT central | LLM09 | non_taxonomy_relevant or LLM01 depending on mechanism |
| Generic vuln detection / secure code gen papers | LLM01 or LLM09 | non_taxonomy_relevant (unless LLM output is unsafely consumed downstream) |

---

## ISSUE: Landmark Gap Detection Required

For each LLM tag, a `missing_landmark_topics` array should be produced based on expected coverage. Expected topics (from spec):

**LLM01:** indirect prompt injection in web/email/RAG/tool outputs, browser-agent prompt injection, coding-agent prompt injection, MCP prompt injection, multimodal/visual prompt injection, vendor prompt-injection reports (OpenAI, Anthropic, Microsoft, Google, NVIDIA)

**LLM02:** training data extraction, memorization, prompt stealing, system prompt extraction, cross-session memory leakage, RAG document leakage, embedding inversion, vector database leakage, membership inference

**LLM03:** malicious Hugging Face models, malicious LoRA/adapters, malicious checkpoints/GGUF, prompt template poisoning, model provenance/signing, safetensors/model artifact security, AI dependency compromise, plugin and extension compromise

**LLM04:** instruction tuning poisoning, fine-tuning poisoning, RLHF/reward model poisoning, synthetic data poisoning, LoRA poisoning, checkpoint poisoning, RAG corpus poisoning, embedding poisoning, model backdoors

**LLM05:** unsafe generated code execution, shell command execution, SQL generation, unsafe Markdown/HTML rendering, browser execution, file writes, template execution, function calling/tool output parsing

**LLM06:** MCP abuse, browser-agent abuse, coding-agent abuse, autonomous tool chaining, recursive agents, permission escalation, computer-use abuse, multi-agent orchestration failures

**LLM07:** system prompt extraction, developer prompt leakage, hidden instruction disclosure, prompt recovery, prompt stealing, agent prompt exfiltration, instruction hierarchy bypass

**LLM08:** embedding inversion, vector database enumeration, cross-tenant vector leakage, similarity search manipulation, ANN attacks, embedding leakage, representation leakage, vector side channels

**LLM09:** fabricated citations, package hallucinations, legal hallucinations, medical hallucinations, scientific hallucinations, fake evidence generation, election misinformation, synthetic news generation, authority impersonation

**LLM10:** denial of wallet, token flooding, context window exhaustion, KV cache exhaustion, GPU exhaustion, API cost amplification, recursive agent loops, tool call amplification

**LLM11:** (new — no prior baseline; initial expected topics:) adversarial suffix attacks, roleplay/persona jailbreaks, many-shot jailbreaks, multi-turn safety erosion, obfuscation-based refusal bypass, multimodal jailbreaks, audio jailbreaks

---

## ISSUE: Required Outputs

### Per-source debug report
For every source in the corpus, show:
- `original_category`
- `final_taxonomy`
- `primary_security_property`
- `primary_exploit_mechanism`
- `evidence_role`
- `keep_in_original_category`
- `secondary_tags`
- `rationale_one_sentence`

### Category-level summary metrics per LLM tag
- `kept_count`
- `moved_count`
- `defense_count`
- `benchmark_count`
- `wrong_category_count`
- `missing_landmark_topics`

---

## Decision — Frontier model releases / capability announcements (landscape stream)

**Question raised (2026-07-03):** where do sources about a new frontier model (e.g. "Mythos", "Fable 5.0") land? They are threat-landscape relevant but have no offensive mechanism.

**Decision: taxonomy stays offensive-only + MECE. Model releases/capability news are NOT shoehorned into a TAI/LLM/ASI/AE tag.** They split three ways by what the *source* is actually about:
1. Pure release/capability announcement → `unclear_or_adjacent`, `mechanism_evidence_role: context` (or `benchmark`). Surfaced on the dashboard as a **capability-landscape stream**, not an attack tag.
2. Capability-as-weapon (model autonomously writes exploits / malware / offensive tooling) → **AE** (ai_enabled_threats) — model-as-tool has a real mechanism + external victim.
3. Named model as *victim* of an attack paper (jailbreak/injection against it) → tagged by the attack mechanism as normal; the model name is irrelevant.

**Follow-up (Phase 5):** "what frontier models exist + what can they now do" becomes an explicit **landmark-topic feed** at ingest via `landmarkGaps.js` / `buildSearchDirectives()`, feeding the dashboard landscape stream. Rejected alternative: a non-offensive `capability_landscape` overlay tag (would blur MECE offensive domains).

---

## Pending — Waiting for More User Feedback

*(add items here as user continues providing feedback)*
