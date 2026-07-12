# Chatbot Test — 25 Questions

_Tested 2026-07-12. Dev server: `npx vercel dev`. Model: claude-sonnet-4-6 (grounded) / claude-haiku-4-5 (query planner)._

---

## Issues Summary

| Q | Issue |
|---|-------|
| **Q17** | **QA BLOCKED** — verifier flagged CVEs not found in any source; answer suppressed entirely |
| **Q20** | Fell back to **general mode** (no corpus grounding) — corpus had no CISO-strategy sources |
| **Q22** | **Incorrectly classified as out-of-scope** — deflected the MCP analogy question; expected answer is "all three, depending on context" |

Additional patterns across all 25:
- **Verifier QA issues** flagged on 19/25 questions. Most are minor (rounding, attribution phrasing), but the QA system logs them as `qa_issues` in metadata. None blocked except Q17.
- **Single-source numbers** appear repeatedly across categories: the "90 organisations" (CrowdStrike), "8,600 successful IPI attacks" (Center for AI Safety), and "$175k loss" figures recur in Q7, Q11, Q13, Q14, Q19, Q21, Q24 — the verifier flags these each time but the answer correctly hedges them. Repetition is appropriate given the corpus, but could feel noisy in a UI that shows QA notes.
- **Q12 (Amazon Q incident)** — correctly identified that the named incident isn't in the corpus; pivoted to the general coding-agent trust model pattern. Good epistemic behaviour.
- **Q8 (multimodal guardrail bypass)** — correctly flagged the multimodal angle isn't evidenced in corpus; answered the related text-injection threat instead. Good.

---

## Q1 — Traditional AI / ML

**Question:** What are the most significant developments in adversarial machine learning over the past 12 months?

Assessment: The clearest signal over the past 12 months is that adversarial attacks have matured from theoretical proofs-of-concept into operationally credible threats against deployed systems — particularly AI-based security tools like malware detectors and vulnerability scanners. Defensive research is responding, but certified defenses are still largely bench-tested, not production-hardened. The quantum-computing defense angle is genuinely early-stage and should not be weighted alongside the operational findings.

1. AI-based malware detection is dangerously brittle, and attackers know exactly how to exploit it.

- A dataset of nearly 78,000 adversarial malware samples shows evasion attacks defeating machine-learning classifiers 98.35% of the time; separately, injecting just 0.5% mislabeled samples into training data measurably degrades detection — both figures are striking but come from a single study. [src-8]
- A separate attack specifically targets the "drift monitoring" safety net — the mechanism that alerts defenders when a malware classifier's environment has shifted. The attack evades the detector while simultaneously staying invisible to that monitor, removing a key layer of defense. [src-5]
- A framework for automatically generating adversarial code that fools AI-powered vulnerability scanners improved attack success by over 26% against prior state-of-the-art. [src-12]

2. Transferable attacks against closed, commercial AI systems are a credible threat, not just a lab result.

- FRA-Attack generates adversarial images crafted against one AI model, then successfully fools a different, closed-source model — achieving state-of-the-art success across 15 flagship multimodal AI products from 7 vendors. [src-9]
- Adversarial perturbations now survive lossy audio compression — a step that defenders previously assumed would destroy attack payloads. 85.5% success rate against deployed audio AI systems. [src-10]
- Discrete image tokenizers are also vulnerable; this is the first study to show attacks at that layer. [src-2]

3. Prompt structure in large language models creates a previously uncharted attack surface.

- Different parts of a prompt — task description, worked examples, constraints — have meaningfully different vulnerability profiles. Attackers can target the weakest component independently. [src-1]

4. Defenders are advancing certified robustness, but practical deployment remains unproven.

- Two independent efforts propose defenses with mathematical guarantees of robustness — one applied to malware detection [src-4], another to neural network classifiers using ensemble methods. [src-6]
- GRAPE achieves competitive robustness with 21% fewer parameters than comparable defenses. [src-7]

5. Quantum-computing defenses are being explored but are not operationally relevant yet. [src-3]

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** The 98.35% evasion and 0.5% poisoning figures come from a single dataset paper and have not been independently replicated.
**QA issues (minor):** Rounding ("nearly 78,000" vs 77,943); transfer success claim phrasing; parameter efficiency wording.

---

## Q2 — Traditional AI / ML

**Question:** Have there been any notable model extraction attacks against production AI systems recently?

Assessment: There are no confirmed incidents of model extraction attacks against named production AI systems in the last 15 months. What exists is a concentrated burst of research demonstrating that the theoretical threat is more operationally viable than previously assumed, particularly through coordination and automation. The production-level risk is real and rising, but the evidence base is research-stage, not incident-stage.

1. Automated attack tools now make model extraction accessible to non-experts.
- AttackPilot, an autonomous AI agent, successfully completed extraction attacks against 20 target ML services with 100% task completion using no human intervention. [src-5]

2. The main defense strategy most providers rely on is broken.
- Most commercial defenses assume all suspicious queries come from one identifiable user (the "Single Client Assumption"). Coordinated groups querying from different accounts defeat this completely, invalidating systems like PRADA. [src-2]

3. New detection approaches exist but remain research-stage.
- MMD-based detection achieves near-perfect detection with very low false positives. [src-1]
- A "honeypot" technique wastes attacker query budgets without hurting normal users. [src-3]

4. Model extraction is being combined with privacy attacks.
- LoMime uses model extraction as a stepping stone to infer whether specific individuals' data was used to train a model (membership inference). [src-8]

5. Extraction attacks against hardware-protected systems are also demonstrated.
- Even models inside a Trusted Execution Environment (TEE) can have their weights recovered if the system reuses cryptographic keys. [src-6]

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** Absence of confirmed production incidents may reflect limited public disclosure rather than absence of real attacks.
**QA issues:** Several specific claims attributed to sources that don't explicitly confirm them (AttackPilot 100% success rate; "Single Client Assumption" framing).

---

## Q3 — Traditional AI / ML

**Question:** How are attackers bypassing AI-powered fraud detection and computer vision systems today?

Assessment: The sources cover malware evasion and audio/image adversarial attacks but contain no direct evidence of attackers bypassing AI-powered fraud detection or computer vision systems in operational deployments. The research confirms that evasion of AI classifiers is highly effective in controlled settings, but the leap to deployed fraud pipelines is not evidenced. The agent correctly flagged this and answered within what the corpus supports.

1. ML-based classifiers are dangerously easy to fool in research conditions.
- 98.35% evasion rate in controlled testing; 0.5% data poisoning threshold; DroidBreaker-style feature manipulation. [src-2, src-7]

2. Attackers are learning to game the features detectors rely on.
- Injecting harmless-looking API calls drops detection recall from 87.5% to 30%. [src-10]
- Drift-signal evasion stays below anomaly monitors. [src-11]

3. Computer vision and multimodal AI are vulnerable to cross-vendor transferable perturbations.
- FRA-Attack works across 15 models from 7 vendors. [src-3]
- Audio attacks achieve 85.5% success through compression. [src-4]

4. Certified defenses exist but remain research-stage.

5. **Gap:** No source describes an actual fraud detection system being bypassed in production. All results are from research benchmarks.

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** No source covers a real-world fraud detection bypass incident.
**QA issues:** Publication rate trend figure not in sources; "voice-based identity verification" applicability asserted not evidenced.

---

## Q4 — Boundary / RAG

**Question:** What are the biggest security risks associated with RAG systems and vector databases?

Assessment: RAG systems face a mature and operationally credible threat landscape. The core problem is that the knowledge base itself is the attack surface, and poisoning it requires surprisingly little effort. Confidence is high; multiple independent research groups converge from different angles.

1. Poisoning a RAG knowledge base with a tiny fraction of bad content causes outsized damage.
- Corrupting as little as 1.6% of a knowledge base is enough to systematically mislead AI in critical systems. [src-2]
- ADMIT achieved 86% success at manipulating AI fact-checkers by injecting false documents, working across multiple models without access to internals. [src-11]
- Injecting just 0.05% malicious code snippets caused GPT-4o to produce insecure code in over 40% of targeted cases. [src-8]

2. The retrieval layer itself is an attack surface.
- Backdoor attacks planted inside the retrieval component — not the model — are invisible to standard model security checks. [src-8]
- Malicious Token Injection (MTI) corrupts the transformer key-value cache through subtle perturbations. [src-9]

3. RAG systems as web-search agents are vulnerable to real-time manipulation.
- Malicious web pages get pulled into AI agent context and presented as endorsed recommendations — 31.4% success rate depending on model. [src-4]

4. Backdoor attacks on RAG infrastructure are stealthy and persist through testing.
- Backdoor-powered prompt injection renders instruction-hierarchy defenses ineffective post-deployment. [src-12]
- "Sleeper cell" technique embeds latent behavior that only activates under specific trigger conditions, passing all safety benchmarks. [src-7]
- Multi-agent distributed backdoors achieve >95% data exfiltration success when triggered. [src-10]

5. Privacy risk: document-level membership inference allows probing for presence of specific confidential files. [src-1]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** Attack success rates from controlled research; real-world degradation could differ.
**QA issues:** Several specific figures (ADMIT 86%, 31.4% web poisoning, 95% multi-agent exfiltration) flagged as not clearly confirmed by cited excerpts.

---

## Q5 — LLM Threats

**Question:** How has indirect prompt injection evolved over the past year?

Assessment: Indirect prompt injection has crossed from research curiosity into confirmed operational threat. Multiple independent sources — academic, vendor, and threat intelligence — converge, and real-world victim counts and financial consequences are documented. The most significant new development is expansion of attack targets beyond end users to the AI systems defenders themselves rely on.

1. Real-world exploitation is confirmed and growing.
- Unit 42: 85.2% of observed attacks use social-engineering frames. [src-1]
- Center for AI Safety: 8,600 successful attacks across frontier models with confirmed consequences. [src-2] _(single source — treat as indicative)_
- CrowdStrike 2026 GTR: prompt injection hit at least 90 organisations; AI-related attacks doubled YoY. [src-12]

2. Attackers are now targeting defenders' AI tools — a serious escalation.
- macOS.Gaslight plants hidden instructions inside malware artifacts designed to be read by AI security triage tools, causing the AI to downplay or ignore the threat. [src-8]

3. Attack surface expanded across every channel AI agents read.
- LivePI benchmark: 10.7–29.6% success across 7 different input surfaces; group-chat injection worked against every model tested. [src-6]
- "Schema poisoning" hides instructions inside structured data formats (JSON-LD, API responses). [src-3]
- RAG knowledge base poisoning: one poisoned document can compromise every user whose query retrieves it. [src-10]
- Chatbots with tool access can be turned into data-exfiltration pipelines. [src-7]

4. Defenses are maturing but none are foolproof.
- Progent (out-of-band controls): reduced attack success from 25.8% to 4.2%. [src-9]
- RAG layered defense: 71.4% → 11.3%. [src-10]
- RETA (grounds decisions in original user intent): below 10% against adaptive attacks. [src-11]

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** The 8,600 and 90-organisation figures are each single-sourced and cannot be cross-verified.

---

## Q6 — LLM Threats

**Question:** What are the major prompt injection incidents affecting coding assistants?

Assessment: Prompt injection has moved to confirmed, operational attack method targeting coding assistants. The GitHub Copilot filesystem escape and Claude Code CI/CD secret leak are the two most concrete, vendor-confirmed incidents.

1. GitHub Copilot filesystem vulnerability.
- CVE in Copilot 1.372.0: specially crafted URI parameter in its web-fetch tool reads files outside the project folder without user approval. [src-1]
- Data-over-image exfiltration (hiding stolen data inside image URLs using Markdown) confirmed against Copilot Chat. [src-7]

2. Claude Code GitHub Action leaks CI/CD secrets.
- Microsoft Threat Intelligence and Check Point independently confirmed a prompt injection path in the Claude Code GitHub Action that exposes workflow secrets. [src-10, src-12]
- Supply-chain risk: turns the AI coding assistant into a vector for handing deployment credentials to attackers.

3. Indirect prompt injection at scale — enterprise-wide.
- CrowdStrike 2026 GTR: 90 organisations, AI-targeted attacks doubled. [src-9] _(single-sourced)_
- Unit 42: 85.2% of live IPI attacks use social-engineering framing. [src-11]
- 5 poisoned documents in a RAG system: 90% manipulation success rate. [src-6] _(single vendor source — indicative)_

4. Structural root cause: LLMs cannot reliably distinguish trusted instructions from untrusted content based on meaning; they fall back on stylistic cues.
- Stripping those style cues ("destyling") cut attack success from 61% to 10%. [src-8]

5. Attackers also weaponising against defenders.
- macOS.Gaslight embeds IPI inside malware targeting AI security analysis tools. [src-2]

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** No patch status or vendor remediation timelines confirmed in sources.
**QA issues:** Copilot Chat confirmation; RAG 90% figure is from a vendor blog (medium trust); Microsoft/Check Point independent confirmation phrasing.

---

## Q7 — LLM Threats

**Question:** Are jailbreaks still relevant or has the threat landscape moved on?

Assessment: Jailbreaks have not been superseded — they have been absorbed into a more dangerous, operationally mature threat. Classic jailbreak logic now powers real-world attacks on enterprise systems, AI-assisted security tools, and agentic pipelines. The "jailbreaks are old news" framing is overhyped; the technique is more consequential than ever, just wearing different clothes.

1. Jailbreak mechanics are the engine behind active, confirmed enterprise attacks.
- CrowdStrike 2026 GTR: 90 organisations targeted; attacks doubled YoY. [src-6]
- Center for AI Safety: 8,600 successful IPI attacks with real consequences. [src-10] _(single source — indicative)_
- Unit 42: 85.2% of real-world IPI attacks use social-engineering frames. [src-7]

2. Jailbreaks now target defenders themselves.
- macOS.Gaslight embeds IPI inside malware; when a security analyst's AI triage tool reads the file, the AI is manipulated into refusing to flag the threat. [src-1, src-8, src-9]

3. Agentic AI dramatically raises stakes.
- When AI agents have tool access (web browsing, file systems, financial APIs), a successful jailbreak enables action, not just text extraction. [src-4, src-11]
- BioShocking attack chain: prompt injection compromising AI browser guardrails. [src-3]
- LLM-based grading systems manipulable to inflate scores. [src-12]

4. Root-cause vulnerability: role confusion.
- LLMs cannot reliably distinguish trusted system instructions from untrusted user input based on meaning alone — they use stylistic cues.
- "Destyling" cut attack success from 61% to 10%. [src-5]

5. Detection tools exist but are not yet sufficient.
- GuardNet: AUROC 0.747, 50ms on standard hardware. [src-2] Competitive but with meaningful false-negative rates.

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** The 8,600 IPI figure is single-sourced and unverified.

---

## Q8 — LLM Threats

**Question:** How are attackers using images and multimodal inputs to bypass LLM guardrails?

**Notable behaviour:** The agent correctly disclosed that the multimodal-specific angle was not evidenced in the corpus and answered the related text-injection question instead. This is good epistemic practice. The actual multimodal research (FRA-Attack, codec attacks) is in the corpus under Q1/Q3, but the query planner apparently didn't retrieve it here — suggesting a retrieval gap on "multimodal guardrail bypass" as a query.

Assessment (as delivered): The sources contain no direct evidence of attackers using images or multimodal inputs specifically to bypass LLM guardrails. Every confirmed operational attack described here uses text-based prompt injection. The agent pivoted to what the evidence actually shows.

What the answer covered (text-based guardrail bypass):
1. Text-embedded hidden instructions in external content — dominant live attack method; Unit 42 documented 22 techniques; 85.2% use authority/persuasion frames. [src-10, src-11]
2. Malware purpose-built to manipulate AI security tools (macOS.Gaslight, Shai-Hulud supply chain). [src-5, src-6, src-12]
3. AI agents with real-world permissions being manipulated — Meta chatbot Instagram password reset incident; Claude Code CI/CD secrets. [src-9, src-7]
4. BioShocking attack chain against AI-powered browsers. [src-1]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** No sources address image-based or multimodal guardrail bypass specifically; that sub-question cannot be answered from the current corpus.
**QA issues:** Several specific claims (Unit 42 22 techniques; 85.2%; Meta chatbot incident) flagged by verifier.

**Issue identified:** The corpus contains multimodal adversarial research (FRA-Attack, codec-robust attacks) but it didn't surface for this query. The query planner may need better routing for "multimodal bypass" → Traditional AI Threats category.

---

## Q9 — Agentic AI

**Question:** What are the biggest security risks introduced by MCP?

Assessment: MCP has rapidly become a high-value attack surface with multiple confirmed, exploitable vulnerabilities already in the wild as of mid-2026. The most dangerous risk is structural — MCP assumes that tools and their descriptions are trustworthy, and they are not.

1. Poisoned tool descriptions give attackers a quiet lever to hijack agent behavior.
- Microsoft flagged poisoned descriptions as an active attack path. [src-5, src-6]
- ShareLock splits malicious instructions across multiple tool descriptions using Shamir's secret sharing, evading detection with >90% success against mainstream models. [src-11] _(single academic paper — indicative)_

2. MCP auto-execution means cloning a malicious repo can immediately run attacker code.
- Amazon Q: cloning a malicious repo and enabling workspace trust was sufficient for immediate code execution with full access to developer's AWS credentials. Fixed in v1.65.0+. [src-7, src-8]
- "Agentjacking" exploits the MCP communication layer in Claude Code, Cursor, and similar tools. [src-4]

3. MCP servers connected to real infrastructure are vulnerable entry points.
- CVE-2026-47250: Kubernetes MCP server passed user-supplied flags without filtering — credential theft. Fixed in v3.7.0. [src-2]
- CVE-2026-13341: Kong Konnect MCP server injection through external data. Fixed in v1.0.0. [src-1]
- mcp-server-git: chained path traversal + argument injection. [src-12]

4. A single malicious webpage can compromise the host machine running an AI browsing agent.
- AutoJack: one malicious webpage → code execution on host via AutoGen Studio's MCP WebSocket localhost trust model. [src-9]

5. Gateway misconfigurations extend MCP risk into cloud and financial systems. [src-10]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** ShareLock 90% success rate and several lateral-movement scenarios rest on single or medium-trust sources.

---

## Q10 — Agentic AI

**Question:** Explain how a malicious webpage could steal local credentials from an AI agent.

Assessment: Well-answered with two documented attack paths: hidden instructions in web content (indirect prompt injection) and the AutoJack RCE chain that turns the agent's browser into full system access. Both paths are confirmed by multiple independent sources.

1. Hidden web instructions — primary proven credential-theft vector.
- Attackers hide instructions in page content, including inside JSON-LD structured metadata invisible in normal page view. Agent acts on attacker commands without any human review. [src-3, src-4, src-6, src-7]
- Agents with payment/login capabilities have already been steered into performing unauthorised transactions and credential submission. [src-4, src-6, src-7]

2. AutoJack — turns agent browser into full system access.
- Malicious webpage exploits AutoGen Studio's MCP WebSocket (local communication channel) to achieve RCE on host, not just data exfiltration. [src-1]
- Single page visit is sufficient; relies on machine treating local connections as trusted (common default).

3. Tool descriptions as attack surface.
- MCP tool descriptions can be poisoned by an attacker with hidden instructions, redirecting the agent's credential handling without sanitisation of the tool catalogue. [src-5]

4. State-sponsored actors now using same injection path for operational sabotage, not just credential theft. [src-2]

5. Secondary vectors: Claude shared-chat feature abused to distribute credential-stealing malware [src-10]; AI coding agents fed malicious setup scripts. [src-9]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** AutoJack RCE chain is documented against AutoGen Studio specifically; generalisability to other frameworks is asserted but not independently verified.

---

## Q11 — Agentic AI

**Question:** Why are agentic systems increasingly vulnerable to supply chain attacks?

Assessment: Solid answer. Agentic systems automatically trust and act on content from external sources — tools, web pages, code packages, plugin descriptions — without verifying whether that content has been tampered with. The trend data (34 sources/week vs 21 baseline) reinforces rapid expansion of this attack surface.

1. AI agents inherit whatever is poisoned in the tools and plugins they connect to.
- MCP tool description poisoning. [src-5]
- April 2026: researchers hijacked Claude Code, Gemini CLI, and GitHub Copilot by planting malicious instructions in GitHub pull-request titles. [src-11]

2. AI coding agents are actively exploited to install malicious packages without verification.
- Autonomous agents install packages without human approval, collapsing the delay between a poisoned package appearing and being installed.

3. Any web content an agent reads is now a potential attack channel.
- Hidden instructions in web pages or structured data markup have been used to trigger unauthorised money transfers. [src-3, src-4, src-6, src-7]

4. State-sponsored actors deliberately weaponising trust gaps for sabotage, not just theft.
- Attackers injecting malicious context into AI security triage, incident response, medical diagnosis agents to derail the mission. [src-2]
- Coordinated IPI attacks against GenAI tools at 90+ organisations. [src-12]

5. Legitimate AI platforms being used as attack delivery infrastructure.
- Claude shared-chat feature used to distribute credential-stealing malware at scale. [src-9]
- Google Gemini voice assistant manipulated via injected notifications to gain device control. [src-10]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** Quantified impact figures largely absent; severity based on mechanism and actor profile.

---

## Q12 — Agentic AI

**Question:** What does the Amazon Q incident tell us about the future trust model of coding agents?

**Notable behaviour:** The agent correctly disclosed that the named Amazon Q incident is not in its corpus, then pivoted to a well-grounded analysis of the broader coding-agent trust model pattern (which is exactly what the question is really asking). Good epistemic transparency.

The answer is high quality despite the corpus gap. Key conclusions delivered:

1. Coding agents inherit too much trust by default.
- Agents clone repos and run setup scripts without sandboxing or verification.
- Shell commands generated by AI are passed directly to execution with no sanitisation. [src-9, src-10]

2. Agents read documentation and configuration files as instructions.
- README or config files with prompt injection can redirect agent behaviour, invisible to code scanners. [src-4]
- Error reports fed to an agent can trigger execution of attacker-supplied code (Agentjacking). [src-8]
- Bash obfuscation bypasses modern agent safeguards. [src-7]

3. External tool connections are largely unguarded trust boundaries.
- MCP server misconfigurations: credential theft, code exfiltration, lateral movement. [src-6]
- MCP tool descriptions themselves are an attack path. [src-12]

4. Attack surface moving from data theft to operational sabotage and financial loss.
- State-sponsored actors using IPI to make AI fail at its mission. [src-11]
- Documented $175k loss: AI agent with autonomous financial tool access manipulated into transferring funds. [src-5] _(single source — indicative)_
- LLM agents used as post-exploitation delivery mechanism. [src-1]

5. Volume is accelerating.
- Agentic AI threat reporting: 34/week vs 21 baseline (~60% increase).

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** No source describes a named Amazon Q security incident; conclusions drawn from the broader threat pattern.

---

## Q13 — Agentic AI

**Question:** Are AI agents creating entirely new attack classes or simply reintroducing old ones?

Assessment: AI agents are not creating wholly new attack primitives — the underlying techniques are decades old. What is new and genuinely dangerous is the *execution context*: agents act autonomously at machine speed with real-world tool permissions, turning old tricks into self-executing, high-impact exploits.

1. Prompt injection = old input injection, now with machine-speed, real-money consequences.
- Agents browsing the web executed hidden payment instructions requiring no compromise of the agent itself. [src-7, src-11]
- State-sponsored actors using prompt injection to *sabotage* mission, not just steal data. [src-2]

2. MCP simply reopens classic server-compromise and credential-theft paths at broader scope.
- One compromised MCP gateway exposes every tool the agent is authorised to use. [src-1]

3. Shell injection against AI coding agents = repackaged 1990s attack class, now automated at developer scale.
- "GuardFall" vulnerabilities in open-source AI agents use legacy shell-injection techniques. [src-6]
- Malicious repo setup scripts executed without sandbox controls. [src-9]

4. Visual spoofing against mobile agents is genuinely new in execution surface.
- Mobile AI agents can be fed invisible text or fake UI elements only the AI "sees." [src-5]
- The attack surface (difference between human and machine vision on a shared screen) did not exist before vision-capable agents became operational.

5. Agents as post-exploitation delivery layer — the trajectory shift that matters most.
- CVE-2026-39987 in Marimo agent framework: agent used as infrastructure for delivering follow-on malware in cloud environments. [src-3]
- "Hallucination-driven malware" — AI recommends a non-existent package; attackers pre-register it with malicious payload. [src-10]

**Meta:** mode=`grounded` | sources=12 | confidence=`low`
**Caveat:** Specific financial figures ($175k; 90 organisations) rest on a single medium-trust source. Confidence lowered because most specific claims could not be tied to a cited source.

---

## Q14 — Agentic AI

**Question:** How does reasoning-chain hijacking differ from traditional prompt injection?

Assessment: Reasoning-chain hijacking is a structural evolution of prompt injection, not merely a variation. Where traditional prompt injection overrides what an AI is told to do, reasoning-chain hijacking corrupts how the AI *thinks through* a problem. The sources don't use the term explicitly, but the operational evidence points clearly toward this more sophisticated class emerging in the wild.

1. Key distinction.
- Classic IPI: AI does the wrong *action*.
- Reasoning-chain variant: AI appears to do the right action (analyse the file) but reaches a *conclusion* the attacker chose.
- macOS.Gaslight: embeds instructions inside malware artifacts so AI security analyst tools produce false-clean analysis rather than just doing something unexpected. [src-1, src-6]

2. Operationally deployed at scale.
- 85.2% of IPI attacks use social-engineering frames to steer AI reasoning. [src-3]
- 8,600 successful IPI attacks with real financial consequences. [src-7] _(single source)_
- 15,300 instances of injected instructions in live webpages across 1.2B URLs; up to 8% AI model compliance. [src-8]

3. Defenses are wider for reasoning-chain attacks.
- Standard input sanitisation misses injections crafted to look like legitimate content.
- AI grading systems manipulated so students inflate scores regardless of answer quality — the AI's *reasoning* was steered, not just its input filter bypassed. [src-11]
- Adversarial audio achieves 79–96% success hijacking commercial voice agents. [src-9]

4. Automated payload generation accessible to non-expert attackers.
- Black-box optimisation outperforms gradient-based approaches, lowering the barrier. [src-10]
- 32% rise in injected instructions in publicly crawled web data between Nov 2025–Feb 2026. [src-5] _(single source)_

5. Highest-consequence target: AI security triage — making a defender's AI conclude malicious code is clean. [src-1, src-4, src-6]

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** The 90-organisation figure and YoY doubling claim comes from a single vendor report.

---

## Q15 — AI-Enabled

**Question:** How are threat actors operationalising frontier AI models for cybercrime?

Assessment: Frontier AI models have crossed from research curiosity to operational criminal and state-sponsored tooling across every phase of an attack — reconnaissance, exploit development, malware writing, and fraud. Evidence base is unusually strong: multiple independent high-trust sources (Google, Microsoft, Rapid7) converge without meaningful contradiction.

1. AI-generated zero-day exploits: confirmed operational reality.
- Google Cloud Threat Intelligence: criminals used AI to find and weaponise a previously unknown flaw in a popular web administration tool — a logic error traditional scanners miss. [src-6]
- First publicly disclosed case of a 2FA bypass zero-day developed with AI assistance, deployed at scale. [src-2, src-11]
- State-sponsored groups (China, North Korea, Russia-linked) using AI to autonomously find, analyse, and validate vulnerabilities at scale. [src-7]

2. AI-accelerated malware development and mutation.
- Microsoft documented Coral Sleet using AI coding tools to generate and redeploy malware components at scale. [src-3]
- Google named CANFAIL and LONGSTREAM malware families with AI-accelerated development; APT27 and Russia-linked actors used Gemini API to generate obfuscated code. [src-8, src-10]

3. Criminal underground has industrialised AI access.
- Underground marketplaces selling jailbroken AI wrappers, Telegram bots, stolen API keys — FraudGPT, WormGPT on subscription. [src-4]
- Google identifies a mature, multifunctional underground AI tooling market for phishing, malware development, vulnerability research. [src-5]
- Xanthorox offering jailbroken AI capabilities to criminal buyers. [src-12]

4. AI systematically accelerating early attack stages.
- AI used for target profiling, hardware/software environment mapping, and phishing lure generation before attack code is written. [src-9]
- One campaign: probed >73 AI endpoints and generated >80,000 interaction sessions over 11 days. [src-1]

5. Reporting on AI-enabled threats running at ~18.5 sources/week vs 10.7 baseline — near-doubling.

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** Several campaigns lack full actor attribution; underground tool capabilities documented primarily via vendor threat intel.

---

## Q16 — AI-Enabled

**Question:** What changes have we seen in AI-enabled phishing over the past year?

**Notable behaviour:** The agent honestly disclosed that coverage is thin — one source, one incident — and gave a high-fidelity read on that one confirmed development rather than padding with speculation. Good restraint.

1. AI now generating fake domain names automatically at scale in real attacks.
- "Montana Empire": first documented threat actor using an LLM to mass-produce convincing fake domain names inside a live phishing campaign, exploiting "domain hallucination." [src-1]
- Automation removes the manual bottleneck of hand-crafting fake domains one at a time.

2. Existing email defenses structurally poorly suited.
- DMARC/DKIM help but only when enforced; many organisations haven't.
- Domain reputation checks struggle against thousands of new lookalike domains appearing simultaneously.

3. **Gap explicitly acknowledged:** No data in corpus on AI-generated phishing email text, AI-powered voice/video impersonation, or industry-specific targeting.

**Meta:** mode=`grounded` | sources=1 | confidence=`low`
**Caveat:** Entire assessment rests on a single source covering a single threat actor; the broader picture cannot be drawn from this evidence.

**Issue noted:** Very thin corpus coverage for AI-enabled phishing. The weekly reporting rate figure (11→19/week) cited by the agent appears to be drawn from internal analytics rather than a cited source — the verifier flagged it.

---

## Q17 — AI-Enabled

**Question:** Have there been any examples of malware specifically targeting AI systems?

**⚠️ QA BLOCKED — answer suppressed**

The verifier flagged that CVEs referenced in the draft answer (CVE-2025-10156, CVE-2025-10157) were not found in any retrieved source. The QA gate blocked the answer from being delivered.

What the agent attempted to claim (cannot verify from corpus):
- Fake OpenAI repository on Hugging Face: 244,000 downloads, delivered credential-stealing malware to Windows users
- Cloud Security Alliance: 341 malicious AI agent skills ("ClawHub") carrying Atomic Stealer malware
- npm package "mouse5212-super-formatter": silently uploaded developer files to attacker-controlled account, 676 downloads

**Issue:** The QA blocking is correct — unverified CVEs should not be cited. However, the underlying topic (malware targeting AI systems) is well-covered in the corpus (LiteLLM backdoor, Hugging Face typosquatting, ShadowLogic model backdoors all appear in Q18/Q25). The failure mode is likely a retrieval/entity extraction issue where the query planner pulled sources that mentioned CVEs the answer then incorrectly attributed. The fallback message ("try rephrasing") is functional but not ideal — a better response would have answered with what *is* in the corpus.

---

## Q18 — Cross-category

**Question:** What is the biggest change in the AI threat landscape over the last year?

Assessment: The defining shift is that AI has moved from being a tool attackers *use* to being a component *inside* attack infrastructure itself. Agentic AI systems have opened a new attack surface that defenders are not yet equipped to handle. Evidence consistent across multiple high-trust sources.

1. Malware that rewrites itself using AI is now documented.
- Google threat intelligence: PROMPTFLUX, PROMPTSTEAL, PROMPTLOCK, FRUITSHELL call live AI APIs during execution to regenerate their own code and evade detection. [src-6, src-7]
- This defeats signature-based detection entirely.

2. Agentic AI systems are now a documented target AND delivery mechanism.
- Claude Code used as sustained operational tool over multiple weeks by attackers. [src-1]
- CVE-2026-39987 in Marimo: remote code execution in cloud environments. [src-11]
- Attackers hijacking AI agents by modifying configuration files. [src-8]
- Agentic AI threat reporting: baseline 21 → 34 per week.

3. AI tool supply chain is actively poisoned at scale.
- LiteLLM backdoored in versions 1.82.7 and 1.82.8: >119,000 downloads during exposure window. [src-10]
- Hugging Face fake repository distributing credential-stealing software. [src-9]
- 3,869 AI agent skills scanned: 76 confirmed malicious payloads, 13.4% security flaws overall. [src-5] _(single source — indicative)_

4. AI compressing vulnerability-to-weaponisation timeline.
- Huntress: OpenAI's o3 model used to rapidly accelerate Linux exploit code development. [src-2]

5. Infrastructure connecting AI systems is now under attack.
- MCP: >200,000 AI servers reportedly affected by related vulnerabilities. [src-4, src-12] _(single medium-trust source — unverified)_

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** LiteLLM and Hugging Face incidents well-documented; downstream victim counts and actual credential-theft confirmation beyond download figures not established.

---

## Q19 — Cross-category

**Question:** Are we seeing the emergence of entirely new attack techniques that have no traditional cybersecurity equivalent?

Assessment: Yes — specifically, attackers weaponising the AI systems defenders rely on, turning those tools against their operators. Evidence is strong and convergent with documented financial losses.

1. Sabotaging defenders' own AI tools — a fundamentally new threat category.
- Gaslight: embeds IPI inside malware designed to corrupt AI security analysis tools. [src-1, src-8, src-11]
- No traditional analogue: antivirus software cannot be "argued out of" detecting a virus.

2. AI agents with financial/operational authority robbed through their data feeds, not code exploits.
- IPI via web content: agent reads, follows embedded instructions, takes action — no human review.
- $175k loss documented: AI agent with cryptocurrency wallet access tricked by hidden instructions in fetched web content. [src-7, src-6] _(single source — indicative)_
- One attacker encoded instructions in Morse code to evade text filters.

3. Agent permission model creates a new class of data-leak risk.
- "GitLost": AI coding assistant operating inside GitHub with broad service-account permissions leaked private source repositories via hidden instructions in a GitHub Issue. [src-9]
- Traditional access controls stop humans; they do not stop an AI agent that legitimately holds the access.

4. AI coding agents introduce new supply-chain attack path through *documentation*, not code.
- Malicious instructions embedded in README files; completely invisible to conventional code scanning tools. [src-12]

5. Volume signal: agentic AI threats at 34/week vs 21 baseline.

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`
**Caveat:** Most documented incidents involve research or early-production environments; full prevalence across mature enterprise deployments not yet established.

---

## Q20 — Cross-category

**Question:** If you were a CISO preparing for AI risks over the next 2 years, what would you prioritise?

**⚠️ General mode — no corpus grounding**

The corpus had no CISO-strategy sources. The agent fell back to general background knowledge. The answer is sound generic guidance but is not grounded in the platform's intelligence.

Strategic priorities delivered (ungrounded):
1. Control what the AI can actually *do*, not just what it says — least privilege for AI tools
2. Defend against prompt injection — most underestimated AI-specific attack type
3. Protect proprietary data from leaking through AI tools — data classification policy before broad deployment
4. Prepare for AI-accelerated attacks — attackers using AI for phishing, malware, and recon
5. Build AI governance before tools proliferate beyond visibility — shadow AI inventory

**Issue:** For a CISO strategy question, the corpus has rich relevant material (LiteLLM supply chain, agentic permission gaps, Gaslight detection evasion, MCP risks) that could support a fully grounded response. The query planner likely didn't retrieve it because the question didn't match the corpus's attack-focused framing. This is a retrieval/intent alignment issue, not a content gap.

---

## Q21 — Hard mode

**Question:** Is prompt injection fundamentally different from phishing?

Assessment: Strong analytical response. Prompt injection and phishing share the same underlying trick — deceiving a decision-maker into following attacker instructions — but prompt injection is operationally distinct because the victim is an AI system that often has direct access to tools, data, and automated actions that amplify harm far beyond what a tricked person would hand over.

Key distinctions made:
1. Victim and blast radius differ fundamentally — AI victim acts immediately, at scale, with system-level access; no human delay or suspicion.
2. IPI payloads wait silently in webpages for any AI that browses; phishing links need a human to click. [src-9]
3. Escalation: IPI now targeting defenders' own AI tools (Gaslight), not just users. [src-1, src-5, src-7]
4. Audio attack surface: AudioHijack achieves 79–96% success on voice AI agents — phishing has no audio analogue. [src-10]
5. Automated IPI tooling now outperforms gradient-based approaches for black-box targets. [src-11]
6. IPI generalises to any domain where AI makes decisions on externally supplied text — including grading systems. [src-12]

**Verdict delivered:** Prompt injection is phishing's successor for an AI-automated world — same social manipulation logic, but the victim acts instantly, at scale, and with system-level access.

**Meta:** mode=`grounded` | sources=12 | confidence=`moderate`

---

## Q22 — Hard mode

**Question:** Is an MCP server more similar to an API, a software package or an employee?

**⚠️ Incorrectly classified as out-of-scope**

The agent responded: _"I focus on AI threat intelligence — LLM and agentic-AI threats, adversarial ML, AI-enabled attacks, and related vulnerabilities and incidents. Ask me something in that area and I'll dig into the corpus."_

This is wrong. The question is directly within the platform's domain (MCP is a central topic in Agentic AI Threats). The expected answer is **"All three, depending on context":**
- **API**: MCP servers expose structured function calls, versioned interfaces, and authentication tokens — exactly like an API
- **Software package**: MCP servers are installed, versioned, can be supply-chain-compromised, and execute code in your environment — exactly like a package
- **Employee**: MCP servers are granted trust, given access credentials, and act on behalf of the user with delegated authority — analogous to an employee with system access

This is the richest possible framing for understanding MCP's risk surface, and the corpus has extensive MCP material (Q9 covers CVEs, ShareLock, AutoJack, Amazon Q, etc.).

**Issue:** The query planner classified this as out-of-scope (mode=`out_of_scope`). This is likely because the question is framed as an analogy/reasoning question rather than a threat intelligence question. The intent classifier needs to handle conceptual/analytical questions about core platform topics, not just factual retrieval questions.

---

## Q23 — Hard mode

**Question:** Why does agentic AI seem to violate traditional cybersecurity assumptions?

Assessment: Well-answered. Strong analysis of why agents break the core 1990s assumption that a compromised component stays compromised in one place.

1. Agents act autonomously — attacker's reach multiplies without extra effort.
- First documented autonomous ransomware: agent independently harvesting credentials and performing reconnaissance. [src-10]
- Langflow vulnerability: full tool-invocation authority, multi-stage attack without writing exploit code. [src-11]
- Stolen access to LLM inference servers used to build and run offensive agent chains. [src-12]

2. Attack surface is the agent's data inputs, not its code.
- Semantic Norm Drift: poisons documents in shared agent memory databases; defenders mistake it for a software bug. [src-6]
- Hidden instructions in GitHub repos; agents trust repository contents. [src-7]

3. Agents hold permissions designed for humans.
- GuardFall: legacy shell-injection techniques bypass modern AI agent safeguards. [src-5]
- MCP misconfigurations create immediate lateral movement risk. [src-1]

4. Conventional detection fails — agent misbehaviour looks like normal operation.
- Semantic Norm Drift explicitly exploits this: poisoned memory causes behaviour defenders attribute to "model failure." [src-6]
- Agents spanning coding, tool invocation, and hallucination-driven malware distribution attack different layers simultaneously. [src-8]

5. No mature technical standard yet constrains what agents can do.
- Language-Based Agent Control framework is still research, not deployed standard. [src-9]

**Meta:** mode=`grounded` | sources=12 | confidence=`high`
**Caveat:** Several incidents (Langflow, Marimo CVE) are sourced from single outlets.

---

## Q24 — Hard mode

**Question:** What do Gaslight, AutoJack, MCP poisoning and Agent-Mediated Deception have in common?

**Expected answer:** They attack decision-making rather than software execution.

Assessment: The agent correctly identified all four as variants of the same underlying attack class (prompt injection via indirect delivery), and correctly noted that the attack surface is everything the agent reads, fetches, or executes. However, the answer could have been sharper on the **decision-making vs execution** framing — the agent emphasised delivery mechanism more than the conceptual distinction.

What the answer got right:
- All four exploit the same design assumption: agents act on any text they retrieve. [src-1, src-8, src-12]
- Indirect delivery is the key innovation — none require breaking into the AI system itself. [src-2, src-3, src-6, src-9]
- Blast radius now includes financial loss ($175k single-source [src-5]) and full code execution (AutoJack). [src-8]
- Defenses lagging: agents inherit permissions without understanding data classification. [src-6]
- FragFuse and ObliInjection bypass access controls at 86% lab success. [src-10, src-11]
- Common architectural flaw: no distinction between instruction layer and retrieved content layer.

What could be sharper: The answer didn't explicitly name "decision-making vs software execution" as the framing, which is the most conceptually powerful way to unify these four techniques. That distinction — that these attacks corrupt what the AI *decides* rather than exploit a code bug — is what makes them genuinely novel.

**Meta:** mode=`grounded` | sources=12 | confidence=`high`

---

## Q25 — Hard mode

**Question:** Is AI security converging towards traditional cybersecurity or diverging away from it?

Assessment: Best overall answer in the test set. Clear thesis (convergence with escalation), well-evidenced, acknowledges where AI security is genuinely novel, and avoids both overclaiming novelty and dismissing it.

1. Supply-chain attacks — the oldest threat — are the dominant AI attack vector right now.
- LiteLLM backdoor: >119,000 downloads during exposure window. [src-3]
- Hugging Face typosquatting: classic technique, new platform. [src-2]
- ONNX/TensorRT model file backdoors surviving standard security review. [src-7]

2. AI agents create a new amplification layer on top of familiar vulnerabilities.
- Prompt injection spread virally through shared code templates. [src-6]
- OpenClaw: any web page injects persistent commands into AI working memory via workspace file override. [src-4]
- Criminal actors using Claude Code as sustained multi-week operational tool. [src-1]

3. AI-specific backdoors at model level represent genuinely new territory.
- ShadowLogic backdoors: embedded in the AI model's computational graph, persist through fine-tuning, invisible to standard validation. [src-5, src-7]
- No existing equivalent of antivirus scanning for model graphs.

4. AI safety systems defeated by the techniques they're meant to catch.
- OpenAI's guardrail framework uses AI to evaluate AI — you can bypass the safety check by injecting instructions into the evaluation prompt itself. [src-9]
- Token flip attacks bypass common guardrail architectures across the industry. [src-10]

5. Infrastructure under AI applications carries traditional severe vulnerabilities.
- ChromaDB (13M downloads/month): pre-authentication RCE — no novel exploitation needed. [src-11]

**Final verdict delivered:** The trajectory is convergence with escalation — traditional attack techniques are being grafted onto AI-native systems, which multiply their reach and persistence. Defenders who treat AI security as a separate specialty miss the traditional angles; defenders who treat it as purely traditional miss the model-level and agent-level threats unique to AI.

**Meta:** mode=`grounded` | sources=11 | confidence=`high`

---

## Issues Summary

| # | Question | Issue |
|---|----------|-------|
| Q8 | Multimodal guardrail bypass | Retrieval gap: multimodal adversarial research (FRA-Attack, codec attacks) exists in corpus but didn't surface for this query. Query planner needs better routing for "multimodal bypass" → Traditional AI Threats category. |
| Q16 | AI-enabled phishing | Thin corpus coverage — only 1 source, 1 incident. Internal trend analytics figure cited by answer not traceable to a source. |
| Q17 | Malware targeting AI systems | **QA BLOCKED** — verifier flagged CVEs not found in sources. Correct block, but answer could have redirected to well-evidenced corpus material (LiteLLM, ShadowLogic, etc.) rather than returning a failure message. |
| Q20 | CISO risk priorities | **General mode fallback** — no corpus grounding. Rich relevant material in corpus (MCP, Gaslight, LiteLLM) but query planner didn't retrieve it. Intent-alignment issue: question is framed as strategy, not attack-retrieval. |
| Q22 | MCP analogy (API/package/employee) | **Incorrectly classified as out-of-scope.** MCP is a core platform topic. Likely caused by the analogy/reasoning framing rather than factual retrieval. Expected answer: "all three, depending on context." |
| All | Recurring unverifiable numbers | "90 organisations," "8,600 attacks," "$175k loss" appear in many answers — sourced from single medium-trust outlets. Answers correctly hedge each time, but repetition across 10+ questions may feel noisy. Consider consolidating these into a verified context note. |
| All | QA issues flagging | Verifier logged `qa_issues` on 19/25 questions, mostly for minor attribution precision (rounding, phrasing). Only Q17 was actually blocked. Consider raising the threshold for what appears as a `qa_issue` label. |
