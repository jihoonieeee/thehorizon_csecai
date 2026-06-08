# Evidence Quality Philosophy

**Audience:** Engineers, analysts, and reviewers who need to understand the design principles behind the pipeline's evidence model.

---

## Core Principle: Incomplete Is Better Than Unsupported

The pipeline is designed to be honest about what it does not know.

A slide that says "Evidence insufficient — not assessed this period" is more valuable than a slide that fills the gap with speculation. A category with only weak signals produces an `evidence_gap` slide, not an insightful but fabricated `category_viewpoint`.

This is not a limitation — it is a design requirement. Intelligence briefings that overclaim lose credibility the moment a claim is challenged. The pipeline defaults to conservative claims and explicit uncertainty over confident-sounding summaries.

---

## Principle 1: No Quote, No Evidence

An evidence item without a traceable source quote fails the admissibility gate.

Why this matters: Without a source anchor, there is no way to verify the fact after the pipeline runs. The LLM could have hallucinated it. The source could have been misread. A quote provides a deterministic check — if the quote is in the source text, the fact is real.

Short quotes (< 12 characters) also fail, because a 6-word fragment cannot reliably anchor a substantive claim.

---

## Principle 2: No Evidence ID, No Claim

Every claim must cite at least one evidence item by ID. Every slide bullet that makes a factual assertion must trace back to an evidence callout. Every evidence callout must reference a real `evidence_id` from the pipeline corpus.

The slide content LLM is given a list of approved evidence IDs and is prohibited from inventing new ones. The QA layer checks that every `evidence_id` in an evidence callout exists in the approved set. If an ID is invented, it is stripped.

---

## Principle 3: Thin Evidence Creates a Gap, Not an Insight

When a category has few sources, weak evidence, or only context-level signals, the correct output is an `evidence_gap` or `category_not_assessed` slide.

The pipeline does not pad weak categories with speculative analysis. It says: "The evidence this period is insufficient to support a claim for this category." This is actionable intelligence — it tells the analyst where to look harder next period.

---

## Principle 4: LLMs Explain and Prioritize — They Do Not Invent Facts

The LLM's role in this pipeline is constrained:

- Layer 4: classify and tag (controlled vocabulary only)
- Layer 5A: extract atomic facts from source text (not invent them)
- Layer 5A claim chain: generate structured claim fields (priority assigned deterministically)
- Layer 6: write analysis constrained by the analytical state
- Layer 7: render slide language from approved claims and evidence

At no layer is the LLM given permission to introduce new factual claims not present in the corpus. The system prompt for every analytical LLM call contains an explicit prohibition: "Do not introduce facts not provided in the evidence."

---

## Principle 5: Source Type Controls What a Source Can Prove

Different source types have different evidential permissions:

- **Incident reports** can prove adversary use, real-world impact, and operational status.
- **Research papers** can prove capability exists and attack feasibility — they cannot prove adversary adoption without incident evidence.
- **Governance signals** provide framing and regulatory context — they cannot prove threat activity.
- **Vulnerability reports** expose attack surface — they cannot prove exploitation without an incident report.

These permissions are enforced in the triage layer via `permitted_uses`. The claim chain respects them: a claim of `analytical_change = "adoption_moved_forward"` is rejected unless at least one evidence item with `adoption_support` permission is present — and `adoption_support` is only granted to items with `observed_use = true`.

---

## Principle 6: Trend Claims Are Corpus-Limited by Default

Any statement about a trend — "prompt injection is increasing", "agentic attacks are accelerating" — is automatically limited to the collected corpus unless externally validated.

The analytics layer explicitly annotates all frequency claims: "this reflects the source corpus, not external benchmarks." Trend language in slide content is only allowed when:

1. The slide type is `trend_claim`, AND
2. The underlying claim has `claim_type = "trend_claim"`, AND
3. The claim passed the trend claim validation rules: ≥3 non-duplicate evidence items, ≥2 time windows, ≥2 independent publishers

Outside of validated trend claims, the pipeline uses: "observed pattern", "recurring across sources", "the evidence suggests."

---

## Principle 7: Manual Review Is a Safety Valve, Not a Failure

Some evidence items, visual evidence, and external claims cannot be automatically validated:
- Visual evidence where image quality prevents automated assessment
- Vendor self-reported statistics without independent corroboration
- Claims from a single primary source without independent backing

These go into `manual_review_items` — not silently promoted to the deck and not silently discarded. The analyst sees them, can verify them, and can decide whether to include them. This is intentional: the pipeline trusts its automated path for clear cases and escalates ambiguous cases to human judgment.

---

## Principle 8: Visuals Must Be Analytical, Not Decorative

A visual evidence item is only included in a slide if it directly supports a specific claim. Generic AI chip images, stock cybersecurity graphics, and decorative diagrams are classified as `slide_suitability = "reject"`.

The visual evidence evaluator asks: "Does this image contain data, a diagram, or a walkthrough that could not be conveyed equally well in text?" If not, it is rejected.

Charts are classified as `"embed"` only if:
- The data series is visible and legible
- The chart axes are labelled
- The source is attributable
- The visual adds analytical value beyond the slide bullets

Charts requiring data extraction are classified as `"redraw"` — the pipeline extracts the data and recreates the chart, rather than embedding a low-quality screenshot.

---

## Failure Modes This Philosophy Guards Against

| Risk | Guard |
|------|-------|
| LLM inventing evidence IDs | QA strips any evidence_id not in the approved set |
| LLM hallucinating statistics | QA checks every number in bullets against evidence key_facts |
| Trend claims from single sources | Trend claim validation requires ≥3 items, ≥2 publishers |
| Governance documents used as threat evidence | `permitted_uses` restricts governance sources to context_only |
| Vague insights with no traceability | Evidence IDs required on every claim |
| Speculative outlook presented as certain | Outlook slides must separate observed basis from projection |
| Decorative visuals padding the deck | Visual evidence suitability filter rejects non-analytical images |
| Padded weak-category slides | `evidence_insufficient` categories get not_assessed slide, not fabricated slides |

---

## Where the Philosophy Can Still Break Down

This pipeline is not perfect. Known failure modes:

- **False negatives in triage:** The admissibility gate may reject items that are genuinely important but poorly phrased. High-quality analyst sources sometimes use hedged language that looks speculative.
- **False positives in claim priority:** A critical claim requires all 9 gates to pass. If a gate has a logic error, a weak claim could be escalated. The second-model QA is a backstop but not a guarantee.
- **Context evidence leaking into operational claims:** A sophisticated LLM might construct an operational-sounding bullet from a context-only evidence item by paraphrasing rather than citing. The QA layer catches direct citations but cannot catch all indirect uses.
- **Single-source risk:** A high-quality primary source (e.g. NIST) can drive a critical claim. This is by design — NIST incidents are trustworthy. But it creates dependence on that source being accurate.
- **Coverage gaps are not gaps in the threat:** An `evidence_insufficient` classification means the pipeline didn't find strong evidence, not that the threat doesn't exist. Absence of evidence is not evidence of absence.

---

## Related Documentation

- [`source-to-slide-flow.md`](source-to-slide-flow.md) — concrete examples of evidence decisions
- [`../05-evidence/rawfact-evidence-importance.md`](../05-evidence/rawfact-evidence-importance.md) — how triage decisions are made
- [`../09-appendix/known-limitations.md`](../09-appendix/known-limitations.md) — full list of known limitations

