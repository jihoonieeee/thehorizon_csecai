# `extraction/` — Layer 5: source-aware evidence extraction

Transforms individual classified sources into atomic, quote-grounded evidence items.
Pure source-in → evidence-items-out: no cross-source reasoning, no strategic judgments.
Everything here runs before `analysis/` picks up the items.

## Routing

`extractEvidence.js` is the entry point and router. After the eligibility gate, it
dispatches to a specialist extractor based on `source.source_family`, which is set
by `classifySourceFamily()` in `lib/pipeline/understand/classifySourceFamily.js`
during the understand layer.

```
source.source_family
  atlas_case_study            → extractAtlasEvidence.js       (structured 2-pass)
  academic_paper              → extractAcademicEvidence.js     (research-value gate + academic prompt)
  threat_intel_report         → extractThreatIntelEvidence.js  (epistemic type + attribution confidence)
  major_capability_announcement → extractCapabilityEvidence.js (capability vs marketing_claim labels)
  roundup_digest              → extractRoundupEvidence.js      (segment then extract per story)
  corporate_blog              → extractCorporateBlogEvidence.js (post-type routing wrapper)
  news_blog / unknown         → generic LLM path (extract-evidence.md)
```

The pre-computed report_analysis fast path (for sources with `intelligence.report_analysis`)
takes priority over the router — no LLM call for these sources.

## Files

| File | What it does |
|------|--------------|
| `extractEvidence.js` | Entry point, eligibility gate, router, Jaccard dedup, pack assembly, caching |
| `extractAtlasEvidence.js` | MITRE ATLAS case studies (deterministic chain + LLM incident pass) |
| `extractAcademicEvidence.js` | arXiv / academic papers with research-value gate |
| `extractThreatIntelEvidence.js` | Threat intel reports (Mandiant, GTIG, CISA, etc.) |
| `extractCapabilityEvidence.js` | Major AI capability announcements (OpenAI, Google, etc.) |
| `extractRoundupEvidence.js` | Multi-story digest articles (segment then extract) |
| `extractCorporateBlogEvidence.js` | Corporate blog routing wrapper (classifies post type, delegates) |
| `academicRelevanceGate.js` | Pass/skip gate for academic papers (deterministic + optional Haiku) |

## Evidence item schema

Every item shares the core schema regardless of specialist extractor:

| Field | Type | Notes |
|-------|------|-------|
| `evidence_id` | string | `ev-<8char-id>-<idx>` |
| `fact` | string ≤500 | One atomic proposition |
| `quote` | string ≤300 | Verbatim span proving the fact |
| `quote_grounded` | boolean | Verified against source text |
| `evidence_type` | enum(8) | incident / capability_demonstration / … |
| `specificity` | high/medium/low | |
| `numbers[]` | array | Each with `grounded` flag |
| `technique_tags[]` | array | Validated taxonomy tag IDs |
| `entities[]` | array | Named entities |
| `event_date` | ISO date or null | When event occurred, NOT publication date |
| `time_basis` | enum | event_date / publication_date / unknown |
| `claim_epistemic_type` | enum(5) | observed_fact / author_analysis / forecast / marketing_claim / inference |
| `source_family` | string | Propagated from source routing decision |

### Specialist sub-objects (transparent to synthesis)

**`research_metadata`** — on academic paper items:
- `maturity`: research / demonstrated / weaponized / observed / operational
- `reproducibility`: public_code / methodology_only / none_stated
- `novelty`: new_attack / new_surface / feasibility_shift / measurement / incremental
- `boundary_conditions`: string

**`campaign_metadata`** — on threat intel items:
- `attribution_confidence`: high / medium / low / unknown
- `campaign_name`: string or null
- `is_analytic_judgment`: boolean

## Prompts

All prompts live in `lib/prompts/extraction/`:

| Prompt file | Used by |
|-------------|---------|
| `extract-evidence-news.md` | Generic news/blog path + roundup per-segment pass |
| `extract-evidence-atlas.md` | ATLAS LLM incident pass |
| `extract-evidence-academic.md` | Academic specialist |
| `extract-evidence-threat-intel.md` | Threat intel specialist |
| `extract-evidence-capability.md` | Capability announcement specialist |
| `extract-evidence-roundup.md` | Roundup segmentation pass |
| `extract-evidence-corporate-blog.md` | Corporate blog post-type classification |

## Caching

`extractAllEvidence()` accepts a `supabase` option. When provided, it persists
extracted items per source and only re-runs sources whose `full_text` hash changed
(`lib/storage/evidenceStore.js`).

## Not here

- Pattern clustering → `analysis/extractPatterns.js`
- Strategic synthesis → `analysis/synthesizeCategory.js`
- Dashboard insights → `scripts/generateDashboardInsights.js` (separate pipeline)
- Source family classification → `lib/pipeline/understand/classifySourceFamily.js`
