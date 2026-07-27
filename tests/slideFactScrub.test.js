import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFactGrounding, scrubSlideReport } from "../lib/slides/scrubSlideFacts.js";

// checkFactGrounding drops facts whose SPECIFIC figures are absent from grounding.
// It targets invented/mis-stated numbers; entity conflation is out of scope (prompt).

test("invented comma-number absent from grounding is flagged", () => {
  const r = checkFactGrounding(
    "Anthropic banned 832 accounts mapped to 13,873 actions across 14 tactics.",
    "Anthropic banned 832 accounts using AI across all 14 MITRE tactics and 482 techniques.",
  );
  assert.equal(r.grounded, false);
  assert.deepEqual(r.ungrounded, ["13,873"]);
});

test("invented large stat absent from grounding is flagged", () => {
  const r = checkFactGrounding(
    "Averaging 972 attacks per day and 35,000 catalogued sessions.",
    "LLMjacking uses stolen AI compute as offensive infrastructure.",
  );
  assert.equal(r.grounded, false);
  assert.ok(r.ungrounded.includes("972") && r.ungrounded.includes("35,000"));
});

test("figures present in grounding are kept", () => {
  const r = checkFactGrounding(
    "28.8 million exchanges via ~25,000 accounts, 90% success.",
    "The campaign ran 28.8 million exchanges through nearly 25,000 accounts at a 90% rate.",
  );
  assert.equal(r.grounded, true);
});

test("count-word grounded by its digit form (and vice-versa)", () => {
  assert.equal(checkFactGrounding("Four sessions over fourteen hours.", "4 sessions, 14 hours of operation.").grounded, true);
  // A count-word IS checked regardless of size: "five" absent from grounding → flagged.
  assert.equal(checkFactGrounding("Five skills connected to C2.", "Two skills connected to C2.").grounded, false);
});

test("2-digit bare integers are below the specificity threshold (not scrubbed)", () => {
  // "31" is 2 digits, no comma/decimal/%, so it is not treated as a specific figure.
  assert.equal(checkFactGrounding("Compromised 31 packages.", "unrelated grounding").grounded, true);
});

test("number+unit is specific even at 1-2 digits (lever 1)", () => {
  // "22 MB" absent from grounding → flagged, even though 22 is 2 digits.
  assert.equal(checkFactGrounding("one used 22 MB file padding.", "a skill inflated its file size").grounded, false);
  // present → kept
  assert.equal(checkFactGrounding("one used 22 MB file padding.", "the skill inflated its file to 22 MB").grounded, true);
  // time unit
  assert.equal(checkFactGrounding("ran for 8 hours.", "operated across roughly 14 hours").grounded, false);
  // a bare 2-digit integer with no unit is still not scrubbed
  assert.equal(checkFactGrounding("22 packages were affected.", "unrelated").grounded, true);
});

test("facts with no specific figures are untouched", () => {
  const r = checkFactGrounding("Model registries are now active malware channels.", "unrelated grounding");
  assert.equal(r.grounded, true);
  assert.deepEqual(r.ungrounded, []);
});

test("small bare integers in prose are not treated as specific figures", () => {
  // "4 pivots" is a low-risk 1-digit integer — not scrubbed even if grounding lacks it.
  const r = checkFactGrounding("The agent made 4 pivots.", "The agent moved laterally through the network.");
  assert.equal(r.grounded, true);
});

test("scrubSlideReport drops the ungrounded fact and keeps the rest", () => {
  const report = {
    strategic_shifts: [{
      headline: "Test shift",
      supporting_evidence: [
        { fact: "A real stat of 28.8 million exchanges.", cited_sources: ["S1"] },
        { fact: "An invented 13,873 actions figure.", cited_sources: ["S1"] },
      ],
    }],
  };
  const context = { insightsBlock: "The campaign ran 28.8 million exchanges.", sourceIndex: { S1: { summary: "", evidence_text: "" } } };
  const dropped = scrubSlideReport(report, context);
  assert.equal(dropped.length, 1);
  assert.equal(report.strategic_shifts[0].supporting_evidence.length, 1);
  assert.match(report.strategic_shifts[0].supporting_evidence[0].fact, /28\.8 million/);
});
