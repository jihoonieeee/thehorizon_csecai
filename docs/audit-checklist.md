# Corpus Audit Checklist

Per-source review guide for every batch. Apply to each of the 5 sources in order. All issues must be recorded in `docs/database_audit.md` before moving to the next source.

---

## Dimension 1 — Taxonomy (category + every tag)

### 1a. Main category

Ask: what is the **primary victim** and **primary mechanism**?

| Category | When to use |
|----------|------------|
| `ai_enabled_threats` | AI is the **attacker's weapon** against a human/org victim. Deepfakes, AI-generated phishing, AI-orchestrated attacks, jailbreak platforms. |
| `agentic_ai_threats` | The **AI agent** is the victim being manipulated, or the agent's trust/tool model is exploited. Prompt injection, MCP hijacking, config poisoning, sandbox escape, agent supply chain. |
| `traditional_ai_threats` | Attacks **on ML models** themselves — poisoning, extraction, inversion, membership inference, backdoors, evasion. The ML model is the victim. |
| `llm_threats` | LLM-specific: prompt injection at the model level, jailbreaks, RAG poisoning, supply chain in LLM infrastructure, training data poisoning for LLMs. |
| `unclear_or_adjacent` | Defensive content, governance docs, off-topic, or rejected sources. |

**Common misclassifications seen:**
- Attacker-owned AI agent doing recon/exploitation → `ai_enabled_threats` (NOT `agentic_ai_threats` — ask "whose agent?")
- Worm exploiting AI coding-agent config files → `agentic_ai_threats` (NOT `ai_enabled_threats`)
- LLM hallucinated package names used as attack vector → `llm_threats/LLM09` (NOT `ai_enabled_threats`)
- ML supply chain (PyPI/npm ML packages) → `traditional_ai_threats/TAI10` (NOT `ai_enabled_threats`)

---

### 1b. Primary tag

- Must belong to the assigned `main_category`
- Must match the **novel contribution** of the source, not related-work citations
- Check against the taxonomy in `lib/prompts/understand/classify.md`

---

### 1c. Every secondary tag — verify each one individually

For each secondary tag, state the justification from the source content. If you cannot cite a specific passage, remove the tag.

**Frequent false secondary tags caught so far:**

| Tag | When it's wrong |
|-----|----------------|
| `AE05_ai_malware_dev` | Applied to malware that *targets* AI files (ENCFORGE), worms that *exploit* AI agent configs (Mini Shai-Hulud, SANDWORM_MODE), or supply-chain malware with no AI authorship. **Mandatory test:** Was AI used to WRITE the malware code? If no → remove. |
| `TAI01_data_poisoning` | Applied to model inversion (TAI06), model extraction (TAI05), membership inference (TAI07), or code poisoning of ML libraries (TAI10). TAI01 = attacker modifies training *data inputs*. |
| `TAI10_ai_supply_chain_compromise` | Applied to direct infrastructure breaches (de5f5441 HF breach). TAI10 = attack on ML software/model distribution chain. |
| `AE08_ai_attack_orchestration` | Applied when AI merely *wrote a script* rather than autonomously chaining multi-step attacks. If AI wrote one tool → `AE05`. If AI autonomously orchestrates multi-step campaigns → `AE08`. |
| `AE01_ai_recon` | Applied when the article covers AI-related content but doesn't specifically describe AI-assisted reconnaissance. Requires evidence AI was used for OSINT/scanning. |
| `ASI01_agent_goal_hijack` | Applied to autonomous AI capability incidents (OpenAI/HF eval). ASI01 = adversary *externally* manipulates agent goals. Autonomous unexpected behaviour → `ASI05`. |
| `ASI03_identity_privilege_abuse` | Canonical suffix is `ASI03_identity_privilege_abuse` (NOT `ASI03_prompt_injection` — that suffix is non-canonical). |

**Digest parent containers** (`is_digest=true`, `main_category=unclear_or_adjacent`): should have **no tags**. Their children carry the tags.

---

## Dimension 2 — Threat Maturity

Scale: `research → demonstrated → disclosed → observed → operational`

**Deterministic defaults by source_type:**

| source_type | default |
|-------------|---------|
| `research_finding` | research |
| `capability_demonstration` | demonstrated |
| `exploit_disclosure` | demonstrated |
| `vulnerability` | disclosed |
| `attack_surface_signal` | observed |
| `adversary_adoption_signal` | operational |
| `threat_intelligence` | operational |
| `incident` | **observed** (but often should be `operational` for confirmed repeat/sustained campaigns) |

**When `incident → operational` is justified:**
- Named, repeat threat actor (JadePuffer "returns", Trim operating since March)
- Autonomous payload delivery with real-world impact confirmed
- Sustained campaign with multiple documented victims
- Law-enforcement or government advisory on active ongoing campaign

**When `observed` is correct for incidents:**
- One-off, single-event disclosures
- Attribution uncertain
- Vendor-reported single customer impact

**Audit check:** NOT SET is never acceptable for a classified source. Set it before moving on.

---

## Dimension 3 — Importance Tier

`noise → reference → research → proven → realized`

Determined deterministically by `computeImportance()` from `source_type + main_category + trust_tier`. If stored value diverges from expected, it means source_type was patched without re-running scoring. Fix with:

```js
const imp = computeImportance(source);
intelligence.importance = imp;
```

**Check:** Is `intelligence.importance.tier` set? If NOT SET, run backfill.

---

## Dimension 4 — Reading Value

`background → analyst → recommended → essential`

**Expected mapping from importance:**

| importance | expected reading_value |
|------------|----------------------|
| realized | essential |
| proven | recommended |
| research | **analyst (default)** |
| reference | analyst |
| noise | background |

**Research paper upgrades** — the LLM may upgrade `analyst → recommended` or `recommended → essential`. Evaluate each upgrade:

- `analyst → recommended`: Accept only if significance is `landmark` AND the paper introduces a genuinely new attack class or cross-domain novel combination. A more efficient technique within a known attack class stays `analyst`.
- `recommended → essential`: Accept only if significance is `landmark` AND the finding changes the threat model (defenders must add a new threat, not just update a known one).
- If unsure, **downgrade to analyst**. It is easier to upgrade later than to inflate the corpus.

**Audit check:** If stored ≠ expected, evaluate whether the upgrade is justified and note it as an S10 acceptance or correct it.

---

## Dimension 5 — Research Significance (research sources only)

`landmark → notable → incremental → noise`

Only populated for `source_type=research_finding` sources with `reading_value ≥ analyst`. If NOT SET, it means the significance scoring pass hasn't run.

- Significance is **orthogonal to reading_value** — it ranks within a tier, it does not automatically justify upgrading the tier.
- `landmark` ≠ `essential`. A landmark paper in a known attack class is still `analyst`.

---

## Dimension 6 — Content Quality

### 6a. Summary accuracy
- Does the summary accurately describe the **mechanism**, not just the topic?
- Does it name key actors, tools, CVEs, or techniques present in the content?
- Is it specific enough to distinguish this source from similar ones?
- Flag: vague summaries that describe a broad topic without the specific finding.

### 6b. Full text length
- < 300 chars → stub/paywall; Jina re-fetch should have run (check if upgradeText.js triggered)
- 300–1,500 chars → thin; verify evidence eligibility is appropriate
- > 1,500 chars → sufficient for extraction

### 6c. Source type accuracy
Ask the source type diagnostic questions:

| source_type | key test |
|-------------|---------|
| `vulnerability` | Advisory-only CVE disclosure, no working exploit path shown |
| `exploit_disclosure` | Step-by-step exploit chain or PoC code is the **primary deliverable** |
| `incident` | Confirmed real-world event with named victim or named attacker |
| `threat_intelligence` | Publisher's own investigation (IR team, threat research team) |
| `attack_surface_signal` | Analysis of attack surface, not a specific incident or exploit |
| `capability_demonstration` | Researcher PoC demonstrating a working attack, no production victim |
| `adversary_adoption_signal` | Confirmed in-wild adoption of a technique, not just capability |

**Source type matters for importance:** `vulnerability → noise`; `exploit_disclosure → proven`; `incident → realized`. If source_type is wrong, importance will be wrong.

### 6d. is_digest false positives
Long single articles with headings (arXiv papers, long blog posts, press releases) can trigger `is_digest=true`. Check URL pattern:
- `arxiv.org`, `/blog/`, `/news/`, `/press-release/` → almost always a single article, not a digest
- Verify `IS_REPORT: yes` in audit output and confirm the source is genuinely multi-topic before accepting `is_digest=true`

---

## Dimension 7 — Evidence

### 7a. Zero evidence on eligible sources
If `reading_value ∈ {essential, recommended}` and 0 evidence items → investigate.

Common causes:
- **S16 race condition** (now fixed): `runScoringPass` didn't await DB write before evidence extraction ran
- Source was classified before the fix landed — run `pipelineOneSource.js` to extract
- Source is below `full_text` threshold (< 600 chars in `isEligible`)
- Source was `unclear_or_adjacent` or `trust_tier=low` when extraction ran

### 7b. Evidence quality checks (when items exist)
For each displayed evidence item:
- `quote_grounded: false` on a `threat_actor_activity` or `incident` item → flag. Mechanistic descriptions should be grounded.
- `specificity: low` → check if the fact is too vague to be useful
- `evidence_type` mismatch → e.g. a technical finding labelled `expert_assessment`
- `fact` contains claims not traceable to the source text → hallucination risk

### 7c. claim_extraction_status semantics (S9)
`claim_extraction_status: success` is set by the **classify** pipeline, not by evidence extraction. A source showing `success` with 0 evidence items means either:
- It was ineligible (below reading_value gate or trust gate) — acceptable
- Evidence extraction ran and found nothing — investigate
- Extraction never ran due to S16 — re-run pipeline

---

## Dimension 8 — Data Integrity

### 8a. Date accuracy
- `date_confidence: estimated` → scan `full_text` for explicit date; run `upgradeDate.js` logic mentally
- Date > 2 weeks from today for a "recent" news article → likely feed ingestion date
- Academic papers from arXiv: ID prefix `YYMM` gives the correct month (e.g. `2607.xxxxx` = July 2026)
- Academic papers from NDSS/Springer: URL often contains `2025-` suggesting prior year; verify against abstract
- Cross-check `date_published` against `validation_summary` and `full_text` content

### 8b. Trust tier accuracy
- `primary`: government agencies (CISA, NCSC, FBI, NSF), AI labs (Anthropic, OpenAI, Google DeepMind), NIST
- `high`: established security vendors (CrowdStrike, Tenable, Sygnia, Wiz), academic institutions (arXiv papers), peer-reviewed journals
- `medium`: general security news (Infosecurity Magazine, Help Net Security, The Hacker News), smaller vendors
- Watch for: LLM assigning `primary` because article *quotes* or is *about* a government agency → check the **publisher domain**, not the subject matter

### 8c. Hallucination risk fields
- Check `HALL.RISK` in audit output — `none` is normal; `high` requires manual verification
- For `needs_review: true` sources: verify URL manually in browser before clearing flag
- Unrecognised model names, campaign names, or CVE numbers → flag `needs_review: true`

---

## After Each Source

1. State all issues found (even minor ones)
2. State your reasoning for each tag, not just whether it's right or wrong
3. Apply DB fixes immediately — do not batch across sources
4. If a fix reveals a systemic issue (same error on 3+ sources), log it as S-N in `database_audit.md` and fix the prompt/code

## After Each Batch

1. Update `docs/database_audit.md` — new rows under the batch heading for every issue
2. Run evidence extraction for all newly eligible sources via `pipelineOneSource.js` (uses Gemini by default)
3. Verify evidence quality on extracted items
4. Commit and push

---

## Known Systemic Issues — Watch for Recurrence

| # | Pattern | Status |
|---|---------|--------|
| S15 | `AE05` applied to malware targeting AI / worms exploiting AI agents | Prompt fixed; monitor every batch |
| S17 | `TAI01` used as generic secondary on ML attack papers (inversion/extraction/MIA) | Prompt fixed; monitor |
| S10 | Research paper `reading_value` upgrades beyond `analyst` without landmark+new-class justification | Prompt fixed; still needs manual check |
| S4 | `is_digest: true` on long single articles (arXiv, press releases) | detectDigest.js fixed; check IS_REPORT flag |
| ASI03 | Non-canonical suffix `ASI03_prompt_injection` — canonical is `ASI03_identity_privilege_abuse` | Fixed in prompt + DB |
| AE08 vs AE05 | `AE08` (orchestration) applied when AI merely wrote one script (`AE05`) | No prompt fix yet; check manually |
| trust_tier inflation | LLM assigns `primary` based on article *subject* not article *publisher* | No prompt fix; check publisher domain |
