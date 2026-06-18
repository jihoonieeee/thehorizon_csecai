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
  { pattern: /\bdominate[sd]?\b/i,                   requires: "analytics_majority", replacement: "is frequently observed in", severity: "blocking", label: "unsupported_ranking" },
  { pattern: /\bdominated\s+by\b/i,                  requires: "analytics_majority", replacement: "frequently features",        severity: "blocking", label: "unsupported_ranking" },
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
  // Scope inflation — claims using universal/majority scope without analytics backing
  { pattern: /\ball\s+(?:LLMs?|AI\s+(?:systems?|models?)|organizations?|vendors?)\b/i, requires: null, replacement: "observed AI systems", severity: "blocking", label: "scope_inflation" },
  { pattern: /\bevery\s+(?:LLM|AI\s+(?:system|model)|organization|vendor)\b/i,        requires: null, replacement: "AI systems studied",  severity: "blocking", label: "scope_inflation" },
  { pattern: /\bany\s+(?:LLM|AI\s+(?:system|model))\s+(?:can|could|will|may)\b/i,    requires: null, replacement: "some AI systems can", severity: "blocking", label: "scope_inflation" },
  { pattern: /\bwill\s+definitely\b/i,               requires: null,                 replacement: "may",                      severity: "blocking", label: "false_certainty" },
  { pattern: /\bis\s+certain\s+to\b/i,               requires: null,                 replacement: "may",                      severity: "blocking", label: "false_certainty" },
  { pattern: /\b(?:proves?|confirms?)\s+(?:that\s+)?(?:AI|LLM|adversar)/i,            requires: "rawfact_incident", replacement: "suggests",  severity: "blocking", label: "overclaiming_conclusion" },
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
  return /analytics\s*(aggregate|—|$)|derived metric|corpus aggregate/i.test(c || "");
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

// ── Evidence callout integrity check ─────────────────────────────────────────

const VALID_URL_RE = /^https?:\/\/.+\..+/;
const EVIDENCE_ID_RE = /^(ev_|agg_|ext_|an_|c_|vp_|obs_)/;

// Evidence ID patterns that must NEVER appear in visible slide content
const EV_ID_LEAK_RE = /\bev[_-][a-f0-9]{4,}[a-z0-9_-]*/gi;
const URL_IN_TEXT_RE = /https?:\/\/\S+/i;

/**
 * Validate evidence_callouts on content slides:
 *   - evidence_id must have recognisable format
 *   - URL must be valid https:// if present and not empty
 *   - publisher must be non-empty
 *   - key_fact must be non-trivially long (> 10 chars)
 */
function checkEvidenceCalloutIntegrity(slide) {
  const issues = [];
  // Only run on content slides (not structural/appendix)
  if (STRUCTURAL_TYPES.has(slide.slide_type)) return issues;

  for (const callout of (slide.evidence_callouts || [])) {
    const id = callout?.evidence_id || "";

    // evidence_id format validation
    if (id && !EVIDENCE_ID_RE.test(id) && !id.startsWith("ev-") && !/^[a-z0-9_-]{4,}$/i.test(id)) {
      issues.push({
        issue:    "invalid_evidence_id_format",
        severity: "warning",
        label:    `evidence_callout id "${id.slice(0, 40)}" has unexpected format — may be a fabricated ID`,
      });
    }

    // URL validation
    if (callout?.url && !VALID_URL_RE.test(callout.url)) {
      issues.push({
        issue:    "callout_invalid_url",
        severity: "blocking",
        label:    `evidence_callout "${id}" has malformed URL: "${String(callout.url).slice(0, 80)}"`,
      });
    }

    // Publisher non-empty check
    if (!callout?.publisher || String(callout.publisher).trim().length === 0) {
      issues.push({
        issue:    "callout_missing_publisher",
        severity: "warning",
        label:    `evidence_callout "${id}" has no publisher — cannot verify source provenance`,
      });
    }

    // key_fact must be substantive
    if (!callout?.key_fact || String(callout.key_fact).trim().length < 10) {
      issues.push({
        issue:    "callout_empty_key_fact",
        severity: "warning",
        label:    `evidence_callout "${id}" has empty or trivial key_fact — not useful for grounding`,
      });
    }
  }
  return issues;
}

// ── Evidence ID leak check ────────────────────────────────────────────────────

// Slide types that are structural — skip ev-* checks on these
const EV_LEAK_SKIP_TYPES = new Set([
  "title", "section_divider", "appendix", "appendix_evidence_index",
  "appendix_analytics_tables", "appendix_taxonomy", "scope_methodology",
  "source_coverage", "taxonomy_reference", "scope_and_methodology",
]);

// Analytical slide types that should have source URLs in factual bullets
const FACTUAL_BULLET_SLIDE_TYPES = new Set([
  "critical_claim", "evidence_support", "case_study", "analytics_pattern",
  "trend_claim", "outlook_6month", "recommendation", "evidence_gap",
  "category_viewpoint", "category_content", "category_technique_map",
  "category_evidence", "category_analytics_outlook",
]);

/**
 * Hard-fail check: ev_XXXXX or ev-XXXXX patterns in visible slide content.
 * Internal tracking codes must never appear in bullets or headlines.
 */
function checkEvidenceIdLeak(slide) {
  const issues = [];
  if (EV_LEAK_SKIP_TYPES.has(slide.slide_type)) return issues;

  const check = (text, location) => {
    if (!text) return;
    const matches = [...text.matchAll(EV_ID_LEAK_RE)];
    if (matches.length > 0) {
      const cleaned = text.replace(EV_ID_LEAK_RE, "").replace(/\s{2,}/g, " ").trim();
      issues.push({
        issue:        "evidence_id_leak",
        severity:     "blocking",
        label:        `Internal ev-* ID found in visible ${location}: "${text.slice(0, 80)}"`,
        original_text: text,
        replacement:  cleaned,
        location,
        found_ids:    matches.map((m) => m[0]),
      });
    }
  };

  check(slide.headline, "headline");
  for (const bullet of (slide.bullets || [])) {
    const text = typeof bullet === "object" ? (bullet?.text || "") : (bullet || "");
    check(text, "bullet");
  }

  return issues;
}

// ── Missing URL in factual bullets check ─────────────────────────────────────

/**
 * Warning check: finding/evidence bullets that contain no URL pattern.
 * Factual bullets should include "Source: https://..." for viewer verifiability.
 */
function checkBulletsMissingUrl(slide) {
  const issues = [];

  // Only run on analytical slides that should have cited evidence
  if (!FACTUAL_BULLET_SLIDE_TYPES.has(slide.slide_type)) return issues;

  for (const bullet of (slide.bullets || [])) {
    if (typeof bullet !== "object" || !bullet) continue;
    const role = bullet.bullet_role;
    if (role !== "finding" && role !== "evidence") continue;

    const text = bullet.text || "";
    if (!URL_IN_TEXT_RE.test(text)) {
      issues.push({
        issue:        "factual_bullet_missing_url",
        severity:     "warning",
        label:        `Finding/evidence bullet lacks source URL: "${text.slice(0, 80)}" — add "Source: https://..."`,
        original_text: text,
      });
    }
  }

  return issues;
}

// ── Cross-slide statistic consistency (deck-level) ────────────────────────────

/**
 * Scan the full deck for the same numeric value appearing in conflicting contexts.
 * E.g., if slide 5 says "37% of attacks" and slide 12 says "73% of attacks",
 * flag both as requiring review.
 *
 * Only checks numbers that are large enough to be statistics (≥10) and appear
 * in evidence_callout key_facts (not just bullet text, where paraphrasing is normal).
 */
function checkCrossSlideStatConsistency(slides) {
  const issues = [];
  // Build map: context_key → [ { slide_number, value, text } ]
  // context_key = normalised topic phrase around the number
  const statsByContext = new Map();

  for (const slide of slides) {
    for (const callout of (slide.evidence_callouts || [])) {
      const text = String(callout?.key_fact || "");
      const nums = [...text.matchAll(NUMBER_RE)].map((m) => m[1]);
      for (const num of nums) {
        const n = parseFloat(num.replace(/[,%+]/g, ""));
        if (isNaN(n) || n < 10) continue;
        // Extract up to 4 words around the number as a topic key
        const pos = text.indexOf(num);
        const window = text.slice(Math.max(0, pos - 40), pos + 40).toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
        const words = window.split(" ").filter((w) => w.length > 3 && !/^\d+$/.test(w));
        if (words.length < 2) continue;
        const topicKey = words.slice(0, 2).sort().join("|");

        if (!statsByContext.has(topicKey)) statsByContext.set(topicKey, []);
        statsByContext.get(topicKey).push({ slide_number: slide.slide_number, value: n, text: text.slice(0, 80), num });
      }
    }
  }

  for (const [topic, entries] of statsByContext) {
    if (entries.length < 2) continue;
    const values = [...new Set(entries.map((e) => e.value))];
    if (values.length < 2) continue;
    // Multiple distinct values for the same topic context
    const slideNums = [...new Set(entries.map((e) => e.slide_number))];
    if (slideNums.length < 2) continue;
    issues.push({
      issue:         "cross_slide_stat_inconsistency",
      severity:      "warning",
      topic,
      values:        entries.map((e) => ({ slide: e.slide_number, value: e.num })),
      label:         `Same topic "${topic.replace("|", " … ")}" cited with different values across slides ${slideNums.join(", ")} — verify both callouts reference the same statistic`,
    });
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

/**
 * Sanitize a text string (headline or bullet.text) by replacing prohibited phrases.
 * Returns null when the text contains an unverified hallucinated statistic — the
 * caller should strip the bullet entirely rather than leaving a tagged placeholder.
 */
function sanitizeText(text, issues) {
  let result = text;
  let hasHallucinatedStat = false;

  for (const issue of issues) {
    if (issue.severity !== "blocking") continue;

    // Replace prohibited phrases inline with context-awareness to avoid double words.
    // e.g. "is dominated by" → replace "dominated" with "frequently observed in" but
    // strip preceding "is" and following "by" if the replacement makes them redundant.
    if (issue.pattern && issue.replacement !== null) {
      result = result.replace(new RegExp(issue.pattern, "gi"), (match, ...args) => {
        const offset = args[args.length - 2];
        const str    = args[args.length - 1];
        // Remove a dangling "is " before the match if replacement starts with "is "
        const hasPrecIs  = /\bis\s+$/i.test(str.slice(0, offset));
        const repStartIs = /^is\s/i.test(issue.replacement);
        // Remove a dangling "by" after the match if replacement ends with "in"
        const repEndIn   = /\sin$/.test(issue.replacement.trimEnd());
        let rep = issue.replacement;
        if (hasPrecIs && repStartIs) {
          // Avoid "is is": trim the preceding "is " by noting it will be left in place.
          // Since we can only control the replacement, just use the part after "is ":
          rep = rep.replace(/^is\s+/i, "");
        }
        return rep;
      });
      // Clean up orphaned "by " after "in by" patterns
      result = result.replace(/\bin\s+by\b/gi, "in");
    }

    if (issue.issue === "hallucinated_statistic") {
      hasHallucinatedStat = true;
    }

    // Strip internal ev-* IDs from visible text
    if (issue.issue === "evidence_id_leak" && issue.replacement !== undefined) {
      result = result.replace(EV_ID_LEAK_RE, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  // For hallucinated stats on final slides: return null so the caller drops the bullet.
  // The original text is preserved in content_qa.original_* for review.
  if (hasHallucinatedStat) {
    return null;
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

// ── Bullet role validation ────────────────────────────────────────────────────

const VALID_BULLET_ROLES = new Set(["finding", "evidence", "implication", "caveat", "action"]);

// Structural slide types that do not require bullet_role validation
const STRUCTURAL_NO_ROLE_CHECK = new Set([
  "title", "section_divider", "appendix", "scope_methodology", "source_coverage",
  "taxonomy_reference", "scope_and_methodology", "appendix_evidence_index",
  "appendix_analytics_tables", "appendix_taxonomy", "landscape",
]);

function checkBulletRoles(slide) {
  const issues = [];
  if (STRUCTURAL_NO_ROLE_CHECK.has(slide.slide_type)) return issues;

  for (const bullet of (slide.bullets || [])) {
    // Legacy plain-string bullets are allowed (they will be normalised by assembleSlide)
    if (typeof bullet === "string") continue;
    if (!bullet || typeof bullet !== "object") continue;

    const role = bullet.bullet_role;

    // Missing bullet_role
    if (!role) {
      issues.push({
        issue:    "bullet_missing_role",
        severity: "warning",
        label:    `Bullet "${(bullet.text || "").slice(0, 60)}" is missing bullet_role — use: finding|evidence|implication|caveat|action`,
        original_text: bullet.text || "",
      });
      continue;
    }

    // Invalid role value
    if (!VALID_BULLET_ROLES.has(role)) {
      issues.push({
        issue:    "bullet_invalid_role",
        severity: "warning",
        label:    `Bullet role "${role}" is not valid — must be one of: finding, evidence, implication, caveat, action`,
        original_text: bullet.text || "",
      });
      continue;
    }

    // finding/evidence bullets require supporting_evidence_id
    if ((role === "finding" || role === "evidence") && !bullet.supporting_evidence_id) {
      issues.push({
        issue:    "finding_bullet_missing_evidence_id",
        severity: "warning",
        label:    `Bullet (role=${role}) "${(bullet.text || "").slice(0, 60)}" should have supporting_evidence_id`,
        original_text: bullet.text || "",
      });
    }

    // implication bullets should have linked_claim_id
    if (role === "implication" && !bullet.linked_claim_id && slide.claim_id) {
      issues.push({
        issue:    "implication_bullet_missing_claim_id",
        severity: "info",
        label:    `Implication bullet "${(bullet.text || "").slice(0, 60)}" should have linked_claim_id`,
        original_text: bullet.text || "",
      });
    }
  }

  return issues;
}

// ── Item 5: Slide bullet grounding QA ────────────────────────────────────────
// Checks whether bullet text accurately reflects the evidence it cites.
// Detects: scope inflation (lab → operational), topic drift, over-statement.
// This is a deterministic structural check — no LLM call.

const SCOPE_INFLATION_PATTERNS = [
  // Lab/research → real-world
  { from: /\b(research(?:ers?)?|lab(?:oratory)?|experiment(?:al)?|controlled study|benchmark|PoC|proof.of.concept)\b/i, label: "research_scope" },
  // Theoretical → operational
  { from: /\b(could|might|may be|theoretically|in theory|potentially|demonstrate[sd]?\s+that|show[ns]?\s+that)\b/i, label: "theoretical_scope" },
];

const REAL_WORLD_SCOPE_PATTERNS = [
  /\b(adversaries\s+(are|have|were)\s+(using|deploying|leveraging|exploiting))/i,
  /\b(actively\s+exploited|in\s+the\s+wild|real.world\s+(attacks?|deployment|use)|in\s+production\s+attacks?)/i,
  /\b(has\s+been\s+(deployed|used)\s+by\s+(attackers?|adversaries|threat\s+actors?))/i,
];

function contentWordOverlap(a, b) {
  const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const wordsOf = (s) => new Set(normalize(s).split(/\s+/).filter((w) => w.length > 4));
  const aWords = wordsOf(a);
  const bWords = wordsOf(b);
  if (aWords.size === 0) return 0;
  const common = [...aWords].filter((w) => bWords.has(w)).length;
  return common / aWords.size;
}

/**
 * Item 5: For each bullet on an analytical slide, check that it accurately
 * reflects its cited evidence rather than drifting conceptually.
 *
 * @param {object} slide  - Slide object with bullets[] and evidence_callouts[]
 * @returns {{ bullet: object, support_status: string, reason: string, corrected_bullet?: string }[]}
 */
export function checkBulletGrounding(slide) {
  const results = [];

  // Only check analytical slide types
  const ANALYTICAL_TYPES = new Set([
    "category_content", "critical_claim", "category_viewpoint",
    "evidence_support", "case_study", "cross_category",
  ]);
  if (!ANALYTICAL_TYPES.has(slide.slide_type)) return results;

  // Build evidence lookup from callouts
  const evidenceById = new Map();
  for (const c of (slide.evidence_callouts || [])) {
    if (c.evidence_id) {
      evidenceById.set(c.evidence_id, {
        fact:        c.key_fact || "",
        quote:       c.source_quote || "",
        publisher:   c.publisher || "",
      });
    }
  }
  // Also try rawfact items if present
  for (const r of (slide._rawfact_evidence || slide.rawfact_items || [])) {
    if (r.evidence_id && !evidenceById.has(r.evidence_id)) {
      evidenceById.set(r.evidence_id, {
        fact:  r.fact || r.key_fact || "",
        quote: r.source_quote || "",
      });
    }
  }

  for (const bullet of (slide.bullets || [])) {
    if (typeof bullet !== "object" || !bullet.text) continue;
    const { text, supporting_evidence_id: evId, bullet_role: role } = bullet;

    // Only check finding/evidence bullets with a cited evidence ID
    if (!evId || !["finding", "evidence"].includes(role)) continue;
    const ev = evidenceById.get(evId);
    if (!ev || !ev.fact) continue;

    const evidenceText = `${ev.fact} ${ev.quote}`;

    // 1) Content-word overlap: bullet should share meaningful vocabulary with fact
    const overlap = contentWordOverlap(text, evidenceText);
    if (overlap < 0.15 && text.length > 30) {
      results.push({
        bullet,
        support_status: "unsupported",
        reason: `low content overlap (${Math.round(overlap * 100)}%) with cited evidence — bullet may be fabricated or misattributed`,
        required_caveat: "Verify against cited source before use.",
      });
      continue;
    }

    // 2) Scope inflation: bullet makes real-world claim but evidence is research/theoretical
    const evidenceIsResearch = SCOPE_INFLATION_PATTERNS.some((p) => p.from.test(evidenceText));
    const bulletClaimsRealWorld = REAL_WORLD_SCOPE_PATTERNS.some((p) => p.test(text));
    if (evidenceIsResearch && bulletClaimsRealWorld) {
      // Produce a corrected version by hedging the strongest real-world claim
      const corrected = text
        .replace(/\badversaries\s+(are)\s+(using|deploying|leveraging|exploiting)/i,
          "adversaries may $2")
        .replace(/\bactively exploited\b/i, "potentially exploitable")
        .replace(/\bin the wild\b/i, "in research contexts");
      results.push({
        bullet,
        support_status: "overstates_scope",
        reason: "bullet claims real-world adversary use but evidence is research/lab scope",
        corrected_bullet: corrected !== text ? corrected : null,
        required_caveat: "Finding is from lab/research setting — real-world adversary adoption not confirmed.",
      });
    }
    // Otherwise: supported
  }

  return results;
}

// ── Analytics chart validation ────────────────────────────────────────────────

function checkAnalyticsPackets(slide) {
  const issues = [];
  if (slide.slide_type !== "analytics_pattern") return issues;

  for (const ae of (slide.analytics_evidence || [])) {
    const id = ae?.analytics_id || ae?.evidence_id;

    // Analytics chart must have input_evidence_ids (traceability back to source evidence)
    const inputIds = ae?.input_evidence_ids || ae?.source_evidence_ids || [];
    if (inputIds.length === 0) {
      issues.push({
        issue:    "analytics_chart_missing_input_evidence_ids",
        severity: "blocking",
        label:    `Analytics chart ${id || "(unknown)"} has no input_evidence_ids — cannot trace chart back to source evidence`,
      });
    }

    // Analytics chart used on main slide must be direct_support
    const visualSupport = ae?.analytics_visual_support || "contextual_support";
    if (visualSupport === "not_supporting") {
      issues.push({
        issue:    "analytics_chart_not_supporting_claim",
        severity: "blocking",
        label:    `Analytics chart ${id || "(unknown)"} is classified as not_supporting for this claim — move to appendix/dashboard`,
      });
    }

    // Contextual analytics on main slide: warning only (not blocking, may be correct)
    if (visualSupport === "contextual_support" && slide.claim_id) {
      issues.push({
        issue:    "analytics_chart_contextual_only",
        severity: "info",
        label:    `Analytics chart ${id || "(unknown)"} is contextual_support — consider moving to appendix if it does not directly support "${(slide.claim_text || "").slice(0, 50)}"`,
      });
    }
  }

  return issues;
}

// ── Visual support relationship check ────────────────────────────────────────

function checkVisualSupportRelationship(slide) {
  const issues = [];

  // For main analytical slides, external visual callouts must be direct_support
  const isAnalyticalMain = !STRUCTURAL_NO_ROLE_CHECK.has(slide.slide_type) &&
    ["critical_claim", "trend_claim", "evidence_support", "analytics_pattern"].includes(slide.slide_type);

  if (!isAnalyticalMain) return issues;

  for (const vc of (slide.external_visual_callouts || [])) {
    const rel = vc?.visual_support_relationship;
    if (!rel) continue; // not yet classified

    if (rel === "not_supporting") {
      issues.push({
        issue:    "visual_not_supporting_claim",
        severity: "blocking",
        label:    `Visual ${vc.visualization_id} is classified as not_supporting for claim "${(slide.claim_text || "").slice(0, 50)}" — same-category but irrelevant visuals must not appear on main analytical slides`,
      });
    }

    if (rel === "contextual_support") {
      issues.push({
        issue:    "contextual_visual_on_main_slide",
        severity: "warning",
        label:    `Visual ${vc.visualization_id} is contextual_support — should be in appendix, dashboard, or background slides only`,
      });
    }
  }

  return issues;
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

  // --- New: bullet role validation ---
  issues.push(...checkBulletRoles(slide));

  // --- New: analytics chart validation ---
  issues.push(...checkAnalyticsPackets(slide));

  // --- New: visual support relationship ---
  issues.push(...checkVisualSupportRelationship(slide));

  // --- New: evidence callout integrity (URL format, publisher, key_fact) ---
  issues.push(...checkEvidenceCalloutIntegrity(slide));

  // --- New: evidence ID leak check (hard-fail: ev-* in visible content) ---
  issues.push(...checkEvidenceIdLeak(slide));

  // --- New: factual bullets missing URL (warning) ---
  issues.push(...checkBulletsMissingUrl(slide));

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
    if (strict) {
      let sanitized = sanitizeText(slide.headline, headlineIssues);
      // Headline can't be dropped — fall back to core_message when stat is unverified
      sanitized = sanitized !== null ? sanitized : (slide.core_message || slide.headline);
      // Also strip any ev-* IDs that leaked into the headline
      cleanedHeadline = sanitized.replace(EV_ID_LEAK_RE, "").replace(/\s{2,}/g, " ").trim() || sanitized;
    }
  }

  // --- Rule 1 + 5: numbers and prohibited phrases in bullets ---
  const cleanedBullets = [];
  const bulletIssues   = {};

  for (const bullet of (slide.bullets || [])) {
    // Handle both structured {text, bullet_role} objects and legacy plain strings
    const bulletText = typeof bullet === "object" ? (bullet?.text || "") : (bullet || "");
    const bIssues = [
      ...checkNumbers(bulletText, "bullet"),
      ...checkProhibitedPhrases(bulletText, slide, "bullet"),
    ];
    bulletIssues[bulletText] = bIssues;
    issues.push(...bIssues);

    if (strict) {
      let cleaned = sanitizeText(bulletText, bIssues);
      // Also strip ev-* IDs that leaked into the bullet
      if (cleaned !== null) {
        cleaned = cleaned.replace(EV_ID_LEAK_RE, "").replace(/\s{2,}/g, " ").trim() || cleaned;
      }
      // null = hallucinated stat → drop the bullet entirely
      if (cleaned !== null) {
        if (typeof bullet === "object") {
          cleanedBullets.push({ ...bullet, text: cleaned });
        } else {
          cleanedBullets.push(cleaned);
        }
      }
      // Else: bullet dropped — still logged in issues
    } else {
      cleanedBullets.push(bullet);
    }
  }

  // --- Item 5: bullet grounding QA ---
  // Check each finding/evidence bullet's content-word overlap with cited evidence
  // and detect scope inflation (lab/research → operational/real-world).
  const groundingResults = checkBulletGrounding(slide);
  const groundingByText = new Map(groundingResults.map((r) => [r.bullet.text, r]));
  // Apply grounding corrections/removals to cleanedBullets
  const finalBullets = [];
  for (const bullet of cleanedBullets) {
    const text = typeof bullet === "object" ? bullet.text : bullet;
    const gr = groundingByText.get(text);
    if (!gr) { finalBullets.push(bullet); continue; }
    if (gr.support_status === "unsupported" && strict) {
      issues.push({
        issue: "bullet_not_grounded", severity: "blocking",
        label: `Bullet dropped — ${gr.reason}`,
        original_text: text,
      });
      // Drop: don't push to finalBullets
    } else if (gr.support_status === "overstates_scope" && strict) {
      issues.push({
        issue: "bullet_overstates_scope", severity: "warning",
        label: gr.reason,
        original_text: text,
        corrected_text: gr.corrected_bullet || text,
        required_caveat: gr.required_caveat,
      });
      // Use corrected bullet if available
      const corrected = gr.corrected_bullet;
      if (corrected) {
        finalBullets.push(typeof bullet === "object" ? { ...bullet, text: corrected,
          caveat: gr.required_caveat || bullet.caveat } : corrected);
      } else {
        finalBullets.push(bullet);
      }
    } else {
      finalBullets.push(bullet);
    }
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

  // Determine if the slide needs a deterministic fallback because too few bullets remain
  // after dropping hallucinated stats or grounding failures. < 2 bullets = not useful.
  const tooFewBullets = strict && finalBullets.length < 2 &&
    issues.some((i) => i.issue === "hallucinated_statistic" || i.issue === "bullet_not_grounded");

  const fixedSlide = strict ? {
    ...slide,
    headline:   cleanedHeadline,
    bullets:    finalBullets,
    citations:  sanitizedCitations,
    qa_failed:  tooFewBullets,   // triggers deterministicFallback in slidesLayer
    content_qa: {
      qa_pass:         blockingIssues.length === 0,
      issues,
      blocking_count:  blockingIssues.length,
      warning_count:   issues.filter((i) => i.severity === "warning").length,
      sanitized:       strict && blockingIssues.length > 0,
      needs_fallback:  tooFewBullets,
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

  // Deck-level: cross-slide statistic consistency
  const crossSlideIssues = checkCrossSlideStatConsistency(results);

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

  // New QA categories
  const bulletRoleViolations      = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "finding_bullet_missing_evidence_id" || i.issue === "bullet_invalid_role"));
  const analyticsNotSupporting    = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "analytics_chart_not_supporting_claim" || i.issue === "analytics_chart_missing_input_evidence_ids"));
  const contextualVisualMainSlide = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "contextual_visual_on_main_slide" || i.issue === "visual_not_supporting_claim"));
  const evidenceIdLeaks           = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "evidence_id_leak"));
  const bulletsMissingUrl         = results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "factual_bullet_missing_url"));

  if (crossSlideIssues.length > 0) {
    process.stdout.write(
      `  [L7b-content-qa] DECK-LEVEL: ${crossSlideIssues.length} cross-slide statistic inconsistencies detected\n`
    );
  }

  if (totalBlocking > 0 || totalWarnings > 0) {
    process.stdout.write(
      `  [L7b-content-qa] ${totalBlocking} slides with blocking issues, ${totalWarnings} with warnings\n` +
      (hallucinatedStats.length > 0
        ? `  [L7b-content-qa] BLOCKING: hallucinated statistics (bullets dropped) on slides ${hallucinatedStats.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (inflatedCitations.length > 0
        ? `  [L7b-content-qa] BLOCKING: inflated citation titles on slides ${inflatedCitations.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (analyticsNotSupporting.length > 0
        ? `  [L7b-content-qa] BLOCKING: analytics charts not supporting claim on slides ${analyticsNotSupporting.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (contextualVisualMainSlide.length > 0
        ? `  [L7b-content-qa] WARNING: contextual/unsupported visuals on main analytical slides ${contextualVisualMainSlide.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (suppressCandidates.length > 0
        ? `  [L7b-content-qa] WARNING: ${suppressCandidates.length} category slides with no evidence\n`
        : "") +
      (evidenceIdLeaks.length > 0
        ? `  [L7b-content-qa] BLOCKING: ev-* ID leaks in visible content on slides ${evidenceIdLeaks.map((s) => s.slide_number).join(", ")}\n`
        : "") +
      (bulletsMissingUrl.length > 0
        ? `  [L7b-content-qa] WARNING: factual bullets without source URLs on slides ${bulletsMissingUrl.map((s) => s.slide_number).join(", ")}\n`
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
    missing_claim_id:          missingClaimId.map((s)    => ({ slide: s.slide_number, type: s.slide_type })),
    trend_violations:           trendViolations.map((s)   => ({ slide: s.slide_number, type: s.slide_type })),
    outlook_violations:         outlookViolations.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    operational_from_ctx:       operationalFromCtx.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    // New
    bullet_role_violations:     bulletRoleViolations.map((s)   => ({ slide: s.slide_number, type: s.slide_type })),
    analytics_not_supporting:   analyticsNotSupporting.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    contextual_visual_main:     contextualVisualMainSlide.map((s) => ({ slide: s.slide_number, type: s.slide_type })),
    evidence_id_leaks:          evidenceIdLeaks.map((s) => ({ slide: s.slide_number, title: s.title })),
    bullets_missing_url:        bulletsMissingUrl.map((s) => ({ slide: s.slide_number, title: s.title })),
    all_issues:           results.flatMap((s) =>
      (s.content_qa?.issues || []).map((i) => ({ slide: s.slide_number, ...i }))
    ),
    // Deck-level checks
    cross_slide_stat_issues: crossSlideIssues,
    scope_inflation_slides:  results.filter((s) => (s.content_qa?.issues || []).some((i) => i.label === "scope_inflation"))
      .map((s) => ({ slide: s.slide_number, title: s.title })),
    callout_url_violations:  results.filter((s) => (s.content_qa?.issues || []).some((i) => i.issue === "callout_invalid_url"))
      .map((s) => ({ slide: s.slide_number, title: s.title })),
  };

  return { slides: results, report };
}
