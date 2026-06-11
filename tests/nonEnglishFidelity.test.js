/**
 * Non-English fidelity (audit 1 P0.7) — Latin-script non-English must be detected
 * (not summarised as English), and evidence extracted from a non-English source must
 * cap at context_only (the English "fact" is an LLM translation, not English-quote-
 * grounded, so it cannot anchor a claim).
 *
 * Run with: node tests/nonEnglishFidelity.test.js
 */

import assert from "node:assert/strict";
import { checkSourceValidity } from "../lib/pipeline/validation/sourceValidity.js";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

console.log("\nLatin-script non-English detection");

test("Spanish text is detected as non_english (was passed as English by the ASCII heuristic)", () => {
  const r = checkSourceValidity({
    title: "Nueva campaña de phishing con inteligencia artificial",
    url: "https://es.example.com/a", publisher: "Example",
    full_text: "Los investigadores descubrieron que los atacantes utilizan modelos de lenguaje para generar correos de phishing más convincentes y eludir los controles de seguridad de las empresas.",
  });
  assert.equal(r.detected_language, "non_english");
  assert.ok(r.filter_flags.includes("possible_non_english"));
});

test("French text is detected as non_english", () => {
  const r = checkSourceValidity({
    title: "Une nouvelle attaque par injection de prompt",
    url: "https://fr.example.com/a", publisher: "Example",
    full_text: "Les chercheurs ont démontré que les attaquants peuvent contourner les garde-fous des modèles de langage avec une injection de prompt indirecte dans les documents.",
  });
  assert.equal(r.detected_language, "non_english");
});

test("English security text stays English (no false positive on code-heavy English)", () => {
  const r = checkSourceValidity({
    title: "Prompt injection bypasses the guardrail",
    url: "https://en.example.com/a", publisher: "Example",
    full_text: "The researchers found that attackers can bypass the model guardrail with an indirect prompt injection embedded in a retrieved document, and this technique is not detected by current filters.",
  });
  assert.equal(r.detected_language, "en");
  assert.ok(!r.filter_flags.includes("possible_non_english"));
});

console.log("\nNon-English source caps evidence at context_only");

const item = {
  evidence_id: "ev1", fact: "Attackers used AI to compromise three banks via spear-phishing.",
  source_quote: "Los atacantes utilizaron IA para comprometer tres bancos.",
  quote_verified: true, is_atomic: true, entities: ["three banks"], numbers: ["3"],
  evidence_type: "incident_event",
};

test("evidence from a non_english source is capped to context_only", () => {
  const r = triageEvidenceItem(item, {
    id: "s", url: "https://es.example.com/a", source_type: "incident", detected_language: "non_english",
  }, { concrete_claim: true, direct_demonstration: true });
  assert.equal(r.admissibility, "context_only", `expected context_only, got ${r.admissibility}`);
  assert.ok(r.limitations.includes("non_english_source"));
});

test("the same evidence from an English source passes", () => {
  const r = triageEvidenceItem(
    { ...item, source_quote: "Attackers used AI to compromise three banks via spear-phishing." },
    { id: "s", url: "https://en.example.com/a", source_type: "incident", detected_language: "en" },
    { concrete_claim: true, direct_demonstration: true }
  );
  assert.equal(r.admissibility, "passed");
  assert.ok(!r.limitations.includes("non_english_source"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
