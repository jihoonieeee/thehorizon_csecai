#!/usr/bin/env node
/**
 * 20-Source End-to-End Pipeline Test
 *
 * Runs a controlled pipeline test with 20 curated sources covering all four
 * threat categories plus several expected-rejection candidates.
 *
 * Source selection:
 *   - 3  primary/government/vulnerability (high-trust AI-specific)
 *   - 5  high-trust research_finding / threat_intelligence
 *   - 7  medium security_blog (mix of relevant and borderline)
 *   - 5  expected rejections (marketing, off-topic, vendor fluff)
 *
 * Usage:
 *   node scripts/run20SourcePipelineTest.js [--no-llm] [--no-persist]
 *
 * Outputs to: docs/audits/test-runs/<run_id>/
 */
import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args    = process.argv.slice(2);
const NO_LLM  = args.includes("--no-llm");
const NO_PERSIST = args.includes("--no-persist");

// ── Run ID ───────────────────────────────────────────────────────────────────
const RUN_ID    = `test-20src-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const OUT_DIR   = path.join(ROOT, "docs/audits/test-runs", RUN_ID);
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`\n  Run ID:   ${RUN_ID}`);
console.log(`  Out dir:  ${OUT_DIR}`);
console.log(`  LLM:      ${NO_LLM ? "disabled (--no-llm)" : "enabled"}\n`);

function save(name, data) {
  const full = path.join(OUT_DIR, name);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(full, content);
  console.log(`  → docs/audits/test-runs/${RUN_ID}/${name}`);
  return full;
}

// ── 20 curated source IDs ────────────────────────────────────────────────────
// Rationale for each selection documented in the test audit.
const TEST_SOURCE_IDS = [
  // ── LLM THREATS — arXiv high-trust research (expect: pass) ───────────────────
  "0b31c23765e9962a2a62e6b7bdd78c86747b", // high | arXiv | Revisiting JBShield: jailbreak + repr-level defence
  "908eadfd92a579250fabc7e510a28ccbf9ca", // high | arXiv | SRTJ: Self-Evolving Rule-Driven LLM Jailbreaking
  "77e2b8df0bf2e6b358ba28c26d83989afc16", // high | arXiv | Indirect Prompt Injection in the Wild: empirical study

  // ── AGENTIC AI THREATS — arXiv research (expect: pass) ──────────────────────
  "8d176409a17af7130d7ef6255831e15bfcc0", // high | arXiv | Response-Path Attacks on LLM Agents
  "a5517941ddfb26fc862bda02e1fb7115c54d", // high | arXiv | Security Attack/Defense for Autonomous Agent Frameworks
  "78cf1bbe414dda38d73d1df82769567a0b1d", // high | arXiv | Attack Detection in LLM Agent Tool-Call Traffic

  // ── TRADITIONAL AI THREATS — arXiv adversarial ML (expect: pass) ─────────────
  "662671165adfcfeb9b614194dab50c52247c", // high | arXiv | LocalAlign: Prompt Injection Defence
  "d13e7e598ac2da2f42da74b803edac32cc12", // high | arXiv | Manifold Detours for Black-Box Adversarial Attacks
  "27870879434904650fc8a5adfabfb321445d", // primary | research_finding | PRC influence ops targeting AI debates

  // ── AI-ENABLED THREATS — deepfake + phishing (expect: pass) ─────────────────
  "55ecb61a67265e38e859c38383ff6fdd9e9a", // high | arXiv | Context-Aware Spear Phishing via Generative AI
  "21ab29a8130a236d77f12113cb5015aab0b5", // high | arXiv | Deepfake Detection in Social Media

  // ── GOVERNMENT / VULNERABILITY — concrete CVEs (expect: pass or review) ──────
  "efdaae8518c88b1dc83967c291dfc9634076", // medium | exploit_disclosure | Unpatched Langflow CVE-2026-5027 RCE
  "a89bc9c1fa92195da1dc89765f97d831e86a", // medium | exploit_disclosure | Langflow path traversal exploited
  "2780c64461d6bd7dadd07dacebffcbe5a051", // primary | vulnerability | CVE-2026-46517 LMDeploy
  "e1231c5fe6ce32da35009a65584b1383104f", // medium | security_blog | CISA AI Patching Requirements

  // ── EXPECTED REJECTIONS — off-topic / marketing / no AI angle ────────────────
  "d190ef34362cdb3a75928657e7db7842cd09", // medium | security_blog | Cyera $12B valuation (marketing)
  "6f4957a9df8f3f9ffd736dc133b4040494b2", // medium | security_blog | Aryon Security $29M Series A (marketing)
  "ca9d30c481587a7fd9879dc68e882829ac1a", // high | threat_intelligence | 2026 FIFA World Cup (off-topic)
  "f3b95abed492118d456c426bafe7bb43b1d7", // medium | security_blog | Miasma worm source leaked (no AI angle)
  "490aa96a54bc431f1a1d73b5c17de1868463", // medium | security_blog | Oracle PeopleSoft ShinyHunters (no AI)
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  // Step 1: Load sources from DB
  console.log("[1/7] Loading 20 sources from Supabase...");
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const { data: sources, error } = await supabase
    .from("sources")
    .select("*")
    .in("id", TEST_SOURCE_IDS);
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }

  // Preserve selection order
  const orderedSources = TEST_SOURCE_IDS
    .map(id => sources.find(s => s.id === id))
    .filter(Boolean);

  console.log(`  Loaded: ${orderedSources.length}/${TEST_SOURCE_IDS.length} sources`);
  if (orderedSources.length < TEST_SOURCE_IDS.length) {
    const missing = TEST_SOURCE_IDS.filter(id => !sources.find(s => s.id === id));
    console.warn(`  Missing IDs: ${missing.join(", ")}`);
  }
  save("sources.json", orderedSources.map(s => ({
    id: s.id,
    title: s.title,
    url: s.url,
    publisher: s.publisher,
    source_type: s.source_type,
    trust_tier: s.trust_tier,
    date_published: s.date_published,
    ai_specificity_score: s.ai_specificity_score,
    has_text: !!(s.full_text?.length > 100 || s.clean_text?.length > 100),
  })));

  // Step 2: Layer 3 — validate + triage each source
  console.log("\n[2/7] Layer 3 — Validation triage...");
  const { validateAndTypeSource } = await import("../lib/pipeline/validation/validateAndTypeSource.js");
  const { prepopulateCircularRegistry } = await import("../lib/pipeline/validation/originTracking.js");
  prepopulateCircularRegistry(orderedSources);

  const triageResults = [];
  for (let i = 0; i < orderedSources.length; i++) {
    const s = orderedSources[i];
    process.stdout.write(`  [${i+1}/20] ${s.title?.slice(0, 50)}... `);
    try {
      const r = await validateAndTypeSource(s, { skipLlm: NO_LLM });
      // Merge result back onto source object
      Object.assign(s, r);
      triageResults.push({
        id: s.id,
        title: s.title?.slice(0, 70),
        layer3_status: s.layer3_status,
        validation_status: s.validation_status,
        source_type: s.source_type,
        content_quality: s.content_quality,
        ai_specificity_score: s.ai_specificity_score,
        relevance_tier: s.relevance_tier,
        relevance_path: s.relevance_path,
        ai_threat_focus: s.ai_threat_focus,
        source_quality_status: s.source_quality_status,
        origin_role: s.origin_role,
        independence_level: s.independence_level,
        publisher_class: s.publisher_class,
        downstream_route: s.downstream_route,
        final_validity_reason: s.final_validity_reason,
      });
      console.log(s.layer3_status || "?");
    } catch (err) {
      console.log("ERROR:", err.message);
      triageResults.push({ id: s.id, title: s.title?.slice(0,70), error: err.message });
    }
  }
  save("triage-results.json", triageResults);

  // Step 3: Layer 4 — taxonomy understanding (only on sources that passed triage)
  console.log("\n[3/7] Layer 4 — Taxonomy understanding...");
  const passedSources = orderedSources.filter(s => s.layer3_status !== "reject");
  const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
  const { classifySource }   = await import("../lib/pipeline/classify/classifyCategory.js");

  const taxonomyResults = [];
  for (let i = 0; i < passedSources.length; i++) {
    const s = passedSources[i];
    process.stdout.write(`  [${i+1}/${passedSources.length}] ${s.title?.slice(0, 50)}... `);
    try {
      const understood = await understandSource(s, { skipLlm: NO_LLM });
      Object.assign(s, understood);
      const classified = classifySource(s);
      Object.assign(s, classified);
      taxonomyResults.push({
        id: s.id,
        title: s.title?.slice(0, 70),
        primary_domain: s.primary_domain,
        main_category: s.main_category,
        primary_tags: (s.primary_tags || []).map(t => t.tag || t),
        taxonomy_version: s.taxonomy_version,
        taxonomy_validation_status: s.taxonomy_validation_status,
        ai_enabled: s.ai_enabled,
        classification_confidence: s.classification_confidence,
      });
      console.log(`${s.main_category || "unclear"} (${s.taxonomy_validation_status || "?"})`);
    } catch (err) {
      console.log("ERROR:", err.message);
      taxonomyResults.push({ id: s.id, error: err.message });
    }
  }
  save("taxonomy-results.json", taxonomyResults);

  // Step 4: Layer 5–6 — run synthesis
  console.log("\n[4/7] Layers 5–6 — Synthesis (evidence + analytics + viewpoints)...");
  const { runSynthesisLayer } = await import("../lib/pipeline/synthesis/synthesisLayer.js");
  let synthesisResult;
  try {
    // runSynthesisLayer(sources: object[], opts: {skipLlm})
    synthesisResult = await runSynthesisLayer(passedSources, { skipLlm: NO_LLM });
    console.log(`  Evidence sources: ${synthesisResult.feed_sources?.length}`);
    console.log(`  Fused dossiers:   ${Object.keys(synthesisResult.fused_dossiers || {}).length}`);
    console.log(`  Category analyses:${synthesisResult.category_analyses?.length ?? 0}`);
    const evPkts = (synthesisResult.feed_sources || []).reduce((n, s) => n + (s.evidence_items?.length || 0), 0);
    console.log(`  Evidence items:   ${evPkts}`);
  } catch (err) {
    console.error("  Synthesis error:", err.message);
    console.error(err.stack);
    synthesisResult = { feed_sources: passedSources, error: err.message };
  }

  // Step 5: Collect evidence packets
  console.log("\n[5/7] Collecting evidence packets...");
  const evidencePackets = (synthesisResult.feed_sources || []).flatMap(s =>
    (s.evidence_items || []).map(ei => {
      const td = ei.triage_data || {};
      return {
        source_id:         s.id,
        source_url:        s.url || s.final_url || null,
        source_title:      s.title?.slice(0, 60),
        source_type:       s.source_type,
        trust_tier:        s.trust_tier,
        publisher:         s.publisher,
        date_published:    s.date_published,
        evidence_id:       ei.evidence_id,
        evidence_type:     ei.evidence_type,
        evidence_strength: td.evidence_strength || ei.evidence_strength,
        admissibility:     td.admissibility    || ei.admissibility,
        observed_use:      td.observed_use     || ei.observed_use     || false,
        quote_entailment:  td.quote_entailment || null,
        // Correct field names (previously serialised as claim/quote — wrong)
        fact:              (ei.fact  || ei.claim  || "").slice(0, 200),
        source_quote:      (ei.source_quote || ei.supporting_quote || "").slice(0, 200),
        corrected_fact:    ei.fact_qa?.corrected_fact_text || null,
        limitations:       td.limitations || [],
        permitted_uses:    td.permitted_uses || [],
        second_model_qa:   ei.second_model_qa ? {
          flag: ei.second_model_qa.flag,
          note: ei.second_model_qa.note || null,
        } : null,
        analytical_hooks:  ei.analytical_hooks ? {
          what_changed:        ei.analytical_hooks.what_changed?.slice(0, 120) || null,
          why_this_may_matter: ei.analytical_hooks.why_this_may_matter?.slice(0, 120) || null,
          novelty_signal:      ei.analytical_hooks.novelty_signal?.slice(0, 80) || null,
        } : null,
      };
    })
  );
  console.log(`  Total packets: ${evidencePackets.length}`);
  save("evidence-packets.json", evidencePackets);

  // Step 6: Slides + QA
  console.log("\n[6/7] Layers 7–8 — Slides + QA...");
  const { runSlidesLayer }  = await import("../lib/pipeline/slides/slidesLayer.js");
  const { runQALayer }      = await import("../lib/pipeline/qa/qaLayer.js");
  const { exportMarkdownDeck } = await import("../lib/pipeline/slides/exportMarkdownDeck.js");
  const { buildQaReport, formatQaReportMarkdown } = await import("../lib/pipeline/qa/buildQaReport.js");

  let deckResult, qaResult;
  try {
    // runSlidesLayer(synthesisResult, opts)
    deckResult = await runSlidesLayer(synthesisResult, {
      skipLlm:       NO_LLM,
      exportFormat:  "json",
      detailedNotes: false,
      onProgress:    (step, msg) => console.log(`  [${step}] ${msg}`),
    });
    console.log(`  Slides: ${deckResult?.slides?.length ?? 0}`);
    console.log(`  Deck version: ${deckResult?.deck_version}`);
  } catch (err) {
    console.error("  Slides error:", err.message);
    deckResult = { error: err.message, slides: [], deck_version: "unknown" };
  }

  try {
    // runQALayer(deckResult, synthesisResult) — positional, not destructured
    qaResult = await runQALayer(deckResult, synthesisResult);
    console.log(`  QA pass: ${qaResult?.overall_pass}`);
  } catch (err) {
    console.error("  QA error:", err.message);
    qaResult = { error: err.message };
  }

  // Save QA results — overall_pass must be false if ANY QA layer fails.
  // qaResult.overall_pass covers qaLayer checks (citations, numbers, structure).
  // content_qa and notes_qa come from the slides layer; both must also pass.
  const contentQaPass = deckResult?.content_qa_report?.deck_qa_pass !== false;
  const notesQaPass   = deckResult?.notes_qa_report?.notes_qa_pass   !== false;
  const qaLayerPass   = qaResult?.overall_pass ?? false;
  const overallPass   = qaLayerPass && contentQaPass && notesQaPass;

  const qaReport = buildQaReport ? buildQaReport({ deckResult, qaResult }) : qaResult;
  save("qa-results.json", {
    overall_pass:       overallPass,
    overall_pass_detail: {
      qa_layer:    qaLayerPass,
      content_qa:  contentQaPass,
      notes_qa:    notesQaPass,
    },
    content_qa:      deckResult?.content_qa_report,
    notes_qa:        deckResult?.notes_qa_report,
    slide_count:     deckResult?.slides?.length ?? 0,
    claim_anchored:  deckResult?.counts?.claim_anchored_slides,
    blocking_issues: (deckResult?.content_qa_report?.slides_blocking ?? 0) + (deckResult?.notes_qa_report?.slides_blocking ?? 0),
  });

  // Generate markdown deck
  try {
    const md = exportMarkdownDeck(deckResult, { includeAppendix: true });
    save("analysis-output.md", md);
  } catch (err) {
    save("analysis-output.md", `# Error generating markdown\n\n${err.message}\n`);
  }

  // Step 7: Chatbot smoke test
  console.log("\n[7/7] Chatbot grounding smoke test...");
  const chatbotLines = [];
  try {
    const { GROUNDING_BY_ROUTE, assessOverclaim } = await import("../lib/agent/answerGrounding.js");
    const testQueries = [
      { q: "What is the most significant AI threat this week?", route: "analytical" },
      { q: "Are threat actors actively using LLMs in the wild?", route: "raw_sources" },
      { q: "How common is prompt injection in production?", route: "general" },
    ];
    for (const { q, route } of testQueries) {
      const grounding = GROUNDING_BY_ROUTE[route] || "unknown";
      // Build a minimal context from our evidence packets
      const ctx = {
        claims: evidencePackets.slice(0, 5).map(ep => ({
          source_type: ep.source_type,
          publisher:   ep.source_title,
          claim:       ep.claim,
        })),
      };
      const overclaim = assessOverclaim(q, ctx);
      chatbotLines.push(`## Query: "${q}"`);
      chatbotLines.push(`- Route: \`${route}\` → grounding: \`${grounding}\``);
      chatbotLines.push(`- Overclaim guard: ${JSON.stringify(overclaim)}`);
      chatbotLines.push("");
    }
    chatbotLines.push("## Evidence context used");
    chatbotLines.push(`- ${evidencePackets.length} packets available`);
    chatbotLines.push(`- Types: ${[...new Set(evidencePackets.map(e=>e.evidence_type))].join(", ") || "none"}`);
    chatbotLines.push(`- Strengths: ${[...new Set(evidencePackets.map(e=>e.evidence_strength))].join(", ") || "none"}`);
  } catch (err) {
    chatbotLines.push(`## Error: ${err.message}`);
  }
  save("chatbot-smoke-test.md", chatbotLines.join("\n"));

  // ── Run summary ───────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const accepted = triageResults.filter(r => r.layer3_status !== "reject" && !r.error).length;
  const rejected = triageResults.filter(r => r.layer3_status === "reject").length;
  const review   = triageResults.filter(r => r.layer3_status === "review").length;
  const errors   = triageResults.filter(r => r.error).length;

  const catCounts = {};
  for (const t of taxonomyResults.filter(r => r.main_category)) {
    catCounts[t.main_category] = (catCounts[t.main_category] || 0) + 1;
  }

  const summary = [
    `# 20-Source Pipeline Test — Run Summary`,
    ``,
    `**Run ID:** ${RUN_ID}`,
    `**Date:** ${new Date().toISOString().slice(0,19)}Z`,
    `**LLM mode:** ${NO_LLM ? "deterministic (--no-llm)" : "live (LLM_MODE=quality)"}`,
    `**Elapsed:** ${elapsed}s`,
    ``,
    `## Source Intake (Layer 3)`,
    `- Total sources:  20`,
    `- Loaded from DB: ${orderedSources.length}`,
    `- Passed:         ${accepted - review} (layer3_status=pass)`,
    `- Review:         ${review}  (layer3_status=review)`,
    `- Rejected:       ${rejected} (layer3_status=reject)`,
    `- Errors:         ${errors}`,
    ``,
    `## Layer 4 Taxonomy`,
    `- Sources processed: ${taxonomyResults.length}`,
    `- Category distribution:`,
    ...Object.entries(catCounts).map(([cat, n]) => `  - ${cat}: ${n}`),
    `  - unclear_or_adjacent / no category: ${taxonomyResults.filter(t=>!t.main_category).length}`,
    ``,
    `## Evidence & Synthesis`,
    `- Evidence packets extracted: ${evidencePackets.length}`,
    `- Fused dossiers: ${Object.keys(synthesisResult?.fused_dossiers || {}).length}`,
    `- Category analyses: ${synthesisResult?.category_analyses?.length ?? 0}`,
    ``,
    `## Slides & QA`,
    `- Slides generated: ${deckResult?.slides?.length ?? 0}`,
    `- Deck version: ${deckResult?.deck_version ?? "unknown"}`,
    `- QA overall pass: ${qaResult?.overall_pass ?? false}`,
    `- Blocking QA issues: ${(deckResult?.content_qa_report?.slides_blocking ?? 0) + (deckResult?.notes_qa_report?.slides_blocking ?? 0)}`,
    ``,
    `## Token Usage`,
    ``,
  ];

  try {
    const { getTokenUsageSummary } = await import("../lib/llm/llmRouter.js");
    const usage = getTokenUsageSummary?.();
    if (usage) {
      summary.push("```");
      summary.push(JSON.stringify(usage, null, 2));
      summary.push("```");
    } else {
      summary.push("Token usage not available.");
    }
  } catch {
    summary.push("Token usage module not available.");
  }

  save("run-summary.md", summary.join("\n"));

  console.log(`\n✅ Test complete in ${elapsed}s`);
  console.log(`   Accepted: ${accepted - review}  Review: ${review}  Rejected: ${rejected}  Errors: ${errors}`);
  console.log(`   Evidence packets: ${evidencePackets.length}`);
  console.log(`   Output: ${OUT_DIR}\n`);
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
