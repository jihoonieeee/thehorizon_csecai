# Layer 5 — Evidence Branches Overview (5A / 5B / 5C / 5E)

**Audience:** Supervisors and engineers who need the *logic*, not the code.
**Deep dives:** `rawfact-evidence-importance.md` (5A), `analytics-index-logic.md` (5B),
`layer-5c-web-evidence.md` (5C), `layer-5e-evidence-search.md` (5E).

After Layer 4 tags every source, three branches turn the corpus into evidence for Layer 6
(analysis) and Layer 7 (slides). They run as branches and converge in synthesis:
**5A → 5B → 5C → fuse → Layer 6.** Each answers a different question. (Layer 5E, a separate
external-statistics search, has been **merged into 5C** — see below.)

| Branch | Question it answers | Unit | HOW it decides | Uses LLM? |
|---|---|---|---|---|
| **5A Rawfacts** | "What concrete facts does *our corpus* state, and how strong is each?" | per source | extraction + per-item judgement, then deterministic gates | **Yes** (extraction + judgement); rules enforce |
| **5B Analytics** | "What patterns/frequencies/trends appear *across* the corpus?" | whole corpus | pure arithmetic over per-source features | **No** (aggregation); features came from earlier cheap-LLM passes |
| **5C Web Evidence** *(single external branch — absorbed 5E)* | "What external evidence — case studies, walkthroughs, **statistics**, and real visuals — fills our gaps?" | per gap/category | search → open → extract → validate → select pipeline | **Partly** (cheap models + deterministic; frontier QA on shortlist) |

---

## 5A — Rawfacts (in-corpus evidence)

- **Produces:** discrete, source-grounded evidence items (one atomic fact + verbatim quote each),
  each triaged into a strength bucket **strong / usable / context / archive** with `permitted_uses[]`
  and `limitations[]`; plus normalized taxonomy rawfact rows.
- **HOW importance is judged — hybrid, not a score:**
  1. A cheap LLM *extracts* the facts/quotes/entities/numbers.
  2. A cheap per-source LLM (Haiku) *judges* the semantic fields rules can't infer: was it
     **demonstrated vs theorised** (`direct_demonstration`), is it **concrete**, does it **fit the
     source type**, is there **observed real-world use**, and what **limitations** apply.
  3. **Deterministic gates enforce the verdict:** hard admissibility gates, a per-source-type
     permission table (`sourceTypeClaimPermissions.js`) that caps which `permitted_uses` are even
     possible and whether an item can be `strong`, the observed-use rule, and limitation handling.
  - No LLM / `skipLlm` → deterministic inference fallback (lower precision, still runs).
- **Provides to L6/L7:** the evidence items + buckets that let claims be built and cited; only
  `strong`/`usable` items can anchor claims, `context` only frames. **Source type sets the ceiling;
  the LLM judgement decides whether an item reaches it.**

## 5B — Analytics (corpus-level structure)

- **Produces:** corpus distributions — tag/sub-technique/AI-role frequencies, attack-vector/surface
  counts, maturity, monthly timelines/trends, coverage matrix, and `visualization_specs` (chart data).
- **HOW:** **deterministic aggregation only** — counts, frequencies, weighted counts (trust-tier
  weight, also emitted unweighted), cross-tabs. **No model, no learned index.** Each "index" is a named
  arithmetic function shipped with caveats. Trend claims require **≥3 non-empty month buckets**, else the
  gap is reported; all language is corpus-scoped ("within the collected corpus").
- **Provides to L6/L7:** the quantitative backbone (what's frequent/rising/thin) and the chart specs
  the slide layer renders. Honest by construction (every count carries its limitation).

## 5E — External Evidence Search — **merged into 5C**

The old Layer 5E made one frontier `web_search` call per category to fetch authoritative
statistics. It overlapped 5C (both fetched external evidence + visuals per category through
parallel channels). It has been **retired and folded into 5C's gap-driven missions**: 5C now
also extracts grounded statistics (metric + value + timeframe + source + verbatim quote), and a
small adapter maps 5C's output into the `externalEvidence` shape the synthesis consumers expect
(`analytics_references`, `evidence_inventory`, `category_evidence_summary`, pack citations).
The deck keeps external **statistics callouts + real figures**; the old synthetic "redraw a chart
from data_points" path is dropped in favour of embedding the real figure.

## 5C — Web Evidence (the single external-evidence branch)

- **Produces, per category:** a `web_evidence` section `{ evidence_items, visual_evidence }` of
  concrete incidents, exploit/attack **walkthroughs**, vulnerabilities, benchmarks, **statistics**,
  plus **real embeddable visuals** (screenshots, figures, tables) packaged as slide assets.
- **HOW:** a full pipeline, **gap-driven** (only searches for what 5A/5B are missing per category):
  multi-provider search (Tavily/SerpAPI) → open & cache the page → trace the *original* source →
  extract claim + verbatim quotes + visual candidates → anti-hallucination validation → **categorical
  depth** `thin/concrete/detailed/walkthrough_grade` and **categorical visual usefulness** → cluster →
  select (caps per category). **Mostly deterministic + cheap models; a frontier model does QA only**, on
  the shortlist. Depth and usefulness are **categorical, not scored**; only `concrete+` text and
  `medium/high`, claim-bound visuals reach Layer 6/7. Disable-able and degrades on every failure.
- **HOW:** a full pipeline, **gap-driven** (only searches for what 5A/5B are missing per category):
  multi-provider search (Tavily/SerpAPI) → open & cache the page → trace the *original* source →
  extract claim + verbatim quotes + statistics + visual candidates → anti-hallucination validation →
  **categorical depth** `thin/concrete/detailed/walkthrough_grade` and **categorical visual usefulness** →
  cluster → select (caps per category). **Mostly deterministic + cheap models; a frontier model does QA
  only**, on the shortlist. Depth/usefulness are **categorical, not scored**; only `concrete+` text and
  `medium/high`, claim-bound visuals reach Layer 6/7. A statistic is kept only if its number appears
  verbatim in its quote. Degrades on every failure.
- **Gating:** **auto-enables when a search-provider key (Tavily/SerpAPI) is configured**; graceful no-op
  otherwise. `WEB_EVIDENCE_ENABLED` is an explicit on/off override.
- **Provides to L6/L7:** the **single external-evidence feed** — case studies, attack-chain walkthroughs,
  grounded statistics (→ `analytics_references`, pack citations, numeric callouts), and verified visual
  assets (embed / cite-only / manual-review). Reaches Layer 6 both via its native `web_evidence` dossier
  sections and, through the adapter, via the `externalEvidence` channel the rest of synthesis consumes.

---

## External evidence: one branch

5C is now the **only** external-evidence producer. There is no parallel 5E search: one gap-driven
pipeline fetches case studies, walkthroughs, statistics, and real visuals, with a single grounding
discipline (opened URL + verbatim quote) and one schema. Synthesis order is **5A → 5B → 5C → fuse**;
5C reads the *un-enriched* rawfact packs so its quantitative/visual/case-study **needs** reflect the true
in-corpus gaps, then a thin adapter feeds its output into the existing `externalEvidence` consumers.
