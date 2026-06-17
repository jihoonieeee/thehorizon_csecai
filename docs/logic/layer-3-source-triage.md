# Layer 3 — Source Triage (Validation)

## 1. Purpose

The quality funnel before any expensive analysis. Decide whether a source is worth L4/L5 budget and what kind of evidence it can eventually produce. Sets `layer3_status` (pass/review/reject) and `downstream_route` (layer4 / layer4_with_review / discard), plus the trust/origin/quality context that L5/L6 use to weight evidence. **Must not** extract evidence or assign taxonomy.

Orchestrator: `lib/pipeline/validation/validateAndTypeSource.js` (`VALIDATION_VERSION="validation-v1.2"`).

## 2. Input

- **Input:** cleaned sources from L2 (`clean_text`, `detected_language`, flags).
- **DB fields read/written:** `sources.*` — writes `layer3_status`, `downstream_route`, `trust_tier`, `publisher_class`, `evidence_role`, `independence_level`, `origin_role`, `primary_origin_url`, `source_quality_status`, `source_quality_reasons`, `relevance_tier`, `ai_specificity_score`, `validation_summary`, `ai_threat_focus`, `candidate_domain`, `source_type`, `final_url`, `url_safety_status`, `url_reachable`.
- **Assumes from L2:** `clean_text` present, `detected_language` set.

## 3. Sublayers / steps

The chain runs roughly: structural validity → URL resolution → AI relevance → content quality → typing → trust annotation → origin tracking → source quality → final gate.

### 3.1 Structural validity (`sourceValidity.js`) — deterministic

**Hard fail (immediate reject):** missing title; missing/unsafe URL (non-HTTPS, private IP, denied domain); denied publisher (press wires `prnewswire`/`businesswire`, aggregators `feedburner`/`dlvr.it`, social `reddit`/`twitter`).

**Soft flags (accumulate):** `missing_publisher`, `no_publish_date`, `date_before_2020`, `minimal_text` (50–300 chars; `short_text` <50 is a hard reject), `title_is_url` (hard), `generic_title` (Untitled/No Title — hard), `possible_non_english` (from `detectLanguage`), `url_not_reachable`.

`text_quality_score` (0–100) is computed from length/title/summary/publisher/date presence. **It informs but does not gate** — a real but soft numeric score; treat as advisory only.

### 3.2 URL resolution (`urlSafety.js`) — runs before the final gate

`resolveAndVerifyUrl()` follows HTTP→HTTPS redirects, sets `final_url`, and classifies `url_safety_status`:

| Status | Meaning | Gate action |
|---|---|---|
| `safe` / `http_redirects_to_https` | clean | proceed |
| `domain_switch` | redirect changed registered domain | **hard reject** |
| `redirect_dead_end` | landed on shortener/social | **hard reject** |
| `unsafe_redirect` / `unsafe_protocol` / `invalid` / `private_ip` | unsafe | **hard reject** |

`url_reachable`: `true` (2xx/403/405), `false` (confirmed 4xx/5xx → reject for untrusted, review for primary/high/curated), `null` (timeout → no gate effect). 403/405 are treated as reachable (many gov/academic sites block HEAD).

### 3.3 AI-threat relevance (`aiRelevance.js`)

- **Step A — deterministic pre-gate (`hasAiSignal`)**: word-boundary keyword match. Passes if ≥1 high-signal AI term, OR ≥1 medium AI + ≥1 high cyber, OR ≥2 medium AI (governance). Fails → discard with `relevance_tier="off_topic"`, **no LLM call**. The `relevance_path` field records `known_signal | novelty_signal | both | none`; **`novelty_signal` is never pre-gate discarded** (the emerging-threat safety valve) and routes to review.
- **Step B — `source_relevance` LLM** (Anthropic Haiku → Gemini): reads title/publisher/≤2,500 chars. Returns `summary`, `ai_threat_focus` (central/passing/none), `is_ai_threat`, `candidate_domain`, `source_type`, confidences. `none` → reject (no QA). `passing` → off_topic unless trusted publisher.
- **Step C — `source_relevance_qa` LLM** (Anthropic Haiku, second independent call): verifies B; may downgrade `central`→`passing` (then resets `candidate_domain` to unclear_or_adjacent). Skipped for clear `none` rejects.
- **Fallback (no LLM):** deterministic `assessAiRelevance` → `ai_specificity_score` (0–100) and `relevance_tier` (core ≥40 / adjacent ≥20 / peripheral ≥10 / off_topic <10). **This 0–100 score is a real numeric scorer used only in the no-LLM fallback** — risk: it's a coarse keyword heuristic; treat fallback relevance as low-confidence.

### 3.4 Content quality gate (`contentQualityGate.js`) — only for `ai_threat_focus="central"`

`source_filtering` LLM (Gemini Flash-Lite → Groq/OpenRouter; **no Anthropic**). Deterministic pre-screen: `<120` chars → `thin_content` (no LLM); marketing title/URL → marketing flag. Verdict ∈ `substantive | marketing | keyword_stuffing | thin_content`. **Instructed to fail open** (default `substantive` when uncertain) — so only clearly disqualifying content is rejected. marketing/keyword_stuffing → reject unless curated; thin_content → review.

### 3.5 Typing (`dataTyping.js` / `sourceTyping.js`)

`source_typing` LLM (Gemini) only for unknown types → one of 13 source types + confidence. `unknown` proceeds but routes to review.

### 3.6 Trust annotation (`trustAssessment.js`) — deterministic

Sets `publisher_class` (primary_authority / major_vendor / academic / security_firm / media / unknown), `trust_tier`, `evidence_role` (primary_report / corroborating_secondary / secondary_summary / vendor_perspective), `independence_level`, `verification_status`, `evidence_strength_hint`.

### 3.7 Origin tracking (`originTracking.js`) — deterministic

Sets `origin_role` (primary_origin / secondary_reporting / tertiary_commentary / unknown_origin), `independence_level` (independent / vendor_interested / self_reported / circular_reporting_risk / unknown), `primary_origin_url`, `cited_sources[]`.

Circular reporting is flagged at **≥2** distinct publishers citing the same identified origin (`checkCircularReporting`): neither is independent corroboration. A near-dup cluster representative (`near_duplicate_count ≥ 2`) is forced to `secondary_reporting` unless it is itself authority/academic. `source-lifecycle.md` now reflects the ≥2 threshold correctly.

### 3.8 Source quality (`sourceQuality.js`) — deterministic, runs last

Sets `source_quality_status` (usable / usable_with_caveat / context_only / reject) and `source_quality_reasons[]` (reason codes: primary_source, official_advisory, peer_review_or_preprint, vendor_interested, missing_primary_origin, thin_but_structured, low_signal_blog, marketing_framing, seo_or_feed_content, paywall_stub, unknown_publisher, stale_without_new_evidence, circular_reporting_risk, unsupported_statistical_claim). `reject` here does **not** re-discard (the final gate already routed) — it informs L5/L6 weighting.

### 3.9 Final gate (`finalGate.js`) — deterministic

Combines everything into `layer3_status` + `downstream_route`:

| Outcome | Triggers (selected) |
|---|---|
| **reject → discard** | structural fail; `trust_tier=exclude`; `domain_switch`/`redirect_dead_end`/unsafe URL; `url_reachable=false` and not primary/high/curated; off_topic and not trusted; marketing/keyword_stuffing and not curated; (missing_publisher AND no_publish_date) with (minimal_text OR date_before_2020); possible_non_english and not primary/high/curated |
| **review → layer4_with_review** | thin_content; off_topic but trusted; novelty_signal; unknown source_type; lone soft flags (minimal_text or no_date with otherwise-valid source); date_before_2020 if trusted; curated marketing (protected) |
| **pass → layer4** | all hard gates passed, `ai_threat_focus=central`, `content_quality=substantive`, source_type resolved, no blocking soft flags |

## 4. Fields produced

Key fields (see §3 for assignment): `layer3_status`, `downstream_route`, `trust_tier`, `publisher_class`, `evidence_role`, `independence_level`, `origin_role`, `primary_origin_url`, `cited_sources`, `source_quality_status`, `source_quality_reasons`, `relevance_tier`, `ai_specificity_score`, `validation_summary`, `ai_threat_focus`, `candidate_domain`, `source_type`, `source_type_confidence`, `final_url`/`display_url`, `url_safety_status`, `url_reachable`, `relevance_path`, `filter_flags`.

## 5. Assessment criteria

| Decision | How |
|---|---|
| Structural usability | hard gates + soft flags (`sourceValidity`) |
| Relevance | keyword pre-gate → Haiku verdict (central/passing/none) → Haiku QA |
| Content quality | Gemini verdict (substantive/marketing/keyword_stuffing/thin_content), fail-open |
| Trust / independence | deterministic publisher/origin classification |
| Source quality / usefulness | `source_quality_status` enum + reason codes |

## 6. LLM calls

| Task | Model | Fallback | Trigger | Decides | Enforced after |
|---|---|---|---|---|---|
| `source_relevance` | Anthropic Haiku | Gemini/Groq | passed keyword pre-gate | central/passing/none, summary, candidate_domain, source_type | final gate routing |
| `source_relevance_qa` | Anthropic Haiku | Gemini/Groq | not a clear `none` | may downgrade verdict + reset domain | final gate |
| `source_filtering` | Gemini Flash-Lite | Groq/OpenRouter | `ai_threat_focus=central` | substantive/marketing/keyword_stuffing/thin_content | reject unless curated |
| `source_typing` | Gemini | Groq/OpenRouter | unknown source_type | source_type + confidence | review if still unknown |

Failure mode: LLM unavailable → deterministic `assessAiRelevance` fallback (0–100 keyword score). The whole layer degrades to keyword-only triage.

## 7. QA and anti-hallucination

- **Risk:** LLM relevance admitting hype; missing a novel source at the pre-gate.
- **Prevented by:** second Haiku QA pass; separate content-quality gate; `novelty_signal` never pre-gate discarded; trusted-publisher override after the relevance LLM.
- **Missing:** the pre-gate is keyword-list-bound — a doubly-novel source from an unknown publisher matching neither vocabulary nor novelty patterns is dropped with no LLM call. No sampling audit of pre-gate discards.

## 8. Downstream contract

L4 can assume: the source is structurally valid, AI-threat-central (or trusted-adjacent under review), has a `source_type`, a `trust_tier`, origin/independence/quality annotations, and a resolvable `final_url`. It **cannot** assume the source is true, English (non_english is flagged but proceeds to review), reachable (timeouts pass), or that the `validation_summary` is fully accurate (it's an LLM hint).

## 9. Known failure modes

- Content-quality gate fails open → borderline marketing survives.
- Curated sources bypass marketing reject → curated marketing reaches L4.
- `primary_origin_url` is parsed from "according to" phrases — usually null, so independence counting often falls back to publisher.
- `text_quality_score` and the fallback `ai_specificity_score` are real 0–100 scores — coarse and advisory; do not treat as reliability measures.

## 10. Tests needed

- Press-wire/aggregator/social publisher → hard reject.
- `domain_switch` redirect → reject; 403 → reachable.
- `none` relevance → reject without QA call; `passing` + untrusted → discard; `passing` + primary → review.
- marketing verdict + non-curated → reject; + curated → review.
- 2 publishers citing one origin → both `circular_reporting_risk` (regression for the ≥2 fix).
- non_english + untrusted → reject/review per gate.
