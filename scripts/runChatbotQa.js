#!/usr/bin/env node
/**
 * runChatbotQa.js — LIVE chatbot QA harness.
 *
 * Sends every question in tests/chatbotQa/testCases.js to the real /api/agent
 * handler (Anthropic + Supabase) and grades each reply with the deterministic
 * evaluators in tests/chatbotQa/evaluators.js. Prints a per-case verdict
 * (Excellent / Acceptable / Fail) plus the evaluator detail, and a summary.
 *
 * This is NOT a unit test — it needs live keys and makes billable LLM calls, so
 * it is a script, not a tests/*.test.js. The deterministic evaluator behaviour is
 * unit-tested separately in tests/chatbotQa.test.js.
 *
 * Requires: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   node scripts/runChatbotQa.js                      # all cases
 *   node scripts/runChatbotQa.js --category hallucination_resistance
 *   node scripts/runChatbotQa.js --id BR-01,HR-01
 *   node scripts/runChatbotQa.js --verbose            # print each answer (400 chars)
 *   node scripts/runChatbotQa.js --verbose-full       # print each answer (full text)
 *   node scripts/runChatbotQa.js --json out.json      # also write machine-readable report
 *   node scripts/runChatbotQa.js --delay 2000         # ms to wait between cases (default 2000)
 *                                                     # prevents Supabase connection exhaustion
 *                                                     # on full 62-case runs; use 0 for --id runs
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import handler from "../api/agent.js";
import { TEST_CASES, CATEGORY_KEYS } from "../tests/chatbotQa/testCases.js";
import { evaluateCase, verdictFor } from "../tests/chatbotQa/evaluators.js";

const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VERBOSE      = args.includes("--verbose") || args.includes("--verbose-full");
const VERBOSE_FULL = args.includes("--verbose-full");
const ONLY_CAT = getArg("--category");
const ONLY_IDS = getArg("--id")?.split(",").map(s => s.trim());
const JSON_OUT = getArg("--json");
// Inter-case delay prevents Supabase HTTP keep-alive sockets from exhausting the
// connection pool on full 62-case runs. Defaults to 2 s; pass --delay 0 for
// targeted --id runs where connection exhaustion is not a risk.
const INTER_CASE_DELAY = parseInt(getArg("--delay") ?? "2000", 10);

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[k]) { console.error(`Missing env: ${k}. This runner needs live keys.`); process.exit(1); }
}
// The chatbot runs on the platform seam (Gemini). Require a usable key.
if (!process.env.PLATFORM_AI_API_KEY && !process.env.GEMINI_API_KEY) {
  console.error("Missing LLM key: set PLATFORM_AI_API_KEY or GEMINI_API_KEY."); process.exit(1);
}
// requireAuth (api/agent.js) rejects unauthenticated requests. Use the dev bypass:
// set AGENT_TEST_TOKEN and send it as the bearer token. Never reachable in prod
// (guarded by VERCEL_ENV !== "production" in requireAuth).
const AGENT_TEST_TOKEN = process.env.AGENT_TEST_TOKEN || "dev-qa-token";
process.env.AGENT_TEST_TOKEN = AGENT_TEST_TOKEN;
if (ONLY_CAT && !CATEGORY_KEYS.includes(ONLY_CAT)) {
  console.error(`Unknown --category. Valid: ${CATEGORY_KEYS.join(", ")}`); process.exit(1);
}

// Minimal Express-like res that captures the buffered JSON payload.
function makeRes() {
  return { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; }, setHeader() {}, write() {}, end() {} };
}

async function askAgent(question, { requestedCategory } = {}) {
  const res = makeRes();
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_TEST_TOKEN}` },
    // Pass requestedCategory so category-specific cases use the dashboard's
    // category filter, matching how real users invoke the chatbot.
    body: { query: question, stream: false, ...(requestedCategory ? { category: requestedCategory } : {}) },
  };
  const t0 = Date.now();
  await handler(req, res);
  const ms = Date.now() - t0;
  if (!res._json || res._json.error) throw new Error(res._json?.error || `HTTP ${res._status}`);
  return { payload: res._json, ms };
}

const cases = TEST_CASES
  .filter(t => !ONLY_CAT || t.category === ONLY_CAT)
  .filter(t => !ONLY_IDS || ONLY_IDS.includes(t.id));

const V_COLOR = { Excellent: "\x1b[32m", Acceptable: "\x1b[33m", Fail: "\x1b[31m" };
const RESET = "\x1b[0m";
const tally = { Excellent: 0, Acceptable: 0, Fail: 0, Error: 0 };
const report = [];
let totalCost = 0;          // summed estimated_cost_usd across cases
const latencies = [];       // ms per successful case
const models = new Set();   // synthesis models actually used (sanity: gemini-only)

console.log(`\nRunning ${cases.length} chatbot QA case(s)...\n`);

for (const tc of cases) {
  let payload, verdict, results = [], err = null, ms = null;
  try {
    ({ payload, ms } = await askAgent(tc.question, { requestedCategory: tc.requestedCategory }));
    results = evaluateCase(tc, payload);
    verdict = verdictFor(results);
  } catch (e) {
    err = e.message; verdict = "Error";
  }
  tally[verdict] = (tally[verdict] || 0) + 1;
  const cost = payload?.token_usage?.estimated_cost_usd || 0;
  if (!err) { totalCost += cost; if (ms != null) latencies.push(ms); if (payload?.token_usage?.model) models.add(payload.token_usage.model); }

  const color = V_COLOR[verdict] || "";
  const meta = err ? "" : `  \x1b[90m(${(ms/1000).toFixed(1)}s · $${cost.toFixed(4)})${RESET}`;
  console.log(`${color}[${verdict}]${RESET} ${tc.id} (${tc.category})  ${tc.question}${meta}`);
  if (err) {
    console.log(`      error: ${err}`);
  } else {
    for (const r of results) {
      if (r.pass === false)      console.log(`      ✗ ${r.id}: ${r.detail}`);
      else if (r.pass === null && r.applicable) console.log(`      ? ${r.id}: ${r.detail}`);
    }
    if (VERBOSE) {
      const answerText = (payload.answer || "").replace(/\s+/g, " ");
      console.log(`      answer: ${VERBOSE_FULL ? answerText : answerText.slice(0, 400)}`);
      console.log(`      mode: ${payload.answer_mode || "?"} | citations: ${(payload.citations || []).length} | confidence: ${payload.confidence} | scope: ${payload.temporal_scope}`);
    }
  }
  report.push({ id: tc.id, category: tc.category, question: tc.question, verdict, error: err,
    latency_ms: ms, cost_usd: cost, token_usage: payload?.token_usage,
    results, answer: payload?.answer, citations: payload?.citations, source_refs: payload?.source_refs,
    confidence: payload?.confidence, temporal_scope: payload?.temporal_scope,
    answer_mode: payload?.answer_mode, retrieval_verdict: payload?.retrieval_verdict,
    qa_pass: payload?.qa_pass, qa_blocked: payload?.qa_blocked });

  if (INTER_CASE_DELAY > 0) await new Promise(r => setTimeout(r, INTER_CASE_DELAY));
}

// Cost + latency stats.
const okCount = latencies.length;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const median = pct(0.5), p95 = pct(0.95);
const avgCost = okCount ? totalCost / okCount : 0;

console.log(`\n${"─".repeat(60)}`);
console.log(`  Excellent: ${tally.Excellent}   Acceptable: ${tally.Acceptable}   Fail: ${tally.Fail}   Error: ${tally.Error}`);
console.log(`  Cost: $${totalCost.toFixed(4)} total · $${avgCost.toFixed(4)}/query   Latency: ${(median/1000).toFixed(1)}s median · ${(p95/1000).toFixed(1)}s p95`);
console.log(`  Models used: ${[...models].join(", ") || "n/a"}`);
console.log(`${"─".repeat(60)}\n`);

if (JSON_OUT) {
  const summary = { tally, total_cost_usd: totalCost, avg_cost_usd: avgCost, median_latency_ms: median, p95_latency_ms: p95, models_used: [...models] };
  writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), summary, report }, null, 2));
  console.log(`Wrote ${JSON_OUT}\n`);
}

// Non-zero exit if anything hard-failed, so CI/manual runs can gate on it.
process.exit(tally.Fail > 0 || tally.Error > 0 ? 1 : 0);
