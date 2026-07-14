# The Horizon — Dashboard Legend

Reference for every label, badge, and classification shown in the dashboard.
Each entry explains what the label means, where it comes from, and what it implies.

---

## How `source_type` Is Assigned

`source_type` is the single most important classification field — it drives both the maturity bar
and the reality badge. It is assigned **deterministically in Layer 3** (no LLM) by
`lib/pipeline/validation/sourceTyping.js`. The classifier runs this priority chain, first match wins:

1. **Already set** — source already carries a canonical `source_type` → kept as-is.
2. **Legacy mapping** — old type names (e.g. `security_blog`, `research_paper`) are mapped to the
   current canonical vocabulary.
3. **Connector origin** — the data connector identifies the source's domain:
   - NVD connector → `vulnerability`
   - arXiv connector → `research_finding` (or refined to `benchmark_evaluation` /
     `capability_demonstration` by text rules)
   - CISA/NIST connectors → `governance_signal`
4. **Tag signals** — tags assigned earlier (e.g. `cve`, `incident`, `apt`, `ransomware`) map
   directly to a source type.
5. **Text signals** — regex patterns run over title + summary + first 3,000 characters of
   full text. Examples:
   - "proof-of-concept", "poc released", "exploit published" → `exploit_disclosure`
   - "data breach", "ransomware attack", "were compromised" → `incident`
   - "we demonstrate that", "we present a novel" → `capability_demonstration`
   - "cve-20", "zero-day", "security advisory" → `vulnerability`
6. **Fallback** → `unknown`

**Important:** the text patterns are conservative by design. Hypothetical language
("could be exploited", "researchers showed it is theoretically possible") does NOT match
the `incident` or `exploit_disclosure` patterns. Only unambiguous operational language qualifies.

---

## The Two Classification Systems

The dashboard uses `source_type` in two completely separate ways that look similar but are not:

| System | Where shown | Unit | Code |
|---|---|---|---|
| **Evidence Maturity Bar** | Coloured bar in each category card | Count of sources per rung across the whole category | `lib/dashboard/evidenceMaturity.js` |
| **Reality Badge** | Badge on each source in Top Sources | Single label per source | `lib/pipeline/scoring/importance.js` |

They overlap (both start from `source_type`) but use different mappings and serve different purposes.

---

## Evidence Maturity Bar

**What it answers:** "What is the mix of source types in this category's corpus?"

A category with 50 sources that are all research papers is a fundamentally different signal
than one with 10 incident reports. The bar makes this visible so the count alone is not
mistaken for confirmed operational activity.

**How it works:** `computeEvidenceMaturity()` in `lib/dashboard/evidenceMaturity.js` counts
every source in the category and puts each into one of five rungs based on `source_type`.
No LLM, no text scan — pure type lookup.

| Rung | Colour | `source_type` values that map here | What it means |
|---|---|---|---|
| **Research** | Grey | `research_finding`, `benchmark_evaluation`, `capability_demonstration`, `defensive_capability` | Techniques that have been studied, simulated, or demonstrated. Includes capability demonstrations — working attack code in a controlled setting. |
| **Vulnerabilities** | Amber | `vulnerability` | Disclosed CVEs or vendor advisories. A flaw exists; exploitation has not been confirmed. |
| **Exploitation** | Red | `exploit_disclosure` | A working exploit has been published or demonstrated, not merely disclosed as a CVE. |
| **Incidents** | Dark red | `incident` | Named, confirmed security events with identified victims or attributed actions. |
| **Operational** | Deep red | `threat_intelligence`, `adversary_adoption_signal` | Vendor or government reporting of adversary TTPs in active operations — not just one incident, but documented tradecraft. |

Sources that don't fit these five (blogs, governance signals, surface signals, unknowns) are
counted in a hidden `other` bucket and excluded from the bar — they contribute to the total
source count but not to the maturity distribution.

**The confidence score** shown elsewhere is derived directly from this bar:
sources with zero exploitation + incidents + operational → at most "Medium" confidence;
High confidence requires at least 3 operational data points and 15+ total sources.

---

## Reality Badge (In the Wild / Demonstrated / Research)

**What it answers:** "What lifecycle stage of the threat did this one source witness?"

Shown next to each source in the Top Sources list. This is a per-source classification, not
a count. It is the primary signal for prioritising which individual sources matter most.

**How it works:** `computeImportance()` in `lib/pipeline/scoring/importance.js` applies a
two-step rule to each source:

**Step 1 — map `source_type` to a `reality` value:**

| `source_type` | `reality` |
|---|---|
| `incident` | `realized` |
| `threat_intelligence` | `realized` |
| `adversary_adoption_signal` | `realized` |
| `attack_surface_signal` | `realized` |
| `societal_harm_signal` | `realized` |
| `exploit_disclosure` | `proven` |
| `capability_demonstration` | `proven` |
| `research_finding` | `research` |
| `benchmark_evaluation` | `research` |
| `vulnerability` | `disclosure` *(not shown as a badge — maps to noise tier)* |
| `governance_signal` | `advisory` *(not shown as a badge)* |

**Step 2 — in-the-wild text upgrade:**
If `reality` is `proven`, `disclosure`, or `other`, the source's title and summary are
scanned for explicit in-the-wild exploitation language. If found, `reality` is upgraded
to `realized`. The scan uses only unambiguous phrases:
`"exploited in the wild"`, `"actively exploited"`, `"known exploited"`,
`"mass-exploited"`, `"weaponized in attacks"`, etc.
Hypothetical language is excluded by design.

**Step 3 — posture filter:**
Only sources classified as `offensive` (in one of the four threat categories, not defensive
research) are shown in Top Sources. Defensive and adjacent sources are assigned a `noise` tier
and excluded from the ranked list.

**Final badge:**

| Badge | `reality` value | What it means |
|---|---|---|
| 🔴 **In the wild** | `realized` | An adversary has used this in confirmed real-world attacks. Highest priority. |
| 🟠 **Demonstrated** | `proven` | A working attack was built and shown. Not yet confirmed in active use, but reproducible. |
| 🔵 **Research** | `research` | Technique was studied or benchmarked. Not operationalised. |

---

## Why `capability_demonstration` Differs Between the Two Systems

This is the most confusing point:

- In the **maturity bar**: `capability_demonstration` → **Research** rung (grey)
- In the **reality badge**: `capability_demonstration` → `proven` → **🟠 Demonstrated** badge

This is intentional. The maturity bar groups things by "how close to real operations are these
sources?" For that question, a lab-demonstrated attack belongs with research papers — it has not
been used by an adversary. The reality badge asks "did this individual source prove the attack
works?" — for which a working demonstration is meaningfully stronger than a theoretical study.

Both answers are correct for their respective questions.

---

## Threat Categories

Every source is classified into one offensive category. Sources not clearly offensive are "Other."

| Category | What it covers |
|---|---|
| **Traditional AI Threats** | Attacks *on* ML models — data poisoning, model extraction, adversarial evasion, backdoors, membership inference. The model is the victim. |
| **LLM Threats** | LLM-specific attacks — prompt injection, jailbreaks, RAG poisoning, data/prompt leakage, guardrail bypass, inference-server vulnerabilities (vLLM, LiteLLM). |
| **Agentic AI Threats** | Attacks exploiting AI agent autonomy — malicious plugins/skills, MCP and tool-call abuse, agent supply-chain poisoning, hijacking agent reasoning or memory. |
| **AI-Enabled Threats** | AI as the attacker's tool — AI-generated malware, deepfake fraud, AI-assisted phishing, voice cloning, LLM-as-C2, nation-state AI tradecraft. |

**How assigned:** Layer 3 LLM assigns `main_category` from title, abstract, and summary.
Layer 4 mechanism classifier can revise it based on the specific attack mechanism identified.

---

## Source Trust Tier

Confidence in the source's accuracy and independence. **A confidence annotation, not a
ranking axis** — trust tier does not determine how important a source is, only how much
to trust its claims. A low-trust source can describe a high-impact incident.

| Tier | What it means | How assigned |
|---|---|---|
| **Primary** | Official government agencies (CISA, NCSC, NIST) or the AI labs who built the systems (Anthropic, OpenAI). | Manually set at ingest based on publisher domain. |
| **High** | Established security vendors (Google, Wiz, Microsoft), peer-reviewed academic publications, reputable security research. | Manually or automatically set. |
| **Curated** | Manually imported from analyst's curated backlog (Excel/PDF imports). Human-reviewed. Never auto-deleted. | Set on manual import. |
| **Medium** | General security news outlets. Accurate but may rely on secondary reporting. | Automated based on publisher classification. |
| **Low** | Lower-confidence sources — blogs, unverified aggregators. | Automated. |
| **Unknown** | Not yet classified. | Default. |

---

## Relevance Tiers

How central AI threats are to the source's content. Set by Layer 3 LLM.

| Tier | Meaning |
|---|---|
| **Core** | Directly about AI-specific threats — the primary focus is an AI attack, vulnerability, or incident. |
| **Adjacent** | Relevant security context with an AI component. |
| **Peripheral** | Mentions AI in passing; general cybersecurity with minimal AI relevance. |
| **Off-topic** | Not relevant — excluded. |

Sources with `relevance_tier = off_topic` or `ai_specificity_score < 10` are purged
(except `curated` sources, which are protected from automated deletion).

---

## Source Counts

Numbers in the header and category cards count **unique sources** (deduplicated by URL hash)
that passed Layer 3 validation (`validation_status = pass`) and were classified into one of
the four offensive categories in the selected time window.

**"Other"** = sources that passed validation but are `unclear_or_adjacent` (defensive research,
governance documents, generic CVEs with low AI specificity).

Same URL ingested twice → always an upsert, never a duplicate.
