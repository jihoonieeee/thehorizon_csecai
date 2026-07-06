/**
 * Tests for digest fan-out (multi-topic report → per-item child sources).
 * detectDigest + buildChildSources are pure/deterministic; extractDigestItems
 * and fanOutDigest are tested with an INJECTED fake llmFn (no network).
 * Run: node --test tests/digestFanout.test.js
 */
import assert from "node:assert/strict";
import {
  detectDigest, buildChildSources, extractDigestItems, fanOutDigest,
} from "../lib/pipeline/ingest/digestFanout.js";

let passed = 0, failed = 0;
function test(name, fn) {
  const done = (p) => Promise.resolve(p).then(
    () => { console.log(`  ✓ ${name}`); passed++; },
    (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
  return done((async () => fn())());
}

// ── detectDigest ──────────────────────────────────────────────────────────────
console.log("\n── detectDigest ──");
await test("weekly threat-intel report title → digest", () => {
  assert.equal(detectDigest({ title: "15th June – Threat Intelligence Report" }).is_digest, true);
});
await test("ThreatsDay bulletin → digest", () => {
  assert.equal(detectDigest({ title: "ThreatsDay Bulletin: Worm Code Leaked, AI Agent Phished + 28 more" }).is_digest, true);
});
await test("'6 AI Security Incidents' roundup → digest", () => {
  assert.equal(detectDigest({ title: "6 AI Security Incidents: Full Attack Path Analysis (April 2026)" }).is_digest, true);
});
await test("explicit intelligence.is_digest flag → digest", () => {
  assert.equal(detectDigest({ title: "anything", intelligence: { is_digest: true } }).reason, "explicit_flag");
});
await test("single-topic CVE title → NOT a digest", () => {
  assert.equal(detectDigest({ title: "CVE-2026-42208: SQL Injection in LiteLLM" }).is_digest, false);
});
await test("'Weekly Metasploit Update' (no threat/security qualifier) → NOT a digest", () => {
  assert.equal(detectDigest({ title: "Weekly Metasploit Update: SMB-to-Meterpreter modules" }).is_digest, false);
});

// ── buildChildSources: each item classifies independently, across categories ──
console.log("\n── buildChildSources ──");
const parent = {
  id: "digest-abc", title: "15th June – Threat Intelligence Report",
  url: "https://research.example.com/report", publisher: "Check Point Research",
  date_published: "2026-06-15T00:00:00+00:00", source_type: "threat_intelligence", trust_tier: "high",
};
const items = [
  { item_title: "Gemini-powered phishing-as-a-service (Outsider)", item_summary: "China-based network used Gemini to generate fake sites and SMS phishing at scale.",
    primary_exploit_mechanism: "ai_social_engineering", primary_consequence: "false_information", affected_layer: "application", mechanism_evidence_role: "incident" },
  { item_title: "Prompt injection vs Claude Code GitHub Action", item_summary: "Injection makes the agent run a tool that leaks CI/CD secrets.",
    primary_exploit_mechanism: "prompt_injection", primary_consequence: "tool_execution", affected_layer: "agent", mechanism_evidence_role: "attack" },
  { item_title: "Malicious LLM-gateway package backdoor", item_summary: "A compromised LLM-serving package dependency executes code.",
    primary_exploit_mechanism: "supply_chain_compromise", primary_consequence: "code_execution", affected_layer: "package_dependency", target_is_llm: true, mechanism_evidence_role: "cve" },
];
const children = buildChildSources(parent, items, { scoredAt: "2026-07-06T00:00:00Z" });

await test("produces one child per item", () => assert.equal(children.length, 3));
await test("child ids are parent-scoped and stable", () => {
  assert.deepEqual(children.map(c => c.id), ["digest-abc-i1", "digest-abc-i2", "digest-abc-i3"]);
});
await test("every child links back to the parent", () => {
  assert.ok(children.every(c => c.parent_source_id === "digest-abc"));
});
await test("item 1 (ai_social_engineering) → ai_enabled_threats / AE02", () => {
  assert.equal(children[0].main_category, "ai_enabled_threats");
  assert.ok(children[0].tags.includes("AE02_ai_social_engineering"), `tags=${children[0].tags}`);
});
await test("item 2 (injection→tool_execution) → agentic / ASI02", () => {
  assert.equal(children[1].main_category, "agentic_ai_threats");
  assert.ok(children[1].tags.includes("ASI02_tool_misuse_exploitation"), `tags=${children[1].tags}`);
});
await test("item 3 (LLM-infra supply chain) → llm_threats / LLM03", () => {
  assert.equal(children[2].main_category, "llm_threats");
  assert.ok(children[2].tags.includes("LLM03_llm_supply_chain"), `tags=${children[2].tags}`);
});
await test("children carry a computed importance tier + provenance", () => {
  assert.ok(children[0].intelligence.importance?.tier, "importance tier present");
  assert.equal(children[0].intelligence.derived_from_digest, "digest-abc");
  assert.equal(children[0].intelligence.importance.scored_at, "2026-07-06T00:00:00Z");
});
await test("digest fan-out fixes the single-classification loss (3 distinct categories)", () => {
  const cats = new Set(children.map(c => c.main_category));
  assert.equal(cats.size, 3, `expected 3 distinct categories, got ${[...cats]}`);
});

// ── extractDigestItems / fanOutDigest with injected fake llmFn ────────────────
console.log("\n── extract + fanOut (injected llmFn) ──");
const fakeLlm = async () => ({ is_digest: true, items });

await test("extractDigestItems returns items via injected llmFn", async () => {
  const r = await extractDigestItems(parent, { llmFn: fakeLlm });
  assert.equal(r.is_digest, true);
  assert.equal(r.items.length, 3);
});
await test("extractDigestItems throws without an llmFn", async () => {
  await assert.rejects(() => extractDigestItems(parent, {}), /requires opts\.llmFn/);
});
await test("fanOutDigest composes detect→extract→build for a digest", async () => {
  const r = await fanOutDigest(parent, { llmFn: fakeLlm, scoredAt: "2026-07-06T00:00:00Z" });
  assert.equal(r.is_digest, true);
  assert.equal(r.children.length, 3);
  assert.equal(r.parent_patch.intelligence.is_digest, true);
  assert.equal(r.parent_patch.intelligence.digest_item_count, 3);
});
await test("fanOutDigest is a no-op (no LLM) for a non-digest source", async () => {
  let called = false;
  const spy = async () => { called = true; return { is_digest: true, items }; };
  const r = await fanOutDigest({ id: "x", title: "CVE-2026-1: SQLi in Foo" }, { llmFn: spy });
  assert.equal(r.is_digest, false);
  assert.equal(called, false, "must not spend an LLM call on a non-digest");
});
await test("fanOutDigest defers to the LLM when it says the source is single-topic", async () => {
  const single = async () => ({ is_digest: false, items: [] });
  const r = await fanOutDigest(parent, { llmFn: single });
  assert.equal(r.is_digest, false);
  assert.match(r.reason, /_but_llm_single$/);
});

// ── long-report chunking + full-text fetch ────────────────────────────────────
console.log("\n── chunked extraction ──");
await test("a long report is chunked; findings merge + dedupe across chunks", async () => {
  const bigReport = { id: "rep", title: "HiddenLayer AI Threat Landscape 2026", url: "https://x/threat-landscape/2026", full_text: "x".repeat(95000) };
  let calls = 0;
  // Each chunk returns 2 items; item "shared" repeats across chunks (must dedupe to 1).
  const llm = async () => { calls++; return { is_digest: true, items: [
    { item_title: `finding ${calls}`, item_summary: "s", primary_exploit_mechanism: "data_poisoning", primary_consequence: "false_information" },
    { item_title: "shared finding", item_summary: "s", primary_exploit_mechanism: "prompt_injection", primary_consequence: "tool_execution" },
  ] }; };
  const r = await extractDigestItems(bigReport, { llmFn: llm });
  assert.ok(r.chunks >= 2, `expected multiple chunks, got ${r.chunks}`);
  assert.ok(calls >= 2, "llm called once per chunk");
  const titles = r.items.map(it => it.item_title);
  assert.equal(titles.filter(t => t === "shared finding").length, 1, "duplicate finding deduped across chunks");
  assert.ok(r.items.length > 2, "distinct findings from multiple chunks retained");
});
await test("fetchFullText is used when stored text is short", async () => {
  const shortRep = { id: "r2", title: "GTIG AI Threat Tracker", url: "https://x/threat-tracker", full_text: "tiny" };
  let fetched = false;
  const fetchFullText = async () => { fetched = true; return "FULL REPORT ".repeat(500); };
  const llm = async () => ({ is_digest: true, items: [{ item_title: "f", item_summary: "s", primary_exploit_mechanism: "prompt_injection", primary_consequence: "tool_execution" }] });
  await extractDigestItems(shortRep, { llmFn: llm, fetchFullText });
  assert.equal(fetched, true, "should fetch full text when stored text is short");
});

// ── summary ──────────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}, 50);
