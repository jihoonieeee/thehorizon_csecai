# Chatbot Answer Audit — 25 Questions

_Deep audit of answer quality, formatting, insight, and accuracy. Tested 2026-07-12._

---

## Overall Verdict

The system performs well on specific, corpus-grounded retrieval questions and produces genuinely analyst-grade output at its best (Q4, Q9, Q15, Q21, Q25). It fails meaningfully on three questions (Q17 blocked, Q20 generic fallback, Q22 wrong classification), and has several recurring structural problems that affect readability and credibility across the full set.

**Score by category:**

| Category | Score | Notes |
|---|---|---|
| Traditional AI / ML (Q1–4) | 7.5/10 | Strong on adversarial ML; weaker on fraud/CV specifics |
| LLM Threats (Q5–8) | 7/10 | Q8 is a retrieval failure; rest are solid |
| Agentic AI (Q9–14) | 7.5/10 | Q9 and Q10 are excellent; internal metrics surface in answers |
| AI-Enabled (Q15–17) | 5.5/10 | Q15 is best in test; Q16 thin; Q17 blocked |
| Cross-category (Q18–20) | 6/10 | Q18 good; Q19 good; Q20 is entirely useless |
| Hard mode (Q21–25) | 7/10 | Q21 and Q25 are excellent; Q22 completely fails |

---

## Structural Issues (Apply to Most Answers)

### 1. The "Assessment:" prefix is robotic

Every answer opens with `Assessment:` followed by a summary paragraph. This is internal terminology leaking into the user-facing output. A real analyst briefing doesn't announce its own genre. The paragraph is often good — it just shouldn't be labelled.

**Fix:** Drop the `Assessment:` label. Start with the content.

---

### 2. The "Defenders:" coda is formulaic and repetitive

Every single answer ends with a `Defenders:` recommendation. By Q5, most of them say essentially the same thing: "treat all external inputs as untrusted." This appears verbatim or in close paraphrase in Q5, Q6, Q7, Q8, Q10, Q11, Q12, Q13, Q14. Reading 25 answers sequentially, the recommendation feels copy-pasted.

Some recommendations are genuinely specific and useful (Q2's "audit for distributed, low-volume query patterns across multiple accounts" is sharp). Most are not.

**Fix:** Only include a `Defenders:` coda when it says something *specific* to this answer that isn't implied by the general "treat inputs as untrusted" principle. Cut generic ones.

---

### 3. The same 3–4 numbers appear in 10+ different answers

The following figures appear repeatedly across the full test:
- "90 organisations" (CrowdStrike) — Q5, Q6, Q7, Q8, Q11, Q13, Q14, Q19, Q21
- "8,600 successful IPI attacks" (Center for AI Safety) — Q5, Q7, Q14, Q21
- "$175,000 loss" (CryptoBriefing) — Q11, Q12, Q13, Q19, Q24
- "85.2% of attacks use social engineering frames" (Unit 42) — Q5, Q6, Q7, Q8, Q14, Q21

Each time, these numbers are correctly hedged as single-sourced. But hedging 9 times doesn't fix the underlying problem: the same 3 sources are being stretched across many answers because the query planner keeps retrieving them as relevant. For a user who asks multiple questions in a session, the repetition is obvious and erodes trust — it makes the corpus look thin when it isn't.

**Fix:** Query planner or context builder should detect when a source has already been cited in the session and deprioritise reusing it. Or, consolidate these into a "known-uncertain figures" reference block shown once.

---

### 4. Internal analytics are surfaced as evidence of real-world threat activity

Several answers cite internal corpus metrics as if they're intelligence:
- Q11: "The trend data (34 source references per week versus a baseline of 21)" — cited as evidence the attack surface is expanding
- Q12: "Source volume on agentic AI threats has risen to 34 incidents per week against a baseline of 21" — appears in the answer body
- Q15: "Reporting on AI-enabled threats is running at 18.5 sources per week against a baseline of 10.7"
- Q16: "Weekly source volume on AI-enabled threats has risen from a baseline of roughly 11 reports per week to nearly 19" — attributed to src-1 (which is a single phishing campaign article, not a publication trend source)

These are corpus publication rate metrics, not threat activity metrics. They measure "how much is being written about this" not "how much is actually happening." Presenting them as evidence of threat escalation is misleading, and attributing one of them to a specific source that doesn't contain the data is a factual error.

**Fix:** Remove internal analytics from answer bodies entirely, or clearly label them as "source volume signal, not incident count."

---

### 5. Jargon explanations are inconsistently applied and sometimes condescending

Some parenthetical explanations are excellent — "TEE (Trusted Execution Environment, a secure hardware compartment meant to be tamper-proof)" in Q2 is exactly right for a non-specialist. But some over-explain concepts that a security professional asking these questions would know:
- Q1: "(techniques that trick AI into making wrong decisions by feeding it carefully crafted inputs)" after "adversarial attacks"
- Q9: "(a software program that plans and acts without human guidance)" after "autonomous AI agent"
- Q14: "(where the malicious instruction hides in external content the AI reads, not in a direct user message)" appended to IPI in an answer *about* IPI

If the intended audience is cybersecurity professionals, trim these. If it includes non-technical executives, keep them but apply them consistently, not randomly.

---

### 6. Answer length is inconsistent with no clear principle

Q1: ~700 words. Q4: ~650 words. Q8: ~400 words. Q16: ~230 words. Q22: ~50 words.

Some of this variation is appropriate (Q16 genuinely has less to say). But Q8 is short because of a retrieval failure, and Q1/Q4 are long partly because the 5-bullet structure forces padding even when fewer points would be more precise.

---

## Question-by-Question Audit

---

### Q1 — Adversarial ML developments (8/10)

**Strengths:** One of the best-structured answers. The drift-monitoring evasion point (attackers simultaneously evading the detector AND the monitor that watches for drift) is a genuinely sharp insight that most security summaries miss. The "transferable attacks mean model opacity is no longer a sufficient defense" conclusion is crisp and accurate. Appropriate hedging on the 98.35% figure.

**Issues:**
- Point 3 (prompt structure vulnerability) is useful but feels slightly misplaced — it's really an LLM threat, not an adversarial ML threat in the traditional sense. A question about adversarial ML over the past 12 months is more naturally answered by the first two points.
- Point 5 (quantum defenses) is correctly flagged as irrelevant but still takes a full bullet. One sentence would suffice.
- The QA system flagged the 26% improvement figure for vulnerability scanners and the 85.5% audio success rate as not clearly confirmed by cited sources. The answer presents both as settled facts rather than flagging them alongside other hedged figures.

---

### Q2 — Model extraction attacks (7/10)

**Strengths:** Excellent epistemic discipline. Opens by stating no confirmed production incidents exist, then provides useful research context. The "Single Client Assumption" breakdown of PRADA is genuinely insightful and specific.

**Issues:**
- The "LoMime combining extraction with membership inference" point (point 4) is the most novel finding here but is buried as point 4. It deserves more prominence — extraction + privacy inference is a qualitatively different threat than extraction alone.
- The TEE attack (point 5) being noted "but this is a single research finding, not a confirmed real-world attack" is correct discipline — but if you're going to caveat it that heavily, it's adding noise rather than signal. Cut it or expand it.
- The QA system flagged "AttackPilot achieving 100% task completion against 20 services" as not clearly confirmed by the source excerpt. This specific figure is doing a lot of rhetorical work in the answer.

---

### Q3 — Bypassing AI fraud detection / computer vision (6/10)

**Strengths:** Honest about the gap — no confirmed fraud system bypass in the corpus. The fraud-applicable framing of feature-based evasion (if you know which features the model weights, you can mask them) is a valid analytical bridge even without direct evidence.

**Issues:**
- Point 3 claims "Voice-based identity verification for fraud prevention is directly in scope of this risk" — this is a significant analytical leap not supported by any source, and the QA verifier flagged it. The audio attacks described are against "audio LLMs" and "audio AI systems," not fraud detection specifically. This kind of assertion is the thing that erodes analyst credibility.
- Point 5 cites "publication rate on traditional AI threats is actually below baseline (2.5 per week versus a 5.2 baseline)" — this is internal corpus analytics cited as evidence, then attributed to the verifier, not a source. Factually this shouldn't be in an analyst answer at all.
- The answer structure (5 points, including a "here's what we don't have" section as point 5) is fine but leaves the reader feeling the answer didn't really land on the question asked.

---

### Q4 — RAG and vector database security risks (9/10)

**Best answer in the Traditional AI category.** The poisoning threshold figures (1.6% knowledge base corruption; 0.05% code injection) are striking and concrete. The distinction between retrieval-layer attacks and document-content attacks is analytically sharp. The "sleeper cell" technique activating only under specific conditions is a genuinely unsettling finding that the answer explains well.

**Minor issues:**
- The five ADMIT / multi-agent / 31.4% figures were all flagged by the verifier as not clearly confirmed — three out of five major specific statistics in point 1/3/4. The answer's overall argument holds without them, but they're doing a lot of the persuasive work.
- Point 5 (membership inference / privacy) is a slightly different threat class than the other four points. It's valid but feels like a fifth point added to round out the structure rather than because it fits naturally.

---

### Q5 — Indirect prompt injection evolution (8/10)

**Strengths:** The best "evolution" framing in the test set. The pivot from "users as victims" to "defenders' AI tools as victims" (point 2, Gaslight) is correctly identified as the defining escalation. Progent, RETA, and the RAG layered defense numbers give the defense section concrete texture.

**Issues:**
- Point 5 (tooling and techniques maturing simultaneously) is the weakest — it's an observation about the research field, not an evolution of the threat, and it partially duplicates what point 1 already says.
- "Group-chat injection worked against every model tested" is a strong claim; the LivePI benchmark citation supports it but the answer doesn't caveat this like the other single-sourced figures.
- The defenders' Progent recommendation ("test your AI triage tools against injection payloads using IPI-proxy") is actually good and specific — but it's buried at the end after a lot of boilerplate.

---

### Q6 — Prompt injection incidents affecting coding assistants (7/10)

**Strengths:** The two named incidents (GitHub Copilot filesystem escape; Claude Code CI/CD secrets) are the right anchors. The supply-chain framing for the CI/CD incident ("threatens the integrity of every software release that passes through that pipeline") is sharp.

**Issues:**
- Point 4 (LLMs cannot distinguish trusted instructions from untrusted text) is root-cause analysis, not an incident. The question asked for incidents. This section would fit Q7 (jailbreak mechanisms) or Q14 (reasoning-chain hijacking) better than here.
- Point 5 (Gaslight) is completely out of scope for a question about coding assistants. It's a macOS backdoor targeting security analysts — not a coding assistant incident.
- The answer actually has 2 good concrete incidents and then pads to 5 by pulling from adjacent topics. It would be tighter and more honest as a 2-point answer with more depth on each incident.

---

### Q7 — Are jailbreaks still relevant? (8/10)

**Strengths:** The reframing ("not superseded, absorbed into something more dangerous") is exactly right and stated cleanly in the opening paragraph. The Gaslight confirmation across three independent sources is appropriately flagged as the most significant shift.

**Issues:**
- Point 5 (GuardNet AUROC 0.747 at 50 milliseconds) is a statistical detail dropped into an otherwise strategic analytical answer. AUROC without context is meaningless to most readers; 50ms performance is a nice spec but irrelevant to "are jailbreaks still relevant." Cut this or integrate it into a broader point about detection tools being immature.
- The QA system flagged 4 claims in this answer — more than any other answer in the set. The CrowdStrike "90 confirmed organizations" figure is the most problematic because the underlying source apparently says "at scale" without the specific number. This matters: stating 90 is different from stating "at scale."

---

### Q8 — Images and multimodal inputs bypassing LLM guardrails (4/10)

**The most significant content failure in the test set** — not because of the system's honesty (it correctly discloses the gap), but because the content it falls back on is almost entirely a repeat of Q5/Q6/Q7. The four sections of text-injection bypass material cover the same Gaslight / Copilot / BioShocking material already covered in those answers.

**The real problem is a retrieval failure.** The corpus contains directly relevant multimodal adversarial research (FRA-Attack against multimodal AI, codec-robust audio attacks, discrete image tokenizer attacks) — all of which appeared in Q1's answer. None of it surfaced here. A user asking this question deserves to know about FRA-Attack; it's literally about "images to bypass AI systems."

**Root cause:** The query planner retrieved LLM Threats sources (because "LLM guardrails" triggered that category) rather than Traditional AI Threats sources (where the multimodal adversarial research lives). The category boundary is wrong here — multimodal bypass sits at the intersection of both.

---

### Q9 — MCP security risks (9/10)

**Best-structured answer in the Agentic AI category.** Using horizontal rules between sections (unique to this answer) actually aids readability for a multi-part technical question — each section has a topic sentence that contextualizes the bullets before they appear. The CVE specifics with version numbers add credibility you don't see in most other answers. "MCP is on the same trajectory as cloud APIs in the early 2010s" is the sharpest one-liner in the full test set.

**Issues:**
- The horizontal rule formatting is inconsistent with every other answer. Either apply it everywhere or nowhere.
- Point 5 (gateway misconfigurations) is the weakest section — "medium trust; treat the specific target categories as illustrative rather than confirmed" is doing a lot of hedging work. If it needs that much caveating, it's probably not earning its place.
- The ShareLock 90%+ figure is correctly hedged, but the Shamir's secret sharing explanation in parentheses ("splitting a secret so no single piece is recognizable") is technically inaccurate as a description of how the attack works. It's used for detection evasion, not secret-splitting in the cryptographic sense.

---

### Q10 — How malicious webpage steals local credentials (8/10)

**Strengths:** The two-path structure (IPI vs AutoJack RCE) is correct and well-explained. The JSON-LD insight (attackers hide instructions in structured metadata invisible in normal page view) is the kind of specific operational detail that makes an answer genuinely useful.

**Issues:**
- Point 4 ("State-sponsored actors have shifted from data theft to mission sabotage via the same injection path") is the right insight but it's in the wrong answer. The question asks about a specific attack mechanism (credential theft from a webpage). State-sponsored sabotage objectives are a tangent that should appear in Q11 or Q19.
- Point 5 (Claude shared-chat abuse, coding agents fed malicious setup scripts) is correctly flagged as "lower-confidence path" but both claims were QA-flagged as not clearly supported by the cited sources. If they're both questionable and already acknowledged as lower-confidence, they shouldn't be in the answer.

---

### Q11 — Why agentic systems vulnerable to supply chain attacks (7/10)

**Strengths:** The "agent's supply chain is not just software packages; it includes every piece of text the agent reads to decide what to do next" framing is the sharpest conceptual point in the answer and should probably come first.

**Issues:**
- Point 2 has no source citations at all ("Attackers now craft malware specifically to exploit the gap where AI coding assistants generate and install code packages..."). This is an assertion without evidence in an otherwise well-cited answer.
- Point 5 (Claude shared-chat, Gemini voice assistant) is platform abuse / social engineering, not supply chain vulnerability. The Gemini voice assistant being "manipulated via injected notifications" is even further from supply chain. These shouldn't be here.
- Internal analytics ("34 source references per week versus a baseline of 21") cited in the opening assessment as evidence the attack surface is expanding — this is the internal corpus metric problem described above.

---

### Q12 — Amazon Q incident and coding agent trust model (7/10)

**Strengths:** Correct and transparent handling of the named incident gap. Pivoting to the broader pattern is the right call. The "trust model must now extend to every tool it can call, every description it reads, and every output it receives — all of which are currently treated as trusted" conclusion is precise and analytically correct.

**Issues:**
- "Source volume on agentic AI threats has risen to 34 incidents per week against a baseline of 21" appears in the answer body as supporting evidence. This is an internal metric, not a threat intelligence finding. It conflates publication rates with incident rates.
- The $175,000 figure appears here for at least the third time across the test set, again with hedging. By this point, a user reading sequentially has seen this single data point 3 times and the repeated hedging doesn't help — it highlights how thin the financial impact evidence is.
- CVE-2026-39987 (Marimo) appears here and was QA-flagged as not found in the retrieved sources. It shouldn't be cited if it can't be verified.

---

### Q13 — New attack classes vs reintroducing old ones (8/10)

**Strengths:** The thesis ("recycled techniques, new execution context") is correct and well-argued. Point 4 on visual spoofing for mobile agents genuinely earns the "new" category — the attack surface (divergence between human and machine vision on a shared device screen) is a valid novelty argument.

**Issues:**
- Confidence is listed as `low` in metadata but this isn't clearly communicated in the answer text. A user reading without the metadata block won't know the system had low confidence here.
- Point 5 (agents as post-exploitation delivery layer) is the strongest insight — the idea that defenders face AI agents as both victim *and* vector in the same incident chain — but it's buried as point 5. This should be the answer's conclusion, not an afterthought.
- The Marimo CVE-2026-39987 appears here again (was already QA-flagged in Q12).

---

### Q14 — Reasoning-chain hijacking vs traditional prompt injection (6/10)

**The conceptual distinction is correct but never clearly stated.** The key difference — that classic IPI makes the AI *do* the wrong thing, while reasoning-chain hijacking makes the AI *conclude* the wrong thing — is stated once in point 1 but then the answer moves into general IPI statistics for three sections. A reader who came specifically to understand "reasoning-chain hijacking" as a distinct term doesn't get a clear, memorable definition.

**Issues:**
- The term "reasoning-chain hijacking" should be defined and explained at the top. Instead, the answer immediately starts contrasting it with classic prompt injection before the user knows what it is.
- Points 2–4 are largely generic IPI statistics (8,600 attacks, 85.2%, 90 organisations) that have appeared in Q5, Q6, Q7, Q8. They pad the answer without advancing the conceptual point.
- Point 3's audio attack angle (AudioHijack achieving 79–96% success) is inserted as "this shows the attack surface extends to any reasoning modality" — but audio adversarial attacks are a different mechanism than reasoning-chain hijacking. The connection is asserted, not demonstrated.
- The QA system flagged 3 claims, including the "32% rise in injected instructions" figure which was attributed to a crawl study — plausible, but the source is apparently not confirmed in the retrieved excerpt.

---

### Q15 — Threat actors operationalising frontier AI models (9/10)

**Best-evidenced answer in the test set.** Named actors (Coral Sleet, APT27), named tools (FraudGPT, WormGPT, Xanthorox), named malware families (CANFAIL, LONGSTREAM, PROMPTFLUX), named primary-trust sources (Google, Microsoft, Rapid7). This is what the platform should look like at full capability.

**Minor issues:**
- Point 5 uses internal analytics ("18.5 sources per week against 10.7 baseline") as supporting evidence. Same problem as noted elsewhere — this is corpus volume, not threat activity.
- "The Hacker News and Google separately confirmed this as the first publicly disclosed case of a zero-day 2FA bypass developed with AI assistance" — this is a strong factual claim and the QA system flagged it as not clearly confirmed by cited sources. The "first publicly disclosed" framing in particular is hard to verify.

---

### Q16 — AI-enabled phishing changes over the past year (5/10)

**Honest but unsatisfying.** The system correctly discloses it only has one source. The Montana Empire domain-hallucination finding is genuine. But the question asked about "changes over the past year" and one incident doesn't answer that scope.

**Issues:**
- The answer should have redirected to related material that *is* in the corpus — Q15 covers AI-generated phishing lures extensively (AI used to "generate convincing phishing lures" before writing attack code, FraudGPT/WormGPT sold for phishing). This material is directly relevant to AI-enabled phishing evolution and was apparently not retrieved.
- Point 2 cites the "weekly source volume rising from 11 to 19" as supporting evidence, attributed to src-1 (the Montana Empire article). The Montana Empire article is not a publication trend report. This is a factual attribution error.
- "The barrier to running a high-volume, high-quality phishing campaign just dropped" is a good one-liner but is asserted without evidence from the answer's own limited corpus.

---

### Q17 — Malware targeting AI systems (1/10 — Blocked)

**The fallback message is unhelpful.** "I can't give a reliable answer to this from the current corpus. The automated quality check flagged: Referenced CVE(s) not found in any retrieved source: CVE-2025-10156, CVE-2025-10157. Try rephrasing or narrowing the question so the answer can be grounded in verified sources."

This tells the user nothing useful. The QA block is correct — unverified CVEs should not be cited — but the system knows a lot about malware targeting AI systems from other questions in this test:
- LiteLLM backdoor (Q18): 119,000 downloads of backdoored versions
- Hugging Face supply chain attack (Q18): fake repository distributing credential stealers
- ShadowLogic model graph backdoors (Q25): persist through fine-tuning, invisible to validation
- Malicious AI agent skills (Q18): 76 confirmed malicious payloads in 3,869 scanned skills

**Fix:** When QA blocks an answer, the fallback should not be a bare error message. It should say "the specific claims couldn't be verified, but from our corpus here's what we do know about this topic" and redirect to what IS available.

---

### Q18 — Biggest change in AI threat landscape (8/10)

**Strengths:** The thesis (AI moved from tool attackers *use* to component *inside* attack infrastructure) is exactly the right framing for this question. The PROMPTFLUX/PROMPTSTEAL/PROMPTLOCK/FRUITSHELL finding is specific and striking — self-modifying malware calling live AI APIs during execution to regenerate itself. The LiteLLM backdoor (119,000 downloads) is a concrete, credible example of supply chain risk at scale.

**Issues:**
- The answer is trying to be both the "biggest change" answer and a comprehensive survey. These are different things. The question asked for *the* biggest change, which should produce a hierarchy. Instead it produces 5 roughly equal points.
- Internal analytics again: "agentic AI threat reporting has increased from a baseline of 21 reports per week to 34" in the answer body.
- The 200,000 MCP server figure is correctly flagged as coming from a single medium-trust source, but then it still appears in a prominently placed bullet. If it's that uncertain, cut it.

---

### Q19 — Entirely new attack techniques with no traditional equivalent (8/10)

**Strengths:** Correctly identifies Gaslight as the genuinely novel category — not just a new delivery mechanism, but a qualitatively different threat (AI tools weaponised against the people using them). The $175k cryptocurrency loss example is concrete. The "GitLost" permission leakage example is well-explained.

**Issues:**
- Point 3 (GitLost: AI coding assistant leaking private repos) is a traditional access control problem dressed in AI clothing. The AI agent had legitimate access to the repos and was tricked into sharing them — this is insider threat / privilege misuse, not an attack class with "no traditional cybersecurity equivalent." The framing is slightly overstated.
- Point 4 (supply chain attack through documentation) is real and novel but the explanation — "plain text that only the AI layer reads" — undersells why it's novel. Traditional scanners look at code paths; this attack exploits the semantic layer that code scanners don't see.

---

### Q20 — CISO risk priorities over next 2 years (2/10)

**Worst answer in the test set from a utility standpoint.** The corpus contains rich material that could ground a specific, corpus-evidenced CISO recommendation:
- LiteLLM supply chain attack → immediately audit AI package dependencies
- MCP risks → agent permission model needs a least-privilege audit
- Gaslight → AI-based security triage is now an attack surface
- AI coding agent CI/CD compromise → pipeline integrity needs separate authentication

Instead the answer delivers 5 generic principles any LLM could produce without accessing the corpus at all. The intent classifier should recognise a strategy question as a synthesis task over the corpus, not a general knowledge question.

---

### Q21 — Is prompt injection fundamentally different from phishing? (9/10)

**Best analytical answer in the hard-mode set.** The core argument (same manipulation logic, different victim type and blast radius) is correct and well-constructed. The progression from "same social engineering" → "AI victim acts immediately without suspicion" → "IPI now targets defenders" → "audio vector closes the channel-specific escape" is coherent and builds. "Phishing's successor in an AI-automated world" is the sharpest one-liner in the full test set.

**Minor issues:**
- Four separate QA flags on this answer, mostly around the recurring CrowdStrike/Unit 42 figures. The hedging is present but the number of flagged claims suggests the answer is leaning heavily on sources that are less confirmed than presented.
- The "automated IPI tooling outperforms gradient-based approaches for black-box targets" point (point 5) is genuinely informative but in the context of a conceptual comparison question it feels like technical filler. Cut it or move the insight higher up.

---

### Q22 — MCP: more like an API, software package, or employee? (0/10 — Wrong classification)

**The most significant failure in the test.** The system replied: *"I focus on AI threat intelligence — LLM and agentic-AI threats, adversarial ML, AI-enabled attacks, and related vulnerabilities and incidents. Ask me something in that area and I'll dig into the corpus."*

This is wrong on two levels:
1. **Domain error:** MCP is among the most extensively covered topics in the corpus. The out-of-scope classifier fired on the *framing* of the question (analogy/reasoning) rather than the *topic* (MCP, which is central to the platform).
2. **Expected answer missed:** The question has a conceptually important answer — "all three, depending on the context" — that explains the unusual security risk surface of MCP better than any list of CVEs does:
   - **Like an API:** exposes structured function calls, accepts/returns typed data, can be versioned
   - **Like a software package:** installed into the local environment, executes code with ambient permissions, can be supply-chain compromised
   - **Like an employee:** granted trust and credentials, acts on delegated authority, and can be socially engineered through the instructions it reads

This three-way framing explains *why* MCP is hard to secure: its risk surface doesn't map cleanly to any existing security model. It's the most conceptually valuable question in the hard-mode set, and the system completely deflected it.

---

### Q23 — Why does agentic AI violate traditional cybersecurity assumptions? (8/10)

**Strengths:** The opening framing ("a compromised component stays compromised in one place — agents violate this") is the right conceptual hook. The five points are distinct and well-sequenced: autonomous reach → data inputs as attack surface → permissions designed for humans → misbehaviour looks normal → no mature constraints.

**Issues:**
- Point 5 ("No mature technical standard yet constrains what agents are allowed to do") is true but doesn't answer *why* agentic AI violates cybersecurity assumptions — it's a consequence, not a cause. It feels like a fifth point added to fill the structure.
- The Semantic Norm Drift attack (point 2) is a strong, underused finding — poisoning shared agent memory so defenders mistake the behaviour for a software bug. It deserves more explanation than it gets.
- "The first documented autonomous ransomware case" appears without a source attribution in the main body.

---

### Q24 — What do Gaslight, AutoJack, MCP poisoning and AMD have in common? (7/10)

**Gets the mechanism right but misses the conceptual synthesis.** The answer correctly identifies all four as variants of prompt injection with different entry points. But the expected answer — "they attack decision-making rather than software execution" — is the framing that makes the question analytically interesting.

Traditional attacks exploit flaws in code: buffer overflows, SQL injection, deserialization bugs. These four techniques exploit the AI's *reasoning process* — they don't need a code bug; they need the AI to read something and decide to act on it. This is what makes them genuinely novel: the vulnerability is semantic, not syntactic.

The answer is not wrong, but "they're all prompt injection with different delivery methods" is a less insightful answer than "they attack the layer of the stack where decisions are made, not where code executes."

**Also:** "Gaslight" and "Agent-Mediated Deception" being supported by only one source each (as noted in the caveat) is fine, but the answer spends a lot of space on specifying their technical differentiation when the caveat admits that differentiation can't be confirmed.

---

### Q25 — AI security: converging towards or diverging from traditional cybersecurity? (9/10)

**Best overall answer in the test set.** The thesis — "convergence with escalation" — avoids the two obvious wrong answers ("it's the same old thing" vs "it's completely novel") and makes a specific, defensible claim. The evidence selection is excellent:

- LiteLLM/Hugging Face as traditional supply chain attacks on new infrastructure (**convergence**)
- ShadowLogic in model computational graphs as genuinely novel (**divergence**)
- OpenAI's safety model defeated by injecting into the evaluation prompt itself (**divergence** — the judge and accused are the same type of system)
- ChromaDB pre-authentication RCE at 13M downloads/month (**convergence** — no novel technique needed, just a network connection)

The caveat about Traditional AI Threats declining as a reporting category potentially reflecting reclassification (not actual decline) is a sophisticated analytical note that shows the system reasoning about its own evidence base.

**Minor issue:** Point 2 on "prompt injection spread virally through shared code templates" isn't well-explained. The OpenClaw example (workspace files overriding AI instructions) is interesting but the one-sentence treatment doesn't make clear why this is specifically a supply-chain amplification.

---

## Priority Fixes

Ranked by impact on answer quality:

1. **Q22 classification fix** — MCP analogy question must not be out-of-scope. The intent classifier needs to recognise conceptual/analytical questions about core platform topics. This is the most embarrassing failure.

2. **Q17 fallback improvement** — When QA blocks an answer, redirect to what the corpus *does* contain on the topic. A blocked answer should never leave the user with nothing useful.

3. **Q8 retrieval fix** — "Multimodal inputs to bypass LLM guardrails" must retrieve Traditional AI Threats sources (FRA-Attack, codec attacks, image tokenizer attacks), not only LLM Threats sources. The category boundary is wrong.

4. **Q20 intent fix** — A CISO strategy question is a synthesis task over the corpus, not a general knowledge question. The system should respond with corpus-grounded recommendations, not boilerplate.

5. **Remove internal analytics from answers** — "34 source references per week vs baseline of 21" is a corpus metric, not a threat intelligence finding. Never present it as evidence of real-world threat activity, and never attribute it to a specific article.

6. **Deduplicate recurring single-source numbers** — The 90 organisations / 8,600 IPI attacks / $175k triad are appearing in 8–10 different answers. Either consolidate (show once, reference elsewhere) or deprioritise these sources in retrieval once they've already been used.

7. **Cut the generic "Defenders:" coda** — When the recommendation is "treat all inputs as untrusted," it should not appear 12 times. Require the recommendation to be answer-specific.

8. **Q6 scope discipline** — Remove the structural root cause analysis (point 4) and the Gaslight point (point 5) from the coding assistant incidents answer. Replace with more depth on the two actual incidents, including patch status and exploitability assessment.

9. **Q14 definition** — "Reasoning-chain hijacking" should be clearly defined at the top of the answer before contrasting it with traditional prompt injection. Currently the contrast is drawn without the concept being established.

10. **Q24 synthesis** — Upgrade the answer to explicitly state "they attack decision-making rather than software execution." This is the insight that makes the question worth asking.
