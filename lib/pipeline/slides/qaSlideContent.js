/**
 * L7b — Slide Content Evidence-Grounding QA
 *
 * Deterministic validation pass that runs AFTER generateSlideContent() and
 * BEFORE speaker notes generation. Enforces strict evidence-grounding rules:
 *
 *   Rule 1 — No evidence ID = no substantive claim.
 *            Slides with specific factual claims must carry at least one
 *            evidence_callout or rawfact_evidence_id.
 *
 *   Rule 2 — No analytics evidence = no trend/growth/ranking/frequency claim.
 *            Phrases like "tripling", "dominates", "top attack vector",
 *            "rapid growth" require a backing analytics evidence item whose
 *            top_entries show meaningful (non-"unknown") data.
 *
 *   Rule 3 — No source URL = no citation.
 *            Citation strings must contain a URL. Citations without a URL
 *            are stripped.
 *
 *   Rule 4 — No category evidence = no category section.
 *            Category slides with low-confidence deterministic analysis and
 *            no evidence callouts are flagged for suppression.
 *
 *   Rule 5 — Numbers in bullets/headlines must appear in evidence key_facts.
 *            Specific figures (e.g. "5,500" or "10,000+") that cannot be
 *            traced to an evidence callout key_fact are flagged as
 *            hallucinated_statistic.
 *
 *   Rule 6 — Citation titles must not introduce claims not in key_facts.
 *            If a citation title contains numbers not present in any
 *            evidence_callout key_fact on the same slide, it is flagged.
 *
 * Severity levels:
 *   blocking  — prevents reliable distribution of the claim; must sanitize
 *   warning   — degrades analytical credibility; should be reviewed
 *   info      — minor style or confidence issue
 *
 * In strict mode (default), blocking issues cause the affected text to be
 * replaced with safe neutral language or stripped. The original text is
 * preserved in content_qa.original_* for review.
 *
 * Output per slide: slide with content_qa field added.
 * Output overall:  deck-level QA report with blocking_count, warning_count.
 */

// ── Text normalization helper ─────────────────────────────────────────────────

function normForDedupe(s) {
  return (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Prohibited phrases ────────────────────────────────────────────────────────

/**
 * Each entry:
 *   pattern     — regex to detect the phrase in slide text
 *   requires    — what analytics backing is needed to allow the phrase
 *   replacement — what to substitute in sanitize mode (null = strip the bullet)
 *   severity    — "blocking" or "warning"
 *   label       — machine-readable issue code
 */
const PROHIBITED_PHRASES = [
  { pattern: /\btripling\b/i,                        requires: "analytics_trend",    replacement: "increasing",               severity: "blocking", label: "unsupported_magnitude" },
  { pattern: /\bdoubling\b/i,                        requires: "analytics_trend",    replacement: "increasing",               severity: "blocking", label: "unsupported_magnitude" },
  { pattern: /\bfastest(?:\s+grow|\s+growing)\b/i,   requires: "analytics_rank",     replacement: "growing",                  severity: "blocking", label: "unsupported_ranking" },
  { pattern: /\brapid\s+growth\b/i,                  requires: "analytics_trend",    replacement: "notable growth",           severity: "blocking", label: "unsupported_trend" },
  { pattern: /\brapid(?:ly)?\s+grow(?:ing)?\b/i,    requires: "analytics_trend",    replacement: "growing",                  severity: "blocking", label: "unsupported_trend" },
  { pattern: /\bdominate[sd]?\b/i,                   requires: "analytics_majority", replacement: "is the most frequent in",  severity: "blocking", label: "unsupported_ranking" },
  { pattern: /\btop\s+attack\s+vector\b/i,           requires: "analytics_rank",     replacement: "observed attack vector",   severity: "blocking", label: "unsupported_ranking" },
  { pattern: /\btop\s+\d+\s+attack/i,                requires: "analytics_rank",     replacement: "observed attacks",         severity: "blocking", label: "unsupported_ranking" },
  { pattern: /\bincreased?\s+frequen/i,              requires: "analytics_trend",    replacement: "observed frequency",       severity: "blocking", label: "unsupported_trend" },
  { pattern: /\bsurg(?:e[sd]?|ing)\b/i,              requires: "analytics_trend",    replacement: "increasing",               severity: "blocking", label: "unsupported_trend" },
  { pattern: /\boutpac(?:e[sd]?|ing)\b/i,            requires: "analytics_comparison", replacement: "growing",                severity: "blocking", label: "unsupported_comparison" },
  { pattern: /\boperational(?:iz[ed]+|iz(?:ing|ation))\b/i, requires: "analytics_operational", replacement: "active",        severity: "warning",  label: "unsupported_maturity_claim" },
  { pattern: /\bcritical\s+risk\b/i,                 requires: "derived_metric_high", replacement: "notable risk",            severity: "warning",  label: "unsupported_severity" },
  { pattern: /\bhighest\s+(?:risk|threat|priority)\b/i, requires: "derived_metric_high", replacement: "high priority",       severity: "warning",  label: "unsupported_ranking" },
  { pattern: /\bunprecedented\b/i,                   requires: null,                 replacement: "notable",                  severity: "blocking", label: "exaggerated_language" },
  { pattern: /\bhigh(?:\s*[-–]?\s*)profile\s+incident[s]?\b/i, requires: "rawfact_incident", replacement: "documented case", severity: "warning",  label: "unsupported_incident_claim" },
];

// ── Analytics backing checks ──────────────────────────────────────────────────

function hasNonUnknownAnalytics(analyticsEvidence) {
  return (analyticsEvidence || []).some((e) =>
    (e.top_entries || []).some((entry) => entry.key !== "unknown" && (entry.count || 0) > 0)
  );
}

function hasAnalyticsTrend(slide) {
  const ae = slide.analytics_evidence || [];
  const timelineItem = ae.find((e) =>
    /timeline|trend|monthly|growth|delta/i.test(e.dimension || "") ||
    /trend|increas|grow|declin/i.test(e.insight || "")
  );
  return !!(timelineItem && hasNonUnknownAnalytics([timelineItem]));
}

function hasAnalyticsRank(slide) {
  const ae = slide.analytics_evidence || [];
  // Rank requires a frequency distribution where at least one non-unknown entry has >0 count
  return ae.some((e) =>
    /vector|cluster|surface|theme|control/i.test(e.dimension || "") &&
    (e.top_entries || []).some((entry) => entry.key !== "unknown" && (entry.count || 0) >= 2)
  );
}

function hasAnalyticsMajority(slide) {
  const ae = slide.analytics_evidence || [];
  return ae.some((e) =>
    (e.top_entries || []).some((entry) => entry.key !== "unknown" && (entry.pct || 0) > 50)
  );
}

function hasAnalyticsOperational(slide) {
  const ae = slide.analytics_evidence || [];
  return ae.some((e) =>
    /maturity|operational|status/i.test(e.dimension || "") &&
    (e.top_entries || []).some((entry) =>
      /operational|emerging|active/i.test(entry.key) && (entry.count || 0) > 0
    )
  );
}

function hasDerivedMetricHigh(slide) {
  const ae = slide.analytics_evidence || [];
  return ae.some((e) =>
    /metric/i.test(e.dimension || "") &&
    /high|very_high/i.test(e.label || e.insight || "")
  );
}

function hasRawfactIncident(slide) {
  return (slide.evidence_callouts || []).length > 0 &&
    (slide._plan?.rawfact_evidence_ids?.length || 0) > 0;
}

function analyticsBacksPhrase(slide, requiresType) {
  if (!requiresType) return false;
  switch (requiresType) {
    case "analytics_trend":       return hasAnalyticsTrend(slide);
    case "analytics_rank":        return hasAnalyticsRank(slide);
    case "analytics_majority":    return hasAnalyticsMajority(slide);
    case "analytics_operational": return hasAnalyticsOperational(slide);
    case "derived_metric_high":   return hasDerivedMetricHigh(slide);
    case "analytics_comparison":  return hasAnalyticsTrend(slide) || hasAnalyticsRank(slide);
    case "rawfact_incident":      return hasRawfactIncident(slide);
    default:                      return false;
  }
}

// ── Number extraction and evidence matching ───────────────────────────────────

const NUMBER_RE = /\b(\d[\d,]*(?:\.\d+)?(?:\+|k|K|M|B|%)?)\b/g;

function extractNumbers(text) {
  return [...(text || "").matchAll(NUMBER_RE)].map((m) => m[1].toLowerCase().replace(/,/g, ""));
}

function numbersFromEvidence(slide) {
  const texts = [
    ...(slide.evidence_callouts || []).map((c) => c.key_fact || ""),
    ...(slide.evidence_callouts || []).map((c) => c.title || ""),
  ].join(" ");
  return new Set(extractNumbers(texts));
}

// A number is NOT a statistic to fact-check when it's a year, a duration/time
// window, or a framework reference ("Top 10"). Flagging these as "hallucinated
// statistics" was the main source of false positives on info/overview slides.
function isNonStatisticNumber(num, text) {
  if (/^(19|20)\d{2}$/.test(num)) return true;                 // year, e.g. 2026
  const t = (text || "").toLowerCase().replace(/,/g, "");
  const n = num.replace(/[+%]/g, "");
  if (new RegExp(`\\b${n}\\b\\s*(?:[-–]\\s*\\d+\\s*)?(day|week|month|hour|year|min|quarter|q[1-4])`, "i").test(t)) return true;
  if (new RegExp(`\\d+\\s*[-–]\\s*${n}\\b\\s*(day|week|month|hour|year)`, "i").test(t)) return true; // "30-60 days"
  if (new RegExp(`top\\s*${n}\\b`, "i").test(t)) return true;  // "OWASP LLM Top 10"
  return false;
}

// Internal citations (analytics aggregates / derived metrics) have no URL by
// design — they must not be stripped or flagged as "missing URL".
function isInternalCitation(c) {
  return /analytics aggregate|derived metric|corpus aggregate/i.test(c || "");
}

function checkInventedNumbers(text, evidenceNumbers, context) {
  const issues = [];
  for (const num of extractNumbers(text)) {
    // Allow small counts (1–9), years, durations, and framework refs.
    if (/^[1-9]$/.test(num)) continue;
    if (isNonStatisticNumber(num, text)) continue;
    if (!evidenceNumbers.has(num)) {
      issues.push({
        issue: "hallucinated_statistic",
        severity: "blocking",
        label: `Number "${num}" in ${context} not found in any evidence callout key_fact`,
        original_text: text,
      });
    }
  }
  return issues;
}

// ── Citation integrity check ──────────────────────────────────────────────────

function checkCitationIntegrity(slide, evidenceNumbers) {
  const issues = [];
  for (const citation of (slide.citations || [])) {
    // Internal (analytics aggregate / derived metric) citations legitimately
    // have no URL — never flag those.
    if (!citation.includes("(http") && !isInternalCitation(citation)) {
      issues.push({
        issue: "citation_missing_url",
        severity: "blocking",
        label: `Citation has no URL: "${citation.slice(0, 80)}"`,
        original_text: citation,
      });
    }
    // Extract numbers from citation title (between — and ()
    const titleMatch = citation.match(/—\s*(.+?)\s*\(/);
    if (titleMatch) {
      const titleNums = extractNumbers(titleMatch[1]);
      for (const num of titleNums) {
        if (/^[1-9]$/.test(num)) continue;
        if (isNonStatisticNumber(num, titleMatch[1])) continue;
        if (!evidenceNumbers.has(num)) {
          issues.push({
            issue: "inflated_citation_title",
            severity: "blocking",
            label: `Citation title contains "${num}" not found in any evidence key_fact`,
            original_text: citation,
          });
        }
      }
    }
  }
  return issues;
}

// ── Prohibited phrase check ───────────────────────────────────────────────────

function checkProhibitedPhrases(text, slide, location) {
  const issues = [];
  for (const def of PROHIBITED_PHRASES) {
    if (def.pattern.test(text)) {
      const backed = analyticsBacksPhrase(slide, def.requires);
      if (!backed) {
        issues.push({
          issue:        def.label,
          severity:     def.severity,
          label:        `"${text.match(def.pattern)?.[0]}" in ${location} is unsupported — no backing analytics evidence`,
          pattern:      def.pattern.source,
          replacement:  def.replacement,
          original_text: text,
        });
      }
    }
  }
  return issues;
}

// ── Sanitizer ─────────────────────────────────────────────────────────────────

function sanitizeText(text, issues) {
  let result = text;
  let hasHallucinatedStat = false;

  for (const issue of issues) {
    if (issue.severity !== "blocking") continue;

    // Replace prohibited phrases
    if (issue.pattern && issue.replacement !== null) {
      result = result.replace(new RegExp(issue.pattern, "gi"), issue.replacement);
    }

    // Track hallucinated statistics
    if (issue.issue === "hallucinated_statistic") {
      hasHallucinatedStat = true;
    }
  }

  // Append a visible caveat when the bullet contains an unverified statistic
  if (hasHallucinatedStat) {
    result = result.trimEnd();
    if (!result.endsWith(".")) result += ".";
    result += " [STATISTIC UNVERIFIED — not found in cited evidence]";
  }

  return result;
}

function stripCitationsWithoutUrl(citations) {
  // Keep source citations with a URL, and internal analytics citations (no URL by design).
  return (citations || []).filter((c) => c.includes("(http") || isInternalCitation(c));
}

function sanitizeCitationTitle(citation, evidenceNumbers) {
  // Replace citation titles that contain numbers not in evidence with a sanitized form.
  // "Publisher — Fabricated title with 10,000+ stats (URL)" → "Publisher — [Title requires verification] (URL)"
  const titleMatch = citation.match(/^(.+?)\s+—\s+(.+?)\s+(\(https?:\/\/.+\))$/);
  if (!titleMatch) return citation;

  const [, publisher, title, urlPart] = titleMatch;
  const titleNums = extractNumbers(title);
  const hasUnverifiedNum = titleNums.some(
    (n) => !/^[1-9]$/.test(n) && !evidenceNumbers.has(n)
  );

  if (hasUnverifiedNum) {
    return `${publisher} — [Title contains unverified statistic — see source] ${urlPart}`;
  }
  return citation;
}

// ── Claim-based checks ────────────────────────────────────────────────────────

// Slide types that MUST have a claim_id if they are analytical
const REQUIRES_CLAIM_ID = new Set([
  "critical_claim", "evidence_support", "trend_claim", "outlook_6month",
  "recommendation", "case_study", "analytics_pattern",
]);

// Slide types that represent outlook claims — must separate observed/projected
const OUTLOOK_TYPES = new Set(["outlook_6month", "outlook"]);

// Phrases indicating projected trajectory (acceptable in outlook bullets)
const OBSERVED_BASIS_MARKERS  = /\b(observed|documented|found|identified|reported|confirmed|evidence shows?|published|disclosed)\b/i;
const PROJECTED_TRAJ_MARKERS  = /\b(suggest|trajectory|may|could|likely|expected|projected|anticipated|indicates?|points? to|based on)\b/i;

// Phrases that imply trend certainty — blocked unless claim_type=trend_claim
const TREND_CERTAINTY_PHRASES = [
  { pattern: /\bthe trend (?:shows?|is|continues?|accelerate)\b/i,             label: "trend_certainty_unsupported" },
  { pattern: /\b(?:clearly|definitively) trend(?:ing)?\b/i,                    label: "trend_certainty_unsupported" },
  { pattern: /\b(?:proven|confirmed) trend\b/i,                                label: "trend_certainty_unsupported" },
];

// Phrases that indicate context-only evidence used as operational proof
const OPERATIONAL_ASSERTION_PHRASES = [
  { pattern: /\b(adversaries? are (?:using|deploying|leveraging|adopting))\b/i,  label: "operational_from_context" },
  { pattern: /\b(threat actors? have (?:used|deployed|operated|weaponized))\b/i, label: "operational_from_context" },
  { pattern: /\b(actively exploit(?:ed|ing))\b/i,                               label: "operational_from_context" },
];

function checkClaimIdRequired(slide) {
  const issues = [];
  if (!REQUIRES_CLAIM_ID.has(slide.slide_type)) return issues;
  if (!slide.claim_id) {
    issues.push({
      issue:    "analytical_slide_missing_claim_id",
      severity: "blocking",
      label:    `Analytical slide type "${slide.slide_type}" must have a claim_id — this slide cannot make claims without one`,
    });
  }
  return issues;
}

function checkHeadlineDerivesFromClaim(slide) {
  const issues = [];
  if (!slide.claim_id || !slide.claim_text || !slide.headline) return issues;
  // The headline must share key terms with claim_text
  const claimWords  = new Set(normForDedupe(slide.claim_text).split(/\s+/).filter((w) => w.length > 4));
  const headlineWords = new Set(normForDedupe(slide.headline).split(/\s+/).filter((w) => w.length > 4));
  const shared = [...claimWords].filter((w) => headlineWords.has(w));
  if (claimWords.size > 3 && shared.length < 2) {
    issues.push({
      issue:    "headline_not_derived_from_claim",
      severity: "warning",
      label:    `Headline "${slide.headline.slice(0, 60)}" shares few key terms with claim_text — headline should derive from the claim`,
    });
  }
  return issues;
}

function checkTrendClaimRules(slide) {
  const issues = [];
  if (slide.slide_type !== "trend_claim") return issues;
  if (slide.claim_type !== "trend_claim") {
    issues.push({
      issue:    "trend_slide_without_trend_claim",
      severity: "blocking",
      label:    `Slide type "trend_claim" requires claim_type=trend_claim (got: ${slide.claim_type || "null"}) — cannot make trend assertion without validated trend claim`,
    });
  }
  return issues;
}

function checkOutlookSeparation(slide) {
  const issues = [];
  if (!OUTLOOK_TYPES.has(slide.slide_type)) return issues;
  const bulletText = (slide.bullets || []).join(" ");
  const hasObserved  = OBSERVED_BASIS_MARKERS.test(bulletText);
  const hasProjected = PROJECTED_TRAJ_MARKERS.test(bulletText);
  if (!hasObserved) {
    issues.push({
      issue:    "outlook_missing_observed_basis",
      severity: "warning",
      label:    `Outlook slide is missing observed-basis language — outlook must separate what was observed from what is projected`,
    });
  }
  if (!hasProjected) {
    issues.push({
      issue:    "outlook_missing_projected_trajectory",
      severity: "warning",
      label:    `Outlook slide is missing projected-trajectory language — outlook must separate observed from projected`,
    });
  }
  return issues;
}

function checkContextOnlyOperationalClaim(slide) {
  const issues = [];
  // Context-only evidence cannot support operational claims
  if (!slide._plan?.all_context_only) return issues;
  const textToCheck = [slide.headline, ...(slide.bullets || [])].join(" ");
  for (const { pattern, label } of OPERATIONAL_ASSERTION_PHRASES) {
    if (pattern.test(textToCheck)) {
      issues.push({
        issue:    label,
        severity: "blocking",
        label:    `Context-only evidence slide makes an operational assertion (matched: "${textToCheck.match(pattern)?.[0]}") — context evidence cannot prove adversary use`,
      });
    }
  }
  return issues;
}

function checkTrendCertaintyLanguage(slide) {
  const issues = [];
  if (slide.slide_type === "trend_claim") return issues; // trend_claim slides may use trend language
  const textToCheck = [slide.headline, ...(slide.bullets || [])].join(" ");
  for (const { pattern, label } of TREND_CERTAINTY_PHRASES) {
    if (pattern.test(textToCheck)) {
      issues.push({
        issue:    label,
        severity: "warning",
        label:    `"${textToCheck.match(pattern)?.[0]}" asserts trend certainty — use "the evidence suggests" unless claim_type=trend_claim`,
      });
    }
  }
  return issues;
}

function checkRecommendationCitesBasis(slide) {
  const issues = [];
  if (slide.slide_type !== "recommendation") return issues;
  const hasEvidenceCallouts = (slide.evidence_callouts || []).length > 0;
  const hasEvidenceIds      = (slide._plan?.rawfact_evidence_ids || []).length > 0;
  if (!hasEvidenceCallouts && !hasEvidenceIds) {
    issues.push({
      issue:    "recommendation_without_evidence_basis",
      severity: "warning",
      label:    `Recommendation slide has no evidence callouts — recommendations should cite the risk, control gap, or evidence that motivates the action`,
    });
  }
  return issues;
}

// ── Per-slide QA ──────────────────────────────────────────────────────────────

const STRUCTURAL_TYPES = new Set([
  "title", "section_divider", "appendix", "scope_methodology", "source_coverage",
  "taxonomy_reference", "scope_and_methodology",
]);
const CATEGORY_TYPES   = new Set(["category_viewpoint", "category_technique_map", "category_evidence", "category_analytics_outlook", "category_content"]);

function qaSlide(slide, opts = {}) {
  const { strict = true } = opts;
  const issues = [];

  // Structural slides: only check citations
  if (STRUCTURAL_TYPES.has(slide.slide_type)) {
    const fixedCitations = stripCitationsWithoutUrl(slide.citations);
    return {
      slide:  { ...slide, citations: fixedCitations },
      issues: [],
      qa_pass: true,
      severity: "none",
    };
  }

  const evidenceNumbers  = numbersFromEvidence(slide);
  const hasEvidenceIds   = (slide._plan?.rawfact_evidence_ids?.length || 0) > 0 ||
                           (slide._plan?.claim_ids?.length || 0) > 0;
  const hasCallouts      = (slide.evidence_callouts || []).length > 0;
  const hasAnalyticsData = hasNonUnknownAnalytics(slide.analytics_evidence);
  const isLowConfidence  = slide._plan?.category_analysis_confidence === "low";

  // --- Claim-based rules (Rules 7–11) ---
  issues.push(...checkClaimIdRequired(slide));
  issues.push(...checkHeadlineDerivesFromClaim(slide));
  issues.push(...checkTrendClaimRules(slide));
  issues.push(...checkOutlookSeparation(slide));
  issues.push(...checkContextOnlyOperationalClaim(slide));
  issues.push(...checkTrendCertaintyLanguage(slide));
  issues.push(...checkRecommendationCitesBasis(slide));

  // --- Rule 4: category slide with no evidence and low-confidence analysis ---
  if (CATEGORY_TYPES.has(slide.slide_type) && !hasEvidenceIds && !hasCallouts) {
    issues.push({
      issue:    "no_evidence_for_category_slide",
      severity: "blocking",
      label:    `Category slide "${slide.title}" has no evidence IDs and no callouts — slide should not make specific claims`,
    });
  }

  // The invented-number check only makes sense when the slide HAS evidence
  // callouts to check against. Info/overview/analytics slides draw their numbers
  // from pipeline metadata and analytics aggregates, not callouts — running the
  // check there produced false positives ("90-day window", "100 sources").
  const checkNumbers = (text, ctx) => hasCallouts ? checkInventedNumbers(text, evidenceNumbers, ctx) : [];

  // --- Rule 1 + 5: numbers and prohibited phrases in headline ---
  let cleanedHeadline = slide.headline || "";
  if (slide.headline) {
    const headlineIssues = [
      ...checkNumbers(slide.headline, "headline"),
      ...checkProhibitedPhrases(slide.headline, slide, "headline"),
    ];
    issues.push(...headlineIssues);
    if (strict) cleanedHeadline = sanitizeText(slide.headline, headlineIssues);
  }

  // --- Rule 1 + 5: numbers and prohibited phrases in bullets ---
  const cleanedBullets = [];
  const bulletIssues   = {};

  for (const bullet of (slide.bullets || [])) {
    const bIssues = [
      ...checkNumbers(bullet, "bullet"),
      ...checkProhibitedPhrases(bullet, slide, "bullet"),
    ];
    bulletIssues[bullet] = bIssues;
    issues.push(...bIssues);
    cleanedBullets.push(strict ? sanitizeText(bullet, bIssues) : bullet);
  }

  // --- Rule 6: citation title integrity ---
  issues.push(...checkCitationIntegrity(slide, evidenceNumbers));

  // --- Rule 3: citations must have URLs ---
  const cleanedCitations = stripCitationsWithoutUrl(slide.citations);
  if (cleanedCitations.length < (slide.citations || []).length) {
    issues.push({
      issue:    "citation_missing_url",
      severity: "blocking",
      label:    `${(slide.citations || []).length - cleanedCitations.length} citation(s) stripped — missing URL`,
    });
  }

  // --- Rule 2: analytics claims require analytics evidence ---
  // Check if any bullet references frequency/trend without analytics backing
  if (!hasAnalyticsData && !hasEvidenceIds) {
    const hasSubstantiveClaim = (slide.bullets || []).some((b) =>
      /\b(found|identified|shows?|reveals?|report[sed]+|document[ed]+|\d+)\b/i.test(b)
    );
    if (hasSubstantiveClaim) {
      issues.push({
        issue:    "substantive_claim_without_evidence",
        severity: "warning",
        label:    `Slide "${slide.title}" has substantive claims but no analytics data and no evidence IDs`,
      });
    }
  }

  // --- Low-confidence category gate ---
  if (isLowConfidence && CATEGORY_TYPES.has(slide.slide_type)) {
    issues.push({
      issue:    "low_confidence_analysis",
      severity: "warning",
      label:    `Category analysis ran as deterministic fallback (llm_used=false) — analytical depth is minimal`,
    });
  }

  // Sanitize citation titles that contain inflated statistics
  const sanitizedCitations = strict
    ? cleanedCitations.map((c) => sanitizeCitationTitle(c, evidenceNumbers))
    : cleanedCitations;

  // Build the fixed slide
  const blockingIssues = issues.filter((i) => i.severity === "blocking");
  const fixedSlide = strict ? {
    ...slide,
    headline:   cleanedHeadline,
    bullets:    cleanedBullets,
    citations:  sanitizedCitations,
    content_qa: {
      qa_pass:         blockingIssues.length === 0,
      issues,
      blocking_count:  blockingIssues.length,
      warning_count:   issues.filter((i) => i.severity === "warning").length,
      sanitized:       strict && blockingIssues.length > 0,
    },
  } : {
    ...slide,
    citations: cleanedCitations,   // always strip no-URL citations even in warn mode
    content_qa: {
      qa_pass:        blockingIssues.length === 0,
      issues,
      blocking_count: blockingIssues.length,
      warning_count:  issues.filter((i) => i.severity === "warning").length,
      sanitized:      false,
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
 * Run evidence-grounding QA on all slides in the deck.
 *
 * @param {object[]} slides   - Generated slide content from generateSlideContent()
 * @param {object}   [opts]
 * @param {boolean}  [opts.strict=true]  - Sanitize blocking issues (replace phrases, strip URLs)
 * @returns {{ slides: object[], report: object }}
 */
export function qaSlideContent(slides, opts = {}) {
  const { strict = true } = opts;
  const results = [];
  let totalBlocking = 0;
  let totalWarnings = 0;

  for (const slide of slides) {
    const { slide: fixedSlide, issues, severity } = qaSlide(slide, { strict });
    results.push(fixedSlide);
    if (severity === "blocking") totalBlocking++;
    if (severity === "warning")  totalWarnings++;
  }

  // Slides that should be suppressed (no evidence for category section)
  const suppressCandidates = results.filter((s) =>
    (s.content_qa?.issues || []).some((i) => i.issue === "no_evidence_for_category_slide")
  );

  // Claim-based QA violations
  const missingClaimId     = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "analytical_slide_missing_claim_id"));
  const trendViolations    = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "trend_slide_without_trend_claim"));
  const outlookViolations  = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "outlook_missing_observed_basis" || i.issue === "outlook_missing_projected_trajectory"));
  const operationalFromCtx = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "operational_from_context"));

  // Slides with hallucinated statistics
  const hallucinatedStats = results.filter((s) =>
    (s.content_qa?.issues || []).some((i) => i.issue === "hallucinated_statistic")
  );

  // Slides with inflated citation titles
  const inflatedCitations = results.filter((s) =>
    (s.content_qa?.issues || []).some((i) => i.issue === "inflated_citation_title")
  );

  if (totalBlocking > 0 || totalWarnings > 0) {
    process.stdout.write(
      `  [L7b-content-qa] ${totalBlocking} slides with blocking issues, ${totalWarnings} with warnings\n` +
      (hallucinatedStats.length > 0
        ? `  [L7b-content-qa] BLOCKING: hallucinated statistics on slides ${hallucinatedStats.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (inflatedCitations.length > 0
        ? `  [L7b-content-qa] BLOCKING: inflated citation titles on slides ${inflatedCitations.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (suppressCandidates.length > 0
        ? `  [L7b-content-qa] WARNING: ${suppressCandidates.length} category slides with no evidence\n`
        : "")
    );
  } else {
    process.stdout.write("  [L7b-content-qa] All slides passed evidence-grounding checks\n");
  }

  const report = {
    total_slides:         slides.length,
    slides_blocking:      totalBlocking,
    slides_warning:       totalWarnings,
    slides_pass:          slides.length - totalBlocking - totalWarnings,
    deck_qa_pass:         totalBlocking === 0,
    hallucinated_stats:   hallucinatedStats.map((s) => ({ slide: s.slide_number, title: s.title })),
    inflated_citations:   inflatedCitations.map((s) => ({ slide: s.slide_number, title: s.title })),
    suppress_candidates:  suppressCandidates.map((s) => ({ slide: s.slide_number, title: s.title })),
    // Claim-based QA
    missing_claim_id:     missingClaimId.map((s)    => ({ slide: s.slide_number, type: s.slide_type })),
    trend_violations:     trendViolations.map((s)   => ({ slide: s.slide_number, type: s.slide_type })),
    outlook_violations:   outlookViolations.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    operational_from_ctx: operationalFromCtx.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    all_issues:           results.flatMap((s) =>
      (s.content_qa?.issues || []).map((i) => ({ slide: s.slide_number, ...i }))
    ),
  };

  return { slides: results, report };
}
