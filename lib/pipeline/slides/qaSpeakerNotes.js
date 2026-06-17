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

// ── Bullet text extraction (duplicated from generateSlideContent — cannot import across files) ───

function extractBulletText(b) {
  if (!b) return "";
  if (typeof b === "string") return b;
  if (typeof b === "object" && b.text) return b.text;
  return "";
}

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
    ...(slide.bullets || []).map(extractBulletText),
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
    const bulletTexts = slide.bullets.slice(0, 3).map(extractBulletText).filter(Boolean);
    if (bulletTexts.length > 0) parts.push(`Key points: ${bulletTexts.join("; ")}.`);
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
          severity: "blocking",
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

  // --- Rule 6: No bullet verbatim copy ---
  // A warning when speaker notes contain 8+ consecutive words that match a bullet verbatim.
  for (const bullet of (slide.bullets || [])) {
    const bText = extractBulletText(bullet);
    if (!bText || bText.split(/\s+/).length < 8) continue;
    // Build overlapping 8-word windows from the bullet
    const bWords = bText.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
    const notesLower = notes.toLowerCase().replace(/[^\w\s]/g, " ");
    for (let j = 0; j <= bWords.length - 8; j++) {
      const window = bWords.slice(j, j + 8).join(" ");
      if (window.length > 10 && notesLower.includes(window)) {
        issues.push({
          issue:    "bullet_verbatim_copy",
          severity: "warning",
          label:    `Speaker notes contain 8+ consecutive words matching a bullet verbatim: "${bWords.slice(j, j + 8).join(" ")}"`,
          phrase:   bWords.slice(j, j + 8).join(" "),
        });
        break; // One issue per bullet is sufficient
      }
    }
  }

  // --- Rule 7: Research-only claim must include caveat ---
  // When all evidence_callouts are research findings and slide.caveats mentions "research" or "lab",
  // the notes MUST acknowledge it.
  if (slide.evidence_callouts?.length > 0) {
    const allResearch = slide.evidence_callouts.every((c) => {
      const type = (c.evidence_type || "").toLowerCase();
      return type === "research_finding" || type === "benchmark_result";
    });
    const caveatsHaveResearch = /\b(research|lab|laboratory)\b/i.test(slide.caveats || "");
    if (allResearch && caveatsHaveResearch) {
      const notesAcknowledgeResearch = /\b(research|lab|not yet operational|not confirmed)\b/i.test(notes);
      if (!notesAcknowledgeResearch) {
        issues.push({
          issue:    "research_only_missing_caveat",
          severity: "warning",
          label:    "All evidence callouts are research findings and slide caveat mentions 'research' or 'lab', but speaker notes do not acknowledge this limitation",
        });
      }
    }
  }

  // --- Rule 8: Analytics slides must state corpus scope ---
  if (slide.slide_type === "analytics_pattern") {
    const hasScopeStatement = /\b(corpus|collected sources|sources reviewed|this analysis|based on \w+ sources)\b/i.test(notes);
    if (!hasScopeStatement) {
      issues.push({
        issue:    "analytics_missing_corpus_scope",
        severity: "warning",
        label:    "analytics_pattern slide speaker notes should state the corpus scope (e.g., 'based on N sources in our collected corpus')",
      });
    }
  }

  // --- Rule 9: Evidence-gap notes must not fabricate conclusions ---
  if (slide.slide_type === "evidence_gap") {
    const FABRICATED_CONCLUSION_RE = /\b(this confirms?|this shows? that|it is clear that|evidence demonstrates?|this proves?|confirms that|demonstrates that)\b/i;
    const fabMatch = notes.match(FABRICATED_CONCLUSION_RE);
    if (fabMatch) {
      issues.push({
        issue:    "evidence_gap_fabricated_conclusion",
        severity: "blocking",
        label:    `"${fabMatch[0]}" in speaker notes for an evidence_gap slide asserts a conclusion — gap slides must not fabricate certainty`,
        phrase:   fabMatch[0],
      });
    }
  }

  // --- Rule 10: Visual slide notes should explain the visual ---
  const sv = slide.selected_visual;
  if (sv && sv.visual_support_relationship === "direct_support") {
    const VISUAL_EXPLAIN_RE = /\b(chart|figure|visual|graph|shows|diagram|illustrates?)\b/i;
    if (!VISUAL_EXPLAIN_RE.test(notes)) {
      issues.push({
        issue:    "visual_missing_explanation",
        severity: "info",
        label:    `Slide has a direct_support visual (${sv.visualization_id}) but speaker notes do not explain what the visual proves`,
      });
    }
  }

  const blockingIssues = issues.filter((i) => i.severity === "blocking");

  // For blocking issues (new numbers / phantom publishers): attempt sentence-level
  // removal before falling back to full deterministic replacement.
  // This preserves as much of the LLM-generated content as possible.
  let fixedNotes = notes;
  let removedSentenceCount = 0;

  if (strict && blockingIssues.length > 0) {
    // Split notes into sentences and filter out any sentence that contains a
    // blocking phantom source or ungrounded number.
    const phantomPubs  = new Set(blockingIssues.filter((i) => i.publisher).map((i) => i.publisher));
    const newNums      = new Set(blockingIssues.filter((i) => i.number).map((i) => i.number));
    const sentences    = notes.split(/(?<=[.!?])\s+/);
    const cleanSents   = sentences.filter((sent) => {
      // Check for phantom publisher
      for (const pub of phantomPubs) {
        if (normalizePublisher(sent).includes(pub)) {
          process.stdout.write(`  [L8.4-qa] REMOVED sentence with ungrounded content from slide ${slide.slide_number}: "${sent.slice(0, 80)}"\n`);
          removedSentenceCount++;
          return false;
        }
      }
      // Check for new number
      const sentNums = extractNumbers(sent);
      for (const num of sentNums) {
        if (newNums.has(num)) {
          process.stdout.write(`  [L8.4-qa] REMOVED sentence with ungrounded content from slide ${slide.slide_number}: "${sent.slice(0, 80)}"\n`);
          removedSentenceCount++;
          return false;
        }
      }
      return true;
    });

    if (cleanSents.length >= 2) {
      // Enough sentences remain after removal — no full fallback needed
      fixedNotes = cleanSents.join(" ");
    } else {
      // Too few sentences after removal — use full deterministic fallback
      fixedNotes = safeDeterministicNotes(slide);
    }
  }

  const fixedSlide = {
    ...slide,
    speaker_notes: fixedNotes,
    notes_qa: {
      qa_pass:                       blockingIssues.length === 0,
      issues,
      blocking_count:                blockingIssues.length,
      warning_count:                 issues.filter((i) => i.severity === "warning").length,
      replaced_with_deterministic:   strict && blockingIssues.length > 0 && removedSentenceCount === 0,
      sentences_removed:             removedSentenceCount,
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
      `  [L8.4-notes-qa] ${totalBlocking} slides blocking, ${totalWarnings} warning\n` +
      (newNumbers.length      ? `    new numbers in notes (sentences REMOVED): slides ${newNumbers.map((s) => s.slide_number).join(", ")}\n` : "") +
      (phantomSources.length  ? `    phantom publishers (sentences REMOVED): slides ${phantomSources.map((s) => s.slide_number).join(", ")}\n` : "") +
      (trendViolations.length ? `    trend certainty in notes: slides ${trendViolations.map((s) => s.slide_number).join(", ")}\n` : "") +
      (certViolations.length  ? `    outlook certainty in notes: slides ${certViolations.map((s) => s.slide_number).join(", ")}\n` : "") +
      (replaced.length        ? `    ${replaced.length} slides replaced with deterministic notes (sentence removal insufficient)\n` : "")
    );
  } else {
    process.stdout.write("  [L8.4-notes-qa] All speaker notes passed QA\n");
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
