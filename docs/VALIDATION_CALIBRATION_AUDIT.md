# Validation Calibration Audit (P1–P5)

> **Date:** 2026-06-22
> **Question:** Is the corpus imbalance a *feed* problem or a *validation* problem?
> **Answer:** Mostly validation — but validation alone does **not** solve 80% of it.
> Live numbers from Supabase `sources` (n=1,752; pass=1,037, review=321, reject=199, null=195).

The corpus audit (`docs/CORPUS_COMPOSITION_AUDIT.md`) established the symptom:
arXiv+NVD pass at 87.7%, operational RSS at 9.8%; 641 operational sources ingested,
63 passed. This document audits **why**, with worked examples and a quantified
recovery simulation.

---

## P1 — The AI-relevance gate is a single-axis "AI as subject" test

### Mechanism

The gate is two stages:

1. **`aiRelevance.js → runRelevanceLlm()`** (Haiku) reads each source and returns
   `ai_threat_focus ∈ {central, passing, none}` (prompt: `validation-relevance.md`).
2. **`FOCUS_TIER`** (`aiRelevance.js:344`) maps that verdict to a relevance tier:

   ```
   central → relevance_tier "core",      ai_specificity 80
   passing → relevance_tier "off_topic", ai_specificity 20   ← collapses to off_topic
   none    → relevance_tier "off_topic", ai_specificity 5
   ```

3. **`finalGate.js:119`** then routes `off_topic`:
   - `primary`/`curated` → **review** (never pass)
   - `high` → **review** iff `ai_specificity ≥ 5`, else **reject**
   - `medium`/`low` → **reject**

So **only `central` reaches `pass`.** Everything the LLM calls "passing" — AI is
present but not the article's main subject — is `off_topic`, and the best an
operational source can get is `review` (which the deck never reads, see P2).

### Why this is the wrong axis for a horizon scan

The prompt asks one question — *"is an AI/ML threat the **subject**?"* — and
explicitly instructs: *"A source that merely uses the word 'AI' or names a model
while being about an unrelated breach … is 'passing', NOT 'central'."*

A horizon scan needs **four AI roles**, only one of which is "subject":

| Role | Example source | LLM verdict today | Should be |
|---|---|---|---|
| **AI as subject** | arXiv paper on a new prompt-injection method | central → **pass** | pass ✓ |
| **AI as attack tool** | Unit 42: ransomware crew used an LLM to write loaders | "about ransomware" → **passing → review/reject** | relevant |
| **AI as target** | NVD CVE in an agent framework's tool allowlist | often central (CVE+AI) → pass; but NVD CVEs *without* AI vocab → passing | relevant |
| **AI as enabling tech** | The Record: deepfake-voice CEO fraud nets $25M | "about fraud" → **passing → review/reject** | relevant |

For `ai_enabled_threats` — the most operational category — **AI is *never* the
subject**; the incident/campaign is. The central/passing test therefore
structurally rejects the exact evidence that category needs. This is why
`ai_enabled_threats` is the smallest pass bucket (35 sources).

### Worked traces (pass / review / reject)

**PASSES** — *arXiv: "Adversarial Suffixes Transfer Across Aligned LLMs"*
`ai_high` keyword hits ("llm", "adversarial", "jailbreak") → pre-gate `high` →
LLM: subject **is** the attack → `central` → `core` → **pass**. AI-as-subject;
the gate is tuned for exactly this.

**REVIEWED (then invisible)** — *Unit 42 (high trust): "Agonizing Serpens uses
GPT-generated phishing in espionage campaign"*
Pre-gate clears (`ai_medium` "generative ai" + `cyber_high` "phishing"/"campaign").
LLM: the article is *about an espionage campaign*; the GPT angle is one tactic →
`passing` → `off_topic`, `ai_specificity 20`. `finalGate`: high trust + spec ≥ 5 →
**review → `layer4_with_review`**. Never enters the deck (P2). *This is AI-as-tool
evidence being thrown away.*

**REJECTED** — *BleepingComputer (medium trust): "Voice-cloning scam drains bank
accounts"*
Pre-gate may clear on `ai_low`+`cyber_high`. LLM: about a scam, AI voice cloning
incidental → `passing` → `off_topic`. `finalGate`: medium trust + off_topic →
**reject → discard**. AI-as-enabling-tech evidence, gone for good.

### P1 fix

Replace the binary subject test with a **role-aware relevance** verdict. Concretely
(lowest-risk version): in `finalGate.js`, for `high`/`primary` trust sources whose
`source_type` is operational (`incident`, `threat_intelligence`, `vulnerability`,
`exploit_disclosure`, `adversary_adoption_signal`) **and** that carry any AI nexus
(`passing` with `ai_specificity ≥ 20`, or a novelty-signal path), route to **pass**
instead of review. Optionally extend the relevance prompt to emit
`ai_role ∈ {subject, attack_tool, target, enabling_tech, none}` and treat the
first four as relevant. *Behaviour-changing — ship behind a flag and re-measure.*

---

## P2 — `validation_status = 'pass'` usage audit

Consumers that hard-filter `pass` (so `review`/`null` are invisible):

| Consumer | Line | Role |
|---|---|---|
| `scripts/runSynthesisOnly.js` | :86 | **the scheduled deck/synthesis job** |
| `scripts/generateDashboardInsights.js` | :246 | dashboard insight cron |
| `api/dashboard.js` | :198, :251 | dashboard API |
| `lib/agent/agentTools.js` | :99 | Ask-Agent chatbot |
| `scripts/understandCorpus.js` | :56 | **enrichment — only `pass` gets LLM enrichment** |

Already lenient: `api/sources.js:61` uses `.not(eq 'reject')` — the source browser
**already shows `review` + `null`**; only the analytical layers exclude them.

**Consequence of `understandCorpus.js:56`:** `review`/`null` sources never receive
`short_summary`/`intelligence`, so even if surfaced they'd be thin. Recovery must
re-enrich, not just re-label.

**Recommendation:** for the analytical consumers, change the filter to include
`review` **for high/primary trust operational source_types**, e.g.

```sql
validation_status = 'pass'
OR (validation_status = 'review'
    AND trust_tier IN ('primary','high')
    AND source_type IN ('incident','threat_intelligence','vulnerability',
                        'exploit_disclosure','adversary_adoption_signal',
                        'governance_signal'))
```

and widen `understandCorpus`'s selection to match so those rows get enriched. This is
strictly additive — it cannot remove anything currently shown.

---

## P3 — The 195 `null` sources

**They were never validated at all.** `ai_threat_focus` and `relevance_tier` are
`null` on **all 195** — Layer 3 never ran. Root cause: they were saved with
`validation_status = null` (RSS/sitemap ingest default), and the only
re-processing job, `understandCorpus.js`, selects `validation_status = 'pass'` — so
nothing ever picks them up. They are orphaned between ingest and validation.

| Dimension | Breakdown |
|---|---|
| Trust | medium 161, high 34 |
| Type | security_blog 97, news_article 60, threat_intel 16, news 7, research_finding 6, … |
| Text | **107 have ≥300 chars (validatable now)**, 84 thin (1–299), 4 empty |
| Publishers | The Hacker News 51, Dark Reading 26, BleepingComputer 25, Help Net 25, SecurityWeek 18, Malwarebytes 16, AI Incident DB 10 |

These are **the incident/news outlets** — exactly the operational evidence the
corpus lacks. But 161/195 are `medium` trust, and under the *current* gate
medium-trust `off_topic` → reject. So the **recovery rate of the null pool is low
unless P1 lands**: validate-as-is recovers mainly the 34 high-trust nulls; the
157 medium-trust incident-outlet nulls need the P1 calibration (or a trust bump)
to survive. Cost to attempt: ~191 Haiku relevance calls (the 4 empty are
un-validatable). Estimated recovery: **~15–25 sources as-is; ~70–110 if P1 lands**
(the medium-trust incident outlets become eligible).

---

## P4 — Category & composition impact simulation

Recovery candidate pool = `(review OR null)` ∧ `trust ∈ {high,primary}` ∧
operational `source_type` ∧ `full_text ≥ 300` → **105 sources**. By bucket:
threat_intelligence 44, government 40, vendor_advisory 16, vulnerability 4,
operational_campaign 1. (Note `review` is 299/321 high-or-primary trust;
`ai_threat_focus` on review = none 122, **passing 114**, null 72, central 13 — the
114 "passing" are the AI-as-tool sources P1 targets.)

**Composition — pass-only vs. pass + recovered @60%:**

| Bucket | Pass-only | + Recovered | Target |
|---|---:|---:|---|
| Research | 60.6% | **57.1%** | 20–40% |
| Vulnerability | 33.3% | 31.5% | 20–30% |
| Incident | 0.1% | **0.1%** | 15–25% |
| Threat Intelligence | 0.4% | **3.4%** | 10–20% |
| Operational Campaign | 0.1% | 0.1% | 5–15% |
| Vendor Advisory | 4.5% | 4.8% | 5–15% |
| Government | 0.5% | **2.5%** | 5–15% |

**Category counts — pass-only vs. +recovered @60%:**

| Category | Pass | +Recovered |
|---|---:|---:|
| traditional_ai_threats | 113 | 116 |
| llm_threats | 400 | 400 |
| agentic_ai_threats | 473 | 474 |
| **ai_enabled_threats** | **35** | **42 (+20%)** |

So validation recovery: TI **8.5×** (0.4→3.4%), government **5×** (0.5→2.5%),
ai_enabled **+20%**, and research drops below 60%. Real, useful — but **incident
stays flat** (almost no incident-*typed* high-trust sources exist; the incident
outlets are medium-trust nulls), and every operational bucket remains **below
target**.

---

## P5 — Does fixing validation alone solve 80% of the imbalance? **No — ~15–25%.**

The arithmetic is decisive. The entire recoverable operational pool is ~105
sources (≈63 at 60% recovery) against **974 arXiv+NVD pass sources**. You cannot
rebalance a 974-source research/vuln corpus with ~63 recovered sources:

- Research only falls 60.6% → 57.1% (target ≤40%). Gap closed: **~15%.**
- TI reaches 3.4% (target 10–20%). Gap closed: **~25%.**
- Incident is **unchanged** (~0% of the gap closed) — the supply isn't in the DB.
- No bucket reaches its target band.

**Conclusion:** validation calibration is **necessary but not sufficient.** It
stops the system from *throwing away* operational evidence and recovers the
highest-value sources already in the DB (primarily TI + government), but the
operational *supply* in the database (~170 operational sources total across
pass+review+null) is too thin to hit the diversity targets. Reaching them requires
**all three**, in order:

1. **P1 + P2 — fix the gate & consume review** (necessary first; otherwise
   anything backfilled lands in `review`/`reject` too — confirmed: sitemap
   backfill writes `validation_status='review'` by default, `backfillFromSitemaps.js:424`).
2. **P3 — re-validate the 195 null** (free recovery of what's already ingested).
3. **P4-feeds — historical backfill** (`backfillFromSitemaps.js`) to grow the
   operational supply 5–10×, *plus* down-sampling arXiv so research stops
   dominating by raw count.

Validation fixes the *pass-rate*; only backfill fixes the *supply*. Both are
required; neither alone reaches the targets.

---

## Implemented & measured (2026-06-22)

P1 gate fix and a recovery run were applied and measured against live data:

- **P1 code:** `finalGate.js` now passes high/primary-trust operational source_types
  with a real AI nexus (`ai_specificity ≥ 20`) instead of routing to review.
  Additive, kill-switch `OPERATIONAL_GATE_OFF=1`. 28/28 validation tests pass.
- **Recovery run:** `scripts/revalidateBacklog.js` re-validated 196 non-pass
  high/primary operational sources under the new gate → **23 recovered to `pass`**
  (11.7%): Google GTIG AI Threat Tracker, Mandiant M-Trends 2026, Unit 42
  (Operation FlutterBridge, PAN-OS exploitation), Recorded Future, CrowdStrike,
  Open WebUI / AutoGPT CVEs, Microsoft "AutoJack" agent RCE, OpenAI PRC influence-op
  report. (It also corrected mis-rejected CISA advisories `reject→review`.)
- **Measured corpus delta:** pass **1,037 → 1,062**; operational (non-arXiv/NVD)
  pass **63 → 84 (+33%)**; Threat Intelligence **0.4% → 1.4%** (3.5×); Government
  **0.5% → 0.9%**; Research **60.6% → 59.1%**.

This **confirms P5 empirically**: validation recovery is real and high-value but
**insufficient alone** — research is still 59%, every operational bucket is still
below target, and arXiv+NVD are still 92% of the corpus. Backfill depth (P4) +
arXiv down-sampling remain required to reach the diversity targets.

### Backfill (Jan 2026 → now) + second recovery pass

- **Backfill:** `backfillFromSitemaps.js --days 180 --limit 250` ingested **367
  historical operational sources** (Talos, The Record, 404 Media, DFRLab,
  SentinelOne, …), saved as `review` (sitemap default).
- **Recovery over the new backlog:** of 347 re-validated, **0 promoted to pass** —
  not a bug: the pre-gate (`hasAiSignal`) correctly identified them as **non-AI
  content** (DFRLab Russia/disinfo war reports, CISA ICS advisories for
  Schneider/Siemens, Talos general security). Only 2 had any AI signal; both
  stayed `review`. The mechanism works (it recovered 23 high-AI-nexus TI sources
  in the prior pass) — these publishers' *full history* is simply low-AI-fraction.
- **Net corpus (start → final):** rows 1,752 → **2,140**; pass 1,037 → **1,077**;
  operational (non-arXiv/NVD) pass **63 → 99 (+57%)**; Incident 0.1→**0.6%**, TI
  0.4→**1.6%**, Government 0.5→**1.3%**, Operational Campaign 0.1→**0.5%**;
  Research 60.6→**58.4%**; top-2 publisher 93.9→**90.8%**.

**This is the decisive empirical answer to the user's question:** fixing
validation + backfilling depth moved operational pass +57% and nudged every
operational bucket up, but **did not** reach the diversity targets — because the
AI-relevant fraction of general-security feeds is low. Reaching the targets needs
**AI-targeted operational supply** (vendor TI tagged for AI campaigns, AI-incident
trackers) plus **arXiv down-sampling**, not just more general feeds. Validation was
necessary; supply quality is the remaining lever.

> Lesson learned (documented so it isn't repeated): the first recovery run
> mistakenly rejected 196 sources because the loader used a column subset that
> omitted `url`, making `checkSourceValidity` hard-fail before the LLM ran.
> `revalidateBacklog.js` now `select('*')`s the full row. Always pass the complete
> source row to `validateAndTypeSource`.

### Appendix — recovery candidate definition

`(validation_status = 'review' OR validation_status IS NULL)` AND
`trust_tier IN ('high','primary')` AND `source_type` operational AND
`length(full_text) ≥ 300`. Recovery rates modelled at 50% (+53) and 70% (+74);
category/composition tables use 60%. These are conservative — they exclude the
157 medium-trust incident-outlet nulls that P1 would make eligible (which is the
upside case for the Incident bucket).
