/**
 * LLM Router — routedLLM()
 *
 * Central entry point for all task-aware LLM calls in the Horizon pipeline.
 * Implements model selection, provider failover, caching, token tracking,
 * and graceful degradation.
 *
 * ── QUICK USAGE ───────────────────────────────────────────────────────────────
 *
 *   import { routedLLM } from "../../llm/llmRouter.js";
 *
 *   const { result, llm_metadata } = await routedLLM(
 *     systemPrompt,
 *     userPrompt,
 *     {
 *       task:              "evidence_extraction",
 *       requires_json:     true,
 *       schema:            MY_SCHEMA,          // optional JSON schema
 *     }
 *   );
 *
 * ── MODEL MODES (set via LLM_MODE env var) ────────────────────────────────────
 *   dev     — Gemini 2.5 Flash for extraction/tagging; Pro for synthesis
 *   cheap   — Flash Lite for bulk; 2.5 Flash for extraction; Flash for synthesis
 *   quality — 2.5 Flash for extraction; Pro for analysis/slides/QA
 *   local   — Ollama → Groq fallback; no synthesis-tier models
 *
 * ── PROVIDER ORDER (set via LLM_PROVIDER_ORDER env var) ──────────────────────
 *   Default: gemini,groq,cloudflare,ollama
 *   Override: LLM_PROVIDER_ORDER=groq,gemini to prioritise Groq for all tasks
 *   Task profiles further filter which providers are suitable for each task.
 *
 * ── COST SAFETY RULES ────────────────────────────────────────────────────────
 *   1. Gemini Pro (standard tier) is never used for source_filtering/tagging.
 *   2. Ollama is only tried as last resort when all hosted providers fail.
 *   3. Pipeline never crashes on provider failure; returns degraded result.
 *   4. All calls are cached by prompt hash + model; TTL default 48h.
 *   5. Daily token budget guard (LLM_DAILY_TOKEN_BUDGET); warns at 80%.
 *
 * ── STANDARD RESPONSE SHAPE ──────────────────────────────────────────────────
 *   {
 *     result:       <parsed JSON or raw string>,
 *     llm_metadata: {
 *       llm_used:        true | false,
 *       model_used:      "gemini-2.5-flash",
 *       provider_used:   "gemini",
 *       model_mode:      "dev",
 *       task:            "evidence_extraction",
 *       cache_hit:       false,
 *       latency_ms:      1234,
 *       token_estimate:  { input: 800, output: 400, total: 1200 },
 *     }
 *   }
 */

import { callGemini }      from "./providers/gemini.js";
import { callGroq }        from "./providers/groq.js";
import { callCloudflare }  from "./providers/cloudflare.js";
import { callOpenRouter }  from "./providers/openrouter.js";
import { callOpenAI }      from "./providers/openai.js";
import { callOllama, isOllamaAvailable } from "./providers/ollama.js";
import { callAnthropic, ANTHROPIC_MODELS } from "./providers/anthropic.js";
import {
  TASK_PROFILES,
  GEMINI_LITE, GEMINI_FLASH, GEMINI_CHEAP, GEMINI_STANDARD,
  GROQ_MODEL, CLOUDFLARE_MODEL,
  OPENROUTER_MODELS, OPENAI_MODEL,
  DEFAULT_PROVIDER_ORDER,
} from "./taskProfiles.js";
import { persistCallCost } from "./usagePersistence.js";
import {
  buildCacheKey, cacheGet, cacheSet, getCacheStats,
} from "../cache/llmCache.js";

// ── Session state ─────────────────────────────────────────────────────────────

const _exhaustedProviders = new Set();  // quota-exhausted for this process run
const _ollamaAvailable    = new Map();  // baseUrl → bool (checked once per session)

// ── Token tracking ────────────────────────────────────────────────────────────

const _tokenUsage = {
  byTask:     {},  // task → { input, output, calls }
  byProvider: {},  // provider → { input, output, calls }
  daily:      { date: utcDate(), input: 0, output: 0 },
};

const DAILY_BUDGET = parseInt(process.env.LLM_DAILY_TOKEN_BUDGET || "0", 10);

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function trackTokens(task, provider, input, output) {
  // Reset daily counter if day changed
  const today = utcDate();
  if (_tokenUsage.daily.date !== today) {
    _tokenUsage.daily = { date: today, input: 0, output: 0 };
  }
  _tokenUsage.daily.input  += input;
  _tokenUsage.daily.output += output;

  if (!_tokenUsage.byTask[task]) _tokenUsage.byTask[task] = { input: 0, output: 0, calls: 0 };
  _tokenUsage.byTask[task].input  += input;
  _tokenUsage.byTask[task].output += output;
  _tokenUsage.byTask[task].calls  += 1;

  if (!_tokenUsage.byProvider[provider]) _tokenUsage.byProvider[provider] = { input: 0, output: 0, calls: 0 };
  _tokenUsage.byProvider[provider].input  += input;
  _tokenUsage.byProvider[provider].output += output;
  _tokenUsage.byProvider[provider].calls  += 1;

  // Daily budget guard
  if (DAILY_BUDGET > 0) {
    const total = _tokenUsage.daily.input + _tokenUsage.daily.output;
    if (total >= DAILY_BUDGET) {
      throw Object.assign(
        new Error(`LLM daily token budget exhausted (${total}/${DAILY_BUDGET} tokens)`),
        { isBudgetExhausted: true }
      );
    }
    if (total >= DAILY_BUDGET * 0.8) {
      process.stdout.write(
        `[LLM] WARNING: daily token usage at ${Math.round((total / DAILY_BUDGET) * 100)}% of budget\n`
      );
    }
  }
}

// ── Mode and provider configuration ──────────────────────────────────────────

export function getModelMode() {
  return (process.env.LLM_MODE || "dev").toLowerCase();
}

function getProviderOrder() {
  // Hard lock: LLM_ONLY_GEMINI forces every task onto Gemini, ignoring both the
  // configured order and each task's preferred_providers (they intersect with
  // this list, so a gemini-only order collapses all tasks to Gemini).
  if (/^(1|true|yes)$/i.test(process.env.LLM_ONLY_GEMINI || "")) return ["gemini"];
  const raw = process.env.LLM_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER.join(",");
  return raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
}

// ── Provider executor map ─────────────────────────────────────────────────────

// Collect all distinct numbered keys for an env base name, in priority order:
//   BASE, BASE_2, BASE_3, … up to BASE_<MAX>. Deduped, blanks dropped.
const MAX_KEYS_PER_PROVIDER = 10;
function collectKeys(baseName) {
  const keys = [process.env[baseName]];
  for (let i = 2; i <= MAX_KEYS_PER_PROVIDER; i++) keys.push(process.env[`${baseName}_${i}`]);
  return [...new Set(keys.filter(Boolean))];
}

// All distinct Gemini keys in priority order (KEY, KEY_2, KEY_3, …).
// Platform seam: when PLATFORM_AI_PROVIDER is Gemini, PLATFORM_AI_API_KEY is also
// a valid Gemini key for the pipeline router — appended last so any explicit
// GEMINI_API_KEY(s) keep priority. Lets one platform key serve pipeline + chatbot.
function geminiApiKeys() {
  const keys = collectKeys("GEMINI_API_KEY");
  const platformProvider = (process.env.PLATFORM_AI_PROVIDER || "gemini").toLowerCase();
  if (platformProvider === "gemini" && process.env.PLATFORM_AI_API_KEY) {
    return [...new Set([...keys, process.env.PLATFORM_AI_API_KEY])];
  }
  return keys;
}

function getGeminiApiKey() {
  return geminiApiKeys()[0] || null;
}

function buildProviderExecutors(task, mode) {
  const profile = TASK_PROFILES[task] || TASK_PROFILES.source_understanding;
  const providerOrder = getProviderOrder();

  // Filter to providers that are (a) in profile.preferred_providers and
  // (b) in the global provider order. Maintain preferred_providers priority.
  const taskPreferred = profile.preferred_providers;
  const orderedProviders = [
    ...taskPreferred.filter((p) => providerOrder.includes(p)),
    ...providerOrder.filter((p) => !taskPreferred.includes(p)),
  ];

  const executors = [];

  for (const provider of orderedProviders) {
    switch (provider) {
      case "gemini": {
        const tier    = profile.gemini_tier || "lite";
        const modelId = tier === "lite"      ? GEMINI_LITE
                      : tier === "flash"     ? GEMINI_FLASH
                      : tier === "standard"  ? GEMINI_STANDARD[mode]
                      : GEMINI_CHEAP[mode];  // "cheap" — legacy fallback
        if (!modelId) break;

        const timeout = parseInt(process.env.LLM_TIMEOUT_MS || "45000", 10);
        // Rotate across every distinct Gemini key (KEY, KEY_2, KEY_3, …): each is
        // tried in turn when the previous one is quota-exhausted.
        const geminiKeys = [...new Set(geminiApiKeys())];
        geminiKeys.forEach((apiKey, i) => {
          const label = i === 0 ? "Gemini" : `Gemini-${i + 1}`;
          executors.push({
            provider: "gemini",
            label:    `${label} (${modelId})`,
            modelId,
            call: (sys, usr, opts) => callGemini(
              { modelId, apiKey, label: `${label}/${modelId}` },
              sys, usr, { ...opts, maxTokens: profile.max_tokens, timeoutMs: timeout }
            ),
          });
        });
        break;
      }

      case "groq": {
        const timeout = parseInt(process.env.LLM_TIMEOUT_MS || "45000", 10);
        // Rotate across every distinct Groq key (KEY, KEY_2, …).
        collectKeys("GROQ_API_KEY").forEach((apiKey, i) => {
          const label = i === 0 ? "Groq" : `Groq-${i + 1}`;
          executors.push({
            provider: "groq",
            label:    `${label} (${GROQ_MODEL})`,
            modelId:  GROQ_MODEL,
            call: (sys, usr, opts) => callGroq(
              { apiKey, modelId: GROQ_MODEL, label },
              sys, usr, { ...opts, maxTokens: profile.max_tokens, timeoutMs: timeout }
            ),
          });
        });
        break;
      }

      case "cloudflare": {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiToken  = process.env.CLOUDFLARE_API_TOKEN;
        if (!accountId || !apiToken) break;
        executors.push({
          provider: "cloudflare",
          label:    `Cloudflare (${CLOUDFLARE_MODEL})`,
          modelId:  CLOUDFLARE_MODEL,
          call: (sys, usr, opts) => callCloudflare(
            { accountId, apiToken, modelId: CLOUDFLARE_MODEL, label: "Cloudflare" },
            // Pass the task's real token budget (was hard-capped at 512, which
            // truncated even the light layers). Cap at a CF-safe 4096 ceiling.
            sys, usr, { ...opts, maxTokens: Math.min(profile.max_tokens || 1024, 4096) }
          ),
        });
        break;
      }

      case "openrouter": {
        // Pick model: cheap tier gets the free model; standard tier gets the
        // reasoning model for better extraction/analysis quality.
        const orTier    = profile.gemini_tier || "cheap";
        const orModelId = orTier === "standard"
          ? OPENROUTER_MODELS.reasoning
          : OPENROUTER_MODELS.cheap;
        const timeout   = parseInt(process.env.LLM_TIMEOUT_MS || "45000", 10);

        // Rotate across every distinct OpenRouter key (KEY, KEY_2, …).
        collectKeys("OPENROUTER_API_KEY").forEach((apiKey, i) => {
          const label = i === 0 ? "OpenRouter" : `OpenRouter-${i + 1}`;
          executors.push({
            provider: "openrouter",
            label:    `${label} (${orModelId})`,
            modelId:  orModelId,
            call: (sys, usr, opts) => callOpenRouter(
              { apiKey, modelId: orModelId, label },
              sys, usr, { ...opts, maxTokens: profile.max_tokens, timeoutMs: timeout }
            ),
          });
        });
        break;
      }

      case "openai": {
        // gpt-4o-mini for bulk tasks. Rotate across every distinct key (KEY, KEY_2, …).
        const timeout = parseInt(process.env.LLM_TIMEOUT_MS || "45000", 10);
        collectKeys("OPENAI_API_KEY").forEach((apiKey, i) => {
          const label = i === 0 ? "OpenAI" : `OpenAI-${i + 1}`;
          executors.push({
            provider: "openai",
            label:    `${label} (${OPENAI_MODEL})`,
            modelId:  OPENAI_MODEL,
            call: (sys, usr, opts) => callOpenAI(
              { apiKey, modelId: OPENAI_MODEL, label },
              sys, usr, { ...opts, maxTokens: profile.max_tokens, timeoutMs: timeout }
            ),
          });
        });
        break;
      }

      case "ollama": {
        // Only add Ollama if allow_local is true for this task
        if (!profile.allow_local) break;
        const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const modelId = process.env.OLLAMA_MODEL     || "qwen2.5:0.5b";
        // Local models (especially 7B-class on CPU/Metal) are far slower than the
        // provider's 8s default and need the task's real token budget — a hard
        // 512-cap truncates rich-JSON bulk layers (L4/L5A) into invalid JSON and
        // every call then aborts as "unavailable", silently dropping to the
        // deterministic fallback. Both are env-tunable for larger local models.
        const ollamaTimeout   = parseInt(process.env.OLLAMA_TIMEOUT_MS || "180000", 10);
        const ollamaMaxTokens = parseInt(
          process.env.OLLAMA_MAX_TOKENS || String(Math.min(profile.max_tokens || 1024, 4096)),
          10
        );
        executors.push({
          provider: "ollama",
          label:    `Ollama (${modelId})`,
          modelId,
          isLocal:  true,
          call: (sys, usr, opts) => callOllama(
            { baseUrl, modelId, label: "Ollama" },
            sys, usr, { ...opts, maxTokens: ollamaMaxTokens, timeoutMs: ollamaTimeout }
          ),
        });
        break;
      }

      case "anthropic": {
        // Frontier-model provider — only for tasks that explicitly prefer it.
        // Bulk/local-eligible layers must NOT escalate to Claude as a fallback.
        if (!taskPreferred.includes("anthropic")) break;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) break;

        // Task profile may specify anthropic_model: "opus" | "sonnet" | "haiku".
        // Defaults to "sonnet" for cost safety.
        const anthropicTier = profile.anthropic_model || "sonnet";
        const modelId = ANTHROPIC_MODELS[anthropicTier] || ANTHROPIC_MODELS.sonnet;

        executors.push({
          provider: "anthropic",
          label:    `Anthropic (${modelId})`,
          modelId,
          call: (sys, usr, opts) => callAnthropic(
            { modelId, apiKey, label: `Anthropic/${modelId}` },
            sys, usr, { ...opts, maxTokens: profile.max_tokens, timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "60000", 10) }
          ),
        });
        break;
      }
    }
  }

  return executors;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Patient mode: when a cheap provider is RATE-LIMITED (per-minute 429, not a
// daily quota), wait and retry the SAME provider instead of falling through to
// an expensive one. Trades wall-clock time for keeping bulk work off Sonnet.
function patientConfig() {
  return {
    enabled:    process.env.LLM_PATIENT_MODE === "true",
    baseWaitMs: parseInt(process.env.LLM_RATE_LIMIT_WAIT_MS || "20000", 10),
    maxRetries: parseInt(process.env.LLM_RATE_LIMIT_MAX_RETRIES || "4", 10),
  };
}

// ── JSON parser with fence stripping ─────────────────────────────────────────

// Scan from the first { or [ to its matching close, respecting string literals,
// and return that balanced substring. Lets us recover the JSON value when a
// model appends trailing commentary or a second object after it.
function extractFirstJson(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open  = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc)            esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"')  inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeParseJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    // Handle double-encoded JSON: model returned a JSON string containing JSON
    // (observed with Haiku on very large prompts — it wraps the object in quotes).
    if (typeof parsed === "string") {
      try { return JSON.parse(parsed); } catch { /* not double-encoded, use as-is */ }
    }
    return parsed;
  } catch { /* fall through */ }

  // Strip thinking-mode content that gemini-2.5-flash emits before the JSON.
  // The thinking text often contains { } chars that confuse the brace scanner.
  const noThinking = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();

  // Strip markdown fences (``` or ```json) — local/cheap models often wrap JSON.
  const stripped = noThinking
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch { /* fall through */ }

  // If the model appended text after the JSON, extract the first balanced object.
  const extracted = extractFirstJson(stripped);
  if (extracted) return JSON.parse(extracted);

  // Last resort: try from the last { in case thinking text came before the JSON.
  const lastBrace = stripped.lastIndexOf("{");
  if (lastBrace > 0) {
    const tail = extractFirstJson(stripped.slice(lastBrace));
    if (tail) return JSON.parse(tail);
  }

  throw new SyntaxError("safeParseJson: no parseable JSON found in response");
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Make a task-aware LLM call with automatic provider selection, caching,
 * token tracking, and graceful degradation.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [opts]
 * @param {string}  [opts.task="source_understanding"]
 * @param {boolean} [opts.requires_json=false]  - Parse response as JSON
 * @param {object}  [opts.schema=null]          - JSON schema for structured output
 * @param {string}  [opts.logLabel=""]          - Label for stdout logging
 * @param {boolean} [opts.skipCache=false]      - Bypass cache (still writes to it)
 * @param {string}  [opts.mode]                 - Override LLM_MODE for this call
 * @returns {Promise<{ result: any, llm_metadata: object }>}
 */
export async function routedLLM(systemPrompt, userPrompt, opts = {}) {
  const {
    task          = "source_understanding",
    requires_json = false,
    schema        = null,
    logLabel      = "",
    skipCache     = false,
    mode: modeOverride,
  } = opts;

  const mode     = modeOverride || getModelMode();
  const parseJson = requires_json || schema != null;

  // ── Cache lookup ────────────────────────────────────────────────────────────
  const cacheKey = buildCacheKey(systemPrompt, userPrompt, `${task}:${mode}`);

  if (!skipCache) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return { ...cached, llm_metadata: { ...cached.llm_metadata, cache_hit: true } };
    }
  }

  // ── Build provider chain ────────────────────────────────────────────────────
  const executors = buildProviderExecutors(task, mode);

  if (executors.length === 0) {
    process.stdout.write(
      `[LLM] No providers available for task="${task}" mode="${mode}" — ` +
      "check API key env vars\n"
    );
    return {
      result: null,
      llm_metadata: {
        llm_used: false, model_used: null, provider_used: null,
        model_mode: mode, task, cache_hit: false, latency_ms: 0,
        token_estimate: { input: 0, output: 0, total: 0 },
        error: "no_providers_configured",
      },
    };
  }

  const callOpts = { schema, json: parseJson };
  const inputEstimate = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  const errors = [];

  const pc = patientConfig();

  // Attempt a single executor once. Returns the output object on success, or a
  // status string: "quota" (key exhausted — cached), "rate_limit" (transient),
  // "unavailable", or "error". Per-KEY exhaustion is tracked on the unique
  // executor label so sibling keys (Gemini-2/3/4) are independent.
  const attemptOnce = async (executor) => {
    const providerKey = executor.label;
    if (_exhaustedProviders.has(providerKey)) { errors.push(`${executor.label}: quota exhausted (cached)`); return "quota"; }

    if (executor.isLocal) {
      const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
      if (!_ollamaAvailable.has(baseUrl)) {
        _ollamaAvailable.set(baseUrl, await isOllamaAvailable(baseUrl));
        if (!_ollamaAvailable.get(baseUrl)) process.stdout.write(`[LLM] Ollama not available at ${baseUrl} — skipping\n`);
      }
      if (!_ollamaAvailable.get(baseUrl)) { errors.push(`${executor.label}: not available`); return "unavailable"; }
    }

    const start = Date.now();
    try {
      const raw = await executor.call(systemPrompt, userPrompt, callOpts);

      // Providers now return { text, inputTokens, outputTokens } for accurate
      // cost tracking. Legacy providers still return a plain string — handle both.
      const rawText = (raw && typeof raw === "object" && "text" in raw) ? raw.text : raw;
      const result  = parseJson ? safeParseJson(rawText) : rawText;

      const latency_ms      = Date.now() - start;
      // Use real token counts from provider when available; fall back to estimate
      const actualInput     = (raw?.inputTokens  != null) ? raw.inputTokens  : inputEstimate;
      const outputEstimate  = estimateTokens(typeof rawText === "string" ? rawText : JSON.stringify(rawText));
      const actualOutput    = (raw?.outputTokens != null) ? raw.outputTokens : outputEstimate;
      // Prompt-cache metrics (Anthropic only; 0 elsewhere). cacheRead is billed
      // ~0.1x, cacheCreation ~1.25x — passed through so cost reflects the saving.
      const cacheRead       = raw?.cacheReadInputTokens     ?? 0;
      const cacheCreation   = raw?.cacheCreationInputTokens ?? 0;

      trackTokens(task, executor.provider, actualInput, actualOutput);
      // Persist to DB — fire-and-forget, never blocks the pipeline
      persistCallCost({
        task, provider: executor.provider, model: executor.modelId,
        inputTokens: actualInput, outputTokens: actualOutput,
        cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation,
      });

      if (logLabel) {
        const realCounts = raw?.inputTokens != null ? "" : "~";
        const cacheNote  = cacheRead ? ` (cache read ${cacheRead})` : cacheCreation ? ` (cache write ${cacheCreation})` : "";
        process.stdout.write(`  [LLM/${task}] ${executor.label} — ${latency_ms}ms ${realCounts}${actualInput + actualOutput} tokens${cacheNote}\n`);
      }
      const output = {
        result,
        llm_metadata: {
          llm_used: true, model_used: executor.modelId, provider_used: executor.provider,
          model_mode: mode, task, cache_hit: cacheRead > 0, latency_ms,
          token_estimate: { input: actualInput, output: actualOutput, total: actualInput + actualOutput },
          cache_read: cacheRead, cache_creation: cacheCreation,
          real_token_counts: raw?.inputTokens != null,
        },
      };
      await cacheSet(cacheKey, output);
      return output;
    } catch (err) {
      const latency_ms = Date.now() - start;
      if (err.isQuota) {
        _exhaustedProviders.add(providerKey);
        process.stdout.write(` [${executor.label} quota exhausted — skipping for session]\n`);
        errors.push(`${executor.label}: quota exhausted`);
        return "quota";
      }
      if (err.isRateLimit) {
        process.stdout.write(` [${executor.label} rate-limited — trying next key]\n`);
        return "rate_limit";
      }
      if (err.isUnavailable) { errors.push(`${executor.label}: unavailable`); return "unavailable"; }
      const msg = err.message || String(err);
      process.stdout.write(` [${executor.label} error (${latency_ms}ms): ${msg.slice(0, 100)} — trying next]\n`);
      errors.push(`${executor.label}: ${msg}`);
      return "error";
    }
  };

  // ── Pass 1: try every key/provider once, no waiting ────────────────────────
  // A rate-limited key falls straight through to the next key (separate quota)
  // instead of blocking on a patient wait — this is what makes 4 keys add real
  // throughput. Rate-limited executors are collected for an optional patient pass.
  const rateLimited = [];
  for (const executor of executors) {
    const r = await attemptOnce(executor);
    if (typeof r === "object") return r;          // success
    if (r === "rate_limit") rateLimited.push(executor);
  }

  // ── Pass 2: only if EVERY key was rate-limited do we patiently wait + retry ──
  if (rateLimited.length && pc.enabled) {
    for (let attempt = 1; attempt <= pc.maxRetries; attempt++) {
      const wait = Math.min(pc.baseWaitMs * attempt, 90000);
      process.stdout.write(` [all keys rate-limited — patient wait ${Math.round(wait / 1000)}s, retry ${attempt}/${pc.maxRetries}]\n`);
      await sleep(wait);
      for (const executor of rateLimited) {
        if (_exhaustedProviders.has(executor.label)) continue;
        const r = await attemptOnce(executor);
        if (typeof r === "object") return r;
      }
    }
  }

  // ── All providers failed — graceful degradation ───────────────────────────
  const errorSummary = errors.join("; ");
  process.stdout.write(
    `[LLM] All providers failed for task="${task}". Errors: ${errorSummary}\n`
  );

  return {
    result: null,
    llm_metadata: {
      llm_used:       false,
      model_used:     null,
      provider_used:  null,
      model_mode:     mode,
      task,
      cache_hit:      false,
      latency_ms:     0,
      token_estimate: { input: inputEstimate, output: 0, total: inputEstimate },
      error:          "all_providers_failed",
      provider_errors: errors,
    },
  };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Return token usage accumulated this session, broken down by task and provider.
 */
export function getTokenUsageSummary() {
  const daily = _tokenUsage.daily;
  const total = daily.input + daily.output;
  return {
    session_date:    daily.date,
    daily_total:     total,
    daily_budget:    DAILY_BUDGET || "unlimited",
    daily_budget_pct: DAILY_BUDGET ? `${Math.round((total / DAILY_BUDGET) * 100)}%` : "n/a",
    by_task:         _tokenUsage.byTask,
    by_provider:     _tokenUsage.byProvider,
    cache:           getCacheStats(),
    exhausted_providers: [..._exhaustedProviders],
  };
}

/**
 * Print a startup health summary showing which providers are configured.
 */
export function logProviderStatus() {
  const mode = getModelMode();
  const order = getProviderOrder();

  const keysTag     = (base) => { const n = collectKeys(base).length; return n > 1 ? ` (${n} keys)` : ""; };
  const geminiKey   = getGeminiApiKey() ? "✓" : "✗";
  const gemini2     = keysTag("GEMINI_API_KEY");
  const groqKey     = process.env.GROQ_API_KEY ? "✓" : "✗";
  const groq2       = keysTag("GROQ_API_KEY");
  const openaiKey   = process.env.OPENAI_API_KEY ? "✓" : "✗";
  const openai2     = keysTag("OPENAI_API_KEY");
  const cfOk        = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN ? "✓" : "✗";
  const orKey1      = process.env.OPENROUTER_API_KEY ? "✓" : "✗";
  const orKey2      = keysTag("OPENROUTER_API_KEY");
  const orModel     = OPENROUTER_MODELS.default;
  const orReason    = OPENROUTER_MODELS.reasoning;
  const ollamaUrl   = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
  const anthropicKey = process.env.ANTHROPIC_API_KEY ? "✓" : "✗";
  const anthropicModel = ANTHROPIC_MODELS.sonnet;

  process.stdout.write(`\n[LLM Router] mode=${mode}  provider_order=${order.join(",")}\n`);
  process.stdout.write(`  Gemini:      ${geminiKey}${gemini2}  (GEMINI_API_KEY)\n`);
  process.stdout.write(`  Groq:        ${groqKey}${groq2}  (GROQ_API_KEY)\n`);
  process.stdout.write(`  OpenAI:      ${openaiKey}${openai2}  model=${OPENAI_MODEL}  (GPT-4o-mini, bulk)\n`);
  process.stdout.write(`  Cloudflare:  ${cfOk}  (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)\n`);
  process.stdout.write(`  OpenRouter:  ${orKey1}${orKey2}  cheap=${orModel}  reasoning=${orReason}\n`);
  process.stdout.write(`  Ollama:      ${ollamaUrl}  model=${ollamaModel}  (last fallback only)\n`);
  process.stdout.write(`  Anthropic:   ${anthropicKey}  sonnet=${ANTHROPIC_MODELS.sonnet}  opus=${ANTHROPIC_MODELS.opus}  (L6+ analysis, slides, QA)\n\n`);

  process.stdout.write(`  Gemini tier assignment:\n`);
  process.stdout.write(`    lite  (L3-L4, L5B) → ${GEMINI_LITE}\n`);
  process.stdout.write(`    flash (L5A extract) → ${GEMINI_FLASH}\n`);
  process.stdout.write(`    standard (fallback) → ${GEMINI_STANDARD[mode]}  (mode="${mode}")\n\n`);
}
