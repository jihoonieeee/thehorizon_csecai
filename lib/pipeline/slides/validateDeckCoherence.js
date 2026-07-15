/**
 * validateDeckCoherence()
 *
 * Cross-slide coherence check run AFTER all slides are generated and BEFORE
 * final rendering. Returns structured issues; the caller decides whether to
 * block rendering, revise, or log.
 *
 * All checks are deterministic (no LLM). They catch:
 *   1.  Duplicate claims         — same argument on two slides (Jaccard ≥ 0.55)
 *   2.  Repeated facts           — same bullet text on multiple slides
 *   3.  Unsupported factual claims — claim/data_point bullet with no evidence_id
 *   4.  Unresolved evidence ptrs — evidence_id cited but not in evidenceIndex
 *   5.  Number drift             — number in bullet text that is absent from cited evidence
 *   6.  Source overuse           — same source URL cited on > maxSourceUse slides
 *   7.  Unused high-priority ev  — evidence with importance_tier "realized" never cited
 *   8.  Reporting-window violation — cited evidence with event_date outside the window
 *   9.  Overall slides adding    — overall/cross_category slides introducing claims not
 *       unsupported new claims     grounded in per-category evidence
 *  10.  Weak case study          — case_study slide with < 3 evidence bullets
 *  11.  Missing slide role       — slide plan entry without slide_role assigned
 *  12.  Outlook without precursors — forecast claim with no cited evidence chain
 */

// ── Tokenisation helpers ──────────────────────────────────────────────────────

function tokenise(text) {
  return new Set(String(text || "").toLowerCase().match(/\b[a-z0-9]{3,}\b/g) || []);
}

function jaccard(a, b) {
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// Extract bare digit strings from bullet text so we can match them against evidence.
function extractDigits(text) {
  return (text || "").match(/\b\d[\d,.%×x$]*\b/g)?.map(d => d.replace(/[^0-9.]/g, "")) || [];
}

function evidenceNumbersSet(ev) {
  const nums = new Set();
  for (const n of ev?.numbers || []) {
    const d = String(n.value || "").replace(/[^0-9.]/g, "");
    if (d) nums.add(d);
  }
  // Also extract from fact + quote text directly
  for (const d of extractDigits(ev?.fact || "") ) nums.add(d);
  for (const d of extractDigits(ev?.quote || "")) nums.add(d);
  return nums;
}

// ── Main validation ───────────────────────────────────────────────────────────

const FACTUAL_BULLET_TYPES = new Set(["claim", "data_point"]);
const SKIP_SLIDE_TYPES     = new Set(["cover", "section_intro", "references"]);
const OVERALL_SLIDE_TYPES  = new Set([
  "executive_summary", "overall_developments", "overall_insights", "cross_category",
]);

/**
 * @param {object[]} slides         - Generated slides array from buildPresentation
 * @param {object}   evidenceIndex  - { [evidence_id]: evidenceItem }
 * @param {object}   [opts]
 * @param {string}   [opts.windowStart]     - ISO date string (YYYY-MM-DD)
 * @param {string}   [opts.windowEnd]       - ISO date string
 * @param {number}   [opts.maxSourceUse=4]  - Flag source cited on more than N slides
 * @param {number}   [opts.dupJaccard=0.55] - Jaccard threshold for duplicate claim detection
 * @returns {{ issues: object[], counts: object }}
 */
export function validateDeckCoherence(slides, evidenceIndex, opts = {}) {
  const {
    windowStart  = null,
    windowEnd    = null,
    maxSourceUse = 4,
    dupJaccard   = 0.55,
  } = opts;

  const issues = [];
  function issue(type, data) { issues.push({ type, ...data }); }

  const ws = windowStart ? new Date(windowStart) : null;
  const we = windowEnd   ? new Date(windowEnd)   : null;

  // ── Build lookup structures ───────────────────────────────────────────────

  // Per-bullet source URL usage count: { source_url → [slide_number, ...] }
  const sourceUrlSlides = new Map();
  // Bullet text tokens for duplicate detection
  const bulletEntries = [];  // { tokens, text, slide_number, slide_type }
  // All cited evidence IDs across the deck
  const allCitedEvidenceIds = new Set();
  // Per-category evidence IDs cited (used for overall-slide check)
  const categoryEvidenceUsed = {};

  for (const slide of slides) {
    if (SKIP_SLIDE_TYPES.has(slide.type)) continue;
    const sn = slide.slide_number || 0;
    const cat = slide.category || null;

    for (const b of slide.bullets || []) {
      if (!b.text || b.text.length < 10) continue;

      const tokens = tokenise(b.text);
      bulletEntries.push({ tokens, text: b.text, slide_number: sn, slide_type: slide.type, bullet_type: b.bullet_type });

      // Track source usage
      if (b.evidence_id) {
        allCitedEvidenceIds.add(b.evidence_id);
        const ev = evidenceIndex[b.evidence_id];
        if (ev?.source_url) {
          if (!sourceUrlSlides.has(ev.source_url)) sourceUrlSlides.set(ev.source_url, []);
          sourceUrlSlides.get(ev.source_url).push(sn);
        }
        // Track per-category usage
        if (cat && !OVERALL_SLIDE_TYPES.has(slide.type)) {
          if (!categoryEvidenceUsed[cat]) categoryEvidenceUsed[cat] = new Set();
          categoryEvidenceUsed[cat].add(b.evidence_id);
        }
      }
      // Also count from slide.citations
      for (const cid of slide.citations || []) {
        if (typeof cid === "string" && cid.startsWith("ev-")) allCitedEvidenceIds.add(cid);
      }
    }
  }

  // ── Check 1: Duplicate claims (Jaccard ≥ dupJaccard across slides) ────────
  const seenPairs = new Set();
  for (let i = 0; i < bulletEntries.length; i++) {
    for (let j = i + 1; j < bulletEntries.length; j++) {
      if (bulletEntries[i].slide_number === bulletEntries[j].slide_number) continue;
      const key = `${Math.min(i,j)}-${Math.max(i,j)}`;
      if (seenPairs.has(key)) continue;
      const sim = jaccard(bulletEntries[i].tokens, bulletEntries[j].tokens);
      if (sim >= dupJaccard) {
        seenPairs.add(key);
        issue("duplicate_claim", {
          similarity: +sim.toFixed(2),
          slide_a: bulletEntries[i].slide_number,
          slide_b: bulletEntries[j].slide_number,
          text_a: bulletEntries[i].text.slice(0, 120),
          text_b: bulletEntries[j].text.slice(0, 120),
        });
      }
    }
  }

  // ── Check 2: Repeated fact (exact or near-exact — Jaccard ≥ 0.80) ─────────
  // Higher threshold than duplicate_claim; this catches verbatim copy-paste.
  for (let i = 0; i < bulletEntries.length; i++) {
    for (let j = i + 1; j < bulletEntries.length; j++) {
      if (bulletEntries[i].slide_number === bulletEntries[j].slide_number) continue;
      const sim = jaccard(bulletEntries[i].tokens, bulletEntries[j].tokens);
      if (sim >= 0.80) {
        issue("repeated_fact", {
          similarity: +sim.toFixed(2),
          slide_a: bulletEntries[i].slide_number,
          slide_b: bulletEntries[j].slide_number,
          text: bulletEntries[i].text.slice(0, 120),
        });
        break; // one per bullet
      }
    }
  }

  // ── Check 3: Unsupported factual claims ───────────────────────────────────
  for (const slide of slides) {
    if (SKIP_SLIDE_TYPES.has(slide.type)) continue;
    for (const b of slide.bullets || []) {
      if (FACTUAL_BULLET_TYPES.has(b.bullet_type) && !b.evidence_id) {
        issue("unsupported_claim", {
          slide_number: slide.slide_number,
          slide_type:   slide.type,
          text:         (b.text || "").slice(0, 120),
        });
      }
    }
  }

  // ── Check 4: Unresolved evidence pointers ─────────────────────────────────
  for (const slide of slides) {
    if (SKIP_SLIDE_TYPES.has(slide.type)) continue;
    for (const b of slide.bullets || []) {
      if (b.evidence_id && !(b.evidence_id in evidenceIndex)) {
        issue("unresolved_evidence_id", {
          slide_number: slide.slide_number,
          evidence_id:  b.evidence_id,
        });
      }
    }
    for (const cid of slide.citations || []) {
      if (typeof cid === "string" && cid.startsWith("ev-") && !(cid in evidenceIndex)) {
        issue("unresolved_citation", {
          slide_number: slide.slide_number,
          citation:     cid,
        });
      }
    }
  }

  // ── Check 5: Number drift ─────────────────────────────────────────────────
  // A number in a bullet text that does not appear in the cited evidence item.
  for (const slide of slides) {
    if (SKIP_SLIDE_TYPES.has(slide.type)) continue;
    for (const b of slide.bullets || []) {
      if (!b.evidence_id) continue;
      const ev = evidenceIndex[b.evidence_id];
      if (!ev) continue;
      const bulletDigits = extractDigits(b.text);
      const evDigits = evidenceNumbersSet(ev);
      for (const d of bulletDigits) {
        if (d.length >= 2 && !evDigits.has(d)) {
          // Allow small integers (≤ 9) that are likely ordinal/structural, not statistics.
          const n = parseFloat(d);
          if (!isNaN(n) && n <= 9) continue;
          issue("number_drift", {
            slide_number: slide.slide_number,
            evidence_id:  b.evidence_id,
            number_in_bullet:   d,
            text: (b.text || "").slice(0, 120),
          });
          break; // one per bullet
        }
      }
    }
  }

  // ── Check 6: Source overuse ───────────────────────────────────────────────
  for (const [url, slideNums] of sourceUrlSlides) {
    const unique = new Set(slideNums);
    if (unique.size > maxSourceUse) {
      issue("source_overuse", {
        source_url:     url,
        slide_count:    unique.size,
        slide_numbers:  [...unique].sort((a, b) => a - b),
      });
    }
  }

  // ── Check 7: Unused high-priority evidence ────────────────────────────────
  for (const [evId, ev] of Object.entries(evidenceIndex)) {
    const tier = ev.importance_tier || ev.intelligence?.importance?.tier || null;
    if (tier === "realized" && !allCitedEvidenceIds.has(evId)) {
      issue("unused_priority_evidence", {
        evidence_id:   evId,
        source_title:  ev.source_title || ev.source_id,
        importance_tier: "realized",
        fact:          (ev.fact || "").slice(0, 100),
      });
    }
  }

  // ── Check 8: Reporting-window violations ──────────────────────────────────
  if (ws && we) {
    for (const evId of allCitedEvidenceIds) {
      const ev = evidenceIndex[evId];
      if (!ev) continue;
      const evDate = ev.event_date || null;
      if (!evDate || ev.time_basis === "unknown") continue;
      const d = new Date(evDate);
      if (d < ws || d > we) {
        issue("reporting_window_violation", {
          evidence_id:  evId,
          event_date:   evDate,
          time_basis:   ev.time_basis,
          window_start: windowStart,
          window_end:   windowEnd,
        });
      }
    }
  }

  // ── Check 9: Overall slides adding new unsupported claims ─────────────────
  // Overall slides should synthesize per-category findings, not introduce new ones.
  // Heuristic: an overall slide bullet with an evidence_id not cited in ANY per-category
  // slide of the matching category is suspect.
  const allCategoryEvidence = new Set(Object.values(categoryEvidenceUsed).flatMap(s => [...s]));
  for (const slide of slides) {
    if (!OVERALL_SLIDE_TYPES.has(slide.type)) continue;
    for (const b of slide.bullets || []) {
      if (!b.evidence_id) continue;
      if (!allCategoryEvidence.has(b.evidence_id)) {
        issue("overall_slide_new_claim", {
          slide_number: slide.slide_number,
          slide_type:   slide.type,
          evidence_id:  b.evidence_id,
          text:         (b.text || "").slice(0, 120),
          note:         "Evidence cited in overall/exec slide was not cited in any per-category slide.",
        });
      }
    }
  }

  // ── Check 10: Weak case study ─────────────────────────────────────────────
  for (const slide of slides) {
    if (slide.type !== "case_study") continue;
    const factualBullets = (slide.bullets || []).filter(b => FACTUAL_BULLET_TYPES.has(b.bullet_type));
    if (factualBullets.length < 3) {
      issue("weak_case_study", {
        slide_number:  slide.slide_number,
        category:      slide.category,
        factual_count: factualBullets.length,
        note:          "Case study should have ≥3 factual bullets to tell a complete attack story.",
      });
    }
  }

  // ── Check 11: Missing slide role ─────────────────────────────────────────
  for (const slide of slides) {
    if (SKIP_SLIDE_TYPES.has(slide.type)) continue;
    if (slide.type === "references") continue;
    if (!slide.slide_role) {
      issue("missing_slide_role", {
        slide_number: slide.slide_number,
        slide_type:   slide.type,
      });
    }
  }

  // ── Check 12: Outlook without precursor evidence ──────────────────────────
  for (const slide of slides) {
    if (slide.type !== "early_signals_watchlist" && slide.type !== "outlook_tiered") continue;
    const hasCites = (slide.bullets || []).some(b => b.evidence_id || (b.cite_nums?.length));
    const hasCitations = (slide.citations || []).some(c => typeof c === "string" && c.startsWith("ev-"));
    if (!hasCites && !hasCitations) {
      issue("outlook_unsupported", {
        slide_number: slide.slide_number,
        slide_type:   slide.type,
        note:         "Outlook slide has no cited evidence anchoring its forecasts.",
      });
    }
  }

  // ── Summary counts ─────────────────────────────────────────────────────────
  const counts = {};
  for (const iss of issues) {
    counts[iss.type] = (counts[iss.type] || 0) + 1;
  }

  return { issues, counts };
}
