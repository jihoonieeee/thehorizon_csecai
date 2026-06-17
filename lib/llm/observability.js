/**
 * LLM Observability — Langfuse opt-in tracing
 *
 * Wraps LLM calls with structured traces when LANGFUSE_PUBLIC_KEY and
 * LANGFUSE_SECRET_KEY are present in the environment. Degrades gracefully to a
 * no-op when the env vars are absent or when the langfuse package is unavailable.
 *
 * INTEGRATION
 *   1. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env / Vercel env.
 *   2. Import { wrapLLMCall, flushObservability } in callLLM.js.
 *   3. Wrap each LLM call: const result = await wrapLLMCall(opts, () => actualCall());
 *   4. Call flushObservability() at the end of each pipeline run.
 *
 * WHY LANGFUSE OVER ALTERNATIVES
 *   - Open-source, self-hostable (no SaaS lock-in)
 *   - Captures: prompt text, model, input/output tokens, cost, latency, task name
 *   - Evals framework: can tag individual trace outputs as pass/fail for offline QA
 *   - Direct replacement for custom prompt-trace logging: no application code change
 *     beyond this thin wrapper
 *   - OSS alternative: Helicone (similar), OpenTelemetry (more infra work)
 *
 * WHAT IT REPLACES
 *   - Manual console.log of LLM I/O
 *   - Per-file token/cost counters
 *   - Ad hoc prompt debugging via JSON files
 *
 * WHAT IT DOES NOT REPLACE
 *   - Application-level QA (validateCategoryAnalysis, claimQa) — those are logic gates
 *   - Deterministic triage — not an LLM call, no trace needed
 *
 * IMPLEMENTATION EFFORT: ~2 hours total (wrapper + env wiring)
 * RISK: Zero — degrades to no-op when env vars absent
 * CODE REDUCTION: Removes ad hoc per-file logging; centralises observability
 */

let _langfuse = null;
let _initAttempted = false;

async function getLangfuse() {
  if (_initAttempted) return _langfuse;
  _initAttempted = true;

  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

  if (!pub || !sec) return null;

  try {
    const { Langfuse } = await import("langfuse");
    _langfuse = new Langfuse({ publicKey: pub, secretKey: sec, baseUrl: host });
    process.stdout.write("[observability] Langfuse tracing enabled\n");
  } catch {
    // langfuse package not installed — graceful no-op
  }
  return _langfuse;
}

/**
 * Wrap an LLM call with a Langfuse generation trace.
 *
 * @param {object}   opts
 * @param {string}   opts.task        — task name (from taskProfiles.js)
 * @param {string}   opts.model       — model ID used
 * @param {string}   opts.systemPrompt — system prompt text
 * @param {string}   opts.userPrompt  — user prompt text
 * @param {string}   [opts.layer]     — pipeline layer label (e.g. "L6.3")
 * @param {string}   [opts.runId]     — pipeline run ID for grouping
 * @param {Function} fn               — the actual LLM call (async, returns raw result)
 * @returns {Promise<any>} result of fn()
 */
export async function wrapLLMCall(opts, fn) {
  const lf = await getLangfuse();

  if (!lf) return fn();

  const traceId = opts.runId || `trace_${Date.now()}`;

  let trace;
  try {
    trace = lf.trace({
      id:       `${traceId}_${opts.task || "unknown"}`,
      name:     opts.task || "llm_call",
      metadata: { layer: opts.layer || null, run_id: opts.runId || null },
    });
  } catch {
    return fn();
  }

  const generation = trace.generation({
    name:        opts.task || "llm_call",
    model:       opts.model || "unknown",
    input:       {
      system: (opts.systemPrompt || "").slice(0, 2000),
      user:   (opts.userPrompt  || "").slice(0, 4000),
    },
    metadata:    { layer: opts.layer || null },
    startTime:   new Date(),
  });

  try {
    const result = await fn();
    generation.end({ output: result, level: "DEFAULT" });
    return result;
  } catch (err) {
    generation.end({ level: "ERROR", statusMessage: err.message });
    throw err;
  }
}

/**
 * Flush pending Langfuse events. Call at the end of each pipeline run.
 * Safe no-op when Langfuse is not configured.
 */
export async function flushObservability() {
  const lf = await getLangfuse();
  if (lf) {
    try { await lf.flushAsync(); } catch { /* best effort */ }
  }
}

/**
 * Check whether observability is currently active.
 * Useful in tests: skip observability assertions when not configured.
 */
export function isObservabilityEnabled() {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}
