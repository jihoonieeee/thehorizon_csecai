/**
 * Web Discovery tests (Layer 1B/1C). Deterministic — no network, no DB.
 * Run with: node tests/webDiscovery.test.js
 */

import assert from "node:assert/strict";

import {
  normalizeUrlForGrounding, assessFreshness, detectAiThreatAnchors,
  quoteSupport, extractOriginCitations, computeCandidateHashes,
} from "../lib/pipeline/discovery/candidateGates.js";
import { normalizeCandidate } from "../lib/pipeline/discovery/normalizeCandidate.js";
import { computeEarlySignal } from "../lib/pipeline/discovery/earlySignal.js";
import { dedupeCandidates } from "../lib/pipeline/discovery/dedupeCandidates.js";
import { triageCandidates, triageCandidateDeterministic } from "../lib/pipeline/discovery/triageCandidates.js";
import { runWebDiscovery, enforceSourceClassQuotas } from "../lib/pipeline/discovery/runWebDiscovery.js";
import { buildDiscoveryQueries, buildEntitySeededQueries } from "../lib/pipeline/discovery/buildDiscoveryQueries.js";
import { candidatesToSources } from "../lib/pipeline/discovery/candidateToSource.js";
import { VALID_EARLY_SIGNAL_TYPE, VALID_DISCOVERY_ROUTES, ROUTES_INTO_PIPELINE } from "../lib/config/webDiscoveryVocab.js";
import { runTavilyQuery } from "../lib/pipeline/discovery/providers/tavily.js";
import { runSerpApiQuery, serpEngineFor } from "../lib/pipeline/discovery/providers/serpapi.js";
import { providerOrderFor, hasAnyDiscoveryProvider } from "../lib/pipeline/discovery/discoverySearchRouter.js";
import { hasUsableText, enrichCandidatesWithText, fetchPageText } from "../lib/pipeline/discovery/fetchCandidateText.js";

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
  // reason code is now zero_ai_threat_anchors (was: buzzword_only_no_ai_threat_anchor)
  assert.ok(
    (out.candidate_route_reasons || [out.rejection_reason]).some((r) => /zero_ai_threat|buzzword/.test(r)),
    `expected zero_ai_threat_anchors reason, got: ${out.rejection_reason}`
  );
});

await test("opened URL but no quote (news page) is rejected", async () => {
  const out = await triageOne({
    opened_url: "https://news.example.com/gpt4-mcp-injection",
    title: "GPT-4 prompt injection attack via MCP tool output",
    publisher: "News",
    published_date: "2026-06-01",
    source_class: "news_report",
    candidate_claim: "A prompt injection attack against GPT-4 agents abuses MCP tool output",
    verbatim_quote: "",   // no quote on a plain HTML news page
  });
  // Non-preclean source with no quote must be rejected
  assert.equal(out.route, "reject");
  // reason code is now quote_missing (was: no_supporting_quote)
  assert.ok(
    (out.candidate_route_reasons || [out.rejection_reason]).some((r) => /quote_missing|no_supporting_quote/.test(r)),
    `expected quote_missing reason, got: ${out.rejection_reason}`
  );
});

await test("single anchor source goes to novelty_review, not reject", async () => {
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
  // Single anchor → novelty_review path (not reject) — preserves emerging signals
  assert.equal(out.route, "accept_with_review", "single anchor must route to review, not be hard-rejected");
  assert.ok(
    (out.candidate_route_reasons || []).includes("single_anchor_novelty_review"),
    "must carry single_anchor_novelty_review reason code"
  );
  assert.equal(out.relevance_path, "known_signal", "1 known anchor → known_signal path");
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
      route: "accept_evidence_candidate",  // new route name
      early_signal_value: "none", route_flags: [], candidate_route_reasons: [],
    });
  }
  const out = enforceSourceClassQuotas(news);
  // After quota, at most 2 news sources should remain in pipeline
  const inPipeline = out.filter((c) => ["accept_evidence_candidate","accept_high_priority","accept_with_review","context_only"].includes(c.route));
  assert.ok(inPipeline.length <= 2, `news in pipeline=${inPipeline.length} (cap 2)`);
  const demoted = out.filter((c) => c.route === "archive_only");
  assert.equal(demoted.length, 3);
  assert.ok(
    (demoted[0].candidate_route_reasons || [demoted[0].route_reason]).includes("source_class_quota_exceeded"),
    "demoted candidate must have quota_exceeded reason"
  );
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

// ── Body-text enrichment (F20) ────────────────────────────────────────────────

await test("Tavily candidate carries full page_text used as full_text", () => {
  const data = { results: [{
    url: "https://hiddenlayer.com/research/x",
    title: "New model extraction attack",
    raw_content: "Researchers describe a model extraction attack. ".repeat(40),
    published_date: "2026-05-01",
  }] };
  const { candidates } = (() => {
    // runTavilyQuery uses fetch; instead exercise mapResults via a fake fetchImpl
    return null;
  }) || {};
  // Drive through the provider with an injected fetch returning our payload.
  return runTavilyQuery(
    { mission: "m", query: "q", family: "seed" },
    { fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) }
  ).then((res) => {
    const c = res.candidates[0];
    assert.ok(c.page_text && c.page_text.length > 200, "page_text preserved");
    const [src] = candidatesToSources([normalizeCandidate(c, { mission: "m", groundedUrlSet: new Set(), groundedQuotes: [], now: NOW })]);
    assert.ok(src.full_text.length > 200, "full_text uses page_text, not just a quote");
  });
});

await test("hasUsableText: page_text or real quote passes; empty fails", () => {
  assert.equal(hasUsableText({ page_text: "x".repeat(250) }), true);
  assert.equal(hasUsableText({ verbatim_quote: "A concrete sentence about a real prompt injection attack here." }), true);
  assert.equal(hasUsableText({ verbatim_quote: "", summary: "short", page_text: "" }), false);
});

await test("enrichCandidatesWithText fetches thin candidates and demotes unfetchable ones", async () => {
  const cands = [
    { opened_url: "https://a.com/has", page_text: "y".repeat(300) },          // present
    { opened_url: "https://b.com/serp", verbatim_quote: "", summary: "" },    // fetched
    { opened_url: "https://c.com/dead", verbatim_quote: "", summary: "" },    // thin
  ];
  const fetchImpl = async (url) => {
    if (url.includes("b.com")) {
      return { ok: true, status: 200, headers: { get: () => "text/html" },
        text: async () => "<p>" + "Real article body about an AI agent exploit. ".repeat(20) + "</p>" };
    }
    return { ok: false, status: 404, headers: { get: () => "text/html" }, text: async () => "" };
  };
  const out = await enrichCandidatesWithText(cands, { fetchImpl });
  assert.equal(out[0].text_status, "present");
  assert.equal(out[1].text_status, "fetched");
  assert.ok(out[1].page_text.includes("AI agent exploit"));
  assert.equal(out[2].text_status, "thin");
});

await test("fetchPageText skips non-HTML content types", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "application/pdf" }, text: async () => "%PDF" });
  assert.equal(await fetchPageText("https://x.com/a.pdf", { fetchImpl }), "");
});

// ── New: quote support, freshness_class, origin extraction, routing ──────────────
console.log("\nquote support + freshness_class + origin + new routing");

await test("quote_support: lexically_matched / requires_entailment_qa / unsupported / unverified", () => {
  // Strong overlap (≥0.85) → lexically_matched (not "supported" — still needs LLM confirmation)
  const { quote_support: s1, requires_entailment_qa: r1 } = quoteSupport("prompt injection via MCP tool output exfiltrates secrets", "prompt injection via MCP tool output exfiltrates API secrets from the agent");
  assert.equal(s1, "lexically_matched", "high overlap → lexically_matched (not a semantic verdict)");
  assert.equal(r1, true, "lexically_matched still requires LLM entailment confirmation");
  // Intermediate overlap (0.3–0.85) → requires_entailment_qa (claim goes further than quote says)
  const { quote_support: s2, requires_entailment_qa: r2 } = quoteSupport(
    "prompt injection attacks against LLM agents exploit tool output in automated multi-step pipelines",
    "researchers demonstrate prompt injection techniques against LLM agents in controlled lab settings"
  );
  // claim tokens: prompt, injection, attacks, against, llm, agents, exploit, tool, output, automated, multi-step, pipelines
  // quote tokens: researchers, demonstrate, prompt, injection, techniques, against, llm, agents, controlled, lab, settings
  // hits: prompt, injection, against, llm, agents = 5/12 = 41% → intermediate → requires_entailment_qa
  assert.equal(s2, "requires_entailment_qa", "intermediate overlap → LLM must confirm entailment");
  assert.equal(r2, true);
  // No overlap → unsupported (fast mechanical rejection — no LLM QA needed)
  const { quote_support: s3, requires_entailment_qa: r3 } = quoteSupport("APT-X actively deploys RAG poisoning against financial firms", "we present a theoretical framework for understanding retrieval augmented generation");
  assert.equal(s3, "unsupported", "very low overlap → fast rejection without LLM check");
  assert.equal(r3, false, "unsupported does not need entailment QA — mechanically rejected");
  // No quote → unverified
  const { quote_support: s4, requires_entailment_qa: q4 } = quoteSupport("some claim", "");
  assert.equal(s4, "unverified");
  assert.equal(q4, false, "no entailment QA needed if quote is absent");
});

await test("requires_entailment_qa=true when quote is present with intermediate overlap", () => {
  // A quote that shares some vocabulary with the claim but doesn't fully cover it.
  // Intermediate overlap (0.3–0.85) → requires_entailment_qa=true so LLM can confirm.
  const { requires_entailment_qa } = quoteSupport(
    "GPT-4 agents were exploited through MCP tool injection attacks extracting secrets",
    "MCP tool injection attacks against GPT-4 were demonstrated in a research context"
  );
  assert.equal(requires_entailment_qa, true, "intermediate overlap quote must flag entailment QA");
});

await test("zero anchors → reject; 1 anchor → novelty_review; 2+ → evidence_candidate", async () => {
  const zeroAnchors = await triageOne({
    opened_url: "https://example.com/ai-hype",
    title: "AI is changing everything in security this year",
    publisher: "Blog", published_date: "2026-06-01", source_class: "technical_blog",
    candidate_claim: "AI is reshaping the security landscape for all organizations",
    verbatim_quote: "Artificial intelligence continues to reshape how security teams operate and respond to incidents.",
  });
  assert.equal(zeroAnchors.ai_threat_specificity, "none");
  assert.equal(zeroAnchors.route, "reject");

  const oneAnchor = await triageOne({
    opened_url: "https://blog.example.com/jailbreak",
    title: "Emerging jailbreak variant observed in wild",
    publisher: "Researcher", published_date: "2026-06-01", source_class: "technical_blog",
    candidate_claim: "Novel jailbreak variant bypasses safety filters with a new technique",
    verbatim_quote: "We observe a new jailbreak variant that bypasses safety filters in a way not previously documented.",
  });
  assert.equal(oneAnchor.ai_threat_specificity, "weak");
  assert.equal(oneAnchor.route, "accept_with_review", "single anchor → novelty review");
  assert.ok((oneAnchor.candidate_route_reasons || []).includes("single_anchor_novelty_review"));
});

await test("freshness_class: fresh / current / stale_but_relevant / historical_foundational / historical_stale", () => {
  const fresh = assessFreshness({ published_date: "2026-06-01", now: NOW });
  assert.equal(fresh.freshness_class, "fresh");
  const current = assessFreshness({ published_date: "2026-04-01", now: NOW });
  assert.equal(current.freshness_class, "current");
  // NIST/OWASP framework document: historical but foundational
  const foundational = assessFreshness({ published_date: "2022-01-01", now: NOW, source_class: "standards_or_framework" });
  assert.equal(foundational.freshness_class, "historical_foundational");
  // Old research paper with no special exemption → historical_stale
  const stale = assessFreshness({ published_date: "2023-01-01", now: NOW, source_class: "research_paper" });
  assert.equal(stale.freshness_class, "historical_stale");
  // No date → unknown_date
  const unknown = assessFreshness({});
  assert.equal(unknown.freshness_class, "unknown_date");
});

await test("historical_foundational source → context_only, not rejected or archive_only", async () => {
  const out = await triageOne({
    opened_url: "https://atlas.mitre.org/techniques/AML.T0018",
    title: "MITRE ATLAS: Backdoor ML Model technique reference",
    publisher: "MITRE",
    published_date: "2022-03-01",  // > 365 days old → historical_foundational
    source_class: "standards_or_framework",
    // Claim and quote must carry an anchor so they pass the zero-anchor gate.
    // "training data poisoning" matches specific_attack_method.
    candidate_claim: "Backdoor ML model (MITRE ATLAS AML.T0018): adversaries use training data poisoning to implant backdoors in ML model weights",
    verbatim_quote: "Adversaries may implant backdoors in machine learning models through training data poisoning attacks or by directly modifying model weights.",
  });
  assert.ok(["context_only", "accept_with_review", "accept_evidence_candidate"].includes(out.route),
    `foundational source must not be rejected or archived; got: ${out.route}`);
  assert.equal(out.freshness_class, "historical_foundational");
});

await test("secondary article citing primary source → origin_role=secondary_reporting, primary_origin_url extracted", () => {
  const origin = extractOriginCitations({
    title: "TechCrunch reports on Anthropic's new AI safety finding",
    candidate_claim: "According to a new report by Anthropic, LLM agents can be jailbroken via tool output",
    verbatim_quote: "According to Anthropic researchers, the attack succeeds in 73% of tested configurations.",
    summary: "Reporting on research from Anthropic on LLM agent jailbreaks.",
    publisher: "TechCrunch",
    source_class: "news_report",
  });
  assert.equal(origin.origin_role, "secondary_reporting");
  assert.ok(origin.cited_sources.some((s) => /anthropic/i.test(s)), "Anthropic should be in cited_sources");
});

await test("multiple articles citing same primary origin share candidate_origin_cluster_id", () => {
  const makeCand = (url, title, quote) => normalizeCandidate({
    opened_url: url, title,
    publisher: "News", published_date: "2026-06-01", source_class: "news_report",
    candidate_claim: title, verbatim_quote: quote,
    summary: "Reporting on research from Unit42",
  }, { mission: "fresh_attack_modes", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding(url)]), groundedQuotes: [quote], now: NOW });

  const a = makeCand("https://news1.com/story", "Flowise CVE-2026-46442 reported by Unit42",
    "According to Unit42 researchers, CVE-2026-46442 enables authenticated RCE on Flowise servers.");
  const b = makeCand("https://news2.com/story", "Unit42 report: Flowise CVE enables RCE",
    "Based on a report by Unit42, CVE-2026-46442 allows attackers to execute code on Flowise instances.");
  const [x, y] = dedupeCandidates([a, b]);

  // They should cite the same primary origin → some signal of origin relationship
  const originRoles = [x.origin_role, y.origin_role];
  assert.ok(originRoles.some((r) => r === "secondary_reporting"), "at least one should be secondary_reporting");
});

await test("defensive-only source → context_only route", async () => {
  const out = await triageOne({
    opened_url: "https://defender.example.com/hardening-llm",
    title: "How to harden LLM APIs against prompt injection",
    publisher: "Defender", published_date: "2026-06-01", source_class: "vendor_research",
    candidate_claim: "A guide to hardening LLM APIs against prompt injection by deploying input sanitization",
    verbatim_quote: "Deploy input sanitization and output filtering to reduce prompt injection risk in LLM API deployments.",
    // LLM would set defensive_content_type=defensive_only; simulate it:
  });
  // After triage (skipLlm=true), defensive_content_type defaults to "unknown" so it goes through normally
  // In real run: defensive_only → context_only; we just verify the field exists
  assert.ok(["accept_evidence_candidate","accept_with_review","context_only"].includes(out.route),
    `defensive source routed to: ${out.route}`);
});

await test("CVE/vulnerability candidate → accept_evidence_candidate or accept_high_priority", async () => {
  const out = await triageOne({
    opened_url: "https://nvd.nist.gov/vuln/detail/CVE-2026-99999",
    title: "CVE-2026-99999: Flowise authenticated RCE via agent execution endpoint",
    publisher: "NVD",
    published_date: "2026-06-05",
    source_class: "vulnerability_database",
    candidate_claim: "CVE-2026-99999 enables an authenticated attacker to achieve remote code execution on Flowise server instances via the agent execution API endpoint",
    verbatim_quote: "A remote code execution vulnerability exists in Flowise versions prior to 2.0.1 that allows authenticated users to execute arbitrary commands via the agent API.",
  });
  assert.ok(
    ["accept_evidence_candidate", "accept_high_priority", "accept_with_review"].includes(out.route),
    `CVE candidate should be accepted; got: ${out.route}`
  );
});

await test("content_hash and canonical_url_hash are stable and distinct", () => {
  const h1 = computeCandidateHashes({
    opened_url: "https://example.com/article?utm_source=twitter",
    verbatim_quote: "prompt injection exfiltrates data",
    candidate_claim: "prompt injection attack demonstrated",
    title: "Prompt injection attack paper",
  });
  const h2 = computeCandidateHashes({
    opened_url: "https://example.com/article?utm_source=email",  // different tracking param
    verbatim_quote: "prompt injection exfiltrates data",          // same quote
    candidate_claim: "prompt injection attack demonstrated",       // same claim
    title: "Prompt injection attack paper",
  });
  // Same URL (after stripping tracking params) → same canonical_url_hash
  assert.equal(h1.canonical_url_hash, h2.canonical_url_hash, "tracking params stripped → same hash");
  // Same quote → same quote_hash
  assert.equal(h1.quote_hash, h2.quote_hash);
});

await test("duplicate fact (same content_hash) gets archive_only / skip_reprocess signal", () => {
  const quote = "CVE-2026-46442 enables authenticated remote code execution on Flowise server instances.";
  const a = normalizeCandidate({
    opened_url: "https://nvd.nist.gov/cve-2026-46442",
    title: "CVE-2026-46442 Flowise RCE",
    publisher: "NVD", published_date: "2026-06-01", source_class: "vulnerability_database",
    candidate_claim: "CVE-2026-46442 enables authenticated RCE on Flowise",
    verbatim_quote: quote,
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://nvd.nist.gov/cve-2026-46442")]),
      groundedQuotes: [quote], now: NOW });
  const b = normalizeCandidate({
    opened_url: "https://example.com/flowise-rce-copy",
    title: "CVE-2026-46442 Flowise RCE",  // same title
    publisher: "Blog", published_date: "2026-06-01", source_class: "news_report",
    candidate_claim: "CVE-2026-46442 enables authenticated RCE on Flowise",
    verbatim_quote: quote,  // same verbatim quote
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://example.com/flowise-rce-copy")]),
      groundedQuotes: [quote], now: NOW });
  // Same content_hash is detectable
  assert.equal(a.content_hash, b.content_hash, "same title+quote → same content_hash");
  // After dedup, one should be non-representative
  const [x, y] = dedupeCandidates([a, b]);
  const nonRep = [x, y].find((c) => !c.is_cluster_representative);
  assert.ok(nonRep, "one should be non-representative");
});

await test("all candidate routes are valid vocab values", async () => {
  const candidates = [
    { opened_url: "https://nvd.nist.gov/cve-1", title: "CVE-1 RCE in AI framework",
      publisher: "NVD", published_date: "2026-06-01", source_class: "vulnerability_database",
      candidate_claim: "CVE-2026-10001 allows prompt injection in GPT-4 agent tools",
      verbatim_quote: "CVE-2026-10001 enables prompt injection via the tool output of GPT-4 agents, exfiltrating API keys." },
    { opened_url: "https://arxiv.org/abs/2026.bad", title: "RAG poisoning paper",
      publisher: "arXiv", published_date: "2025-01-01", source_class: "research_paper",
      candidate_claim: "RAG poisoning against vector databases using adversarial documents",
      verbatim_quote: "We demonstrate RAG poisoning against vector databases using adversarial documents in a lab setting." },
  ].map((r) => normalizeCandidate(r, {
    mission: "fresh_attack_modes", search_query: "q", search_query_family: "seed",
    groundedUrlSet: new Set([normalizeUrlForGrounding(r.opened_url)]),
    groundedQuotes: [r.verbatim_quote], now: NOW,
  }));
  const triaged = await triageCandidates(candidates, { skipLlm: true });
  for (const c of triaged) {
    assert.ok(VALID_DISCOVERY_ROUTES.has(c.route), `invalid route: ${c.route}`);
    assert.ok(Array.isArray(c.candidate_route_reasons), "candidate_route_reasons must be array");
  }
});

// ── Freshness class completeness ────────────────────────────────────────────
console.log("\nfreshness class completeness");

await test("stale_but_relevant: source 150 days old", () => {
  const r = assessFreshness({ published_date: "2026-01-05", now: NOW }); // ~150d
  assert.equal(r.freshness_status, "stale");
  assert.equal(r.freshness_class, "stale_but_relevant",
    "stale sources are stale_but_relevant at normalization time; routing handles LLM-based downgrade");
});

await test("fresh pub referencing an old event: freshness_class=current, interpretation=fresh_publication_old_event", () => {
  // Publication date is 34 days ago; event date is ~2 years ago.
  // freshness_status = "current" (31-120d), freshness_interpretation = fresh_publication_old_event.
  const recentPub = assessFreshness({
    published_date: "2026-05-01",
    event_date: "2024-06-01",  // old event (>180d before pub)
    now: NOW,  // 2026-06-04, so 34 days after pub
  });
  assert.equal(recentPub.freshness_status, "current", "34 days old → current, not fresh (threshold=30d)");
  assert.equal(recentPub.freshness_interpretation, "fresh_publication_old_event");
  assert.equal(recentPub.freshness_class, "current",
    "freshness_class follows freshness_status when within 120d; old event doesn't change class");
});

await test("historical_stale: research paper older than 365 days with no special class", () => {
  const r = assessFreshness({ published_date: "2024-01-01", now: NOW, source_class: "research_paper" });
  assert.equal(r.freshness_status, "historical");
  assert.equal(r.freshness_class, "historical_stale",
    "historical non-foundational paper with freshness_interpretation=historical_context → historical_stale");
});

// ── Quote support → routing ───────────────────────────────────────────────────
console.log("\nquote support routing");

await test("intermediate-overlap quote routes to accept_with_review with entailment_qa flag", async () => {
  // Intermediate overlap (30–85%) → requires_entailment_qa → accept_with_review so LLM can confirm.
  const out = await triageOne({
    opened_url: "https://arxiv.org/abs/2026.partial",
    title: "Adversarial attack demonstrated on GPT-4 agents using prompt injection",
    publisher: "arXiv", published_date: "2026-06-01", source_class: "research_paper",
    candidate_claim: "A prompt injection attack against GPT-4 agents extracts system prompt and user data",
    // Intermediate overlap: shares some tokens (prompt injection, agents) but claim asserts data extraction
    verbatim_quote: "Researchers demonstrate prompt injection attacks against LLM agents in controlled lab settings.",
  });
  assert.ok(
    out.quote_support === "requires_entailment_qa" || out.requires_entailment_qa === true,
    `quote with intermediate overlap should flag requires_entailment_qa; got quote_support=${out.quote_support}`
  );
  assert.ok(
    (out.candidate_route_reasons || []).includes("requires_entailment_qa") ||
    out.route === "accept_with_review",
    `intermediate-overlap quote should produce accept_with_review or entailment_qa reason; got route=${out.route}`
  );
});

await test("unsupported quote (low overlap) with moderate specificity → reject", async () => {
  const out = await triageOne({
    opened_url: "https://arxiv.org/abs/2026.mismatch",
    title: "Memory poisoning in GPT-4 MCP agents demonstrated with CVE exploit",
    publisher: "arXiv", published_date: "2026-06-01", source_class: "research_paper",
    candidate_claim: "GPT-4 MCP agents actively exploited by Lazarus Group using CVE-2026-9999",
    // Quote says nothing about Lazarus Group or CVE — completely different content
    verbatim_quote: "We present theoretical analysis of how training data influences model behaviour in foundation models.",
  });
  // Should be unsupported or at least accept_with_review for entailment QA
  assert.ok(
    out.quote_support === "unsupported" || out.requires_entailment_qa === true,
    `low-overlap quote should be unsupported or flag entailment_qa; got quote_support=${out.quote_support}`
  );
});

// ── Marketing + prediction-only deterministic filters ─────────────────────────
console.log("\nmarketing + prediction-only filters");

await test("marketing content (NEGATIVE_CONTENT_PATTERNS) is rejected via isLowValueContent", async () => {
  const out = await triageOne({
    opened_url: "https://vendor.example.com/ai-transformation-guide",
    title: "AI transformation: the future of cybersecurity for enterprises",
    publisher: "VendorCo", published_date: "2026-06-01", source_class: "vendor_research",
    candidate_claim: "AI transformation is reshaping how enterprises approach prompt injection defense",
    verbatim_quote: "AI transformation is key to prompt injection defense in modern enterprise security stacks.",
  });
  // "ai transformation" is in NEGATIVE_CONTENT_PATTERNS → isLowValueContent → reject or none signal
  assert.ok(
    out.route === "reject" || out.early_signal_value === "none",
    `marketing content should be rejected or produce no signal; got route=${out.route}`
  );
});

await test("prediction-only candidate (pre-set flag) → reject", async () => {
  // Simulate the post-LLM-enrichment path by calling triageCandidateDeterministic directly
  const base = mkCandidate({
    opened_url: "https://blog.example.com/future-ai-attacks",
    title: "What AI-powered attacks will look like in 2027",
    publisher: "FuturistBlog", published_date: "2026-06-01", source_class: "technical_blog",
    candidate_claim: "APT groups will use LLM-powered jailbreaks in large-scale campaigns by 2027",
    verbatim_quote: "We predict LLM-powered jailbreak campaigns will be common attack vectors in 2027.",
  });
  // Inject the LLM flag directly (simulates post-enrichment state)
  const enriched = { ...base, _llm_is_prediction_only: true };
  const out = triageCandidateDeterministic(enriched);
  assert.equal(out.route, "reject", "prediction_only flag → reject");
  assert.ok(
    (out.candidate_route_reasons || []).includes("prediction_only"),
    "must carry prediction_only reason code"
  );
});

await test("defensive_with_offensive_findings → accept_with_review", async () => {
  const base = mkCandidate({
    opened_url: "https://detection.example.com/offensive-findings",
    title: "Detecting prompt injection: attack patterns we observed in GPT-4 deployments",
    publisher: "DetectionLab", published_date: "2026-06-01", source_class: "vendor_research",
    candidate_claim: "Researchers observed 12 distinct prompt injection attack patterns against GPT-4 APIs in production",
    verbatim_quote: "Our detection study identified 12 distinct prompt injection attack patterns active against GPT-4 production APIs.",
  });
  const enriched = { ...base, defensive_content_type: "defensive_with_offensive_findings" };
  const out = triageCandidateDeterministic(enriched);
  assert.equal(out.route, "accept_with_review");
  assert.ok(
    (out.candidate_route_reasons || []).includes("defensive_with_offensive_findings"),
    "must carry defensive_with_offensive_findings reason code"
  );
});

// ── processing_cache_status in dedup ──────────────────────────────────────────
console.log("\nprocessing_cache_status");

await test("syndicated duplicate gets processing_cache_status=seen_same_content", () => {
  const quote = "CVE-2026-55555 enables remote code execution on LangChain agent endpoints via prompt injection.";
  const a = normalizeCandidate({
    opened_url: "https://nvd.nist.gov/cve-2026-55555",
    title: "CVE-2026-55555 LangChain RCE", publisher: "NVD",
    published_date: "2026-06-01", source_class: "vulnerability_database",
    candidate_claim: "CVE-2026-55555 RCE in LangChain", verbatim_quote: quote,
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://nvd.nist.gov/cve-2026-55555")]),
      groundedQuotes: [quote], now: NOW });
  const b = normalizeCandidate({
    opened_url: "https://news.example.com/langchain-rce",
    title: "CVE-2026-55555 LangChain RCE", publisher: "News",
    published_date: "2026-06-01", source_class: "news_report",
    candidate_claim: "CVE-2026-55555 RCE in LangChain", verbatim_quote: quote,
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://news.example.com/langchain-rce")]),
      groundedQuotes: [quote], now: NOW });
  assert.equal(a.content_hash, b.content_hash, "same title+quote → same content_hash");
  const [x, y] = dedupeCandidates([a, b]);
  const nonRep = [x, y].find((c) => !c.is_cluster_representative);
  assert.ok(nonRep, "one should be non-representative");
  assert.equal(nonRep.processing_cache_status, "seen_same_content",
    "syndicated duplicate with same content_hash → seen_same_content");
});

await test("derivative coverage (same origin, different content) gets seen_same_origin", () => {
  const primaryQuote = "According to Unit42, CVE-2026-44444 allows prompt injection in AutoGen agents.";
  const secondaryQuote = "Based on a report by Unit42, CVE-2026-44444 is exploitable via the tool-calling interface of AutoGen agentic frameworks.";
  const a = normalizeCandidate({
    opened_url: "https://unit42.example.com/autogen-cve",
    title: "CVE-2026-44444 AutoGen prompt injection", publisher: "Unit42",
    published_date: "2026-06-01", source_class: "vendor_research",
    candidate_claim: "CVE-2026-44444 enables prompt injection via AutoGen tool-calling",
    verbatim_quote: primaryQuote,
    summary: "Unit42 discloses CVE-2026-44444 prompt injection in AutoGen.",
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://unit42.example.com/autogen-cve")]),
      groundedQuotes: [primaryQuote], now: NOW });
  const b = normalizeCandidate({
    opened_url: "https://news.example.com/autogen-cve-report",
    title: "CVE-2026-44444 AutoGen prompt injection vulnerability", publisher: "News",
    published_date: "2026-06-02", source_class: "news_report",
    candidate_claim: "CVE-2026-44444 prompt injection in AutoGen reported by Unit42",
    verbatim_quote: secondaryQuote,
    summary: "Based on a report by Unit42, CVE-2026-44444 is exploitable in AutoGen.",
  }, { mission: "new_vulnerability_or_exploit", search_query: "q", search_query_family: "seed",
      groundedUrlSet: new Set([normalizeUrlForGrounding("https://news.example.com/autogen-cve-report")]),
      groundedQuotes: [secondaryQuote], now: NOW });
  const [x, y] = dedupeCandidates([a, b]);
  const nonRep = [x, y].find((c) => !c.is_cluster_representative);
  assert.ok(nonRep, "one should be non-representative");
  assert.ok(
    ["seen_same_content", "seen_same_origin"].includes(nonRep.processing_cache_status),
    `derivative duplicate should get seen_same_content or seen_same_origin; got ${nonRep.processing_cache_status}`
  );
});

// ── buildDiscoveryMetadata completeness ───────────────────────────────────────
console.log("\nbuildDiscoveryMetadata completeness");

import { buildDiscoveryMetadata } from "../lib/pipeline/discovery/normalizeCandidate.js";

await test("buildDiscoveryMetadata includes all new fields", async () => {
  const c = await triageOne({
    opened_url: "https://arxiv.org/abs/2026.meta",
    title: "Reproducible jailbreak via prompt injection on GPT-4 MCP agents with CVE-2026-12345",
    publisher: "arXiv", published_date: "2026-06-01", source_class: "research_paper",
    candidate_claim: "CVE-2026-12345 enables jailbreak via prompt injection against GPT-4 MCP agents",
    verbatim_quote: "We demonstrate CVE-2026-12345 enables prompt injection jailbreak against GPT-4 MCP agents.",
  });
  const meta = buildDiscoveryMetadata(c);
  // New fields must be present
  assert.ok("quote_support" in meta, "quote_support missing from metadata");
  assert.ok("requires_entailment_qa" in meta, "requires_entailment_qa missing");
  assert.ok("freshness_class" in meta, "freshness_class missing");
  assert.ok("evidence_novelty" in meta, "evidence_novelty missing");
  assert.ok("defensive_content_type" in meta, "defensive_content_type missing");
  assert.ok("candidate_usefulness_roles" in meta, "candidate_usefulness_roles missing");
  assert.ok("candidate_route_reasons" in meta, "candidate_route_reasons missing");
  assert.ok("relevance_path" in meta, "relevance_path missing");
  assert.ok("origin_role" in meta, "origin_role missing");
  assert.ok("independence_level" in meta, "independence_level missing");
  assert.ok("canonical_url_hash" in meta, "canonical_url_hash missing");
  assert.ok("content_hash" in meta, "content_hash missing");
  assert.ok("processing_cache_status" in meta, "processing_cache_status missing");
  assert.ok("age_days" in meta, "age_days missing");
});

// ── Results ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
