#!/usr/bin/env node
/**
 * Pipeline Smoke Test — 5 sources
 *
 * Runs the full pipeline on 5 hardcoded fixture sources (no DB required).
 * Writes checkpoints + a readable audit report to debug/runs/<run_id>/.
 *
 * Usage:
 *   node scripts/smokeTest.js              # full run with LLM
 *   node scripts/smokeTest.js --no-llm     # deterministic stubs only
 *   node scripts/smokeTest.js --no-slides  # skip deck generation
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args   = process.argv.slice(2);
const NO_LLM    = args.includes("--no-llm");
const NO_SLIDES = args.includes("--no-slides");

// ── 5 fixture sources — one per major scenario ────────────────────────────────

// Source IDs must differ in their first 8 characters — extractEvidence uses
// source.id.slice(0,8) as the evidence_id prefix. "fixture-00X" all truncate
// to "fixture-", collapsing all evidence into the same ID slots.
const FIXTURES = [
  {
    id: "smk-msj-a",
    title: "Many-Shot Jailbreaking: Overcoming Safety Training in Large Language Models",
    publisher: "Anthropic",
    url: "https://www.anthropic.com/research/many-shot-jailbreaking",
    source_type: "research_paper",
    trust_tier: "primary",
    date_published: "2024-04-02",
    main_category: "llm_threats",
    full_text: `We present many-shot jailbreaking (MSJ), a simple jailbreaking technique that exploits a fundamental feature of LLMs: the long-context window. By including numerous (100+) demonstrations of undesirable behavior in the prompt, we can jailbreak frontier LLMs with remarkably high success rates.

Our experiments show that success rates scale predictably with the number of demonstrations: from near-zero with 1-5 shots to above 80% with 256 shots. This holds across Claude 3 Opus, GPT-4, and Llama-3 70B. The attack requires no fine-tuning, no gradient access, and no special access to model internals.

Key findings:
- 256-shot MSJ achieves 83% success against Claude 3 Opus on harmful request generation
- The technique exploits in-context learning — the model learns to comply with harmful requests from examples in-context
- No defence we tested was reliably effective: RLHF, constitutional AI, and system prompts all failed above 128 shots
- Attack cost is low: MSJ can be automated for <$0.05 per successful jailbreak with current API pricing

We recommend the following mitigations: (1) monitoring for anomalously long prompts with repeated structure, (2) per-chunk context processing rather than full long-context, (3) research into context-aware safety training.`,
  },

  {
    id: "smk-mcp-b",
    title: "CISA Alert AA26-001A: Active Exploitation of MCP Server Vulnerabilities in Agentic AI Pipelines",
    publisher: "CISA",
    url: "https://www.cisa.gov/news-events/alerts/2026/01/15/aa26-001a",
    source_type: "government_advisory",
    trust_tier: "primary",
    date_published: "2026-01-15",
    main_category: "agentic_ai_threats",
    full_text: `CISA, NSA, and NCSC are releasing this joint advisory to warn organizations that threat actors are actively exploiting vulnerabilities in Model Context Protocol (MCP) server implementations.

OVERVIEW:
Since November 2025, multiple threat actors—including groups assessed to be state-sponsored—have been observed exploiting misconfigured and vulnerable MCP servers to:
1. Exfiltrate API credentials and secrets passed through agent tool calls
2. Inject malicious instructions into agent memory systems
3. Achieve lateral movement within enterprise environments by pivoting from compromised agent identities

AFFECTED PRODUCTS:
- LangChain MCP integrations (versions < 0.3.15)
- Anthropic MCP SDK for Python (versions < 1.2.0)
- Custom MCP server implementations without signature verification

OBSERVED TECHNIQUES:
Threat actor TTPs include: (1) registering malicious MCP servers with the same namespace as legitimate tools; (2) exploiting the lack of TLS verification in MCP tool discovery; (3) injecting tool-call responses with follow-on prompt injection payloads.

INCIDENT DATA:
CISA has coordinated response to 34 confirmed incidents across critical infrastructure sectors. Average dwell time before detection: 18 days. In 12 incidents, threat actors successfully exfiltrated API keys granting access to cloud production environments.

MITIGATIONS:
Organizations should immediately: (1) audit all deployed MCP servers against the published allowlist; (2) enable MCP server identity verification; (3) restrict agent credential scope to least-privilege.`,
  },

  {
    id: "smk-psh-c",
    title: "GPT-4 Enables Autonomous Spear-Phishing at Scale: A Controlled Study",
    publisher: "IEEE Security & Privacy",
    url: "https://ieeexplore.ieee.org/document/fixture-003",
    source_type: "research_paper",
    trust_tier: "high",
    date_published: "2025-11-20",
    main_category: "ai_enabled_threats",
    full_text: `We conducted a controlled study comparing AI-assisted spear-phishing against traditional template-based phishing across 600 simulated targets. Our system used GPT-4o to generate personalized phishing emails by ingesting LinkedIn profiles, recent tweets, and company press releases for each target.

RESULTS:
- AI-personalized emails achieved 54% click-through rate vs 12% for template-based phishing (4.5× improvement)
- Credential submission rate: 31% AI-personalized vs 8% template-based (3.9× improvement)
- Detection by email security filters: 14% AI vs 41% template (AI emails bypass filters more often)
- Cost analysis: fully automated AI campaign costs approximately $0.08 per target vs $2.50 manual per-target cost

We then tested this system against red-team environments with AI-aware email security:
- Human reviewers correctly identified AI emails 38% of the time (vs 71% for obvious template phishing)
- AI security tools identified AI-generated emails 52% of the time

The results demonstrate that GPT-4-class LLMs substantially lower the skill barrier for effective spear-phishing. A motivated attacker can achieve success rates previously requiring significant social engineering expertise with minimal effort.

DISCLOSURE: Conducted under IRB approval with fully synthetic target identities. No real individuals were targeted.`,
  },

  {
    id: "smk-ext-d",
    title: "ShadowModel: Extracting GPT-4 with 10M Queries for Under $2,000",
    publisher: "arXiv",
    url: "https://arxiv.org/abs/2411.fixture-004",
    source_type: "research_paper",
    trust_tier: "high",
    date_published: "2024-11-08",
    main_category: "traditional_ai_threats",
    full_text: `We present ShadowModel, a model extraction attack that produces a functional approximate of GPT-4 using 10M queries at a total cost of approximately $1,847 in API fees. The resulting shadow model matches GPT-4's task performance on 89% of tested benchmarks within ±3% accuracy.

METHODOLOGY:
We use a two-phase extraction approach: (1) task-specific seed generation using structured prompt templates across 47 task categories; (2) iterative distillation where shadow model outputs are scored against target model outputs and used to generate adversarial training examples.

THREAT IMPLICATIONS:
- The extracted model provides attacker with offline access equivalent to GPT-4 without API logging
- Shadow model can be fine-tuned for specific malicious tasks without OpenAI's content policy enforcement
- IP and training data can be partially reconstructed from the shadow model's memorized training examples
- Total extraction completed in 11 days using commodity GPU infrastructure

DEFENCE ANALYSIS:
Current defences are largely ineffective at this extraction scale. Query rate limiting delayed but did not prevent extraction (attacker used 200 distinct API keys). Canary tokens were detected by the attacker and systematically avoided.

OUTPUT MODEL CAPABILITIES:
The extracted model retains >90% of GPT-4's coding ability, >85% of reasoning ability, and >95% of language generation quality. It lacks GPT-4's most recent knowledge cutoff data but otherwise functions as a capable offline substitute.`,
  },

  {
    id: "smk-wgp-e",
    title: "AI-Accelerated Vulnerability Discovery: WormGPT Successor Tools in Criminal Forums",
    publisher: "Recorded Future",
    url: "https://www.recordedfuture.com/research/fixture-005",
    source_type: "threat_intelligence_report",
    trust_tier: "high",
    date_published: "2026-02-28",
    main_category: "ai_enabled_threats",
    full_text: `Recorded Future Intelligence Group has identified three successor tools to WormGPT circulating in closed criminal forums, with demonstrated capabilities for autonomous vulnerability discovery and exploit generation.

TOOLS IDENTIFIED:
1. DarkMind-v2: LLM fine-tuned on exploit codebases and CVE write-ups. Observed generating working PoC exploits for CVE-2025-series vulnerabilities within hours of NVD publication.

2. AutoPwn: Agent-based system combining LLM reasoning with automated fuzzing and exploitation frameworks. Forum testimonials claim 73% success rate on "known vulnerable" targets in penetration testing use cases.

3. VulnGPT-Pro: Specialized for vulnerability research; can analyze closed-source binaries for vulnerability patterns. Pricing: $150/month subscription in one observed criminal marketplace.

OBSERVED USES:
- Members of criminal forums reporting using these tools to: (1) rapidly analyze newly published CVEs for exploitability; (2) generate phishing lures referencing zero-day disclosures; (3) automate scanning for unpatched systems at scale.
- Timeframe between CVE publication and functional exploit availability is decreasing: pre-AI baseline was 7-14 days; forum discussions suggest 24-48 hours with AI assistance for common vulnerability classes.

ACTOR ASSESSMENT:
These tools are primarily observed being used by mid-tier financially motivated threat actors rather than APT groups (who have comparable capabilities through other means). They represent a significant capability uplift for actors who previously lacked exploit development skills.`,
  },
];

// ── Output setup ──────────────────────────────────────────────────────────────

const RUN_ID  = `smoke-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const OUT_DIR = path.join(ROOT, "debug", "runs", RUN_ID);
const CK_DIR  = path.join(OUT_DIR, "checkpoints");
fs.mkdirSync(CK_DIR, { recursive: true });

function save(name, data) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return p;
}

function banner(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

// ── Audit report generator ────────────────────────────────────────────────────

function buildAuditReport(result, checkpoints) {
  const lines = [];
  const t = s => String(s || "").slice(0, 150);

  lines.push(`# Smoke Test — Audit Report`);
  lines.push(`\n**Run ID**: \`${result.run_id}\`  `);
  lines.push(`**Mode**: ${NO_LLM ? "deterministic (--no-llm)" : "live LLM"}  `);
  lines.push(`**Elapsed**: ${result.elapsed_seconds}s  `);
  lines.push(`**Date**: ${new Date().toISOString()}\n`);

  // ── Layer 1: Source loading ──
  lines.push(`\n## L1 — Source Loading\n`);
  lines.push(`- **Fixtures loaded**: ${FIXTURES.length}`);
  lines.push(`| # | Title | Type | Trust | Category |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (let i = 0; i < FIXTURES.length; i++) {
    const s = FIXTURES[i];
    lines.push(`| ${i+1} | ${t(s.title, 50)} | ${s.source_type} | ${s.trust_tier} | ${s.main_category} |`);
  }

  // ── Layer 2-4: Understanding ──
  lines.push(`\n## L2–L4 — Understanding (merged)\n`);
  const ck_understand = checkpoints.understand || {};
  lines.push(`- **Total**: ${ck_understand.total || 0}`);
  lines.push(`- **Relevant**: ${ck_understand.relevant || 0}`);
  lines.push(`- **Discarded**: ${ck_understand.discarded || 0}`);
  if (ck_understand.discarded > 0) {
    lines.push(`\n**Discarded sources:**`);
    for (const d of ck_understand.discarded_sample || []) {
      lines.push(`- \`${d.id}\` — ${t(d.title, 60)}: _${t(d.reason, 100)}_`);
    }
  }
  lines.push(`\n**Category assignments:**`);
  for (const [cat, n] of Object.entries(ck_understand.by_category || {})) {
    lines.push(`- ${cat}: ${n}`);
  }

  lines.push(`\n**Per-source understanding detail:**`);
  for (const s of result.relevant_sources || []) {
    lines.push(`\n### ${t(s.title, 80)}`);
    lines.push(`- **category**: ${s.category}`);
    lines.push(`- **primary_tags**: ${(s.primary_tags || []).join(", ") || "none"}`);
    lines.push(`- **sub_techniques**: ${(s.sub_techniques || []).join(", ") || "none"}`);
    lines.push(`- **source_type**: ${s.source_type} | **trust_tier**: ${s.trust_tier}`);
    lines.push(`- **key_entities**: ${(s.key_entities || []).slice(0,6).join(", ") || "none"}`);
    lines.push(`- **main_claims** (${(s.main_claims||[]).length}):`);
    for (const c of (s.main_claims || []).slice(0, 3)) {
      lines.push(`  - ${t(c, 120)}`);
    }
    lines.push(`- **short_summary**: ${t(s.short_summary, 200)}`);

    // Audit check
    const issues = [];
    if (!s.primary_tags?.length) issues.push("NO primary_tags assigned");
    if (!s.key_entities?.length) issues.push("NO key_entities extracted");
    if (!s.short_summary)        issues.push("NO short_summary");
    if (s.category === "unclear_or_adjacent" && s.relevant) issues.push("relevant=true but unclear_or_adjacent category");
    lines.push(issues.length ? `- **⚠ AUDIT**: ${issues.join(" | ")}` : `- **✓ AUDIT**: looks sane`);
  }

  // ── L5: Evidence ──
  lines.push(`\n## L5 — Evidence Extraction\n`);
  const ck_ev = checkpoints.evidence || {};
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total extracted | ${ck_ev.counts?.total_extracted || 0} |`);
  lines.push(`| After dedup | ${ck_ev.counts?.after_dedup || 0} |`);
  lines.push(`| Clusters | ${ck_ev.counts?.clusters || 0} |`);
  lines.push(`| Strong (grounded+high) | ${ck_ev.counts?.strong || 0} |`);
  lines.push(`| Usable | ${ck_ev.counts?.usable || 0} |`);
  lines.push(`| Context only | ${ck_ev.counts?.context || 0} |`);

  lines.push(`\n**Evidence packs by category:**`);
  for (const p of ck_ev.pack_sizes || []) {
    lines.push(`- **${p.category}**: strong=${p.strong} usable=${p.usable} context=${p.context}`);
  }

  lines.push(`\n**Evidence item sample (first 10 strong/usable items):**`);
  const sampleItems = (result.evidence_items || [])
    .filter(ei => ei.is_cluster_rep && (ei.quote_grounded || ei.specificity !== "low"))
    .slice(0, 10);
  for (const ei of sampleItems) {
    lines.push(`\n#### \`${ei.evidence_id}\``);
    lines.push(`- **type**: ${ei.evidence_type} | **specificity**: ${ei.specificity} | **grounded**: ${ei.quote_grounded}`);
    lines.push(`- **fact**: ${t(ei.fact, 200)}`);
    lines.push(`- **quote**: _"${t(ei.quote, 150)}"_`);
    lines.push(`- **tags**: ${(ei.technique_tags||[]).join(", ") || "none"}`);
    lines.push(`- **entities**: ${(ei.entities||[]).slice(0,5).join(", ") || "none"}`);
    lines.push(`- **source**: ${t(ei.source_title, 60)} [${ei.trust_tier}]`);

    // Audit checks
    const evIssues = [];
    if (!ei.quote || ei.quote.length < 10) evIssues.push("quote too short");
    if (!ei.quote_grounded && ei.specificity === "high") evIssues.push("high specificity but not grounded — check");
    if (!ei.entities?.length) evIssues.push("no entities extracted");
    lines.push(evIssues.length ? `- **⚠ AUDIT**: ${evIssues.join(" | ")}` : `- **✓ AUDIT**: evidence looks solid`);
  }

  // ── L6: Synthesis ──
  lines.push(`\n## L6 — Strategic Analysis\n`);
  const ck_syn = checkpoints.synthesis || {};
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Judgments generated | ${ck_syn.total_judgments || 0} |`);
  lines.push(`| Judgments approved | ${ck_syn.approved_judgments || 0} |`);
  lines.push(`| Blocked | ${(ck_syn.total_judgments||0) - (ck_syn.approved_judgments||0)} |`);
  lines.push(`| Cross-category patterns | ${ck_syn.cross_cat_patterns || 0} |`);

  for (const ca of result.category_analyses || []) {
    const approved = (ca.judgments || []).filter(j => !j.blocked);
    const blocked  = (ca.judgments || []).filter(j => j.blocked);

    lines.push(`\n### ${ca.category.replace(/_/g, " ").toUpperCase()}`);
    lines.push(`- **status**: ${ca.assessment_status}`);
    lines.push(`- **coverage**: ${t(ca.coverage_assessment, 150)}`);
    if (ca.evidence_gaps?.length) {
      lines.push(`- **evidence gaps**: ${ca.evidence_gaps.join("; ")}`);
    }

    for (const j of approved) {
      lines.push(`\n**APPROVED Judgment** \`${j.judgment_id?.slice(0,8)}\``);
      lines.push(`> ${t(j.judgment, 300)}`);
      lines.push(`- **what_changed**: ${t(j.what_changed, 150)}`);
      lines.push(`- **why_this_matters**: ${t(j.why_this_matters, 150)}`);
      lines.push(`- **confidence**: ${j.confidence}`);
      lines.push(`- **short_takeaway**: _${t(j.short_takeaway, 80)}_`);
      lines.push(`- **evidence_for** (${j.evidence_for?.length || 0}): ${(j.evidence_for||[]).join(", ")}`);
      lines.push(`- **caveats**: ${(j.caveats||[]).join("; ") || "none"}`);
      if (j.recommended_action) lines.push(`- **action**: ${t(j.recommended_action, 120)}`);

      // Audit checks
      const jIssues = [];
      if (!j.evidence_for?.length)       jIssues.push("⚠ NO evidence_for — should have been blocked");
      if (!j.what_changed || j.what_changed.length < 20) jIssues.push("⚠ what_changed too short — may be descriptive");
      if (!j.caveats?.length && j.confidence !== "high") jIssues.push("⚠ no caveats on non-high confidence");
      if (!j.short_takeaway)             jIssues.push("⚠ no short_takeaway");
      lines.push(jIssues.length ? jIssues.join("\n") : `- **✓ AUDIT**: judgment looks analytical`);
    }

    for (const j of blocked) {
      lines.push(`\n**BLOCKED Judgment** \`${j.judgment_id?.slice(0,8)}\``);
      lines.push(`> ${t(j.judgment, 200)}`);
      lines.push(`- **blocked because**: ${j.qa_issues?.join(", ") || "unknown"}`);
      // Audit check: was the block correct?
      const blockCorrect = j.qa_issues?.includes("no_evidence_cited") || j.qa_issues?.includes("descriptive_not_analytical");
      lines.push(blockCorrect ? `- **✓ AUDIT**: block looks correct` : `- **⚠ AUDIT**: block reason unclear — review`);
    }
  }

  // Cross-category
  if (result.cross_category?.patterns?.length > 0) {
    lines.push(`\n### Cross-Category Patterns\n`);
    for (const p of result.cross_category.patterns) {
      lines.push(`**${p.pattern}**`);
      lines.push(`${p.description}`);
      lines.push(`- Implication: ${t(p.implication, 150)}`);
      lines.push(`- Categories: ${(p.categories||[]).join(", ")}`);
      lines.push("");
    }
  }

  // ── Dashboard ──
  lines.push(`\n## Dashboard State\n`);
  const ds = result.dashboard_state;
  if (!ds) {
    lines.push(`_Dashboard state not generated._`);
  } else {
    for (const card of ds.category_cards || []) {
      lines.push(`**${card.display_name}** — trend: \`${card.trend_status}\` | sources: ${card.source_count} | evidence: ${card.evidence_count} | judgments: ${card.judgment_count}`);
      if (card.top_judgment) {
        lines.push(`  → _${t(card.top_judgment.short_takeaway, 80)}_ (${card.top_judgment.confidence})`);
      }
    }

    lines.push(`\n**Recent evidence highlights**: ${ds.recent_evidence?.length || 0}`);
    lines.push(`**Tag trends**: ${ds.tag_trends?.slice(0,5).map(t => `${t.tag}(${t.count})`).join(", ")}`);
    lines.push(`**Cross-category patterns**: ${ds.patterns?.length || 0}`);
    lines.push(`**Corpus health**: ${ds.corpus_health?.total_sources} sources, ${ds.corpus_health?.date_range}`);
  }

  // ── Slides ──
  if (result.deck) {
    lines.push(`\n## L7-L8 — Presentation Deck\n`);
    lines.push(`- **Slides planned**: ${result.deck.slide_plan?.length || 0}`);
    lines.push(`- **Slides generated**: ${result.deck.slides?.length || 0}`);
    lines.push(`- **Traceability issues**: ${result.deck.traceability_issues?.length || 0}`);

    if (result.deck.traceability_issues?.length > 0) {
      lines.push(`\n**⚠ Traceability issues:**`);
      for (const issue of result.deck.traceability_issues) {
        lines.push(`- Slide ${issue.slide_number}: ${issue.type} — \`${issue.evidence_id || issue.citation}\``);
      }
    }

    lines.push(`\n**Slide sample (first 5 non-cover slides):**`);
    const slideSample = (result.deck.slides || []).filter(s => !["cover"].includes(s.type)).slice(0, 5);
    for (const slide of slideSample) {
      lines.push(`\n#### Slide ${slide.slide_number}: ${slide.type}`);
      lines.push(`**Headline**: ${t(slide.headline, 100)}`);
      for (const b of (slide.bullets || []).slice(0, 4)) {
        const evRef = b.evidence_id ? ` \`[${b.evidence_id}]\`` : "";
        lines.push(`- ${t(b.text, 100)}${evRef}`);
      }
      if (slide.speaker_notes) {
        lines.push(`> _${t(slide.speaker_notes.replace(/\n/g, " "), 200)}_`);
      }
      // Audit
      const slideIssues = [];
      if (!slide.headline)                                     slideIssues.push("no headline");
      if (!slide.bullets?.length && slide.type !== "cover")   slideIssues.push("no bullets");
      if (!slide.speaker_notes)                                slideIssues.push("no speaker notes");
      const unresolved = (slide.bullets||[]).filter(b => b.evidence_id && !b.evidence_id.startsWith("ev-"));
      if (unresolved.length > 0) slideIssues.push(`${unresolved.length} suspicious evidence IDs`);
      lines.push(slideIssues.length ? `**⚠ AUDIT**: ${slideIssues.join(" | ")}` : `**✓ AUDIT**: slide looks complete`);
    }
  }

  // ── Summary ──
  lines.push(`\n## Run Summary\n`);
  const c = result.counts || {};
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Sources input | ${c.sources_input} |`);
  lines.push(`| Sources relevant | ${c.sources_relevant} |`);
  lines.push(`| Sources discarded | ${c.sources_discarded} |`);
  lines.push(`| Evidence items (deduped) | ${c.evidence_items} |`);
  lines.push(`| Strong evidence | ${c.evidence_strong} |`);
  lines.push(`| Judgments generated | ${c.judgments_total} |`);
  lines.push(`| Judgments approved | ${c.judgments_approved} |`);
  lines.push(`| Cross-category patterns | ${c.patterns_found} |`);
  lines.push(`| Slides generated | ${c.slides_generated} |`);
  lines.push(`| Elapsed (s) | ${result.elapsed_seconds} |`);

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner(`Smoke Test — 5 fixtures | LLM: ${NO_LLM ? "OFF" : "ON"}`);
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`  Output: debug/runs/${RUN_ID}/\n`);

  const { runPipeline } = await import("../lib/pipeline/runPipeline.js");

  const checkpoints = {};
  const result = await runPipeline(FIXTURES, {
    skipLlm:    NO_LLM,
    skipSlides: NO_SLIDES,
    onProgress: () => {},
    onCheckpoint: async (layer, data) => {
      checkpoints[layer] = data;
      fs.writeFileSync(
        path.join(CK_DIR, `${layer}.json`),
        JSON.stringify(data, null, 2)
      );
      console.log(`  ✓ checkpoint: ${layer}.json`);
    },
  });

  // Write all outputs
  save("run-result.json",        { run_id: result.run_id, counts: result.counts, elapsed: result.elapsed_seconds });
  save("corpus-summary.json",    result.corpus_summary);
  save("category-analyses.json", result.category_analyses);
  save("cross-category.json",    result.cross_category);
  save("dashboard-state.json",   result.dashboard_state);
  save("evidence-items.json",    result.evidence_items);
  save("evidence-graph.json",    result.evidence_graph);
  if (result.deck) save("slide-deck.json", result.deck);

  // Build and write audit report
  const auditMd = buildAuditReport(result, checkpoints);
  save("AUDIT_REPORT.md", auditMd);

  banner("Smoke Test Complete");
  const c = result.counts;
  console.log(`  Sources: ${c.sources_relevant}/${c.sources_input} relevant`);
  console.log(`  Evidence: ${c.evidence_items} items (${c.evidence_strong} strong)`);
  console.log(`  Judgments: ${c.judgments_approved}/${c.judgments_total} approved`);
  console.log(`  Slides: ${c.slides_generated}`);
  console.log(`  Elapsed: ${result.elapsed_seconds}s`);
  console.log(`\n  Audit report: debug/runs/${RUN_ID}/AUDIT_REPORT.md`);
  console.log(`  Checkpoints:  debug/runs/${RUN_ID}/checkpoints/\n`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
