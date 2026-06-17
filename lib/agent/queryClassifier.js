/**
 * Agent query classifier.
 *
 * Detects whether the user is asking for:
 *   analytical     — synthesis judgment ("most critical finding", "what mattered most")
 *   evidence_lookup — evidence behind a specific claim
 *   raw_sources    — raw source listing
 *   distribution   — category / source count breakdown
 *   timeline       — chronological events ("what happened in May", "recent incidents")
 *   attack_vector  — technique/vector breakdown ("top attack vectors", "how are they attacking")
 *   general        — everything else (falls back to source retrieval)
 *
 * Also detects response length mode:
 *   brief     — user said "briefly", "short", "tldr", "quick"
 *   deep_dive — user said "deep dive", "detailed", "explain fully", "in depth"
 *   default   — no explicit length preference
 */

const ANALYTICAL_PATTERNS = [
  /most\s*(critical|important|significant|pressing|urgent)\s*(finding|threat|development|issue|concern)?/i,
  /biggest\s*(finding|development|threat|happening|story|concern)/i,
  /what\s+mattered\s+most/i,
  /what\s+(is|was|were)\s+the\s+(most|key|critical|top|biggest|main)/i,
  /leadership\s*(should\s*)?(care|know|focus|understand)/i,
  /(top|critical|key|primary|main)\s*(finding|insight|threat|pick|concern|takeaway)/i,
  /what\s+should\s+(we|leadership|the\s+team|analysts?)\s+(care|know|focus|prioritize)/i,
  /most\s+notable/i,
  /standout\s+(finding|development|event)/i,
  /highlight\s+(this\s+)?(period|quarter|month|week)/i,
  /what\s+stands?\s+out/i,
  /primary\s+concern/i,
  /what\s+mattered/i,
];

const EVIDENCE_LOOKUP_PATTERNS = [
  /evidence\s+(for|behind|supporting|about)\s/i,
  /what\s+support(s)?\s+the\s+(claim|finding)/i,
  /citation(s)?\s+(for|behind)/i,
  /\bevidence\s+packet/i,
  /\bEvidencePacket\b/,
  /show\s+me\s+the\s+evidence/i,
];

const RAW_SOURCE_PATTERNS = [
  /\b(list|show|find|get)\s+(me\s+)?(the\s+)?(source|article|paper|document|url)/i,
  /\bsource\s+list\b/i,
  /\braw\s+source\b/i,
  /which\s+(articles?|papers?|sources?)\s+(are|were|cover)/i,
];

const DISTRIBUTION_PATTERNS = [
  /\b(how\s+many|breakdown|distribution|count|number\s+of)\b.*(categor|source|article)/i,
  /categor.*(breakdown|distribution|count)/i,
  /\bby\s+category\b/i,
];

const TIMELINE_PATTERNS = [
  /\b(timeline|chronolog|in\s+order|sequence|when\s+did|what\s+happened\s+in)\b/i,
  /\b(recent\s+incidents?|recent\s+events?|latest\s+incidents?)\b/i,
  /\b(this\s+week|this\s+month|in\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i,
  /\b(over\s+the\s+past|over\s+(?:the\s+)?last)\s+\d+/i,
  /\bhow\s+has\s+.+\s+evolved\b/i,
  /\btrend\s+over\s+time\b/i,
];

const ATTACK_VECTOR_PATTERNS = [
  /\battack\s+vector(s)?\b/i,
  // "top attack technique" but not "top technique used in paper"
  /\btop\s+attack\s+(technique|tactic|method|vector)/i,
  /how\s+are\s+.+(attacking|exploiting|targeting)/i,
  // require "attack" qualifier so "technique used in paper" doesn't match
  /\battack\s+(technique|tactic|method)s?\s+(breakdown|distribution|observed|common)/i,
  /\bmost\s+(common|frequent|observed)\s+(attack|technique|tactic)\b/i,
  /\bTTP(s)?\b/,
  /operational\s+vs\.?\s+research/i,
];

// ── Mode detection ─────────────────────────────────────────────────────────────

const BRIEF_PATTERNS   = /\b(briefly|brief|short|tldr|tl;?dr|quick\s+answer|in\s+a\s+sentence|one\s+liner)\b/i;
const DEEP_DIVE_PATTERNS = /\b(deep\s+dive|detailed|in[\s-]depth|fully\s+explain|comprehensive|more\s+detail|elaborate|expand\s+on)\b/i;

/**
 * Detect response length mode.
 * @param {string} query
 * @returns {"brief" | "deep_dive" | "default"}
 */
export function detectMode(query) {
  const q = (query || "").trim();
  if (BRIEF_PATTERNS.test(q))     return "brief";
  if (DEEP_DIVE_PATTERNS.test(q)) return "deep_dive";
  return "default";
}

/**
 * @param {string} query
 * @returns {"analytical" | "evidence_lookup" | "raw_sources" | "distribution" | "timeline" | "attack_vector" | "general"}
 */
export function classifyQuery(query) {
  const q = (query || "").trim();
  // Check specific types before the broad analytical catch-all
  if (EVIDENCE_LOOKUP_PATTERNS.some((p) => p.test(q))) return "evidence_lookup";
  if (RAW_SOURCE_PATTERNS.some((p)      => p.test(q))) return "raw_sources";
  if (DISTRIBUTION_PATTERNS.some((p)    => p.test(q))) return "distribution";
  if (ATTACK_VECTOR_PATTERNS.some((p)   => p.test(q))) return "attack_vector";
  if (TIMELINE_PATTERNS.some((p)        => p.test(q))) return "timeline";
  if (ANALYTICAL_PATTERNS.some((p)      => p.test(q))) return "analytical";
  return "general";
}
