/**
 * Agent response composer.
 *
 * Builds structured judgment-first answers from L6 claim-chain selections.
 * Pure functions — no I/O, easy to unit-test.
 *
 * Output format: markdown bullets (not prose paragraphs).
 * Structure: Answer → Why it matters → Evidence → Confidence → Caveat → Next angle
 */

const CATEGORY_LABELS = {
  llm_threats:             "LLM Threats",
  agentic_ai_threats:      "Agentic AI Threats",
  traditional_ai_threats:  "Traditional AI Threats",
  ai_enabled_threats:      "AI-Enabled Threats",
};

// ── QA guards ─────────────────────────────────────────────────────────────────

/**
 * Returns a rejection reason string, or null if the claim passes QA.
 */
export function qaCheckClaim(claim, evidencePackets) {
  if (!claim?.claim_text) return "missing claim text";

  if (!claim.supporting_evidence_ids?.length) {
    return "no supporting evidence IDs — unsupported claim";
  }

  if (!evidencePackets?.length) {
    return "evidence IDs not resolvable in index";
  }

  return null;
}

// ── Structured answer builder ─────────────────────────────────────────────────

/**
 * Build the structured judgment-first answer object.
 * Includes a compact inner object for the LLM + a preformatted markdown fallback.
 */
export function composeJudgmentAnswer({ selectedResult, category, period }) {
  if (!selectedResult) return null;

  const { claim, evidencePackets, researchOnly, alternatives } = selectedResult;

  const qaFailure = qaCheckClaim(claim, evidencePackets);
  if (qaFailure) return null;

  const catLabel  = CATEGORY_LABELS[category || selectedResult.category] || "AI threats";
  const periodStr = period ? ` this ${period}` : " this period";

  const confidence = claim.claim_priority === "critical" ? "high"
    : claim.claim_priority === "high" ? "moderate"
    : "low";

  const researchCaveat = researchOnly
    ? "All supporting sources are research demonstrations, not confirmed operational incidents. Treat as emerging technical risk, not active campaign."
    : null;

  const caveat = claim.caveat_if_any || researchCaveat;

  const notSelected = alternatives?.length
    ? alternatives.slice(0, 2)
        .map((a) => `"${(a.claim_text || "").slice(0, 80).trimEnd()}…" (${a.claim_priority || "medium"} priority)`)
        .join("; ")
    : null;

  const evidenceList = evidencePackets.map((ep) => ({
    evidence_id:    ep.evidence_id,
    source_title:   ep.source_title || "",
    publisher:      ep.publisher || "",
    url:            ep.url || "",
    fact:           ep.fact || "",
    numbers:        ep.numbers || [],
    evidence_class: ep.evidence_class || "research",
  }));

  return {
    answer:              claim.claim_text,
    why_it_matters:      claim.why_it_matters || "",
    key_points:          [],
    evidence_points:     evidenceList,
    evidence:            evidenceList,  // backward compat
    confidence,
    caveat:              caveat || null,
    not_selected:        notSelected || null,
    suggested_next_angle: null,
    source_type:         "l6_claim_chain",
    category_label:      catLabel,
    period_label:        periodStr.trim(),
  };
}

// ── Dashboard intel answer composer ───────────────────────────────────────────
//
// Composes a structured answer from a dashboard_intelligence_object.
// This is the primary path for analytical queries when dashboard intel is available.
// Rules:
//   - Only use intelObj with approved_for_chatbot=true
//   - Cite evidence IDs
//   - Include caveats — never suppress them
//   - Do not add new claims beyond what the intel object states
//   - If confidence is low, state uncertainty explicitly

/**
 * Build a structured chatbot answer from a dashboard_intelligence_object.
 *
 * @param {object} intelObj  dashboard_intelligence_object (must have approved_for_chatbot=true)
 * @param {object[]} [alternatives]  Other approved intel objects as alternatives
 * @returns {object | null}
 */
export function composeIntelAnswer(intelObj, alternatives = []) {
  if (!intelObj) return null;
  if (!intelObj.approved_for_chatbot) return null;
  if (!intelObj.supporting_evidence_ids?.length) return null;

  const catLabel = CATEGORY_LABELS[intelObj.category] || intelObj.category || "AI threats";
  const caveats  = (intelObj.caveats || []).filter(Boolean);

  // Use short_takeaway as the primary headline if available and non-trivial
  const answer = intelObj.short_takeaway?.trim().length > 10
    ? intelObj.short_takeaway
    : intelObj.judgment;

  const evidencePoints = (intelObj.evidence_for || []).slice(0, 4).map((e) => ({
    evidence_id:    e.evidence_id,
    source_title:   e.source_title || "",
    publisher:      e.publisher    || "",
    url:            e.url          || null,
    fact:           e.fact         || "",
    numbers:        [],
    evidence_class: e.source_type  || "research",
  }));

  const counterPoints = (intelObj.evidence_against || []).slice(0, 2).map((e) => ({
    evidence_id: e.evidence_id,
    fact:        e.fact || "",
    publisher:   e.publisher || "",
  }));

  const notSelected = alternatives
    .slice(0, 2)
    .map((a) => `"${(a.short_takeaway || a.judgment || "").slice(0, 80).trimEnd()}…" (${a.confidence || "low"} confidence)`)
    .join("; ") || null;

  return {
    answer,
    full_judgment:    intelObj.judgment,
    why_it_matters:   intelObj.why_it_matters || "",
    what_changed:     intelObj.what_changed || "",
    key_points:       [],
    evidence_points:  evidencePoints,
    evidence:         evidencePoints,
    counter_evidence: counterPoints,
    confidence:       intelObj.confidence || "low",
    caveat:           caveats.join("; ") || null,
    trend_status:     intelObj.trend_status || "insufficient_evidence",
    monitoring_signals: (intelObj.monitoring_signals || []).slice(0, 3),
    not_selected:     notSelected,
    source_type:      "dashboard_intel",
    category_label:   catLabel,
    intel_id:         intelObj.intel_id,
    dashboard_relevance_hint: intelObj.dashboard_relevance_hint,
    analytical_quality: intelObj.analytical_quality,
  };
}

// ── Markdown bullet formatter (deterministic fallback) ────────────────────────

/**
 * Format a structured judgment answer into markdown bullets.
 * Used when the LLM is unavailable or as a post-processing template.
 */
export function formatJudgmentAnswer(composed, { category, period } = {}) {
  if (!composed) return null;

  const catLabel  = composed.category_label || CATEGORY_LABELS[category] || "AI threats";
  const periodStr = composed.period_label   || (period ? ` this ${period}` : "");
  const lines = [];

  // Answer — the primary judgment (include category context as first line)
  lines.push(`**${catLabel}${periodStr ? ` —${periodStr}` : ""}**`);
  lines.push("");
  lines.push(`**Answer:** ${composed.answer}`);
  lines.push("");

  // Why it matters
  if (composed.why_it_matters) {
    lines.push("**Why it matters:**");
    lines.push(`- ${composed.why_it_matters}`);
    lines.push("");
  }

  // Evidence bullets — max 3
  const evLines = (composed.evidence_points || composed.evidence || [])
    .filter((ep) => ep.fact || ep.source_title)
    .slice(0, 3)
    .map((ep) => {
      const src  = ep.publisher || ep.source_title || "";
      const stat = (ep.numbers || []).slice(0, 1).join(", ");
      const fact = ep.fact || "";
      const id   = ep.evidence_id ? ` \`${ep.evidence_id}\`` : "";
      return `- ${fact}${stat ? ` (${stat})` : ""}${src ? ` — ${src}` : ""}${id}`;
    });

  if (evLines.length) {
    lines.push("**Evidence:**");
    lines.push(...evLines);
    lines.push("");
  }

  // Confidence
  const confReason = composed.confidence === "high"   ? "critical priority, strong evidence"
    : composed.confidence === "moderate" ? "high priority, usable evidence"
    : "medium priority or limited evidence";
  lines.push(`**Confidence:** ${composed.confidence} — ${confReason}`);

  // Caveat
  if (composed.caveat) {
    lines.push(`**Caveat:** ${composed.caveat}`);
  }

  // Not selected alternatives (optional, compact)
  if (composed.not_selected) {
    lines.push(`**Other findings considered:** ${composed.not_selected}`);
  }

  // Next angle
  if (composed.suggested_next_angle) {
    lines.push("");
    lines.push(`**Next angle:** ${composed.suggested_next_angle}`);
  }

  return lines.join("\n");
}

// ── System prompt for LLM-enhanced judgment answers ──────────────────────────

export const JUDGMENT_SYSTEM_PROMPT = `You are an AI threat intelligence analyst for the Horizon dashboard.

You have been given a pre-selected critical finding from validated L6 claim-chain outputs.
Your task: present this finding as concise, scannable markdown bullets — not prose paragraphs.

## OUTPUT FORMAT (required)

**Answer:** One clear judgment sentence. Lead with the finding, not with the source.

**Why it matters:**
- 1–2 bullets on operational or strategic significance

**Evidence:**
- Specific fact from the evidence packet — publisher, evidence_id
- (repeat for up to 3 items, each on its own line)

**Confidence:** high | moderate | low — one-line reason

**Caveat:** one sentence (omit if no caveat)

**Next angle:** one follow-up question or dashboard action (optional)

## RULES

1. Answer leads with the finding — never with "According to source X…"
2. Bullets only — no prose paragraphs unless the user asked for narrative
3. Evidence bullets cite the source title + evidence_id from the provided EvidencePackets only
4. Do NOT invent citations, statistics, or sources not in the provided context
5. Distinguish research demos from confirmed operational incidents
6. If researchOnly, the caveat must say so clearly
7. Max total length: 200 words
8. No filler phrases: no "Based on the provided context", no "It is important to note", no "As we can see"
9. No hype words: no "unprecedented", "exploding", "revolutionary" unless in approved claim text
10. Short sentences. Every word earns its place.`;
