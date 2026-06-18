/**
 * L9 — Deck QA Report Builder
 *
 * Generates a structured JSON QA report summarising the quality and integrity
 * of the generated slide deck. Aggregates findings from:
 *   - Slide content QA (qaSlideContent)
 *   - Speaker notes QA (qaSpeakerNotes)
 *   - Strategic themes (extractStrategicThemes)
 *   - Slide plan metadata
 *
 * Hard-fail conditions (prevent distribution):
 *   1. Any visible ev-* ID in main slides
 *   2. Any factual bullet (role=finding|evidence) with no URL
 *   3. Any category with zero evidence getting >1 slide
 *   4. Any duplicate slide title
 *
 * @module deckQaReport
 */

export const DECK_QA_REPORT_VERSION = "deck-v9.x";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STRUCTURAL_SLIDE_TYPES = new Set([
  "title", "section_divider", "appendix", "appendix_evidence_index",
  "appendix_analytics_tables", "appendix_taxonomy",
]);

function sectionOf(slide) {
  if (slide.section) return slide.section;
  const type = slide.slide_type || "";
  if (type === "title" || type.startsWith("scope") || type === "source_coverage" || type === "executive_summary" || type === "taxonomy_reference") return "executive_summary";
  if (type.startsWith("appendix")) return "appendix";
  if (slide.category && slide.section !== "D") return "categories";
  if (type.startsWith("cross") || type === "outlook_6month" || type === "watchlist" || type === "evidence_gap") return "cross_category";
  return "outlook";
}

function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

// ── Hard-fail condition checkers ─────────────────────────────────────────────

const EV_ID_LEAK_RE = /\bev[_-][a-f0-9]{4,}[a-z0-9_-]*/gi;
const URL_IN_TEXT_RE = /https?:\/\/\S+/i;

function checkVisibleEvIds(slides) {
  const violations = [];
  for (const slide of slides) {
    if (STRUCTURAL_SLIDE_TYPES.has(slide.slide_type)) continue;
    const textToCheck = [
      slide.headline || "",
      ...(slide.bullets || []).map((b) => (typeof b === "object" ? b.text : b) || ""),
    ].join(" ");
    const matches = [...textToCheck.matchAll(EV_ID_LEAK_RE)].map((m) => m[0]);
    if (matches.length > 0) {
      violations.push({ slide: slide.slide_number, title: slide.title, found_ids: matches });
    }
  }
  return violations;
}

function checkFactualBulletsWithoutUrl(slides) {
  const violations = [];
  for (const slide of slides) {
    if (STRUCTURAL_SLIDE_TYPES.has(slide.slide_type)) continue;
    for (const bullet of (slide.bullets || [])) {
      if (typeof bullet !== "object") continue;
      if (bullet.bullet_role !== "finding" && bullet.bullet_role !== "evidence") continue;
      const text = bullet.text || "";
      if (!URL_IN_TEXT_RE.test(text)) {
        violations.push({ slide: slide.slide_number, title: slide.title, bullet_text: text.slice(0, 80) });
      }
    }
  }
  return violations;
}

function checkZeroEvidenceCategoriesWithMultipleSlides(slides) {
  const violations = [];
  // Group by category
  const catSlides = {};
  for (const slide of slides) {
    if (!slide.category || STRUCTURAL_SLIDE_TYPES.has(slide.slide_type)) continue;
    (catSlides[slide.category] = catSlides[slide.category] || []).push(slide);
  }
  for (const [cat, catSl] of Object.entries(catSlides)) {
    // Check if this category has zero evidence IDs
    const hasEvidence = catSl.some((s) =>
      (s._plan?.rawfact_evidence_ids?.length || 0) > 0 ||
      (s._plan?.claim_ids?.length || 0) > 0 ||
      (s.evidence_callouts?.length || 0) > 0
    );
    if (!hasEvidence && catSl.length > 1) {
      violations.push({
        category: cat,
        slide_count: catSl.length,
        slide_numbers: catSl.map((s) => s.slide_number),
        message: `Category "${cat}" has zero evidence but ${catSl.length} slides — should have at most 1`,
      });
    }
  }
  return violations;
}

function checkDuplicateTitles(slides) {
  const violations = [];
  const seen = new Map();
  for (const slide of slides) {
    if (STRUCTURAL_SLIDE_TYPES.has(slide.slide_type)) continue;
    const norm = normTitle(slide.title);
    if (!norm) continue;
    if (seen.has(norm)) {
      violations.push({
        title: slide.title,
        slide_numbers: [seen.get(norm), slide.slide_number],
      });
    } else {
      seen.set(norm, slide.slide_number);
    }
  }
  return violations;
}

// ── Section slide counter ─────────────────────────────────────────────────────

function countSectionSlides(slides) {
  const counts = {
    executive_summary: 0,
    themes:            0,
    categories:        0,
    cross_category:    0,
    outlook:           0,
    appendix:          0,
  };
  for (const slide of slides) {
    const s = sectionOf(slide);
    if (s in counts) counts[s]++;
    else counts.categories++;  // default to categories
  }
  return counts;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a structured QA report for the deck.
 *
 * @param {object[]} slides              - Final slide objects after all QA passes
 * @param {object[]} sources             - Feed sources (enriched)
 * @param {object[]} strategicThemes     - From extractStrategicThemes()
 * @param {object}   qaContentReport     - From qaSlideContent()
 * @param {object}   notesQaReport       - From qaSpeakerNotes()
 * @returns {object}                     - Structured QA report JSON
 */
export function buildDeckQaReport(slides, sources, strategicThemes, qaContentReport, notesQaReport) {
  slides = slides || [];
  sources = sources || [];
  strategicThemes = strategicThemes || [];
  qaContentReport = qaContentReport || {};
  notesQaReport = notesQaReport || {};

  // ── Date window from sources ──────────────────────────────────────────────
  const dates = (sources || [])
    .map((s) => s.date_published || s.published_date)
    .filter(Boolean)
    .sort();
  const dateWindow = dates.length > 0
    ? { start: dates[0], end: dates[dates.length - 1] }
    : { start: "", end: "" };

  // ── Category analysis ─────────────────────────────────────────────────────
  const MAIN_CATEGORIES = new Set([
    "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
  ]);

  const categorySlideCounts = {};
  for (const slide of slides) {
    if (slide.category && MAIN_CATEGORIES.has(slide.category)) {
      categorySlideCounts[slide.category] = (categorySlideCounts[slide.category] || 0) + 1;
    }
  }

  const categoriesWithFullSections = Object.entries(categorySlideCounts)
    .filter(([, count]) => count >= 3)
    .map(([cat]) => cat);

  const coverageGapSlides = slides.filter((s) => s.slide_type === "coverage_gap");
  const categoriesCollapsedToCoverageGap = [...new Set(coverageGapSlides.map((s) => s.category).filter(Boolean))];

  // ── Duplicate slides removed (from plan dedup) ────────────────────────────
  const dupeSlidesRemoved = slides.filter((s) => s._dedup_removed).length;

  // ── QA content analysis ───────────────────────────────────────────────────
  const allIssues = qaContentReport.all_issues || [];

  const unsupportedBulletsRemoved = allIssues.filter((i) =>
    i.issue === "bullet_not_grounded" || i.issue === "hallucinated_statistic"
  ).length;

  const claimsDowngraded = allIssues.filter((i) =>
    i.issue === "analytical_slide_missing_claim_id"
  ).length;

  const analystJudgmentBullets = allIssues
    .filter((i) => i.issue === "finding_bullet_missing_evidence_id")
    .map((i) => ({ slide: i.slide, text: (i.original_text || "").slice(0, 80) }));

  const factualBulletsMissingUrl = (qaContentReport.bullets_missing_url || []).map((s) => ({
    slide: s.slide,
    title: s.title,
  }));

  // ── Hard-fail conditions ──────────────────────────────────────────────────
  const hardFailConditions = [];

  // 1. Visible ev-* IDs in main slides
  const visibleEvIds = checkVisibleEvIds(slides);
  if (visibleEvIds.length > 0) {
    hardFailConditions.push(
      `FAIL: ${visibleEvIds.length} slide(s) have visible ev-* IDs in main content`
    );
  }

  // 2. Factual bullets with no URL (also from QA content report)
  const factualNoUrl = checkFactualBulletsWithoutUrl(slides);
  if (factualNoUrl.length > 0) {
    hardFailConditions.push(
      `WARN: ${factualNoUrl.length} factual bullet(s) lack a source URL`
    );
  }

  // 3. Zero-evidence categories with >1 slide
  const zeroEvMultiSlide = checkZeroEvidenceCategoriesWithMultipleSlides(slides);
  if (zeroEvMultiSlide.length > 0) {
    hardFailConditions.push(
      `FAIL: ${zeroEvMultiSlide.length} category/categories with zero evidence have >1 slide`
    );
  }

  // 4. Duplicate slide titles
  const dupeTitles = checkDuplicateTitles(slides);
  if (dupeTitles.length > 0) {
    hardFailConditions.push(
      `FAIL: ${dupeTitles.length} duplicate slide title(s) detected`
    );
  }

  // QA pass: hard-fail conditions starting with "FAIL" are blocking
  const hasHardFail = hardFailConditions.some((c) => c.startsWith("FAIL"));
  const contentQaPass = qaContentReport.deck_qa_pass !== false;
  const notesQaPass = notesQaReport.notes_qa_pass !== false;
  const qaPass = !hasHardFail && contentQaPass && notesQaPass;

  // ── Layout issues ─────────────────────────────────────────────────────────
  const layoutIssues = allIssues
    .filter((i) => i.issue === "callout_invalid_url" || i.issue === "callout_missing_publisher")
    .map((i) => ({ slide: i.slide, issue: i.issue, label: i.label }));

  // ── Outlooks missing invalidation ─────────────────────────────────────────
  const outlooksMissingInvalidation = allIssues
    .filter((i) => i.issue === "outlook_missing_observed_basis" || i.issue === "outlook_missing_projected_trajectory")
    .map((i) => ({ slide: i.slide, issue: i.issue }));

  // ── Build report ──────────────────────────────────────────────────────────
  return {
    generated_at:                   new Date().toISOString(),
    deck_version:                   DECK_QA_REPORT_VERSION,
    final_slide_count:              slides.length,
    section_slide_counts:           countSectionSlides(slides),
    source_stats: {
      total_sources_processed:      sources.length,
      relevant_sources_used:        sources.filter((s) =>
        s.main_category && MAIN_CATEGORIES.has(s.main_category)
      ).length,
      date_window:                  dateWindow,
    },
    strategic_themes_selected:      strategicThemes.map((t) => ({
      theme_id:            t.theme_id,
      theme_title:         t.theme_title,
      categories_involved: t.categories_involved,
      evidence_maturity:   t.evidence_maturity,
      confidence:          t.confidence,
    })),
    categories_with_full_sections:    categoriesWithFullSections,
    categories_collapsed_to_coverage_gap: categoriesCollapsedToCoverageGap,
    duplicate_slides_removed:         dupeSlidesRemoved,
    unsupported_bullets_removed:      unsupportedBulletsRemoved,
    claims_downgraded:                claimsDowngraded,
    analyst_judgment_bullets:         analystJudgmentBullets.slice(0, 20),
    factual_bullets_missing_url:      factualBulletsMissingUrl.slice(0, 20),
    visible_internal_ids_found:       visibleEvIds,
    outlooks_missing_invalidation:    outlooksMissingInvalidation,
    layout_issues_found:              layoutIssues.slice(0, 20),
    hard_fail_conditions_triggered:   hardFailConditions,
    qa_pass:                          qaPass,
    // Summary from upstream QA passes
    content_qa_summary: {
      slides_blocking:   qaContentReport.slides_blocking || 0,
      slides_warning:    qaContentReport.slides_warning  || 0,
      deck_qa_pass:      qaContentReport.deck_qa_pass    !== false,
    },
    notes_qa_summary: {
      slides_blocking:   notesQaReport.slides_blocking || 0,
      slides_warning:    notesQaReport.slides_warning  || 0,
      notes_qa_pass:     notesQaReport.notes_qa_pass   !== false,
    },
  };
}
