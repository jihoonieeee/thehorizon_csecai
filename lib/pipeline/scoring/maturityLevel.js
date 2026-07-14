/**
 * Unified threat maturity classification.
 *
 * Single source of truth for the five-level ladder used by:
 *   - scripts/labelMaturityLevels.js  (batch classification of existing sources)
 *   - lib/pipeline/understand/understandSource.js (inline at ingest)
 *   - lib/dashboard/evidenceMaturity.js (dashboard bar)
 *   - api/dashboard.js (top-source ranking)
 *
 * Stored in intelligence.maturity_level (no DB schema migration needed).
 */

import { loadPrompt } from "../../prompts/promptLoader.js";

export const MATURITY_LEVELS = ["research", "demonstrated", "disclosed", "observed", "operational"];

export const MATURITY_RANK = {
  operational:  5,
  observed:     4,
  disclosed:    3,
  demonstrated: 2,
  research:     1,
};

// ── Deterministic fallback ────────────────────────────────────────────────────
// Applied when LLM is unavailable or returns an invalid level.
// Derived from source_type — less accurate than LLM but always available.
const FALLBACK_BY_TYPE = {
  incident:                  "observed",
  threat_intelligence:       "operational",
  adversary_adoption_signal: "operational",
  attack_surface_signal:     "observed",
  societal_harm_signal:      "observed",
  exploit_disclosure:        "demonstrated",
  capability_demonstration:  "demonstrated",
  research_finding:          "research",
  benchmark_evaluation:      "research",
  vulnerability:             "disclosed",
  governance_signal:         "research",
  defensive_capability:      "research",
  unknown:                   "research",
};

// In-the-wild language upgrades disclosed → observed and demonstrated → observed.
const IN_WILD_RE = /\b(exploited in the wild|in-the-wild exploitation|actively exploited|known exploited|under active exploitation|observed exploitation|being exploited|exploited within \d+|exploited by (?:attackers|threat actors|adversaries|apt|hackers)|mass[- ]exploit(?:ed|ation)?|weaponized in attacks|used in (?:active )?attacks)\b/i;

export function deterministicMaturity(source) {
  const type  = source.source_type || "unknown";
  const text  = `${source.title || ""} ${source.short_summary || source.summary || ""}`;
  let level   = FALLBACK_BY_TYPE[type] || "research";
  if (IN_WILD_RE.test(text) && (level === "demonstrated" || level === "disclosed")) {
    level = "observed";
  }
  return { level, reason: `Deterministic fallback from source_type=${type}`, method: "deterministic" };
}

// ── LLM classification ────────────────────────────────────────────────────────

let _system = null;
function getSystem() {
  if (!_system) _system = loadPrompt("understand/maturity").system;
  return _system;
}

function buildUser(source) {
  const claims = (source.intelligence?.main_claims || []).slice(0, 3)
    .map((c, i) => `  ${i + 1}. ${typeof c === "string" ? c : c?.claim || ""}`).join("\n");
  const summary = (source.analyst_brief || source.short_summary || source.intelligence?.source_summary || "").slice(0, 500);
  return [
    `SOURCE TYPE: ${source.source_type || "unknown"}`,
    `TITLE: ${source.title || "untitled"}`,
    `PUBLISHER: ${source.publisher || "unknown"}`,
    `SUMMARY: ${summary || "(none)"}`,
    claims ? `KEY CLAIMS:\n${claims}` : "",
  ].filter(Boolean).join("\n");
}

const SCHEMA = {
  type: "object",
  required: ["level", "reason"],
  properties: {
    level:  { type: "string", enum: MATURITY_LEVELS },
    reason: { type: "string" },
  },
};

/**
 * Classify a source's maturity level using an LLM.
 *
 * @param {object} source — DB row or normalise() output
 * @param {function} callFn — async (system, user, opts) => string|object
 * @returns {Promise<{ level, reason, method }>}
 */
export async function classifyMaturityLevel(source, callFn) {
  const sys = getSystem();
  const usr = buildUser(source);
  try {
    let raw = await callFn(sys, usr, { schema: SCHEMA, json: true, task: "maturity_level" });
    if (typeof raw === "string") raw = JSON.parse(raw);
    const level = raw?.level;
    if (!MATURITY_LEVELS.includes(level)) throw new Error(`Invalid level: ${level}`);
    return { level, reason: raw.reason || "", method: "llm" };
  } catch {
    return deterministicMaturity(source);
  }
}

/**
 * Read the stored maturity level, falling back to deterministic if not yet classified.
 */
export function maturityOf(source) {
  const stored = source?.intelligence?.maturity_level;
  if (stored && MATURITY_LEVELS.includes(stored)) return stored;
  return deterministicMaturity(source).level;
}
