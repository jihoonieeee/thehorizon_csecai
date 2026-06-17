/**
 * Case study diagram generation tests.
 * Deterministic — no network. LLM is injected via opts.llmFn.
 * Run with: node tests/caseDiagrams.test.js
 */

import assert from "node:assert/strict";

import {
  generateCaseDiagram,
  generateAllCaseDiagrams,
  AI_DIAGRAM_FOOTNOTE,
  DIAGRAM_GEN_VERSION,
} from "../lib/pipeline/slides/generateCaseDiagrams.js";

// planSlides helpers (diagram decision logic)
// We test these by constructing slides that planSlides would produce

let passed = 0, failed = 0;
async function test(name, fn) {
  try   { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkCaseStudySlide(over = {}) {
  return {
    slide_id:    "slide_012",
    slide_number: 12,
    slide_type:  "case_study",
    category:    "llm_threats",
    claim_id:    "claim_llm_1",
    claim_text:  "Prompt injection via RAG document poisoning reached operational deployment.",
    supporting_evidence_ids: ["ev_001"],
    supporting_evidence:     [mkEvidence()],
    needs_diagram:           true,
    visualization_ids:       [],
    diagram_requirements: {
      subject:           "RAG document poisoning attack flow",
      claim_text:        "Prompt injection via RAG document poisoning reached operational deployment.",
      key_fact:          "3 confirmed incidents of LLM guardrail bypass via poisoned RAG documents",
      entities:          ["Attacker", "RAG Pipeline", "Document Store", "LLM"],
      attack_steps:      [
        "Inject malicious instructions into documents",
        "Documents ingested into vector store",
        "LLM retrieves poisoned context",
        "Guardrails bypassed — attacker instructions executed",
      ],
      numbers:           ["3 incidents"],
      source_evidence_id:"ev_001",
      category:          "llm_threats",
    },
    ...over,
  };
}

function mkEvidence() {
  return {
    evidence_id:      "ev_001",
    evidence_type:    "incident_report",
    evidence_class:   "operational",
    evidence_strength:"strong",
    fact:             "3 confirmed RAG poisoning incidents in enterprise LLM deployments",
    entities:         ["RAG Pipeline", "ChatGPT Enterprise", "Document Store"],
    numbers:          ["3"],
    source_id:        "src_001",
    url:              "https://example.com/nist-advisory",
    publisher:        "NIST",
    title:            "NIST AI Incident Report 2026",
  };
}

// Mock LLM that returns valid Mermaid DSL
function mockLlmSuccess() {
  return async () => ({
    result: JSON.stringify({
      diagram_type:  "flowchart LR",
      mermaid_dsl:   "flowchart LR\n  A[Attacker] --> B[Document Store]\n  B --> C[RAG Pipeline]\n  C --> D[LLM]\n  D --> E[Guardrail Bypass]",
      caption:       "RAG document poisoning attack flow",
      what_it_shows: "How attackers inject malicious instructions into RAG documents",
    }),
    model: "claude-sonnet-4-6",
  });
}

// Mock LLM that returns invalid DSL
function mockLlmInvalidDsl() {
  return async () => ({
    result: JSON.stringify({
      diagram_type:  "flowchart LR",
      mermaid_dsl:   "this is not valid mermaid",
      caption:       "bad diagram",
    }),
    model: "claude-sonnet-4-6",
  });
}

// Mock LLM that throws
function mockLlmFailure() {
  return async () => { throw new Error("LLM call failed"); };
}

// ── 1. generateCaseDiagram — happy path ──────────────────────────────────────

console.log("\n── generateCaseDiagram — happy path ──");

await test("returns DiagramSpec with all required fields", async () => {
  const slide = mkCaseStudySlide();
  const spec  = await generateCaseDiagram(slide, { llmFn: mockLlmSuccess() });
  assert.ok(spec, "spec not null");
  assert.ok(spec.visualization_id.startsWith("diagram_"), "visualization_id prefixed");
  assert.equal(spec.visualization_type, "ai_diagram");
  assert.equal(spec.ai_generated, true);
  assert.ok(spec.footnote.includes("AI-generated"), "footnote mentions AI-generated");
  assert.ok(spec.render_url.startsWith("https://mermaid.ink"), "render_url is mermaid.ink");
  assert.ok(spec.mermaid_dsl.startsWith("flowchart"), "valid mermaid DSL");
  assert.equal(spec.source_evidence_id, "ev_001");
  assert.equal(spec.generation_model, "claude-sonnet-4-6");
  assert.equal(spec.diagram_gen_version, DIAGRAM_GEN_VERSION);
});

await test("footnote is the canonical AI_DIAGRAM_FOOTNOTE constant", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.equal(spec.footnote, AI_DIAGRAM_FOOTNOTE);
});

await test("image_url alias matches render_url for legacy renderers", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.equal(spec.image_url, spec.render_url);
});

await test("caption is populated from LLM output", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.ok(spec.caption.length > 0);
});

await test("usage_rights_status is ai_generated", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.equal(spec.usage_rights_status, "ai_generated");
});

// ── 2. Fallback on LLM failure ────────────────────────────────────────────────

console.log("\n── Fallback on LLM failure ──");

await test("falls back to deterministic when LLM throws", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmFailure() });
  assert.ok(spec, "spec not null — deterministic fallback produced a result");
  assert.equal(spec.generation_model, "deterministic");
  assert.ok(spec.mermaid_dsl.startsWith("flowchart"), "deterministic DSL starts with flowchart");
});

await test("falls back to deterministic when LLM returns invalid Mermaid", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmInvalidDsl() });
  assert.ok(spec, "fallback produced a result");
  assert.equal(spec.generation_model, "deterministic");
});

await test("deterministic fallback uses attack_steps as nodes", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmFailure() });
  // The deterministic diagram uses attack_steps
  assert.ok(spec.mermaid_dsl.includes("Inject"), "attack step included in fallback DSL");
});

await test("returns null when slide has no diagram_requirements", async () => {
  const slide = mkCaseStudySlide({ diagram_requirements: null });
  const spec  = await generateCaseDiagram(slide, { skipLlm: true });
  assert.equal(spec, null);
});

// ── 3. skipLlm mode ───────────────────────────────────────────────────────────

console.log("\n── skipLlm mode ──");

await test("skipLlm=true produces deterministic diagram without calling LLM", async () => {
  let called = false;
  const llmFn = async () => { called = true; return { result: "{}", model: "x" }; };
  const spec  = await generateCaseDiagram(mkCaseStudySlide(), { skipLlm: true, llmFn });
  assert.ok(!called, "LLM not called when skipLlm=true");
  // Should still produce a deterministic result
  assert.ok(spec === null || spec.generation_model === "deterministic");
});

// ── 4. generateAllCaseDiagrams ────────────────────────────────────────────────

console.log("\n── generateAllCaseDiagrams ──");

await test("skips slides without needs_diagram=true", async () => {
  const slides = [
    { slide_id: "s1", slide_type: "critical_claim", needs_diagram: false },
    { slide_id: "s2", slide_type: "case_study",     needs_diagram: false },
  ];
  const { diagramSpecs, updatedSlides } = await generateAllCaseDiagrams(slides, { skipLlm: true });
  assert.equal(diagramSpecs.length, 0);
  assert.equal(updatedSlides.length, 2);
});

await test("generates diagram for each case_study slide with needs_diagram=true", async () => {
  const slides = [
    mkCaseStudySlide({ slide_id: "s1" }),
    mkCaseStudySlide({ slide_id: "s2" }),
    { slide_id: "s3", slide_type: "critical_claim", needs_diagram: false },
  ];
  const { diagramSpecs, updatedSlides } = await generateAllCaseDiagrams(slides, {
    llmFn: mockLlmSuccess(),
  });
  assert.equal(diagramSpecs.length, 2, "two diagrams generated");
  assert.equal(updatedSlides.length, 3, "all slides returned");
});

await test("patches visualization_ids onto the matching slides", async () => {
  const slides = [mkCaseStudySlide({ slide_id: "s1" })];
  const { diagramSpecs, updatedSlides } = await generateAllCaseDiagrams(slides, {
    llmFn: mockLlmSuccess(),
  });
  const updated = updatedSlides[0];
  assert.ok(updated.visualization_ids.includes(diagramSpecs[0].visualization_id),
    "visualization_id patched onto slide");
});

await test("attaches ai_diagram_spec to the updated slide", async () => {
  const slides = [mkCaseStudySlide({ slide_id: "s1" })];
  const { updatedSlides } = await generateAllCaseDiagrams(slides, { llmFn: mockLlmSuccess() });
  assert.ok(updatedSlides[0].ai_diagram_spec, "ai_diagram_spec attached to slide");
  assert.equal(updatedSlides[0].ai_diagram_spec.ai_generated, true);
});

await test("non-case-study slides are returned unchanged", async () => {
  const other = { slide_id: "s99", slide_type: "exec_overview", visualization_ids: ["viz_1"] };
  const { updatedSlides } = await generateAllCaseDiagrams(
    [mkCaseStudySlide({ slide_id: "s1" }), other],
    { llmFn: mockLlmSuccess() }
  );
  const returnedOther = updatedSlides.find((s) => s.slide_id === "s99");
  assert.deepEqual(returnedOther.visualization_ids, ["viz_1"], "unchanged");
});

// ── 5. Traceability requirements ──────────────────────────────────────────────

console.log("\n── Traceability requirements ──");

await test("spec always has source_evidence_id", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.ok(spec.source_evidence_id, "source_evidence_id present");
});

await test("spec render_url is a valid mermaid.ink URL", async () => {
  const spec = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  assert.match(spec.render_url, /^https:\/\/mermaid\.ink\/img\//);
});

await test("render_url contains base64-encoded mermaid DSL", async () => {
  const spec    = await generateCaseDiagram(mkCaseStudySlide(), { llmFn: mockLlmSuccess() });
  const b64     = spec.render_url.replace("https://mermaid.ink/img/", "");
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  assert.ok(decoded.startsWith("flowchart"), "decoded render_url contains the Mermaid DSL");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
