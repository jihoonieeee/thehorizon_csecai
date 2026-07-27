import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCategoryContext } from "../lib/slides/buildCategoryContext.js";

const insightPoints = {
  assessment: "Category thesis for the period.",
  insights: [
    {
      title: "State-scale model theft confirmed",
      insight: "A state-linked actor extracted frontier capability via fraudulent API access.",
      explanation_points: ["25,000 fraudulent accounts", "28.8 million exchanges"],
      confidence: "Medium",
      sources: [{ url: "https://ex.com/a", title: "A", publisher: "Pub", date: "2026-06-25", maturity: "observed" }],
    },
    {
      title: "Config-file RCE in a popular ML library",
      insight: "Attacker-crafted config files execute code at model load time.",
      explanation_points: ["CVE issued", "232M downloads"],
      confidence: "Medium",
      sources: [{ url: "https://ex.com/b", title: "B", publisher: "Pub", date: "2026-06-20", maturity: "disclosed" }],
    },
  ],
};

test("insight sources merge into the citable pool (dedup by url)", () => {
  const selected = [{ id: "x", url: "https://ex.com/a", title: "A dup", publisher: "P", date_published: "2026-06-25", intelligence: {}, tags: [], _evidence: [] }];
  const ctx = buildCategoryContext("llm_threats", selected, null, insightPoints);
  // 1 selected (== insight source A by url) + insight source B = 2, not 3
  assert.equal(ctx.sources.length, 2);
});

test("insightsBlock carries headline seed, points, and resolved citations", () => {
  const ctx = buildCategoryContext("llm_threats", [], null, insightPoints);
  assert.ok(ctx.insightsBlock.includes("Headline seed: State-scale model theft confirmed"));
  assert.ok(ctx.insightsBlock.includes("Cite:       S1"));
  assert.ok(ctx.insightsBlock.includes("Cite:       S2"));
  assert.equal(ctx.assessment, "Category thesis for the period.");
});

test("insight maturity maps to the slide scale (observed→observed_exploitation, disclosed→disclosed_vulnerability)", () => {
  const ctx = buildCategoryContext("llm_threats", [], null, insightPoints);
  assert.ok(ctx.insightsBlock.includes("Maturity:   observed_exploitation"));
  assert.ok(ctx.insightsBlock.includes("Maturity:   disclosed_vulnerability"));
});

test("no insights → empty block, fallback to dossier synthesis", () => {
  const selected = [{ id: "x", url: "https://ex.com/z", title: "Z", publisher: "P", date_published: "2026-06-01", intelligence: {}, tags: [], _evidence: [] }];
  const ctx = buildCategoryContext("llm_threats", selected, null, null);
  assert.equal(ctx.insightsBlock, "");
  assert.equal(ctx.assessment, "");
  assert.equal(ctx.sources.length, 1);
});
