# GovTech AI Platform API (LLMaaS)

Reference for `lib/llm/providers/platform_ai.js` and `lib/llm/platformProvider.js`.

## Base URL

```
PLATFORM_API_BASE_URL  (default: https://api-public.ai.tech.gov.sg)
```

## Authentication

`x-api-key: <PLATFORM_AI_API_KEY>` header on every request.

## Chat Completions

OpenAI-compatible. Endpoint: `POST /platform/models/v1/chat/completions`

Standard OpenAI request/response shape. Supports streaming (SSE).

Example streamed response chunk:
```json
{"id":"chatcmpl-...","created":1775464785,"model":"gpt-5.4","object":"chat.completion.chunk",
 "choices":[{"index":0,"delta":{"content":"."}}],"obfuscation":"1"}
```
Final chunk carries `"llmaas"` metadata (guardrails/sentinel scores) — safe to ignore for text extraction.

## Embeddings

Endpoint: `POST /v1/embeddings`

```json
// Request
{ "model": "text-embedding-3-small", "input": "The quick brown fox..." }

// Response
{ "model": "text-embedding-3-small", "data": [{ "embedding": [...], "index": 0 }], "object": "list", "usage": {...} }
```

## Error Responses

| Status | Description |
|--------|-------------|
| 401    | Unauthorized — missing or invalid API key |
| 403    | Forbidden — key does not have access to the requested capability |
| 429    | Too Many Requests — rate limit exceeded |

## Env vars

| Variable                | Description |
|-------------------------|-------------|
| `PLATFORM_AI_API_KEY`   | API key (sent as `x-api-key` header) |
| `PLATFORM_API_BASE_URL` | Base URL (default: `https://api-public.ai.tech.gov.sg`) |
| `PLATFORM_PIPELINE_MODEL` | Model for pipeline calls (e.g. `gpt-5.4`) |
| `PLATFORM_MODEL_CHEAP` / `_STANDARD` / `_SYNTHESIS` | Per-tier model overrides for chatbot seam |
