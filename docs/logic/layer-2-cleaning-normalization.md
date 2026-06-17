# Layer 2 — Cleaning + Normalization

## 1. Purpose

Turn raw source text into clean, analyzable text while **preserving technical content** (code, IOCs, numbers) out-of-band, and detect the source language. **Must not** summarize, interpret, or drop content it cannot classify — cleaning is lossy only for boilerplate, never for substance.

Orchestrator: `lib/pipeline/clean/cleanSources.js`.

## 2. Input

- **Input:** sources from L1 with `full_text`/`raw_text`, `title`, `publisher`.
- **Required:** `raw_text` or `full_text`.
- **Assumes from L1:** canonical `id`/`url`, not a near-duplicate.

## 3. Sublayers / steps

### 2.1 Structured extraction (`extractStructuredContent.js`) — runs FIRST, before destructive cleaning

Needs original markup, so it runs before `cleanText`. Extracts:
- Code blocks (fenced ``` and `<code>`) → `extracted_code_blocks[]`
- IOCs: IPs, domains, CVE IDs, SHA256/MD5 hashes, file paths → `extracted_iocs[]`
- Numeric statistics (percentages, counts, monetary) in context.

### 2.2 Text cleaning (`cleanText.js`, `cleanPlaintext.js`)

Remove HTML tags, normalize Unicode, collapse whitespace, strip boilerplate footers ("Read more at…", "Subscribe…"). Sets `clean_text`. `cleanPlaintext` is the lighter title/publisher cleaner used in L1.

### 2.3 Final normalization (`normalizeSources.js`)

Validate `clean_text` meets minimum length, normalize publisher names to canonical forms, strip non-ASCII from titles.

### 2.4 Language detection (`detectLanguage` in `lib/pipeline/validation/sourceValidity.js`)

> Lives in L3's validity module but is logically a cleaning-time signal; documented here and in L3.

Stopword-fingerprint classifier (en/es/fr/de/pt/it) with a non-Latin-script (CJK/Cyrillic/Arabic) byte-ratio backstop. Returns `"en" | "non_english" | "unknown"`. **This catches Latin-script non-English** (Spanish/French/German) that the old ">30% non-ASCII" heuristic passed as English — a real fidelity fix. Code-heavy English still scores English (the/and/of/to dominate).

## 4. Fields produced

| Field | Type | Values | Assigned by | Used by |
|---|---|---|---|---|
| `clean_text` | string | cleaned body | cleanText | L3 relevance, L4 understanding, L5A extraction |
| `extracted_code_blocks` | string[] | — | extractStructuredContent | L5A (technical evidence) |
| `extracted_iocs` | string[] | IPs/CVEs/hashes/paths | extractStructuredContent | L5A entities |
| `detected_language` | enum | en / non_english / unknown | detectLanguage | L3 flag, L5A admissibility cap |

## 5. Assessment criteria

Only one judgment: language. `non_english` → L3 adds `possible_non_english` filter flag (routes to review unless trusted publisher) → **L5A caps any evidence from a non-English source to `context_only`** (the English "fact" is an LLM translation, not English-quote-grounded).

## 6. LLM calls

None. Layer 2 is fully deterministic.

## 7. QA and anti-hallucination

- **Risk:** destructive cleaning could strip technical substance; truncation downstream loses caveats.
- **Prevented by:** structured extraction runs before cleaning; code/IOCs preserved separately.
- **Missing:** no chunking — long reports are truncated at the LLM windows in L3/L4/L5 (relevance 2,500 / understanding 3,000 / extraction 3,000 chars). A methodology paragraph past the window is invisible to extraction. No PDF table/figure extraction. See `open-logic-risks.md`.

## 8. Downstream contract

L3 can assume: `clean_text` exists and is HTML-free; code/IOCs/numbers are extracted; `detected_language` is set. It **cannot** assume the text is complete (long docs are windowed later), that the source is on-topic, or that the language detection is perfect on short text (`<30` chars → unknown).

## 9. Known failure modes

- Truncation loses methodology/caveats from long reports (the gate stays safe, the *evidence* is impoverished).
- Language detection on very short text returns `unknown`; a short non-English stub may slip through.
- Boilerplate stripping is pattern-based; an unusual footer survives or a real sentence is clipped.

## 10. Tests needed

- Code block / IOC survives cleaning and lands in `extracted_*`.
- Spanish/French body → `detected_language="non_english"`; code-heavy English → `"en"`.
- Boilerplate footer stripped; body preserved.
- Long doc: assert the cleaning step does not itself truncate (truncation is a downstream window, not a cleaning loss).
