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
import { generateSlideContent }             from "./generateSlideContent.js";
import { generateSpeakerNotesForDeck }      from "./generateSpeakerNotes.js";
import { exportDeck }                       from "./exportDeck.js";
import {
  exportMarkdownDeck,
  exportSpeakerScript,
  exportSpeakerScriptTxt,
  exportSpeakerScriptDocx,
} from "./exportMarkdownDeck.js";
import { qaAllScripts }                     from "../scriptGeneration/qaScript.js";
import { qaSlideContent }                   from "./qaSlideContent.js";
import { qaSpeakerNotes }                   from "./qaSpeakerNotes.js";
import { validateSlideTraceability }        from "./validateSlideTraceability.js";
import { exportPptxTemplate, isTemplateExportAvailable } from "./exportPptxTemplate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");

export const DECK_VERSION = "deck-v8.0";

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
 * @param {boolean} [opts.detailedNotes=true]
 * @param {string}  [opts.exportFormat="all"]  "markdown"|"pptx"|"json"|"all"
 * @param {string}  [opts.outputPath=null]     Override for PPTX output path.
 * @returns {Promise<DeckResult>}
 */
export async function runSlidesLayer(synthesisResult, opts = {}) {
  const {
    skipLlm       = false,
    detailedNotes = true,
    exportFormat  = "all",
    outputPath    = null,
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

  // ── Step 1: Slide planning (claim-first) ─────────────────────────────────
  const totalCritical = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_critical || 0), 0);
  const totalHigh     = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_high    || 0), 0);
  process.stdout.write(
    `  [L7-slide-content] step 1 — planning (claim-first) — ` +
    `critical=${totalCritical} high=${totalHigh} categories_with_chains=${Object.keys(claim_chain_results).length}\n`
  );
  const slide_plan = planSlides(
    category_analyses,
    dossiers,
    feed_sources,
    aggregates,
    visualization_specs,
    presentation_packet,
    claim_chain_results    // new: claim-first planning
  );
  process.stdout.write(`    ${slide_plan.length} slides planned\n`);

  // ── Step 2: Slide content generation ─────────────────────────────────────
  process.stdout.write(`  [L7-slide-content] step 2 — content generation — Generating slide content (skipLlm=${skipLlm})...\n`);
  const contentSlides = await generateSlideContent(slide_plan, feed_sources, { skipLlm });
  process.stdout.write(`    ${contentSlides.length} slides generated\n`);

  // ── Step 2b: Slide content evidence-grounding QA ─────────────────────────
  // Runs deterministically after generation. Enforces:
  //   - no specific numbers without evidence key_fact backing
  //   - no prohibited trend/growth phrases without analytics backing
  //   - citation titles must not introduce inflated statistics
  //   - citations without URLs stripped
  // Blocking issues sanitize the slide content (phrase replacement) in strict mode.
  process.stdout.write("  [L7b-content-qa] step 2b — Slide content evidence-grounding QA...\n");
  const { slides: qaContentSlides, report: contentQaReport } = qaSlideContent(contentSlides, { strict: true });
  if (!contentQaReport.deck_qa_pass) {
    process.stdout.write(
      `  [L7b-content-qa] DECK QA FAIL: ${contentQaReport.slides_blocking} slides with blocking issues\n` +
      (contentQaReport.hallucinated_stats.length > 0
        ? `    Hallucinated statistics: slides ${contentQaReport.hallucinated_stats.map((s) => s.slide).join(", ")}\n`
        : "") +
      (contentQaReport.inflated_citations.length > 0
        ? `    Inflated citations: slides ${contentQaReport.inflated_citations.map((s) => s.slide).join(", ")}\n`
        : "")
    );
  }

  // ── Step 2c: Traceability validation ─────────────────────────────────────
  // Validate that every evidence_id, visual_id, and citation in the deck resolves
  // to a registered EvidencePacket. Non-blocking: logs errors but continues.
  const evidenceRegistry = synthesisResult?.dossiers?.[0]?._evidence_packet_registry || null;
  let traceabilityReport = null;
  if (evidenceRegistry) {
    process.stdout.write("  [L9-traceability] step 2c — Slide traceability validation...\n");
    traceabilityReport = validateSlideTraceability(qaContentSlides, evidenceRegistry);
    if (traceabilityReport.valid) {
      process.stdout.write(`    Traceability QA passed. ${traceabilityReport.warnings.length} warning(s).\n`);
    } else {
      process.stdout.write(
        `  [L9-traceability] ${traceabilityReport.errors.length} traceability error(s), ` +
        `${traceabilityReport.warnings.length} warning(s). Unresolved IDs: ${traceabilityReport.unresolved_ids.length}\n`
      );
    }
    // Write back claim IDs onto packets
    const allClaims = qaContentSlides
      .filter((s) => s.claim_id)
      .map((s) => ({ claim_id: s.claim_id, supporting_evidence_ids: s.supporting_evidence_ids || [] }));
    if (allClaims.length > 0) {
      evidenceRegistry.writeBackClaimIds(allClaims);
      process.stdout.write(`    Claim writeback: ${allClaims.length} claims linked to evidence packets\n`);
    }
  } else {
    process.stdout.write("  [L9-traceability] step 2c — Traceability validation skipped (no registry)\n");
  }

  // ── Step 3: Speaker notes ─────────────────────────────────────────────────
  process.stdout.write("  [L8-script-generation] step 3 — Generating speaker scripts...\n");
  const slidesWithNotes = await generateSpeakerNotesForDeck(qaContentSlides, { skipLlm });
  process.stdout.write("    Speaker scripts complete\n");

  // ── Step 3b: Script QA (non-blocking, second-model optional) ────────────
  process.stdout.write("  [L8-script-generation] step 3b — Running script QA...\n");
  const afterScriptQa = await qaAllScripts(slidesWithNotes, { skipSecondModel: skipLlm });
  const qaIssues = afterScriptQa.filter((s) => s.script_qa?.issues?.length > 0).length;
  process.stdout.write(`    Script QA complete — ${qaIssues} slides with issues\n`);

  // ── Step 3c: Speaker-notes deterministic QA (blocking) ───────────────────
  // Validates: no new numbers, no phantom sources, no trend/outlook certainty,
  // caveats acknowledged. Replaces blocking notes with deterministic fallback.
  process.stdout.write("  [L8b-notes-qa] step 3c — Deterministic speaker-notes QA...\n");
  const { slides: finalSlides, report: notesQaReport } = qaSpeakerNotes(afterScriptQa, { strict: true });
  process.stdout.write(`    Notes QA: ${notesQaReport.slides_blocking} blocking, ${notesQaReport.slides_warning} warning\n`);

  // ── Step 4: Export ────────────────────────────────────────────────────────
  process.stdout.write("  [L9-pptx-export] step 4 — Exporting deck...\n");

  const outDir   = outputsDir();
  const pptxPath = outputPath || join(outDir, "horizon_scan_deck.pptx");
  const mode     = skipLlm ? "deterministic" : "llm";

  await ensureOutputDir(outDir);

  // JSON + speaker scripts (always written regardless of exportFormat)
  const jsonPath  = join(outDir, "slide_deck_output.json");
  const mdPath    = join(outDir, `speaker_script_${mode}.md`);
  const txtPath   = join(outDir, `speaker_script_${mode}.txt`);
  const docxPath  = join(outDir, `speaker_script_${mode}.docx`);

  await writeFile(jsonPath, JSON.stringify(finalSlides, null, 2));
  await writeFile(mdPath,   exportSpeakerScript(finalSlides));
  await writeFile(txtPath,  exportSpeakerScriptTxt(finalSlides));
  await writeFile(docxPath, await exportSpeakerScriptDocx(finalSlides));

  // Non-PPTX deck formats (markdown JSON)
  const wantsPptx = exportFormat === "pptx" || exportFormat === "all";
  const mdDeckFormat = wantsPptx ? "markdown" : exportFormat;
  const exports = await exportDeck(finalSlides, mdDeckFormat, {
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
        await exportPptxTemplate(finalSlides, pptxPath, visualization_specs);
        pptxMethod = "template";
      } else {
        process.stdout.write("  [L9-pptx-export] PptxGenJS exporter (primary)...\n");
        const { exportPptx } = await import("./exportPptx.js");
        await exportPptx(finalSlides, feed_sources, aggregates, visualization_specs, pptxPath, {
          evidenceInventory: evidence_inventory,
        });
        pptxMethod = "pptxgenjs";
      }
    } catch (pptxErr) {
      process.stdout.write(`  [L9-pptx-export] WARN PPTX export failed: ${pptxErr.message}\n`);
    }
  }

  process.stdout.write(
    `    PPTX:       ${pptxMethod} → ${pptxPath}\n` +
    `    json:       ${jsonPath}\n` +
    `    script_md:  ${mdPath}\n` +
    `    script_txt: ${txtPath}\n` +
    `    script_docx:${docxPath}\n`
  );

  // ── Counts ────────────────────────────────────────────────────────────────
  const evidenceCalloutsUsed = finalSlides.reduce(
    (n, s) => n + (s.evidence_callouts?.length || 0),
    0
  );

  // Slides with claim anchors
  const claimAnchoredCount = finalSlides.filter((s) => s.claim_id).length;

  return {
    slide_plan,
    slides: finalSlides,
    exports: {
      ...exports,
      json_path:    jsonPath,
      script_md:    mdPath,
      script_txt:   txtPath,
      script_docx:  docxPath,
      pptx_path:    wantsPptx ? pptxPath : null,
      pptx_method:  pptxMethod,
    },
    counts: {
      slides_planned:              slide_plan.length,
      slides_generated:            finalSlides.length,
      claim_anchored_slides:       claimAnchoredCount,
      evidence_callouts_used:      evidenceCalloutsUsed,
      script_qa_issues:            qaIssues,
      content_qa_blocking:         contentQaReport.slides_blocking,
      content_qa_warnings:         contentQaReport.slides_warning,
      content_qa_pass:             contentQaReport.deck_qa_pass,
      notes_qa_blocking:           notesQaReport.slides_blocking,
      notes_qa_warnings:           notesQaReport.slides_warning,
      notes_qa_pass:               notesQaReport.notes_qa_pass,
      claim_chain_categories:      Object.keys(claim_chain_results).length,
    },
    content_qa_report:       contentQaReport,
    notes_qa_report:         notesQaReport,
    traceability_report:     traceabilityReport,
    evidence_registry_summary: evidenceRegistry?.summary() || null,
    deck_version:            DECK_VERSION,
  };
}
