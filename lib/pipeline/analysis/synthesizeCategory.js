/**
 * L6.3 — Category Synthesis (single strong viewpoints-first LLM call)
 *
 * ONE call per category over the compact 5A/5B/5C evidence dossier. The model
 * identifies analytical VIEWPOINTS first, then produces the analyst outputs and
 * traces each back to evidence_ids from the dossier. It must NOT invent evidence
 * ids or facts. Deterministic validation (validateCategoryAnalysis.js) enforces
 * every constraint afterwards.
 *
 * ── MODEL STRATEGY ────────────────────────────────────────────────────────────
 *   Primary:  task "category_synthesis" → routed by taskProfiles.js → Anthropic Opus
 *   Fallback: Gemini Pro (standard tier)
 *
 *   The expensive Opus model is intentional here: this is the core reasoning step.
 *   Deterministic validation (validateCategoryAnalysis.js) enforces evidence constraints
 *   downstream, so the model is trusted to reason but cannot invent evidence IDs.
 *
 *   To override per-environment, set:
 *     ANTHROPIC_OPUS_MODEL env var (default: claude-opus-4-8)
 *
 *   Cross-category synthesis (runCrossCategorySynthesis.js) uses Sonnet,
 *   not Opus — it synthesizes from already-validated category outputs.
 *
 * ── OUTPUT CONTRACT ────────────────────────────────────────────────────────────
 * Returns the parsed contract object (with model_used attached), or null when
 * no LLM is available or the call fails. Null triggers deterministicAnalysis()
 * fallback in analyzeCategory.js.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { scrubImpliedQuantitatives as _scrubImplied } from "./statisticalClaimQa.js";
import { validateSynthesisBatch } from "../../llm/outputValidators.js";

// ── Output schema ─────────────────────────────────────────────────────────────

const STRATEGIC_JUDGMENT_ITEM = {
  type: "object",
  required: [
    "judgment", "judgment_type", "evidence_for", "evidence_against",
    "why_this_matters", "what_changed", "causal_mechanism",
    "uncertainty", "confidence", "supporting_evidence_ids",
    "judgment_flags",   // required — no regex fallback for missing flags
    "short_takeaway",   // required — dashboard/slide headline
  ],
  properties: {
    judgment_id:              { type: "string" },
    // Full analytical conclusion — minimum 20 words. Must state WHAT changed,
    // WHO is affected (if known), and WHY it matters. NOT a label or title.
    // Example: "Unpatched path traversal in Langflow (CVE-2026-5027) enables
    // remote code execution against deployed AI agent infrastructure, observed
    // exploited in the wild — attackers can pivot from agent to host system."
    judgment:                 { type: "string", minLength: 30 },
    judgment_type: {
      type: "string",
      enum: [
        "operational_shift", "capability_change", "adversary_adoption",
        "risk_elevation", "technique_evolution", "ecosystem_change",
        "monitoring_required", "early_signal",
      ],
    },
    // IDs from this dossier that support the judgment
    evidence_for:             { type: "array", items: { type: "string" } },
    // IDs that weaken or contradict — empty array if none found
    evidence_against:         { type: "array", items: { type: "string" } },
    // What is specifically DIFFERENT now — name the before/after if visible
    what_changed:             { type: "string" },
    // WHY this is happening — the enabling factor or driver, not the description
    causal_mechanism:         { type: "string" },
    // Defender or ecosystem consequence
    why_this_matters:         { type: "string" },
    // What happens downstream if this pattern continues
    second_order_implications:{ type: "array", items: { type: "string" } },
    // Who is most affected
    affected_stakeholders:    { type: "array", items: { type: "string" } },
    // What we don't know / what would change this judgment
    uncertainty:              { type: "string" },
    confidence:               { type: "string", enum: ["high", "medium", "low"] },
    // Observable indicators to watch that would confirm or deny
    monitoring_signals:       { type: "array", items: { type: "string" } },
    // Specific defender actions (lead with verbs)
    recommended_actions:      { type: "array", items: { type: "string" } },
    // Union of evidence_for for traceability
    supporting_evidence_ids:  { type: "array", items: { type: "string" } },
    caveat_if_any:            { type: ["string", "null"] },
    slide_usefulness:         { type: "string", enum: ["high", "medium", "low"] },
    // ── Semantic flags (LLM-assigned) ─────────────────────────────────────────
    // These replace downstream regex scanning of judgment text.
    // Deterministic gates in validateCategoryAnalysis.js and claimQa.js READ
    // these flags instead of re-parsing free text with keyword patterns.
    judgment_flags: {
      type: "object",
      required: ["implies_adoption", "implies_operational", "implies_trend",
                 "is_forward_looking", "is_market_wide", "is_lab_only"],
      properties: {
        implies_adoption:    { type: "boolean" }, // asserts real-world adversary adoption/use
        implies_operational: { type: "boolean" }, // asserts operational/production deployment
        implies_trend:       { type: "boolean" }, // asserts a trend over multiple time periods
        is_forward_looking:  { type: "boolean" }, // speculative/projected (not yet observed)
        is_market_wide:      { type: "boolean" }, // claims broad market/industry-wide scope
        is_lab_only:         { type: "boolean" }, // limited to research/lab context
      },
    },
    // Secondary attributes for claim QA (replaces regex in detectSecondaryAttributes)
    secondary_attributes: {
      type: "array",
      items: { type: "string", enum: ["real_world_use", "lab_only", "forward_looking", "market_wide", "vendor_claim"] },
    },
    // ── Dashboard-facing fields ───────────────────────────────────────────────
    // short_takeaway: ≤15 words, dashboard headline. The ONE sentence a defender
    // needs. Not a restatement — the actionable conclusion in plain language.
    short_takeaway: { type: "string" },
    // dashboard_relevance_hint: signals what kind of dashboard panel this belongs in.
    dashboard_relevance_hint: {
      type: "string",
      enum: [
        "trend_alert",         // a measurable directional shift in the threat landscape
        "incident_signal",     // a concrete event or confirmed adversary action
        "capability_update",   // a new or significantly enhanced threat capability
        "risk_elevation",      // increased risk to defender systems/posture
        "emerging_watchlist",  // early signal that needs monitoring, not yet confirmed
        "coverage_gap",        // something the evidence cannot yet establish
      ],
    },
  },
};

const SCHEMA = {
  type: "object",
  required: ["strategic_judgments", "evidence_gaps", "outlook_6_months"],
  properties: {
    // Up to 5 judgments ordered by strategic significance
    strategic_judgments: { type: "array", maxItems: 5, items: STRATEGIC_JUDGMENT_ITEM },
    evidence_gaps:       { type: "array", items: { type: "string" } },
    outlook_6_months: {
      type: "object",
      required: ["observed_basis", "projected_trajectory", "reasoning", "confidence", "supporting_evidence_ids"],
      properties: {
        observed_basis:          { type: "string" },
        projected_trajectory:    { type: "string" },
        reasoning:               { type: "string" },
        confidence:              { type: "string", enum: ["high", "medium", "low"] },
        caveat_if_any:           { type: ["string", "null"] },
        supporting_evidence_ids: { type: "array", items: { type: "string" } },
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior AI threat intelligence analyst. Your task is to ANALYZE evidence and produce strategic judgments — not to summarize or describe it.

You are given a structured evidence dossier with three origins:
  5A_rawfact  — atomic facts extracted from the collected corpus
  5B_analytics — corpus-level measurements (CORPUS-SCOPED, not global)
  5C_external — authoritative external statistics / reports / benchmarks

## THE ANALYST QUESTION SET

Before writing each judgment, you must be able to answer ALL of these:
1. What CHANGED? (new capability, new adoption pattern, new scale, new actor, new technique)
2. WHY is it happening? (causal mechanism — what enables or drives it, not just a description)
3. WHY NOW? (what makes this evidence or this period significant)
4. What ASSUMPTION does this challenge or confirm?
5. What is the OPERATIONAL or STRATEGIC IMPLICATION for defenders?
6. What evidence SUPPORTS this? What WEAKENS or CONTRADICTS it?
7. What should be WATCHED to confirm or deny this judgment?

If you cannot answer at least questions 1, 2, 4, and 5 with evidence, do not write the judgment.
Move it to evidence_gaps instead.

## WHAT A STRATEGIC JUDGMENT LOOKS LIKE

BAD — summary only (BLOCKED — do not write these):
  "Prompt injection continues to be a notable attack technique"
  "Multiple sources document adversarial ML threats"
  "The LLM security landscape remains complex and evolving"

BAD — descriptive only (BLOCKED — do not write these):
  "Researchers demonstrated prompt injection against several LLMs in controlled settings"
  "Several CVEs were disclosed in AI-related frameworks this period"

GOOD — analytical (has change + cause + implication):
  "Automation of jailbreak search is commoditizing bypass tooling: JailbreakOPT achieves 88% ASR on GPT-4 via gradient-based search, removing the artisanal skill requirement — this lowers the barrier for low-sophistication adversaries, likely within 6 months."

GOOD — strategic (has change + cause + second-order effects + uncertainty):
  "Tool-call chain depth multiplies prompt injection blast radius beyond single-agent models: compound tool chains create multi-hop propagation paths. Consequence: defenders must now validate trust at every inter-agent handoff, not just at LLM input. Key uncertainty: whether production deployments use chain depths seen in research contexts."

The difference: good judgments name the MECHANISM, state the IMPLICATION, and acknowledge UNCERTAINTY.

## EVIDENCE WEIGHT — CONCRETE ANCHORS MATTER, DRAMATIC LANGUAGE DOES NOT

HIGH WEIGHT (cite as primary support for high-confidence judgments):
  - Named CVE with reproduction method or confirmed exploitation
  - Named AI model + specific attack technique + measured result (e.g. "88% ASR on GPT-4")
  - Incident report with named victim, named attacker, named method, and date
  - Authoritative advisory (CISA, NIST, Anthropic, Google security) with specific affected systems
  - Academic paper with methodology, sample sizes, and reproducible results
  - Named threat actor with observed TTPs

MEDIUM WEIGHT (cite as supporting evidence; confidence=medium):
  - Secondary reporting that cites a specific named primary source
  - Vendor threat intelligence with named actor or named campaign
  - Research with some specifics but limited scope

LOW WEIGHT (context only — cannot ground high-confidence judgments):
  - Vendor blog posts with no named CVE, no named incident, no measured results
  - Dramatic language without specific named entities, metrics, dates, or methods
  - Predictions about future AI use without observed evidence

CORPUS STATISTICS ARE ABOUT YOUR COLLECTION, NOT THE THREAT LANDSCAPE:
  5B analytics show how many of YOUR COLLECTED SOURCES discuss a topic.
  They CANNOT alone support real-world incident, adoption, or market-wide claims.
  They CAN inform corpus-scoped observations with explicit "within the collected corpus" phrasing.

For confidence:
  high: requires ≥2 HIGH WEIGHT evidence items from different sources
  medium: MEDIUM WEIGHT evidence, or HIGH WEIGHT from a single source
  low: LOW WEIGHT evidence only, or single weak signal — must acknowledge explicitly
Never assign "high" confidence from LOW WEIGHT (dramatic-language-only) sources.

## ANALYTICS (5B) STRICT RULES
5B analytics describe YOUR COLLECTION, not the real world. They CANNOT alone support:
  - real-world incident claims ("adversaries are using X")
  - adoption claims ("X has been widely adopted")
  - market-wide claims ("the industry is shifting to X")
  - incident frequency claims ("there have been N attacks")

If you use a 5B item to support a judgment, that judgment MUST use corpus-scoped language.

## JUDGMENT_TYPE — USE ONLY THESE 8 VALUES (no others)
  operational_shift    — a shift in how a threat operates in the real world
  capability_change    — a new or significantly enhanced attacker capability demonstrated
  adversary_adoption   — direct evidence of adversary adoption or confirmed use in the wild
  risk_elevation       — increased risk exposure or reduced defensive effectiveness
  technique_evolution  — evolution of an existing technique (new variant, new scale, new target)
  ecosystem_change     — a structural change in the threat ecosystem (supply chain, platforms, trust models)
  monitoring_required  — an early-stage signal that needs watching but cannot yet support a strong claim
  early_signal         — emerging evidence of a new threat pattern, insufficient for trend/adoption claims

If none of these fit, move the judgment to evidence_gaps instead of inventing a type.

## HARD RULES
- Use ONLY evidence_ids that appear in the dossier below. NEVER invent an id.
- Every judgment MUST cite evidence_for (≥1 id) — even low-confidence judgments.
- "what_changed" MUST be at least one complete sentence (minimum ~15 words) describing a specific observable change. State what was true before and what is different now. NEVER leave it blank, write a single word, or write a generic phrase like "N/A" or "threat increased".
- "causal_mechanism" MUST explain WHY the change is happening — the enabling factor or driver. Not a description of what happened, but what is causing it.
- NEVER claim real-world adversary ADOPTION unless 5A evidence is from an observed source type (incident / threat_intelligence / adversary_adoption_signal). Research/benchmark = capability demonstrated, not adoption.
- evidence_against MUST be [] if no contradicting evidence found in this dossier — do not fabricate opposition.
- supporting_evidence_ids MUST be the union of evidence_for (plus any evidence_against if cited).
- outlook_6_months MUST separate observed_basis (what the evidence actually shows) from projected_trajectory (what may follow). Use hedged language ("may", "could", "is likely to") in projected_trajectory.
- If evidence is thin, produce fewer judgments and be explicit in evidence_gaps. Never pad with summary-only content.
- Obey CORPUS REPRESENTATIVENESS constraints. When a constraint blocks a claim, move it to evidence_gaps.
- CONFIDENCE CEILING: never assign confidence above the stated ceiling from the ANALYTICAL STATE block.

## SEMANTIC FLAGS (judgment_flags + secondary_attributes)
Every judgment MUST include judgment_flags and secondary_attributes so that downstream validation
can gate on your stated intent rather than re-scanning text with keyword patterns.

judgment_flags (all boolean — default false if not applicable):
  implies_adoption:    true when you assert real-world adversary adoption or use ("adversaries are using X", "deployed in the wild")
  implies_operational: true when you assert operational/production deployment (not just lab demonstration)
  implies_trend:       true when you claim a pattern across multiple time periods ("increasing over", "growing trend")
  is_forward_looking:  true when the judgment is speculative or projected, not yet observed
  is_market_wide:      true when the claim scope is broad industry-wide or ecosystem-wide
  is_lab_only:         true when the finding is limited to a research or lab context

secondary_attributes (subset of ["real_world_use","lab_only","forward_looking","market_wide","vendor_claim"]):
  real_world_use  — judgment references confirmed real-world deployment or incidents
  lab_only        — evidence is purely from research/benchmark/lab settings
  forward_looking — judgment is primarily about future projection
  market_wide     — claim implies broad industry or market scope
  vendor_claim    — primary evidence is vendor self-reporting

IMPORTANT: These flags let validators enforce semantic rules (e.g. adoption claims require
observed-use evidence) without using fragile text-matching heuristics. Be precise.
If you use adversary_adoption judgment_type, implies_adoption=true is expected.
If you use capability_change and evidence is lab-only, is_lab_only=true and real_world_use must NOT be set.

## DASHBOARD FIELDS (short_takeaway + dashboard_relevance_hint)
Every judgment MUST include:

short_takeaway (≤15 words): The one sentence a security analyst needs to act on.
  - NOT a restatement of the judgment text — it is the distilled ACTIONABLE CONCLUSION.
  - GOOD: "Prompt injection tooling is now automated, lowering skill barrier for attackers"
  - BAD: "Prompt injection remains an important threat to LLM systems"
  - GOOD: "GPT-4-based phishing kits are being sold on criminal forums for $50/month"
  - BAD: "AI-enabled phishing is a growing concern for organizations"
  Write the takeaway a CISO would quote in a meeting.

dashboard_relevance_hint: Pick the one that best fits:
  trend_alert        — measurable directional shift (e.g. adoption growing, technique proliferating)
  incident_signal    — confirmed real-world event, adversary action, or breach
  capability_update  — new or significantly enhanced threat capability demonstrated
  risk_elevation     — increased exposure or reduced defensive control effectiveness
  emerging_watchlist — early/preliminary signal, needs monitoring not action yet
  coverage_gap       — something important that the evidence cannot yet establish

## OUTPUT FIELD GUIDANCE
judgment (REQUIRED, ≥20 words): The full analytical CONCLUSION. Must name the specific threat, state what changed or was demonstrated, and state the defender implication. NOT a label, title, or one-word answer.
  BAD: "Exploit detected"  |  "CVE-2026-5027"  |  "Threat elevated"  |  ""
  GOOD: "Unpatched path traversal in Langflow (CVE-2026-5027) enables remote code execution against deployed AI agent infrastructure and is being actively exploited in the wild — attackers can pivot from the agent process to the host system, exposing connected tools and credentials."

what_changed (REQUIRED, ≥15 words): State the specific BEFORE and AFTER. What was the situation before? What is different now?
  BAD: "increased"  |  "N/A"  |  "threat grew"
  GOOD: "Previously Langflow path traversal was a theoretical risk (patched in 1.3.0); CVE-2026-5027 discloses that unpatched deployments are now actively exploited, confirming real adversary operationalization."

causal_mechanism (REQUIRED, ≥10 words): WHY is this happening — the enabling factor or technical driver. Not "research shows." Not "capabilities improving." What specifically enables or causes this?
  BAD: "LLM synthesis"  |  "Automation"  |  "Research advances"  |  null
  GOOD: "Open-weight LLMs eliminated the compute barrier that previously made adversarial attack generation impractical for low-resourced actors"
  GOOD: "Indirect injection exploits LLMs' inability to distinguish trusted user instructions from untrusted retrieved content — a fundamental architectural trust boundary violation"
  GOOD: "Gradient-based jailbreak search can now be run in black-box mode against API endpoints, removing the need for model weight access"

why_this_matters (REQUIRED, ≥10 words): DEFENDER or ECOSYSTEM CONSEQUENCE. Not "this is a concern." Not "defenders should be aware." What specifically changes for the people being defended?
  BAD: "Defenders must adapt"  |  "This is a risk"  |  null
  GOOD: "Enterprise RAG pipelines are now an untested attack surface: any document ingested from the internet can silently redirect agent behavior, and existing DLP tools do not inspect LLM tool-call chains"
  GOOD: "Spear-phishing detection models trained on pre-2025 distributions will systematically underperform because the population of lures now includes AI-synthesized content with human-like specificity"

## STATISTICS — ABSOLUTE RULE
ANY number, percentage, dollar amount, or growth rate in your output MUST appear verbatim in an evidence item in this dossier. This rule overrides your training knowledge.
If you cannot find the exact figure in a listed evidence_id — OMIT IT. Qualitative language is better than a fabricated number.
FORBIDDEN: "$893 million", "2,137%", "nearly 100 vulnerabilities" unless verbatim in dossier.

## EVIDENCE SIGNALS (starting points — form YOUR OWN strategic judgments)
The ANALYTICAL STATE block below lists pre-computed evidence signals (OBSERVATIONS, not conclusions).
These describe what the data shows. You must analyze what these signals MEAN, WHY they matter,
and WHAT THEY IMPLY — form your own strategic judgment.
Do NOT simply restate a signal as your judgment. That is a summary, not analysis.
Never assign confidence above the stated CONFIDENCE CEILING.

Return strict JSON matching the schema. No markdown, no preamble.`;

function fmt5A(items) {
  return items.map((e) => {
    const provenance = [e.publisher, e.date].filter(Boolean).join(", ");
    let line = `  [${e.evidence_id}] (${e.source_type}/${e.evidence_strength}${provenance ? ` | ${provenance}` : ""}) ${e.fact}`;
    if (e.numbers?.length)       line += ` | nums: ${e.numbers.join("; ")}`;
    if (e.permitted_uses?.length) line += ` | uses: ${e.permitted_uses.join(",")}`;
    if (e.limitations?.length)   line += ` | limits: ${e.limitations.join(",")}`;
    // Verbatim quote — show more (200 chars) for rich excerpts
    const quote = (e.source_quote || "").trim();
    if (quote.length >= 20) line += `\n    quote: "${quote.slice(0, 200)}${quote.length > 200 ? "…" : ""}"`;
    // Rich context fields (v2.0 extraction) — directly tell the LLM what this evidence establishes
    if (e.caveats)                      line += `\n    caveats: ${e.caveats}`;
    if (e.what_this_establishes)        line += `\n    establishes: ${e.what_this_establishes}`;
    if (e.what_this_cannot_establish)   line += `\n    cannot establish: ${e.what_this_cannot_establish}`;
    // Analytical hooks from extraction
    if (e.analytical_hook)       line += `\n    hook: ${e.analytical_hook}`;
    if (e.novelty_signal)        line += `\n    novelty: ${e.novelty_signal}`;
    if (e.what_changed)          line += `\n    changed: ${e.what_changed}`;
    if (e.assumption_challenged) line += `\n    challenges: ${e.assumption_challenged}`;
    return line;
  }).join("\n") || "  (none)";
}
function fmt5B(items) {
  return items.map((e) =>
    `  [${e.evidence_id}] ${e.metric}: ${e.finding || e.value_summary} (n=${e.source_count}, conf=${e.confidence}${e.caveat ? `, caveat: ${e.caveat}` : ""})`
  ).join("\n") || "  (none)";
}
function fmt5C(items) {
  return items.map((e) =>
    `  [${e.evidence_id}] ${e.title} — ${e.claim}` +
    (e.metric_value ? ` | ${e.metric_name || "metric"}: ${e.metric_value}` : "") +
    (e.publisher ? ` [${e.publisher}]` : "")
  ).join("\n") || "  (none)";
}

export function buildCorpusAuditBlock(ca) {
  if (!ca) return "";
  const flags = [...(ca.source_concentration_flags || []), ...(ca.evidence_gap_flags || [])];
  const lines = [
    `=== CORPUS REPRESENTATIVENESS (governs what you may claim) ===`,
    `analysis_allowed: ${ca.analysis_allowed || "full"}`,
    flags.length ? `flags: ${flags.join(", ")}` : `flags: none`,
  ];
  for (const lim of (ca.analysis_limitations || [])) lines.push(`- ${lim}`);
  // Hard guidance derived from the flags — the deterministic validator enforces these
  // again afterwards, but stating them here keeps the model from over-claiming.
  const guidance = [];
  if (flags.includes("vendor_heavy"))
    guidance.push("Corpus is vendor-dominated: do NOT make strategic assessments without an explicit vendor-bias caveat.");
  if (flags.includes("research_heavy"))
    guidance.push("Corpus is research-dominated: treat findings as CAPABILITY, not real-world adoption; no operational/adoption claims.");
  if (flags.includes("operational_evidence_sparse"))
    guidance.push("No operational evidence: do NOT assert real-world incidents or adversary adoption.");
  if (flags.some((f) => String(f).startsWith("single_publisher_dominance")))
    guidance.push("One publisher dominates: do NOT present trends — perspective diversity is insufficient.");
  if (ca.analysis_allowed === "insufficient")
    guidance.push("Corpus is INSUFFICIENT: only capability (lab), speculative outlook, and cautionary recommendation claims are permitted; everything else must go in evidence_gaps.");
  if (guidance.length) { lines.push(``); lines.push(`CLAIM CONSTRAINTS:`); for (const g of guidance) lines.push(`- ${g}`); }
  lines.push(``);
  return lines.join("\n");
}

// Derive a minimal analytical state from the compact dossier when none is pre-computed.
// Gives the LLM a confidence ceiling based on evidence quality and flags whether
// operational evidence is present — preventing the LLM from inferring adoption claims
// from a research-only corpus without explicit flags.
function deriveAnalyticalStateFromDossier(cd, corpusAudit) {
  if (!cd) return null;
  const items = cd.evidence_5A || [];
  const hasStrong    = items.some((e) => e.evidence_strength === "strong");
  const hasUsable    = items.some((e) => e.evidence_strength === "usable");
  const hasOperational = items.some((e) =>
    ["incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure"].includes(e.source_type)
  );
  // Ceiling from evidence quality (corpus audit may further constrain it)
  let ceiling = hasStrong ? "high" : hasUsable ? "medium" : "low";
  // If corpus audit blocks adoption/operational, cap at medium even with strong evidence
  const auditBlocked = corpusAudit?.blocked_claim_types || [];
  if (auditBlocked.includes("adoption") || auditBlocked.includes("real_world_factual")) {
    if (ceiling === "high") ceiling = "medium";
  }

  // Surface blocked claim types from corpus audit in the analytical state block
  const blocked_claim_types = auditBlocked.map((ct) => ({
    claim_type: ct,
    blocking_reason: corpusAudit?.analysis_limitations?.[0] || "blocked by corpus audit",
  }));

  return {
    confidence_ceiling:  ceiling,
    ceiling_reason:      hasStrong ? "corpus has strong evidence items"
                       : hasUsable ? "corpus has usable but no strong items"
                       : "corpus evidence is context-only or archive",
    ceiling_evidence_ids: [],
    blocked_claim_types,
    evidence_signals: {
      has_operational_sources: hasOperational,
      has_adversary_adoption:  false,
      dominant_patterns:       [],
      coverage_gaps:           [],
    },
  };
}

export function buildAnalyticalStateBlock(as) {
  if (!as) return "";
  const ceilingIds = (as.ceiling_evidence_ids || []).join(", ");
  const lines = [
    `=== EVIDENCE SIGNALS (form YOUR OWN strategic judgments from these) ===`,
    `CONFIDENCE CEILING: ${as.confidence_ceiling || "low"} (no judgment may exceed this)`,
    as.ceiling_reason ? `  Reason: ${as.ceiling_reason}` : "",
    ceilingIds ? `  Driving evidence IDs: ${ceilingIds}` : "",
    ``,
    `These are OBSERVATIONS from the corpus — not conclusions. Your job is to analyze`,
    `what the signals MEAN, WHY they matter, and WHAT they imply. Do NOT restate a signal.`,
    ``,
  ].filter(Boolean);

  // Dominant threat patterns with evidence IDs
  const signals = as.evidence_signals || {};
  const patterns = signals.dominant_patterns || [];
  if (patterns.length) {
    lines.push(`DOMINANT PATTERNS:`);
    for (const p of patterns) {
      const ids = (p.supporting_evidence_ids || []).join(", ");
      lines.push(
        `  - ${p.pattern_name}: ${p.source_count} sources (${p.confidence} confidence)` +
        (ids ? ` | ids: ${ids}` : "") +
        (p.caveat_if_any ? ` ⚠ ${p.caveat_if_any}` : "")
      );
    }
    lines.push(``);
  }

  // Key signal flags
  if (signals.has_operational_sources === false) {
    lines.push(`NOTE: No operational source types — cannot assert real-world adversary adoption.`);
  }
  if (signals.has_adversary_adoption) {
    lines.push(`NOTE: Adversary adoption signals present — confirm observed_use in supporting evidence.`);
  }
  if (signals.trend_direction) {
    const tc = signals.trend_caveat ? ` (${signals.trend_caveat})` : "";
    lines.push(`NOTE: Corpus volume trend: ${signals.trend_direction}${tc}`);
  }
  if ((signals.coverage_gaps || []).length) {
    lines.push(`COVERAGE GAPS: ${signals.coverage_gaps.join("; ")}`);
  }

  // Blocked claim types (accept either key name — analyzeCategory uses blocked_claim_types,
  // tests and cross-category synthesis may pass blocked_claim_opportunities)
  const blocked = as.blocked_claim_types || as.blocked_claim_opportunities || [];
  if (blocked.length) {
    lines.push(``, `BLOCKED CLAIM TYPES (evidence does not support — move to evidence_gaps):`);
    for (const b of blocked) {
      lines.push(`  ✗ ${b.claim_type}: ${b.blocking_reason}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}

function buildLandscapeContextBlock(landscape) {
  if (!landscape) return "";
  const lines = [
    `=== LANDSCAPE SURVEY (Pass 1 broad overview — use to orient your strategic analysis) ===`,
    `Summary: ${landscape.landscape_summary || ""}`,
    ``,
  ];
  const themes = landscape.key_themes || [];
  if (themes.length) {
    lines.push(`Key themes: ${themes.join(" | ")}`);
  }
  const signals = landscape.evidence_signals || [];
  if (signals.length) {
    lines.push(`Evidence signals:`);
    for (const s of signals) {
      const ids = (s.evidence_ids || []).slice(0, 3).join(", ");
      lines.push(`  - [${s.strength || "moderate"}] ${s.signal}${ids ? ` (${ids})` : ""}`);
    }
  }
  const gaps = landscape.coverage_gaps_observed || [];
  if (gaps.length) {
    lines.push(`Observed gaps: ${gaps.join("; ")}`);
  }
  lines.push(``);
  return lines.join("\n");
}

function buildUserPrompt(cd, landscape = null) {
  // Evidence inventory summary — helps the LLM quickly understand corpus composition
  const n5A    = (cd.evidence_5A || []).length;
  const n5B    = (cd.evidence_5B || []).length;
  const n5C    = (cd.evidence_5C || []).length;
  const nStrong  = (cd.evidence_5A || []).filter((e) => e.evidence_strength === "strong").length;
  const nUsable  = (cd.evidence_5A || []).filter((e) => e.evidence_strength === "usable").length;
  const nContext = (cd.evidence_5A || []).filter((e) => e.evidence_strength === "context").length;
  const inventoryLine = `EVIDENCE INVENTORY: ${n5A} 5A items (${nStrong} strong / ${nUsable} usable / ${nContext} context), ${n5B} 5B analytics, ${n5C} 5C external`;

  return [
    `CATEGORY: ${cd.category}`,
    `SOURCES IN CATEGORY: ${cd.source_count}`,
    `TREND SUPPORT: ${cd.trend_support.item_count} dated items, ${cd.trend_support.distinct_publishers} distinct publishers, ${cd.trend_support.distinct_months} distinct months`,
    `CORPUS CONFIDENCE: ${cd.confidence_assessment}`,
    inventoryLine,
    ``,
    buildCorpusAuditBlock(cd.corpus_audit),
    buildLandscapeContextBlock(landscape),
    buildAnalyticalStateBlock(cd.analytical_state || deriveAnalyticalStateFromDossier(cd, cd.corpus_audit)),
    `=== 5A RAWFACT EVIDENCE (corpus facts) ===`,
    `Each item: [id] (source_type/strength | publisher, date) fact`,
    `  quote: "verbatim source text"  caveats: author-stated scope/confidence`,
    `  establishes: what this proves  |  cannot establish: what it does not prove`,
    fmt5A(cd.evidence_5A),
    ``,
    `=== 5B ANALYTICS EVIDENCE (corpus measurements — corpus-scoped) ===`,
    fmt5B(cd.evidence_5B),
    ``,
    `=== 5C EXTERNAL EVIDENCE (authoritative external) ===`,
    fmt5C(cd.evidence_5C),
    ``,
    cd.evidence_gaps.length ? `KNOWN EVIDENCE GAPS: ${cd.evidence_gaps.join("; ")}` : "",
    ``,
    `Produce strategic_judgments[] for this category. For each judgment: answer WHAT changed, WHY it's happening, and WHAT it implies. Cite only evidence_ids listed above. Move summary-only content to evidence_gaps.`,
    `REMINDER: judgment_flags must be set for every judgment. short_takeaway is required (≤15 words, actionable).`,
  ].filter((l) => l !== "").join("\n");
}

// ── Landscape overview pass (Pass 1) ─────────────────────────────────────────
//
// A cheap first pass that reads ALL evidence for a category and produces:
//   - landscape_summary: 3–5 sentences describing the overall threat picture
//   - key_themes[]: the 3–5 dominant analytical themes in the evidence
//   - evidence_signals[]: what the data shows (not conclusions — observations)
//   - coverage_gaps_observed[]: patterns the evidence does NOT support
//
// This runs before the strategic analysis call (Pass 2) and is injected into
// the Opus user prompt as additional analyst context. It ensures Opus has a
// broad picture of the category before forming specific strategic judgments,
// even when it cannot see every single item (60-item cap).

const LANDSCAPE_SYSTEM = `You are a senior threat intelligence analyst doing a BROAD SURVEY of evidence before deep analysis.

Your job in this pass: understand the LANDSCAPE of threats in this category from all the evidence.
Do NOT write analytical conclusions yet. Your output will be used as context for a deeper analysis pass.

Survey the evidence and identify:
1. What are the dominant themes? (attack techniques, actors, capabilities seen most)
2. What is the evidence QUALITY? (mostly research, real incidents, mix?)
3. Are there OPERATIONAL signals? (real adversary use, not just research)
4. What are the most significant INDIVIDUAL developments? (briefly name them)
5. What is MISSING? (gaps in the evidence — what questions can't be answered?)

Be specific. Name techniques, CVEs, actors, and metrics where visible.
Do NOT write generic summaries. Do NOT repeat dramatic language.
Return strict JSON only.`;

const LANDSCAPE_SCHEMA = {
  type: "object",
  required: ["landscape_summary", "key_themes", "evidence_signals", "coverage_gaps_observed"],
  properties: {
    landscape_summary: { type: "string" },
    key_themes: { type: "array", maxItems: 5, items: { type: "string" } },
    evidence_signals: { type: "array", maxItems: 8, items: {
      type: "object",
      required: ["signal", "evidence_ids"],
      properties: {
        signal:       { type: "string" },
        evidence_ids: { type: "array", items: { type: "string" } },
        strength:     { type: "string", enum: ["strong", "moderate", "weak"] },
      },
    }},
    coverage_gaps_observed: { type: "array", maxItems: 4, items: { type: "string" } },
  },
};

function buildLandscapePrompt(cd) {
  return [
    `CATEGORY: ${cd.category}  SOURCES: ${cd.source_count}`,
    ``,
    `ALL EVIDENCE (${(cd.evidence_5A || []).length} items — survey everything):`,
    fmt5A(cd.evidence_5A),
    ``,
    fmt5B(cd.evidence_5B).length > 10 ? `ANALYTICS:\n${fmt5B(cd.evidence_5B)}` : "",
    fmt5C(cd.evidence_5C).length > 10 ? `EXTERNAL:\n${fmt5C(cd.evidence_5C)}` : "",
    ``,
    `Survey all evidence and identify: dominant themes, evidence quality, operational signals, significant developments, coverage gaps. Be specific — name CVEs, actors, techniques, metrics where visible.`,
  ].filter((l) => l !== "").join("\n");
}

/**
 * Pass 1: Broad landscape survey over all category evidence.
 * Returns a landscape object that augments the Pass 2 Opus prompt.
 * Fails gracefully — null return means Pass 2 proceeds without landscape context.
 */
export async function synthesizeLandscape(compactDossier, opts = {}) {
  const { llmFn = routedLLM } = opts;
  if ((compactDossier.evidence_5A || []).length === 0) return null;
  try {
    const { result } = await llmFn(LANDSCAPE_SYSTEM, buildLandscapePrompt(compactDossier), {
      task:          "category_analysis",  // Sonnet — cheaper than Opus
      schema:        LANDSCAPE_SCHEMA,
      requires_json: true,
      logLabel:      `L6-landscape-${compactDossier.category}`,
    });
    if (!result?.landscape_summary) return null;
    process.stdout.write(
      `  [L6-landscape] ${compactDossier.category}: "${(result.landscape_summary || "").slice(0, 100)}"\n`
    );
    return result;
  } catch {
    return null;
  }
}

/**
 * Run the single category-synthesis LLM call (Pass 2: strategic analysis).
 * @param {object}   compactDossier  Output of buildCategoryEvidenceDossier().
 * @param {object}   [opts]
 * @param {Function} [opts.llmFn=routedLLM]  Injectable for tests.
 * @param {object}   [opts.landscape]  Output of synthesizeLandscape() — injected as context.
 * @returns {Promise<object|null>} parsed contract (sans validation) or null.
 */
// ── Post-synthesis numerical scrubber ─────────────────────────────────────────
// Extracts every significant number / percentage / dollar figure from the LLM
// output, checks whether it appears verbatim in the evidence supplied to the
// model, and strips or flags any claim that contains an ungrounded statistic.
// Returns { scrubbed: object, removed_statistics: string[] }.

const STAT_PATTERN = /(\$[\d,]+(?:\.\d+)?[MBk]?(?:\s*(?:million|billion))?|\d[\d,]*(?:\.\d+)?%|\d[\d,]*(?:\+|×|x)\s*(?:times?|fold)|grew?\s+\d[\d,]*%?|\d[\d,]*\s+(?:vulnerabilities?|incidents?|cases?|attacks?|techniques?|organizations?|victims?|reports?|breaches?|days?))/gi;

function collectEvidenceText(dossier) {
  const parts = [];
  for (const e of (dossier.evidence_5A || [])) {
    parts.push(e.fact || "", ...(e.numbers || []), e.supporting_quote || "");
  }
  for (const e of (dossier.evidence_5B || [])) {
    parts.push(String(e.finding || ""), String(e.value_summary || ""), String(e.caveat || ""));
  }
  for (const e of (dossier.evidence_5C || [])) {
    parts.push(e.claim || "", String(e.metric_value || ""), e.title || "");
  }
  return parts.join(" ").toLowerCase();
}

function statAppearsInEvidence(stat, evidenceText) {
  // Normalise: strip commas and currency symbols for comparison
  const norm = stat.toLowerCase().replace(/[$,]/g, "").trim();
  return evidenceText.includes(norm);
}

export function scrubUngroundedStatistics(analysis, dossier) {
  const evidenceText = collectEvidenceText(dossier);
  const removed_statistics = [];

  function scrubText(text) {
    if (!text || typeof text !== "string") return text;
    let out = text.replace(STAT_PATTERN, (match) => {
      if (statAppearsInEvidence(match, evidenceText)) return match;
      removed_statistics.push(match);
      return "[FIGURE REMOVED — not in evidence dossier]";
    });
    const implied = _scrubImplied(out, evidenceText);
    if (implied.replacements.length > 0) {
      for (const r of implied.replacements) {
        removed_statistics.push(`[implied: "${r.original}" → "${r.replacement}"]`);
      }
      out = implied.text;
    }
    return out;
  }

  // Scrub strategic_judgments (new schema)
  function scrubJudgments(judgments) {
    if (!Array.isArray(judgments)) return judgments;
    return judgments.map((j) => ({
      ...j,
      judgment:          scrubText(j.judgment),
      what_changed:      scrubText(j.what_changed),
      causal_mechanism:  scrubText(j.causal_mechanism),
      why_this_matters:  scrubText(j.why_this_matters),
      uncertainty:       scrubText(j.uncertainty),
      caveat_if_any:     scrubText(j.caveat_if_any),
      second_order_implications: (j.second_order_implications || []).map(scrubText),
    }));
  }

  const scrubbed = {
    ...analysis,
    strategic_judgments: scrubJudgments(analysis.strategic_judgments),
  };

  if (analysis.outlook_6_months && typeof analysis.outlook_6_months === "object") {
    scrubbed.outlook_6_months = {
      ...analysis.outlook_6_months,
      observed_basis:       scrubText(analysis.outlook_6_months.observed_basis),
      projected_trajectory: scrubText(analysis.outlook_6_months.projected_trajectory),
      reasoning:            scrubText(analysis.outlook_6_months.reasoning),
    };
  }

  return { scrubbed, removed_statistics };
}

// ── judgment_flags completeness check ────────────────────────────────────────
// Returns true when all 6 flag booleans are explicitly present.
function hasCompleteFlags(j) {
  const f = j.judgment_flags;
  if (!f || typeof f !== "object") return false;
  const required = ["implies_adoption", "implies_operational", "implies_trend",
                    "is_forward_looking", "is_market_wide", "is_lab_only"];
  return required.every((k) => typeof f[k] === "boolean");
}

// Single retry prompt asking only for the missing judgment_flags.
function buildFlagsRetryPrompt(judgment) {
  return [
    `The following strategic judgment is missing required judgment_flags booleans.`,
    `Return ONLY a JSON object with exactly these 6 fields (all boolean):`,
    `{ "implies_adoption": <bool>, "implies_operational": <bool>, "implies_trend": <bool>,`,
    `  "is_forward_looking": <bool>, "is_market_wide": <bool>, "is_lab_only": <bool> }`,
    ``,
    `judgment: "${(judgment.judgment || "").slice(0, 300)}"`,
    `what_changed: "${(judgment.what_changed || "").slice(0, 200)}"`,
    `causal_mechanism: "${(judgment.causal_mechanism || "").slice(0, 200)}"`,
    ``,
    `Rules:`,
    `  implies_adoption:    true if text asserts adversaries ARE using this in the wild`,
    `  implies_operational: true if text asserts active production exploitation`,
    `  implies_trend:       true if text claims a pattern across multiple time periods`,
    `  is_forward_looking:  true if the judgment is speculative/projected, not observed`,
    `  is_market_wide:      true if scope is broad industry or ecosystem-wide`,
    `  is_lab_only:         true if evidence is purely research/lab (no real-world use)`,
  ].join("\n");
}

const FLAGS_SCHEMA = {
  type: "object",
  required: ["implies_adoption", "implies_operational", "implies_trend",
             "is_forward_looking", "is_market_wide", "is_lab_only"],
  properties: {
    implies_adoption:    { type: "boolean" },
    implies_operational: { type: "boolean" },
    implies_trend:       { type: "boolean" },
    is_forward_looking:  { type: "boolean" },
    is_market_wide:      { type: "boolean" },
    is_lab_only:         { type: "boolean" },
  },
};

// Attempt one retry to fill missing flags for a single judgment.
async function retryMissingFlags(judgment, category, llmFn) {
  try {
    const { result } = await llmFn(
      "You are a precise boolean classifier. Return only valid JSON.",
      buildFlagsRetryPrompt(judgment),
      { task: "category_synthesis", schema: FLAGS_SCHEMA, requires_json: true,
        logLabel: `L6-flags-retry-${category}` }
    );
    if (result && typeof result === "object" &&
        typeof result.implies_adoption === "boolean") {
      return result;
    }
  } catch { /* non-fatal */ }
  return null;
}

export async function synthesizeCategory(compactDossier, opts = {}) {
  const { llmFn = routedLLM, landscape = null } = opts;
  try {
    const userPrompt = buildUserPrompt(compactDossier, landscape);
    const { result, llm_metadata } = await llmFn(SYSTEM_PROMPT, userPrompt, {
      task:          "category_synthesis",
      schema:        SCHEMA,
      requires_json: true,
      logLabel:      `L6-category-synthesis-${compactDossier.category}`,
    });
    if (!result || llm_metadata?.llm_used === false) return null;

    // ── Output validation: reject judgments with hallucinated evidence IDs ──────
    if (result.strategic_judgments?.length > 0) {
      const { valid, invalid } = validateSynthesisBatch(result.strategic_judgments, compactDossier.allowed_ids);
      if (invalid.length > 0) {
        process.stdout.write(
          `  [L6-synthesis-validate] ${compactDossier.category}: rejected ${invalid.length} judgment(s) with invalid evidence IDs: ` +
          invalid.map((x) => x.validation.errors.slice(0, 1).join("; ")).join(" | ") + "\n"
        );
        result.strategic_judgments = valid;
      }
    }

    // ── judgment_flags completeness: retry once, then reject ─────────────────
    // judgment_flags are required for all downstream gates to work without regex
    // fallback. If the LLM omitted them, attempt one targeted retry. If still
    // absent, mark the judgment rejected rather than silently using text regex.
    if (result.strategic_judgments?.length > 0) {
      const missing = result.strategic_judgments.filter((j) => !hasCompleteFlags(j));
      if (missing.length > 0) {
        process.stdout.write(
          `  [L6-flags-retry] ${compactDossier.category}: ${missing.length} judgment(s) missing flags — retrying\n`
        );
        await Promise.all(missing.map(async (j) => {
          const recovered = await retryMissingFlags(j, compactDossier.category, llmFn);
          if (recovered) {
            j.judgment_flags = recovered;
            j._flags_recovered_by_retry = true;
          } else {
            j._rejected_reason = "missing_required_judgment_flags";
          }
        }));
        // Remove judgments that couldn't get flags after retry
        const beforeCount = result.strategic_judgments.length;
        result.strategic_judgments = result.strategic_judgments.filter((j) => !j._rejected_reason);
        const afterCount = result.strategic_judgments.length;
        if (afterCount < beforeCount) {
          process.stdout.write(
            `  [L6-flags-reject] ${compactDossier.category}: rejected ${beforeCount - afterCount} judgment(s) — missing_required_judgment_flags\n`
          );
        }
      }
    }

    // Strip any statistics that cannot be traced back to the evidence dossier
    const { scrubbed, removed_statistics } = scrubUngroundedStatistics(result, compactDossier);
    if (removed_statistics.length > 0) {
      process.stdout.write(
        `  [L6-stat-scrub] ${compactDossier.category}: removed ${removed_statistics.length} ungrounded ` +
        `statistic(s): ${removed_statistics.slice(0, 4).map(s => `"${s}"`).join(", ")}` +
        (removed_statistics.length > 4 ? ` +${removed_statistics.length - 4} more` : "") + "\n"
      );
    }

    return { ...scrubbed, model_used: llm_metadata?.model_used || "category_synthesis" };
  } catch {
    return null;
  }
}

export { SCHEMA as CATEGORY_SYNTHESIS_SCHEMA };
export { STRATEGIC_JUDGMENT_ITEM };
