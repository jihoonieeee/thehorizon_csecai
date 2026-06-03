# LLM Model Routing — The Horizon Pipeline

## Overview

The Horizon uses a task-aware LLM routing layer that applies the principle:

```
cheap/local models  → bulk processing (filtering, tagging, dedup)
cheap capable models → nuanced extraction (evidence items, taxonomy)
strong models only  → final synthesis, critique, narrative
```

The entry point is `lib/llm/llmRouter.js` → `routedLLM()`. Existing code using `callLLM()` is automatically routed when it passes a `task` option.

---

## Architecture

```
lib/llm/
  llmRouter.js          — routing engine: model selection, caching, token tracking
  taskProfiles.js       — task definitions, mode→model mapping, OpenRouter model constants
  callLLM.js            — legacy entry point (delegates to router when task provided)
  providers/
    gemini.js           — Gemini REST API (structured output, all tiers)
    groq.js             — Groq OpenAI-compat (JSON mode, free Llama)
    cloudflare.js       — Cloudflare Workers AI (free, bulk classification)
    openrouter.js       — OpenRouter model marketplace (free-tier fallback, 2-key rotation)
    ollama.js           — Local Ollama (last-resort fallback, 8s quick-fail)

lib/cache/
  llmCache.js           — SHA-256 prompt cache (in-memory + optional disk)
```

---

## Modes

Set via `LLM_MODE` environment variable.

| Mode | Use when | Gemini (bulk tasks) | Gemini (synthesis) |
|------|----------|--------------------|--------------------|
| `dev` | Testing pipeline frequently | gemini-2.5-flash | gemini-2.5-pro |
| `cheap` | Minimise spend | gemini-2.0-flash-lite | gemini-2.5-flash |
| `quality` | Final report generation | gemini-2.5-flash | gemini-2.5-pro |
| `local` | API quota exhausted | gemini-2.0-flash-lite | gemini-2.5-flash |

---

## Provider Priority

Default order: `gemini → groq → cloudflare → openrouter → ollama`

Override via `LLM_PROVIDER_ORDER=groq,gemini,openrouter,cloudflare,ollama`.

| Provider | Key(s) | Cost | Schema support | Best for |
|----------|--------|------|----------------|----------|
| Gemini | `GEMINI_API_KEY` [+ `_2`] | free → paid | ✓ Full responseSchema | All tasks |
| Groq | `GROQ_API_KEY` | Free tier | JSON mode only | Tagging, bulk extraction |
| Cloudflare | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Free tier | Prompt only | Source filtering, dedup |
| **OpenRouter** | `OPENROUTER_API_KEY` [+ `_2`] | **Free tier available** | JSON mode | Hosted fallback before local |
| Ollama | `OLLAMA_BASE_URL` | Free (local) | Prompt only | Absolute last resort |

### Why OpenRouter exists in the architecture

OpenRouter is the **cloud-first fallback** before resorting to local compute. Benefits:
- **Free models available** — `openrouter/auto` routes to free capacity; no spend required
- **Two-key rotation** — `OPENROUTER_API_KEY` + `OPENROUTER_API_KEY_2` double the quota
- **Zero infrastructure** — no local server needed; works in Vercel serverless functions
- **Model variety** — `openai/gpt-oss-20b:free` provides reasoning capability for free

Ollama is tried **last**, with an 8-second timeout, and only for tasks where `allow_local: true`. It never handles category analysis, slide content, or final QA.

### OpenRouter vs Ollama

| | OpenRouter | Ollama |
|---|---|---|
| Infrastructure | Hosted (cloud) | Local (your machine) |
| Available in Vercel | ✓ Yes | ✗ No |
| Free tier | ✓ Yes | ✓ Yes (self-hosted) |
| Model quality | Medium–High | Low (0.5b model) |
| Context window | Model-dependent | ~8K tokens |
| Use when | Gemini/Groq exhausted | Everything else failed |

### OpenRouter model constants

All model IDs are centralized in `taskProfiles.js` → `OPENROUTER_MODELS`. Never hardcode model strings elsewhere — change here to update globally:

```js
OPENROUTER_MODELS = {
  default:   process.env.OPENROUTER_DEFAULT_MODEL   || "openrouter/auto",
  cheap:     process.env.OPENROUTER_CHEAP_MODEL     || "openrouter/auto",
  reasoning: process.env.OPENROUTER_REASONING_MODEL || "openai/gpt-oss-20b:free",
}
```

- **cheap tasks** (filtering, tagging) → `OPENROUTER_MODELS.cheap`
- **standard tasks** (extraction, analysis fallback) → `OPENROUTER_MODELS.reasoning`

### Free-tier limits and handling

OpenRouter's free models can hit capacity limits (503/529) or rate limits (429). The router handles these gracefully:
- **429 rate-limit**: retries with exponential backoff (up to 2 retries)
- **503/529 capacity**: retries once, then falls back to next provider
- **402 credits**: marks provider quota-exhausted; rolls to key 2 then Ollama
- **Key 1 quota-exhausted**: automatically tries `OPENROUTER_API_KEY_2`
- **Both keys exhausted**: falls through to Ollama (if `allow_local: true`)

---

## Task Routing

### Tasks and their pipeline layer

| Task | Layer | Preferred providers | Gemini tier | OpenRouter model |
|------|-------|--------------------|-|---|
| `source_filtering` | Layer 3 (optional) | cloudflare, groq, **openrouter**, gemini | cheap | cheap |
| `source_understanding` | Layer 4 | gemini, groq, **openrouter** | cheap | cheap |
| `taxonomy_tagging` | Layer 5a.1 | groq, **openrouter**, gemini, cloudflare | cheap | cheap |
| `evidence_extraction` | Layer 5a.3 | gemini, **openrouter**, groq | cheap | reasoning |
| `category_analysis` | Layer 8B | gemini *(only)* | **standard** | reasoning |
| `slide_content` | Layer 7 | gemini, **openrouter**, groq | **standard** | reasoning |
| `speaker_notes` | Layer 7 (notes) | gemini, **openrouter**, groq | cheap | cheap |
| `final_qa` | Layer 8D | gemini *(only)* | **standard** | reasoning |

`category_analysis` and `final_qa` are **Gemini-only** — OpenRouter free models don't have the reasoning depth needed for strategic synthesis. These tasks have no fallback beyond a deterministic fallback function.

**"cheap" tier** = gemini-2.5-flash (dev/quality) or gemini-2.0-flash-lite (cheap mode)
**"standard" tier** = gemini-2.5-pro (dev/quality) or gemini-2.5-flash (cheap mode)

### Why these choices

- **Groq preferred for tagging**: Fast, free, sufficient for structured classification. Falls back to Gemini on rate-limit.
- **Cloudflare for filtering**: Free tier inference is enough for binary relevance decisions. Small model; don't use for extraction.
- **Gemini 2.5 Flash for extraction**: Best cheap-capable model for reading source text and extracting concrete facts with schema output.
- **Gemini 2.5 Pro for synthesis**: Only used after evidence has been filtered to critical/high items (4 calls maximum). Significantly higher quality than Flash for analytical reasoning.
- **Gemini 2.5 Pro for slides**: Presentation output that external stakeholders see — warrants the quality bump.
- **No Claude/Anthropic by default**: No key available. If added in future, wire into `routedLLM` providers with `ANTHROPIC_API_KEY`.

---

## Cost-Saving Rules

1. **Never use standard-tier models before source filtering.** `category_analysis` and `slide_content` only run after evidence is reduced to critical/high items.
2. **Deterministic tasks use no LLM.** Scoring, clustering, QA rules, analytics aggregation, PPTX rendering — all deterministic code.
3. **Standard-tier models are called at most 4× per run** (once per category for analysis; once per category for QA). Everything upstream is cheap or free.
4. **All calls are cached** by SHA-256 hash of `(systemPrompt + userPrompt + task:mode)`. Cache TTL default: 48h. Hit rate is typically 60–90% on repeated dev runs.
5. **Reuse existing enrichment.** `understandSource.js` skips sources already at `understand_version = taxonomy-v6.0`. The rawfact branch skips sources with no eligible evidence.
6. **Daily token budget guard.** Set `LLM_DAILY_TOKEN_BUDGET` to warn at 80% and throw at 100%.
7. **Ollama fails fast.** 8-second timeout. A missing local server doesn't block the pipeline.
8. **Quota exhaustion is per-session.** Once a provider returns 429/quota, it's skipped for the rest of the process run. No repeated failed calls.

---

## Calling the Router

### New code

```js
import { routedLLM } from "../../llm/llmRouter.js";

const { result, llm_metadata } = await routedLLM(
  systemPrompt,
  userPrompt,
  {
    task:          "evidence_extraction",
    requires_json: true,
    schema:        MY_SCHEMA,       // optional; enables Gemini responseSchema
    logLabel:      "Layer5a.3",    // optional; enables per-call stdout logging
  }
);

// result: parsed JSON object (or null if all providers failed)
// llm_metadata: { model_used, provider_used, latency_ms, token_estimate, cache_hit, ... }
```

### Legacy code migration

Existing `callLLM()` calls gain routing automatically when `task` is added:

```js
// Before:
const result = await callLLM(sys, usr, { schema, logLabel: "Layer4" });

// After (routes via llmRouter):
const result = await callLLM(sys, usr, { task: "source_understanding", schema });
```

### Routing opts reference

```js
{
  task:          // "source_understanding" | "taxonomy_tagging" | "evidence_extraction"
                 // "category_analysis" | "slide_content" | "speaker_notes" | "final_qa"
  requires_json: // true | false — parse response as JSON
  schema:        // JSON schema object — enables structured output (Gemini responseSchema)
  logLabel:      // string — printed to stdout on each call for debugging
  skipCache:     // true — bypass cache read (still writes result)
  mode:          // override LLM_MODE for this call only
}
```

---

## Output Metadata

Every `routedLLM()` call returns:

```js
{
  result: <parsed JSON or string>,
  llm_metadata: {
    llm_used:       true,
    model_used:     "gemini-2.5-flash",
    provider_used:  "gemini",
    model_mode:     "dev",
    task:           "evidence_extraction",
    cache_hit:      false,
    latency_ms:     1247,
    token_estimate: { input: 820, output: 340, total: 1160 },
    // on failure:
    error:           "all_providers_failed",
    provider_errors: ["Gemini: quota exhausted", "Groq: rate limit"],
  }
}
```

---

## Graceful Degradation

The router **never throws** when providers are unavailable. Instead it returns `{ result: null, llm_metadata: { error: "all_providers_failed" } }`. Callers should check `result === null` and apply a deterministic fallback:

```js
const { result } = await routedLLM(sys, usr, { task: "source_understanding" });
if (result === null) {
  return deterministicFallback(source); // keyword-based taxonomy, no LLM
}
```

Pipeline sources that could not be enriched are marked:
- `claim_extraction_status: "quota_exceeded"` or `"provider_unavailable"`
- `llm_used: false`

They continue through the pipeline in a degraded state rather than crashing it.

---

## Caching

Cache key: `SHA-256(systemPrompt + "\x00" + userPrompt + "\x00" + task:mode)`

- **In-memory**: always active; evicts LRU when >2000 entries; process-lifetime TTL
- **Disk** (optional): set `LLM_CACHE_DIR=.llm_cache`; persists across restarts; one JSON file per entry

```bash
# Token usage + cache stats (call at end of a pipeline run)
node -e "
  import('./lib/llm/llmRouter.js').then(m => {
    console.log(JSON.stringify(m.getTokenUsageSummary(), null, 2));
  });
"
```

---

## Diagnostics

Print provider health at pipeline startup:

```js
import { logProviderStatus } from "../../llm/llmRouter.js";
logProviderStatus();
// [LLM Router] mode=dev  provider_order=gemini,groq,cloudflare,ollama
//   Gemini:     ✓  (GEMINI_API_KEY + GEMINI_API_KEY_2)
//   Groq:       ✓  (GROQ_API_KEY)
//   Cloudflare: ✗/✗  (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
//   Ollama:     http://localhost:11434  model=qwen2.5:0.5b  (last fallback only)
```

> **Note on `/api/debug/llm-status`**: The Vercel Hobby plan is capped at 12 serverless functions (currently at capacity). A debug endpoint cannot be added without removing an existing one. Use `logProviderStatus()` and `getTokenUsageSummary()` in scripts instead.

---

## New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Primary Gemini key (required for most tasks) |
| `GEMINI_API_KEY_2` | — | Second Gemini key for quota rotation |
| `GROQ_API_KEY` | — | Groq free Llama (tagging, extraction fallback) |
| `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare Workers AI (bulk filtering) |
| `CLOUDFLARE_API_TOKEN` | — | Cloudflare Workers AI |
| `OPENROUTER_API_KEY` | — | OpenRouter key 1 (free-tier hosted fallback) |
| `OPENROUTER_API_KEY_2` | — | OpenRouter key 2 (quota rotation) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `OPENROUTER_DEFAULT_MODEL` | `openrouter/auto` | Default OpenRouter model |
| `OPENROUTER_CHEAP_MODEL` | `openrouter/auto` | Cheap/bulk tasks |
| `OPENROUTER_REASONING_MODEL` | `openai/gpt-oss-20b:free` | Extraction/analysis fallback |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local Ollama server |
| `OLLAMA_MODEL` | `qwen2.5:0.5b` | Local model (tiny, CPU-compatible) |
| `LLM_MODE` | `dev` | Routing mode: `dev\|cheap\|quality\|local` |
| `LLM_PROVIDER_ORDER` | `gemini,groq,cloudflare,openrouter,ollama` | Provider priority |
| `LLM_TIMEOUT_MS` | `45000` | Per-call timeout |
| `LLM_MAX_RETRIES` | `3` | Rate-limit retries per provider |
| `LLM_CACHE_TTL_HOURS` | `48` | Prompt cache TTL |
| `LLM_CACHE_DIR` | _(disabled)_ | Disk cache path (e.g. `.llm_cache`) |
| `LLM_DAILY_TOKEN_BUDGET` | `0` (unlimited) | Estimated token budget guard |

Existing keys (`OPENAI_API_KEY`, `OPENAI_API_KEY_2`) continue to work in the legacy `callLLM()` path but are not in the default routing table.
