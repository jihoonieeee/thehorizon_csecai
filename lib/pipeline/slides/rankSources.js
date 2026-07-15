/**
 * rankSources() — Multi-factor source ranking for slide evidence prioritization.
 *
 * Scores each source across 8 dimensions and returns it with ranking_score and
 * ranking_tier attached. Slide writers should prefer tier_1/tier_2 sources for
 * lead evidence; tier_3 for baselines; tier_4 should not anchor claims.
 *
 * Does NOT filter sources — all are returned with scores for downstream use.
 *
 * Ranking dimensions:
 *   1. Primary-source authority (trust_tier)
 *   2. Strategic significance (intelligence.importance.tier)
 *   3. AI specificity (ai_specificity_score)
 *   4. Event timeframe relevance (event date in reporting window)
 *   5. Novelty within the reporting window
 *   6. Evidence maturity (claim_extraction_status + intelligence)
 *   7. Case-study potential (named entity + attack stages)
 *   8. Distinct technique contribution vs. the rest of the corpus
 *
 * Note: a recent "Critical" source does NOT automatically outrank a more relevant
 * primary-source authority item. The scoring weights authority equally against
 * strategic significance and timeframe relevance.
 */

// ── Scoring tables ────────────────────────────────────────────────────────────

const AUTHORITY_SCORE = {
  primary:  25,
  curated:  20,
  high:     20,
  medium:   12,
  low:       4,
  unknown:   2,
};

const IMPORTANCE_SCORE = {
  realized:  20,
  proven:    15,
  research:   8,
  reference:  3,
  noise:      0,
};

// ── Per-source scoring ────────────────────────────────────────────────────────

/**
 * Score a single source.
 *
 * @param {object} source        - Source row (DB or understandSource output shape)
 * @param {object} [opts]
 * @param {Date}   [opts.windowStart]      - Reporting window start (Date object or ISO string)
 * @param {Date}   [opts.windowEnd]        - Reporting window end
 * @param {Set}    [opts.seenTechTags]     - Set of technique_tags already seen in ranked set
 *                                           (passed in call order; mutated in place)
 * @returns {object} source enriched with ranking_score, ranking_tier, ranking_breakdown
 */
export function scoreSource(source, opts = {}) {
  const {
    windowStart = null,
    windowEnd   = null,
    seenTechTags = new Set(),
  } = opts;

  const intel = source.intelligence || {};
  const importanceTier = intel.importance?.tier || intel.importance_tier || null;

  // 1. Authority — trust_tier (0–25 pts)
  const authorityScore = AUTHORITY_SCORE[source.trust_tier] ?? 2;

  // 2. Strategic significance — importance tier (0–20 pts)
  const importanceScore = IMPORTANCE_SCORE[importanceTier] ?? 0;

  // 3. AI specificity (0–20 pts)
  const aiSpec = Math.max(0, Math.min(100, source.ai_specificity_score || 0));
  const aiScore = Math.round((aiSpec / 100) * 20);

  // 4. Event timeframe relevance (0–15 pts)
  // Prefer sources where the reported event date falls inside the reporting window.
  // Evidence items carry event_date; the source's date_published is a proxy.
  let timeframeScore = 0;
  const eventDate = source.event_date || source.date_published || null;
  if (eventDate && windowStart && windowEnd) {
    const d = new Date(eventDate);
    const ws = new Date(windowStart);
    const we = new Date(windowEnd);
    if (d >= ws && d <= we) {
      timeframeScore = 15;
    } else if (d >= new Date(ws.getTime() - 30 * 86400_000) && d < ws) {
      // Just before the window — useful as baseline
      timeframeScore = 5;
    }
  } else if (windowStart == null) {
    // No window supplied — give partial credit to all sources
    timeframeScore = 8;
  }

  // 5. Novelty within window (0–10 pts)
  // Fresh sources from the last 30 days of the window get a novelty bonus.
  let noveltyScore = 0;
  if (source.date_published && windowEnd) {
    const pub = new Date(source.date_published);
    const we  = new Date(windowEnd);
    const daysBeforeEnd = (we - pub) / 86400_000;
    if (daysBeforeEnd >= 0 && daysBeforeEnd <= 30)  noveltyScore = 10;
    else if (daysBeforeEnd > 30 && daysBeforeEnd <= 90) noveltyScore = 5;
  } else {
    noveltyScore = 3; // unknown date — modest credit
  }

  // 6. Evidence maturity (0–10 pts)
  // Graded: operational sources > disclosed CVEs > research > expert assessment
  let maturityScore = 0;
  if (source.claim_extraction_status === "success") {
    const claims = Array.isArray(intel.main_claims) ? intel.main_claims : [];
    if (claims.length >= 3) maturityScore = 10;
    else if (claims.length >= 1) maturityScore = 6;
    else maturityScore = 3;
  }

  // 7. Case-study potential (0–5 pts)
  // A source with named entities AND attack walkthroughs is highly valuable for case studies.
  let caseStudyScore = 0;
  const hasWalkthrough = Array.isArray(intel.report_analysis?.attack_walkthroughs)
    && intel.report_analysis.attack_walkthroughs.length >= 1;
  const hasNamedEntities = Array.isArray(intel.key_entities) && intel.key_entities.length >= 2;
  if (hasWalkthrough && hasNamedEntities) caseStudyScore = 5;
  else if (hasWalkthrough || hasNamedEntities) caseStudyScore = 2;

  // 8. Distinct technique contribution (0–5 pts)
  // Sources covering technique tags not yet seen in the ranked set add unique coverage.
  let distinctScore = 0;
  const sourceTags = new Set(Array.isArray(source.tags) ? source.tags : []);
  if (sourceTags.size > 0) {
    const newTags = [...sourceTags].filter(t => !seenTechTags.has(t));
    if (newTags.length >= 2)      distinctScore = 5;
    else if (newTags.length === 1) distinctScore = 3;
    // Register all tags so subsequent sources don't double-count
    for (const t of sourceTags) seenTechTags.add(t);
  }

  const total = authorityScore + importanceScore + aiScore + timeframeScore
              + noveltyScore + maturityScore + caseStudyScore + distinctScore;

  // Clamp to 0–100 (scores shouldn't exceed 100 but be safe)
  const ranking_score = Math.min(100, Math.max(0, total));

  const ranking_tier =
    ranking_score >= 70 ? "tier_1" :
    ranking_score >= 50 ? "tier_2" :
    ranking_score >= 30 ? "tier_3" : "tier_4";

  return {
    ...source,
    ranking_score,
    ranking_tier,
    ranking_breakdown: {
      authority:     authorityScore,
      importance:    importanceScore,
      ai_specificity: aiScore,
      timeframe:     timeframeScore,
      novelty:       noveltyScore,
      maturity:      maturityScore,
      case_study:    caseStudyScore,
      distinct:      distinctScore,
    },
  };
}

/**
 * Rank a list of sources.
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {string|Date} [opts.windowStart]
 * @param {string|Date} [opts.windowEnd]
 * @returns {object[]} sorted by ranking_score descending, each with ranking_* fields
 */
export function rankSources(sources, opts = {}) {
  const seenTechTags = new Set();
  // Score in publication-date order (most recent first) so novelty and distinctness
  // bonuses accrue from the freshest sources rather than arbitrary input order.
  const byDate = [...sources].sort((a, b) => {
    const da = a.date_published || "";
    const db = b.date_published || "";
    return db < da ? -1 : db > da ? 1 : 0;
  });

  const scored = byDate.map(s => scoreSource(s, { ...opts, seenTechTags }));
  scored.sort((a, b) => b.ranking_score - a.ranking_score);

  const tierCounts = { tier_1: 0, tier_2: 0, tier_3: 0, tier_4: 0 };
  for (const s of scored) tierCounts[s.ranking_tier]++;

  process.stdout.write(
    `  [rank] ${scored.length} sources scored — ` +
    `tier_1: ${tierCounts.tier_1}, tier_2: ${tierCounts.tier_2}, ` +
    `tier_3: ${tierCounts.tier_3}, tier_4: ${tierCounts.tier_4}\n`,
  );

  return scored;
}
