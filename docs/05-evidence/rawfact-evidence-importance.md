# Decision Logic — Rawfact Evidence Importance

**Previous layer:** [Layer 4 — Taxonomy Understanding](../04-taxonomy/taxonomy-reference.md)  
**Next layer:** [Layer 5B — Analytics](analytics-index-logic.md)  
**Related:** [layer-5a-rawfacts-branch.md](layer-5a-rawfacts-branch.md) — rawfact branch overview and triage spec

---

## Purpose

Determine which extracted evidence items are strong enough to drive analytical claims, which provide supporting context, and which should be archived.

This is the single most consequential decision in the pipeline. The evidence triage result controls:
- Whether a claim can be `critical` or `high`
- Whether a source can appear in a slide's evidence callout
- Whether a trend claim can be validated
- Whether a recommendation has a risk basis

---

## Why This Decision Matters

**If too permissive:** Weak or speculative evidence gets escalated to slides. Analysts defend claims built on secondary reports, vendor marketing, or theoretical demonstrations that never occurred in practice.

**If too restrictive:** Legitimate findings from strong sources are suppressed. Coverage gaps widen. The pipeline misses real threats because the evidence didn't fit a clean profile.

The triage model threads this by separating evidence into four buckets (strong/usable/context/archive) rather than making a binary accept/reject decision. Context-level evidence still has a role — it can frame slides and inform outlook — but it cannot anchor claims.

---

## How the criteria are decided (LLM judgement + deterministic enforcement)

Two stages, by design:

1. **Per-source LLM judgement (Layer 5A step 5b — `judgeEvidenceItems.js`, Haiku).**
   One cheap call per source judges all of that source's extracted items at once and
   returns, per `evidence_id`, the *semantic* fields the rules cannot infer reliably:
   `direct_demonstration` (actually demonstrated/observed vs. proposed/theorised),
   `concrete_claim`, `source_type_fit` (does the fact match what this source TYPE can
   establish), `observed_use`, and `limitations`. The LLM is given the source type and
   its `can_prove` / `cannot_prove` profile so its `source_type_fit` call is grounded.

2. **Deterministic enforcement (`evidenceTriage.js`).** Every constraint is enforced in
   code: the hard admissibility gates, the source-type permission bounds
   (`sourceTypeClaimPermissions.js`), the observed-use rule, the limitation handling, and
   the categorical strength assignment. The LLM may *propose*; the rules *dispose*. The LLM
   can never invent a permitted use outside its source type's `can_support` set.

**Fallback:** when the LLM is unavailable or `skipLlm` is set, items carry no judgement and
the triage falls back to deterministic inference — `direct_demonstration` from the
`evidence_type` whitelist and `concrete_claim` from entity/number presence. This keeps the
pipeline running with no API keys, at lower precision (an `attack_method`-typed but purely
theoretical item is inflated by inference; the LLM judgement is what corrects it).

So: **source type sets the *ceiling* (which uses are even possible and whether the item can
be `strong` at all), and the LLM judgement decides whether a given item *reaches* that
ceiling** (was it demonstrated, does it fit, what limits apply).

## Inputs Considered

- `evidence_type` — type of fact extracted (incident_event, research_result, governance_action, etc.)
- `source_type` — what kind of source this came from (incident, research_finding, governance_signal, etc.)
- `fact` — the actual text of the extracted fact
- `source_quote` — verbatim span from the source text
- `quote_verified` — whether the quote was found in the source text
- `is_atomic` — whether the fact is a single, specific claim
- `direct_demonstration` — whether the fact describes something that was demonstrated/observed (not just theorised)
- `concrete_claim` — whether the fact includes named entities, tools, CVEs, or specific numbers
- `entities`, `numbers` — named entities and statistics extracted
- `evidence_cluster.is_representative` — whether this item is the representative of a duplicate cluster

---

## Decision Criteria

### 1. Admissibility Gates (Hard Fails)

An item is immediately `archive` if ANY of these are true:
- No traceable source URL or source ID
- `quote_verified = false`
- `is_atomic = false` (compound claim — must be split)
- Fact < 25 characters (too short to be substantive)
- Generic opener under 70 chars (e.g. "AI can be used to attack...", "AI models may...")
- Marketing language (best-in-class, revolutionary, game-changer, world's first)
- Speculative language (may/might/could + verb, possibly, potentially) without accompanying `direct_demonstration = true`
- LLM semantic judgement: `source_type_fit = false` (the evidence type doesn't match the source type)

**Why these gates?**
- No URL = no verification possible post-run
- No quote = possible hallucination or misread
- Compound claims = can't be selectively cited
- Short/generic facts = not specific enough to prove anything
- Marketing language = vendor self-interest distorts the claim
- Speculative language = cannot anchor a claim that requires operational specificity

### 2. Evidence Strength Assignment

| Strength | Conditions |
|----------|-----------|
| `strong` | admissibility=passed; direct_demonstration=true; concrete_claim=true; source_type permissions allow the claim; no blocking limitation |
| `usable` | admissibility=passed; but ≥1 limitation applies OR source_type has restricted permissions |
| `context` | admissibility=context_only; source contributes framing but cannot prove activity |
| `archive` | any hard-fail gate triggered |

### 3. Permitted Uses

The `permitted_uses` field controls what the evidence item can be used for in claims and slides:

| Use | Meaning | Who gets it |
|-----|---------|-------------|
| `fact_support` | Can support a factual claim | Strong and usable items |
| `case_study` | Can be a slide case study | Strong incident/exploit items |
| `capability_support` | Can prove capability exists | Strong research/benchmark items |
| `adoption_support` | Can prove adversary adoption | Only items with `observed_use = true` |
| `trend_input` | Can contribute to trend analysis | Strong and usable items |
| `outlook_input` | Can inform 6-month projections | All non-archive items |
| `context_only` | Can only frame; cannot prove | Context-strength items |
| `not_used` | Excluded from all claims | Archive items |

**The `adoption_support` gate is the hardest.** Only items from `incident` sources with confirmed real-world adversary use get this permission. Research papers demonstrating an attack in a lab do NOT get `adoption_support` — even if the attack is completely feasible and clearly dangerous.

### 4. Limitations

Limitations downgrade evidence strength and restrict permitted uses:

| Limitation | Effect |
|------------|--------|
| `single_source` | Downgrade: strong→usable for adoption claims |
| `lab_only` | Blocks: cannot support operational claims |
| `no_operational_observation` | Blocks: cannot support adoption claims |
| `vendor_self_reported` | Downgrade: usable→context if single-vendor |
| `duplicate_reporting` | Penalty: non-representative cluster members downgraded one level |
| `conflicting_evidence` | Downgrade: to context level |
| `narrow_time_window` | Warning: noted in viewpoint caveat |

---

## Reasoning Process

**Step 1:** Run hard-fail admissibility gates. Any fail → `archive`.

**Step 2:** Check `direct_demonstration` and `concrete_claim`. Both false → `context_only`.

**Step 3:** Check source-type permissions. `governance_signal` with `evidence_type = "incident_event"` → `source_type_fit = false` (LLM or rule) → `archive`.

**Step 4:** Apply limitations. Does the item have `lab_only`? → `usable` at best, no `adoption_support`.

**Step 5:** Is the item a non-representative duplicate? → Downgrade one strength level.

**Step 6:** Assign `evidence_strength` and build `permitted_uses`.

---

## What Strong Looks Like

A strong evidence item has all of:
- Source quote verified and specific (names a tool, actor, CVE, or count)
- `direct_demonstration = true` (something was done, not just theorised)
- `concrete_claim = true` (named entities or statistics present)
- Source type consistent with claim type (incident source proving incident, not governance source proving attack)
- No blocking limitations

**Example:** `ev_src_nist_pi_2026_1` — NIST advisory documenting 3 incidents by name with source quote.

---

## What Weak Looks Like

Weak evidence:
- Secondary reporting with no unique facts (duplicate_reporting)
- Research paper demonstrating capability without observed adversary use
- Governance document citing "AI risks" without incident evidence
- Source saying "attackers could use AI to..." (speculative without direct_demonstration)
- Vendor report claiming "our product stopped X attacks" without independent corroboration

---

## Reject / Downgrade Conditions

- Archive (hard reject): compound, generic, speculative, marketing, no-quote, source_type mismatch
- Downgrade to context: governance source making threat activity claim; context_only admissibility
- Downgrade one level: non-representative duplicate cluster member; vendor_self_reported single source

---

## Edge Cases

**What if a research paper includes a real CVE?**
The CVE makes the claim concrete. `concrete_claim = true`. If `direct_demonstration = true` (the paper demonstrates exploitation), the item is `strong`. But: `permitted_uses` does NOT include `adoption_support` because no adversary use is observed. The item can prove capability, not adversary adoption.

**What if a single NIST advisory documents an attack?**
Single-source limitation applies: `single_source`. But for adoption claims, NIST incidents are granted `adoption_support` because NIST is a `primary` trust tier source and incident events with `observed_use = true`. The limitation reduces strength from strong to usable for most claims, but adoption claims can still use this item.

**What if there are conflicting_evidence items?**
Both items are downgraded to `usable`. The viewpoint LLM is told about the conflict. The resulting claim has `caveat_if_any = "conflicting evidence — treat with caution"`.

---

## Failure Modes

- **False negatives:** High-quality items with hedged language may fail the speculative-language gate. The pipeline has known false-rejection for items where authors use academic hedging ("may contribute to") about something they actually demonstrated.
- **False positives:** A well-formatted but inaccurate vendor claim might pass all gates. The `vendor_self_reported` limitation partially addresses this, but single-vendor incident reports can still drive claims.
- **Duplicate cluster errors:** If two items about the same event are not clustered (because they don't share enough tokens), both may be promoted. The duplicate penalty won't apply.

---

## QA / Validation

- `qaEvidenceItems.js` runs deterministic post-processing: removes items with missing required fields, validates evidence_type against profile, flags generic facts
- `qaEvidenceLlm.js` optionally runs a second-model semantic check on borderline items
- `qaSlideContent.js` checks that every evidence_callout in a slide references a real evidence_id

---

## Output Fields

Key fields set by the triage:
- `triage_data.admissibility` — passed / context_only / failed
- `triage_data.evidence_strength` — strong / usable / context / archive
- `triage_data.permitted_uses` — array of allowed uses
- `triage_data.limitations` — array of limitation labels
- `score_data.evidence_score` — backward-compat numeric (strong=80, usable=60, context=30, archive=0)
- `rawfact_priority` — backward-compat label (must_read / high / medium / archive_only)
