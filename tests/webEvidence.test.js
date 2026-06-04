/**
 * Layer 5C Web Evidence Branch tests. Deterministic — no network, no DB.
 * Run with: node tests/webEvidence.test.js
 */

import assert from "node:assert/strict";

import { executeWebSearch, dedupeSearchResults } from "../lib/pipeline/webEvidence/executeWebSearch.js";
import { normalizeSearchResult } from "../lib/pipeline/webEvidence/webEvidenceSchemas.js";
import { makeWebEvidenceObject, makeVisualEvidenceObject } from "../lib/pipeline/webEvidence/webEvidenceSchemas.js";
import { assessEvidenceDepth, assessWalkthroughStatus } from "../lib/pipeline/webEvidence/extractWebEvidence.js";
import { validateWebEvidence } from "../lib/pipeline/webEvidence/validateWebEvidence.js";
import { validateVisualEvidence } from "../lib/pipeline/webEvidence/validateVisualEvidence.js";
import { applyVisualClassification, classifyVisual } from "../lib/pipeline/webEvidence/classifyVisuals.js";
import { evaluateVisual, deterministicVisualFilter } from "../lib/pipeline/webEvidence/evaluateVisualUsefulness.js";
import { clusterVisualEvidence } from "../lib/pipeline/webEvidence/clusterVisualEvidence.js";
import { extractVisualCandidates } from "../lib/pipeline/webEvidence/extractVisualEvidence.js";
import { traceOriginalSource } from "../lib/pipeline/webEvidence/traceOriginalSources.js";
import { capturePageScreenshot, capturePdfPageScreenshot, captureCroppedVisual } from "../lib/pipeline/webEvidence/screenshotCapture.js";
import { packageVisualAssetsForSlides } from "../lib/pipeline/webEvidence/packageVisualAssetsForSlides.js";
import { runWebEvidenceBranch } from "../lib/pipeline/webEvidence/runWebEvidenceBranch.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

function res(data, { status = 200, contentType = "application/json" } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) }, json: async () => data, text: async () => (typeof data === "string" ? data : JSON.stringify(data)), arrayBuffer: async () => Buffer.from("") };
}

const baseCfg = {
  enabled: true, provider_order: ["tavily", "serpapi"], tavily_enabled: true, serpapi_enabled: true,
  gemini_grounding_enabled: false, claude_web_enabled: false, cache_dir: "/tmp/we_test",
};

// ── Search provider normalization + rotation ──────────────────────────────────
console.log("\nsearch providers");

await test("Tavily search results normalize to the standard shape", async () => {
  process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY || "test";
  const fetchImpl = async (url) => res({ results: [{ url: "https://arxiv.org/abs/1", title: "T", content: "snippet text", published_date: "2026-05-01", score: 0.9 }] });
  const out = await executeWebSearch("q", { source_class_hint: "research_paper" }, { config: { ...baseCfg, provider_order: ["tavily"] }, fetchImpl, minResults: 1 });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.provider, "tavily");
  assert.equal(r.result_url, "https://arxiv.org/abs/1");
  assert.equal(r.snippet, "snippet text");
});

await test("SerpAPI organic results normalize to the standard shape", async () => {
  process.env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "test";
  const fetchImpl = async () => res({ organic_results: [{ link: "https://vendor.com/r", title: "R", snippet: "vendor snippet", date: "2026-04-01", position: 1 }] });
  const out = await executeWebSearch("q", { source_class_hint: "technical_blog" }, { config: { ...baseCfg, provider_order: ["serpapi"] }, fetchImpl, minResults: 1 });
  assert.equal(out.results[0].provider, "serpapi");
  assert.equal(out.results[0].result_url, "https://vendor.com/r");
});

await test("provider fallback: Tavily fails → SerpAPI used", async () => {
  process.env.TAVILY_API_KEY = "test"; process.env.SERPAPI_API_KEY = "test";
  const fetchImpl = async (url) => {
    if (String(url).includes("tavily")) return res("err", { status: 500 });
    return res({ organic_results: [{ link: "https://vendor.com/x", title: "X", snippet: "s" }] });
  };
  const out = await executeWebSearch("q", { source_class_hint: "technical_blog" }, { config: baseCfg, fetchImpl, minResults: 1 });
  assert.ok(out.providers_used.includes("serpapi"));
  assert.ok(out.failures.some((f) => f.provider === "tavily"));
  assert.equal(out.results[0].result_url, "https://vendor.com/x");
});

await test("cross-provider dedup by canonical URL", () => {
  const a = normalizeSearchResult({ result_url: "https://x.com/a/" }, "tavily", "q", 2);
  const b = normalizeSearchResult({ result_url: "https://www.x.com/a" }, "serpapi", "q", 1);
  const out = dedupeSearchResults([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rank, 1, "keeps the better-ranked");
});

// ── Evidence depth + walkthrough ──────────────────────────────────────────────
console.log("\nevidence depth + walkthrough");

await test("vague evidence is thin", () => {
  const ev = makeWebEvidenceObject({ concrete_claim: "AI increases cyber risk", source_grounding: { verbatim_quotes: [] } });
  assert.equal(assessEvidenceDepth(ev), "thin");
});

await test("concrete evidence (named + quote) is concrete", () => {
  const ev = makeWebEvidenceObject({
    concrete_claim: "GPT-4 Copilot is vulnerable to prompt injection",
    operational_details: { technique: "prompt injection", affected_system: "GPT-4 Copilot" },
    source_grounding: { verbatim_quotes: ["The researchers showed GPT-4 Copilot leaked data via prompt injection."] },
  });
  assert.equal(assessEvidenceDepth(ev), "concrete");
});

await test("detailed evidence (named + technique + impact + quote)", () => {
  const ev = makeWebEvidenceObject({
    concrete_claim: "MCP tool poisoning exfiltrates keys from GPT-4 agents",
    operational_details: { technique: "tool poisoning", affected_system: "GPT-4 agent", impact: "exfiltrates API keys", vulnerabilities_or_weaknesses: ["CVE-2026-1"] },
    source_grounding: { verbatim_quotes: ["The attack exfiltrated API keys from the GPT-4 MCP agent at a 92% rate."] },
  });
  assert.equal(assessEvidenceDepth(ev), "detailed");
});

await test("walkthrough grounded → complete; missing steps → partial", () => {
  const steps3 = makeWebEvidenceObject({
    operational_details: { technique: "tool poisoning", target: "GPT-4 agent", affected_system: "GPT-4 agent",
      attack_steps: [{ step: "register MCP", grounded: true, quote: "..." }, { step: "agent calls tool", grounded: true, quote: "..." }, { step: "exfiltrate", grounded: true, quote: "..." }] },
    source_grounding: { verbatim_quotes: ["The MCP tool poisoning attack chain exfiltrates keys."] },
  });
  assert.equal(assessWalkthroughStatus(steps3), "complete_walkthrough");
  assert.equal(assessEvidenceDepth(steps3), "walkthrough_grade");

  const steps2 = makeWebEvidenceObject({ operational_details: { technique: "tool poisoning", target: "agent", attack_steps: [{ step: "a", grounded: true }, { step: "b", grounded: true }] } });
  assert.equal(assessWalkthroughStatus(steps2), "partial_walkthrough");
});

// ── Text validation gates ─────────────────────────────────────────────────────
console.log("\ntext validation gates");

await test("invented URL (opened_url_confirmed false) is rejected", () => {
  const ev = makeWebEvidenceObject({
    evidence_depth: "concrete", concrete_claim: "GPT-4 prompt injection",
    operational_details: { technique: "prompt injection", affected_system: "GPT-4" },
    source_grounding: { source_url: "https://x.com", opened_url_confirmed: false, verbatim_quotes: ["GPT-4 was exploited via prompt injection."] },
  });
  const out = validateWebEvidence(ev);
  assert.equal(out.validation_status, "rejected");
  assert.ok(out.validation_violations.includes("opened_url_not_confirmed"));
});

await test("concrete evidence with confirmed URL + supporting quote validates", () => {
  const ev = makeWebEvidenceObject({
    evidence_depth: "concrete", concrete_claim: "GPT-4 Copilot prompt injection leaks data",
    operational_details: { technique: "prompt injection", affected_system: "GPT-4 Copilot" },
    source_grounding: { source_url: "https://arxiv.org/abs/1", opened_url_confirmed: true, verbatim_quotes: ["GPT-4 Copilot prompt injection leaks data from the context."] },
  });
  const out = validateWebEvidence(ev);
  assert.equal(out.validation_status, "validated");
  assert.equal(out.analysis_eligible, true);
});

await test("number in claim not grounded in quote → manual review", () => {
  const ev = makeWebEvidenceObject({
    evidence_depth: "concrete", concrete_claim: "The attack succeeds 92% of the time on GPT-4",
    operational_details: { technique: "prompt injection", affected_system: "GPT-4" },
    source_grounding: { source_url: "https://x.com", opened_url_confirmed: true, verbatim_quotes: ["The attack works against GPT-4 systems."] },
  });
  const out = validateWebEvidence(ev);
  assert.ok(out.validation_violations.includes("number_in_claim_not_grounded_in_quote"));
  assert.equal(out.manual_review_required, true);
});

// ── Original source tracing ───────────────────────────────────────────────────
console.log("\noriginal source tracing");

await test("original source is traced + preferred; derivative with value retained", async () => {
  const opened = {
    source_url: "https://news.example.com/story", canonical_url: "https://news.example.com/story",
    text: "A short news summary. Step 1: attacker does X. Step 2: agent does Y. 92% success rate.",
    links: [{ href: "https://arxiv.org/abs/2026.99", text: "original paper" }],
  };
  const fetchImpl = async () => res("<html><head><title>Original Paper</title></head><body>Original research content.</body></html>", { contentType: "text/html" });
  const out = await traceOriginalSource(opened, { config: { max_trace_depth: 2 }, fetchImpl });
  assert.equal(out.original_source_opened, true);
  assert.equal(out.original_source_url, "https://arxiv.org/abs/2026.99");
  assert.ok(["derivative_with_value", "derivative_archive_only"].includes(out.source_lineage));
  assert.equal(out.derivative_adds_unique_value, true, "news has steps + numbers → adds value");
});

// ── Visual extraction ─────────────────────────────────────────────────────────
console.log("\nvisual extraction");

await test("direct image URL is stored; svg → page_screenshot fallback", async () => {
  const opened = { source_url: "https://r.com/p", is_pdf: false, html: '<figure><img src="/d.png" alt="attack chain diagram"><figcaption>attack chain</figcaption></figure><svg></svg>' };
  const vis = await extractVisualCandidates(opened, { category: "agentic_ai_threats" }, { config: { max_visuals_per_source: 5 } });
  const img = vis.find((v) => v.visual_url);
  assert.ok(img, "direct image extracted");
  assert.equal(img.capture_method, "direct_image");
  assert.ok(img.visual_url.endsWith("/d.png"));
  const svg = vis.find((v) => !v.visual_url && v.capture_method === "page_screenshot");
  assert.ok(svg, "svg → page_screenshot candidate");
});

await test("HTML table extracted with columns + rows", async () => {
  const opened = { source_url: "https://r.com/t", is_pdf: false, html: "<table><caption>Rates</caption><tr><th>Model</th><th>ASR</th></tr><tr><td>GPT-4</td><td>92%</td></tr></table>" };
  const vis = await extractVisualCandidates(opened, {}, { config: { max_visuals_per_source: 5 } });
  const tbl = vis.find((v) => v.visual_kind === "html_table");
  assert.ok(tbl);
  assert.deepEqual(tbl._table_data.columns, ["Model", "ASR"]);
  assert.equal(tbl._table_data.rows.length, 1);
  assert.equal(tbl.capture_method, "html_table_extract");
});

await test("PDF figure → pdf_page_screenshot; PDF table uncertain → manual_review", async () => {
  const opened = { source_url: "https://r.com/p.pdf", is_pdf: true, text: "Figure 1: attack chain overview. Table 2: model comparison." };
  const vis = await extractVisualCandidates(opened, {}, { config: { max_visuals_per_source: 5 } });
  const fig = vis.find((v) => v.visual_kind === "figure");
  assert.equal(fig.capture_method, "pdf_page_screenshot");
  const tbl = vis.find((v) => v.visual_kind === "pdf_table");
  assert.equal(tbl.capture_method, "pdf_table_extract");
  const validated = validateVisualEvidence({ ...tbl, supports_evidence_ids: ["webev_1"] });
  assert.equal(validated.slide_suitability.decision, "manual_review", "uncertain pdf table → manual_review");
});

// ── Screenshot capture degradation ────────────────────────────────────────────
console.log("\nscreenshot capture (degrade)");

await test("screenshot/crop/pdf capture degrade gracefully when tools absent", async () => {
  const a = await capturePageScreenshot("https://x.com", { config: { screenshot_enabled: true } });
  assert.equal(a.ok, false);
  const b = await captureCroppedVisual("https://x.com", {}, {});
  assert.equal(b.ok, false);
  assert.equal(b.crop_method, "manual_review");
  const c = await capturePdfPageScreenshot(null, null, {});
  assert.equal(c.ok, false);
});

// ── Visual classification + usefulness + suitability ──────────────────────────
console.log("\nvisual usefulness + slide suitability");

function boundVisual(partial) {
  return makeVisualEvidenceObject({ source_url: "https://r.com/p", supports_evidence_ids: ["webev_1"],
    caption_or_nearby_text: partial.caption || "fig", visual_quality: { readable: true, not_decorative: true, has_axis_or_labels: true, data_extractable: partial.data_extractable ?? false, ocr_quality: "not_needed" }, ...partial });
}

await test("decorative visual is rejected", () => {
  const v = applyVisualClassification(makeVisualEvidenceObject({ source_url: "https://r.com", visual_url: "https://r.com/logo.png", caption_or_nearby_text: "company logo stock image", supports_evidence_ids: ["webev_1"], visual_quality: { readable: true, not_decorative: true } }));
  const out = evaluateVisual(v, { flags: v._classification_flags });
  assert.equal(out.visual_usefulness.level, "not_useful");
  assert.equal(out.slide_suitability.decision, "reject");
});

await test("attack chain diagram → embed", () => {
  let v = boundVisual({ visual_kind: "diagram", visual_url: "https://r.com/d.png", caption: "MCP tool poisoning attack chain diagram", capture_method: "direct_image" });
  v = applyVisualClassification(v);
  const out = evaluateVisual(v, { flags: v._classification_flags });
  assert.equal(out.visual_usefulness.level, "high");
  assert.equal(out.slide_suitability.decision, "embed");
  assert.equal(out.slide_suitability.best_slide_use, "attack_walkthrough");
});

await test("data-extractable chart → redraw", () => {
  let v = boundVisual({ visual_kind: "chart", visual_url: "https://r.com/c.png", caption: "benchmark comparison of attack success rate", data_extractable: true, capture_method: "direct_image" });
  v = applyVisualClassification(v);
  const out = evaluateVisual(v, { flags: v._classification_flags });
  assert.equal(out.slide_suitability.decision, "redraw");
});

await test("visual with no claim binding is rejected", () => {
  const v = applyVisualClassification(makeVisualEvidenceObject({ source_url: "https://r.com", visual_url: "https://r.com/x.png", caption_or_nearby_text: "", visual_quality: { readable: true, not_decorative: true } }));
  const out = evaluateVisual(v, {});
  assert.equal(out.slide_suitability.decision, "reject");
});

await test("visual with no context (no caption, no binding) rejected by deterministic filter", () => {
  const v = makeVisualEvidenceObject({ source_url: "https://r.com", visual_url: "https://r.com/x.png", caption_or_nearby_text: "", visual_quality: { readable: true, not_decorative: true } });
  assert.equal(deterministicVisualFilter(v), "no_caption_or_context");
});

await test("usefulness levels: high / medium / low / not_useful", () => {
  const high = evaluateVisual(applyVisualClassification(boundVisual({ visual_kind: "timeline", visual_url: "https://r.com/t.png", caption: "incident timeline over time", capture_method: "direct_image" })), {});
  assert.equal(high.visual_usefulness.level, "high");
  const notUseful = evaluateVisual(applyVisualClassification(makeVisualEvidenceObject({ source_url: "https://r.com", visual_url: "https://r.com/x.png", caption_or_nearby_text: "decorative banner stock image", visual_quality: { readable: true, not_decorative: true } })), {});
  assert.equal(notUseful.visual_usefulness.level, "not_useful");
});

// ── OCR gate ──────────────────────────────────────────────────────────────────
console.log("\nOCR + table extraction gates");

await test("poor OCR blocks numeric extraction (redraw → manual_review)", () => {
  const v = makeVisualEvidenceObject({
    source_url: "https://r.com", visual_kind: "chart", screenshot_path: "/tmp/x.png",
    supports_evidence_ids: ["webev_1"], caption_or_nearby_text: "benchmark",
    slide_suitability: { decision: "redraw" },
    visual_quality: { readable: true, not_decorative: true, data_extractable: false, ocr_quality: "poor" },
  });
  const out = validateVisualEvidence(v);
  assert.ok(out.validation_violations.includes("ocr_poor_blocks_numeric_extraction"));
  assert.equal(out.slide_suitability.decision, "manual_review");
});

// ── Clustering ────────────────────────────────────────────────────────────────
console.log("\nvisual clustering");

await test("duplicate visual (same image hash) clusters to one representative", () => {
  const a = makeVisualEvidenceObject({ source_url: "https://a.com", visual_kind: "diagram", image_hash: "h1", visual_usefulness: { level: "high" }, capture_method: "direct_image" });
  const b = makeVisualEvidenceObject({ source_url: "https://b.com", visual_kind: "diagram", image_hash: "h1", visual_usefulness: { level: "medium" }, capture_method: "page_screenshot" });
  const [x, y] = clusterVisualEvidence([a, b]);
  const reps = [x, y].filter((v) => v.is_cluster_representative);
  assert.equal(reps.length, 1);
});

// ── Slide packaging routing ───────────────────────────────────────────────────
console.log("\nslide packaging routing");

await test("cite_only + manual_review are NOT auto slide candidates; embed/redraw are", () => {
  const embed = makeVisualEvidenceObject({ visual_evidence_id: "webvis_e", category: "llm_threats", visual_kind: "diagram", source_url: "https://r.com", slide_suitability: { decision: "embed", best_slide_use: "architecture" }, usage: { slide_usable: true } });
  const redraw = makeVisualEvidenceObject({ visual_evidence_id: "webvis_r", category: "llm_threats", visual_kind: "html_table", source_url: "https://r.com", slide_suitability: { decision: "redraw" }, usage: { slide_usable: true } });
  const cite = makeVisualEvidenceObject({ visual_evidence_id: "webvis_c", category: "llm_threats", visual_kind: "figure", source_url: "https://r.com", slide_suitability: { decision: "cite_only" } });
  const manual = makeVisualEvidenceObject({ visual_evidence_id: "webvis_m", category: "llm_threats", visual_kind: "figure", source_url: "https://r.com", slide_suitability: { decision: "manual_review" } });
  const reject = makeVisualEvidenceObject({ visual_evidence_id: "webvis_x", category: "llm_threats", visual_kind: "figure", source_url: "https://r.com", slide_suitability: { decision: "reject" } });
  const out = packageVisualAssetsForSlides([embed, redraw, cite, manual, reject], { maxFinalVisualsPerCategory: 5, maxHeroVisualsPerCategory: 2 });
  const autoIds = out.auto_slide_candidates.map((a) => a.visual_evidence_id);
  assert.ok(autoIds.includes("webvis_e") && autoIds.includes("webvis_r"));
  assert.ok(!autoIds.includes("webvis_c") && !autoIds.includes("webvis_m") && !autoIds.includes("webvis_x"));
  assert.equal(out.reference_only.length, 1, "cite_only → reference");
  assert.equal(out.manual_review_pack.length, 1, "manual_review → manual pack");
});

// ── Orchestrator: unsupported queries + failure modes ─────────────────────────
console.log("\norchestrator failure handling");

await test("unsupported query recorded when search returns nothing (no crash)", async () => {
  const cfg = { ...baseCfg, max_queries_per_category: 1, max_opened_urls: 5, max_opened_urls_per_mission: 2, max_final_evidence_per_category: 5, max_final_visuals_per_category: 3, max_hero_visuals_per_category: 1, max_frontier_qa_visuals: 2, screenshot_enabled: false, frontier_qa_enabled: false };
  const searchFn = async () => ({ results: [], providers_used: [], failures: [] });
  const openFn = async () => ({ opened_url_confirmed: false, failure_reason: "should_not_be_called" });
  const r = await runWebEvidenceBranch({ evidencePacks: [], analyticsResult: {}, opts: { config: cfg, searchFn, openFn, skipLlm: true } });
  assert.equal(r.enabled, true);
  assert.ok(r.unsupported_queries.length > 0);
});

await test("search + open failures are recorded without crashing", async () => {
  const cfg = { ...baseCfg, max_queries_per_category: 1, max_opened_urls: 5, max_opened_urls_per_mission: 2, max_final_evidence_per_category: 5, max_final_visuals_per_category: 3, max_hero_visuals_per_category: 1, max_frontier_qa_visuals: 2, screenshot_enabled: false, frontier_qa_enabled: false };
  const searchFn = async (q) => ({ results: [{ provider: "tavily", query: q, result_url: "https://x.com/" + Math.random(), title: "t", snippet: "s", source_class_hint: "technical_blog", rank: 1 }], providers_used: ["tavily"], failures: [{ provider: "serpapi", query: q, failure_reason: "serpapi_http_500" }] });
  const openFn = async () => { throw new Error("boom"); };
  const r = await runWebEvidenceBranch({ evidencePacks: [], analyticsResult: {}, opts: { config: cfg, searchFn, openFn, skipLlm: true } });
  assert.equal(r.enabled, true);
  assert.ok(r.failures.length > 0, "failures recorded");
  assert.ok(r.failures.some((f) => /boom/.test(f.failure_reason)) || r.failures.some((f) => f.provider === "serpapi"));
});

await test("branch is a no-op when disabled", async () => {
  const r = await runWebEvidenceBranch({ opts: { config: { ...baseCfg, enabled: false } } });
  assert.equal(r.enabled, false);
  assert.equal(r.evidence_items.length, 0);
});

// ── Results ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
