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
 *   node scripts/runChatbotQa.js                 # all cases
 *   node scripts/runChatbotQa.js --category hallucination_resistance
 *   node scripts/runChatbotQa.js --id BR-01,HR-01
 *   node scripts/runChatbotQa.js --verbose       # print each answer
 *   node scripts/runChatbotQa.js --json out.json # also write machine-readable report
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import handler from "../api/agent.js";
import { TEST_CASES, CATEGORY_KEYS } from "../tests/chatbotQa/testCases.js";
import { evaluateCase, verdictFor } from "../tests/chatbotQa/evaluators.js";

const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VERBOSE = args.includes("--verbose");
const ONLY_CAT = getArg("--category");
const ONLY_IDS = getArg("--id")?.split(",").map(s => s.trim());
const JSON_OUT = getArg("--json");

for (const k of ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[k]) { console.error(`Missing env: ${k}. This runner needs live keys.`); process.exit(1); }
}
if (ONLY_CAT && !CATEGORY_KEYS.includes(ONLY_CAT)) {
  console.error(`Unknown --category. Valid: ${CATEGORY_KEYS.join(", ")}`); process.exit(1);
}

// Minimal Express-like res that captures the buffered JSON payload.
function makeRes() {
  return { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; }, setHeader() {}, write() {}, end() {} };
}

async function askAgent(question) {
  const res = makeRes();
  await handler({ method: "POST", body: { query: question, stream: false } }, res);
  if (!res._json || res._json.error) throw new Error(res._json?.error || `HTTP ${res._status}`);
  return res._json;
}

const cases = TEST_CASES
  .filter(t => !ONLY_CAT || t.category === ONLY_CAT)
  .filter(t => !ONLY_IDS || ONLY_IDS.includes(t.id));

const V_COLOR = { Excellent: "\x1b[32m", Acceptable: "\x1b[33m", Fail: "\x1b[31m" };
const RESET = "\x1b[0m";
const tally = { Excellent: 0, Acceptable: 0, Fail: 0, Error: 0 };
const report = [];

console.log(`\nRunning ${cases.length} chatbot QA case(s)...\n`);

for (const tc of cases) {
  let payload, verdict, results = [], err = null;
  try {
    payload = await askAgent(tc.question);
    results = evaluateCase(tc, payload);
    verdict = verdictFor(results);
  } catch (e) {
    err = e.message; verdict = "Error";
  }
  tally[verdict] = (tally[verdict] || 0) + 1;

  const color = V_COLOR[verdict] || "";
  console.log(`${color}[${verdict}]${RESET} ${tc.id} (${tc.category})  ${tc.question}`);
  if (err) {
    console.log(`      error: ${err}`);
  } else {
    for (const r of results) {
      if (r.pass === false)      console.log(`      ✗ ${r.id}: ${r.detail}`);
      else if (r.pass === null && r.applicable) console.log(`      ? ${r.id}: ${r.detail}`);
    }
    if (VERBOSE) {
      console.log(`      answer: ${(payload.answer || "").replace(/\s+/g, " ").slice(0, 400)}`);
      console.log(`      citations: ${(payload.citations || []).length} | confidence: ${payload.confidence} | scope: ${payload.temporal_scope}`);
    }
  }
  report.push({ id: tc.id, category: tc.category, question: tc.question, verdict, error: err,
    results, answer: payload?.answer, citations: payload?.citations, confidence: payload?.confidence,
    temporal_scope: payload?.temporal_scope, qa_pass: payload?.qa_pass, qa_blocked: payload?.qa_blocked });
}

console.log(`\n${"─".repeat(60)}`);
console.log(`  Excellent: ${tally.Excellent}   Acceptable: ${tally.Acceptable}   Fail: ${tally.Fail}   Error: ${tally.Error}`);
console.log(`${"─".repeat(60)}\n`);

if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), tally, report }, null, 2)); console.log(`Wrote ${JSON_OUT}\n`); }

// Non-zero exit if anything hard-failed, so CI/manual runs can gate on it.
process.exit(tally.Fail > 0 || tally.Error > 0 ? 1 : 0);
