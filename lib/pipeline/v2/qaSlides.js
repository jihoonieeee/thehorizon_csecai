/**
 * v2 — qaSlides()
 *
 * Deterministic QA pass for v2 slide decks. Runs after slide content
 * generation and diagram attachment, before traceability validation.
 *
 * v2 slide shape uses bullet_type ('claim'|'data_point'|'implication'|
 * 'recommendation'|'signal'|'context') rather than the v1 bullet_role taxonomy.
 *
 * Checks (all mutate slides in-place where a safe fix exists):
 *   1. ev_* ID leak        — evidence IDs stripped from visible bullet text
 *   2. Prohibited phrases  — unsubstantiated hype quantifiers flagged
 *   3. Claim bullet orphan — claim/data_point bullets without evidence backing
 *   4. Numeric orphan      — statistics in claim bullets not backed by evidence
 */

// Slide types to run QA on. Skip deterministic stubs.
const QA_TYPES = new Set([
  "executive_summary", "top_happenings", "category_trends",
  "category_insights", "monitoring_signals", "case_study",
  "cross_category", "early_signals_watchlist", "outlook_structured",
]);

// Phrases that are acceptable only when backed by a quoted statistic.
const PROHIBITED_PHRASES = [
  /\b(?:tripling|quadrupling|quintupling)\b/gi,
  /\b(?:explosive|skyrocket(?:ing|ed)?)\b/gi,
  /\bdominated? the (?:market|landscape|field|industry)\b/gi,
  /\bnow represents? (?:the )?(?:majority|most)\b/gi,
];

const EV_LEAK_RE   = /\bev-[a-f0-9]{8}-\d+\b/g;
const STAT_RE      = /\b\d+(?:\.\d+)?(?:\s*%|\s+(?:percent|times|x|fold))\b/gi;

/**
 * Run deterministic QA on a v2 slide deck. Mutates slides in place for safe
 * fixes (ev_* leaks). Returns the full issue list for reporting.
 *
 * @param {object[]} slides        - From buildPresentation()
 * @param {object}   evidenceIndex - { [evidence_id]: evidenceItem }
 * @returns {{ issues: object[], counts: object }}
 */
export function qaSlides(slides, evidenceIndex = {}) {
  const issues = [];

  // Pre-build evidence text corpus for numeric grounding check
  const allEvidenceFacts = Object.values(evidenceIndex)
    .map(e => `${e.fact || ""} ${e.quote || ""}`)
    .join(" ");

  for (const slide of slides) {
    if (!QA_TYPES.has(slide.type)) continue;
    const bullets = slide.bullets || [];

    for (let bi = 0; bi < bullets.length; bi++) {
      const bullet = bullets[bi];
      if (typeof bullet !== "object" || !bullet.text) continue;

      const { text, bullet_type, evidence_id } = bullet;

      // 1. ev_* leak — strip evidence IDs that leaked into visible text
      if (EV_LEAK_RE.test(text)) {
        EV_LEAK_RE.lastIndex = 0;
        bullets[bi] = {
          ...bullet,
          text: text.replace(EV_LEAK_RE, "").replace(/\s{2,}/g, " ").trim(),
        };
        issues.push({
          slide_number: slide.slide_number,
          slide_type:   slide.type,
          type:         "ev_id_leak",
          severity:     "warning",
          original:     text.slice(0, 120),
        });
        EV_LEAK_RE.lastIndex = 0;
      }

      // 2. Prohibited phrases — flag only (no auto-replacement; human review)
      for (const re of PROHIBITED_PHRASES) {
        const match = text.match(re);
        if (match) {
          issues.push({
            slide_number: slide.slide_number,
            slide_type:   slide.type,
            type:         "prohibited_phrase",
            severity:     "warning",
            phrase:       match[0],
            text:         text.slice(0, 120),
          });
        }
        re.lastIndex = 0;
      }

      // 3. Claim/data_point bullet without evidence backing
      if (["claim", "data_point"].includes(bullet_type)) {
        const hasResolvedId = evidence_id && Boolean(evidenceIndex[evidence_id]);
        const hasCitationFallback = !hasResolvedId &&
          (slide.citations || []).some(c => typeof c === "string" && c.startsWith("ev-"));
        if (!hasResolvedId && !hasCitationFallback) {
          issues.push({
            slide_number: slide.slide_number,
            slide_type:   slide.type,
            type:         "claim_bullet_orphan",
            severity:     "warning",
            evidence_id:  evidence_id || null,
            text:         text.slice(0, 120),
          });
        }
      }

      // 4. Numeric orphan — stat in claim bullet not present in any evidence
      if (["claim", "data_point"].includes(bullet_type)) {
        const stats = [...(text.matchAll(STAT_RE))].map(m => m[0]);
        for (const stat of stats) {
          const num = stat.match(/[\d.]+/)?.[0];
          if (num && !allEvidenceFacts.includes(num)) {
            issues.push({
              slide_number: slide.slide_number,
              slide_type:   slide.type,
              type:         "numeric_orphan",
              severity:     "warning",
              statistic:    stat,
              text:         text.slice(0, 120),
            });
          }
        }
        STAT_RE.lastIndex = 0;
      }
    }
  }

  const byType = issues.reduce((acc, i) => {
    acc[i.type] = (acc[i.type] || 0) + 1;
    return acc;
  }, {});

  return { issues, counts: byType };
}
