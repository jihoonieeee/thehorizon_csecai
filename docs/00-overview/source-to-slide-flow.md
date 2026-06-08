# Source-to-Slide Flow

**Audience:** New engineers and analysts who want to understand how raw source material becomes a claim on a briefing slide.

This document walks through three concrete source examples — showing every decision the pipeline makes, why it makes it, and how those decisions affect final slide content.

---

## Example 1 — Incident Report (Highest Evidence Value)

**Source:** A published report from NIST documenting 3 real-world prompt injection attacks against enterprise LLM deployments.

**IDs used in this walkthrough:**
- Source: `src_nist_pi_2026`
- Evidence items: `ev_src_nist_pi_2026_1`, `ev_src_nist_pi_2026_2`
- Observation: `obs_llm_1`
- Viewpoint: `vp_llm_1`
- Claim: `cl_llm_critical_1`
- Slide: `slide_012`

---

### Layer 1 — Ingest

The NIST advisory RSS feed is checked. The URL `https://nist.gov/...` is hashed → SHA-256 → first 36 chars → `src_nist_pi_2026`.

Because this ID is the primary key in the `sources` table, a second ingestion run with the same URL does an upsert — no duplicate row created.

The connector sets:
```
source_type:  "incident"       ← NIST is mapped to this by the connector
trust_tier:   "primary"        ← NIST is in the primary trust tier list
```

---

### Layer 2 — Clean

The full advisory text is stripped of HTML, markdown artifacts, and repeated whitespace. `clean_text` is set. The cleaner extracts:
- No CVE IDs found in this report
- No IP indicators
- Code blocks: none

---

### Layer 3 — Validate / Gate

Three decisions:

**Validity gate:** Does this source have substantive text? Is the URL reachable? Trust tier primary → passes.

**AI relevance:** Keyword search finds "prompt injection", "LLM", "enterprise deployment", "bypass". AI specificity score is high (>70). Source passes the relevance gate.

**Source type refinement:** The preliminary `source_type = "incident"` is confirmed. Trust tier is `primary`.

The source is routed to **Layer 4** with `layer3_status = "pass"` and `downstream_route = "layer4"`.

---

### Layer 4 — Taxonomy Understanding

The LLM runs taxonomy tagging. It reads `clean_text` and assigns tags from the v9 controlled vocabulary (coded IDs: TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE10):

```
primary_tags: [
  { tag: "LLM01_prompt_injection", domain: "llm_threats", validation_status: "validated" },
  { tag: "LLM02_sensitive_information_disclosure", domain: "llm_threats", validation_status: "validated" }
]
sub_techniques: ["retrieval_augmented_prompt_injection"]
main_category: "llm_threats"
taxonomy_version: "taxonomy-v9-2026-06"
```

The deterministic post-processor validates these tags against the controlled vocabulary in `lib/config/taxonomyRegistry.js`. Both are valid. The source is confirmed as `llm_threats`.

---

### Layer 5A — Rawfact Evidence Extraction

Because this source has `trust_tier = "primary"` and passed Layer 3, it is eligible for evidence extraction.

The LLM reads the source and extracts atomic evidence items:

**Item 1: `ev_src_nist_pi_2026_1`**
```
evidence_type:    "incident_event"
fact:             "3 documented incidents of prompt injection bypassing enterprise LLM guardrails via RAG document poisoning in Q1 2026."
source_quote:     "In all three cases, the attacker inserted malicious instructions into documents retrieved by the RAG pipeline, causing the LLM to follow attacker instructions."
entities:         ["RAG pipeline", "enterprise LLM", "ChatGPT Enterprise"]
numbers:          ["3"]
is_atomic:        true
quote_verified:   true
```

**Item 2: `ev_src_nist_pi_2026_2`**
```
evidence_type:    "vulnerability_fact"
fact:             "All affected deployments lacked input sanitization on retrieved RAG documents before passing to the LLM context window."
source_quote:     "None of the affected deployments had implemented sanitization..."
entities:         ["RAG", "context window", "input sanitization"]
numbers:          []
is_atomic:        true
quote_verified:   true
```

**Evidence triage for `ev_src_nist_pi_2026_1`:**

Admissibility gates run deterministically:
- URL/source ID present ✓
- Quote verified ✓
- Atomic fact ✓
- Fact > 25 chars ✓
- No marketing language ✓
- No speculative language ✓

Result: `admissibility = "passed"`

Strength assessment:
- `direct_demonstration = true` (actual incidents)
- `concrete_claim = true` (named systems, named attack vector)
- Source type `incident` → full evidence permissions
- No blocking limitations

Result: **`evidence_strength = "strong"`**

`permitted_uses = ["fact_support", "case_study", "capability_support", "trend_input", "outlook_input"]`

**Evidence triage for `ev_src_nist_pi_2026_2`:**
- Admissibility: passes
- `direct_demonstration = true` but narrow scope
- `evidence_strength = "usable"` (limitation: `single_source`)

---

### Layer 5B — Analytics

Aggregates for `llm_threats` include:
- `attack_vector_frequency.prompt_injection = 8` (across all sources)
- `maturity_distribution.operational = 3`

`ev_src_nist_pi_2026_1` contributes to the `incident` source_type count and the `prompt_injection` attack vector frequency.

No analytics visualization spec is generated specifically for this source (it's a single source; viz specs emerge from corpus-level patterns).

---

### Layer 6 — Analysis + Synthesis (Claim Chain)

Layer 6 converges the L5A rawfact evidence and L5B analytics into a fused category dossier, then runs the claim chain. The claim chain is a **single viewpoints-first synthesis call** — the LLM receives the full evidence dossier and produces observations, viewpoints, and claims in one pass (not three sequential calls).

The analytical state includes:
- `ev_src_nist_pi_2026_1` (strong, incident_event)
- `ev_src_nist_pi_2026_2` (usable, vulnerability_fact)
- Analytics: `prompt_injection` frequency = 8, 3 operational sources

**Observation (derived from synthesis output):**

**`obs_llm_1`:**
```
observation_type:   "repeated_technique"
observation_scope:  "repeated_pattern"
observation_text:   "RAG document poisoning as a prompt injection vector has been documented across 3 independent incidents from 2 publishers in Q1 2026."
limitations:        ["narrow_time_window"]
```

**Viewpoint:**

**`vp_llm_1`:**
```
viewpoint_type:    "operational_pattern"
viewpoint_text:    "Prompt injection via RAG document poisoning has moved from research demonstration to documented operational exploitation in enterprise environments."
analytical_change: "adoption_moved_forward"
change_driver:     "operationalized"
strength:          "strong"
caveat_if_any:     null
```

Why `strong`? It connects 2+ observations, the analytical_change is non-trivial, and it does not assert anything beyond what the source_type `incident` permits.

**Claim (before priority assignment):**
```
claim_id:                   "cl_llm_critical_1"
claim_text:                 "Prompt injection via RAG document poisoning has crossed from research to documented operational exploitation in enterprise LLM deployments."
claim_type:                 "category_insight"
analytical_change:          "adoption_moved_forward"
change_driver:              "operationalized"
supporting_viewpoint_ids:   ["vp_llm_1"]
supporting_observation_ids: ["obs_llm_1"]
supporting_evidence_ids:    ["ev_src_nist_pi_2026_1"]
evidence_sufficiency:       "sufficient"
broad_relevance:            true
broad_relevance_basis:      ["common_ai_deployment_pattern"]
multi_scope_impact:         true
multi_scope_basis:          ["actors", "systems"]
strong_viewpoint_support:   true
strong_evidence_support:    true
blocking_limitations:       false
slide_driving_power:        true
```

**Deterministic priority assignment:**

All critical gates check:
| Gate | Result |
|------|--------|
| evidence_sufficiency = "sufficient" | ✓ |
| CRITICAL_ANALYTICAL_CHANGE (adoption_moved_forward) | ✓ |
| CRITICAL_CHANGE_DRIVER (operationalized) | ✓ |
| broad_relevance + valid basis | ✓ |
| multi_scope_impact + ≥2 valid dimensions | ✓ |
| strong_viewpoint_support | ✓ |
| strong_evidence_support | ✓ |
| no blocking limitations | ✓ |
| slide_driving_power | ✓ |

**Result: `claim_priority = "critical"`**

The LLM did NOT decide this. The deterministic gate did.

**Category-level analysis output:**
```
category_headline: "Prompt injection is now a confirmed operational threat, not just a research finding."
top_insights[0]:
  insight:             "Enterprise LLM deployments exposed via RAG document poisoning — 3 confirmed incidents."
  confidence:          "high"
  supporting_evidence_ids: ["ev_src_nist_pi_2026_1"]
```

Because the analytical state provides a ceiling on what the LLM may claim (e.g. it cannot claim "widespread" without analytics showing frequency > 50%), the LLM output respects these constraints.

---

### Layer 7 — Slide Planning

`planSlides()` runs with `category_analyses["llm_threats"]` present.

`cl_llm_critical_1` has priority `critical` → triggers the **full critical section** for `llm_threats`:

Slides generated for this claim:
1. `section_divider` — LLM Threats
2. `critical_claim` (slide_012) — anchored to `cl_llm_critical_1`
3. `evidence_support` — supporting `cl_llm_critical_1`
4. `case_study` — `ev_src_nist_pi_2026_1` as the concrete case
5. `outlook_6month` — outlook claim if available
6. `recommendation` — if recommendation claim available

**Slide plan for `slide_012`:**
```json
{
  "slide_id":           "slide_012",
  "slide_number":       12,
  "slide_type":         "critical_claim",
  "section":            "C",
  "category":           "llm_threats",
  "claim_id":           "cl_llm_critical_1",
  "claim_priority":     "critical",
  "claim_type":         "category_insight",
  "claim_text":         "Prompt injection via RAG document poisoning has crossed from research to documented operational exploitation in enterprise LLM deployments.",
  "supporting_evidence_ids": ["ev_src_nist_pi_2026_1"],
  "supporting_viewpoint_ids": ["vp_llm_1"],
  "caveats":            null
}
```

---

### Layer 7 — Slide Content Generation

`generateSlideContent()` routes `slide_012` to `buildClaimFirstPrompt()` because `claim_id` is set.

The LLM receives ONLY:
- The claim text
- Selected evidence: `ev_src_nist_pi_2026_1` (with fact, source_quote, entities)
- Viewpoint: `vp_llm_1` (with analytical_change reasoning)
- Caveats: none

The LLM **cannot** receive the broader category analysis or raw evidence dumps. It writes slide language from the approved claim and approved support only.

Output:
```json
{
  "headline": "Prompt injection crossed from research to operational: 3 confirmed enterprise incidents.",
  "bullets": [
    "3 documented incidents in Q1 bypassed enterprise LLM guardrails via RAG document poisoning.",
    "Attackers injected malicious instructions into documents retrieved by the RAG pipeline.",
    "All affected deployments lacked sanitization on RAG-retrieved content.",
    "Operational exploitation confirmed — no longer research-only."
  ],
  "evidence_callouts": [{
    "evidence_id": "ev_src_nist_pi_2026_1",
    "title":       "NIST Prompt Injection Advisory Q1 2026",
    "key_fact":    "3 documented incidents bypassed enterprise LLM guardrails via RAG document poisoning.",
    "publisher":   "NIST",
    "url":         "https://nist.gov/..."
  }],
  "citations": ["NIST — Prompt Injection Advisory Q1 2026 (https://nist.gov/...)"]
}
```

---

### Layer 7 — Slide Content QA

`qaSlideContent()` runs deterministic checks:

- Analytical slide has `claim_id` ✓
- Headline derives from `claim_text` ✓ (key terms overlap)
- No hallucinated numbers: "3" is in `ev_src_nist_pi_2026_1.numbers` ✓
- No unsupported trend phrases ✓
- Citation has URL ✓

**Result: all checks pass, `content_qa.qa_pass = true`**

---

### Layer 8 — Speaker Notes

`generateSpeakerNotes()` receives the finalized `slide_012` content plus `claim_type = "category_insight"`.

The system prompt instructs: explain why the claim matters, explain how the evidence supports it, state caveat/confidence if relevant.

The LLM writes:

> "This marks a significant shift for enterprise LLM security. NIST documented three real incidents where attackers injected malicious instructions into documents retrieved by a RAG pipeline — causing the LLM to follow attacker commands instead of legitimate user requests. The attack doesn't require access to the model itself; it exploits the retrieval step. This matters because most enterprise RAG deployments don't sanitize retrieved content before it reaches the context window. Moving to the next slide, we'll look at the specific evidence behind this finding."

---

### Layer 8 — Speaker Notes QA

`qaSpeakerNotes()` checks:
- No new numbers: "three" resolves from evidence callout ✓
- No phantom sources: "NIST" is in citations ✓
- No trend certainty language ✓
- No outlook certainty ✓

**Result: `notes_qa.qa_pass = true`**

---

### Layer 9 — PPTX Export

`exportPptx()` renders `slide_012`:
- Headline as large text
- 4 bullets
- Evidence callout box with NIST attribution and key fact
- Speaker notes attached to slide notes field

Final PPTX contains `slide_012` at position 12 in the deck.

---

## Example 2 — Research Paper (Lower Evidence Value)

**Source:** An arXiv paper demonstrating a new theoretical attack method against model watermarks.

**IDs:** `src_arxiv_watermark_2026`, `ev_src_arxiv_wm_1`

---

### Why Research Papers Get Lower Priority

Research papers go through the same pipeline, but key gates work differently:

**Layer 3 — Validate:**
- `source_type = "research_finding"` (set by arXiv connector)
- `trust_tier = "high"` (arXiv is high, not primary)

**Layer 5A — Triage:**

Evidence item extracted:
```
fact:              "Researchers demonstrated a gradient-based attack that can remove model watermarks in 3 inference passes on commodity hardware."
evidence_type:     "research_result"
direct_demonstration: true
concrete_claim:    true
```

Triage:
- Admissibility: **passes**
- BUT: `source_type = "research_finding"` limits permissions
  - `permitted_uses` does NOT include `"adoption_support"` (only incidents can prove adversary adoption)
  - Limitation added: `"no_operational_observation"` (paper demonstrates but no confirmed real-world use)

Result: `evidence_strength = "usable"` (not strong, because limitation applies)

**Layer 6 — Claim Chain:**

A viewpoint is generated: `"Watermark removal capability demonstrated at low cost, suggesting defensive watermarking assumptions may need revision."`

The `analytical_change` is `"capability_increased"` — appropriate.

The critical gate checks:
- `adoption_moved_forward` gate: fails (no `adoption_support` permission)
- But `CRITICAL_ANALYTICAL_CHANGE.has("capability_increased")` = true
- Missing: `multi_scope_impact` (only systems dimension, not actors)

**Priority: `"high"` (not critical)**

The research paper produces a high-priority claim, not critical. It will get a compact slide section (divider + category_viewpoint + evidence_support), not the full critical section.

**Key takeaway:** Research papers can prove capability — they cannot prove adversary adoption. The system enforces this automatically via `permitted_uses` and the `adoption_support` check in the claim priority gates.

---

## Example 3 — Governance Signal (Context-Only)

**Source:** A CISA guidance document on AI security recommendations for federal agencies.

**IDs:** `src_cisa_ai_guidance_2026`, `ev_src_cisa_1`

---

### Why Governance Signals Cannot Drive Analytical Slides

**Layer 5A — Triage:**

Evidence item extracted:
```
fact:             "CISA issued new guidance identifying prompt injection as a top risk for federal LLM deployments."
evidence_type:    "governance_action"
source_type:      "governance_signal"
direct_demonstration: false
concrete_claim:   false
```

Triage:
- Admissibility: **`context_only`** — passes but `direct_demonstration = false` and `concrete_claim = false`
- `evidence_strength = "context"`
- `permitted_uses = ["context_only", "outlook_input"]`

**Critical consequence:** A `context_only` evidence item:
- **Cannot** be a slide's primary evidence callout
- **Cannot** drive an analytical claim (only provides framing)
- **Can** appear in background context for an outlook or methodology slide
- **Triggers** `qaSlideContent` Rule: if slide has `all_context_only = true` and makes operational assertions, the QA blocks it

**Layer 6 — Claim Chain:**

Governance signals do not produce viewpoints about threat activity. The viewpoint synthesis is instructed:

> "governance_signal cannot prove attacker activity or operational trends."

If the synthesis tried to write "Adversaries are actively exploiting LLMs" and cited only a CISA guidance document, the `permitted_uses` check during triage would have already prevented this:
- The evidence item has `permitted_uses = ["context_only"]`
- A viewpoint asserting `analytical_change = "adoption_moved_forward"` would need `adoption_support` permission
- `adoption_support` is NOT in the permitted_uses for governance signals

**What governance signals CAN do:**
- Provide context for the `scope_methodology` and `evidence_gaps` slides
- Provide background for `recommendation` claims (citing governance frameworks)
- Support `outlook_input` for trajectory discussions

**On the deck:** This source appears in the appendix bibliography and may be cited in the `scope_methodology` slide or an `evidence_gap` slide as "CISA flagged this as a gap area." It does NOT anchor an analytical claim.

---

## Cross-Cutting Design Principles Illustrated by These Examples

### 1. Source Type Controls What a Source Can Prove

| Source Type | Can Prove | Cannot Prove |
|-------------|-----------|--------------|
| `incident` | Adversary use, operational impact, real-world attack | Future trajectory alone |
| `research_finding` | Capability exists, attack feasibility | Adversary adoption, operational use |
| `governance_signal` | Regulatory attention, framework gaps | Threat activity, capability |
| `vulnerability` | Exposed attack surface | Exploitation without incident evidence |

### 2. Evidence Must Be Atomic

A compound claim like "Prompt injection and model extraction are both increasing" would produce `is_atomic = false` → immediate failure in admissibility. The extraction LLM is instructed to split compound claims into separate items.

Why: A compound claim cannot be selectively cited. If one half is valid and the other is not, the whole item becomes untrustworthy.

### 3. No Number Without a Number in the Evidence

The pipeline enforces: every number in a slide bullet or speaker note must appear verbatim in the evidence callout's `key_fact` or the slide's `bullets`.

If the source says "thousands of repositories" and the LLM writes "5,500 repositories" in a bullet — `qaSlideContent` flags it as `hallucinated_statistic` and either revises it to "thousands" or appends `[STATISTIC UNVERIFIED]`.

### 4. Claims Are Generated Top-Down; Evidence Flows Bottom-Up

Evidence items → Observations → Viewpoints → Claims → Slide Planning → Slide Content

At each step, the rules only get stricter. You cannot make a claim that wasn't supported by a viewpoint. You cannot generate a slide without a claim. You cannot write a slide headline that invents a new claim. You cannot write speaker notes that introduce new facts.

The claim chain runs as a single viewpoints-first LLM synthesis call in Layer 6 — not as three separate sequential calls. The output still produces the obs/vp/claim hierarchy as structured fields, but the LLM sees the full dossier at once and reasons viewpoints-first.

### 5. Deterministic Gates Beat LLM Judgment for Priority

The LLM generates claim fields. The LLM cannot set `claim_priority`. This is intentional: LLMs are susceptible to hype escalation, media emphasis, and novelty bias. The deterministic gates in `assignClaimPriority()` require all nine conditions to be true for `critical`, with no exceptions.

### 6. Context Evidence Creates Gaps, Not Insights

When a category has only context-level evidence (governance documents, strategic commentary, general ecosystem news), the pipeline produces:
- An `evidence_gap` slide explaining what is unknown
- A `category_not_assessed` slide if even that fails
- NOT a speculative `category_viewpoint` slide with invented claims

---

## Related Documentation

- [`../05-evidence/rawfact-evidence-importance.md`](../05-evidence/rawfact-evidence-importance.md) — evidence triage decision logic
- [`../00-overview/evidence-quality-philosophy.md`](evidence-quality-philosophy.md) — design philosophy
- [`../06-analysis/layer-6-analysis.md`](../06-analysis/layer-6-analysis.md) — how claims become analysis
- [`../07-slides/layer-7-slide-planning.md`](../07-slides/layer-7-slide-planning.md) — slide planning architecture
