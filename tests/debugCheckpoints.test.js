/**
 * Debug checkpoint tests — no network calls, no DB.
 * Run with: node tests/debugCheckpoints.test.js
 *
 * Covers:
 *   - buildRunId() format
 *   - writeCheckpoint() creates file + content can be read back
 *   - writeSourceTraces() creates file
 *   - reportL4() format
 *   - reportL6() format
 *   - reportL7() format
 *   - reportL8() format
 *   - reportRunSummary() includes run_id + source counts
 *   - Cleanup: removes test artefacts
 */

import assert          from "node:assert/strict";
import { join, resolve } from "path";
import { readFile, rm }  from "fs/promises";
import { fileURLToPath } from "url";
import { dirname }       from "path";

import {
  buildRunId,
  getRunDir,
  writeCheckpoint,
  writeSourceTraces,
  buildSourceTraces,
  summariseL4,
  summariseL6,
  summariseL7L8,
  summariseL9,
} from "../lib/pipeline/debug/checkpointWriter.js";

import {
  reportL4,
  reportL6,
  reportL7,
  reportL8,
  reportRunSummary,
} from "../lib/pipeline/debug/markdownReporter.js";

// ── Test harness ───────────────────────────────────────────────────────────────

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

// Use a fixed test run ID so cleanup is deterministic.
const TEST_RUN_ID   = "test-run-001";
// Override DEBUG_ROOT for tests by pointing into debug/test-runs/
// The checkpoint writer computes its path from PROJECT_ROOT/debug/runs/<runId>
// so we use TEST_RUN_ID in the standard location and clean up after.
const TEST_RUN_DIR  = join(PROJECT_ROOT, "debug", "runs", TEST_RUN_ID);

let passed = 0;
let failed = 0;
const cleanupPaths = new Set();

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // async test — handled by asyncTest()
      throw new Error("Use asyncTest() for async tests");
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SAMPLE_SOURCES = [
  {
    id:             "abc-123",
    title:          "Prompt Injection via Indirect RAG Poisoning",
    url:            "https://example.com/prompt-injection",
    publisher:      "ARXIV",
    trust_tier:     "high",
    main_category:  "llm_threats",
    tags:           ["prompt_injection", "rag_poisoning"],
    layer3_status:  "pass",
    downstream_route: "layer4",
    taxonomy_validation_status: "validated",
  },
  {
    id:             "def-456",
    title:          "AI Malware Generation at Scale",
    url:            "https://example.com/ai-malware",
    publisher:      "BLOG",
    trust_tier:     "medium",
    main_category:  "ai_enabled_threats",
    tags:           ["ai_malware"],
    layer3_status:  "reject",
    downstream_route: "discard",
    rejection_reason: "low relevance score",
    taxonomy_validation_status: "rejected",
  },
];

const SAMPLE_SYNTHESIS = {
  category_analyses: [
    {
      category:       "llm_threats",
      judgments:      [{ judgment: "Prompt injection remains the top LLM risk", confidence: "high", why_this_matters: "Direct business impact" }],
      strategic_judgments: [{ judgment: "Prompt injection remains the top LLM risk", confidence: "high" }],
      evidence_ids:   ["ev-001", "ev-002"],
      blocked_claims: [],
      evidence_gaps:  ["No observed-in-wild examples"],
      qa_warnings:    [],
    },
  ],
  counts: {
    total_sources:  2,
    high_priority:  1,
    evidence_cards: 5,
    clusters:       2,
    insights:       3,
    early_signals:  1,
    viewpoints:     0,
  },
  synthesis_version: "synthesis-v7.1",
};

const SAMPLE_DECK = {
  slide_plan: [
    { slide_number: 1, slide_type: "title",    argument: "AI Threat Landscape 2026", evidence_ids: [] },
    { slide_number: 2, slide_type: "category", argument: "LLM threats increasing",   evidence_ids: ["ev-001"] },
  ],
  slides: [
    {
      slide_number:    1,
      slide_type:      "title",
      headline:        "AI Threat Landscape 2026",
      title:           "AI Threat Landscape 2026",
      bullets:         [],
      citations:       [],
      evidence_callouts: [],
    },
    {
      slide_number:    2,
      slide_type:      "category",
      headline:        "Prompt injection is the dominant LLM attack vector",
      title:           "LLM Threats",
      bullets:         ["Finding 1", "Finding 2"],
      citations:       ["ev-001"],
      evidence_callouts: [{ evidence_id: "ev-001" }],
    },
  ],
  counts: {
    slides_planned:         2,
    slides_generated:       2,
    evidence_callouts_used: 1,
  },
  deck_version: "deck-v7.1",
};

const SAMPLE_QA = {
  overall_pass: true,
  summary: {
    total_issues: 1,
    errors:       0,
    warnings:     1,
    infos:        0,
    all_issues: [
      { severity: "warning", module: "citations", check: "coverage", message: "Only 1 of 2 high-priority sources cited" },
    ],
  },
  qa_version: "qa-v8.0",
};

// ── Tests: buildRunId ──────────────────────────────────────────────────────────

console.log("\nbuildRunId");

test("returns a string starting with pipeline-run-YYYY", () => {
  const id = buildRunId();
  assert.ok(typeof id === "string", "should be a string");
  assert.ok(id.startsWith("pipeline-run-"), `should start with pipeline-run-, got: ${id}`);
  assert.match(id, /^pipeline-run-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/,
    "should match pipeline-run-YYYY-MM-DD-HH-MM-SS");
});

test("two consecutive buildRunId() calls produce consistent format", () => {
  const a = buildRunId();
  const b = buildRunId();
  // Both should match the pattern (timestamps may differ by a second)
  assert.match(a, /^pipeline-run-\d{4}/);
  assert.match(b, /^pipeline-run-\d{4}/);
});

// ── Tests: getRunDir ───────────────────────────────────────────────────────────

console.log("\ngetRunDir");

test("returns an absolute path containing the run ID", () => {
  const dir = getRunDir("pipeline-run-2026-01-01-00-00-00");
  assert.ok(dir.includes("pipeline-run-2026-01-01-00-00-00"), "should include run ID");
  assert.ok(dir.startsWith("/"), "should be absolute");
});

// ── Tests: summariseL4 ─────────────────────────────────────────────────────────

console.log("\nsummariseL4");

test("returns total_sources count", () => {
  const counts = { total: 2, already_done: 0, llm_processed: 1, fallback: 1 };
  const result = summariseL4(SAMPLE_SOURCES, counts);
  assert.equal(result.total_sources, 2);
});

test("discarded array contains rejected sources", () => {
  const counts = { total: 2, already_done: 0, llm_processed: 1, fallback: 1 };
  const result = summariseL4(SAMPLE_SOURCES, counts);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0].id, "def-456");
});

test("sample_validated contains non-discarded sources (max 5)", () => {
  const counts = { total: 2, already_done: 0, llm_processed: 1, fallback: 1 };
  const result = summariseL4(SAMPLE_SOURCES, counts);
  assert.equal(result.sample_validated.length, 1);
  assert.equal(result.sample_validated[0].id, "abc-123");
});

// ── Tests: summariseL6 ─────────────────────────────────────────────────────────

console.log("\nsummariseL6");

test("returns evidence_cards count from counts", () => {
  const result = summariseL6(SAMPLE_SYNTHESIS);
  assert.equal(result.evidence_cards, 5);
});

test("category_analyses array has one entry per category", () => {
  const result = summariseL6(SAMPLE_SYNTHESIS);
  assert.equal(result.category_analyses.length, 1);
  assert.equal(result.category_analyses[0].category, "llm_threats");
});

// ── Tests: summariseL7L8 ───────────────────────────────────────────────────────

console.log("\nsummariseL7L8");

test("returns slide_plan_count and generated_count", () => {
  const result = summariseL7L8(SAMPLE_DECK);
  assert.equal(result.slide_plan_count, 2);
  assert.equal(result.generated_count, 2);
});

test("slide_type_distribution counts each type", () => {
  const result = summariseL7L8(SAMPLE_DECK);
  assert.equal(result.slide_type_distribution["title"], 1);
  assert.equal(result.slide_type_distribution["category"], 1);
});

// ── Tests: summariseL9 ─────────────────────────────────────────────────────────

console.log("\nsummariseL9");

test("overall_pass is true when no errors", () => {
  const result = summariseL9(SAMPLE_QA);
  assert.equal(result.overall_pass, true);
});

test("warning_count is 1", () => {
  const result = summariseL9(SAMPLE_QA);
  assert.equal(result.warning_count, 1);
});

// ── Tests: writeCheckpoint ─────────────────────────────────────────────────────

console.log("\nwriteCheckpoint");

await asyncTest("creates the checkpoint file and it can be read back", async () => {
  cleanupPaths.add(TEST_RUN_DIR);
  const data    = { layer: "L4_taxonomy", total_sources: 42, custom_field: "hello" };
  const filePath = await writeCheckpoint(TEST_RUN_ID, "L4_taxonomy", data);

  assert.ok(typeof filePath === "string", "should return a file path string");
  assert.ok(filePath.endsWith("L4_taxonomy.json"), "path should end with layer name");

  const raw     = await readFile(filePath, "utf8");
  const parsed  = JSON.parse(raw);

  assert.equal(parsed.run_id, TEST_RUN_ID);
  assert.equal(parsed.layer,  "L4_taxonomy");
  assert.equal(parsed.total_sources, 42);
  assert.equal(parsed.custom_field,  "hello");
  assert.ok(parsed.timestamp, "should include a timestamp");
});

await asyncTest("creates nested directories as needed", async () => {
  // Write a checkpoint to a sub-layer that has not been created yet
  const filePath = await writeCheckpoint(TEST_RUN_ID, "custom_layer", { value: 1 });
  const raw     = await readFile(filePath, "utf8");
  const parsed  = JSON.parse(raw);
  assert.equal(parsed.run_id, TEST_RUN_ID);
  assert.equal(parsed.value, 1);
});

// ── Tests: writeSourceTraces ────────────────────────────────────────────────────

console.log("\nwriteSourceTraces");

await asyncTest("creates source_traces.json with correct shape", async () => {
  const traces  = buildSourceTraces(SAMPLE_SOURCES);
  const filePath = await writeSourceTraces(TEST_RUN_ID, traces);

  const raw    = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.run_id,      TEST_RUN_ID);
  assert.equal(parsed.trace_count, SAMPLE_SOURCES.length);
  assert.ok(Array.isArray(parsed.traces));
  assert.ok(parsed.traces[0].source_id);
  assert.ok(Array.isArray(parsed.traces[0].layer_history));
});

// ── Tests: buildSourceTraces ───────────────────────────────────────────────────

console.log("\nbuildSourceTraces");

test("returns one trace per source", () => {
  const traces = buildSourceTraces(SAMPLE_SOURCES);
  assert.equal(traces.length, SAMPLE_SOURCES.length);
});

test("each trace has source_id and layer_history", () => {
  const traces = buildSourceTraces(SAMPLE_SOURCES);
  for (const t of traces) {
    assert.ok(t.source_id,             "should have source_id");
    assert.ok(Array.isArray(t.layer_history), "should have layer_history");
    assert.ok(t.layer_history.length > 0,     "layer_history should not be empty");
  }
});

// ── Tests: reportL4 ───────────────────────────────────────────────────────────

console.log("\nreportL4");

test("produces a non-empty string with ## headings", () => {
  const counts     = { total: 2, already_done: 0, llm_processed: 1, fallback: 1 };
  const summary    = summariseL4(SAMPLE_SOURCES, counts);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL4(checkpoint);

  assert.ok(typeof md === "string" && md.length > 0, "should be a non-empty string");
  assert.ok(md.includes("##"),                       "should contain ## headings");
  assert.ok(md.includes("L4 Taxonomy"),              "should mention L4 Taxonomy");
  assert.ok(md.includes(TEST_RUN_ID),                "should include the run ID");
});

test("includes discarded source reason", () => {
  const counts     = { total: 2, already_done: 0, llm_processed: 1, fallback: 1 };
  const summary    = summariseL4(SAMPLE_SOURCES, counts);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL4(checkpoint);

  assert.ok(md.includes("low relevance score"), "should include rejection reason");
});

// ── Tests: reportL6 ───────────────────────────────────────────────────────────

console.log("\nreportL6");

test("produces a non-empty string with ## headings", () => {
  const summary    = summariseL6(SAMPLE_SYNTHESIS);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL6(checkpoint);

  assert.ok(typeof md === "string" && md.length > 0, "should be non-empty");
  assert.ok(md.includes("##"),                       "should contain ## headings");
  assert.ok(md.includes("llm threats"),              "should mention the category");
});

test("includes evidence card count", () => {
  const summary    = summariseL6(SAMPLE_SYNTHESIS);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL6(checkpoint);

  assert.ok(md.includes("5"), "should include evidence card count");
});

// ── Tests: reportL7 ───────────────────────────────────────────────────────────

console.log("\nreportL7");

test("produces a non-empty string with ## headings", () => {
  const summary    = summariseL7L8(SAMPLE_DECK);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL7(checkpoint);

  assert.ok(typeof md === "string" && md.length > 0, "should be non-empty");
  assert.ok(md.includes("##"),                       "should contain ## headings");
  assert.ok(md.includes("L7"),                       "should mention L7");
});

// ── Tests: reportL8 ───────────────────────────────────────────────────────────

console.log("\nreportL8");

test("produces a non-empty string with ## headings", () => {
  const summary    = summariseL7L8(SAMPLE_DECK);
  const checkpoint = { run_id: TEST_RUN_ID, timestamp: new Date().toISOString(), ...summary };
  const md         = reportL8(checkpoint);

  assert.ok(typeof md === "string" && md.length > 0, "should be non-empty");
  assert.ok(md.includes("##"),                       "should contain ## headings");
  assert.ok(md.includes("L8"),                       "should mention L8");
});

// ── Tests: reportRunSummary ────────────────────────────────────────────────────

console.log("\nreportRunSummary");

test("includes run_id", () => {
  const md = reportRunSummary({
    run_id:    TEST_RUN_ID,
    timestamp: "2026-06-15T00:00:00Z",
    l4:   summariseL4(SAMPLE_SOURCES, { total: 2, already_done: 0, llm_processed: 1, fallback: 1 }),
    l6:   summariseL6(SAMPLE_SYNTHESIS),
    l7l8: summariseL7L8(SAMPLE_DECK),
    l9:   summariseL9(SAMPLE_QA),
  });

  assert.ok(md.includes(TEST_RUN_ID), "should include run_id");
});

test("includes source counts", () => {
  const md = reportRunSummary({
    run_id:    TEST_RUN_ID,
    timestamp: "2026-06-15T00:00:00Z",
    l4:   summariseL4(SAMPLE_SOURCES, { total: 2, already_done: 0, llm_processed: 1, fallback: 1 }),
    l6:   summariseL6(SAMPLE_SYNTHESIS),
    l7l8: summariseL7L8(SAMPLE_DECK),
    l9:   summariseL9(SAMPLE_QA),
  });

  assert.ok(md.includes("Total sources"), "should mention Total sources");
  assert.ok(md.includes("Evidence cards"), "should mention Evidence cards");
});

test("includes QA section", () => {
  const md = reportRunSummary({
    run_id:    TEST_RUN_ID,
    timestamp: "2026-06-15T00:00:00Z",
    l4:   summariseL4(SAMPLE_SOURCES, { total: 2, already_done: 0, llm_processed: 1, fallback: 1 }),
    l6:   summariseL6(SAMPLE_SYNTHESIS),
    l7l8: summariseL7L8(SAMPLE_DECK),
    l9:   summariseL9(SAMPLE_QA),
  });

  assert.ok(md.includes("QA Summary"), "should have QA Summary section");
  assert.ok(md.includes("PASS"), "should indicate overall pass/fail");
});

test("includes how-to-dig-deeper links", () => {
  const md = reportRunSummary({
    run_id:    TEST_RUN_ID,
    timestamp: "2026-06-15T00:00:00Z",
    l4:   {},
    l6:   {},
    l7l8: {},
    l9:   {},
  });
  assert.ok(md.includes("source_traces.json"), "should reference source_traces.json");
  assert.ok(md.includes("Next Steps"),         "should have Next Steps section");
});

// ── Cleanup ────────────────────────────────────────────────────────────────────

console.log("\ncleanup");

for (const p of cleanupPaths) {
  try {
    await rm(p, { recursive: true, force: true });
    console.log(`  ✓ Cleaned up ${p}`);
  } catch (err) {
    console.warn(`  ⚠ Could not clean up ${p}: ${err.message}`);
  }
}

// ── Results ────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
