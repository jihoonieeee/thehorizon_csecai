import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceTags, frameworkCellText, NA_TEXT } from "../lib/frameworks/sourceTags.js";
import { NA_TEXT as MAP_NA_TEXT } from "../lib/pipeline/understand/mapFrameworks.js";

const catalogue = new Map([
  ["T1566",     { name: "Phishing",           domain: "enterprise", url: "https://attack.mitre.org/techniques/T1566" }],
  ["T1059",     { name: "Command and Scripting Interpreter", domain: "enterprise", url: null }],
  ["T1417",     { name: "Input Capture",      domain: "mobile",     url: null }],
  ["AML.T0051", { name: "LLM Prompt Injection", domain: null,      url: null }],
]);

test("NA text is shared with the enrich step", () => {
  assert.equal(NA_TEXT, MAP_NA_TEXT);
});

test("model mapping: tagged techniques carry name, quote and confidence; N/A uses stored reason", () => {
  const out = buildSourceTags({
    statuses: [
      { source_id: "s1", framework: "attack", status: "tagged" },
      { source_id: "s1", framework: "atlas",  status: "not_applicable", na_reason: null },
    ],
    techniques: [
      { source_id: "s1", framework: "attack", technique_id: "T1566", confidence: "high", quote: "sent phishing emails" },
      { source_id: "s1", framework: "attack", technique_id: "T1417", confidence: "low",  quote: "captured keystrokes" },
    ],
    catalogue,
  });
  const { attack, atlas } = out.s1;
  assert.equal(attack.reviewed, false);
  assert.deepEqual(attack.techniques.map(t => t.id), ["T1417", "T1566"]);
  assert.equal(attack.techniques[1].quote, "sent phishing emails");
  assert.equal(attack.text, "T1417 Input Capture (Mobile); T1566 Phishing");
  assert.equal(atlas.text, NA_TEXT.atlas);
  assert.deepEqual(atlas.techniques, []);
});

test("analyst review replaces the model answer and keeps quotes only for IDs the model also found", () => {
  const out = buildSourceTags({
    statuses:   [{ source_id: "s1", framework: "attack", status: "tagged" }],
    techniques: [{ source_id: "s1", framework: "attack", technique_id: "T1566", confidence: "high", quote: "q1" }],
    reviews:    [{ source_id: "s1", framework: "attack", outcome: "tagged", technique_ids: ["T1566", "T1059"], review_batch: "2026-08" }],
    catalogue,
  });
  const a = out.s1.attack;
  assert.equal(a.reviewed, true);
  assert.equal(a.review_batch, "2026-08");
  assert.deepEqual(a.techniques.map(t => [t.id, t.quote]), [["T1059", null], ["T1566", "q1"]]);
});

test("review outcome N/A or none clears the model's techniques", () => {
  const out = buildSourceTags({
    statuses:   [{ source_id: "s1", framework: "attack", status: "tagged" }, { source_id: "s1", framework: "atlas", status: "tagged" }],
    techniques: [
      { source_id: "s1", framework: "attack", technique_id: "T1566" },
      { source_id: "s1", framework: "atlas",  technique_id: "AML.T0051" },
    ],
    reviews: [
      { source_id: "s1", framework: "attack", outcome: "not_applicable", technique_ids: [] },
      { source_id: "s1", framework: "atlas",  outcome: "none",           technique_ids: [] },
    ],
    catalogue,
  });
  assert.equal(out.s1.attack.text, NA_TEXT.attack);
  assert.deepEqual(out.s1.attack.techniques, []);
  assert.equal(out.s1.atlas.status, "none");
  assert.equal(out.s1.atlas.text, "");
});

test("a source with no rows is absent (not tagged yet); unknown IDs still display", () => {
  const out = buildSourceTags({
    reviews: [{ source_id: "s2", framework: "atlas", outcome: "tagged", technique_ids: ["AML.T9999"] }],
    catalogue,
  });
  assert.equal(out.s1, undefined);
  assert.equal(out.s2.attack, undefined);
  assert.equal(out.s2.atlas.text, "AML.T9999");
  assert.equal(frameworkCellText(undefined), "");
});
