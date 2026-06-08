/**
 * L8b — Speaker Notes Deterministic QA
 *
 * Runs AFTER generateSpeakerNotesForDeck(). Validates each slide's speaker_notes
 * against the finalized slide content (headline, bullets, evidence_callouts, citations).
 *
 * Rules:
 *   Rule 1 — No new numbers beyond slide content and approved evidence.
 *             Numbers in speaker notes that are not in bullets/headline/callout key_facts
 *             are flagged as hallucinated statistics.
 *
 *   Rule 2 — No new source names beyond citations and evidence callouts.
 *             Publisher names mentioned in speaker notes that are not in citations
 *             or evidence_callouts are flagged as phantom sources.
 *
 *   Rule 3 — No unsupported trend/growth certainty language.
 *             Same prohibited phrases as slide QA, applied to speaker notes.
 *             Exception: trend_claim slides may use trend language.
 *
 *   Rule 4 — No unsupported outlook certainty.
 *             Outlook slides must not assert future certainty.
 *             Phrases like "will certainly", "is confirmed", "definitively shows" are blocked.
 *
 *   Rule 5 — Caveat must be mentioned when slide.caveats is set.
 *             A warning is raised if the slide has a caveat but speaker notes don't
 *             acknowledge uncertainty.
 *
 * Severity:
 *   blocking — note must be regenerated or replaced with deterministic fallback
 *   warning  — degrades credibility; reviewer should check
 *   info     — minor issue
 *
 * If blocking: replace with concise deterministic speaker notes from slide content only.
 *
 * Output per slide: slide with notes_qa field added.
 * Output overall:  report with blocking_count, warning_count.
 */

// ── Number extraction ─────────────────────────────────────────────────────────

const NUMBER_RE = /\b(\d[\d,]*(?:\.\d+)?(?:\+|k|K|M|B|%)?)\b/g;

function extractNumbers(text) {
  return new Set(
    [...(text || "").matchAll(NUMBER_RE)]
      .map((m) => m[1].toLowerCase().replace(/,/g, ""))
      .filter((n) => !/^(19|20)\d{2}$/.test(n) && !/^[1-9]$/.test(n))
  );
}

function slideContentNumbers(slide) {
  const texts = [
    slide.headline || "",
    ...(slide.bullets || []),
    ...(slide.evidence_callouts || []).map((c) => c.key_fact || ""),
    ...(slide.evidence_callouts || []).map((c) => c.title || ""),
  ].join(" ");
  return extractNumbers(texts);
}

// ── Publisher/source extraction ────────────────────────────────────────────────

function normalizePublisher(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slidePublishers(slide) {
  const publishers = new Set();
  for (const c of slide.evidence_callouts || []) {
    if (c.publisher) publishers.add(normalizePublisher(c.publisher));
  }
  for (const citation of slide.citations || []) {
    // "Publisher — Title (URL)"
    const match = citation.match(/^(.+?)\s+—/);
    if (match) publishers.add(normalizePublisher(match[1]));
  }
  return publishers;
}

// Extract apparent publisher mentions from free text.
// This is a heuristic — catches "According to Anthropic", "Google researchers found", etc.
const ACCORDING_TO_RE = /according to\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\s*[,.(]|$)/gi;
const RESEARCHERS_RE  = /([A-Z][A-Za-z0-9\s&.]+?)\s+(?:researchers?|analysts?|report|published|found|disclosed)/g;

function extractMentionedPublishers(text) {
  const found = [];
  for (const [, pub] of (text || "").matchAll(ACCORDING_TO_RE)) {
    found.push(pub.trim());
  }
  for (const [, pub] of (text || "").matchAll(RESEARCHERS_RE)) {
    const p = pub.trim();
    if (p.split(" ").length <= 4) found.push(p); // avoid long false positives
  }
  return found.map(normalizePublisher).filter(Boolean);
}

// ── Unsupported trend/certainty phrases ───────────────────────────────────────

const UNSUPPORTED_TREND_RE = /\b(tripling|doubling|fastest\s+grow|rapid(?:ly)?\s+grow(?:ing)?|rapid\s+growth|dominate[sd]?|outpac(?:e[sd]?|ing)|surg(?:e[sd]?|ing))\b/i;
const OUTLOOK_CERTAINTY_RE = /\b(will\s+(?:certainly|definitely|surely)|is\s+(?:confirmed|proven|established|guaranteed)|definitively\s+show[s]?|it\s+is\s+(?:certain|inevitable))\b/i;
const FAKE_EVIDENCE_FRAME   = /\bthe evidence (?:confirms?|proves?|demonstrates? that|establishes)\b/i;

// ── Deterministic fallback for blocked notes ──────────────────────────────────

function safeDeterministicNotes(slide) {
  const parts = [`${slide.headline || slide.title}.`];
  if ((slide.bullets || []).length > 0) {
    parts.push(`Key points: ${slide.bullets.slice(0, 3).join("; ")}.`);
  }
  if ((slide.evidence_callouts || []).length > 0) {
    const ev = slide.evidence_callouts[0];
    if (ev.key_fact) parts.push(`${ev.publisher ? `${ev.publisher} reports: ` : ""}${ev.key_fact}`);
  }
  if (slide.caveats) {
    parts.push(`Note: ${slide.caveats}`);
  }
  return parts.join(" ");
}

// ── Per-slide QA ──────────────────────────────────────────────────────────────

function qaNotes(slide, opts = {}) {
  const { strict = true } = opts;
  const notes = slide.speaker_notes || "";
  const issues = [];

  // Skip structural slides with no real notes
  if (!notes.trim() || ["title", "appendix", "appendix_evidence_index", "appendix_analytics_tables", "appendix_taxonomy"].includes(slide.slide_type)) {
    return { slide, issues: [], qa_pass: true, severity: "none" };
  }

  // --- Rule 1: No new numbers ---
  const approved = slideContentNumbers(slide);
  const inNotes  = extractNumbers(notes);
  for (const num of inNotes) {
    if (!approved.has(num)) {
      issues.push({
        issue:    "new_number_in_speaker_notes",
        severity: "blocking",
        label:    `Number "${num}" in speaker notes was not found in slide headline, bullets, or evidence callout key_facts`,
        number:   num,
      });
    }
  }

  // --- Rule 2: No new source names ---
  const approvedPublishers = slidePublishers(slide);
  const mentionedPublishers = extractMentionedPublishers(notes);
  for (const pub of mentionedPublishers) {
    if (!approvedPublishers.has(pub)) {
      // Fuzzy: check if any approved publisher starts with or contains the mentioned one
      const partialMatch = [...approvedPublishers].some(
        (ap) => ap.includes(pub) || pub.includes(ap)
      );
      if (!partialMatch && pub.length > 4) {
        issues.push({
          issue:    "phantom_source_in_speaker_notes",
          severity: "warning",
          label:    `Publisher "${pub}" mentioned in speaker notes does not appear in slide citations or evidence callouts`,
          publisher: pub,
        });
      }
    }
  }

  // --- Rule 3: No unsupported trend/growth certainty (except trend_claim slides) ---
  if (slide.slide_type !== "trend_claim" && slide.claim_type !== "trend_claim") {
    const match = notes.match(UNSUPPORTED_TREND_RE);
    if (match) {
      issues.push({
        issue:    "unsupported_trend_language_in_notes",
        severity: "blocking",
        label:    `"${match[0]}" in speaker notes requires analytics backing. Use "observed pattern" or "the evidence suggests" instead`,
        phrase:   match[0],
      });
    }
  }

  // --- Rule 4: No unsupported outlook certainty ---
  const OUTLOOK_TYPES = new Set(["outlook_6month", "outlook"]);
  if (OUTLOOK_TYPES.has(slide.slide_type) || slide.claim_type === "outlook") {
    const certMatch = notes.match(OUTLOOK_CERTAINTY_RE) || notes.match(FAKE_EVIDENCE_FRAME);
    if (certMatch) {
      issues.push({
        issue:    "unsupported_outlook_certainty",
        severity: "blocking",
        label:    `"${certMatch[0]}" in speaker notes asserts certainty about a future outcome — outlook projections must be conditional`,
        phrase:   certMatch[0],
      });
    }
  }

  // --- Rule 5: Caveat must be acknowledged if slide has one ---
  if (slide.caveats) {
    // Check if any uncertainty hedging is present
    const uncertaintyPresent = /\b(caveat|limitation|uncertainty|limited|insufficient|not confirmed|unclear|unverified|confidence)\b/i.test(notes);
    if (!uncertaintyPresent) {
      issues.push({
        issue:    "missing_caveat_acknowledgment",
        severity: "warning",
        label:    `Slide has caveat "${slide.caveats.slice(0, 80)}" but speaker notes do not acknowledge uncertainty`,
      });
    }
  }

  const blockingIssues = issues.filter((i) => i.severity === "blocking");
  const fixedNotes = (strict && blockingIssues.length > 0)
    ? safeDeterministicNotes(slide)
    : notes;

  const fixedSlide = {
    ...slide,
    speaker_notes: fixedNotes,
    notes_qa: {
      qa_pass:        blockingIssues.length === 0,
      issues,
      blocking_count: blockingIssues.length,
      warning_count:  issues.filter((i) => i.severity === "warning").length,
      replaced_with_deterministic: strict && blockingIssues.length > 0,
    },
  };

  return {
    slide:    fixedSlide,
    issues,
    qa_pass:  blockingIssues.length === 0,
    severity: blockingIssues.length > 0 ? "blocking" : issues.length > 0 ? "warning" : "none",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run deterministic speaker-notes QA on all slides.
 *
 * @param {object[]} slides  - Slides with speaker_notes set (from generateSpeakerNotesForDeck)
 * @param {object}   [opts]
 * @param {boolean}  [opts.strict=true]  - Replace blocking notes with deterministic fallback
 * @returns {{ slides: object[], report: object }}
 */
export function qaSpeakerNotes(slides, opts = {}) {
  const { strict = true } = opts;
  const results  = [];
  let totalBlocking = 0;
  let totalWarnings = 0;

  for (const slide of slides) {
    const { slide: fixedSlide, issues, severity } = qaNotes(slide, { strict });
    results.push(fixedSlide);
    if (severity === "blocking") totalBlocking++;
    if (severity === "warning")  totalWarnings++;
  }

  const phantomSources  = results.filter((s) => (s.notes_qa?.issues || []).some((i) => i.issue === "phantom_source_in_speaker_notes"));
  const newNumbers      = results.filter((s) => (s.notes_qa?.issues || []).some((i) => i.issue === "new_number_in_speaker_notes"));
  const trendViolations = results.filter((s) => (s.notes_qa?.issues || []).some((i) => i.issue === "unsupported_trend_language_in_notes"));
  const certViolations  = results.filter((s) => (s.notes_qa?.issues || []).some((i) => i.issue === "unsupported_outlook_certainty"));
  const replaced        = results.filter((s) => s.notes_qa?.replaced_with_deterministic);

  if (totalBlocking > 0 || totalWarnings > 0) {
    process.stdout.write(
      `  [L8b-notes-qa] ${totalBlocking} slides blocking, ${totalWarnings} warning\n` +
      (newNumbers.length      ? `    new numbers in notes: slides ${newNumbers.map((s) => s.slide_number).join(", ")}\n` : "") +
      (trendViolations.length ? `    trend certainty in notes: slides ${trendViolations.map((s) => s.slide_number).join(", ")}\n` : "") +
      (certViolations.length  ? `    outlook certainty in notes: slides ${certViolations.map((s) => s.slide_number).join(", ")}\n` : "") +
      (replaced.length        ? `    ${replaced.length} slides replaced with deterministic notes\n` : "")
    );
  } else {
    process.stdout.write("  [L8b-notes-qa] All speaker notes passed QA\n");
  }

  return {
    slides: results,
    report: {
      total_slides:         slides.length,
      slides_blocking:      totalBlocking,
      slides_warning:       totalWarnings,
      slides_pass:          slides.length - totalBlocking - totalWarnings,
      notes_qa_pass:        totalBlocking === 0,
      phantom_sources:      phantomSources.map((s) => ({ slide: s.slide_number, title: s.title })),
      new_numbers:          newNumbers.map((s)      => ({ slide: s.slide_number, title: s.title })),
      trend_violations:     trendViolations.map((s) => ({ slide: s.slide_number, title: s.title })),
      certainty_violations: certViolations.map((s)  => ({ slide: s.slide_number, title: s.title })),
      replaced_slides:      replaced.map((s)        => ({ slide: s.slide_number, title: s.title })),
      all_issues: results.flatMap((s) =>
        (s.notes_qa?.issues || []).map((i) => ({ slide: s.slide_number, ...i }))
      ),
    },
  };
}
