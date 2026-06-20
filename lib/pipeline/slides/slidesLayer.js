/**
 * L7/L8/L9 — Presentation Pipeline Orchestrator
 *
 * Produces the final presentation deck from runSynthesisLayer() output.
 * Contains no direct LLM calls — delegated to generateSlideContent.js (L7)
 * and generateSpeakerNotes.js (L8).
 *
 * ── PIPELINE STEPS ────────────────────────────────────────────────────────────
 * Step 1 (L7 planning) — planSlides() — deterministic, no LLM
 *   Builds a 30+ slide horizon-scan structure from category_analyses + dossiers.
 *   Prefers presentation_packet (synthesis-v8.0+) as content source.
 *
 * Step 2 (L7 content) — generateSlideContent() — LLM
 *   Output:  structured JSON per slide: title, headline, bullets[], evidence_callouts[],
 *            citations[], visualization_ids[]
 *   Label:   "L7-slide-content-<N>-<type>", concurrency: 3
 *   Fallback: deterministicSlide()
 *
 * Step 3 (L8 script) — generateSpeakerNotesForDeck() — LLM
 *   MUST run AFTER Step 2 — uses finalized slide content only, no new claims.
 *   Label:   "L8-speaker-script-<slide_number>", concurrency: 3
 *   Fallback: deterministicNotes()
 *
 * Step 3b (L8 QA) — qaAllScripts() — deterministic + optional second-model
 *   Annotates each slide with script_qa. Non-blocking.
 *   skipSecondModel=false → uses a different provider from script generation.
 *
 * Step 4 (L9 export) — deterministic, no LLM
 *   PPTX: template exporter (python-pptx + AI x Security template) preferred.
 *         Falls back to PptxGenJS if python3/python-pptx/template unavailable.
 *   Speaker scripts: speaker_script_<mode>.md / .txt / .docx
 *   JSON: slide_deck_output.json (raw slide objects incl. script_qa)
 *   mode = "llm" when LLM was used, "deterministic" when skipLlm=true.
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 * synthesisResult from runSynthesisLayer():
 *   { feed_sources[], analytics: { aggregates, visualization_specs },
 *     category_analyses[], dossiers[] }
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * { slide_plan, slides[], exports, counts: { evidence_callouts_used }, deck_version }
 */

import { join, resolve }                   from "path";
import { mkdir, writeFile }                 from "fs/promises";
import { fileURLToPath }                    from "url";
import { dirname }                          from "path";

import { planSlides }                       from "./planSlides.js";
import { matchVisualizationsToSlidePlan }   from "../synthesis/matchVisualizationsToInsights.js";
import { generateAllCaseDiagrams }          from "./generateCaseDiagrams.js";
import { generateSlideContent }             from "./generateSlideContent.js";
import { exportDeck }                       from "./exportDeck.js";
import { exportMarkdownDeck }               from "./exportMarkdownDeck.js";
import { qaSlideContent }                   from "./qaSlideContent.js";
import { qaSlideContentLlm }               from "./qaSlideContentLlm.js";
import { validateSlideTraceability }        from "./validateSlideTraceability.js";
import { exportPptxTemplate, isTemplateExportAvailable } from "./exportPptxTemplate.js";
import { extractStrategicThemes }           from "./strategicThemesPhase.js";
import { buildDeckQaReport }               from "./deckQaReport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");

export const DECK_VERSION = "deck-v9.1";

// ── Output path helpers ────────────────────────────────────────────────────────

async function ensureOutputDir(dir) {
  await mkdir(dir, { recursive: true });
}

function outputsDir() {
  return join(PROJECT_ROOT, "outputs", "final");
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the full Layer 7–9 slides pipeline.
 *
 * @param {object} synthesisResult  - Output of runSynthesisLayer() (Layers 6+).
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm=false]
 * @param {string}  [opts.exportFormat="all"]  "markdown"|"pptx"|"json"|"all"
 * @param {string}  [opts.outputPath=null]     Override for PPTX output path.
 * @returns {Promise<DeckResult>}
 */
export async function runSlidesLayer(synthesisResult, opts = {}) {
  const {
    skipLlm      = false,
    exportFormat = "all",
    outputPath   = null,
  } = opts;

  const {
    feed_sources         = [],
    analytics            = {},
    category_analyses    = [],
    dossiers             = [],
    presentation_packet  = null,
    evidence_inventory   = [],
    claim_chain_results  = {},   // from runClaimChainAllCategories — claim-first planning
  } = synthesisResult;

  const { aggregates = {}, visualization_specs = [] } = analytics;

  if (!feed_sources?.length) {
    return {
      slide_plan:   [],
      slides:       [],
      exports:      {},
      counts:       { slides_planned: 0, slides_generated: 0, evidence_callouts_used: 0, script_qa_issues: 0 },
      deck_version: DECK_VERSION,
    };
  }

  // Layer 7 step order:
  // L7.0 — Corpus audit log (deterministic, no LLM)
  // L7.1 — buildPresentationPacket(analysis_package) — runs in synthesisLayer.js (backward compat)
  // L7.2 — selectSlideEvidence (per slide, after slide type known)
  // L7.3 — matchVisualizationsToSlidePlan (after slide plan exists, attach only to approved slides)
  // L7.4 — planSlides
  // L7.4b — Strategic themes phase (Phase 3)
  // L7.5 — Slide Plan QA (validateSlideTraceability, qaSlides)

  // ── L7.0: Corpus audit log ────────────────────────────────────────────────
  // Structured log of source counts and evidence maturity before planning begins.
  const corpusAudit = {
    total_sources:      feed_sources.length,
    date_window: (() => {
      const dates = feed_sources.map((s) => s.date_published || s.published_date).filter(Boolean).sort();
      return dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : { start: null, end: null };
    })(),
    by_category:        {},
    evidence_maturity:  {},
  };
  for (const src of feed_sources) {
    const cat = src.main_category || "unknown";
    corpusAudit.by_category[cat] = (corpusAudit.by_category[cat] || 0) + 1;
  }
  for (const analysis of category_analyses) {
    if (analysis.corpus_audit?.maturity_distribution) {
      for (const [k, v] of Object.entries(analysis.corpus_audit.maturity_distribution)) {
        corpusAudit.evidence_maturity[k] = (corpusAudit.evidence_maturity[k] || 0) + (v || 0);
      }
    }
  }
  process.stdout.write(
    `  [L7.0-corpus-audit] ${corpusAudit.total_sources} sources` +
    (corpusAudit.date_window.start ? ` | window: ${corpusAudit.date_window.start} → ${corpusAudit.date_window.end}` : "") +
    ` | categories: ${Object.keys(corpusAudit.by_category).join(", ")}\n`
  );

  // ── L7.4b: Strategic themes phase (Phase 3) ───────────────────────────────
  process.stdout.write("  [L7.4b-strategic-themes] extracting strategic themes...\n");
  const strategicThemes = await extractStrategicThemes(
    {
      category_analyses,
      claim_chain_results,
      presentation_packet,
      feed_sources,
    },
    { skipLlm }
  );
  process.stdout.write(`    ${strategicThemes.length} strategic theme(s) extracted\n`);

  // ── L7.4: Slide planning (claim-first) ────────────────────────────────────
  const totalCritical = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_critical || 0), 0);
  const totalHigh     = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_high    || 0), 0);
  process.stdout.write(
    `  [L7.4-plan-slides] planning (claim-first) — ` +
    `critical=${totalCritical} high=${totalHigh} categories_with_chains=${Object.keys(claim_chain_results).length}\n`
  );
  const rawSlidePlan = planSlides(
    category_analyses,
    dossiers,
    feed_sources,
    aggregates,
    visualization_specs,
    presentation_packet,
    claim_chain_results    // claim-first planning
  );
  process.stdout.write(`    ${rawSlidePlan.length} slides planned\n`);

  // ── L7.3: Match visualizations to slide plan ───────────────────────────────
  // Runs AFTER L7.4 (planSlides) so slide types and claim_ids are known.
  // Attaches only to slides with an approved claim_id and evidence_sufficient=true.
  const vizRegistry = synthesisResult?.analysis_package?.visualization_registry || null;
  const slide_plan = vizRegistry
    ? matchVisualizationsToSlidePlan(rawSlidePlan, vizRegistry)
    : rawSlidePlan;
  if (vizRegistry) {
    const vizFiltered = rawSlidePlan.reduce((n, s, i) => {
      const before = (s.visualization_ids || []).length;
      const after  = (slide_plan[i]?.visualization_ids || []).length;
      return n + (before - after);
    }, 0);
    if (vizFiltered > 0) {
      process.stdout.write(`  [L7.3-viz-match] filtered ${vizFiltered} unregistered visualization_id(s) from slide plan\n`);
    }
  }

  // ── Step 1a: Argument-form cross-validation ────────────────────────────────
  // The presentation_packet.argument_form_by_claim[] was computed by buildPresentationPacket
  // (before planSlides). planSlides computes the same argument forms via attachArgumentFormMeta.
  // Both call selectSlideArgumentForm deterministically — they should always agree.
  // Log any disagreements so evidence-input divergence is visible without being blocking.
  if (presentation_packet?.argument_form_by_claim?.length > 0) {
    const packetFormMap = new Map(
      presentation_packet.argument_form_by_claim.map((x) => [x.claim_id, x.argument_form])
    );
    let mismatchCount = 0;
    for (const slide of slide_plan) {
      if (!slide.claim_id || !slide.argument_form) continue;
      const packetForm = packetFormMap.get(slide.claim_id);
      if (packetForm && packetForm !== slide.argument_form) {
        mismatchCount++;
        process.stdout.write(
          `  [L7-arg-form-xval] WARN claim ${slide.claim_id}: packet_form=${packetForm} vs plan_form=${slide.argument_form}\n`
        );
      }
    }
    if (mismatchCount === 0) {
      process.stdout.write(`  [L7-arg-form-xval] Argument forms consistent across packet + plan\n`);
    }
  }

  // ── Step 1b: Case-study diagram generation ────────────────────────────────
  // Runs after planning, before content generation.
  // Processes slides with needs_diagram=true: generates Mermaid DSL via LLM,
  // builds DiagramSpec, patches visualization_ids back onto those slides.
  // L5B/L5C real visuals (already in external_visual_callouts) take priority —
  // needs_diagram is only set when no real visual is available.
  const needsDiagramCount = slide_plan.filter((s) => s.needs_diagram).length;
  let finalSlidePlan = slide_plan;
  if (needsDiagramCount > 0) {
    process.stdout.write(`  [L7-diagram-gen] step 1b — case diagram generation (${needsDiagramCount} candidate(s))...\n`);
    const { diagramSpecs, updatedSlides } = await generateAllCaseDiagrams(slide_plan, { skipLlm });
    finalSlidePlan = updatedSlides;
    // Merge diagram specs into visualization_specs so the renderer can resolve them
    visualization_specs.push(...diagramSpecs);
    process.stdout.write(`    ${diagramSpecs.length} diagram(s) added to visualization specs\n`);
  }

  // ── Step 2: Slide content generation ─────────────────────────────────────
  process.stdout.write(`  [L7-slide-content] step 2 — content generation — Generating slide content (skipLlm=${skipLlm})...\n`);
  const contentSlides = await generateSlideContent(finalSlidePlan, feed_sources, { skipLlm });
  process.stdout.write(`    ${contentSlides.length} slides generated\n`);

  // ── Step 2b: Slide content evidence-grounding QA ─────────────────────────
  // Runs deterministically after generation. Enforces:
  //   - no specific numbers without evidence key_fact backing
  //   - no prohibited trend/growth phrases without analytics backing
  //   - citation titles must not introduce inflated statistics
  //   - citations without URLs stripped
  // Blocking issues sanitize the slide content (phrase replacement) in strict mode.
  process.stdout.write("  [L8.2-content-qa] step 2b — Slide content evidence-grounding QA...\n");
  const { slides: qaContentSlides, report: contentQaReport } = qaSlideContent(contentSlides, { strict: true });
  if (!contentQaReport.deck_qa_pass) {
    process.stdout.write(
      `  [L8.2-content-qa] DECK QA FAIL: ${contentQaReport.slides_blocking} slides with blocking issues\n` +
      (contentQaReport.hallucinated_stats.length > 0
        ? `    Hallucinated statistics (bullets DROPPED): slides ${contentQaReport.hallucinated_stats.map((s) => s.slide).join(", ")}\n`
        : "") +
      (contentQaReport.inflated_citations.length > 0
        ? `    Inflated citations: slides ${contentQaReport.inflated_citations.map((s) => s.slide).join(", ")}\n`
        : "")
    );
  }

  // ── Step 2b-ii: Second-model LLM QA on slide content ─────────────────────
  // Haiku independently checks Opus/Sonnet-generated bullets and headlines
  // against the evidence callouts on each slide. Verdicts:
  //   unsupported   → bullet dropped or headline downgraded
  //   needs_caveat  → caveat appended inline
  //   grounded      → no change
  // ~6 Haiku calls for a 35-slide deck (~$0.03). Skipped when skipLlm=true.
  process.stdout.write("  [QA/LLM] step 2b-ii — Second-model slide content QA...\n");
  const llmQaSlides = await qaSlideContentLlm(qaContentSlides, { skip: skipLlm });

  // ── L8.2 qa_failed: deterministic fallback for slides with < 2 bullets ───
  // If hallucinated stat dropping or LLM QA left a slide with too few bullets,
  // generate safe deterministic content from evidence_callouts and headline.
  // Structural slides (title, section_divider, appendix) have 0 bullets by design —
  // exclude them so they don't trigger the fallback and emit resolved_by_fallback noise.
  const STRUCTURAL_NO_QA_FALLBACK = new Set([
    "title", "section_divider", "appendix", "appendix_evidence_index",
    "appendix_analytics_tables", "appendix_taxonomy",
  ]);
  const qaFailedSlides = llmQaSlides.filter((s) =>
    s.qa_failed || (
      (s.bullets?.length ?? 0) < 1 &&
      !STRUCTURAL_NO_QA_FALLBACK.has(s.slide_type)
    )
  );
  if (qaFailedSlides.length > 0) {
    process.stdout.write(
      `  [L8.2-content-qa] ${qaFailedSlides.length} slide(s) qa_failed=true — using deterministic fallback bullets\n`
    );
    for (const slide of qaFailedSlides) {
      // Deterministic fallback: rebuild bullets from evidence callouts and claim text
      const fallbackBullets = [];
      if (slide.claim_text) fallbackBullets.push(slide.claim_text.slice(0, 120));
      for (const callout of (slide.evidence_callouts || []).slice(0, 2)) {
        if (callout.key_fact) fallbackBullets.push(`${callout.publisher ? callout.publisher + ": " : ""}${callout.key_fact.slice(0, 100)}`);
      }
      if (fallbackBullets.length === 0 && slide.headline) {
        fallbackBullets.push(slide.headline);
        fallbackBullets.push("See evidence callouts for supporting detail.");
      }
      slide.bullets   = fallbackBullets;
      slide.qa_failed = false;  // resolved by fallback
      slide.content_qa = { ...(slide.content_qa || {}), resolved_by_fallback: true };
      process.stdout.write(`  [L8.2-content-qa] DROPPED bullet + fallback on slide ${slide.slide_number}\n`);
    }
  }

  // ── Step 2b-iii: Inline visual plan processing ───────────────────────────
  // Slides where the content LLM requested a visual get Mermaid diagrams
  // generated here. attack_flow / timeline / concept_diagram → mermaid.ink URL.
  // comparison_table / bar_chart_text → AI-described placeholder.
  // Slides that already have visualization_ids from L5B/L5C are not overridden.
  const visualPlanSlides = llmQaSlides.filter(
    (s) => s.visual_plan?.needed && !(s.visualization_ids?.length)
  );
  if (visualPlanSlides.length > 0) {
    process.stdout.write(
      `  [L7-inline-visual] step 2b-iii — Processing ${visualPlanSlides.length} inline visual plan(s)...\n`
    );
    const { generateInlineVisuals } = await import("./generateInlineVisuals.js");
    const inlineVisualResults = await generateInlineVisuals(visualPlanSlides, { skipLlm });
    // Merge results: attach visual_requirement to slides that got one, add specs
    const vizById = new Map(inlineVisualResults.map((r) => [r.slide_number, r]));
    for (let i = 0; i < llmQaSlides.length; i++) {
      const r = vizById.get(llmQaSlides[i].slide_number);
      if (r?.visual_requirement) {
        llmQaSlides[i] = { ...llmQaSlides[i], visual_requirement: r.visual_requirement };
      }
      if (r?.visualization_spec) {
        visualization_specs.push(r.visualization_spec);
      }
    }
    const inlineVisualCount = inlineVisualResults.filter((r) => r.visual_requirement).length;
    process.stdout.write(`    ${inlineVisualCount} inline visual(s) generated\n`);
  }

  // ── Step 2c: Traceability validation ─────────────────────────────────────
  // When a full EvidencePacketRegistry (v1 pipeline) is available, use the deep
  // validator. Otherwise fall back to a lightweight inline check that works with
  // v2 pipeline output (no registry required).
  const evidenceRegistry = synthesisResult?.dossiers?.[0]?._evidence_packet_registry || null;
  let traceabilityReport = null;

  if (evidenceRegistry) {
    process.stdout.write("  [L9-traceability] step 2c — Slide traceability validation (registry)...\n");
    traceabilityReport = validateSlideTraceability(llmQaSlides, evidenceRegistry);
    if (traceabilityReport.valid) {
      process.stdout.write(`    Traceability QA passed. ${traceabilityReport.warnings.length} warning(s).\n`);
    } else {
      process.stdout.write(
        `  [L9-traceability] ${traceabilityReport.errors.length} error(s), ` +
        `${traceabilityReport.warnings.length} warning(s). Unresolved IDs: ${traceabilityReport.unresolved_ids.length}\n`
      );
    }
    const allClaims = llmQaSlides
      .filter((s) => s.claim_id)
      .map((s) => ({ claim_id: s.claim_id, supporting_evidence_ids: s.supporting_evidence_ids || [] }));
    if (allClaims.length > 0) {
      evidenceRegistry.writeBackClaimIds(allClaims);
      process.stdout.write(`    Claim writeback: ${allClaims.length} claims linked to evidence packets\n`);
    }
  } else {
    // Lightweight inline traceability check for v2 pipeline (no registry).
    // Checks: (1) citations have URLs, (2) evidence callouts have valid URLs,
    // (3) no raw ev_xxx IDs in visible text, (4) claim slides have evidence.
    process.stdout.write("  [L9-traceability] step 2c — Lightweight traceability check (v2)...\n");
    const errors = [], warnings = [];
    const EV_ID_RE = /\bev[_-][a-zA-Z0-9_-]{4,}/;

    for (const slide of llmQaSlides) {
      const loc = `slide ${slide.slide_number} (${slide.slide_type})`;

      // Citations must have a URL in parentheses
      for (const cit of (slide.citations || [])) {
        if (!cit.includes("http")) warnings.push(`${loc}: citation missing URL — "${cit.slice(0, 60)}"`);
      }

      // Evidence callouts must have a valid https URL
      for (const ec of (slide.evidence_callouts || [])) {
        if (!ec.url || !ec.url.startsWith("http")) {
          errors.push(`${loc}: evidence callout "${ec.title?.slice(0, 40)}" has no valid URL`);
        }
        if (EV_ID_RE.test(ec.url || "")) {
          errors.push(`${loc}: evidence callout URL is an internal ID, not a real URL: ${ec.url}`);
        }
      }

      // No raw ev_xxx IDs should appear in visible bullet text
      for (const b of (slide.bullets || [])) {
        const txt = typeof b === "string" ? b : (b.text || "");
        if (EV_ID_RE.test(txt)) {
          errors.push(`${loc}: internal evidence ID visible in bullet: "${txt.slice(0, 60)}"`);
        }
      }

      // Claim-anchored slides must cite at least one piece of evidence
      const isClaimSlide = ["critical_claim", "trend_claim", "claim_first"].includes(slide.slide_type);
      if (isClaimSlide && !(slide.evidence_callouts?.length) && !(slide.citations?.length)) {
        warnings.push(`${loc}: claim slide has no evidence callouts or citations`);
      }
    }

    traceabilityReport = {
      valid:    errors.length === 0,
      errors,
      warnings,
      unresolved_ids: [],
      mode: "lightweight_v2",
    };

    if (errors.length === 0) {
      process.stdout.write(`    Lightweight traceability passed. ${warnings.length} warning(s).\n`);
    } else {
      process.stdout.write(
        `  [L9-traceability] ${errors.length} error(s), ${warnings.length} warning(s).\n`
      );
      errors.slice(0, 5).forEach((e) => process.stdout.write(`    ✗ ${e}\n`));
    }
  }

  // ── Step 3: Visual planning pass ─────────────────────────────────────────
  // Opus reviews the full deck and assigns visual_requirement to ≤4 analytical slides.
  // When no external figures exist this provides at minimum a structured description
  // that the PPTX exporter renders as a labeled placeholder.
  process.stdout.write("  [L7-visual-planning] step 3d — Visual planning pass...\n");
  const { generateVisualPlanning } = await import("./generateVisualPlanning.js");
  const slidesWithVisuals = await generateVisualPlanning(llmQaSlides, { skipLlm });
  const visualCount = slidesWithVisuals.filter((s) => s.visual_requirement).length;
  process.stdout.write(`    Visual planning: ${visualCount} slide(s) assigned visual_requirement\n`);
  const exportSlides = slidesWithVisuals;

  // ── Step 4: Export ────────────────────────────────────────────────────────
  process.stdout.write("  [L9-pptx-export] step 4 — Exporting deck...\n");

  const outDir   = outputsDir();
  const pptxPath = outputPath || join(outDir, "horizon_scan_deck.pptx");
  const mode     = skipLlm ? "deterministic" : "llm";

  await ensureOutputDir(outDir);

  const jsonPath = join(outDir, "slide_deck_output.json");
  await writeFile(jsonPath, JSON.stringify(exportSlides, null, 2));

  // Non-PPTX deck formats (markdown JSON)
  const wantsPptx = exportFormat === "pptx" || exportFormat === "all";
  const mdDeckFormat = wantsPptx ? "markdown" : exportFormat;
  const exports = await exportDeck(exportSlides, mdDeckFormat, {
    feedSources:        feed_sources,
    aggregates,
    visualizationSpecs: visualization_specs,
  });

  // PPTX: PptxGenJS is the primary renderer (full layout control).
  // The python-pptx template exporter is opt-in via USE_TEMPLATE_EXPORT=1.
  let pptxMethod = "skipped";
  if (wantsPptx) {
    const useTemplate = process.env.USE_TEMPLATE_EXPORT === "1" && await isTemplateExportAvailable();
    try {
      if (useTemplate) {
        process.stdout.write("  [L9-pptx-export] Template exporter (python-pptx + AI x Security template)...\n");
        await exportPptxTemplate(exportSlides, pptxPath, visualization_specs);
        pptxMethod = "template";
      } else {
        process.stdout.write("  [L9-pptx-export] PptxGenJS exporter (primary)...\n");
        const { exportPptx } = await import("./exportPptx.js");
        await exportPptx(exportSlides, feed_sources, aggregates, visualization_specs, pptxPath, {
          evidenceInventory: evidence_inventory,
        });
        pptxMethod = "pptxgenjs";
      }
    } catch (pptxErr) {
      process.stdout.write(`  [L9-pptx-export] WARN PPTX export failed: ${pptxErr.message}\n`);
    }
  }

  process.stdout.write(
    `    PPTX:  ${pptxMethod} → ${pptxPath}\n` +
    `    json:  ${jsonPath}\n`
  );

  // ── Deck QA Report ────────────────────────────────────────────────────────
  process.stdout.write("  [L9-deck-qa-report] Building deck QA report...\n");
  const deckQaReport = buildDeckQaReport(
    exportSlides,
    feed_sources,
    strategicThemes,
    contentQaReport,
    null   // speaker notes removed
  );
  const qaReportPath = join(outDir, "deck_qa_report.json");
  try {
    await writeFile(qaReportPath, JSON.stringify(deckQaReport, null, 2));
    process.stdout.write(`    QA report: ${qaReportPath}\n`);
    if (!deckQaReport.qa_pass) {
      process.stdout.write(
        `  [L9-deck-qa-report] QA FAIL:\n` +
        deckQaReport.hard_fail_conditions_triggered.map((c) => `    ${c}`).join("\n") + "\n"
      );
    } else {
      process.stdout.write(`  [L9-deck-qa-report] QA PASS\n`);
    }
  } catch (qaErr) {
    process.stdout.write(`  [L9-deck-qa-report] WARN: failed to write QA report: ${qaErr.message}\n`);
  }

  // ── Counts ────────────────────────────────────────────────────────────────
  const evidenceCalloutsUsed = exportSlides.reduce(
    (n, s) => n + (s.evidence_callouts?.length || 0),
    0
  );

  // Slides with claim anchors
  const claimAnchoredCount = exportSlides.filter((s) => s.claim_id).length;

  return {
    slide_plan,
    slides: exportSlides,
    exports: {
      ...exports,
      json_path:      jsonPath,
      pptx_path:      wantsPptx ? pptxPath : null,
      pptx_method:    pptxMethod,
      qa_report_path: qaReportPath,
    },
    counts: {
      slides_planned:             slide_plan.length,
      slides_generated:           exportSlides.length,
      claim_anchored_slides:      claimAnchoredCount,
      evidence_callouts_used:     evidenceCalloutsUsed,
      visuals_planned:            visualCount,
      content_qa_blocking:        contentQaReport.slides_blocking,
      content_qa_warnings:        contentQaReport.slides_warning,
      content_qa_pass:            contentQaReport.deck_qa_pass,
      claim_chain_categories:     Object.keys(claim_chain_results).length,
      strategic_themes_extracted: strategicThemes.length,
    },
    content_qa_report:  contentQaReport,
    deck_qa_report:     deckQaReport,
    strategic_themes:           strategicThemes,
    traceability_report:        traceabilityReport,
    evidence_registry_summary:  evidenceRegistry?.summary() || null,
    deck_version:            DECK_VERSION,
  };
}
