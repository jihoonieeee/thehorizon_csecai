/**
 * Source Intent Signals
 *
 * Deterministic structural signal extraction — no semantic grading.
 *
 * DESIGN PRINCIPLE: deterministic code extracts OBSERVABLE STRUCTURAL SIGNALS
 * (source_type, publisher_class, provenance indicators, keyword presence).
 * It does NOT grade, score, or rank sources semantically.
 *
 * What this module produces:
 *   intent_class       — structural classification (not semantic quality judgment)
 *   commercial_interest — provenance indicator (from independence_level / publisher_class)
 *   evidence_posture   — structural posture (does source type typically present evidence?)
 *
 * What this module explicitly does NOT produce:
 *   tone_strength          — REMOVED: arbitrary hype-pattern count, not semantic judgment
 *   evidence_strength      — REMOVED: concreteness-derived strength is fake precision
 *   tone_evidence_mismatch — REMOVED: deterministic sentiment comparison
 *
 * These removed fields looked precise but were arbitrary regex-count thresholds.
 * Semantic judgments (is this vendor claiming too much? is the evidence strong?)
 * belong to the LLM judge in judgeEvidenceItems.js (triage_judgment.support_level,
 * triage_judgment.quote_support, triage_judgment.source_type_fit).
 *
 * ALLOWED downstream uses of source_intent:
 *   - intent_class and commercial_interest can be passed to LLM prompts as context
 *   - evidence_posture may inform extraction profile selection (which fields to look for)
 *
 * NOT ALLOWED:
 *   - intent_class alone must not assign claim_permissions
 *   - source_intent must not cap evidence_strength
 *   - source_intent must not block slide/dashboard eligibility without LLM review
 */

// ── Intent classification patterns ───────────────────────────────────────────
// These patterns identify STRUCTURAL features (CVE IDs, research methodology
// keywords, marketing verbs) — not semantic quality or tone.

const INCIDENT_WORDS       = /\b(incident|breach|attack on|was compromised|victim|hacked|data leak)\b/i;
const NAMED_ORG_PATTERN    = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;
const EXPLOIT_WORDS        = /CVE-\d{4}-\d{4,}|proof of concept|PoC|exploit code|reproduction steps/i;
const ACTOR_TTP_WORDS      = /\b(APT\d+|Lazarus|Sandworm|Fancy Bear|Cozy Bear|Salt Typhoon|Volt Typhoon|FIN\d+|UNC\d+|threat actor|TTP|indicator of compromise)\b/i;
const PRIMARY_RESEARCH_WORDS = /\b(we propose|we evaluate|we demonstrate|n=\d|dataset|experiment|methodology|ablation|our approach|our system|we present)\b/i;
const BENCHMARK_WITH_NUMBER  = /\b(benchmark|ASR|attack success rate|evaluation|F1|accuracy|precision|recall)\b.*\d+(?:\.\d+)?%|\d+(?:\.\d+)?%.*\b(ASR|attack success|F1|accuracy)\b/i;
const POLICY_WORDS         = /\b(advisory|guidance|policy|regulation|framework|compliance|mandate|recommendation)\b/i;
const MARKETING_WORDS      = /\b(announces|launches|now available|solution|protect your|our platform|our product|sign up|free trial|contact us)\b/i;
const THOUGHT_LEADERSHIP_WORDS = /\b(the future of|trends in|predictions for|what to watch|why .+ matters|how .+ will|the state of)\b/i;
const SPECULATIVE_WORDS    = /\bwill become\b|\bis expected to\b|\bcould enable\b|\bmay lead to\b/i;

/**
 * Extract structural source intent signals.
 *
 * Returns an object for LLM context and extraction profile selection.
 * MUST NOT be used as a standalone gate for claim permissions or evidence strength.
 *
 * @param {object} source
 * @returns {{
 *   intent_class: string,
 *   commercial_interest: string,
 *   evidence_posture: string,
 * }}
 */
export function classifySourceIntent(source) {
  const st          = source.source_type       || "unknown";
  const pubClass    = source.publisher_class   || "";
  const trustTier   = source.trust_tier        || "unknown";
  const indepLevel  = source.independence_level|| "";
  const evidRole    = source.evidence_role     || "";
  const title       = (source.title            || "").toLowerCase();
  const text        = (source.full_text || source.summary || source.clean_text || "").toLowerCase();
  const textHead    = text.slice(0, 500);

  // ── Intent class (ordered — first structural match wins) ─────────────────
  // This is structural identification, not quality assessment.

  let intent_class = "other";

  if (
    st === "incident" ||
    ((INCIDENT_WORDS.test(title) || INCIDENT_WORDS.test(textHead)) && NAMED_ORG_PATTERN.test(title + " " + textHead))
  ) {
    intent_class = "incident_report";
  }
  else if (
    st === "exploit_disclosure" || st === "vulnerability" ||
    EXPLOIT_WORDS.test(text) || EXPLOIT_WORDS.test(title)
  ) {
    intent_class = "exploit_disclosure";
  }
  else if (
    st === "threat_intelligence" || st === "adversary_adoption_signal" ||
    (trustTier === "primary" && ACTOR_TTP_WORDS.test(text))
  ) {
    intent_class = "threat_intelligence";
  }
  else if (
    (st === "research_finding" || st === "benchmark_evaluation") &&
    PRIMARY_RESEARCH_WORDS.test(text)
  ) {
    intent_class = "primary_research";
  }
  else if (
    BENCHMARK_WITH_NUMBER.test(text) || BENCHMARK_WITH_NUMBER.test(title)
  ) {
    intent_class = "benchmark";
  }
  else if (
    st === "governance_signal" ||
    pubClass === "primary_authority" ||
    POLICY_WORDS.test(title) || POLICY_WORDS.test(textHead)
  ) {
    intent_class = "policy_guidance";
  }
  else if (
    indepLevel === "vendor_interested" || indepLevel === "self_reported" ||
    MARKETING_WORDS.test(title) || MARKETING_WORDS.test(textHead)
  ) {
    intent_class = "vendor_marketing";
  }
  else if (
    pubClass === "media" &&
    (evidRole === "corroborating_secondary" || evidRole === "secondary_summary")
  ) {
    intent_class = "news_summary";
  }
  else if (
    THOUGHT_LEADERSHIP_WORDS.test(title) || THOUGHT_LEADERSHIP_WORDS.test(textHead)
  ) {
    intent_class = "thought_leadership";
  }
  else if (
    SPECULATIVE_WORDS.test(text) || SPECULATIVE_WORDS.test(title)
  ) {
    intent_class = "speculative_blog";
  }
  else if (st === "research_finding" || st === "benchmark_evaluation") {
    intent_class = "primary_research";
  }

  // ── Commercial interest — provenance indicator only ───────────────────────
  // Identifies financial interest as a signal; does NOT automatically downgrade.

  let commercial_interest;
  if (intent_class === "vendor_marketing") {
    commercial_interest = "high";
  } else if (
    (intent_class === "thought_leadership" && (indepLevel === "vendor_interested" || pubClass === "major_vendor")) ||
    indepLevel === "vendor_interested"
  ) {
    commercial_interest = "medium";
  } else if (intent_class === "news_summary" || intent_class === "thought_leadership") {
    commercial_interest = "low";
  } else {
    commercial_interest = "none";
  }

  // ── Evidence posture — structural indicator only ──────────────────────────
  // Does this type of source typically present evidence before conclusions?
  // Used to guide extraction profile selection, not to gate evidence strength.

  const EVIDENCE_FIRST_CLASSES = new Set([
    "primary_research", "benchmark", "incident_report", "exploit_disclosure",
    "threat_intelligence", "policy_guidance",
  ]);
  const ARGUMENT_FIRST_CLASSES = new Set(["thought_leadership", "news_summary"]);

  let evidence_posture;
  if (EVIDENCE_FIRST_CLASSES.has(intent_class))        evidence_posture = "evidence_first";
  else if (ARGUMENT_FIRST_CLASSES.has(intent_class))   evidence_posture = "argument_first";
  else if (intent_class === "vendor_marketing")         evidence_posture = "marketing_first";
  else if (intent_class === "speculative_blog")         evidence_posture = "prediction_first";
  else                                                  evidence_posture = "argument_first";

  return {
    intent_class,
    commercial_interest,
    evidence_posture,
    // NOTE: tone_strength, evidence_strength, tone_evidence_mismatch were
    // removed (2026-06-17) — they were arbitrary hype-count thresholds.
    // Semantic tone/strength judgment belongs to the LLM (triage_judgment fields).
  };
}

/**
 * Apply source intent signal extraction to all sources.
 *
 * @param {object[]} sources
 * @returns {object[]} Sources with source_intent field added
 */
export function applySourceIntentToSources(sources) {
  return sources.map((source) => ({
    ...source,
    source_intent: classifySourceIntent(source),
  }));
}
