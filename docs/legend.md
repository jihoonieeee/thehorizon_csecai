# Source Labels — Complete Reference

Every source in The Horizon carries multiple labels assigned at different pipeline stages. This document defines each label, its values, and how it is determined.

---

## 1. Reading Value

**Field:** `reading_value`  
**Set by:** Layer 3 unified LLM call (`lib/prompts/validation/layer3.md`), using the shared rubric in `lib/prompts/scoring/reading-value.md`  
**Question answered:** How much does this source change what a threat team knows or does?

Reading value is the primary editorial triage signal. It is independent of threat severity, maturity, and publisher prestige — a theoretical paper introducing a new attack surface may be `essential` while a confirmed in-the-wild CVE may be `informative`.

| Value | Definition | Examples |
|---|---|---|
| `essential` | Materially changes the strategic understanding of the threat landscape, or establishes a significant development not previously evidenced. | The first confirmed adversary use of a consequential AI capability; authoritative evidence of a new class of threat; a landmark framework likely to shape security practice; a multi-government advisory signalling a significant shift in strategic posture. |
| `recommended` | Materially changes prioritisation or understanding within an established threat area. | A significant technique variant supported by concrete evidence; first confirmed adversary adoption of a known technique; synthesis revealing a pattern across multiple incidents; a substantive case study demonstrating measurable impact. |
| `informative` | Provides substantive technical or operational value, but does not materially change strategic understanding or prioritisation. | Implementation mechanics; exploit details; incremental research on a well-understood technique; technical validation; a vulnerability advisory without evidence of exploitation. Practitioners typically benefit from the source directly, while leadership can rely on its key findings. |
| `background` | Provides contextual or supplementary information without materially adding to the current understanding of the threat. | Adjacent policy or guidance; general defensive advice; commentary without new evidence; derivative reporting; sources substantially duplicating stronger existing coverage. |

**The two dividing lines:**
- `recommended` vs `informative` is **materiality, not quality** — after reading it, would a threat team re-rank a risk, a mitigation, or a monitoring priority? If nothing gets re-ranked, it is `informative` however good it is.
- `essential` vs `recommended` is **scope** — `essential` moves the picture of the landscape; `recommended` sharpens the picture inside a threat area already on the map.

**Hard rules:**
- Thin body text (<~300 chars): capped at `informative` regardless of title language. The title is not evidence.
- Defensive-primary sources (vendor tooling docs, architecture guides, how-to hardening): `informative` or `background` even if they describe attacks as context.
- Research-only work (lab demo, no real-world exploitation) defaults to `informative`. It reaches `recommended` only when it demonstrates a significant technique variant with a working attack AND names a prioritisation consequence (lowers attack cost/skill, raises success rate or scale, defeats a relied-on mitigation, or extends a known attack to a boundary defenders treated as out of reach). Benchmarks, taxonomies, surveys, and efficiency refinements stay `informative`.
- `essential` has two independent branches: **(A)** first-of-kind or first-operational novelty that changes the threat model, or **(B)** the first credible public evidence of something the field could not previously evidence — the first confirmed adversary use of a consequential capability, a genuinely new threat class with a working demonstration, or a canonical framework / multi-government posture statement. Branch B does not require a new attack class.

### Worked examples and signals

Retained here for analyst calibration. These were previously shown in the dashboard's
"Threat Maturity & Reading Value Reference" panel and were removed from the UI to keep it
scannable; the definitions above remain the authoritative criteria.

| Value | Examples | Signals |
|---|---|---|
| `essential` | GTIG's first confirmed AI-generated zero-day in a real operation. A named state actor poisoning npm packages specifically so AI coding agents select them. OWASP LLM Top 10 initial release. Five Eyes statement on frontier AI cyber risk. | Confirms something the field considered theoretical; first credible public evidence of adversary use of a consequential capability; establishes a new attack class; landmark framework or multi-government advisory that reshapes strategic posture. |
| `recommended` | GTIG quarterly AI threat report with new adversary TTPs. CrowdStrike on the fourth observed AI-generated phishing campaign at scale. HiddenLayer HuggingFace malware incident. A paper demonstrating a technique variant that materially lowers attack cost. | New TTP variant backed by concrete evidence; further confirmed adoption of a capability already evidenced; named incident with measurable impact; shifts how you weight a known risk. |
| `informative` | Vulnerability advisory for a vLLM SSRF. arXiv paper with only an abstract available. Benchmark or taxonomy over a known attack class. Third journalist writeup of a known incident. | CVE or advisory with no exploitation evidence; implementation mechanics; 2nd or 3rd coverage of a known story; incremental research or evaluation work on a well-mapped technique. |
| `background` | Generic "AI threats are rising" editorial. AWS implementation guide for multi-tenant agents. Defensive IR playbook with no new offensive findings. | Defensive or hardening content only; policy/governance without offensive findings; generic editorial; adds nothing beyond what better sources already cover. |

---

## 2. Distribution Recommendation

**Field:** `distribution_recommendation` (object with three booleans)  
**Set by:** Layer 3 unified LLM call, derived from reading_value + content assessment  
**Question answered:** Which surfaces should actively promote this source?

| Flag | True when |
|---|---|
| `overview_dashboard` | `essential`, or `recommended` that is timely, not duplicate, and represents a distinct development in a major threat category during the current reporting window |
| `email_newsletter` | `essential` or `recommended` AND the finding is readable without engineering background AND actionable or awareness-raising for a non-specialist — never thin-text, defensive-primary, PoC mechanics, or academic benchmarks |
| `analyst_library` | Any `essential`, `recommended`, or `informative` source — all substantive sources go here |

---

## 3. Threat Maturity

**Field:** `intelligence.maturity_level`  
**Set by:** Deterministic at Layer 4 ingest; LLM-refined via `scripts/labelMaturityLevels.js`  
**Question answered:** How far along the threat lifecycle is this technique?

Ordered from least to most mature: `research` → `validated` → `observed` → `operational`.

| Level | Meaning | Typical source types |
|---|---|---|
| `research` | The threat, attack technique, or vulnerability has been identified or demonstrated primarily through research, simulation, benchmarks, or controlled laboratory testing. There is no credible evidence of practical exploitation outside a research setting or of adversary use in the wild. | `research_finding`, `benchmark_evaluation` |
| `validated` | The threat, vulnerability, or attack technique has been credibly confirmed to affect a real product, system, or implementation, or its practical feasibility has been demonstrated through a reproducible exploit, proof-of-concept, tool, or equivalent technical evidence. There is no credible evidence of adversary use in the wild. | `vulnerability`, `exploit_disclosure`, `capability_demonstration`, `governance_signal` |
| `observed` | Credible evidence confirms that the technique or exploit has been used against real-world targets outside controlled testing. At least one documented instance of attempted or successful exploitation by a threat actor has been established. | `incident`, `attack_surface_signal` |
| `operational` | The technique or exploit has progressed beyond isolated use and is being repeatedly, systematically, or at scale employed by one or more threat actors. Evidence indicates sustained adversary adoption, such as multiple incidents, an ongoing campaign, integration into operational tooling, or repeated use across targets. | `threat_intelligence`, `adversary_adoption_signal` |

**Classification rules:**
- A CVE → `validated`, with or without a public PoC. CVE + confirmed exploitation → `observed`.
- Paper tested against a live real product → `validated`. Controlled lab only → `research`.
- Single confirmed incident → `observed`. Sustained/repeated campaign → `operational`.

### Worked examples and signals

Retained here for analyst calibration. These were previously shown in the dashboard's
"Threat Maturity & Reading Value Reference" panel and were removed from the UI to keep it
scannable; the definitions above remain the authoritative criteria.

| Level | Examples | Signals |
|---|---|---|
| `research` | Prompt compression attack paper. Backdoor attack benchmark evaluation. | "we show that", "we demonstrate", academic/arXiv paper, red-team simulation, controlled experiment. |
| `validated` | CVE for prompt injection in LangChain, patched in 0.3.15, no exploit code. Wiz Research published working code showing symlink traversal against six real AI coding assistants. | CVE (with or without PoC), vendor advisory, "patched in version X", "responsibly disclosed", CISA/NIST/CERT advisory, PoC released, "we exploited [real product]". |
| `observed` | Prompt injection campaign targeting enterprise chatbots with confirmed credential theft. Malware found in a live Hugging Face repo actively harvesting credentials. | "exploited in the wild", incident report, confirmed breach, named victims, threat intelligence documenting adversary use. |
| `operational` | Nation-state group integrating AI-generated spear-phishing into standard tradecraft across multiple operations. Ransomware group using AI for payload generation across multiple campaigns. | "ongoing campaign", "attributed to [named group]", "multiple victims", threat intelligence spanning weeks or months, GTIG/CrowdStrike campaign reporting. |

---

## 4. Research Significance

**Field:** `intelligence.significance` (object: `level`, `novelty`, `opens_new_surface`, `transferability`, `reason`)  
**Set by:** LLM via `scripts/scoreResearchSignificance.js` (batch, research sources only)  
**Question answered:** For research papers — how novel is this contribution to the field?

Applies only to `research_finding` and `benchmark_evaluation` sources. Incidents, threat-intel, and other types are ranked by maturity and reading_value instead.

| Level | Meaning |
|---|---|
| `landmark` | First work to establish a new attack surface or threat class; or first autonomous capability at scale; or first rigorous systematic measurement of a known-but-unmeasured risk. Opens a new tracking file for the field. |
| `notable` | New technique or measurement within a known attack surface. Worth a slide; does not establish the surface itself. |
| `routine` | Solid but expected. Incremental on well-trodden ground, or secondary news coverage of research disclosed elsewhere. |
| `incremental` | Minor variation, narrow scope, or reproduction study with small deltas. |

**Key rule:** The significance attaches to the originating research, not to news coverage of it. A blog reporting a technique first disclosed in a paper is `routine` at best, regardless of how striking the technique is.

---

## 5. Source Type

**Field:** `source_type`  
**Set by:** Layer 3 unified LLM call, normalised against the controlled vocabulary  
**Question answered:** What kind of intelligence artefact is this?

| Type | Description |
|---|---|
| `vulnerability` | A specific disclosed flaw in an AI system or its dependencies |
| `exploit_disclosure` | A working exploit, PoC, or tool for a specific vulnerability |
| `incident` | A documented real-world attack, breach, or abuse |
| `threat_intelligence` | Actor TTPs, IOCs, attribution, campaign tracking |
| `adversary_adoption_signal` | Evidence that adversaries are adopting a technique |
| `research_finding` | A paper analysing or theorising an attack (no released tool) |
| `benchmark_evaluation` | A dataset, benchmark, or measurement study |
| `capability_demonstration` | First-of-kind proof a new offensive capability is possible |
| `defensive_capability` | A detection, mitigation, or hardening technique |
| `governance_signal` | Policy, regulation, standard, or agency advisory |
| `societal_harm_signal` | Documented societal or individual harm (fraud, disinformation, abuse) |
| `attack_surface_signal` | A development that materially shifts the AI attack surface; also used for threat landscape syntheses and roundups aggregating multiple named AI threat events |
| `unknown` | Source type could not be determined |

---

## 6. Threat Category

**Field:** `main_category`  
**Set by:** Layer 4 understand LLM (`lib/prompts/understand/classify.md`)  
**Question answered:** Which offensive AI threat domain does this source belong to?

| Category | What it covers |
|---|---|
| `traditional_ai_threats` | Attacks on ML models, training data, weights, inference pipelines, and model supply chain. The victim is a classical ML artifact, not an LLM or autonomous agent. |
| `llm_threats` | Attacks exploiting LLM language processing: prompt injection, jailbreaks, RAG poisoning, data/prompt leakage, guardrail bypass, LLM-serving infrastructure. |
| `agentic_ai_threats` | Attacks exploiting AI agent autonomy: MCP/tool abuse, agent goal hijacking, memory poisoning, agentic supply chain, code execution via agent tool-use. |
| `ai_enabled_threats` | AI as the attacker's weapon against non-AI victims: AI-generated malware, deepfake fraud, AI-assisted phishing, autonomous attack orchestration. |
| `unclear_or_adjacent` | Genuinely about AI security but does not map to one of the four offensive categories; kept as reference context. |

---

## 7. Trust Tier

**Field:** `trust_tier`  
**Set by:** Deterministic at ingest (`trustAssessment.js`), refined by Layer 3 LLM (can downgrade, never upgrade)  
**Question answered:** How credible is this source for the specific claim it makes?

Trust tier reflects the publisher's role in the specific claim, not just their general reputation. The same publisher can be `primary` for their own advisory and `medium` when reporting someone else's finding.

| Tier | Meaning |
|---|---|
| `primary` | Authoritative for this specific claim: the affected vendor, named victim, original research team, government agency issuing its own record |
| `high` | Established institution or security vendor publishing original technical work with named authors and traceable evidence |
| `medium` | Reputable journalism or independent analysis accurately attributing and linking to primary evidence; did not originate the finding |
| `low` | Weak attribution, recycled reporting, anonymous claims, strong commercial incentive without original evidence |
| `unknown` | Cannot determine publisher trustworthiness from available text |

---

## 8. Evidence Quality

**Field:** `evidence_quality`  
**Set by:** Layer 3 unified LLM call  
**Question answered:** How well-supported is the primary claim?

| Value | Meaning |
|---|---|
| `strong` | Named authors/org, CVE/advisory identifiers, affected products and versions named, methodology described, traceable references, measurements from own experiments |
| `adequate` | Some of the above present but incomplete; claim is plausible and reasonably supported |
| `weak` | Vague attribution, untraced statistics, social-media posts, circular attribution, single unnamed source |
| `unverifiable` | Cannot determine if the claim is real; hypothetical framed as observed; headline stronger than body |

---

## 9. Evidence Origin

**Field:** `evidence_origin`  
**Set by:** Layer 3 unified LLM call  
**Question answered:** Who produced the underlying evidence?

| Value | Meaning |
|---|---|
| `first_party` | Publisher directly observed, discovered, investigated, owns the affected product, is the named victim, or issued the authoritative record |
| `original_research` | Publisher conducted independent original research, experiments, or analysis |
| `secondary_reporting` | Publisher accurately reports and attributes another organisation's finding |
| `aggregation` | Publisher collects and summarises multiple other sources without original analysis |
| `unclear` | Cannot determine from available text |

---

## How labels relate to each other

```
reading_value      — editorial triage:  "who should read this NOW?"
distribution       — surface routing:   "dashboard / newsletter / library?"
maturity_level     — threat lifecycle:  "how real is this threat technique?"
significance       — research novelty:  "how new is this research contribution?" (research only)
source_type        — artefact kind:     "what kind of intelligence object is this?"
main_category      — threat domain:     "which AI threat area does this belong to?"
trust_tier         — claim credibility: "how trustworthy is this specific claim?"
evidence_quality   — claim support:     "how well-evidenced is the primary claim?"
evidence_origin    — claim provenance:  "who produced the underlying evidence?"
```

None of these dimensions is a function of any other. A source can be:
- `essential` + `research` maturity (first-of-kind theoretical paper)
- `informative` + `operational` maturity (routine CVE for a known exploited class)
- `recommended` + `secondary_reporting` origin (well-sourced journalist synthesis)
- `background` + `primary` trust (authoritative defensive guidance with no offensive finding)
