/**
 * Pipeline Layer Registry — canonical names, log prefixes, and version stamps
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 *
 *   L1  Ingest            lib/pipeline/ingest/
 *   L2  Clean             lib/pipeline/clean/
 *   L3  Validate+Archive  lib/pipeline/classify/  lib/pipeline/validate/  lib/pipeline/archive/
 *   L4  Taxonomy          lib/pipeline/understand/
 *       ├── L5A  Rawfacts Branch     lib/pipeline/rawfact/  lib/pipeline/evidence/
 *       └── L5B  Analytics Branch   lib/pipeline/analytics/
 *                    ↓ (converge)
 *   L6  Analysis+Synthesis  lib/pipeline/analysis/  lib/pipeline/synthesis/
 *                    ↓
 *   L7  Slide Content       lib/pipeline/slides/generateSlideContent.js
 *                    ↓
 *   L8  Script Generation   lib/pipeline/slides/generateSpeakerNotes.js
 *                    ↓
 *   L9  PPTX+Export         lib/pipeline/slides/exportPptx.js  exportDeck.js
 *
 * L5A and L5B run in parallel after L4.
 * L6 converges both branches and runs analysis + synthesis.
 * L7–L9 are the presentation pipeline: content → script → export.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *
 *   import { LOG, LAYER } from "../../layers.js";
 *   process.stdout.write(LOG.L5A("evidence extraction starting\n"));
 *   // → "[L5A-rawfacts] evidence extraction starting\n"
 */

// ── Canonical layer identifiers ───────────────────────────────────────────────

export const LAYER = {
  L1_INGEST:              "L1_INGEST",
  L2_CLEAN:               "L2_CLEAN",
  L3_VALIDATE_ARCHIVE:    "L3_VALIDATE_ARCHIVE",
  L4_TAXONOMY:            "L4_TAXONOMY",
  L5A_RAWFACTS:           "L5A_RAWFACTS",
  L5B_ANALYTICS:          "L5B_ANALYTICS",
  L6_ANALYSIS_SYNTHESIS:  "L6_ANALYSIS_SYNTHESIS",
  L7_SLIDE_CONTENT:       "L7_SLIDE_CONTENT",
  L8_SCRIPT_GENERATION:   "L8_SCRIPT_GENERATION",
  L9_PPTX_EXPORT:         "L9_PPTX_EXPORT",
};

// ── Canonical log prefixes ────────────────────────────────────────────────────
// Each prefix function returns a bracketed label for process.stdout.write.
// Use these in all pipeline log statements.

export const LOG = {
  L1:   (msg) => `[L1-ingest] ${msg}`,
  L2:   (msg) => `[L2-clean] ${msg}`,
  L3:   (msg) => `[L3-validate-archive] ${msg}`,
  L4:   (msg) => `[L4-taxonomy] ${msg}`,
  L5A:  (msg) => `[L5A-rawfacts] ${msg}`,
  L5B:  (msg) => `[L5B-analytics] ${msg}`,
  L6:   (msg) => `[L6-analysis-synthesis] ${msg}`,
  L6c:  (msg) => `[L6-analysis-cross-category] ${msg}`,
  L6d:  (msg) => `[L6-analysis-dossier-fusion] ${msg}`,
  L6s:  (msg) => `[L6-analysis-category-synthesis] ${msg}`,
  L6e:  (msg) => `[L6-analysis-evidence-linking] ${msg}`,
  L6q:  (msg) => `[L6-analysis-qa] ${msg}`,
  L6p:  (msg) => `[L6-analysis-presentation-packet] ${msg}`,
  L7:   (msg) => `[L7-slide-content] ${msg}`,
  L8:   (msg) => `[L8-script-generation] ${msg}`,
  L9:   (msg) => `[L9-pptx-export] ${msg}`,
};

// ── LLM logLabel constants ────────────────────────────────────────────────────
// Used in routedLLM({ logLabel }) and callLLM({ logLabel }) calls.

export const LLM_LABEL = {
  L3_VALIDATION_RELEVANCE:    (id = "") => `L3-validation-relevance${id ? `-${id}` : ""}`,
  L3_VALIDATION_RELEVANCE_QA: (id = "") => `L3-validation-relevance-qa${id ? `-${id}` : ""}`,
  L4_TAXONOMY:                (id = "") => `L4-taxonomy-source-understanding${id ? `-${id}` : ""}`,
  L5A_RAWFACTS_TAXONOMY:      ()        => "L5A-rawfacts-taxonomy",
  L5A_EVIDENCE_EXTRACTION:    ()        => "L5A-rawfacts-evidence-extraction",
  L5B_FEATURE_EXTRACTION:     ()        => "L5B-analytics-feature-extraction",
  L6_CATEGORY_SYNTHESIS:      (cat = "")=> `L6-category-synthesis${cat ? `-${cat}` : ""}`,
  L6_CROSS_CATEGORY:          ()        => "L6-cross-category-synthesis",
  L6_ANALYSIS_QA:             (cat = "")=> `L6-analysis-qa${cat ? `-${cat}` : ""}`,
  L7_SLIDE_CONTENT:           (n, type) => `L7-slide-content-${n}-${type}`,
  L8_SPEAKER_SCRIPT:          (n)       => `L8-speaker-script-${n}`,
};

// ── Pipeline version stamps ───────────────────────────────────────────────────
// These values are stored in the database as idempotency stamps.
// Do NOT change the string values without a corresponding data migration.

export const PIPELINE_VERSIONS = {
  VALIDATION:     "validation-v1.0",  // L3 — stored as validation_version on sources
  TAXONOMY:       "taxonomy-v7.0",    // L4 — stored as taxonomy_version on sources
  RAWFACT:        "rawfact-v2.0",     // L5A — stored as rawfact_version
  ANALYTICS:      "analytics-v2.0",  // L5B — stored as analytics_version
  SYNTHESIS:      "synthesis-v8.0",  // L6  — stored in synthesis output
  ANALYSIS:       "analysis-v2.0",   // L6  — stored in analysis output
  DECK:           "deck-v7.1",        // L7–L9 — stored in deck metadata
  RUNNER:         "runner-v9.0",      // top-level pipeline runner
};

// ── Pipeline step descriptions (for docs and diagnostics) ────────────────────

export const PIPELINE_STEPS = [
  { id: "L1",  label: "Ingest",              folder: "lib/pipeline/ingest/",    parallel: false },
  { id: "L2",  label: "Clean",               folder: "lib/pipeline/clean/",     parallel: false },
  { id: "L3",  label: "Validate + Archive",  folder: "lib/pipeline/classify/  lib/pipeline/validate/  lib/pipeline/archive/", parallel: false },
  { id: "L4",  label: "Taxonomy",            folder: "lib/pipeline/understand/", parallel: false },
  { id: "L5A", label: "Rawfacts Branch",     folder: "lib/pipeline/rawfact/  lib/pipeline/evidence/", parallel: true },
  { id: "L5B", label: "Analytics Branch",    folder: "lib/pipeline/analytics/", parallel: true },
  { id: "L6",  label: "Analysis + Synthesis",folder: "lib/pipeline/analysis/  lib/pipeline/synthesis/", parallel: false },
  { id: "L7",  label: "Slide Content",       folder: "lib/pipeline/slides/generateSlideContent.js", parallel: false },
  { id: "L8",  label: "Script Generation",   folder: "lib/pipeline/slides/generateSpeakerNotes.js", parallel: false },
  { id: "L9",  label: "PPTX + Export",       folder: "lib/pipeline/slides/exportPptx.js", parallel: false },
];
