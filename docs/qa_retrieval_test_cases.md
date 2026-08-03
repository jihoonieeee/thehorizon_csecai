# QA Test Cases v2 — Retrieval Quality & Topic Specificity

## Purpose

This document defines the second generation of chatbot QA cases, focused on **retrieval quality** rather than safety/adversarial properties. The v1 cases (`docs/chatbot_qa_test_cases.md`) cover hallucination resistance, adversarial robustness, and basic grounding. These cases test whether the agent retrieves the *right* sources, prioritises them *correctly*, and respects *timeframe and topic constraints*.

They also establish a **citation verification protocol** — checking that every `[src-N]` in the answer maps to a real, correctly-indexed, non-null source.

---

## Test Categories

| Key | Category | What it tests |
|-----|----------|---------------|
| RP | Retrieval Precision | Sources are specifically about the queried topic, not just keyword-adjacent |
| SI | Source Importance | High-trust / confirmed-operational sources are prioritised over noise |
| RQ | Recency | Agent respects "latest / this week / recent" phrasing; cited dates match |
| FT | Fixed Timeframe | Agent correctly gates to a closed date window (month, quarter, range) |
| TR | Trend Analysis | Agent uses temporal comparison data, states direction, doesn't just give a point-in-time snapshot |
| TS | Topic-Specific | Cited sources actually cover the named technology (MCP, coding agents, inference infra, etc.) |
| CV | Citation Verification | Every `[src-N]` in the answer has a valid, correctly-indexed source behind it |

---

## Test Cases

### RP — Retrieval Precision

```js
{ id: "RP-01", category: "retrieval_precision",
  question: "What do we know about indirect prompt injection attacks against AI agents that use retrieval?",
  note: "Cited sources must specifically cover indirect/RAG prompt injection — not generic jailbreaks or direct injection. Check that source summaries contain 'indirect', 'RAG', or 'retrieval' rather than only 'prompt injection' generically.",
  requiredKeywords: ["indirect", "retrieval", "RAG", "document"],
  forbidKwInSources: [] },

{ id: "RP-02", category: "retrieval_precision",
  question: "What is CVE-2026-42271 and what happened with it?",
  note: "Should return sources specifically about this CVE (LiteLLM). Answer must name the CVE ID, the product, and the exploitation status. No generic LLM threat filler.",
  requiredEntities: ["CVE-2026-42271", "LiteLLM"] },

{ id: "RP-03", category: "retrieval_precision",
  question: "What security research exists on multimodal model jailbreaks — attacks that use images, audio, or video?",
  note: "Sources must cover multimodal attack vectors specifically. Answer should not drift to text-only jailbreaks. At least one source should mention image, audio, or video as the attack medium.",
  requiredKeywords: ["image", "multimodal", "visual", "audio"] },

{ id: "RP-04", category: "retrieval_precision",
  question: "Which AI security incidents involved poisoned or backdoored model weights uploaded to model repositories?",
  note: "Must cite sources about supply-chain model poisoning specifically. Should not conflate with prompt injection or data poisoning of training pipelines.",
  requiredKeywords: ["model", "weight", "upload", "repository", "Hugging Face"] },

{ id: "RP-05", category: "retrieval_precision",
  question: "What do we know about attacks that exfiltrate LLM system prompts or confidential context?",
  note: "Sources must be about system prompt extraction or confidential context leakage. Should not drift to general PII leakage or training data extraction.",
  requiredKeywords: ["system prompt", "context", "exfiltrat", "leak"] },
```

### SI — Source Importance

```js
{ id: "SI-01", category: "source_importance",
  question: "What are the most critical confirmed AI security incidents — not research demonstrations — in the past 90 days?",
  note: "Answer must distinguish confirmed operational incidents from research. Cited sources should have high trust tier (primary/high) or maturity level (operational/observed). Should not cite benchmark papers as 'incidents'.",
  requireTrustTier: ["primary", "high"],
  requireDistinction: true },

{ id: "SI-02", category: "source_importance",
  question: "What warnings or advisories have government agencies or national CERTs issued about AI threats?",
  note: "Must cite primary-tier sources — CISA, NCSC, CSA, NIST, or equivalent government bodies. Should not cite vendor blogs as primary government warnings.",
  requireTrustTier: ["primary"] },

{ id: "SI-03", category: "source_importance",
  question: "What is the single most operationally significant LLM vulnerability confirmed in real-world exploitation?",
  note: "Should name one specific confirmed vulnerability with CISA KEV listing or equivalent validation. Answer should explicitly distinguish 'confirmed exploitation' from 'demonstrated in research'.",
  requireExploitationStatus: "confirmed" },

{ id: "SI-04", category: "source_importance",
  question: "Which findings about AI supply chain attacks are backed by the strongest evidence?",
  note: "Answer should rank or qualify sources by evidence strength. Sources cited for 'strongest evidence' should be high-trust or primary tier, not research papers from unknown authors.",
  requireTrustTier: ["primary", "high", "curated"] },
```

### RQ — Recency

```js
{ id: "RQ-01", category: "recency",
  question: "What are the most recent LLM security disclosures from the past two weeks?",
  note: "temporal_scope must say '2 weeks' or similar. Cited source dates (source_refs[N-1].date) should fall within 14 days of today. If no sources exist in that window, agent should say so rather than returning older sources unlabelled.",
  maxAgeDays: 14 },

{ id: "RQ-02", category: "recency",
  question: "What happened in AI agent security this week?",
  note: "temporal_scope must be 'this week' or last 7 days. Cited sources should have dates within 7 days. If no sources, agent must state that explicitly rather than serving week-old content as 'this week'.",
  maxAgeDays: 7 },

{ id: "RQ-03", category: "recency",
  question: "What is the latest research on autonomous AI agents performing cyberattacks?",
  note: "At least one cited source should be among the most recently published on this topic. Agent should not cite only older foundational papers if recent ones exist in corpus.",
  requireRecentSource: true },
```

### FT — Fixed Timeframe

```js
{ id: "FT-01", category: "fixed_timeframe",
  question: "What AI security incidents were reported in June 2026?",
  note: "temporal_scope must say 'June 2026' or '2026-06-01 to 2026-06-30'. Cited sources must have dates in June 2026. Sources from May or July must not be cited without an explicit caveat.",
  requiredScopeLabel: "June 2026",
  allowedDateRange: ["2026-06-01", "2026-06-30"] },

{ id: "FT-02", category: "fixed_timeframe",
  question: "What adversarial ML research was published in Q1 2026?",
  note: "temporal_scope must say Q1 2026 or Jan-Mar 2026. Cited source dates must fall between 2026-01-01 and 2026-03-31.",
  requiredScopeLabel: "Q1 2026",
  allowedDateRange: ["2026-01-01", "2026-03-31"] },

{ id: "FT-03", category: "fixed_timeframe",
  question: "What LLM vulnerabilities were disclosed between January and April 2026?",
  note: "Closed window. Agent must state scope clearly. No sources outside Jan–Apr 2026 should be cited.",
  allowedDateRange: ["2026-01-01", "2026-04-30"] },

{ id: "FT-04", category: "fixed_timeframe",
  question: "Give me a timeline of AI agent security incidents in 2026 so far.",
  note: "Answer should be ordered chronologically. All cited sources should be from 2026. Should name specific dates for each incident, not vague references.",
  requireChronologicalOrder: true },
```

### TR — Trend Analysis

```js
{ id: "TR-01", category: "trend_analysis",
  question: "Is the volume of reported LLM jailbreak attacks increasing or decreasing over the past six months?",
  note: "Answer must state a direction (increasing / decreasing / stable / insufficient data). Must not give a point-in-time snapshot. Should reference temporal comparison data or source volume by period.",
  requireDirection: true,
  forbidPointInTime: true },

{ id: "TR-02", category: "trend_analysis",
  question: "How has the nature of AI supply chain attacks changed from early 2025 to mid 2026?",
  note: "Must compare two time periods explicitly. Answer should describe what changed, not just list all supply chain incidents. Needs at least sources from two different periods to support the comparison.",
  requireTemporalComparison: true },

{ id: "TR-03", category: "trend_analysis",
  question: "Are AI-enabled phishing attacks becoming more sophisticated over time, and what evidence supports that?",
  note: "Must name specific sophistication signals and how they evolved. Should cite sources from at least two time periods. Should not claim 'increasing' without specific evidence of change.",
  requireEvolution: true },

{ id: "TR-04", category: "trend_analysis",
  question: "Which AI threat category has seen the most growth in reported incidents this year?",
  note: "Must make a comparative claim across categories backed by volume/trend data. Should state explicitly which category is growing fastest and what evidence supports that.",
  requireCrossCategComparison: true },
```

### TS — Topic-Specific

```js
{ id: "TS-01", category: "topic_specific",
  question: "What security vulnerabilities have been found in AI coding assistants like Claude Code, Cursor, or GitHub Copilot?",
  note: "Must cite sources specifically about coding assistants. Should name at least one specific product by name. Should not drift to generic LLM jailbreaks unrelated to coding tools.",
  requiredKeywords: ["coding", "assistant", "Copilot", "Cursor", "Claude Code", "Devin"],
  minProductMentions: 1 },

{ id: "TS-02", category: "topic_specific",
  question: "What are the known security issues with the Model Context Protocol (MCP)?",
  note: "Must cite sources specifically about MCP. Answer should explain what MCP is briefly, then describe specific security issues (tool poisoning, prompt injection via tool metadata, supply chain). Should not give a generic agentic AI answer without MCP specifics.",
  requiredKeywords: ["MCP", "Model Context Protocol", "tool", "server"],
  requireExplanation: true },

{ id: "TS-03", category: "topic_specific",
  question: "What attacks have exploited AI agent tool use or function calling capabilities?",
  note: "Should cite sources about tool misuse, function calling abuse, or MCP exploitation specifically. Should distinguish tool-use attacks from prompt injection that doesn't involve tool calls.",
  requiredKeywords: ["tool", "function call", "tool use", "MCP", "plugin"] },

{ id: "TS-04", category: "topic_specific",
  question: "What security vulnerabilities have been found in AI inference infrastructure like vLLM, Ollama, or LiteLLM?",
  note: "Must cite sources about AI serving infrastructure specifically. Should name specific CVEs or incidents for at least one named product. Should not substitute with generic 'AI system' findings.",
  requiredKeywords: ["vLLM", "Ollama", "LiteLLM", "inference", "proxy", "gateway"],
  requiredEntities: ["vLLM", "LiteLLM", "Ollama"] },

{ id: "TS-05", category: "topic_specific",
  question: "What is known about attacks targeting AI agent memory systems or knowledge bases — including RAG poisoning?",
  note: "Must specifically address agent memory, knowledge base injection, or RAG poisoning. Should cite research or incidents about persistent memory corruption, not just one-shot prompt injection.",
  requiredKeywords: ["RAG", "memory", "knowledge base", "retrieval", "poisoning"] },

{ id: "TS-06", category: "topic_specific",
  question: "What risks exist when AI agents are given web browsing or code execution capabilities?",
  note: "Should cover capability-specific risks: unrestricted browsing enabling SSRF or data exfiltration, code execution enabling RCE or sandbox escape. Should name specific research or incidents, not give a theoretical list.",
  requiredKeywords: ["code execution", "web", "browser", "sandbox", "escape", "browsing"] },

{ id: "TS-07", category: "topic_specific",
  question: "What security issues have emerged from AI agent orchestration frameworks like LangChain, CrewAI, or LangFlow?",
  note: "Must cite sources about orchestration framework vulnerabilities specifically. Should not give a generic agentic AI answer. At least one named framework should appear in the cited sources.",
  requiredKeywords: ["LangChain", "CrewAI", "LangFlow", "Flowise", "orchestration"] },
```

### CV — Citation Verification

These cases are identical to existing cases but graded solely on citation integrity — the goal is to verify the citation index is consistent end-to-end.

```js
{ id: "CV-01", category: "citation_verification",
  question: "What happened with LiteLLM?",
  note: "Run evalCitationIndexConsistency: every [src-N] in answer must map to source_refs[N-1] with a non-null URL. Run evalCitationFooterMatch: the ref number on each footer button must equal the N in the corresponding [src-N] marker. Run evalNoDuplicateRefs: two different [src-N] markers pointing to the same URL should have been deduplicated (ref rewrite)." },

{ id: "CV-02", category: "citation_verification",
  question: "What agentic AI risks are most relevant to enterprise environments?",
  note: "Broader answer with more citations — good stress-test for index consistency when many sources are cited." },

{ id: "CV-03", category: "citation_verification",
  question: "What are the main LLM threats this week?",
  note: "Time-bounded query — after QA drops out-of-window sources, verify remaining [src-N] markers are renumbered consistently or that orphaned markers were stripped." },
```

---

## Evaluators

### Existing evaluators (applied to new cases)

| Evaluator | Applied to categories |
|-----------|----------------------|
| `evalEvidenceForClaims` | RP, SI, TR, TS |
| `evalCitationsPresent` | RP, SI, RQ, FT, TR, TS |
| `evalBreadthOfEvidence` | SI, TR (broad questions) |
| `evalTimeframePresent` | RQ, FT, TR |
| `evalNoFakeScores` | all |
| `evalNoSpeculation` | all |
| `evalNoMalformedCitations` | all, especially CV |

### New evaluators needed

#### `evalCitationIndexConsistency`
Every `[src-N]` in the answer must:
1. Have `N` within bounds: `1 ≤ N ≤ source_refs.length`
2. Have `source_refs[N-1]` present and non-null
3. Have `source_refs[N-1].url` non-null (QA should have stripped markers for null-URL sources)

```
PASS if: all inline [src-N] have a valid, non-null source_refs[N-1] with URL
FAIL if: any [src-N] where N > source_refs.length, or source_refs[N-1].url is null
N/A if: answer has no inline [src-N] markers
```

#### `evalCitationFooterMatch`
For each citation in `citations[]`, the number extracted from `c.ref` (e.g. `[src-3]` → 3) must:
1. Equal the number the footer button displays (guaranteed by the frontend fix, but testable at payload level)
2. Correspond to `source_refs[N-1]` having the same URL as `c.url`

```
PASS if: for every c in citations[], parseInt(c.ref.match(/\d+/)) → N, and c.url === source_refs[N-1].url
FAIL if: any mismatch between citation ref number and source_refs position
N/A if: citations[] is empty
```

#### `evalNoDuplicateUrls`
Two different `[src-N]` markers in the answer should not point to the same URL (dedup should have collapsed them).

```
PASS if: all URLs in citations[] are unique
FAIL if: two citations[] entries share the same URL
N/A if: ≤ 1 citation
```

#### `evalSourceRecency` (for RQ cases)
At least one cited source's date must fall within the expected window.

```
Input: maxAgeDays from test case definition
PASS if: any source_refs[N-1].date (for cited [src-N]) is within maxAgeDays of today
FAIL if: no cited source falls within the expected window
N/A if: citations absent or test case has no maxAgeDays
```

#### `evalTemporalScopeAccuracy` (for FT cases)
The `temporal_scope` in the response must match the requested window.

```
Input: requiredScopeLabel from test case definition (e.g. "June 2026", "Q1 2026")
PASS if: temporal_scope contains the expected label (case-insensitive substring)
FAIL if: temporal_scope is absent, "all available data", or contradicts the window
N/A if: test case has no requiredScopeLabel
```

#### `evalTopicSpecificity` (for TS, RP cases)
At least one cited source's title or summary must contain a required keyword.

```
Input: requiredKeywords[] from test case definition
PASS if: any source_refs[N-1].{title,summary} (for cited [src-N]) contains at least one requiredKeyword
FAIL if: no cited source contains any required keyword
N/A if: no requiredKeywords defined or no citations
```

#### `evalTrustTierPresent` (for SI cases)
At least one cited source must have `trust_tier` in the required set.

```
Input: requireTrustTier[] from test case definition (e.g. ["primary","high"])
PASS if: any source_refs[N-1].trust_tier (for cited [src-N]) is in requireTrustTier
FAIL if: all cited sources have trust_tier outside the required set
N/A if: no requireTrustTier defined or no citations
```

#### `evalTrendDirection` (for TR cases)
Answer must state an explicit direction or state insufficient data.

```
PASS if: answer contains "increasing"/"decreasing"/"growing"/"declining"/"stable"/"insufficient data"/"unclear"
FAIL if: answer gives only point-in-time facts with no directional claim
N/A if: test case has no requireDirection flag
```

---

## Citation Verification Protocol

The citation chain has four links. All four must hold for a citation to be considered valid.

```
[src-N] in answer text
    ↓ N is within bounds of source_refs[]
source_refs[N-1] — has title, URL, date, trust_tier
    ↓ URL matches citations[].url for the same ref
citations[] entry — {ref: "[src-N]", url, source_title, publisher, trust_tier}
    ↓ footer button reads number N (from c.ref, not from array index)
Footer SourceButton displaying correct number and linking to correct URL
```

**What can break each link:**

| Link | Breakage mode | Evaluator |
|------|--------------|-----------|
| [src-N] → source_refs[N-1] | N out of bounds; source has null URL | `evalCitationIndexConsistency` |
| source_refs ↔ citations | URL mismatch after ref-rewrite (dedup) | `evalCitationFooterMatch` |
| citations → footer | Old bug: index used instead of ref number | fixed by frontend, verified by `evalCitationFooterMatch` |
| URL liveness | Dead link was not caught by QA | `evalNoMalformedCitations` (proxy); manual spot-check |

**Running the citation check manually:**

```bash
# Run CV cases with JSON output, then inspect citation chain
node scripts/runChatbotQa.js --id CV-01,CV-02,CV-03 --json reports/cv-check.json --verbose-full
```

Then in the JSON, for each case:
1. Extract all `[src-N]` from `answer` → get list of N values
2. For each N: confirm `source_refs[N-1]` exists and has a non-null URL
3. For each citation in `citations[]`: extract number from `ref`, confirm `source_refs[number-1].url === citation.url`
4. Confirm no two entries in `citations[]` share the same URL

---

## Pass/Fail Standards

| Metric | Hard gate | Quality target |
|--------|-----------|----------------|
| `evalCitationIndexConsistency` | 0 out-of-bounds refs | all cases pass |
| `evalCitationFooterMatch` | 0 URL mismatches | all cases pass |
| `evalNoDuplicateUrls` | — | all cases pass |
| `evalSourceRecency` (RQ) | ≥1 cited source within window | all RQ cases pass |
| `evalTemporalScopeAccuracy` (FT) | scope label matches request | all FT cases pass |
| `evalTopicSpecificity` (TS, RP) | ≥1 cited source contains required keyword | ≥80% of TS/RP cases pass |
| `evalTrustTierPresent` (SI) | ≥1 primary/high-tier source | all SI cases pass |
| `evalTrendDirection` (TR) | explicit direction stated | all TR cases pass |
| Overall Fail rate | 0 hard Fails | — |
| Overall Excellent rate | — | ≥ 60% |

---

## Execution Plan

### Step 1 — Add evaluators to `tests/chatbotQa/evaluators.js`

Implement the 7 new evaluators above. Each follows the same `R(id, applicable, pass, detail)` contract. Unit-test each in `tests/chatbotQa.test.js` with a pass fixture and a fail fixture before wiring into the harness.

### Step 2 — Add test cases to `tests/chatbotQa/testCases.js`

Add the 26 new cases (RP × 5, SI × 4, RQ × 3, FT × 4, TR × 4, TS × 7, CV × 3) to the `TEST_CASES` array and add the new category keys to `CATEGORY_KEYS`.

New category keys to add:
```js
"retrieval_precision", "source_importance", "recency",
"fixed_timeframe", "trend_analysis", "topic_specific", "citation_verification"
```

### Step 3 — Wire new evaluators in `evaluateCase()`

Map each new category to its evaluator set:
- `retrieval_precision`: `evalEvidenceForClaims`, `evalCitationsPresent`, `evalBreadthOfEvidence`, `evalTopicSpecificity`, `evalCitationIndexConsistency`
- `source_importance`: `evalEvidenceForClaims`, `evalCitationsPresent`, `evalTrustTierPresent`, `evalCitationIndexConsistency`
- `recency`: `evalCitationsPresent`, `evalTimeframePresent`, `evalSourceRecency`, `evalCitationIndexConsistency`
- `fixed_timeframe`: `evalCitationsPresent`, `evalTimeframePresent`, `evalTemporalScopeAccuracy`, `evalCitationIndexConsistency`
- `trend_analysis`: `evalCitationsPresent`, `evalBreadthOfEvidence`, `evalTimeframePresent`, `evalTrendDirection`, `evalCitationIndexConsistency`
- `topic_specific`: `evalEvidenceForClaims`, `evalCitationsPresent`, `evalTopicSpecificity`, `evalCitationIndexConsistency`
- `citation_verification`: `evalCitationIndexConsistency`, `evalCitationFooterMatch`, `evalNoDuplicateUrls`, `evalNoMalformedCitations`

### Step 4 — Baseline run

```bash
node scripts/runChatbotQa.js --category retrieval_precision --json reports/qa-rp-baseline.json
node scripts/runChatbotQa.js --category topic_specific --json reports/qa-ts-baseline.json
# etc. — run by category to avoid connection exhaustion
```

Save baselines. Future runs diff against these.

### Step 5 — Citation audit run

```bash
node scripts/runChatbotQa.js --id CV-01,CV-02,CV-03 --verbose-full --delay 0
```

Manually inspect the JSON output's `source_refs` and `citations` arrays for each case to verify the full citation chain described above.

### Ongoing cadence

- Run citation_verification cases on every agent code change
- Run topic_specific cases after corpus reingestion (topic coverage changes as new sources arrive)
- Run recency/fixed_timeframe cases weekly to catch temporal window drift
- Run full suite (v1 + v2) before any significant prompt or retrieval change
