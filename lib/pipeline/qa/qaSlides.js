/**
 * Layer 8 QA — Slide Quality Assurance
 * Deterministic structural and content checks on generated slide content.
 */

function bulletText(b) {
  if (!b) return "";
  return typeof b === "object" ? (b.text || "") : String(b);
}

function wordCount(str) {
  const s = typeof str === "object" ? (str?.text || "") : (str || "");
  return s ? s.trim().split(/\s+/).length : 0;
}

// Structural slide types exempt from evidence and citation checks
const STRUCTURAL_TYPES = new Set(["title", "section_divider", "appendix"]);

// ── Check definitions ─────────────────────────────────────────────────────────
// Each entry: { severity, fn, msg }
// error   → blocks overall_pass (structural failure — visible on distributed deck)
// warning → advisory (quality issue)

const CHECKS = {
  has_headline: {
    severity: "error",
    fn:  (slide) => typeof slide.headline === "string" && slide.headline.trim().length > 0,
    msg: (slide) => `Slide ${slide.slide_number} is missing a headline.`,
  },

  bullet_count_ok: {
    severity: "error",
    fn:  (slide) => !slide.bullets || slide.bullets.length <= 5,
    msg: (slide) => `Slide ${slide.slide_number} has ${slide.bullets?.length} bullets (max 5).`,
  },

  bullets_not_too_long: {
    severity: "warning",
    fn:  (slide) => {
      if (!slide.bullets || slide.bullets.length === 0) return true;
      return slide.bullets.every((b) => wordCount(b) <= 15);
    },
    msg: (slide) => {
      const long = (slide.bullets || []).filter((b) => bulletText(b).trim().split(/\s+/).length > 15);
      return `Slide ${slide.slide_number} has ${long.length} bullet(s) exceeding 15 words.`;
    },
  },

  has_speaker_notes: {
    severity: "warning",
    fn:  (slide) => typeof slide.speaker_notes === "string" && slide.speaker_notes.trim().length > 0,
    msg: (slide) => `Slide ${slide.slide_number} is missing speaker notes.`,
  },

  has_evidence_or_citations: {
    severity: "warning",
    fn: (slide) => {
      if (STRUCTURAL_TYPES.has(slide.slide_type)) return true;
      const hasCallouts  = Array.isArray(slide.evidence_callouts) && slide.evidence_callouts.length > 0;
      const hasCitations = Array.isArray(slide.citations) && slide.citations.length > 0;
      return hasCallouts || hasCitations;
    },
    msg: (slide) => `Slide ${slide.slide_number} has no evidence callouts and no citations.`,
  },

  callouts_have_evidence_id: {
    severity: "warning",
    fn: (slide) => {
      if (STRUCTURAL_TYPES.has(slide.slide_type)) return true;
      return (slide.evidence_callouts || []).every((c) => !!c.evidence_id?.trim());
    },
    msg: (slide) => `Slide ${slide.slide_number} has an evidence callout missing an evidence_id.`,
  },
};

// ── CVE & named-entity grounding check ───────────────────────────────────────
// Extracts CVE IDs from all slide bullet text and verifies each against the
// evidence dossier. A CVE ID not present in any evidence item is a hallucination.
// Also flags named CVE-like references in speaker notes.

const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/gi;

/**
 * Extract all CVE IDs referenced in slide bullets and speaker notes.
 */
function extractSlideCveIds(slide) {
  const texts = [
    ...(slide.bullets  || []).map(bulletText),
    slide.speaker_notes || "",
    slide.headline      || "",
  ];
  const ids = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(CVE_PATTERN)) ids.add(m[0].toUpperCase());
  }
  return ids;
}

/**
 * Build a set of all CVE IDs present in the evidence dossier
 * (rawfact evidence items passed via feedSources.evidence_items).
 */
function buildEvidenceCveSet(feedSources) {
  const cves = new Set();
  for (const s of (feedSources || [])) {
    for (const ei of (s.evidence_items || [])) {
      const texts = [ei.fact || "", ei.source_quote || ""];
      for (const t of texts) {
        for (const m of t.matchAll(CVE_PATTERN)) cves.add(m[0].toUpperCase());
      }
    }
    // Also check the source title / description for CVE IDs
    for (const t of [s.title || "", s.full_text?.slice(0, 500) || ""]) {
      for (const m of t.matchAll(CVE_PATTERN)) cves.add(m[0].toUpperCase());
    }
  }
  return cves;
}

/**
 * Run QA checks on generated slides.
 *
 * @param {object[]} slides      - Generated slide content objects.
 * @param {object[]} viewpoints  - Layer 6 viewpoints.
 * @param {object[]} feedSources - Feed sources.
 * @param {object[]} slidePlan   - Slide plan objects (for evidence/viewpoint context).
 * @returns {object} QA report.
 */
export function qaSlides(slides, viewpoints = [], feedSources = [], slidePlan = []) {
  const qa_issues    = [];
  const slide_results = [];
  let passed = 0;
  let failed = 0;

  const planByNumber = {};
  for (const p of slidePlan) planByNumber[p.slide_number] = p;

  // Pre-build the set of CVE IDs that exist in evidence (used for hallucination check)
  const evidenceCves = buildEvidenceCveSet(feedSources);

  for (const slide of slides) {
    const plan = planByNumber[slide.slide_number] || null;
    const checkResults = {};
    let slideFailed = false;

    for (const [checkName, check] of Object.entries(CHECKS)) {
      let pass;
      try {
        pass = !!check.fn(slide, viewpoints, feedSources, plan);
      } catch {
        pass = false;
      }

      checkResults[checkName] = pass;

      if (!pass) {
        if (check.severity === "error") slideFailed = true;
        qa_issues.push({
          slide_number: slide.slide_number,
          slide_title:  slide.title || slide.slide_title || `Slide ${slide.slide_number}`,
          check:        checkName,
          severity:     check.severity,
          message:      check.msg(slide),
        });
      }
    }

    // ── CVE hallucination check (per slide, blocking) ─────────────────────────
    // Any CVE ID referenced in slide content that does not appear in the
    // evidence dossier is a hallucination. Flagged as error (blocking).
    if (!STRUCTURAL_TYPES.has(slide.slide_type) && evidenceCves.size >= 0) {
      const slideCves = extractSlideCveIds(slide);
      for (const cve of slideCves) {
        if (!evidenceCves.has(cve)) {
          slideFailed = true;
          qa_issues.push({
            slide_number: slide.slide_number,
            slide_title:  slide.title || slide.slide_title || `Slide ${slide.slide_number}`,
            check:        "cve_not_in_evidence",
            severity:     "error",
            message:      `Slide ${slide.slide_number} references ${cve} which does not appear in any evidence item — possible hallucination.`,
            cve_id:       cve,
          });
        }
      }
    }

    if (slideFailed) failed++;
    else passed++;

    slide_results.push({
      slide_number: slide.slide_number,
      slide_title:  slide.title || slide.slide_title || `Slide ${slide.slide_number}`,
      checks:       checkResults,
    });
  }

  return {
    passed,
    failed,
    qa_issues,
    slide_results,
    overall_pass: failed === 0,
  };
}
