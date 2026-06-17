/**
 * LLM Task Granularity Tests
 *
 * Covers:
 *   1. Long source chunking (chunkSourceText)
 *   2. Quote offsets preserved in chunked extraction
 *   3. Duplicate facts merged after chunking (deduplicateChunkItems)
 *   4. Output validators — invalid enum rejected
 *   5. Output validators — hallucinated evidence ID rejected
 *   6. Output validators — unsupported quote fails
 *   7. Output validators — slide content headline length
 *   8. Output validators — evidence callout URL validation
 *   9. Field-level retry instruction generation
 *   10. Task registry — all tasks are documented
 *   11. Task registry — mixed tasks are justified
 *   12. deriveCredibilitySignal — deterministic classification
 *
 * Run: node tests/llm/task-granularity.test.js
 */

import assert from "node:assert/strict";
import {
  chunkSourceText,
  deduplicateChunkItems,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  LONG_THRESHOLD,
} from "../../lib/pipeline/rawfact/extractEvidenceItems.js";
import {
  validateEvidenceItem,
  validateEvidenceJudgment,
  validateStrategicJudgmentOutput,
  validateSlideContent,
  buildFieldRetryInstruction,
  validateLlmOutputUrl,
  validateEvidenceBatch,
} from "../../lib/llm/outputValidators.js";
import {
  TASK_REGISTRY,
  getTaskMeta,
  getMixedTasks,
  getFieldRetryTasks,
} from "../../lib/llm/taskRegistry.js";
import { deriveCredibilitySignal } from "../../lib/pipeline/validation/aiRelevance.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeText(chars) {
  const chunk = "This is a sentence about AI threat intelligence. ";
  let result = "";
  while (result.length < chars) result += chunk;
  return result.slice(0, chars);
}

function makeEvidenceItem(overrides = {}) {
  return {
    evidence_id: "ev_test_001",
    evidence_type: "research_result",
    fact: "GPT-4 was jailbroken with 88% ASR using PAIR methodology",
    source_quote: "we achieve an attack success rate of 88% on GPT-4 using PAIR",
    evidence_confidence: "high",
    best_used_for: ["case_study"],
    entities: ["GPT-4"],
    numbers: ["88%"],
    ...overrides,
  };
}

// ── 1. Long source chunking ───────────────────────────────────────────────────

process.stdout.write("\n1. Long source chunking\n");

test("short source (<LONG_THRESHOLD) returns empty chunks (single-pass path)", () => {
  const text = makeText(LONG_THRESHOLD - 100);
  const chunks = chunkSourceText(text);
  assert.equal(chunks.length, 0, "short source should not be chunked");
});

test("long source (>LONG_THRESHOLD) is split into multiple chunks", () => {
  const text = makeText(LONG_THRESHOLD * 2);
  const chunks = chunkSourceText(text);
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test("each chunk has chunk_id and byte_offset", () => {
  const text = makeText(LONG_THRESHOLD * 3);
  const chunks = chunkSourceText(text);
  for (const chunk of chunks) {
    assert.ok(typeof chunk.chunk_id === "number", "chunk_id must be number");
    assert.ok(typeof chunk.byte_offset === "number", "byte_offset must be number");
    assert.ok(chunk.byte_offset >= 0, "byte_offset must be non-negative");
    assert.ok(chunk.text.length > 0, "chunk text must be non-empty");
  }
});

test("chunk sizes are approximately CHUNK_SIZE", () => {
  const text = makeText(LONG_THRESHOLD * 3);
  const chunks = chunkSourceText(text);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= CHUNK_SIZE + 100, `chunk too large: ${chunk.text.length}`);
  }
});

test("chunks overlap by approximately CHUNK_OVERLAP chars", () => {
  const text = makeText(LONG_THRESHOLD * 2 + 500);
  const chunks = chunkSourceText(text);
  if (chunks.length >= 2) {
    const expectedSecondStart = CHUNK_SIZE - CHUNK_OVERLAP;
    assert.ok(
      Math.abs(chunks[1].byte_offset - expectedSecondStart) <= 50,
      `second chunk offset ${chunks[1].byte_offset} should be near ${expectedSecondStart}`
    );
  }
});

test("quote in chunk text can be traced to byte offset in source", () => {
  // Build a text with a known quote at a specific position
  const prefix = makeText(LONG_THRESHOLD + 1000);
  const knownQuote = "UNIQUE EVIDENCE STRING FOR TESTING";
  const text = prefix + knownQuote + makeText(2000);
  const chunks = chunkSourceText(text);

  // Find the chunk that contains the known quote
  const matchingChunk = chunks.find((c) => c.text.includes(knownQuote));
  assert.ok(matchingChunk, "known quote should appear in at least one chunk");

  // Verify the byte_offset correctly locates the quote in the original text
  const quoteInChunk = matchingChunk.text.indexOf(knownQuote);
  const absoluteOffset = matchingChunk.byte_offset + quoteInChunk;
  assert.equal(
    text.slice(absoluteOffset, absoluteOffset + knownQuote.length),
    knownQuote,
    "byte_offset allows tracing chunk content back to source"
  );
});

// ── 3. Deduplication of cross-chunk items ─────────────────────────────────────

process.stdout.write("\n3. Cross-chunk deduplication\n");

test("identical facts from overlapping chunks are deduplicated", () => {
  const items = [
    { ...makeEvidenceItem(), evidence_id: "ev_s_c0_1", fact: "GPT-4 was jailbroken with 88% ASR", evidence_confidence: "medium", chunk_id: 0, chunk_byte_offset: 0 },
    { ...makeEvidenceItem(), evidence_id: "ev_s_c1_1", fact: "GPT-4 was jailbroken with 88% ASR", evidence_confidence: "high", chunk_id: 1, chunk_byte_offset: 4000 },
    { ...makeEvidenceItem({ fact: "Researchers found a novel attack method" }), evidence_id: "ev_s_c0_2", chunk_id: 0, chunk_byte_offset: 0 },
  ];
  const deduped = deduplicateChunkItems(items);
  assert.equal(deduped.length, 2, `expected 2 unique items, got ${deduped.length}`);
});

test("deduplication keeps the highest confidence version", () => {
  const items = [
    { ...makeEvidenceItem(), evidence_id: "ev_c0_1", fact: "Prompt injection attack on GPT-4 achieved 88% success rate", evidence_confidence: "low", chunk_id: 0, chunk_byte_offset: 0 },
    { ...makeEvidenceItem(), evidence_id: "ev_c1_1", fact: "Prompt injection attack on GPT-4 achieved 88% success rate", evidence_confidence: "high", chunk_id: 1, chunk_byte_offset: 4000 },
  ];
  const deduped = deduplicateChunkItems(items);
  assert.equal(deduped.length, 1, "should keep only one");
  assert.equal(deduped[0].evidence_confidence, "high", "should keep the high-confidence version");
});

test("non-overlapping distinct facts from different chunks are kept", () => {
  const items = [
    { ...makeEvidenceItem({ fact: "CVE-2026-12345 affects GPT-4 API" }), evidence_id: "ev_c0_1", chunk_id: 0, chunk_byte_offset: 0 },
    { ...makeEvidenceItem({ fact: "Anthropic research shows 95% bypass rate" }), evidence_id: "ev_c1_1", chunk_id: 1, chunk_byte_offset: 4000 },
    { ...makeEvidenceItem({ fact: "CISA issued advisory on AI prompt injection" }), evidence_id: "ev_c2_1", chunk_id: 2, chunk_byte_offset: 8000 },
  ];
  const deduped = deduplicateChunkItems(items);
  assert.equal(deduped.length, 3, "distinct facts should all be kept");
});

// ── 4. Output validators — enum validation ────────────────────────────────────

process.stdout.write("\n4. Output validators — enum validation\n");

test("invalid evidence_type is rejected", () => {
  const item = makeEvidenceItem({ evidence_type: "not_a_real_type" });
  const result = validateEvidenceItem(item);
  assert.equal(result.valid, false, "invalid type should fail validation");
  assert.ok(result.errors.some((e) => e.includes("evidence_type")), "should mention evidence_type in error");
  assert.ok(result.failed_fields.includes("evidence_type"), "evidence_type in failed_fields");
});

test("valid evidence_type passes", () => {
  const item = makeEvidenceItem({ evidence_type: "research_result" });
  const result = validateEvidenceItem(item);
  assert.ok(!result.errors.some((e) => e.includes("evidence_type")), "valid type should not error");
});

test("invalid evidence_confidence is rejected", () => {
  const item = makeEvidenceItem({ evidence_confidence: "very_high" });
  const result = validateEvidenceItem(item);
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("evidence_confidence"), "should be in failed_fields");
});

test("invalid judgment_type in synthesis output is rejected", () => {
  const judgment = {
    judgment: "GPT-4 jailbreaks are commoditizing as tooling proliferates",
    judgment_type: "not_a_valid_type",
    evidence_for: ["ev_001"],
    evidence_against: [],
    what_changed: "Automated search achieves 88% ASR vs manual 20%",
    causal_mechanism: "Gradient-based optimization removes skill barrier",
    why_this_matters: "Low-sophistication actors can now bypass RLHF filters",
    uncertainty: "Lab ASR may not hold on production models",
    confidence: "medium",
    supporting_evidence_ids: ["ev_001"],
  };
  const result = validateStrategicJudgmentOutput(judgment, new Set(["ev_001"]));
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("judgment_type"), "judgment_type in failed_fields");
});

// ── 5. Output validators — hallucinated ID rejected ───────────────────────────

process.stdout.write("\n5. Output validators — hallucinated IDs\n");

test("synthesis judgment with invented evidence ID is flagged", () => {
  const allowedIds = new Set(["ev_real_001", "ev_real_002"]);
  const judgment = {
    judgment: "Real analytical conclusion about AI threats",
    judgment_type: "capability_change",
    evidence_for: ["ev_real_001", "ev_INVENTED_999"],  // invented ID
    evidence_against: [],
    what_changed: "Attack capability increased significantly",
    causal_mechanism: "Automated tooling proliferates",
    why_this_matters: "Defenders face expanded attack surface",
    uncertainty: "Not confirmed in production environments",
    confidence: "medium",
    supporting_evidence_ids: ["ev_real_001", "ev_INVENTED_999"],
  };
  const result = validateStrategicJudgmentOutput(judgment, allowedIds);
  assert.equal(result.valid, false, "invented ID should fail");
  assert.ok(result.errors.some((e) => e.includes("ev_INVENTED_999")), "should name the invented ID");
  assert.ok(result.failed_fields.includes("evidence_for"), "evidence_for in failed_fields");
});

test("slide content with invented evidence callout ID is flagged", () => {
  const allowed = new Set(["ev_real_001"]);
  const slide = {
    headline: "AI jailbreak tooling commoditizes bypass attacks",
    bullets: [{ text: "Automated search achieves 88% ASR on GPT-4", bullet_role: "finding", supporting_evidence_id: "ev_real_001" }],
    evidence_callouts: [
      { evidence_id: "ev_INVENTED_999", title: "Test", key_fact: "88%", publisher: "arXiv", url: "https://arxiv.org/abs/test" },
    ],
    citations: [],
  };
  const result = validateSlideContent(slide, allowed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ev_INVENTED_999")), "should name the invented ID");
  assert.ok(result.failed_fields.includes("evidence_callouts"), "evidence_callouts in failed_fields");
});

test("judgment citing only valid IDs passes", () => {
  const allowedIds = new Set(["ev_real_001", "ev_real_002"]);
  const judgment = {
    judgment: "Real analytical conclusion",
    judgment_type: "capability_change",
    evidence_for: ["ev_real_001"],
    evidence_against: ["ev_real_002"],
    what_changed: "Meaningful capability shift occurred",
    causal_mechanism: "Gradient descent enables automated search",
    why_this_matters: "Low-skill adversaries can now bypass filters",
    uncertainty: "Lab conditions only; production unknown",
    confidence: "medium",
    supporting_evidence_ids: ["ev_real_001", "ev_real_002"],
  };
  const result = validateStrategicJudgmentOutput(judgment, allowedIds);
  assert.equal(result.valid, true, `should be valid: ${result.errors.join("; ")}`);
});

// ── 6. Output validators — quote validation ───────────────────────────────────

process.stdout.write("\n6. Output validators — quote validation\n");

test("evidence item with empty source_quote fails validation", () => {
  const item = makeEvidenceItem({ source_quote: "" });
  const result = validateEvidenceItem(item);
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("source_quote"), "source_quote in failed_fields");
});

test("evidence item with short source_quote (<12 chars) fails validation", () => {
  const item = makeEvidenceItem({ source_quote: "too short" });  // 9 chars
  const result = validateEvidenceItem(item);
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("source_quote"), "source_quote in failed_fields");
});

test("evidence item with valid source_quote (≥12 chars) passes", () => {
  const item = makeEvidenceItem({ source_quote: "we achieve an attack success rate of 88% on GPT-4" });
  const result = validateEvidenceItem(item);
  assert.ok(!result.failed_fields.includes("source_quote"), "valid quote should not fail");
});

// ── 7. Output validators — slide headline length ──────────────────────────────

process.stdout.write("\n7. Slide content validators\n");

test("slide with headline >20 words fails validation", () => {
  const longHeadline = "This is a very long headline that has way too many words and should definitely fail the validation check for length constraints";
  const slide = {
    headline: longHeadline,
    bullets: [{ text: "Short bullet", bullet_role: "finding" }],
    evidence_callouts: [],
    citations: [],
  };
  const result = validateSlideContent(slide, new Set());
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("headline"), "headline in failed_fields");
});

test("slide with ≤20 word headline passes", () => {
  const slide = {
    headline: "AI jailbreak tooling commoditizes bypass attacks in 2026",  // 10 words
    bullets: [{ text: "Concrete finding here", bullet_role: "finding" }],
    evidence_callouts: [],
    citations: [],
  };
  const result = validateSlideContent(slide, new Set());
  assert.ok(!result.failed_fields.includes("headline"), `headline should pass: ${result.errors.join("; ")}`);
});

test("slide with invalid bullet_role fails validation", () => {
  const slide = {
    headline: "Valid headline about AI threats",
    bullets: [{ text: "Some bullet", bullet_role: "invalid_role" }],
    evidence_callouts: [],
    citations: [],
  };
  const result = validateSlideContent(slide, new Set());
  assert.equal(result.valid, false);
  assert.ok(result.failed_fields.includes("bullets"), "bullets in failed_fields");
});

// ── 8. URL validation ─────────────────────────────────────────────────────────

process.stdout.write("\n8. URL validation\n");

test("fabricated domain URL fails validation", () => {
  const result = validateLlmOutputUrl("https://example.com/some-article");
  assert.equal(result.valid, false, "fabricated domain should fail");
  assert.ok(result.reason.includes("fabricated"), `reason should mention fabricated: ${result.reason}`);
});

test("valid URL passes validation", () => {
  const result = validateLlmOutputUrl("https://arxiv.org/abs/2024.12345");
  assert.equal(result.valid, true, `valid URL should pass: ${result.reason}`);
});

test("non-http URL fails validation", () => {
  const result = validateLlmOutputUrl("ftp://some-file.example.net");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("http"), `reason should mention http: ${result.reason}`);
});

test("empty URL passes (optional field)", () => {
  const result = validateLlmOutputUrl("");
  assert.equal(result.valid, true, "empty URL should pass (field is optional)");
});

// ── 9. Field-level retry instructions ────────────────────────────────────────

process.stdout.write("\n9. Field-level retry\n");

test("empty source_quote generates retry instruction for evidence_extraction", () => {
  const failedItem = makeEvidenceItem({
    source_quote: "",
    fact: "GPT-4 was jailbroken with PAIR methodology",
  });
  const { should_retry, retry_instructions } = buildFieldRetryInstruction(
    "evidence_extraction", ["source_quote"], failedItem
  );
  assert.equal(should_retry, true, "should retry");
  assert.ok(retry_instructions.includes("source_quote"), `instructions should mention source_quote: ${retry_instructions.slice(0, 100)}`);
  assert.ok(retry_instructions.includes("PAIR"), "instructions should include the failing fact");
});

test("invalid evidence_type generates retry instruction", () => {
  const failedItem = makeEvidenceItem({ evidence_type: "invalid_type" });
  const { should_retry, retry_instructions } = buildFieldRetryInstruction(
    "evidence_extraction", ["evidence_type"], failedItem
  );
  assert.equal(should_retry, true);
  assert.ok(retry_instructions.includes("evidence_type"), "should mention evidence_type");
});

test("no failed fields returns should_retry=false", () => {
  const { should_retry } = buildFieldRetryInstruction("evidence_extraction", []);
  assert.equal(should_retry, false, "no failed fields → no retry needed");
});

// ── 10. Task registry — all tasks documented ─────────────────────────────────

process.stdout.write("\n10. Task registry\n");

test("task registry has all expected pipeline tasks", () => {
  const expectedTasks = [
    "source_relevance", "source_relevance_qa", "source_quality_gate",
    "source_typing", "source_understanding",
    "evidence_extraction", "evidence_judgment", "evidence_qa",
    "category_synthesis", "cross_category_synthesis",
    "slide_content", "speaker_notes",
  ];
  for (const task of expectedTasks) {
    assert.ok(TASK_REGISTRY[task], `task "${task}" missing from registry`);
  }
});

test("every registry entry has responsibility and status", () => {
  const VALID_STATUSES = new Set(["narrow", "mixed", "multi-stage"]);
  for (const [name, meta] of Object.entries(TASK_REGISTRY)) {
    assert.ok(meta.responsibility || meta.stages, `"${name}" missing responsibility`);
    assert.ok(meta.status, `"${name}" missing status`);
    assert.ok(VALID_STATUSES.has(meta.status), `"${name}" status "${meta.status}" must be narrow|mixed|multi-stage`);
    // For multi-stage tasks, check each stage
    if (meta.stages) {
      for (const [stageName, stage] of Object.entries(meta.stages)) {
        assert.ok(stage.responsibility, `"${name}.${stageName}" missing responsibility`);
        assert.ok(stage.status, `"${name}.${stageName}" missing status`);
      }
    }
  }
});

test("getTaskMeta returns correct entry", () => {
  const meta = getTaskMeta("evidence_extraction");
  assert.ok(meta, "should find evidence_extraction");
  assert.equal(meta.status, "narrow", "evidence_extraction should be narrow");
  assert.ok(meta.field_retry, "evidence_extraction should have field_retry");
});

test("getTaskMeta returns null for unknown task", () => {
  const meta = getTaskMeta("not_a_real_task");
  assert.equal(meta, null);
});

// ── 11. Mixed tasks are all justified ────────────────────────────────────────

process.stdout.write("\n11. Mixed tasks have justification\n");

test("every mixed task has a status_reason explaining why it is justified", () => {
  const mixed = getMixedTasks();
  for (const { task_name, reason } of mixed) {
    assert.ok(reason && reason.length > 20, `mixed task "${task_name}" has no justification (status_reason)`);
    assert.ok(reason.includes("JUSTIFIED") || reason.includes("justified"),
      `mixed task "${task_name}" reason should say JUSTIFIED: "${reason.slice(0, 80)}"`);
  }
});

test("field-level retry tasks are documented in registry", () => {
  const retryTasks = getFieldRetryTasks();
  const retryTaskNames = retryTasks.map((t) => t.task_name);
  assert.ok(retryTaskNames.includes("evidence_extraction"),
    "evidence_extraction should have field_retry configured");
  assert.ok(retryTaskNames.includes("slide_content"),
    "slide_content should have field_retry configured");
});

// ── 12. Deterministic credibility signal (L3 refactor) ───────────────────────

process.stdout.write("\n12. Deterministic credibility signal (L3 refactor)\n");

test("CISA primary authority source gets authoritative_advisory", () => {
  const source = {
    publisher_class: "primary_authority",
    trust_tier: "primary",
    title: "CISA Advisory: AI-enabled phishing campaigns",
    source_type: "governance_signal",
  };
  const signal = deriveCredibilitySignal(source);
  assert.equal(signal, "authoritative_advisory", `got ${signal}`);
});

test("vendor source gets vendor_marketing", () => {
  const source = {
    independence_level: "vendor_interested",
    publisher_class: "major_vendor",
    title: "CrowdStrike launches new AI-powered threat detection",
    full_text: "Our platform now available with AI threat detection. Sign up for a free trial today.",
    source_type: "research_finding",
    trust_tier: "medium",
  };
  const signal = deriveCredibilitySignal(source);
  assert.equal(signal, "vendor_marketing", `got ${signal}`);
});

test("research finding from arXiv gets primary_research", () => {
  const source = {
    publisher_class: "academic",
    trust_tier: "high",
    source_type: "research_finding",
    title: "Automated jailbreaks via PAIR methodology",
    full_text: "We propose PAIR methodology and evaluate it against GPT-4. Our approach achieves 88% ASR.",
  };
  const signal = deriveCredibilitySignal(source);
  assert.equal(signal, "primary_research", `got ${signal}`);
});

test("speculative blog gets speculative_analysis", () => {
  const source = {
    title: "The future of AI in cybersecurity and what to watch for",
    full_text: "AI will become the dominant attack vector by 2027. We predict these trends will reshape the landscape.",
    source_type: "attack_surface_signal",
    trust_tier: "low",
  };
  const signal = deriveCredibilitySignal(source);
  assert.equal(signal, "speculative_analysis", `got ${signal}`);
});

test("deriveCredibilitySignal never produces source_type or source_relevance data", () => {
  // The signal should only be one of the 7 valid credibility signals
  const VALID_SIGNALS = new Set([
    "primary_research", "authoritative_advisory", "threat_intelligence",
    "technical_disclosure", "secondary_reporting", "vendor_marketing",
    "speculative_analysis", "unknown",
  ]);
  const testSources = [
    { trust_tier: "high", source_type: "incident" },
    { trust_tier: "primary", source_type: "governance_signal", publisher_class: "primary_authority" },
    { trust_tier: "low", source_type: "unknown" },
  ];
  for (const s of testSources) {
    const signal = deriveCredibilitySignal(s);
    assert.ok(VALID_SIGNALS.has(signal), `"${signal}" not a valid credibility signal`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
