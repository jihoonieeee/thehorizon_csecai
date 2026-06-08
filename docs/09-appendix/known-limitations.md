# Known Limitations

**Audience:** Engineers, analysts, and reviewers aware of the pipeline's boundaries.

This document is intentionally honest. The pipeline is a useful tool, not a perfect oracle.

---

## Evidence Triage

**False negatives — academic hedging:** Research papers use hedged language ("may contribute to", "could be leveraged") even when describing real demonstrated attacks. The admissibility gate treats this as speculative language and may archive items that are actually strong evidence. High-quality academic findings with cautious language can be suppressed.

**False positives — vendor sources:** A well-formatted vendor report with a specific quote and named tools can pass all triage gates. The `vendor_self_reported` limitation partially addresses this, but it relies on the source being correctly typed. Vendor marketing dressed as research may slip through.

**Single primary source:** A critical claim requires one `adoption_support` evidence item. A NIST advisory documenting a single incident can drive a critical claim. This is by design (NIST is highly trusted) but creates a single-source risk if the advisory turns out to be inaccurate.

---

## Claim Chain

**LLM subjectivity in claim fields:** The claim LLM populates structured fields (analytical_change, change_driver, broad_relevance, etc.) before the deterministic priority gate runs. If the LLM consistently mislabels `analytical_change` (e.g. using `capability_increased` when `adoption_moved_forward` is more accurate), claims that should be critical get capped at high. This is hard to audit without running the same sources through multiple models.

**Trend claim strictness:** The trend claim validation rules (≥3 items, ≥2 time windows, ≥2 publishers) are calibrated conservatively. A real trend with 2 strong independent sources doesn't qualify. This is correct for preventing false trend claims but means genuine early trends are reported as "recurring patterns" until the third independent corroboration arrives.

**Duplicate cluster misses:** If two evidence items about the same event are not clustered (e.g. different phrasing, different publishers), both may be treated as independent. This inflates the apparent corroboration of a claim. The Jaccard deduplication threshold (0.40 similarity) is a heuristic and can miss rephrased duplicates.

---

## Analytics

**Corpus-limited trend claims:** All frequency analysis is relative to the ingested corpus. "Prompt injection is the most frequent attack vector" means it appeared most often in sources that reached Layer 3 and were classified in that category. It does not mean it is the most frequent attack vector in the real world. This is always noted on analytics slides.

**Source type classification bias:** The analytics aggregation uses source type to route evidence. Misclassified source types produce incorrect aggregates. arXiv papers are always `research_finding` regardless of whether they describe a real incident. NVD entries are always `vulnerability` even when they include exploitation evidence.

**Small-N problem:** A category with 3 sources has a very wide confidence interval on any statistic. The pipeline does not explicitly report confidence intervals on analytics claims. An analyst reading "prompt_injection: 8 sources" needs to mentally adjust for corpus size.

---

## Slide Generation

**Claim text as headline:** The slide headline is instructed to "derive from claim_text." The QA checks for shared key terms but cannot verify semantic equivalence. A headline that inverts the claim ("LLM defenses are failing" vs "LLM attacks are succeeding") would share key terms and pass QA.

**Speaker notes introduce reasoning not in evidence:** The speaker notes LLM is instructed to "explain the reasoning chain" and "not introduce new facts." In practice, the reasoning explanation sometimes draws connections not explicitly stated in the evidence — these are not facts but analytical inferences. The QA catches new numbers and new source names, but cannot catch every form of implicit fact introduction.

**Outlook projections:** The `outlook_6month` slide requires a separation between observed basis and projected trajectory. The QA checks for marker words ("observed", "suggests", "may"), but a sophisticated LLM could write projections that sound conditional but are actually stronger claims in disguise.

---

## Web Evidence

**Screenshot quality:** Web evidence images are acquired via Playwright screenshot. Screenshot quality depends on page rendering, font loading, and viewport. Charts that render correctly in a browser may be unreadable at the screenshot resolution. The visual usefulness evaluator uses OCR-based assessment, which fails on rendered SVG charts.

**Original source tracing:** When a derivative source (news article, blog post) cites a primary finding, the pipeline attempts to trace to the original source. This tracing is LLM-based and can fail for paywalled content, conference papers, or sources without explicit citation links.

**Gap-fill search relevance:** The web evidence branch searches for evidence to fill corpus gaps. The search queries are generated by an LLM from gap descriptions. A poorly phrased gap description produces irrelevant search results. The quality of gap-fill evidence depends heavily on gap description quality.

---

## Coverage and Bias

**Feed coverage gaps:** The pipeline only knows about sources in its ingestion feeds. Important intelligence from sources not in the registry is missed. The pipeline cannot know what it doesn't ingest.

**Language bias:** The pipeline processes primarily English-language sources. Significant AI security research published in Chinese, Russian, or other languages is not ingested by default connectors.

**Vendor-heavy academic bias:** arXiv AI security research is heavily weighted toward US/Western academic institutions and large AI vendors. This produces a geographic and institutional bias in what counts as "the research consensus."

**Evidence absence ≠ threat absence:** An `evidence_insufficient` classification means the pipeline didn't find strong evidence, not that the threat doesn't exist. Categories with poor feed coverage will systematically appear as gaps even if significant activity is happening outside the pipeline's view.

---

## Operational

**Vercel 10-second timeout:** Most API endpoints run under the Vercel 10-second limit. The full pipeline must run in scripts (not API handlers). This means automated full runs require scheduled execution, not on-demand API calls.

**LLM cost and quota:** All LLM calls consume tokens and quota. A full pipeline run on a large corpus can use significant API budget. The degraded-run technique (`LLM_PROVIDER_ORDER=anthropic --no-persist`) works around exhausted free-tier quotas but produces lower-quality analysis.

**Model quality variance:** Different LLM providers produce materially different claim field outputs. Claude Sonnet produces more conservative and analytically careful viewpoints and claims than gpt-4o-mini. Running the same corpus through different models may produce different claim priorities.
