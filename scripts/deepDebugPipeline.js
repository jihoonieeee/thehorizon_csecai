#!/usr/bin/env node
/**
 * Deep Debug Pipeline — Layer-by-Layer Pipeline Test Harness
 *
 * Runs sources through the pipeline one layer at a time, writing detailed
 * Markdown reports and JSON checkpoints at each layer boundary. Designed
 * to produce auditable output that can be reviewed externally.
 *
 * Usage:
 *   npm run debug:deep -- [options]
 *
 * Options:
 *   --limit <n>                 Number of sources to process (default: 20)
 *   --source-id <id>            Run only this source (can repeat)
 *   --category <cat>            Filter sources by main_category
 *   --from-layer <L1|L2|..>    Start from this layer (default: L1)
 *   --to-layer <L9|..>         Stop after this layer (default: L9)
 *   --no-llm                   Skip all LLM calls (deterministic mode)
 *   --trace-prompts             Write sanitized LLM prompt traces
 *   --write-md                  Write markdown reports (default: true)
 *   --write-json                Write JSON checkpoints (default: true)
 *
 * Output structure:
 *   debug/runs/<run_id>/
 *     00_README_FOR_AUDIT.md
 *     00_run_summary.md
 *     01_L1_ingestion_deep.md
 *     02_L2_cleaning_deep.md
 *     03_L3_validation_deep.md
 *     04_L4_taxonomy_deep.md
 *     05_L5A_evidence_extraction_deep.md
 *     05_L5B_analytics_deep.md
 *     05_L5C_web_enrichment_deep.md
 *     06_L6_analysis_deep.md
 *     07_L7_deck_planning_deep.md
 *     08_L8_narrative_generation_deep.md
 *     09_L9_export_qa_deep.md
 *     10_dashboard_intelligence_deep.md
 *     11_errors_warnings_and_suspected_bugs.md
 *     AUDIT_PACK.md
 *     checkpoints/
 *       L1.json, L2.json, L3.json, L4.json, L5A.json, ...
 *     prompt_traces/
 *       <layer>_<task>_<id>.md  (if --trace-prompts)
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal = null) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : defaultVal;
}
function hasFlag(flag) { return args.includes(flag); }
function getMultiArg(flag) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) results.push(args[i + 1]);
  }
  return results;
}

const LIMIT        = parseInt(getArg("--limit", "20"), 10);
const SOURCE_IDS   = getMultiArg("--source-id");
const CATEGORY     = getArg("--category");
const FROM_LAYER   = getArg("--from-layer", "L1");
const TO_LAYER     = getArg("--to-layer", "L9");
const NO_LLM       = hasFlag("--no-llm");
const TRACE_PROMPTS = hasFlag("--trace-prompts");
const WRITE_MD     = !hasFlag("--no-md");
const WRITE_JSON   = !hasFlag("--no-json");

// Layer order for from/to filtering
const LAYER_ORDER = ["L1","L2","L3","L4","L5A","L5B","L5C","L6","L7","L8","L9"];
function shouldRun(layer) {
  const from = LAYER_ORDER.indexOf(FROM_LAYER);
  const to   = LAYER_ORDER.indexOf(TO_LAYER);
  const cur  = LAYER_ORDER.indexOf(layer);
  if (from < 0 || to < 0 || cur < 0) return true;
  return cur >= from && cur <= to;
}

// ── Run setup ─────────────────────────────────────────────────────────────────

const RUN_ID  = `deepdebug-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const RUN_DIR = path.join(ROOT, "debug", "runs", RUN_ID);
const CK_DIR  = path.join(RUN_DIR, "checkpoints");
const PT_DIR  = path.join(RUN_DIR, "prompt_traces");

fs.mkdirSync(CK_DIR, { recursive: true });
if (TRACE_PROMPTS) fs.mkdirSync(PT_DIR, { recursive: true });

const t0 = Date.now();

function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1); }

// ── I/O helpers ───────────────────────────────────────────────────────────────

function save(name, data) {
  const p = path.join(RUN_DIR, name);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(p, content);
  console.log(`  → ${name}`);
  return p;
}

function saveCheckpoint(layer, data) {
  if (!WRITE_JSON) return;
  const p = path.join(CK_DIR, `${layer}.json`);
  const payload = { run_id: RUN_ID, layer, timestamp: new Date().toISOString(), ...data };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  console.log(`  → checkpoints/${layer}.json`);
}

function saveReport(filename, md) {
  if (!WRITE_MD) return;
  save(filename, md);
}

function savePromptTrace(layer, task, id, data) {
  if (!TRACE_PROMPTS) return;
  const filename = `${layer}_${task}_${String(id || "run").slice(0, 30).replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
  const p = path.join(PT_DIR, filename);
  const lines = [
    `# Prompt Trace — ${layer} / ${task}`,
    `\n> **ID**: ${id}  `,
    `> **Timestamp**: ${new Date().toISOString()}`,
    ``,
    `## Task Name`,
    `${layer} — ${task}`,
    ``,
    `## Model Used`,
    `${data.model || "unknown"}`,
    ``,
    `## Input Fields`,
    "```json",
    JSON.stringify(data.input || {}, null, 2).slice(0, 3000),
    "```",
    ``,
    `## Prompt Text`,
    "```",
    String(data.prompt || "not captured").slice(0, 5000),
    "```",
    ``,
    `## Output JSON`,
    "```json",
    JSON.stringify(data.output || {}, null, 2).slice(0, 3000),
    "```",
    ``,
    `## Validator Result`,
    `${data.validator_result || "not captured"}`,
    ``,
    `## Retry Result`,
    `${data.retry_result || "no retry"}`,
  ];
  fs.writeFileSync(p, lines.join("\n"));
}

// ── Error log ─────────────────────────────────────────────────────────────────

const errorLog = [];

function logError(layer, type, message, extras = {}) {
  const entry = { severity: "error", layer, type, message, timestamp: new Date().toISOString(), ...extras };
  errorLog.push(entry);
  console.error(`  [ERROR] [${layer}] ${message}`);
  return entry;
}

function logWarn(layer, message, extras = {}) {
  const entry = { severity: "warning", layer, message, timestamp: new Date().toISOString(), ...extras };
  errorLog.push(entry);
  console.warn(`  [WARN] [${layer}] ${message}`);
  return entry;
}

// ── Source fixtures ───────────────────────────────────────────────────────────
// Used when the database is unavailable or returns fewer than requested sources.

function buildFixtures(count = 20) {
  const fixtures = [
    // Research / benchmark
    { _fixture: true, source_type: "research_finding", trust_tier: "high",
      title: "FIXTURE: Adversarial Attacks on Instruction-Tuned LLMs via Indirect Prompt Injection",
      publisher: "arXiv (synthetic fixture)", url: "https://arxiv.org/abs/fixture-001",
      full_text: "We demonstrate that instruction-tuned LLMs are vulnerable to indirect prompt injection (IPI) attacks where malicious instructions are embedded in retrieved documents. In experiments across GPT-4, Claude 3, and Gemini Ultra, IPI success rate averaged 73% without defenses. We propose a novel token-level defense that reduces IPI success to 12%.",
      main_category: "llm_threats", date_published: "2026-01-15" },
    { _fixture: true, source_type: "research_finding", trust_tier: "high",
      title: "FIXTURE: Evaluating Model Extraction Attacks on Production ML APIs",
      publisher: "IEEE S&P (synthetic fixture)", url: "https://example.com/fixture-002",
      full_text: "Model extraction attacks allow adversaries to approximate a target model by querying its API. We evaluate 15 state-of-the-art extraction methods against 8 commercial ML APIs including OpenAI, Google, and AWS. Our findings show that models with >1B parameters can be extracted with 95% fidelity using 10M queries at ~$500.",
      main_category: "traditional_ai_threats", date_published: "2026-02-10" },
    { _fixture: true, source_type: "research_finding", trust_tier: "high",
      title: "FIXTURE: Backdoor Attacks in Federated Learning for Medical Image Classification",
      publisher: "NeurIPS (synthetic fixture)", url: "https://example.com/fixture-003",
      full_text: "We study backdoor poisoning attacks in federated learning scenarios applied to medical imaging. A malicious participant contributing 5% of training data can achieve 99% backdoor activation rate while maintaining 97% clean accuracy. The attack persists through 50 rounds of federated averaging.",
      main_category: "traditional_ai_threats", date_published: "2026-03-01" },
    { _fixture: true, source_type: "research_finding", trust_tier: "primary",
      title: "FIXTURE: CISA Advisory on LLM Prompt Injection in Autonomous Agent Pipelines",
      publisher: "CISA (synthetic fixture)", url: "https://www.cisa.gov/fixture-004",
      full_text: "CISA has identified active exploitation of prompt injection vulnerabilities in LLM-based agentic pipelines. Threat actors have used prompt injection to exfiltrate API keys from coding assistants in at least 12 documented incidents in Q1 2026. Affected products include GitHub Copilot, Cursor, and JetBrains AI Assistant.",
      main_category: "agentic_ai_threats", date_published: "2026-04-05" },
    { _fixture: true, source_type: "research_finding", trust_tier: "high",
      title: "FIXTURE: Benchmark Study: LLM Jailbreaking Techniques Across 20 Models",
      publisher: "AI Safety Institute (synthetic fixture)", url: "https://example.com/fixture-005",
      full_text: "We systematically evaluate 47 jailbreaking techniques across 20 LLMs. Many-shot jailbreaking succeeds at 81% against GPT-4o. DAN-style attacks succeed at 34% average across models. Multimodal attacks (image+text) succeed at 62% against vision-enabled models. Only models with constitutional AI training showed consistent resistance.",
      main_category: "llm_threats", date_published: "2026-02-28" },

    // Incident / advisory / threat intel
    { _fixture: true, source_type: "threat_intelligence", trust_tier: "high",
      title: "FIXTURE: APT41 Uses LLM-Generated Spear-Phishing to Target Defense Contractors",
      publisher: "Mandiant (synthetic fixture)", url: "https://www.mandiant.com/fixture-006",
      full_text: "Mandiant has identified APT41 using GPT-4-equivalent LLM infrastructure to generate highly personalized spear-phishing emails at scale. The campaign targeted 340 defense contractors across the US, UK, and Australia. LLM-generated emails had 3.4x higher click-through rate than template-based phishing. Attribution based on C2 infrastructure and TTP overlap.",
      main_category: "ai_enabled_threats", date_published: "2026-05-12" },
    { _fixture: true, source_type: "vulnerability", trust_tier: "primary",
      title: "FIXTURE: CVE-2026-99001 — Critical RCE in LangChain Agent Executor",
      publisher: "NVD (synthetic fixture)", url: "https://nvd.nist.gov/fixture-007",
      full_text: "A critical remote code execution vulnerability (CVSS 9.8) exists in LangChain versions prior to 0.3.12 when using the AgentExecutor with untrusted tool input. An attacker can craft a malicious tool response to achieve arbitrary code execution on the server. This vulnerability has been observed in active exploitation.",
      main_category: "agentic_ai_threats", date_published: "2026-05-20" },
    { _fixture: true, source_type: "threat_intelligence", trust_tier: "high",
      title: "FIXTURE: FIN7 Adopts AI-Powered Malware Generation for Ransomware Variants",
      publisher: "CrowdStrike (synthetic fixture)", url: "https://www.crowdstrike.com/fixture-008",
      full_text: "CrowdStrike Intelligence has observed FIN7 using AI-assisted tools to rapidly generate unique ransomware variants at scale. Each variant exhibits polymorphic obfuscation patterns consistent with LLM-generated code. Production rate estimated at 200+ unique samples per day versus previous baseline of 5-10.",
      main_category: "ai_enabled_threats", date_published: "2026-04-18" },
    { _fixture: true, source_type: "threat_intelligence", trust_tier: "high",
      title: "FIXTURE: Deepfake-Based CEO Fraud Nets $35M from European Bank",
      publisher: "Europol (synthetic fixture)", url: "https://www.europol.europa.eu/fixture-009",
      full_text: "Europol has confirmed a deepfake-enabled business email compromise attack resulting in a €32M wire transfer from a European bank. The attackers used real-time voice cloning of the CEO's voice in a phone call followed by a deepfake video conference. This is the largest confirmed deepfake fraud case in Europe.",
      main_category: "ai_enabled_threats", date_published: "2026-03-22" },
    { _fixture: true, source_type: "vulnerability", trust_tier: "high",
      title: "FIXTURE: RAG Poisoning Attack Demonstrated Against Enterprise Knowledge Bases",
      publisher: "Trail of Bits (synthetic fixture)", url: "https://blog.trailofbits.com/fixture-010",
      full_text: "Trail of Bits researchers have demonstrated a RAG poisoning attack against enterprise knowledge base systems. By injecting 47 malicious documents into a corporate Confluence instance, they caused the connected LLM to leak confidential HR data in 89% of queries from authorized users. The attack requires only write access to any document source.",
      main_category: "llm_threats", date_published: "2026-01-30" },

    // Vendor / news / blog
    { _fixture: true, source_type: "security_blog", trust_tier: "medium",
      title: "FIXTURE: 5 Ways AI is Transforming Threat Detection in SOCs",
      publisher: "Security Vendor Blog (synthetic fixture)", url: "https://example.com/fixture-011",
      full_text: "Artificial intelligence is revolutionizing Security Operations Centers. Modern SOCs use ML to detect anomalies 10x faster. Our platform reduces false positives by 40%. This blog post explores five key use cases for AI in threat detection including UEBA, log analysis, threat hunting, incident prioritization, and automated response.",
      main_category: "unclear_or_adjacent", date_published: "2026-02-14" },
    { _fixture: true, source_type: "security_blog", trust_tier: "medium",
      title: "FIXTURE: How to Protect Your Organization from AI-Powered Attacks in 2026",
      publisher: "Medium Security Blog (synthetic fixture)", url: "https://example.com/fixture-012",
      full_text: "AI-powered attacks are on the rise. In this article we explore practical steps organizations can take to defend against AI threats. Key recommendations include implementing zero-trust architecture, deploying AI-aware endpoint detection, training staff to recognize AI-generated phishing, and maintaining up-to-date LLM security policies.",
      main_category: "unclear_or_adjacent", date_published: "2026-03-10" },
    { _fixture: true, source_type: "security_blog", trust_tier: "medium",
      title: "FIXTURE: MCP Protocol Security Review: What You Need to Know",
      publisher: "Security Researcher Blog (synthetic fixture)", url: "https://example.com/fixture-013",
      full_text: "Anthropic's Model Context Protocol (MCP) introduces new attack surfaces for AI agents. We reviewed the MCP specification and identified three security concerns: (1) insufficient sandboxing of tool calls, (2) no cryptographic verification of tool server identity, (3) SSRF risk from URL parameters in tool responses. We disclosed these to Anthropic in January 2026.",
      main_category: "agentic_ai_threats", date_published: "2026-02-05" },
    { _fixture: true, source_type: "news_article", trust_tier: "medium",
      title: "FIXTURE: OpenAI Patches API Rate Limiting Bypass That Enabled Model Extraction",
      publisher: "The Register (synthetic fixture)", url: "https://www.theregister.com/fixture-014",
      full_text: "OpenAI has patched a vulnerability in its API rate limiting system that allowed researchers to bypass query quotas and potentially conduct model extraction attacks at scale. The flaw was discovered by Stanford researchers and allowed 100x the permitted query volume. No evidence of exploitation in the wild was found.",
      main_category: "traditional_ai_threats", date_published: "2026-04-02" },
    { _fixture: true, source_type: "security_blog", trust_tier: "medium",
      title: "FIXTURE: AI Governance Frameworks and Their Role in Cybersecurity",
      publisher: "Governance Think Tank (synthetic fixture)", url: "https://example.com/fixture-015",
      full_text: "Several AI governance frameworks have emerged including NIST AI RMF, EU AI Act, and Singapore's Model AI Governance Framework. These frameworks include cybersecurity considerations but primarily address broader AI risk. This analysis examines how each framework addresses AI-specific security threats and where gaps remain.",
      main_category: "unclear_or_adjacent", date_published: "2026-01-20" },

    // Weak / speculative / edge-case
    { _fixture: true, source_type: "news_article", trust_tier: "low",
      title: "FIXTURE: Could AI Eventually Hack Itself? (Opinion)",
      publisher: "Tech Blog (synthetic fixture)", url: "https://example.com/fixture-016",
      full_text: "In a speculative piece, we explore whether future AI systems could autonomously discover and exploit vulnerabilities in other AI systems. While there is no evidence of this occurring, AI researchers warn it could become possible by 2030. Some experts we spoke with disagree. The implications would be profound.",
      main_category: "unclear_or_adjacent", date_published: "2026-05-01" },
    { _fixture: true, source_type: "news_article", trust_tier: "medium",
      title: "FIXTURE: DUPLICATE — Deepfake CEO Fraud Targets European Bank (Repost)",
      publisher: "Another Security Blog (synthetic fixture)", url: "https://example.com/fixture-017",
      full_text: "A major deepfake fraud case has been reported in Europe involving a fake CEO call. The attack used AI voice cloning and video manipulation to authorize a large wire transfer. This is consistent with the trend of AI-enabled fraud attacks increasing dramatically in 2026.",
      main_category: "ai_enabled_threats", date_published: "2026-03-23" },
    { _fixture: true, source_type: "news_article", trust_tier: "low",
      title: "FIXTURE: Vendor Raises $50M Series B for AI Security Platform",
      publisher: "TechCrunch (synthetic fixture)", url: "https://example.com/fixture-018",
      full_text: "AISecure Inc. has raised $50M in Series B funding to expand its AI-powered security platform. The company, founded in 2023, uses machine learning to detect threats across enterprise networks. Investors include top-tier VCs. The company plans to use the funds to expand to Europe and Asia.",
      main_category: "unclear_or_adjacent", date_published: "2026-05-15" },
    { _fixture: true, source_type: "news_article", trust_tier: "medium",
      title: "FIXTURE: FIFA World Cup 2026 Cybersecurity Preparations (Off-Topic)",
      publisher: "Sports Security Blog (synthetic fixture)", url: "https://example.com/fixture-019",
      full_text: "The 2026 FIFA World Cup represents a major cybersecurity challenge for host countries. Organizers are deploying traditional security measures including network monitoring, DDoS protection, and physical security systems. The event will see elevated cybercriminal activity targeting fans and sponsors. No AI-specific threats discussed.",
      main_category: "unclear_or_adjacent", date_published: "2026-04-10" },
    { _fixture: true, source_type: "news_article", trust_tier: "low",
      title: "FIXTURE: Vague Claim — AI Will Change Everything in Security Soon",
      publisher: "Generic Tech Blog (synthetic fixture)", url: "https://example.com/fixture-020",
      full_text: "AI is rapidly changing the cybersecurity landscape. Experts predict AI will transform both attack and defense in coming years. Organizations should prepare now. The pace of change is accelerating. Both attackers and defenders are increasingly using AI. This trend will continue.",
      main_category: "unclear_or_adjacent", date_published: "2026-05-18" },
  ];

  return fixtures.slice(0, count).map((f, i) => ({
    ...f,
    id: `fixture-${String(i + 1).padStart(3, "0")}`,
    ai_specificity_score: f.trust_tier === "primary" ? 85 : f.trust_tier === "high" ? 70 : 40,
    source_type: f.source_type || "unknown",
    ingest_warnings: [],
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Deep Debug Pipeline`);
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`  Limit:  ${LIMIT}  |  LLM: ${NO_LLM ? "disabled" : "enabled"}`);
  console.log(`  Layers: ${FROM_LAYER} → ${TO_LAYER}`);
  console.log(`  Output: debug/runs/${RUN_ID}/`);
  console.log(`${banner}\n`);

  // ─── State buckets ──────────────────────────────────────────────────────────
  let sources         = [];          // L1 raw sources
  let cleanedSources  = [];          // L2 cleaned
  let validatedSources = [];         // L3 validated
  let taxonomyResults = [];          // L4 taxonomy
  let passedL3Sources = [];          // sources that survived L3
  let passedL4Sources = [];          // sources that survived L4
  let triageResults   = [];          // per-source L3 results
  let l4Counts        = {};
  let rawfactResult   = null;        // L5A
  let analyticsResult = null;        // L5B
  let webEvidenceResult = null;      // L5C
  let categoryAnalyses = [];         // L6
  let crossCatSynthesis = null;      // L6 cross-category
  let deckResult      = null;        // L7+L8
  let qaResult        = null;        // L9
  let dashboardObjects = [];         // dashboard intel
  let synthesisResult = null;        // full synthesis output (for slides layer)

  const reportState = {
    sourceMethod: "unknown",
    webEvidenceEnabled: false,
  };

  // ─── L1: Source loading ─────────────────────────────────────────────────────
  if (shouldRun("L1")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 1 — Source Ingestion`);
    console.log(`${"─".repeat(64)}`);

    let dbSources = [];
    let dbError   = null;

    // Try DB
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        let query = supabase.from("sources").select("*");

        if (SOURCE_IDS.length > 0) {
          query = query.in("id", SOURCE_IDS);
        } else {
          if (CATEGORY) {
            query = query.eq("main_category", CATEGORY);
          }
          // Get a balanced mix
          query = query
            .not("full_text", "is", null)
            .order("date_published", { ascending: false })
            .limit(LIMIT * 4);
        }

        const { data, error } = await query;
        if (error) {
          dbError = error.message;
          logWarn("L1", `DB query failed: ${error.message}`, { likely_cause: "check SUPABASE credentials" });
        } else if (data && data.length > 0) {
          // Balance the selection: up to LIMIT with diversity
          dbSources = balanceSources(data, LIMIT);
          reportState.sourceMethod = "supabase_database";
          console.log(`  Loaded ${dbSources.length} sources from Supabase`);
        } else {
          logWarn("L1", "Database returned 0 sources — using fixtures");
        }
      } catch (err) {
        dbError = err.message;
        logWarn("L1", `DB connection error: ${err.message}`, { likely_cause: "check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY" });
      }
    } else {
      logWarn("L1", "No Supabase credentials in env — using fixtures", { likely_cause: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    // Fill with fixtures if needed
    if (dbSources.length < Math.min(LIMIT, 5)) {
      const fixtureCount = LIMIT - dbSources.length;
      const fixturePrefix = dbSources.length > 0 ? `Supplementing ${dbSources.length} DB sources with` : "Using";
      console.log(`  ${fixturePrefix} ${fixtureCount} fixture sources`);
      logWarn("L1", `${fixturePrefix} ${fixtureCount} synthetic fixture sources`, {
        likely_cause: dbError ? `DB error: ${dbError}` : "insufficient DB sources",
        likely_bug: false,
      });
      const fixturesNeeded = buildFixtures(fixtureCount);
      sources = [...dbSources, ...fixturesNeeded];
      reportState.sourceMethod = dbSources.length > 0 ? "db_plus_fixtures" : "fixtures_only";
    } else {
      sources = dbSources;
    }

    console.log(`  Total sources: ${sources.length}`);

    saveCheckpoint("L1", {
      source_count: sources.length,
      source_method: reportState.sourceMethod,
      by_type:  countBy(sources, "source_type"),
      by_trust: countBy(sources, "trust_tier"),
      by_category: countBy(sources, "main_category"),
      sources: sources.map(s => ({
        id: s.id,
        title: s.title?.slice(0, 80),
        publisher: s.publisher,
        source_type: s.source_type,
        trust_tier: s.trust_tier,
        text_length: (s.full_text || s.raw_text || "").length,
        is_fixture: s._fixture || false,
      })),
    });

    const { reportL1 } = await import("../lib/pipeline/debug/deepReporter.js");
    saveReport("01_L1_ingestion_deep.md", reportL1(RUN_ID, sources, {
      sourceMethod: reportState.sourceMethod,
      warnings: errorLog.filter(e => e.layer === "L1").map(e => e.message),
    }));
  }

  // ─── L2: Text cleaning ──────────────────────────────────────────────────────
  if (shouldRun("L2")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 2 — Text Cleaning`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { cleanSources } = await import("../lib/pipeline/clean/cleanSources.js");
      const originalSources = sources.map(s => ({ ...s }));
      cleanedSources = cleanSources(sources);
      console.log(`  Cleaned ${cleanedSources.length} sources`);

      // Update sources in place
      sources = cleanedSources;

      saveCheckpoint("L2", {
        sources_cleaned: cleanedSources.length,
        with_code_blocks: cleanedSources.filter(s => s.extracted_code_blocks?.length > 0).length,
        with_iocs: cleanedSources.filter(s => s.extracted_iocs?.length > 0).length,
        avg_text_length: Math.round(
          cleanedSources.reduce((n, s) => n + (s.clean_text || "").length, 0) / Math.max(cleanedSources.length, 1)
        ),
        samples: cleanedSources.slice(0, 5).map(s => ({
          id: s.id,
          before: (originalSources.find(o => o.id === s.id)?.full_text || "").length,
          after: (s.clean_text || s.full_text || "").length,
          has_code_blocks: (s.extracted_code_blocks || []).length > 0,
          has_iocs: (s.extracted_iocs || []).length > 0,
        })),
      });

      const { reportL2 } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("02_L2_cleaning_deep.md", reportL2(RUN_ID, cleanedSources, originalSources));
    } catch (err) {
      logError("L2", "clean_failed", `cleanSources threw: ${err.message}`, { stack: err.stack });
      cleanedSources = sources;
    }
  } else {
    cleanedSources = sources;
  }

  // ─── L3: Validation & typing ────────────────────────────────────────────────
  if (shouldRun("L3")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 3 — Validation & Typing`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { validateAndTypeSource } = await import("../lib/pipeline/validation/validateAndTypeSource.js");
      const { prepopulateCircularRegistry } = await import("../lib/pipeline/validation/originTracking.js");
      prepopulateCircularRegistry(cleanedSources);

      for (let i = 0; i < cleanedSources.length; i++) {
        const s = cleanedSources[i];
        process.stdout.write(`  [${i+1}/${cleanedSources.length}] ${(s.title || s.id).slice(0, 50)}... `);
        try {
          const r = await validateAndTypeSource(s, { skipLlm: NO_LLM });
          Object.assign(s, r);
          const status = s.layer3_status || "?";
          process.stdout.write(`${status}\n`);
          triageResults.push({
            id: s.id,
            title: s.title?.slice(0, 80),
            layer3_status: s.layer3_status,
            validation_status: s.validation_status,
            source_type: s.source_type,
            trust_tier: s.trust_tier,
            publisher_class: s.publisher_class,
            content_quality: s.content_quality,
            ai_specificity_score: s.ai_specificity_score,
            relevance_tier: s.relevance_tier,
            relevance_path: s.relevance_path,
            ai_threat_focus: s.ai_threat_focus,
            source_quality_status: s.source_quality_status,
            origin_role: s.origin_role,
            independence_level: s.independence_level,
            downstream_route: s.downstream_route,
            final_validity_reason: s.final_validity_reason,
          });
        } catch (err) {
          logError("L3", "validate_error", `Failed to validate source ${s.id}: ${err.message}`, {
            source_id: s.id, stack: err.stack
          });
          triageResults.push({ id: s.id, title: s.title?.slice(0,60), error: err.message, layer3_status: "error" });
          s.layer3_status = "error";
          process.stdout.write(`ERROR\n`);
        }
      }

      validatedSources = cleanedSources;
      passedL3Sources  = cleanedSources.filter(s => s.layer3_status !== "reject" && s.layer3_status !== "error");
      const passed = triageResults.filter(r => r.layer3_status === "pass").length;
      const review = triageResults.filter(r => r.layer3_status === "review").length;
      const rejected = triageResults.filter(r => r.layer3_status === "reject").length;
      console.log(`  L3 result: pass=${passed} review=${review} reject=${rejected}`);

      saveCheckpoint("L3", {
        total: triageResults.length,
        pass: passed, review, reject: rejected,
        by_relevance: countBy(triageResults, "relevance_tier"),
        by_route:     countBy(triageResults, "downstream_route"),
        triage_results: triageResults,
      });

      const { reportL3 } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("03_L3_validation_deep.md", reportL3(RUN_ID, triageResults));
    } catch (err) {
      logError("L3", "layer_failed", `Layer 3 setup failed: ${err.message}`, { stack: err.stack });
      passedL3Sources = cleanedSources;
      triageResults = cleanedSources.map(s => ({ id: s.id, title: s.title?.slice(0,60), layer3_status: "pass", error: "L3 skipped" }));
    }
  } else {
    passedL3Sources = cleanedSources;
    triageResults = cleanedSources.map(s => ({ id: s.id, title: s.title?.slice(0,60), layer3_status: "pass" }));
  }

  // ─── L4: Taxonomy understanding ─────────────────────────────────────────────
  if (shouldRun("L4")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 4 — Taxonomy Understanding`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { understandSources } = await import("../lib/pipeline/understand/understandSources.js");
      const { classifySource }    = await import("../lib/pipeline/classify/classifyCategory.js");

      const l4Input = passedL3Sources;
      console.log(`  Processing ${l4Input.length} sources through L4...`);

      const l4Out = await understandSources(l4Input, {
        skipLlm: NO_LLM,
        concurrency: 3,
        onProgress: (done, total) => process.stdout.write(`  [L4] ${done}/${total}\r`),
      });

      l4Counts = l4Out.counts;
      const l4Sources = l4Out.sources;

      // Classify each source
      for (const s of l4Sources) {
        try {
          const classified = classifySource(s);
          Object.assign(s, classified);
        } catch (err) {
          logWarn("L4", `classifySource failed for ${s.id}: ${err.message}`);
        }
      }

      // Build taxonomy results
      taxonomyResults = l4Sources.map(s => ({
        id: s.id,
        title: s.title?.slice(0, 80),
        understanding: s.understanding || {},
        primary_domain: s.understanding?.primary_domain || s.primary_domain,
        main_category: s.main_category,
        taxonomy_validation_status: s.understanding?.taxonomy_validation_status || s.taxonomy_validation_status,
        primary_tags: s.understanding?.primary_tags || s.primary_tags || [],
        sub_techniques: s.understanding?.sub_techniques || [],
        ai_enabled: s.understanding?.ai_enabled ?? s.ai_enabled,
        key_entities: s.understanding?.key_entities || [],
        main_claims: s.understanding?.main_claims || [],
        important_numbers: s.understanding?.important_numbers || [],
      }));

      passedL4Sources = l4Sources;
      console.log(`\n  L4 counts: ${JSON.stringify(l4Counts)}`);

      saveCheckpoint("L4", {
        total: taxonomyResults.length,
        counts: l4Counts,
        by_category: countBy(taxonomyResults, "main_category"),
        by_validation_status: countBy(taxonomyResults, "taxonomy_validation_status"),
        discarded: l4Out.discarded?.map(s => ({ id: s.id, title: s.title?.slice(0,60) })) || [],
        taxonomy_results: taxonomyResults,
      });

      const { reportL4 } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("04_L4_taxonomy_deep.md", reportL4(RUN_ID, taxonomyResults, l4Counts));
    } catch (err) {
      logError("L4", "layer_failed", `Layer 4 failed: ${err.message}`, { stack: err.stack });
      passedL4Sources = passedL3Sources;
      taxonomyResults = passedL3Sources.map(s => ({ id: s.id, title: s.title?.slice(0,60), error: err.message }));
    }
  } else {
    passedL4Sources = passedL3Sources;
    taxonomyResults = passedL3Sources.map(s => ({ id: s.id, title: s.title?.slice(0,60), main_category: s.main_category }));
  }

  // ─── L5A: Evidence extraction ───────────────────────────────────────────────
  if (shouldRun("L5A")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 5A — Evidence Extraction (Rawfact Branch)`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { runRawfactBranch } = await import("../lib/pipeline/rawfact/runRawfactBranch.js");
      console.log(`  Running rawfact branch on ${passedL4Sources.length} sources...`);
      rawfactResult = await runRawfactBranch(passedL4Sources, { skipLlm: NO_LLM });
      console.log(`  L5A: items=${rawfactResult.counts?.evidence_items_total} strong=${rawfactResult.counts?.strong_items} packs=${rawfactResult.counts?.evidence_packs}`);

      // Update passedL4Sources with enriched data from rawfact
      passedL4Sources = rawfactResult.rawfact_sources || passedL4Sources;

      saveCheckpoint("L5A", {
        counts: rawfactResult.counts,
        evidence_packs_by_category: (rawfactResult.evidence_packs || []).map(p => ({
          category: p.category,
          strong: p.strong?.length || 0,
          usable: p.usable?.length || 0,
          context: p.context?.length || 0,
          statistics: p.statistics?.length || 0,
        })),
        sample_items: (rawfactResult.rawfact_sources || []).slice(0, 5).flatMap(s =>
          (s.evidence_items || []).slice(0, 2).map(ei => ({
            source_id: s.id,
            evidence_id: ei.evidence_id,
            evidence_type: ei.evidence_type,
            strength: (ei.triage_data || {}).evidence_strength || ei.evidence_strength,
            admissibility: (ei.triage_data || {}).admissibility || ei.admissibility,
            claim: (ei.claim || "").slice(0, 120),
            quote: (ei.supporting_quote || "").slice(0, 120),
          }))
        ),
      });

      const { reportL5A } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("05_L5A_evidence_extraction_deep.md", reportL5A(RUN_ID, rawfactResult));
    } catch (err) {
      logError("L5A", "rawfact_failed", `L5A rawfact branch failed: ${err.message}`, { stack: err.stack });
      rawfactResult = { rawfact_sources: passedL4Sources, evidence_packs: [], counts: {} };
    }
  }

  // ─── L5B: Analytics ─────────────────────────────────────────────────────────
  if (shouldRun("L5B")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 5B — Analytics Branch`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { runAnalyticsBranch } = await import("../lib/pipeline/analytics/runAnalyticsBranch.js");
      const l5bInput = rawfactResult?.rawfact_sources || passedL4Sources;
      console.log(`  Running analytics on ${l5bInput.length} sources...`);
      analyticsResult = await runAnalyticsBranch(l5bInput, { skipLlm: NO_LLM, externalEvidence: [] });
      console.log(`  L5B: visualizations=${analyticsResult.counts?.visualizations} categories=${JSON.stringify(analyticsResult.counts?.categories)}`);

      saveCheckpoint("L5B", {
        counts: analyticsResult.counts,
        visualization_count: (analyticsResult.visualization_specs || []).length,
        viz_types: countBy(analyticsResult.visualization_specs || [], "chart_type"),
        qa_pass: analyticsResult.qa_report?.overall_pass,
        qa_failures: (analyticsResult.qa_report?.checks || []).filter(c => c.status === "fail").length,
      });

      const { reportL5B } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("05_L5B_analytics_deep.md", reportL5B(RUN_ID, analyticsResult));
    } catch (err) {
      logError("L5B", "analytics_failed", `L5B analytics branch failed: ${err.message}`, { stack: err.stack });
      analyticsResult = { aggregates: {}, visualization_specs: [], counts: {}, analytics_sources: passedL4Sources };
    }
  }

  // ─── L5C: Web evidence ──────────────────────────────────────────────────────
  if (shouldRun("L5C")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 5C — Web Evidence`);
    console.log(`${"─".repeat(64)}`);

    try {
      const { getWebEvidenceConfig } = await import("../lib/pipeline/webEvidence/webEvidenceConfig.js");
      const webEvidenceConfig = getWebEvidenceConfig();
      reportState.webEvidenceEnabled = webEvidenceConfig.enabled;

      if (webEvidenceConfig.enabled) {
        const { runWebEvidenceBranch } = await import("../lib/pipeline/webEvidence/runWebEvidenceBranch.js");
        const evidencePacks = rawfactResult?.evidence_packs || [];
        const seedEntities = [...new Set(
          (analyticsResult?.analytics_sources || passedL4Sources)
            .flatMap(s => s.understanding?.key_entities || [])
        )].filter(Boolean).slice(0, 20);

        webEvidenceResult = await runWebEvidenceBranch({
          evidencePacks,
          analyticsResult: analyticsResult || {},
          seedEntities,
          opts: { config: webEvidenceConfig, skipLlm: NO_LLM },
        });
        console.log(`  L5C: evidence=${webEvidenceResult.counts?.evidence_selected}/${webEvidenceResult.counts?.evidence_total} visuals=${webEvidenceResult.counts?.visuals_auto_slide}`);
      } else {
        console.log(`  L5C: DISABLED (set WEB_EVIDENCE_ENABLED=1 to enable)`);
      }

      saveCheckpoint("L5C", {
        enabled: webEvidenceConfig.enabled,
        counts: webEvidenceResult?.counts || {},
        evidence_count: (webEvidenceResult?.evidence_packages || []).length,
        visual_count: (webEvidenceResult?.visual_evidence || []).length,
      });

      const { reportL5C } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("05_L5C_web_enrichment_deep.md", reportL5C(RUN_ID, webEvidenceResult, webEvidenceConfig.enabled));
    } catch (err) {
      logError("L5C", "web_evidence_failed", `L5C web evidence failed: ${err.message}`, { stack: err.stack });
    }
  }

  // ─── L6: Strategic analysis ─────────────────────────────────────────────────
  if (shouldRun("L6")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 6 — Strategic Analysis`);
    console.log(`${"─".repeat(64)}`);

    try {
      // Build the web evidence adapter shape
      let externalEvidence = [];
      let externalVisualEvidence = [];
      if (webEvidenceResult) {
        const { webEvidenceToExternalEvidence } = await import("../lib/pipeline/synthesis/externalEvidence.js");
        const adapted = webEvidenceToExternalEvidence(webEvidenceResult);
        externalEvidence = adapted.external_evidence || [];
        externalVisualEvidence = adapted.external_visual_evidence || [];
      }

      // Enrich evidence packs with external evidence
      let enrichedPacks = rawfactResult?.evidence_packs || [];
      if (externalEvidence.length > 0) {
        const { attachExternalEvidenceToPacks } = await import("../lib/pipeline/synthesis/externalEvidence.js");
        enrichedPacks = attachExternalEvidenceToPacks(enrichedPacks, externalEvidence, externalVisualEvidence);
      }

      const vizSpecs = analyticsResult?.visualization_specs || [];
      const analysisSources = analyticsResult?.analytics_sources || rawfactResult?.rawfact_sources || passedL4Sources;
      const aggregates = analyticsResult?.aggregates || {};

      const { runAnalysisLayer } = await import("../lib/pipeline/analysis/runAnalysisLayer.js");
      console.log(`  Running L6 analysis on ${analysisSources.length} sources...`);

      const analysisResult = await runAnalysisLayer(analysisSources, aggregates, {
        skipLlm: NO_LLM,
        evidencePacks:   enrichedPacks,
        analytics_evidence: analyticsResult?.analytics_evidence || [],
        derived_metrics: analyticsResult?.derived_metrics || {},
        vizSpecs,
        analyticsResult: analyticsResult || {},
        externalEvidence,
        visualEvidence: externalVisualEvidence,
        webEvidence: webEvidenceResult,
      });

      categoryAnalyses = analysisResult.category_analyses || [];
      console.log(`  L6: ${categoryAnalyses.length} categories, ${categoryAnalyses.reduce((n,a) => n + (a.judgments || a.strategic_judgments || []).length, 0)} judgments`);

      // Cross-category synthesis
      try {
        const { runCrossCategorySynthesis } = await import("../lib/pipeline/synthesis/runCrossCategorySynthesis.js");
        const { buildRunCorpusAudit } = await import("../lib/pipeline/analysis/runCorpusAudit.js");
        const corpusAudit = buildRunCorpusAudit(categoryAnalyses, analysisSources);
        crossCatSynthesis = await runCrossCategorySynthesis(categoryAnalyses, {
          skipLlm: NO_LLM,
          corpusAudit,
        });
        console.log(`  L6 cross-category: ${(crossCatSynthesis?.patterns || []).length} patterns`);
      } catch (err) {
        logWarn("L6", `Cross-category synthesis failed: ${err.message}`);
      }

      // Build dashboard intel
      try {
        const { buildDashboardIntelPackage } = await import("../lib/pipeline/analysis/buildDashboardIntelPackage.js");
        const allJudgments = categoryAnalyses.flatMap(ca =>
          (ca.judgments || ca.strategic_judgments || []).map(j => ({ ...j, category: ca.category }))
        );
        dashboardObjects = buildDashboardIntelPackage(allJudgments, analysisSources) || [];
        console.log(`  Dashboard: ${dashboardObjects.filter(d => d.approved_for_dashboard).length}/${dashboardObjects.length} approved`);
      } catch (err) {
        logWarn("L6", `buildDashboardIntelPackage failed: ${err.message}`);
        dashboardObjects = [];
      }

      // Build synthesis result for L7
      synthesisResult = {
        feed_sources: analysisSources,
        rawfact: rawfactResult || {},
        analytics: analyticsResult || {},
        fused_dossiers: analysisResult.dossiers || [],
        category_analyses: categoryAnalyses,
        cross_category_synthesis: crossCatSynthesis || {},
        presentation_packet: analysisResult.analysis_package || {},
        evidence_packs: enrichedPacks,
        dossiers: analysisResult.dossiers || [],
        evidence_inventory: [],
        category_evidence_summary: {},
        unsupported_claims: [],
        manual_review_items: [],
        viewpoints: [],
        counts: {
          total_sources: analysisSources.length,
          evidence_cards: (rawfactResult?.counts?.evidence_items_total || 0),
          insights: categoryAnalyses.reduce((n, a) => n + (a.judgments || a.strategic_judgments || []).length, 0),
        },
      };

      saveCheckpoint("L6", {
        categories_analyzed: categoryAnalyses.length,
        total_judgments: categoryAnalyses.reduce((n, a) => n + (a.judgments || a.strategic_judgments || []).length, 0),
        approved_judgments: categoryAnalyses.reduce((n, a) =>
          n + (a.judgments || a.strategic_judgments || []).filter(j => !j.blocked && j.approved_for_dashboard !== false).length, 0),
        blocked_claims: categoryAnalyses.reduce((n, a) => n + (a.blocked_claims || []).length, 0),
        dashboard_objects: dashboardObjects.length,
        dashboard_approved: dashboardObjects.filter(d => d.approved_for_dashboard).length,
        category_summary: categoryAnalyses.map(a => ({
          category: a.category,
          assessment_status: a.assessment_status,
          judgment_count: (a.judgments || a.strategic_judgments || []).length,
          evidence_count: (a.evidence_ids || a.supporting_evidence_ids || []).length,
          blocked_claims: (a.blocked_claims || []).length,
        })),
        category_analyses: categoryAnalyses,
      });

      const { reportL6, reportDashboard } = await import("../lib/pipeline/debug/deepReporter.js");
      saveReport("06_L6_analysis_deep.md", reportL6(RUN_ID, categoryAnalyses, crossCatSynthesis));
      saveReport("10_dashboard_intelligence_deep.md", reportDashboard(RUN_ID, dashboardObjects));
    } catch (err) {
      logError("L6", "analysis_failed", `Layer 6 analysis failed: ${err.message}`, { stack: err.stack });
      synthesisResult = {
        feed_sources: passedL4Sources,
        category_analyses: [], fused_dossiers: [], evidence_packs: [],
        dossiers: [], viewpoints: [], analytics: {}, rawfact: {}, counts: {},
      };
    }
  }

  // ─── L7+L8: Slides ──────────────────────────────────────────────────────────
  if (shouldRun("L7") || shouldRun("L8")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYERS 7+8 — Slide Planning & Narrative Generation`);
    console.log(`${"─".repeat(64)}`);

    if (!synthesisResult) {
      logWarn("L7", "No synthesis result available — skipping slides layer");
    } else {
      try {
        const { runSlidesLayer } = await import("../lib/pipeline/slides/slidesLayer.js");
        console.log(`  Running slides layer...`);
        deckResult = await runSlidesLayer(synthesisResult, {
          skipLlm:       NO_LLM,
          exportFormat:  "json",
          detailedNotes: !NO_LLM,
          onProgress:    (step, msg) => console.log(`    [${step}] ${msg}`),
        });
        console.log(`  L7/L8: ${(deckResult?.slide_plan || []).length} planned, ${(deckResult?.slides || []).length} generated`);

        saveCheckpoint("L7", {
          slide_plan_count: (deckResult?.slide_plan || []).length,
          slide_type_dist: countBy(deckResult?.slide_plan || [], "slide_type"),
          sample_plan: (deckResult?.slide_plan || []).slice(0, 5).map(s => ({
            slide_number: s.slide_number,
            slide_type: s.slide_type,
            argument: (s.slide_argument || s.argument || "").slice(0, 100),
          })),
        });

        saveCheckpoint("L8", {
          slides_generated: (deckResult?.slides || []).length,
          evidence_callouts_used: deckResult?.counts?.evidence_callouts_used || 0,
          content_qa_pass: deckResult?.content_qa_report?.overall_pass,
          content_qa_blocking: deckResult?.content_qa_report?.slides_blocking || 0,
          notes_qa_pass: deckResult?.notes_qa_report?.overall_pass,
          slide_type_dist: countBy(deckResult?.slides || [], "slide_type"),
          sample_slides: (deckResult?.slides || []).slice(0, 3).map(s => ({
            slide_number: s.slide_number,
            slide_type: s.slide_type,
            headline: (s.headline || s.title || "").slice(0, 80),
            bullet_count: (s.bullets || []).length,
            citation_count: (s.citations || []).length,
          })),
        });

        const { reportL7, reportL8 } = await import("../lib/pipeline/debug/deepReporter.js");
        saveReport("07_L7_deck_planning_deep.md", reportL7(RUN_ID, deckResult?.slide_plan, deckResult));
        saveReport("08_L8_narrative_generation_deep.md", reportL8(RUN_ID, deckResult?.slides, deckResult));
      } catch (err) {
        logError("L7", "slides_failed", `Slides layer failed: ${err.message}`, { stack: err.stack });
        deckResult = { slides: [], slide_plan: [], counts: {}, deck_version: "unknown" };
      }
    }
  }

  // ─── L9: QA ─────────────────────────────────────────────────────────────────
  if (shouldRun("L9")) {
    console.log(`\n${"─".repeat(64)}`);
    console.log(`  LAYER 9 — Export QA`);
    console.log(`${"─".repeat(64)}`);

    if (!deckResult || !synthesisResult) {
      logWarn("L9", "No deck/synthesis result available — skipping QA layer");
    } else {
      try {
        const { runQALayer } = await import("../lib/pipeline/qa/qaLayer.js");
        qaResult = await runQALayer(deckResult, synthesisResult);
        console.log(`  L9 QA: pass=${qaResult?.overall_pass} errors=${qaResult?.summary?.errors || 0} warnings=${qaResult?.summary?.warnings || 0}`);

        saveCheckpoint("L9", {
          overall_pass: qaResult?.overall_pass,
          error_count: qaResult?.summary?.errors || 0,
          warning_count: qaResult?.summary?.warnings || 0,
          top_issues: (qaResult?.summary?.all_issues || []).slice(0, 10).map(i => ({
            severity: i.severity,
            module: i.module,
            check: i.check,
            message: (i.message || "").slice(0, 200),
          })),
        });

        const { reportL9 } = await import("../lib/pipeline/debug/deepReporter.js");
        saveReport("09_L9_export_qa_deep.md", reportL9(RUN_ID, qaResult, deckResult));
      } catch (err) {
        logError("L9", "qa_failed", `L9 QA layer failed: ${err.message}`, { stack: err.stack });
        qaResult = { overall_pass: null, summary: { errors: 1 } };
      }
    }
  }

  // ─── Generate remaining reports ──────────────────────────────────────────────

  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Generating final reports`);
  console.log(`${"─".repeat(64)}`);

  const {
    reportErrors,
    reportRunSummary,
    reportReadme,
    reportAuditPack,
  } = await import("../lib/pipeline/debug/deepReporter.js");

  // Errors & warnings
  saveReport("11_errors_warnings_and_suspected_bugs.md", reportErrors(RUN_ID, errorLog));

  // Run summary
  saveReport("00_run_summary.md", reportRunSummary(RUN_ID, {
    sources,
    triageResults,
    taxonomyResults,
    rawfactResult,
    analyticsResult,
    categoryAnalyses,
    dashboardObjects,
    deckResult,
    qaResult,
    errorLog,
    elapsed: elapsed(),
    opts: { skipLlm: NO_LLM, webEvidence: reportState.webEvidenceEnabled },
  }));

  // README
  saveReport("00_README_FOR_AUDIT.md", reportReadme(RUN_ID, {
    limit: LIMIT,
    sourceMethod: reportState.sourceMethod,
    noLlm: NO_LLM,
    fromLayer: FROM_LAYER,
    toLayer: TO_LAYER,
    webEvidence: reportState.webEvidenceEnabled,
  }));

  // Audit pack
  saveReport("AUDIT_PACK.md", reportAuditPack(RUN_ID, {
    sources,
    triageResults,
    taxonomyResults,
    rawfactResult,
    categoryAnalyses,
    dashboardObjects,
    deckResult,
    qaResult,
    errorLog,
    elapsed: elapsed(),
  }));

  // Also write a markdown deck export if available
  if (deckResult?.slides?.length > 0) {
    try {
      const { exportMarkdownDeck } = await import("../lib/pipeline/slides/exportMarkdownDeck.js");
      const md = exportMarkdownDeck(deckResult, { includeAppendix: true });
      save("analysis-output.md", md);
    } catch (err) {
      logWarn("export", `Could not export markdown deck: ${err.message}`);
    }
  }

  // ─── Pass/fail criteria check ─────────────────────────────────────────────
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Pass/Fail Criteria`);
  console.log(`${"─".repeat(64)}`);

  const qaIssues = qaResult?.summary?.all_issues || [];
  const criteria = [
    { name: "No unresolved evidence_id in exported slides",   pass: !qaIssues.some(i => i.check === "unresolved_evidence_id") },
    { name: "No cited URLs missing from source registry",      pass: !qaIssues.some(i => i.check === "missing_source_url") },
    { name: "No approved judgment without evidence_ids",       pass: !categoryAnalyses.some(a => (a.judgments || a.strategic_judgments || []).some(j => !j.blocked && j.approved_for_dashboard !== false && !(j.evidence_for || j.supporting_evidence_ids || []).length)) },
    { name: "No approved judgment is summary_only",            pass: !qaIssues.some(i => i.check === "summary_only_judgment") },
    { name: "No fabricated IDs in validation",                 pass: !qaIssues.some(i => i.check === "fabricated_id") },
    { name: "No pipeline layer errored out",                   pass: !errorLog.some(e => e.severity === "error") },
  ];

  for (const c of criteria) {
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`);
  }

  const allPass = criteria.every(c => c.pass);
  console.log(`\n  Overall: ${allPass ? "PASS" : "FAIL — see errors above"}`);

  // ─── Final summary ────────────────────────────────────────────────────────
  const totalElapsed = elapsed();
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Deep Debug Run Complete`);
  console.log(`  Run ID:    ${RUN_ID}`);
  console.log(`  Elapsed:   ${totalElapsed}s`);
  console.log(`  Errors:    ${errorLog.filter(e => e.severity === "error").length}`);
  console.log(`  Warnings:  ${errorLog.filter(e => e.severity === "warning").length}`);
  console.log(`${"═".repeat(64)}`);
  console.log(`\nKey output files:`);
  console.log(`  AUDIT_PACK.md       → debug/runs/${RUN_ID}/AUDIT_PACK.md`);
  console.log(`  Run summary         → debug/runs/${RUN_ID}/00_run_summary.md`);
  console.log(`  L6 analysis         → debug/runs/${RUN_ID}/06_L6_analysis_deep.md`);
  console.log(`  Dashboard intel     → debug/runs/${RUN_ID}/10_dashboard_intelligence_deep.md`);
  console.log(`  Errors & warnings   → debug/runs/${RUN_ID}/11_errors_warnings_and_suspected_bugs.md`);
  console.log(`\nFull output directory:`);
  console.log(`  ${RUN_DIR}\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countBy(arr, field) {
  const counts = {};
  for (const item of arr || []) {
    const k = (typeof field === "function" ? field(item) : item?.[field]) || "unknown";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function balanceSources(sources, limit) {
  if (sources.length <= limit) return sources;

  // Try to get a balanced mix of source types
  const byType = {};
  for (const s of sources) {
    const t = s.source_type || "unknown";
    if (!byType[t]) byType[t] = [];
    byType[t].push(s);
  }

  const types = Object.keys(byType);
  const perType = Math.ceil(limit / Math.max(types.length, 1));
  const selected = [];

  for (const type of types) {
    selected.push(...byType[type].slice(0, perType));
    if (selected.length >= limit) break;
  }

  // Fill remaining slots with any sources not yet selected
  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(s => s.id));
    for (const s of sources) {
      if (!selectedIds.has(s.id)) {
        selected.push(s);
        if (selected.length >= limit) break;
      }
    }
  }

  return selected.slice(0, limit);
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`\nFATAL ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
