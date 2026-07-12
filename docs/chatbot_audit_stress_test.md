# Chatbot Stress Test + DB Audit

_6 questions tested 2026-07-12 post-retrieval fixes. Combined answer quality audit and database analysis._

---

## DB Audit Findings First

These findings explain why certain answer patterns keep appearing regardless of the question.

### Finding 1: 45% of all evidence comes from arXiv

Out of 5,836 total evidence rows, the top publisher split is:

| Publisher | Items | % |
|---|---|---|
| arXiv | 457 | 45% |
| NVD | 70 | 7% |
| Check Point Research | 68 | 7% |
| The Hacker News | 58 | 6% |
| Help Net Security | 33 | 3% |
| Red Canary | 29 | 3% |
| Huntress | 29 | 3% |

arXiv evidence breaks down as: agentic (203), LLM (161), traditional (82), AI-enabled (12). The publisher diversity fix on `retrieveRelevant` (capped at 2 per publisher) reduces arXiv dominance in retrieval, but the evidence table itself is still heavily arXiv-weighted. The `getEvidence` diversity fix (also capped at 2 per source URL) should reduce the arXiv-in-evidence problem in synthesis.

### Finding 2: 79% of agentic AI sources have zero evidence extracted

| | Count |
|---|---|
| Total agentic AI sources | 500 |
| With evidence extracted | 104 (21%) |
| Without evidence extracted | 396 (79%) |
| claim_extraction_status=success | 489 of 500 |

Extraction *ran* on 489 sources and reported success, but 396 have no rows in the `evidence` table. This is a silent failure: the pipeline marks extraction as complete but didn't write anything. The chatbot has no access to the substance of these 396 sources beyond their 400-character summary truncation.

High-quality sources with zero evidence extracted:
- OWASP Top 10 for Agentic Applications 2026 (primary trust)
- VulnerableMCP.info comprehensive MCP security database (high trust)
- "Friendly Fire: Hijacking Defensive Cyber AI Agents for Remote Code Execution" (AI Now Institute, high trust)
- "Beware of Agentic Botnets: Scalable Untargeted Promptware Attacks" (arXiv, high trust)
- "GitHub AI agent leaks private repositories via prompt injection attack" (CSO Online, high trust, incident)
- "Hidden Web Prompts Trick AI Agents Into Sending Money" (Security Affairs, high trust, incident)
- "Supply-Chain Poisoning Attacks Against LLM Coding Agent Skill Ecosystems" (arXiv, high trust)
- "A Formal Security Framework for MCP-Based AI Agents" (arXiv, high trust)

The chatbot cannot properly cite or synthesise from these. It can only use their 400-char summary as context.

### Finding 3: 38% of agentic AI evidence is about generic security incidents

141 of 369 agentic AI evidence rows don't mention any AI or agent keyword. The top offender is Check Point Research's weekly threat digests, whose evidence items include:
- Air France data breach via compromised customer service platform
- Google/Salesforce CRM breach exposing 2.55M business contacts
- Bouygues Telecom cyberattack exposing 6.4M accounts
- Dell ControlVault3 firmware vulnerabilities
- Trend Micro RCE advisories
- Pakistan Petroleum ransomware attack

These are real, grounded, high-quality evidence items — but they're categorised under `agentic_ai_threats` because Check Point Research's weekly roundups were ingested and tagged as a whole. When `getEvidence` fetches agentic AI evidence, ~38% of what it returns is generic breach reports unrelated to agentic AI. These crowd out genuinely relevant items.

### Finding 4: The recurring single-source numbers have NO evidence rows

Every answer has cited these figures. Here's what the evidence table actually contains:

| Number | Evidence rows | Reality |
|---|---|---|
| "90 organisations" (CrowdStrike) | **0** | Not in evidence table at all |
| "8,600 IPI attacks" (CAS) | **1** | That 1 item is about Gray Swan's CTF competition with 272 samples — not 8,600 attacks |
| "85.2% social engineering" (Unit42) | **0** | Not in evidence table |
| "$175,000 loss" | **0** | Not in evidence table |
| "119,000 LiteLLM downloads" | **0** | Not in evidence table |

The model is citing these numbers from source *summaries* (the 400-char truncations passed in the context message), not from verified evidence items. The verifier can only check whether a claim is supported by the provided text — if the summary contains the number, the verifier passes it. But the number may be in a summary for a source that never actually contained it, or whose full text hasn't been evidence-extracted.

### Finding 5: Good agentic incident evidence exists and IS grounded

The incidents that should anchor Q3-type answers exist in the evidence table:

| Incident | Publisher | Grounded | Quality |
|---|---|---|---|
| macOS.Gaslight — 38 fake system messages targeting AI triage | SentinelOne | ✓ | High |
| AutoJack — complete RCE chain via malicious webpage | Microsoft/Hacker News | ✓ | High |
| s1ngularity — agent recursively searched for crypto wallet files | Red Canary | ✓ | Medium |
| First malicious MCP server discovered stealing emails | Red Canary | ✓ | Medium |
| Agentjacking — attack via malicious Sentry error reports | Hacker News | ✓ | High |
| ShareLock — Shamir's secret sharing across tool descriptions | arXiv | ✓ | High |
| GuardFall — shell injection bypass in 10/11 AI agents | Adversa AI/Hacker News | ✓ | High |
| GitHub AI agent leaks private repos via prompt injection | CSO Online | No evidence extracted | — |

The retrieval fix (publisher diversity cap, cross-category search) is helping these surface. But the 38% non-AI contamination in agentic evidence means they compete with unrelated noise.

---

## Question-by-Question Answer Audit

---

### Q1 — Threat Landscape Synthesis (8.5/10)

**Question:** What are the most significant emerging agentic AI threats observed in the past 12 months, and what evidence suggests these threats are becoming operational rather than theoretical?

**Mode:** grounded | 12 sources | all agentic_ai_threats | confidence=high

**What's good:**
- Publisher diversity fix is visibly working: Zscaler, ReversingLabs, Innovaiden, Security Affairs, BleepingComputer, Sysdig — not the same 3-4 sources from before
- No internal analytics leaked anywhere in the answer
- The LLMjacking evolution point (stolen compute now used to *run* offensive agent chains, not just mine) is fresh and specific — Sysdig source, correctly flagged as single-source
- The JSON-LD delivery mechanism for hidden payment instructions is concrete and not something the model would invent from training data
- The second-order framing ("the window between agent action and human intervention is where every attack lives") is the right analytical level for a synthesis question

**Issues:**
- The Tencent/MCP-Inspector remote code execution claim has no verifiable source in the retrieved set — QA correctly flagged it, but it still appears in the answer body. A QA-flagged claim shouldn't be presented as a finding; it should either be cut or labelled "unverified claim from a single source"
- Point 4 (LLMjacking) is correctly single-source caveatted but the Sysdig finding about *orchestrating multi-step attacks* from hijacked servers is a significant step beyond the typical "selling stolen compute" narrative. More scrutiny warranted given the single source
- The "Defenders:" line is good and specific to this answer

---

### Q2 — Cross-Category Reasoning (9/10)

**Question:** Does indirect prompt injection through web pages, PDFs, and images belong under traditional AI threats, LLM threats, or agentic AI threats?

**Mode:** grounded | 12 sources | all agentic_ai_threats | high confidence

**What's good:**
- The taxonomy reasoning in point 1 is the strongest conceptual framing in the full test set: "Chatbot reads bad text → bad output → human reviews → limited harm. Agent reads bad text → wires money immediately → no human checkpoint." This is exactly right and precisely articulates why the threat is category-specific
- The robot/ROS2 physical sensor injection point (point 4) is completely new and not covered in the previous 25-question test. The RIPA paper finding that model scale doesn't reliably prevent sensor-based injection is a meaningful constraint on "just upgrade to a better model" as a defence
- PDF/stored injection (DualView research) is correctly identified as a distinct variant from live web injection
- Schema poisoning is correctly separated as a further escalation

**Issues:**
- The CrowdStrike 90 orgs / $175k reappears in point 2, still single-sourced. From the DB audit: this number has **zero evidence rows**. The model is citing it from a summary
- Bold markdown formatting (`**agentic AI threats**`) in the opening assessment violates the system prompt instruction against bold formatting. Minor but indicates the prompt constraint isn't consistently honoured
- The "larger models are not consistently more resistant" finding (point 4) is QA-flagged as not clearly supported by the cited source. The claim is plausible but shouldn't be stated as a confirmed finding

---

### Q3 — Operational Threat Intelligence (7/10)

**Question:** Have there been any real-world incidents where attackers abused AI agents or copilots to steal credentials, execute actions, or access sensitive data?

**Mode:** grounded | 12 sources | all agentic_ai_threats | high confidence

**What's good:**
- Amazon Q credential theft path is now correct and specific (VS Code, poisoned repository → cloud credential theft). This didn't work well in the 25-question test
- The "documentation-based attack bypasses traditional security scanning" point (point 5) is sharp: the attack lives in the README, not the code, so code scanners miss it entirely
- Attack paths are clearly explained in each point — good for the "reconstruct the attack chain" test requirement

**What's missing:**
The DB has excellent incident evidence that didn't surface:
- **s1ngularity (Red Canary)**: agent used to recursively search for cryptocurrency wallet files — this is a real, grounded, named incident with a quote. Not in the answer
- **First malicious MCP server stealing emails (Red Canary)**: confirmed incident, grounded quote. Not in the answer
- **Meta chatbot Instagram account seizure**: mentioned in the 25-question test answers but absent here
- **GitLost (CSO Online)**: GitHub AI agent leaking private repos via prompt injection — a named, recent incident. No evidence extracted so it can't surface

The answer covers the attack *patterns* well but misses several named, concrete incidents that would make point 3 ("have there been real-world incidents?") much more compelling. The retrieval is pulling technique-oriented sources rather than incident-oriented sources.

**Root cause:** The `get_evidence` query uses the plan's search terms ("agent abuse," "credential theft," "agentic attack") but the incident sources are tagged under attack techniques (ASI02, LLM01) rather than named after their incident type. A search for "s1ngularity" or "malicious MCP" would find them; the current term expansion doesn't generate those.

**Issues:**
- State-sponsored sabotage claim (point 4) is QA-flagged and appears without its own source citation
- MCP-Inspector RCE claim is in here again without a verifiable source

---

### Q4 — Strategic Insight Generation / CISO Priorities (8/10)

**Question:** Based on developments in 2026 so far, what AI-related threats should CISOs and security leaders prioritise over the next 18 months, and why?

**Mode:** grounded | 12 sources | agentic (9) + LLM (2) + traditional (1) | moderate confidence

**What's good:**
- No longer falls to general mode — the CISO strategy question is now grounded. The planner fix worked
- No internal analytics anywhere
- Cross-category retrieval is working: 9 agentic + 2 LLM + 1 traditional sources retrieved, giving the answer appropriate breadth
- The automated prompt injection via reinforcement learning (AutoInject) finding is new and genuinely alarming: attacks that transfer across GPT-4/5/Claude/Gemini and defeat fine-tuned defences. This is the right signal for a "what to prioritise" question
- ADI (Agent Data Injection via resource identifiers and file metadata) is flagged as a second-generation attack designed to evade current defences — forward-looking and relevant

**Issues:**
- Hugging Face typosquatting claim (point 4) is QA-flagged as not clearly confirmed. It's single-sourced from a source that may not actually contain the "trending on the platform" detail
- The five points are of unequal weight: points 1, 2, and 3 are the prioritisation; points 4 and 5 are supporting evidence. The structure blurs this — ideally a CISO priority list would rank the five threats explicitly rather than presenting them as co-equal numbered points
- Confidence is moderate, which is appropriate — but the answer doesn't explain *why* moderate (it's because prevalence data is absent, which only appears in the caveat)

---

### Q5 — Evidence and Citation Quality / 3 Academic Papers (5/10)

**Question:** Provide a comparison of the top three papers published in the past year on agent-mediated deception or multi-agent manipulation attacks.

**Mode:** grounded | 12 sources | all agentic_ai_threats | confidence=low

**The honest disclosure is correct but the retrieval failure is not:**
The answer correctly says "no three distinct peer-reviewed publications were present in the source base." This is good epistemic behaviour. But from the DB audit, the relevant research papers **are** in the corpus and **do** have evidence extracted:

- **SPADE-Bench** (arXiv, grounded high-specificity evidence): evaluates spontaneous strategic deception by agents — plan-action divergence, agents declaring one plan while executing another. This is exactly "agent-mediated deception"
- **ShareLock** (arXiv, grounded): multi-tool threshold poisoning using Shamir's secret sharing across tool descriptions
- **ObliInjection** (mentioned in QA report as NDSS 2026 paper): injection regardless of data arrival order
- **SkillCamo** (mentioned in QA): agent skill camouflage techniques
- **AI-Infra-Guard** (arXiv): unified framework for multi-agent security auditing

These exist as evidence rows. The query planner generated terms like "agent manipulation," "deception attacks," "multi-agent" which didn't match the paper titles. The papers are indexed under their attack technique tags (ASI01\_agent\_goal\_hijack, ASI02\_tool\_misuse) rather than under "agent-mediated deception" as a phrase.

What the answer actually used instead — PROMPTSPY (Android malware), Meta chatbot account seizure, MCP exploitation — are incident reports and operator advisories, not research papers. The answer correctly labels these as "not academic papers" but doesn't explain that the actual papers exist in the corpus and simply weren't retrieved.

The answer's three case studies are actually well-chosen as operational findings. But the question asked for papers, and the system should have been able to find them.

**Root cause:** "Agent-mediated deception" and "multi-agent manipulation" are not the terminology this corpus uses. The papers are tagged as ASI01 (agent goal hijacking) and ASI02 (tool misuse exploitation). The planner needs to translate "agent-mediated deception" → ["agent goal hijacking", "tool poisoning", "strategic deception", "SPADE", "agent manipulation"] to find them.

---

### Q6 — Adversarial / Is Prompt Injection Solvable? (9/10)

**Question:** Is prompt injection fundamentally solvable? Compare positions of frontier labs, academic work, and security researchers.

**Mode:** grounded | 12 sources | agentic (9) + LLM (3) | high confidence

**Best answer in the stress test.** Clear thesis, evidence-led, honestly represents the disagreement structure.

**What's good:**
- The AutoInject finding (RL-generated attacks transferring across GPT-4/5, Claude, Gemini, defeating fine-tuned defences) is the strongest academic anchor and used correctly: "you cannot train your way out of a problem where the attack surface is the model's core function"
- Point 4 ("security researchers and industry are converging on 'contain and isolate,' not 'solve'") is the right characterisation of where the field actually is, drawn from multiple sources
- Correctly notes that frontier labs have no public claim that prompt injection is solved
- The Gaslight finding (attackers targeting the AI analyst rather than the sandbox) is the most novel operational data point and used well to show the attack surface is *growing*
- The Morse code encoding to bypass text filters (point 2) shows attacker iteration against current mitigations — relevant to "is it solvable?"

**Issues:**
- The 90 orgs / $175k appears again (point 2). Still single-sourced, still zero evidence rows in DB. The hedging is present but given how many times this appears, the synthesis model should be more aggressive about not repeating unverifiable figures
- BioShocking appears (point 4, "AI browser guardrails bypassed") — this is the fourth time this case appears across different questions. It's being over-relied upon
- The "frontier labs have no publicly documented position" point is true but thin — it would be stronger if it cited specific lab safety card language or a research statement rather than arguing from absence

---

## Cross-Cutting Issues

### What the retrieval fixes improved

Comparing this run to the 25-question test:
- **Publisher diversity**: dramatically better. No answer is dominated by CrowdStrike + Unit42 + CAS anymore. Zscaler, Innovaiden, SentinelOne, arxiv.org, Security Affairs, BleepingComputer all appear
- **Internal analytics leak**: zero instances across all 6 answers. Fix worked cleanly
- **CISO strategy (Q4)**: now grounded with good sources. Was completely useless (generic fallback) in the previous run
- **MCP analogy scope fix (Q22 equivalent)**: would now work — demonstrated with the separate Q22 smoke test

### What still needs fixing

**1. The "38% contamination" problem in the evidence table**

Check Point Research's weekly threat digests are being ingested as agentic AI threat sources and contributing ~140 evidence rows about generic breaches (Air France, Bouygues Telecom, etc.). These crowd out relevant evidence. The source-level category assignment is probably correct for the source as a whole (it covers agentic AI threats among other things), but the individual evidence items pulled from weekly digests are mostly off-topic for the assigned category.

**2. 79% of agentic AI sources have no evidence extracted**

claim_extraction_status=success for 489/500 but 396 have no evidence rows. The best sources (OWASP Top 10 Agentic 2026, VulnerableMCP.info, "GitHub AI agent leaks private repos," "Hidden Web Prompts Trick Agents Into Sending Money") are known to the chatbot only through their 400-char summary. The extraction pipeline is running but not writing evidence. This is likely a silent error in the extraction step — worth investigating whether the LLM call is returning empty arrays or whether the write is failing.

**3. Key named incidents aren't being retrieved for incident-specific questions**

The DB has: s1ngularity (crypto wallet theft), first malicious MCP server, Agentjacking, GuardFall. These don't surface for Q3 because the search terms don't include the incident names. The query planner for an incident retrieval question should generate the incident names themselves as search terms when asking "have there been real-world incidents." This requires the planner to have awareness of known named incidents, or the evidence table to be more richly tagged with incident identifiers.

**4. Research paper retrieval fails for conceptual queries**

Q5 (3 papers on agent-mediated deception) couldn't find SPADE-Bench, ObliInjection, or ShareLock despite all being in the corpus, because the planner generates natural-language topic terms that don't match the papers' coded taxonomy tags (ASI01, ASI02). For academic retrieval questions, the planner should translate the conceptual query into taxonomy tags AND paper-title keywords, not just thematic terms.

**5. Recurring single-source numbers persist despite hedging**

The "90 organisations," "$175k," and "85.2%" figures have zero evidence rows in the DB. They exist in source summaries, which means the synthesis model can see them in the 400-char truncation but can't verify them against actual evidence. The verifier passes them because they appear in the provided text. The fix would be to exclude figures from source summaries unless they have a corresponding grounded evidence row — or at minimum, add a synthesis prompt instruction to treat numbers appearing only in summaries (not in evidence rows) as unverified.

---

## Priority Fixes

Ranked by impact:

| # | Fix | What it addresses |
|---|---|---|
| 1 | **Investigate silent evidence extraction failure** | 79% of agentic sources have no evidence rows despite extraction marked success. Check the pipeline for empty-array writes. Possibly re-run extraction on the 396 empty sources. | 
| 2 | **Retag or filter generic breach evidence from agentic AI category** | 141 evidence rows (38%) in agentic_ai_threats don't mention AI. Filter `getEvidence` to only return rows where `fact` or `quote` contains at least one of: agent, MCP, copilot, prompt injection, LLM, agentic, coding assistant, model context. |
| 3 | **Add incident-name terms to planner for incident retrieval questions** | When the query includes "real-world incidents," "attack cases," or "examples," the planner should include known named incidents as search terms (AutoJack, Agentjacking, GuardFall, s1ngularity, Gaslight, GitLost). |
| 4 | **Add taxonomy tag translation for conceptual/academic queries** | When query mentions "agent deception," "multi-agent manipulation," "spontaneous deception," planner should emit tags: `ASI01_agent_goal_hijack`, `ASI02_tool_misuse_exploitation`, `ASI06_memory_context_poisoning`. |
| 5 | **Add synthesis prompt rule: numbers from summaries only are unverified** | If a statistic appears in the source context but has no corresponding evidence row, the model should label it "(appears in source summary only — not independently verified)" rather than treating it as a confirmed finding. |
| 6 | **Ban markdown bold/italic in synthesis prompt** | The current grounded prompt says "No markdown headers, no bold-everything" but Q2 used `**agentic AI threats**`. Tighten to: "No asterisks, no underscores for emphasis. Plain text only." |
