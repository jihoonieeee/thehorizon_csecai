# docs/testruns — 5-Source Debug Batch System

This directory holds layer-by-layer debug reports for 5-source pipeline test runs.
Each run produces 12 Markdown reports, JSON checkpoints per layer, and an audit
findings summary. Use these to audit pipeline quality without reading raw JSON.

---

## How to Run

```bash
# Default: 5 sources, latest from data/sample_sources.json, no LLM (deterministic)
npm run test:debug5

# Random selection of 5 sources
npm run test:debug5 -- --batch random

# Use only built-in synthetic fixture sources
npm run test:debug5 -- --batch fixtures

# Filter by source type
npm run test:debug5 -- --source-type research_finding
npm run test:debug5 -- --source-type incident

# Custom run ID (useful for repeating a specific scenario)
npm run test:debug5 -- --run-id my_test_name

# Enable real LLM calls (requires API keys in .env)
npm run test:debug5 -- --with-llm

# Skip slide generation (faster — stops after L6)
npm run test:debug5 -- --no-slides

# Write LLM prompt traces (useful for debugging bad outputs)
npm run test:debug5 -- --with-llm --trace-prompts

# Compare two runs
npm run test:debug5:diff -- --run-a debug5-2026-06-16-12-00-00 --run-b debug5-2026-06-16-13-00-00
```

---

## Output Folder Structure

```
docs/testruns/<run_id>/
  00_run_summary.md           — overview: counts, status, key findings
  01_L1_ingestion.md          — sources loaded, trust tiers, text lengths
  02_L2_cleaning.md           — IOC extraction, text reduction, code blocks
  03_L3_validation.md         — pass/review/reject per source, relevance verdict, novelty path
  04_L4_taxonomy.md           — domain, tags, supporting quotes, QA verdicts
  05_L5_evidence.md           — extracted facts, quotes, admissibility, claim permissions
  05b_L5B_analytics.md        — corpus-level analytics, frequency, trends
  06_L6_analysis.md           — strategic judgments, reasoning chains, blocked claims
  07_dashboard_intelligence.md — ApprovedIntelligenceObjects, approval flags, rejections
  08_L7_deck_planning.md      — slide plan, argument forms, reasoning chain selection
  09_L8_narrative.md          — generated headlines, bullets, speaker notes, QA
  10_L9_export_qa.md          — citation check, number verification, export blockers
  11_audit_findings.md        — top issues, root causes, recommended fixes
  checkpoints/
    L1.json  L2.json  L3.json  L4.json  L5.json  L6.json
    dashboard.json  L7.json  L8.json  L9.json
  prompt_traces/              — (only when --trace-prompts is set)
    L3_source_relevance_<id>.md
    L4_source_understanding_<id>.md
    L5A_evidence_extraction_<id>.md
    L6_category_synthesis_<id>.md
    ...
```

---

## How to Trace Source → Evidence → Intelligence Object → Slide/Dashboard

Every piece of information in the output is traceable. Here's the full chain:

### 1. Find the source

In `01_L1_ingestion.md`, each source is listed with its `source_id`, `title`, `publisher`, and `url`.

### 2. See what the source produced in L4

In `04_L4_taxonomy.md`, find the source by title. It shows:
- The threat domain assigned
- Taxonomy tags with supporting quotes
- QA verdicts (confirmed / downgraded / removed)
- The `taxonomy_validation_status`

### 3. See what evidence was extracted from the source

In `05_L5_evidence.md`, find the source section. It shows:
- Each extracted evidence item: `fact`, `source_quote`, `evidence_type`
- `admissibility` (passed / context_only / failed)
- `claim_permissions.permitted_uses` and `blocked_uses`
- `analytical_hooks` (what the LLM noticed as significant)
- `qa_status` and `qa_reasons`

### 4. See which strategic judgment used this evidence

In `06_L6_analysis.md`, find the category for this source. Judgments list:
- `supporting_evidence_ids[]` — the `evidence_id` values from L5
- `what_changed`, `causal_mechanism`, `why_it_matters`
- `evidence_for[]`, `evidence_against[]`
- Whether the judgment passed QA or was blocked

### 5. See whether the intelligence object was approved

In `07_dashboard_intelligence.md`:
- `approved_for_dashboard`, `approved_for_chatbot`, `approved_for_slides`
- `rejection_reason` if blocked
- `source_links[]` — back to the original article URL
- `supporting_evidence_ids[]` — the canonical evidence chain

### 6. See what went on slides

In `09_L8_narrative.md`:
- Each slide shows `headline`, `bullets[]`, `evidence_callouts[]`
- `citations[]` list the `evidence_id` values cited
- `speaker_notes` and `speaker_notes_structured`

### The full chain (text format)

```
source URL (01_L1)
  → source_id
  → taxonomy tags + quotes (04_L4)
  → evidence_id: ev_<source_id>_<hash> (05_L5)
  → supporting_evidence_ids in judgment (06_L6)
  → intel_id in intelligence object (07_dashboard)
  → citations in slide (09_L8)
```

---

## How to Read Each Report

### 03_L3_validation.md — What to look for

- All sources should be `pass` or `review`. `reject` in a 5-source run is a quality concern.
- `novelty_path = novelty_signal` means the source was caught by the novelty track (new technique pattern).
- `ai_threat_focus = none` causes rejection. Check if source text is too thin or off-topic.
- `candidate_domain` should match what you expect for the source topic.

### 04_L4_taxonomy.md — What to look for

- Every accepted tag should have a non-empty `supporting_quote`.
- Tags with `evidence_basis = weak_inference` are excluded from `primary_tags`.
- `taxonomy_validation_status = no_tags_found` means the source passed L3 but L4 couldn't categorize it.
- `QA verdict = removed` means Gemini Flash disagreed with the Haiku tag assignment.

### 05_L5_evidence.md — What to look for

- `admissibility = failed` means the item has no usable quote or failed a structural gate.
- `limitations: lab_only` means the evidence cannot support real-world adoption claims.
- `claim_permissions.blocked_uses` lists what this evidence cannot support — check for unexpected blocks.
- High `archive` rate (>50% of items) is a quality red flag.
- `analytical_hooks` shows what the LLM considered significant — check if these are sensible.

### 06_L6_analysis.md — What to look for

- `analytical_quality = summary_only` or `descriptive` means the judgment is blocked.
- A good judgment has `what_changed`, `causal_mechanism`, `why_it_matters`, and `uncertainty`.
- `blocked_claims_by_qa` lists claims the pipeline rejected and why.
- Zero judgments for a category = evidence was insufficient or all claims were blocked.

### 07_dashboard_intelligence.md — What to look for

- `approved_for_dashboard = false` means the intelligence object won't appear on the main dashboard.
- `rejection_reason` explains why (usually `analytical_quality too low` or `no resolved supporting evidence`).
- `url_trace_failures` = intelligence objects with no verifiable source URL (traceability broken).
- Check that `approved_for_chatbot = true` for objects you want the chatbot to use.

### 11_audit_findings.md — Your action list

This file summarises the top issues found in this run:
- **HIGH** = blocking issues; pipeline output may be unreliable
- **MEDIUM** = quality concerns; output is usable but could be better
- **LOW** = informational; minor improvements available

---

## How to Compare Two Runs

```bash
npm run test:debug5:diff -- --run-a <run_id_1> --run-b <run_id_2>
```

This writes `docs/testruns/diff_<A>_vs_<B>.md` comparing:
- Source routing (pass/review/reject)
- Evidence strength distribution
- Judgment counts and blocked claims
- Dashboard approval rates
- Slide and export QA failures

Useful for:
- Checking whether a pipeline change improved or regressed output quality
- Comparing LLM vs. deterministic mode
- Comparing different source batches

---

## What to Paste into a LLM for Deeper Audit

For a systematic quality review of a run, paste these files:
1. `06_L6_analysis.md` — ask "Are these strategic judgments analytical or just descriptions?"
2. `07_dashboard_intelligence.md` — ask "Are the approval decisions consistent with the evidence?"
3. `11_audit_findings.md` — ask "What are the root causes of these issues?"
4. `05_L5_evidence.md` — ask "Are these evidence items concrete or vague?"

---

## Environment Setup for LLM Runs

By default, all LLM calls are skipped (deterministic mode). To run with real LLM calls:

```bash
# .env file (copy from .env.example)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...

# Then run with LLM enabled
npm run test:debug5 -- --with-llm
```

LLM mode produces richer reports (actual taxonomy tags, real evidence extraction,
strategic judgments with reasoning chains) but costs API credits and takes longer.

Deterministic mode is fast (~5 seconds for 5 sources) and good for testing
pipeline mechanics without spending API budget.
