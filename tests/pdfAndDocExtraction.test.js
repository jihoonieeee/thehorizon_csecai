/**
 * PDF connector + document section extractor tests.
 * No network calls — all external I/O is injected or mocked.
 *
 * Run: node tests/pdfAndDocExtraction.test.js
 */

import assert from "node:assert/strict";
import {
  looksLikePdf,
  isPdfUrl,
  clearPdfCache,
} from "../lib/pipeline/ingest/connectors/pdfConnector.js";
import {
  detectDocType,
  extractDocumentSections,
} from "../lib/pipeline/ingest/extractDocumentSections.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { console.log(`  ✓ ${name}`); passed++; })
              .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
    }
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. looksLikePdf — URL detection
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n1. looksLikePdf URL detection");

test("plain .pdf extension detected", () => {
  assert.equal(looksLikePdf("https://cisa.gov/sites/default/files/2026/advisory.pdf"), true);
});
test(".pdf with query string detected", () => {
  assert.equal(looksLikePdf("https://example.com/report.pdf?version=2"), true);
});
test("non-PDF HTML URL not flagged", () => {
  assert.equal(looksLikePdf("https://blog.google/threat-analysis/ai-threats"), false);
});
test("URL with /download/files/ path and pdf keyword detected", () => {
  assert.equal(looksLikePdf("https://mandiant.com/download/files/m-trends-2026-pdf"), true);
});
test("arXiv abs URL not flagged as PDF", () => {
  assert.equal(looksLikePdf("https://arxiv.org/abs/2406.12345"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isPdfUrl — HEAD request mock
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. isPdfUrl with mocked HEAD");

test("Content-Type: application/pdf → true", async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: { get: (h) => h === "content-type" ? "application/pdf" : null },
  });
  const result = await isPdfUrl("https://example.com/document", { fetchImpl: mockFetch });
  assert.equal(result, true);
});
test("Content-Type: text/html → false", async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: { get: (h) => h === "content-type" ? "text/html; charset=utf-8" : null },
  });
  const result = await isPdfUrl("https://example.com/page", { fetchImpl: mockFetch });
  assert.equal(result, false);
});
test("looksLikePdf short-circuits — no HEAD request made", async () => {
  let called = false;
  const mockFetch = async () => { called = true; return { ok: true, headers: { get: () => "text/html" } }; };
  await isPdfUrl("https://example.com/report.pdf", { fetchImpl: mockFetch });
  assert.equal(called, false, "HEAD request should be skipped when URL looks like PDF");
});
test("network error → false (graceful)", async () => {
  const mockFetch = async () => { throw new Error("network timeout"); };
  const result = await isPdfUrl("https://example.com/report", { fetchImpl: mockFetch });
  assert.equal(result, false, "network error should return false gracefully");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. detectDocType — document type heuristics
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. detectDocType");

test("arXiv URL → research", () => {
  assert.equal(detectDocType("", "https://arxiv.org/abs/2406.12345"), "research");
});
test("CISA URL → intel", () => {
  assert.equal(detectDocType("", "https://cisa.gov/sites/default/files/advisory.pdf"), "intel");
});
test("Google blog URL → intel", () => {
  assert.equal(detectDocType("", "https://blog.google/threat-analysis-group/q2-2026"), "intel");
});
test("Mandiant URL → intel", () => {
  assert.equal(detectDocType("", "https://mandiant.com/research/apt-report"), "intel");
});
test("Content with abstract/methodology → research", () => {
  const html = "<body><h2>Abstract</h2><p>We evaluate...</p><h2>Methodology</h2><p>Our approach...</p></body>";
  assert.equal(detectDocType(html, "https://unknown.org/paper"), "research");
});
test("Content with IOC section → intel", () => {
  const html = "<body><h2>Indicators of Compromise</h2><p>domain: evil.com</p></body>";
  assert.equal(detectDocType(html, "https://unknown.org/report"), "intel");
});
test("Content with Executive Summary → intel", () => {
  const html = "<body><h2>Executive Summary</h2><p>Key findings...</p></body>";
  assert.equal(detectDocType(html, "https://unknown.org/report"), "intel");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. extractDocumentSections — content extraction
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. extractDocumentSections");

const RESEARCH_HTML = `
<html><body>
<nav>Navigation stuff here that should be stripped</nav>
<article>
  <h2>Abstract</h2><p>We demonstrate that GPT-4 can be jailbroken using the PAIR algorithm achieving 88% ASR.</p>
  <h2>Introduction</h2><p>Large language models are increasingly deployed in production systems.</p>
  <h2>Methodology</h2><p>We ran 1000 attack iterations across 10 categories of harmful behaviors.</p>
  <h2>Results</h2><p>GPT-4 achieved 88% attack success rate. GPT-3.5 achieved 77%.</p>
  <h2>Related Work</h2><p>Previous work on adversarial examples...</p>
  <h2>References</h2><p>[1] Author A. Paper title. 2024.</p>
</article>
</body></html>`;

const INTEL_HTML = `
<html><body>
<nav>Site navigation</nav>
<main>
  <h2>Executive Summary</h2>
  <p>APT29 conducted spear-phishing campaigns targeting 47 organizations in the financial sector.</p>
  <h2>Threat Actor Profile</h2>
  <p>APT29 (Cozy Bear) is a Russian intelligence group attributed to the SVR.</p>
  <h2>TTPs</h2>
  <p>Technique: T1566.001 — Spearphishing Attachment. Initial access via malicious PDFs.</p>
  <h2>Indicators of Compromise</h2>
  <p>Domain: updates.microsoftportal[.]com | IP: 192.168.1.100 | Hash: abc123def456</p>
  <h2>Recommendations</h2>
  <p>Enable MFA, patch CVE-2026-1234, block listed IOCs.</p>
  <h2>About Us</h2><p>Mandiant is a cybersecurity company...</p>
  <h2>Legal Disclaimer</h2><p>This report is provided as-is...</p>
</main>
</body></html>`;

test("research document: extracts abstract and results, strips references", () => {
  const { text, doc_type } = extractDocumentSections(RESEARCH_HTML, {
    url: "https://arxiv.org/abs/1234.5678",
  });
  assert.equal(doc_type, "research");
  assert.ok(text.includes("88%"), "should include results with metric");
  assert.ok(!text.includes("[1] Author A"), "references should be stripped");
  assert.ok(!text.includes("Navigation stuff"), "nav should be stripped");
});

test("intel document: signal sections prioritized, noise stripped", () => {
  const { text, doc_type } = extractDocumentSections(INTEL_HTML, {
    url: "https://mandiant.com/research/apt29",
  });
  assert.equal(doc_type, "intel");
  assert.ok(text.includes("APT29"), "threat actor content included");
  assert.ok(text.includes("IOC") || text.includes("Indicators"), "IOC section included");
  assert.ok(text.includes("CVE-2026-1234") || text.includes("Recommendations"), "recommendations included");
  assert.ok(!text.includes("Mandiant is a cybersecurity company"), "About Us section stripped");
  assert.ok(!text.includes("as-is"), "Legal disclaimer stripped");
});

test("maxChars cap is respected", () => {
  const longHtml = `<body>${"<p>AI security content here. </p>".repeat(1000)}</body>`;
  const { text } = extractDocumentSections(longHtml, { maxChars: 500 });
  assert.ok(text.length <= 500, `text length ${text.length} exceeds maxChars 500`);
});

test("short content falls back to plain text extraction", () => {
  const html = "<html><body><p>GPT-4 jailbreak via prompt injection.</p></body></html>";
  const { text } = extractDocumentSections(html, { url: "https://example.com/short" });
  assert.ok(text.includes("GPT-4"), "short content preserved");
  assert.ok(text.length > 0, "non-empty result");
});

test("empty HTML returns non-empty fallback text (or empty gracefully)", () => {
  const { text } = extractDocumentSections("", { url: "" });
  // Should not throw; text may be empty
  assert.ok(typeof text === "string");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PDF cache
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. PDF file_id cache");

test("clearPdfCache does not throw", () => {
  assert.doesNotThrow(() => clearPdfCache());
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`PDF + Document extraction: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
