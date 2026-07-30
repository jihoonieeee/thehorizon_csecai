/**
 * platformProvider — the swappable LLM seam. Verifies config resolution, tier→
 * model mapping, cost estimation, and per-provider dispatch (buffered + streamed)
 * with a mocked fetch. No network.
 *
 * Run with: node tests/platformProvider.test.js
 */

import assert from "node:assert/strict";
import {
  platformChat, platformConfig, modelForTier, estimateCostUsd,
} from "../lib/llm/platformProvider.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const realFetch = global.fetch;
let lastRequest = null;

function mockJson(obj) {
  global.fetch = async (url, opts) => {
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
}

// A fetch whose body streams the given SSE lines as one chunk.
function mockSse(lines) {
  global.fetch = async (url, opts) => {
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    const payload = lines.join("\n") + "\n";
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(payload) }),
      }) },
    };
  };
}

function resetEnv() {
  delete process.env.PLATFORM_AI_PROVIDER;
  delete process.env.PLATFORM_AI_API_KEY;
  delete process.env.PLATFORM_AI_BASE_URL;
  delete process.env.LLM_ONLY_GEMINI;   // keep tests hermetic vs the gemini-only lock
}

// ── Config + mapping (no network) ───────────────────────────────────────────────
console.log("\nplatformProvider — config & mapping");

await test("defaults to gemini provider", () => {
  resetEnv();
  process.env.PLATFORM_AI_API_KEY = "k";
  assert.equal(platformConfig().provider, "gemini");
});

await test("PLATFORM_AI_PROVIDER overrides provider", () => {
  resetEnv();
  process.env.PLATFORM_AI_PROVIDER = "anthropic";
  process.env.PLATFORM_AI_API_KEY = "k";
  assert.equal(platformConfig().provider, "anthropic");
});

await test("LLM_ONLY_GEMINI forces gemini over PLATFORM_AI_PROVIDER", () => {
  resetEnv();
  process.env.LLM_ONLY_GEMINI = "1";
  process.env.PLATFORM_AI_PROVIDER = "anthropic";
  process.env.PLATFORM_AI_API_KEY = "k";
  assert.equal(platformConfig().provider, "gemini");
  delete process.env.LLM_ONLY_GEMINI;
});

await test("openai-compatible defaults base URL", () => {
  resetEnv();
  process.env.PLATFORM_AI_PROVIDER = "openai-compatible";
  process.env.PLATFORM_AI_API_KEY = "k";
  assert.equal(platformConfig().baseUrl, "https://api.openai.com/v1");
});

await test("tier mapping is per provider", () => {
  assert.equal(modelForTier("cheap", "gemini"), "gemini-2.5-flash");
  assert.equal(modelForTier("synthesis", "gemini"), "gemini-2.5-pro");
  assert.equal(modelForTier("synthesis", "anthropic"), "claude-sonnet-4-6");
  assert.equal(modelForTier("cheap", "openai-compatible"), "gpt-4o-mini");
});

await test("estimateCostUsd matches longest prefix", () => {
  const c = estimateCostUsd({ model: "gemini-2.5-flash", inputTokens: 1e6, outputTokens: 1e6 });
  assert.equal(c, 0.30 + 2.50);
  // flash-lite must not be captured by the shorter "gemini-2.5-flash" key
  const lite = estimateCostUsd({ model: "gemini-2.5-flash-lite", inputTokens: 1e6, outputTokens: 0 });
  assert.equal(lite, 0.10);
  assert.equal(estimateCostUsd({ model: "totally-unknown", inputTokens: 1e6 }), 0);
});

// ── Gemini dispatch ─────────────────────────────────────────────────────────────
console.log("\nplatformProvider — gemini transport");

await test("gemini buffered call parses text + tokens", async () => {
  resetEnv();
  process.env.PLATFORM_AI_API_KEY = "gkey";
  mockJson({
    candidates: [{ content: { parts: [{ text: "hello" }] } }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
  });
  const r = await platformChat({ tier: "synthesis", system: "sys", user: "hi" });
  assert.equal(r.text, "hello");
  assert.equal(r.inputTokens, 11);
  assert.equal(r.outputTokens, 3);
  assert.equal(r.provider, "gemini");
  assert.equal(r.model, "gemini-2.5-pro");
  // key on the URL, systemInstruction set, contents role=user
  assert.ok(lastRequest.url.includes("gemini-2.5-pro:generateContent?key=gkey"));
  assert.equal(lastRequest.body.systemInstruction.parts[0].text, "sys");
  assert.equal(lastRequest.body.contents[0].role, "user");
});

await test("gemini maps assistant history role → model", async () => {
  resetEnv();
  process.env.PLATFORM_AI_API_KEY = "gkey";
  mockJson({ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: {} });
  await platformChat({ tier: "cheap", messages: [
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" },
  ] });
  assert.equal(lastRequest.body.contents[1].role, "model");
});

await test("gemini streaming aggregates deltas + fires onText", async () => {
  resetEnv();
  process.env.PLATFORM_AI_API_KEY = "gkey";
  mockSse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "foo " }] } }] })}`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "bar" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })}`,
  ]);
  let streamed = "";
  const r = await platformChat({ tier: "synthesis", user: "hi", stream: true, onText: (d) => { streamed += d; } });
  assert.equal(streamed, "foo bar");
  assert.equal(r.text, "foo bar");
  assert.equal(r.outputTokens, 2);
  assert.ok(lastRequest.url.includes("streamGenerateContent?alt=sse"));
});

// ── Anthropic + OpenAI dispatch ─────────────────────────────────────────────────
console.log("\nplatformProvider — anthropic & openai dispatch");

await test("anthropic buffered call uses x-api-key + preserves system array", async () => {
  resetEnv();
  process.env.PLATFORM_AI_PROVIDER = "anthropic";
  process.env.PLATFORM_AI_API_KEY = "akey";
  mockJson({ content: [{ type: "text", text: "ans" }], usage: { input_tokens: 7, output_tokens: 4 } });
  const sysArr = [{ type: "text", text: "T", cache_control: { type: "ephemeral" } }];
  const r = await platformChat({ tier: "synthesis", system: sysArr, user: "hi" });
  assert.equal(r.text, "ans");
  assert.equal(r.provider, "anthropic");
  assert.equal(lastRequest.opts.headers["x-api-key"], "akey");
  // system array passed through untouched (cache_control preserved)
  assert.deepEqual(lastRequest.body.system, sysArr);
});

await test("openai-compatible call uses bearer + chat/completions", async () => {
  resetEnv();
  process.env.PLATFORM_AI_PROVIDER = "openai-compatible";
  process.env.PLATFORM_AI_API_KEY = "okey";
  mockJson({ choices: [{ message: { content: "oai" } }], usage: { prompt_tokens: 9, completion_tokens: 6 } });
  const r = await platformChat({ tier: "cheap", system: "sys", user: "hi", json: true });
  assert.equal(r.text, "oai");
  assert.equal(r.inputTokens, 9);
  assert.equal(lastRequest.opts.headers.Authorization, "Bearer okey");
  assert.ok(lastRequest.url.endsWith("/chat/completions"));
  assert.equal(lastRequest.body.messages[0].role, "system");
  assert.equal(lastRequest.body.response_format.type, "json_object");
});

await test("throws when no key resolved", async () => {
  resetEnv();
  await assert.rejects(() => platformChat({ tier: "cheap", user: "hi" }), /no API key/);
});

// ── Summary ─────────────────────────────────────────────────────────────────────
global.fetch = realFetch;
resetEnv();
console.log(`\n${failed ? "✗" : "✓"} platformProvider: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
