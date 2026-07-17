# Source Labels — Complete Reference

Every source in The Horizon carries multiple labels assigned at different pipeline stages. This document defines each label, its values, and how it is determined.

---

## 1. Reading Value

**Field:** `reading_value`  
**Set by:** Layer 3 unified LLM call (`lib/prompts/validation/layer3.md`)  
**Question answered:** Who should read this source? Is it dashboard or newsletter material?

Reading value is the primary editorial triage signal. It is independent of threat severity, maturity, and publisher prestige — a theoretical paper introducing a new attack surface may be `essential` while a confirmed in-the-wild CVE may be `analyst`.

| Value | Audience | Criteria |
|---|---|---|
| `essential` | Senior leadership, board, policymakers | Changes the threat model, invalidates a trusted assumption, establishes a new attack surface, documents the first confirmed operational use of a major capability, or introduces a canonical framework leadership will repeatedly reference. A CISO cites this in a board deck. |
| `recommended` | Security-aware professionals, threat analysts | Materially changes prioritisation within a known attack surface through a new technique, meaningful measurement, confirmed adversary adoption, strong multi-incident synthesis, or a highly reusable case study. Goes in the weekly threat brief. |
| `analyst` | Security engineers and practitioners | Technically useful detail, implementation mechanics, incremental research, or corroborating coverage that improves practitioner understanding but does not change strategic posture. The team reads it; leadership sees the summary. |
| `background` | Reference only | Adjacent guidance, generic commentary, aggregations, policy context, defensive advice, or sources that add no distinct intelligence beyond stronger existing coverage. File away. |

**Hard rules:**
- Thin body text (<~300 chars): capped at `analyst` regardless of title language. The title is not evidence.
- Defensive-primary sources (vendor tooling docs, architecture guides, how-to hardening): `analyst` or `background` even if they describe attacks as context.

---

## 2. Distribution Recommendation

**Field:** `distribution_recommendation` (object with three booleans)  
**Set by:** Layer 3 unified LLM call, derived from reading_value + content assessment  
**Question answered:** Which surfaces should actively promote this source?

| Flag | True when |
|---|---|
| `overview_dashboard` | `essential`, or `recommended` that is timely, not duplicate, and represents a distinct development in a major threat category during the current reporting window |
| `email_newsletter` | `essential` or `recommended` AND the finding is readable without engineering background AND actionable or awareness-raising for a non-specialist — never thin-text, defensive-primary, PoC mechanics, or academic benchmarks |
| `analyst_library` | Any `essential`, `recommended`, or `analyst` source — all substantive sources go here |

---

## 3. Threat Maturity

**Field:** `intelligence.maturity_level`  
**Set by:** Deterministic at Layer 4 ingest; LLM-refined via `scripts/labelMaturityLevels.js`  
**Question answered:** How far along the threat lifecycle is this technique?

| Level | Meaning | Typical source types |
|---|---|---|
| `research` | Technique studied or simulated in a controlled or academic environment. No adversary use; no working exploit outside the research setting. | `research_finding`, `benchmark_evaluation` |
| `demonstrated` | Working exploit or PoC exists and is reproducible against real software outside academia. No adversary use yet. | `exploit_disclosure`, `capability_demonstration` |
| `disclosed` | Vendor, researcher, or government confirmed a vulnerability exists. No exploit or exploitation observed. | `vulnerability`, `governance_signal` |
| `observed` | Confirmed real-world use — at least one documented incident with evidence of actual exploitation or harm. | `incident`, `attack_surface_signal` |
| `operational` | Sustained, repeated, or scaled adversary use. Multiple incidents, ongoing campaign, or documented adoption at scale. | `threat_intelligence`, `adversary_adoption_signal` |

**Classification rules:**
- A CVE alone → `disclosed`. CVE + public PoC → `demonstrated`. CVE + confirmed exploitation → `observed`.
- Paper tested against a live real product → `demonstrated`. Controlled lab only → `research`.
- Single confirmed incident → `observed`. Sustained/repeated campaign → `operational`.

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
- `analyst` + `operational` maturity (routine CVE for a known exploited class)
- `recommended` + `secondary_reporting` origin (well-sourced journalist synthesis)
- `background` + `primary` trust (authoritative defensive guidance with no offensive finding)
