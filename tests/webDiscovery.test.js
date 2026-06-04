/**
 * Web Discovery tests (Layer 1B/1C). Deterministic — no network, no DB.
 * Run with: node tests/webDiscovery.test.js
 */

import assert from "node:assert/strict";

import {
  normalizeUrlForGrounding, assessFreshness, detectAiThreatAnchors,
} from "../lib/pipeline/discovery/candidateGates.js";
import { normalizeCandidate } from "../lib/pipeline/discovery/normalizeCandidate.js";
import { computeEarlySignal } from "../lib/pipeline/discovery/earlySignal.js";
import { dedupeCandidates } from "../lib/pipeline/discovery/dedupeCandidates.js";
import { triageCandidates } from "../lib/pipeline/discovery/triageCandidates.js";
import { runWebDiscovery, enforceSourceClassQuotas } from "../lib/pipeline/discovery/runWebDiscovery.js";
import { buildDiscoveryQueries, buildEntitySeededQueries } from "../lib/pipeline/discovery/buildDiscoveryQueries.js";
import { candidatesToSources } from "../lib/pipeline/discovery/candidateToSource.js";
import { VALID_EARLY_SIGNAL_TYPE } from "../lib/config/webDiscoveryVocab.js";
import { runTavilyQuery } from "../lib/pipeline/discovery/providers/tavily.js";
import { runSerpApiQuery, serpEngineFor } from "../lib/pipeline/discovery/providers/serpapi.js";
import { providerOrderFor, hasAnyDiscoveryProvider } from "../lib/pipeline/discovery/discoverySearchRouter.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const NOW = new Date("2026-06-04T00:00:00Z");

function mkCandidate(raw) {
  const url = raw.opened_url;
  const groundedUrlSet = new Set([normalizeUrlForGrounding(url)]);
  const groundedQuotes = raw.verbatim_quote ? [raw.verbatim_quote] : [];
  return normalizeCandidate(raw, {
    mission: raw.discovery_mission || "fresh_attack_modes",
    search_query: "q", search_query_family: "seed",
    groundedUrlSet, groundedQuotes, now: NOW,
  });
}

async function triageOne(raw) {
  const c = mkCandidate(raw);
  const [out] = await triageCandidates([c], { skipLlm: true });
  return out;
}

// ── Anti-hallucination + specificity gates ────────────────────────────────────
console.log("\nspecificity + routing gates");

await test("buzzword-only AI source is rejected", async () => {
  const out = await triageOne({
    opened_url: "https://example.com/ai-transformation",
    title: "How AI is transforming cybersecurity",
    publisher: "Example",
    published_date: "2026-06-01",
    source_class: "news_report",
    candidate_claim: "AI is changing the threat landscape for organizations",
    verbatim_quote: "Artificial intelligence is transforming how organizations think about security and risk.",
  });
  assert.equal(out.ai_threat_specificity, "none", "should have no concrete anchors");
  assert.equal(out.route, "reject");
  assert.match(out.rejection_reason, /buzzword/);
});

await test("opened URL but no quote (news page) is rejected / sent to review", async () => {
  const out = await triageOne({
    opened_url: "https://news.example.com/gpt4-mcp-injection",
    title: "GPT-4 prompt injection attack via MCP tool output",
    publisher: "News",
    published_date: "2026-06-01",
    source_class: "news_report",
    candidate_claim: "A prompt injection attack against GPT-4 agents abuses MCP tool output",
    verbatim_quote: "",   // no quote on a plain HTML news page
  });
  assert.ok(["reject", "accept_with_review"].includes(out.route), `route=${out.route}`);
  if (out.route === "reject") assert.equal(out.rejection_reason, "no_supporting_quote");
  else assert.equal(out.manual_review_required, true);
});

await test("source with quote but weak AI specificity is rejected", async () => {
  const out = await triageOne({
    opened_url: "https://blog.example.com/ai-thoughts",
    title: "Some thoughts on AI security",
    publisher: "Blog",
    published_date: "2026-06-01",
    source_class: "technical_blog",
    candidate_claim: "The author muses about jailbreak trends over time",
    verbatim_quote: "Researchers note that jailbreak attempts continue to evolve across systems over the years.",
  });
  assert.equal(out.ai_threat_specificity, "weak", "exactly one anchor → weak");
  assert.equal(out.route, "reject");
  assert.match(out.rejection_reason, /weak_ai_threat_specificity/);
});

// ── Quote-gate adjustment (pre-clean) ─────────────────────────────────────────
console.log("\nquote gate adjustment (pre-clean)");

await test("useful PDF accepted_with_review even if quote missing pre-clean", async () => {
  const out = await triageOne({
    opened_url: "https://arxiv.org/pdf/2026.12345.pdf",
    title: "Reproducible prompt injection against MCP agents using GPT-4",
    publisher: "arXiv",
    published_date: "2026-05-20",
    source_class: "research_paper",
    candidate_claim: "A reproducible proof of concept prompt injection extracts secrets from a GPT-4 MCP agent",
    verbatim_quote: "",   // PDF — quote needs cleaning first
  });
  assert.equal(out.quote_status, "missing_preclean");
  assert.equal(out.route, "accept_with_review");
  assert.equal(out.manual_review_required, true);
});

await test("GitHub PoC accepted with repo metadata (quote pending)", async () => {
  const out = await triageOne({
    opened_url: "https://github.com/researcher/mcp-prompt-injection-poc",
    title: "PoC: indirect prompt injection in MCP tool output (LangChain, GPT-4)",
    publisher: "GitHub",
    published_date: "2026-05-30",
    source_class: "github_poc",
    candidate_claim: "Reproducible PoC of indirect prompt injection via MCP tool output against a LangChain GPT-4 agent",
    verbatim_quote: "",
  });
  assert.equal(out.quote_status, "missing_preclean");
  assert.ok(["accept", "accept_with_review"].includes(out.route), `route=${out.route}`);
  assert.equal(out.manual_review_required, true);
});

// ── Early-signal decision tree ────────────────────────────────────────────────
console.log("\nearly-signal decision tree");

await test("fresh technical PoC: conceptual→weak, reproducible_poc→moderate", () => {
  const weak = computeEarlySignal({ operationalization_stage: "conceptual", ai_threat_specificity: "moderate", discovery_mission: "fresh_attack_modes" });
  assert.equal(weak.early_signal_value, "weak");
  const mod = computeEarlySignal({ operationalization_stage: "reproducible_poc", ai_threat_specificity: "moderate", discovery_mission: "fresh_attack_modes" });
  assert.equal(mod.early_signal_value, "moderate");
});

await test("actor-observed source is a strong early signal", () => {
  const s = computeEarlySignal({ operationalization_stage: "actor_observed", ai_threat_specificity: "strong", discovery_mission: "new_actor_adoption" });
  assert.equal(s.early_signal_value, "strong");
});

await test("research PoC accepted as weak/moderate early signal (via triage)", async () => {
  const c = mkCandidate({
    opened_url: "https://arxiv.org/abs/2026.99999",
    title: "Reproducible model extraction attack benchmark on GPT-4",
    publisher: "arXiv", published_date: "2026-05-15", source_class: "research_paper",
    candidate_claim: "We release a reproducible proof of concept and benchmark for model extraction against GPT-4",
    verbatim_quote: "We release a reproducible proof of concept and benchmark demonstrating model extraction against GPT-4 query APIs.",
  });
  const [out] = await triageCandidates([c], { skipLlm: true });
  assert.ok(["weak", "moderate"].includes(out.early_signal_value), `value=${out.early_signal_value}`);
});

await test("early_signal_value is never produced without an early_signal_type", () => {
  const inputs = [
    { operationalization_stage: "conceptual", ai_threat_specificity: "moderate" },
    { operationalization_stage: "reproducible_poc", ai_threat_specificity: "moderate" },
    { operationalization_stage: "actor_observed", ai_threat_specificity: "strong" },
    { corroboration_status: "independent_sources", ai_threat_specificity: "moderate" },
    { novelty_assessment: "genuinely_new", ai_threat_specificity: "strong" },
  ];
  for (const inp of inputs) {
    const s = computeEarlySignal({ ...inp, discovery_mission: "fresh_attack_modes" });
    if (s.early_signal_value !== "none") {
      assert.ok(s.early_signal_type && s.early_signal_type !== "none", `value=${s.early_signal_value} has no type`);
      assert.ok(VALID_EARLY_SIGNAL_TYPE.has(s.early_signal_type));
    }
  }
});

await test("moderate/strong early signals require a QA flag", () => {
  const mod = computeEarlySignal({ operationalization_stage: "reproducible_poc", ai_threat_specificity: "moderate", discovery_mission: "fresh_attack_modes" });
  assert.equal(mod.needs_early_signal_qa, true);
  assert.equal(mod.early_signal_qa_status, "pending");
  const strong = computeEarlySignal({ operationalization_stage: "actor_observed", ai_threat_specificity: "strong", discovery_mission: "new_actor_adoption" });
  assert.equal(strong.needs_early_signal_qa, true);
  assert.equal(strong.early_signal_qa_status, "pending");
});

await test("fresh publication of an old event is NOT an early signal", () => {
  const s = computeEarlySignal({
    operationalization_stage: "actor_observed",   // even a strong stage…
    ai_threat_specificity: "strong",
    freshness_interpretation: "fresh_publication_old_event",
    adds_new_evidence: false,                       // …is none when it adds nothing new
    discovery_mission: "new_incident_or_case_study",
  });
  assert.equal(s.early_signal_value, "none");
  assert.match(s.early_signal_reason, /old event/);
});

await test("early_signal_value=none can still enter the corpus", async () => {
  const out = await triageOne({
    opened_url: "https://vendor.example.com/background-on-rag-poisoning",
    title: "Background: how RAG poisoning works against vector databases",
    publisher: "Vendor", published_date: "2026-06-01", source_class: "vendor_research",
    candidate_claim: "An explainer of RAG poisoning attacks against vector database retrieval",
    verbatim_quote: "RAG poisoning injects adversarial documents into a vector database so retrieval returns attacker-controlled context.",
  });
  assert.equal(out.early_signal_value, "none", "background explainer is not an early signal");
  assert.ok(["accept", "accept_with_review"].includes(out.route), `route=${out.route}`);
});

// ── Freshness ─────────────────────────────────────────────────────────────────
console.log("\nfreshness");

await test("old source is classified stale / historical", () => {
  const stale = assessFreshness({ published_date: "2026-01-01", now: NOW });   // ~155d
  assert.equal(stale.freshness_status, "stale");
  const historical = assessFreshness({ published_date: "2024-01-01", now: NOW }); // >365d
  assert.equal(historical.freshness_status, "historical");
  const fresh = assessFreshness({ published_date: "2026-05-25", now: NOW });    // ~10d
  assert.equal(fresh.freshness_status, "fresh");
});

// ── Duplicate clustering + independence ───────────────────────────────────────
console.log("\nduplicate clustering");

await test("duplicate syndicated source is marked derivative/syndicated", () => {
  const quote = "We release a reproducible proof of concept showing prompt injection exfiltrating API keys from an MCP agent.";
  const a = mkCandidate({ opened_url: "https://arxiv.org/abs/2026.1", title: "Prompt injection exfiltrates keys from MCP agents", publisher: "arXiv", source_class: "research_paper", candidate_claim: "PoC prompt injection exfiltrates API keys from MCP agents", verbatim_quote: quote, published_date: "2026-05-20" });
  const b = mkCandidate({ opened_url: "https://news.example.com/repost", title: "Prompt injection exfiltrates keys from MCP agents", publisher: "News", source_class: "news_report", candidate_claim: "PoC prompt injection exfiltrates API keys from MCP agents", verbatim_quote: quote, published_date: "2026-05-21" });
  const [x, y] = dedupeCandidates([a, b]);
  const rep = [x, y].find((c) => c.is_cluster_representative);
  const nonRep = [x, y].find((c) => !c.is_cluster_representative);
  assert.ok(rep && nonRep, "one representative, one non-representative");
  assert.ok(["syndicated", "derivative"].includes(nonRep.source_independence_status));
  assert.equal(rep.source_independence_status, "original");
});

await test("duplicate news repost archived, original retained", async () => {
  const quote = "Researchers demonstrate a memory poisoning attack against autonomous GPT-4 MCP agents in a controlled study.";
  const original = mkCandidate({ opened_url: "https://unit42.example.com/memory-poisoning", title: "Memory poisoning attack against autonomous GPT-4 MCP agents", publisher: "Unit42", source_class: "vendor_research", candidate_claim: "A memory poisoning attack manipulates autonomous GPT-4 MCP agent decisions", verbatim_quote: quote, published_date: "2026-05-10" });
  const repost = mkCandidate({ opened_url: "https://news.example.com/memory-poisoning-repost", title: "Memory poisoning attack against autonomous GPT-4 MCP agents", publisher: "News", source_class: "news_report", candidate_claim: "A memory poisoning attack manipulates autonomous GPT-4 MCP agent decisions", verbatim_quote: quote, published_date: "2026-05-11" });
  const triaged = await triageCandidates(dedupeCandidates([original, repost]), { skipLlm: true });
  const orig = triaged.find((c) => c.publisher === "Unit42");
  const rep = triaged.find((c) => c.publisher === "News");
  assert.ok(["accept", "accept_with_review"].includes(orig.route), `original route=${orig.route}`);
  assert.equal(rep.route, "archive_only");
});

await test("derivative source with better technical detail is retained", () => {
  const original = mkCandidate({ opened_url: "https://vendor.example.com/echoleak", title: "EchoLeak prompt injection in Copilot", publisher: "Vendor", source_class: "vendor_research", candidate_claim: "EchoLeak abuses indirect prompt injection in Copilot", verbatim_quote: "EchoLeak uses indirect prompt injection to exfiltrate data from Copilot.", published_date: "2026-05-01" });
  const deeper = mkCandidate({ opened_url: "https://blog.example.com/echoleak-deep", title: "EchoLeak prompt injection Copilot deep technical analysis", publisher: "Researcher", source_class: "technical_blog", candidate_claim: "Deep analysis of the EchoLeak Copilot attack chain with a 92% exfiltration rate measured across a benchmark table", verbatim_quote: "Our benchmark table shows the EchoLeak attack chain achieves a 92% exfiltration success rate across tested Copilot configurations.", published_date: "2026-05-02" });
  const [a, b] = dedupeCandidates([original, deeper]);
  const both = [a, b];
  assert.equal(both.filter((c) => c.duplicate_cluster_id === a.duplicate_cluster_id).length, 2, "same cluster");
  const retainedDeeper = both.find((c) => c.publisher === "Researcher");
  assert.equal(retainedDeeper.is_cluster_representative, true);
  assert.equal(retainedDeeper.duplicate_reason, "retained_adds_unique_detail");
});

// ── Source-class quotas ───────────────────────────────────────────────────────
console.log("\nsource-class quotas");

await test("source-class quota prevents news domination", () => {
  const news = [];
  for (let i = 0; i < 5; i++) {
    news.push({
      candidate_id: `n${i}`, discovery_mission: "new_incident_or_case_study",
      source_class: "news_report", source_quality: "medium",
      route: "accept", early_signal_value: "none", route_flags: [],
    });
  }
  const out = enforceSourceClassQuotas(news);
  const accepted = out.filter((c) => c.route === "accept");
  assert.ok(accepted.length <= 2, `news accepted=${accepted.length} (cap 2)`);
  const demoted = out.filter((c) => c.route === "archive_only");
  assert.equal(demoted.length, 3);
  assert.match(demoted[0].route_reason, /source_class_quota_exceeded/);
});

// ── Query generation ──────────────────────────────────────────────────────────
console.log("\nquery generation");

await test("entity-seeded query is generated from a known CVE / product / attack name", () => {
  const q = buildDiscoveryQueries("new_tool_or_mcp_abuse", { entities: ["CVE-2026-1234", "LangChain"] });
  assert.ok(q.entity_seeded.some((x) => x.query.includes("CVE-2026-1234")), "CVE entity-seeded query missing");
  assert.ok(q.entity_seeded.some((x) => x.query.includes("LangChain")), "product entity-seeded query missing");
  const e2 = buildEntitySeededQueries(["EchoLeak"]);
  assert.ok(e2.some((x) => x.query === "EchoLeak attack chain"));
});

// ── Orchestrator: retry, unsupported, accepted vs audit ──────────────────────
console.log("\norchestrator");

await test("retry expansion happens before an unsupported query is recorded", async () => {
  // searchFn returns a candidate ONLY for retry-family queries; nothing otherwise.
  const searchFn = async ({ mission, family, query }) => {
    if (family === "retry") {
      return {
        candidates: [{
          opened_url: "https://arxiv.org/abs/2026.retry",
          title: "Reproducible RAG poisoning attack on vector databases",
          publisher: "arXiv", published_date: "2026-05-20", source_class: "research_paper",
          candidate_claim: "Reproducible PoC RAG poisoning attack against a vector database",
          verbatim_quote: "We provide a reproducible proof of concept RAG poisoning attack against a vector database retrieval pipeline.",
        }],
        grounded: { citations: [{ url: "https://arxiv.org/abs/2026.retry", cited_text: "reproducible proof of concept RAG poisoning" }], search_results: [{ url: "https://arxiv.org/abs/2026.retry" }] },
        no_results: false, note: null,
      };
    }
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: null };
  };
  const r = await runWebDiscovery({ missions: ["new_vector_rag_weakness"], skipLlm: true, useCache: false, searchFn });
  assert.ok(r.candidates_total > 0, "retry should have produced candidates");
  assert.ok(!(r.unsupported_queries_by_mission && r.unsupported_queries_by_mission.new_vector_rag_weakness),
    "mission must not be marked unsupported after retry found candidates");
});

await test("unsupported query is recorded when everything returns nothing", async () => {
  const searchFn = async () => ({ candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: null });
  const r = await runWebDiscovery({ missions: ["new_defensive_bypass"], skipLlm: true, useCache: false, searchFn });
  assert.equal(r.candidates_total, 0);
  assert.ok((r.unsupported_queries || []).length > 0, "unsupported_queries should be recorded");
  assert.ok(r.unsupported_queries_by_mission.new_defensive_bypass, "per-mission unsupported recorded");
});

await test("rejected web candidates are archived but NOT sent to Layer 4", async () => {
  const searchFn = async () => ({
    candidates: [{
      opened_url: "https://example.com/ai-buzz",
      title: "The future of AI and the digital transformation of security",
      publisher: "Example", published_date: "2026-06-01", source_class: "news_report",
      candidate_claim: "AI will transform security in the coming years",
      verbatim_quote: "AI will transform how enterprises approach their digital transformation journey.",
    }],
    grounded: { citations: [{ url: "https://example.com/ai-buzz", cited_text: "AI will transform" }], search_results: [{ url: "https://example.com/ai-buzz" }] },
    no_results: false, note: null,
  });
  const r = await runWebDiscovery({ missions: ["fresh_attack_modes"], skipLlm: true, useCache: false, searchFn });
  assert.equal(r.accepted_count, 0, "buzzword candidate must not be accepted");
  assert.ok(r.audit.some((c) => c.route === "reject"), "rejected candidate retained in audit");
  // Confirm it never becomes a pipeline source.
  const sources = candidatesToSources(r.accepted);
  assert.equal(sources.length, 0);
});

await test("accepted web candidates enter the Layer 2/3 normal path as sources", async () => {
  const searchFn = async () => ({
    candidates: [{
      opened_url: "https://arxiv.org/abs/2026.accept",
      title: "Reproducible indirect prompt injection against GPT-4 MCP agents",
      publisher: "arXiv", published_date: "2026-05-25", source_class: "research_paper",
      candidate_claim: "Reproducible PoC indirect prompt injection extracts secrets from a GPT-4 MCP agent",
      verbatim_quote: "We present a reproducible proof of concept where indirect prompt injection via tool output exfiltrates secrets from a GPT-4 MCP agent.",
    }],
    grounded: { citations: [{ url: "https://arxiv.org/abs/2026.accept", cited_text: "reproducible proof of concept where indirect prompt injection" }], search_results: [{ url: "https://arxiv.org/abs/2026.accept" }] },
    no_results: false, note: null,
  });
  const r = await runWebDiscovery({ missions: ["new_tool_or_mcp_abuse"], skipLlm: true, useCache: false, searchFn });
  assert.ok(r.accepted_count >= 1, "should accept the grounded research PoC");
  const sources = candidatesToSources(r.accepted);
  assert.ok(sources.length >= 1);
  const s = sources[0];
  assert.equal(s.source_origin, "web_discovery");
  assert.ok(s.id && s.url, "normalized source must have id + url for Layer 2/3");
  assert.equal(s.discovery_mission, "new_tool_or_mcp_abuse");
});

// ── Search providers (Tavily / SerpAPI) — mocked fetch, no network ───────────
console.log("\nsearch providers");

function mockFetch(data, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => data });
}

await test("Tavily maps results to grounded candidates with a real quote", async () => {
  process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY || "test-key";
  const fetchImpl = mockFetch({
    results: [{
      title: "Prompt injection in GPT-4 Copilot via MCP tool output",
      url: "https://example.com/pi-copilot",
      content: "Researchers demonstrate a prompt injection attack against GPT-4 Copilot agents.",
      raw_content: "Researchers demonstrate a reproducible prompt injection attack against GPT-4 Copilot MCP agents that exfiltrates secrets through tool output.",
      published_date: "2026-05-20",
    }],
  });
  const res = await runTavilyQuery({ mission: "new_tool_or_mcp_abuse", query: "q", family: "seed" }, { fetchImpl });
  assert.equal(res.candidates.length, 1);
  const c = res.candidates[0];
  assert.ok(c.verbatim_quote.length >= 20, "should extract a real quote from content");
  assert.equal(c.fetch_pending, false);
  assert.equal(c.provider, "tavily");
  assert.equal(res.grounded.search_results.length, 1);
  assert.equal(res.grounded.citations.length, 1, "quote grounded as a citation");
  // Normalizes to a confirmed, quote-present candidate.
  const norm = mkCandidate(c);
  assert.equal(norm.opened_url_confirmed, true);
  assert.equal(norm.quote_status, "present");
});

await test("SerpAPI maps SERP rows to fetch-pending candidates (quote in Layer 2)", async () => {
  process.env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "test-key";
  const fetchImpl = mockFetch({
    organic_results: [{
      title: "Memory poisoning attack on GPT-4 MCP agents",
      link: "https://example.com/memory-poisoning",
      snippet: "A memory poisoning attack manipulates autonomous GPT-4 MCP agent decisions in a controlled study.",
      date: "May 20, 2026",
    }],
  });
  const res = await runSerpApiQuery(
    { mission: "new_agentic_attack_surface", query: "q", family: "seed", source_class_hint: "vendor_research" },
    { fetchImpl, engine: "google" },
  );
  assert.equal(res.candidates.length, 1);
  const c = res.candidates[0];
  assert.equal(c.fetch_pending, true, "SERP snippet only → page fetched later");
  assert.equal(c.verbatim_quote, "");
  assert.ok(c.summary.includes("memory poisoning"));
  assert.equal(res.grounded.search_results.length, 1);
  assert.equal(res.grounded.citations.length, 0, "no page-verified quote yet");
  // A fetch-pending SERP candidate routes to accept_with_review, not reject.
  const out = await triageOne({ ...c });
  assert.equal(out.quote_status, "missing_preclean");
  assert.ok(["accept", "accept_with_review"].includes(out.route), `route=${out.route}`);
});

await test("SerpAPI engine routing: scholar for research, news for incidents", () => {
  assert.equal(serpEngineFor("research_paper"), "google_scholar");
  assert.equal(serpEngineFor("benchmark_dataset"), "google_scholar");
  assert.equal(serpEngineFor("incident_writeup"), "google_news");
  assert.equal(serpEngineFor("news_report"), "google_news");
  assert.equal(serpEngineFor("technical_blog"), "google");
});

await test("router prefers a forced provider and reports availability", () => {
  process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY || "test-key";
  assert.equal(hasAnyDiscoveryProvider(), true);
  const prev = process.env.WEB_DISCOVERY_PROVIDER;
  process.env.WEB_DISCOVERY_PROVIDER = "tavily";
  assert.deepEqual(providerOrderFor("technical_blog"), ["tavily"]);
  if (prev === undefined) delete process.env.WEB_DISCOVERY_PROVIDER; else process.env.WEB_DISCOVERY_PROVIDER = prev;
});

// ── Results ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
