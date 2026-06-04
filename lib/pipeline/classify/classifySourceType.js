/**
 * Layer 3 — Source Type Classification
 *
 * Assigns a deterministic source_type to each source based on metadata,
 * tags, connector origin, and text signals. No LLM calls.
 *
 * Returns a value from ALL_SOURCE_TYPES (lib/config/sourceTypes.js).
 * Returns "unknown" when no rule matches with reasonable confidence.
 */

import { ALL_SOURCE_TYPES, SOURCE_TYPES, OLD_SOURCE_TYPE_MAP } from "../../config/sourceTypes.js";

// ── Legacy value mapping ──────────────────────────────────────────────────────
// DB and connectors may carry old source_type values from before the
// controlled-vocabulary migration. Map them to the canonical value.
const LEGACY_TYPE_MAP = {
  // Old canonical names (renamed in cleanup)
  ...OLD_SOURCE_TYPE_MAP,

  // Connector-emitted legacy names
  security_blog:           SOURCE_TYPES.RESEARCH_FINDING,
  vendor_advisory:         SOURCE_TYPES.VULNERABILITY,
  government_advisory:     SOURCE_TYPES.GOVERNANCE_SIGNAL,
  threat_intel:            SOURCE_TYPES.THREAT_INTELLIGENCE,
  research_paper:          SOURCE_TYPES.RESEARCH_FINDING,
  academic_research:       SOURCE_TYPES.RESEARCH_FINDING,
  policy_update:           SOURCE_TYPES.GOVERNANCE_SIGNAL,
  security_framework:      SOURCE_TYPES.DEFENSIVE_CAPABILITY,
  ai_lab_update:           SOURCE_TYPES.RESEARCH_FINDING,
  news:                    SOURCE_TYPES.RESEARCH_FINDING,
  vulnerability_database:  SOURCE_TYPES.VULNERABILITY,
  open_source_project:     SOURCE_TYPES.ECOSYSTEM_SIGNAL,
  incident_database:       SOURCE_TYPES.INCIDENT,
  ai_threat_framework:     SOURCE_TYPES.DEFENSIVE_CAPABILITY,
  social_signal:           SOURCE_TYPES.RESEARCH_FINDING,
  tooling_platform:        SOURCE_TYPES.ECOSYSTEM_SIGNAL,
  tooling_platform_development: SOURCE_TYPES.ECOSYSTEM_SIGNAL,

  // Short-form aliases from old classifySourceType versions
  policy_regulatory:       SOURCE_TYPES.GOVERNANCE_SIGNAL,
  governance:              SOURCE_TYPES.GOVERNANCE_SIGNAL,
  ecosystem_market:        SOURCE_TYPES.ECOSYSTEM_SIGNAL,
  societal_harm:           SOURCE_TYPES.SOCIETAL_HARM,
};

// ── Connector origin → source_type ───────────────────────────────────────────
const CONNECTOR_TYPE_MAP = {
  nvd:              SOURCE_TYPES.VULNERABILITY,
  arxiv:            SOURCE_TYPES.RESEARCH_FINDING,
  cisa_advisories:  SOURCE_TYPES.GOVERNANCE_SIGNAL,
  cisa:             SOURCE_TYPES.GOVERNANCE_SIGNAL,
  nist:             SOURCE_TYPES.GOVERNANCE_SIGNAL,
};

// ── Tag signals (first match wins) ───────────────────────────────────────────
const TAG_TYPE_MAP = {
  "cve":                   SOURCE_TYPES.VULNERABILITY,
  "vulnerability":         SOURCE_TYPES.VULNERABILITY,
  "exploit":               SOURCE_TYPES.EXPLOIT_DISCLOSURE,
  "proof_of_concept":      SOURCE_TYPES.EXPLOIT_DISCLOSURE,
  "incident":              SOURCE_TYPES.INCIDENT,
  "data_breach":           SOURCE_TYPES.INCIDENT,
  "ransomware":            SOURCE_TYPES.INCIDENT,
  "threat_actor":          SOURCE_TYPES.THREAT_INTELLIGENCE,
  "apt":                   SOURCE_TYPES.THREAT_INTELLIGENCE,
  "nation_state":          SOURCE_TYPES.THREAT_INTELLIGENCE,
  "ioc":                   SOURCE_TYPES.THREAT_INTELLIGENCE,
  "research":              SOURCE_TYPES.RESEARCH_FINDING,
  "academic_research":     SOURCE_TYPES.RESEARCH_FINDING,
  "research_paper":        SOURCE_TYPES.RESEARCH_FINDING,
  "benchmark":             SOURCE_TYPES.BENCHMARK_EVALUATION,
  "red_teaming":           SOURCE_TYPES.BENCHMARK_EVALUATION,
  "policy":                SOURCE_TYPES.GOVERNANCE_SIGNAL,
  "regulatory":            SOURCE_TYPES.GOVERNANCE_SIGNAL,
  "governance":            SOURCE_TYPES.GOVERNANCE_SIGNAL,
  "defensive":             SOURCE_TYPES.DEFENSIVE_CAPABILITY,
  "detection":             SOURCE_TYPES.DEFENSIVE_CAPABILITY,
  "deepfake":              SOURCE_TYPES.SOCIETAL_HARM,
  "ai_disinformation":     SOURCE_TYPES.SOCIETAL_HARM,
  "market":                SOURCE_TYPES.ECOSYSTEM_SIGNAL,
};

// ── Text signal rules ─────────────────────────────────────────────────────────
// Ordered from most specific to most general.
const TEXT_RULES = [
  {
    type: SOURCE_TYPES.EXPLOIT_DISCLOSURE,
    any:  ["proof-of-concept", "poc released", "exploit published", "exploit code", "exploit released", "working exploit", "exploit public", "weaponized"],
  },
  {
    type: SOURCE_TYPES.VULNERABILITY,
    any:  ["cve-20", "zero-day", "0-day", "security advisory", "patch tuesday", "vulnerability disclosed", "vulnerability patched", "buffer overflow", "remote code execution", "rce vulnerability", "sql injection", "xss vulnerability", "security flaw"],
    none: ["ransomware", "data breach", "threat actor", "supply chain attack"],
  },
  {
    type: SOURCE_TYPES.INCIDENT,
    any:  ["data breach", "ransomware attack", "supply chain attack", "nation-state attack", "was attacked", "were compromised", "were breached", "intrusion detected", "threat actor deployed", "campaign targeting", "cyber attack on", "cyberattack on"],
  },
  {
    type: SOURCE_TYPES.BENCHMARK_EVALUATION,
    any:  ["benchmark", "red team evaluation", "safety evaluation", "model evaluation", "jailbreak success rate", "attack success rate", "asr", "evaluation framework", "red teaming results", "safety benchmark"],
  },
  {
    type: SOURCE_TYPES.CAPABILITY_DEMONSTRATION,
    any:  ["we demonstrate that", "we show that", "we present a", "proof of concept", "we built a", "we developed a", "we introduce a novel", "capable of generating", "capable of producing", "successfully generated", "successfully bypassed", "successfully extracted"],
    none: ["cve-", "zero-day", "data breach", "threat actor", "apt", "ransomware", "patch tuesday"],
  },
  {
    type: SOURCE_TYPES.ADVERSARY_ADOPTION_SIGNAL,
    any:  ["threat actor using ai", "apt group using", "adversary adopts", "criminal groups using ai", "ransomware group using ai", "nation-state using ai", "observed using llm", "seen using deepfake", "adopted ai", "leveraging ai for attacks", "using generative ai to", "ai-generated phishing campaign observed", "real-world use of ai", "in the wild"],
    none: ["researchers discovered", "we propose", "in this paper", "proof-of-concept"],
  },
  {
    type: SOURCE_TYPES.RESEARCH_FINDING,
    any:  ["we propose", "we demonstrate", "we show that", "we present", "in this paper", "our approach", "experimental results", "arxiv:", "arxiv.org", "preprint", "conference paper", "workshop paper", "usenix security", "ieee s&p", "ndss 2", "acm ccs", "researchers discovered", "researchers found", "researchers demonstrated", "new research shows", "study reveals"],
    // Do NOT add "security researchers" — it appears in news, threat reports, CVE advisories.
    none: ["data breach", "ransomware attack", "supply chain attack", "threat actor", "was attacked", "were compromised", "cve-20", "exploit published", "zero-day"],
  },
  {
    type: SOURCE_TYPES.THREAT_INTELLIGENCE,
    any:  ["threat actor", "threat group", "apt", "attributed to", "ttps", "indicators of compromise", "ioc", "campaign attributed", "nation-state", "criminal group", "threat report"],
  },
  {
    type: SOURCE_TYPES.GOVERNANCE_SIGNAL,
    any:  ["cisa advisory", "nist guidance", "regulatory requirement", "compliance mandate", "government directive", "executive order", "legislation passed", "bill introduced", "sector guidance", "advisory notice", "ai governance", "ai act", "ai policy", "ai standard", "ai regulation", "responsible ai", "ai safety framework", "model card", "transparency report", "ai accountability", "ai ethics policy"],
  },
  {
    type: SOURCE_TYPES.DEFENSIVE_CAPABILITY,
    any:  ["detection capability", "new defense", "mitigation strategy", "countermeasure", "security improvement", "detection rule", "defensive technique", "hardening guide", "mitigations for"],
    none: ["threat actor", "attack campaign", "data breach"],
  },
  {
    type: SOURCE_TYPES.SOCIETAL_HARM,
    any:  ["deepfake", "disinformation", "synthetic media", "ai-generated content used", "influence operation", "election interference", "social manipulation", "voice cloning fraud", "ai scam", "synthetic propaganda"],
  },
  {
    type: SOURCE_TYPES.ECOSYSTEM_SIGNAL,
    any:  ["raises $", "funding round", "acquisition", "partnership announced", "product launch", "series a", "series b", "series c", "merger", "market share", "valuation", "tool released", "open source", "github.com", "python library", "framework released", "new tool", "security tool", "offensive tool", "red team tool", "plugin released", "sdk released"],
    none: ["data breach", "attack campaign"],
  },
];

function textOf(source) {
  return [source.title, source.summary, source.full_text?.slice(0, 3000)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchTextRule(rule, text) {
  if (rule.required && !rule.required.every((term) => text.includes(term))) return false;
  if (rule.any     && !rule.any.some((term)      => text.includes(term)))  return false;
  if (rule.none    && rule.none.some((term)       => text.includes(term)))  return false;
  return true;
}

/**
 * Classify the source_type of a source.
 *
 * Returns one of ALL_SOURCE_TYPES values, or "unknown" if no rule matches
 * with sufficient confidence.
 *
 * Priority:
 * 1. Existing canonical source_type (already in controlled vocabulary)
 * 2. Legacy source_type — mapped to canonical equivalent
 * 3. Connector origin
 * 4. Tag signals (exact match on cleaned tag names)
 * 5. Text signals (ordered most-specific to most-general)
 * 6. Fallback: "unknown" (triggers LLM disambiguation in Layer 5)
 *
 * @param {object} source
 * @returns {{ type: string, confidence: "high"|"medium"|"low", method: string }}
 */
export function classifySourceType(source) {
  // 1. Already has a canonical type — trust it
  if (source.source_type && ALL_SOURCE_TYPES.includes(source.source_type)) {
    return { type: source.source_type, confidence: "high", method: "existing" };
  }

  // 2. Legacy type → canonical mapping
  if (source.source_type && LEGACY_TYPE_MAP[source.source_type]) {
    return { type: LEGACY_TYPE_MAP[source.source_type], confidence: "medium", method: "legacy_map" };
  }

  // 3. Connector origin (strong signal — the connector knows its domain)
  // arXiv is a special case: papers can be benchmark_evaluation or capability_demonstration,
  // not just research_finding. Run text rules on top of the arXiv origin hint.
  const connectorId = source.collection_metadata?.connector_id || "";
  for (const [prefix, type] of Object.entries(CONNECTOR_TYPE_MAP)) {
    if (connectorId.startsWith(prefix)) {
      if (prefix === "arxiv") {
        // Check text rules first; fall back to research_finding if none match
        const text = textOf(source);
        for (const rule of TEXT_RULES) {
          if ([SOURCE_TYPES.BENCHMARK_EVALUATION, SOURCE_TYPES.CAPABILITY_DEMONSTRATION].includes(rule.type) && matchTextRule(rule, text)) {
            return { type: rule.type, confidence: "medium", method: "arxiv_text_refined" };
          }
        }
      }
      return { type, confidence: "high", method: "connector_origin" };
    }
  }

  // 4. Tag signals — cleaned to match tag keys (replace hyphens/spaces with underscores)
  for (const rawTag of source.tags || []) {
    const tag = rawTag.replace(/-/g, "_").replace(/\s+/g, "_").toLowerCase();
    if (TAG_TYPE_MAP[tag]) {
      return { type: TAG_TYPE_MAP[tag], confidence: "medium", method: "tag_signal" };
    }
  }

  // 5. Text signals
  const text = textOf(source);
  for (const rule of TEXT_RULES) {
    if (matchTextRule(rule, text)) {
      return { type: rule.type, confidence: "low", method: "text_signal" };
    }
  }

  // 6. No match — signal to Layer 5 that LLM disambiguation is needed
  return { type: "unknown", confidence: "low", method: "fallback" };
}

/**
 * Apply source_type in-place. Safe to call multiple times.
 * Only updates if the current value is missing or not in the canonical vocabulary.
 *
 * @param {object} source
 * @returns {object} mutated source
 */
export function applySourceType(source) {
  if (!source.source_type || !ALL_SOURCE_TYPES.includes(source.source_type)) {
    const { type } = classifySourceType(source);
    source.source_type = type;
  }
  return source;
}
