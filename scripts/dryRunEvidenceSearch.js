/**
 * scripts/dryRunEvidenceSearch.js
 *
 * Dry-run the Layer 5e evidence search layer against a small source set.
 * Shows:
 *   - Evidence objects returned per category
 *   - Citation quality and URL confidence
 *   - Unsupported queries (where no evidence was found)
 *   - Manual review flags
 *
 * Usage:
 *   node scripts/dryRunEvidenceSearch.js [--category <cat>] [--load-db] [--limit <n>]
 *
 * Options:
 *   --load-db          Load real sources from Supabase (requires SUPABASE_URL + KEY)
 *   --category <cat>   Only search one category (default: all)
 *   --limit <n>        Max sources to load from DB (default: 40)
 *
 * Without --load-db, uses a compact mock source set.
 */

import "dotenv/config";
import { runEvidenceSearchLayer } from "../lib/pipeline/evidence/evidenceSearchLayer.js";

const args = process.argv.slice(2);
const loadDb    = args.includes("--load-db");
const limitArg  = args.indexOf("--limit");
const limit     = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : 40;
const catArg    = args.indexOf("--category");
const onlyCat   = catArg >= 0 ? args[catArg + 1] : null;

// ── Mock sources ──────────────────────────────────────────────────────────────

const MOCK_SOURCES = [
  // traditional_ai_threats
  {
    id: "mock_trad_1", main_category: "traditional_ai_threats", source_type: "research_finding",
    trust_tier: "high", title: "Adversarial Patch Attacks on Object Detection",
    publisher: "arXiv", url: "https://arxiv.org/abs/example1",
    understanding: { entities: ["PyTorch", "CIFAR-10", "ImageNet"], main_claims: ["Patch attacks achieve 80% ASR on YOLO models"] },
  },
  {
    id: "mock_trad_2", main_category: "traditional_ai_threats", source_type: "vulnerability",
    trust_tier: "primary", title: "MITRE ATLAS ATT&CK for ML",
    publisher: "MITRE", url: "https://atlas.mitre.org/",
    understanding: { entities: ["MITRE", "ML pipeline", "data poisoning"], main_claims: ["14 real-world ML attacks documented"] },
  },
  {
    id: "mock_trad_3", main_category: "traditional_ai_threats", source_type: "benchmark_evaluation",
    trust_tier: "high", title: "RobustBench: Adversarial Robustness Benchmark",
    publisher: "ETH Zürich", url: "https://robustbench.github.io/",
    understanding: { entities: ["RobustBench", "AutoAttack", "CIFAR-10-C"] },
  },

  // llm_threats
  {
    id: "mock_llm_1", main_category: "llm_threats", source_type: "research_finding",
    trust_tier: "high", title: "Universal and Transferable Adversarial Attacks on Aligned Language Models",
    publisher: "arXiv", url: "https://arxiv.org/abs/2307.15043",
    understanding: { entities: ["ChatGPT", "Claude", "Bard"], main_claims: ["Universal suffixes bypass alignment in 88% of trials"] },
  },
  {
    id: "mock_llm_2", main_category: "llm_threats", source_type: "governance_signal",
    trust_tier: "primary", title: "OWASP Top 10 for LLMs",
    publisher: "OWASP", url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
    understanding: { entities: ["OWASP", "prompt injection", "LLM01"] },
  },
  {
    id: "mock_llm_3", main_category: "llm_threats", source_type: "incident",
    trust_tier: "high", title: "ChatGPT Training Data Leakage via Memorisation",
    publisher: "Google DeepMind", url: "https://arxiv.org/abs/2311.17035",
    understanding: { entities: ["GPT-3.5", "training data", "PII"], main_claims: ["Models memorise and reproduce training data verbatim"] },
  },

  // agentic_ai_threats
  {
    id: "mock_ag_1", main_category: "agentic_ai_threats", source_type: "research_finding",
    trust_tier: "high", title: "Prompt Injection Attacks on LLM-Integrated Applications",
    publisher: "arXiv", url: "https://arxiv.org/abs/2306.05499",
    understanding: { entities: ["LangChain", "tool use", "ReAct agent"] },
  },
  {
    id: "mock_ag_2", main_category: "agentic_ai_threats", source_type: "vulnerability",
    trust_tier: "medium", title: "MCP Security: Tool-Use Injection in Agent Frameworks",
    publisher: "GitHub Security Lab", url: "https://securitylab.github.com/",
    understanding: { entities: ["MCP", "Claude Desktop", "tool injection"] },
  },

  // ai_enabled_threats
  {
    id: "mock_ai_1", main_category: "ai_enabled_threats", source_type: "incident",
    trust_tier: "primary", title: "FBI Warning: Deepfake-Enabled Fraud Surging",
    publisher: "FBI IC3", url: "https://www.ic3.gov/",
    understanding: { entities: ["deepfake", "voice cloning", "fraud"], main_claims: ["Deepfake fraud complaints up 300% YoY"] },
  },
  {
    id: "mock_ai_2", main_category: "ai_enabled_threats", source_type: "threat_intelligence",
    trust_tier: "high", title: "AI-Enhanced Phishing Campaigns: 2024 Analysis",
    publisher: "Verizon DBIR", url: "https://www.verizon.com/business/resources/reports/dbir/",
    understanding: { entities: ["phishing", "AI generation", "BEC"] },
  },
];

// ── Supabase loader ───────────────────────────────────────────────────────────

async function loadSourcesFromDb(limitN) {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from("sources")
    .select("id, title, url, publisher, source_type, main_category, trust_tier, understanding, intelligence, layer3_status, ai_specificity_score")
    .in("main_category", ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"])
    .eq("layer3_status", "pass")
    .gte("ai_specificity_score", 40)
    .order("ai_specificity_score", { ascending: false })
    .limit(limitN);

  if (error) throw new Error(`Supabase error: ${error.message}`);
  return data || [];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function badge(confidence) {
  return { high: "✅", medium: "⚠️", low: "🔴" }[confidence] || "❓";
}

function printEvidenceItem(ev, i) {
  const reviewFlag = ev.needs_manual_review ? " [MANUAL REVIEW REQUIRED]" : "";
  const urlNote    = ev.url ? `\n     URL (${ev.url_confidence}): ${ev.url}` : "\n     URL: (unknown — needs manual lookup)";

  console.log(`  ${i + 1}. ${badge(ev.evidence_confidence)} [${ev.evidence_type.toUpperCase()}] ${ev.title}`);
  console.log(`     Publisher: ${ev.publisher}${ev.published_date ? " | " + ev.published_date : ""}${reviewFlag}`);
  if (ev.metric_value != null) {
    console.log(`     Metric: ${ev.metric_name || "value"} = ${ev.metric_value}${ev.metric_timeframe ? " (" + ev.metric_timeframe + ")" : ""}`);
  }
  if (ev.exact_quote) {
    console.log(`     Quote: "${ev.exact_quote.slice(0, 120)}"`);
  }
  console.log(`     Summary: ${ev.summary.slice(0, 200)}`);
  console.log(`     Relevance: ${ev.relevance.slice(0, 150)}`);
  console.log(urlNote);
  console.log(`     Quality: ${ev.source_quality_score}/100 | Confidence: ${ev.evidence_confidence} | Citation: ${ev.citation_type}`);
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Layer 5e — Evidence Search Dry Run");
  console.log("═══════════════════════════════════════════════════════\n");

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey    = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2;

  if (!anthropicKey && !geminiKey) {
    console.error("❌  No ANTHROPIC_API_KEY or GEMINI_API_KEY found in environment.");
    console.error("    Set at least one to run the evidence search.");
    process.exit(1);
  }

  const provider = anthropicKey ? `Anthropic (${process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"})` : "Gemini Pro";
  console.log(`Provider: ${provider}`);

  let sources;
  if (loadDb) {
    console.log(`Loading up to ${limit} sources from Supabase...`);
    try {
      sources = await loadSourcesFromDb(limit);
      console.log(`Loaded ${sources.length} sources from DB\n`);
    } catch (err) {
      console.error(`Failed to load from DB: ${err.message}`);
      console.log("Falling back to mock sources\n");
      sources = MOCK_SOURCES;
    }
  } else {
    sources = MOCK_SOURCES;
    console.log(`Using ${sources.length} mock sources (pass --load-db to use real sources)\n`);
  }

  // Optionally filter to one category
  if (onlyCat) {
    sources = sources.filter((s) => s.main_category === onlyCat);
    console.log(`Filtered to category: ${onlyCat} → ${sources.length} sources\n`);
  }

  const categoryCounts = {};
  for (const s of sources) {
    categoryCounts[s.main_category] = (categoryCounts[s.main_category] || 0) + 1;
  }
  console.log("Source distribution:", categoryCounts, "\n");

  // Run the evidence search
  const t0 = Date.now();
  const result = await runEvidenceSearchLayer(sources, [], { skipLlm: false, minSourcesPerCategory: 1 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  Results (${elapsed}s)`);
  console.log(`${"═".repeat(55)}\n`);

  if (result.skipped) {
    console.log("⚠️  Evidence search was skipped (no LLM available)");
    return;
  }

  console.log(`Total external evidence items: ${result.external_evidence.length}`);
  console.log(`Manual review required: ${result.manual_review_items.length}`);
  console.log(`Unsupported queries: ${result.unsupported_queries.length}`);
  console.log();

  // Per-category breakdown
  for (const [cat, catData] of Object.entries(result.evidence_by_category)) {
    const summary = result.evidence_inventory_summary[cat] || {};
    console.log(`${"─".repeat(55)}`);
    console.log(`📂 ${cat.toUpperCase().replace(/_/g, " ")}`);
    console.log(`   ${summary.total} items | ${summary.high_confidence} high-confidence | ${summary.needs_review} need review`);
    console.log(`   Coverage: ${catData.coverage_assessment}`);
    console.log();

    if (catData.items.length === 0) {
      console.log("   (no evidence found for this category)");
    } else {
      catData.items.forEach((ev, i) => printEvidenceItem(ev, i));
    }

    if (catData.unsupported_queries.length > 0) {
      console.log(`   ⚠️  UNSUPPORTED QUERIES (no reliable evidence found):`);
      catData.unsupported_queries.forEach((q) => console.log(`     - ${q}`));
      console.log();
    }
  }

  // Manual review summary
  if (result.manual_review_items.length > 0) {
    console.log(`${"─".repeat(55)}`);
    console.log(`🔍 MANUAL REVIEW REQUIRED (${result.manual_review_items.length} items):`);
    result.manual_review_items.forEach((ev) => {
      console.log(`   [${ev.category}] "${ev.title}" — ${ev.publisher} (URL confidence: ${ev.url_confidence})`);
    });
    console.log();
  }

  // Citation stats
  console.log(`${"─".repeat(55)}`);
  console.log("📊 CITATION STATS:");
  const confCounts = { high: 0, medium: 0, low: 0 };
  const typeCounts = {};
  for (const ev of result.external_evidence) {
    confCounts[ev.evidence_confidence] = (confCounts[ev.evidence_confidence] || 0) + 1;
    typeCounts[ev.evidence_type] = (typeCounts[ev.evidence_type] || 0) + 1;
  }
  console.log(`  Confidence: high=${confCounts.high} medium=${confCounts.medium} low=${confCounts.low}`);
  console.log(`  Types: ${Object.entries(typeCounts).map(([t, n]) => `${t}=${n}`).join(" ")}`);
  const withUrl = result.external_evidence.filter((e) => e.url && e.url_confidence !== "low").length;
  console.log(`  With verified URL: ${withUrl}/${result.external_evidence.length}`);
  console.log();

  // Sample analytics references (simulated viz spec enrichment)
  const sampleSpec = {
    visualization_id: "attack_vector_frequency",
    chart_type: "bar_chart",
    title: "Top Attack Vectors",
    category: "traditional_ai_threats",
  };
  const { attachEvidenceReferencesToSpecs } = await import("../lib/pipeline/evidence/evidenceSearchLayer.js");
  const enriched = attachEvidenceReferencesToSpecs([sampleSpec], result.external_evidence);
  if (enriched[0]?.references?.length > 0) {
    console.log(`${"─".repeat(55)}`);
    console.log("📎 SAMPLE ANALYTICS REFERENCES (for 'attack_vector_frequency' spec):");
    enriched[0].references.forEach((ref) => {
      console.log(`   [${ref.evidence_type}] "${ref.title}" — ${ref.publisher}`);
      if (ref.url) console.log(`   → ${ref.url}`);
    });
    console.log(`   Citation note: ${enriched[0].citation_note}`);
    console.log();
  }

  console.log("✅  Dry run complete.\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
