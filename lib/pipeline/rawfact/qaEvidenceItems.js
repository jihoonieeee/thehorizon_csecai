/**
 * Layer 5a.8 — Evidence QA
 *
 * Validates evidence items and evidence packs. Deterministic — no LLM.
 * May downgrade or remove items that fail quality checks.
 *
 * Checks:
 *   - Every item has required fields (source_id, url, publisher, evidence_type, fact)
 *   - evidence_type is allowed by source-type profile
 *   - critical items pass the criticality rule
 *   - statistics contain a number
 *   - attack/exploit types come from eligible source types
 *   - governance sources do not produce attack claims (unless clearly evidence-backed)
 *   - duplicate clusters have one representative
 *   - vague/generic facts are downgraded
 *   - marketing claims are downgraded unless backed by numbers
 */

import { ALL_EVIDENCE_TYPES, getExtractionProfile } from "./evidenceExtractionProfiles.js";

// ── QA constants ──────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ["source_id", "evidence_type", "fact", "evidence_confidence"];

const ATTACK_EVIDENCE_TYPES = new Set([
  "incident_event", "exploit_chain", "attack_method",
  "threat_actor_activity", "adversary_adoption",
]);

const GOVERNANCE_SOURCE_TYPES = new Set([
  "governance_signal", "attack_surface_signal",
]);

const MARKETING_PATTERNS = [
  /\b(world's (first|leading|best)|industry-leading|state-of-the-art|revolutionary|cutting-edge|breakthrough)\b/i,
  /\b(we are proud|exciting (announcement|news|product)|introduces|launches|announces) \b/i,
];

const GENERIC_PATTERNS = [
  /^(ai|large language model|llm|artificial intelligence) (is|are|can|may|might|has|have) /i,
  /^researchers? (have|has) (shown|demonstrated|found|discovered) that/i,
  /^(this|the) (paper|study|report|research) (presents|proposes|shows|describes)/i,
  /^in (this|the) (paper|study|report)/i,
];

const NUMBER_PATTERN = /\d+%|\$[\d,.]+|\d+\s*(million|billion|thousand|k\b)|[<>≥≤]\s*\d+|[\d,.]+\s*(times|x)\b/i;

// ── Item-level QA ─────────────────────────────────────────────────────────────

function qaItem(item, source) {
  const profile = getExtractionProfile(source.source_type);
  const issues  = [];
  let   action  = "keep"; // keep | downgrade | remove

  // Required fields
  for (const f of REQUIRED_FIELDS) {
    if (!item[f]) {
      issues.push(`missing_field:${f}`);
      action = "remove";
    }
  }

  // evidence_type valid
  if (!ALL_EVIDENCE_TYPES.includes(item.evidence_type)) {
    issues.push(`invalid_evidence_type:${item.evidence_type}`);
    action = "remove";
  }

  // evidence_type allowed by profile
  if (profile.allowed_evidence_types.length > 0 &&
      !profile.allowed_evidence_types.includes(item.evidence_type)) {
    issues.push(`type_not_in_profile:${item.evidence_type}`);
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Fact too short
  const fact = item.fact || "";
  if (fact.length < 15) {
    issues.push("fact_too_short");
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Generic fact
  if (GENERIC_PATTERNS.some((p) => p.test(fact))) {
    issues.push("generic_fact");
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Non-atomic fact (compound statement or summary) — rawfacts must be atomic.
  if (item.is_atomic === false) {
    issues.push("non_atomic_fact");
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Ungrounded quote — source_quote did not trace to the source body.
  // Only penalise when the source actually had text (quote_match !== "no_source").
  if (item.quote_verified === false && item.quote_match && item.quote_match !== "no_source") {
    issues.push(`ungrounded_quote:${item.quote_match}`);
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Marketing claim without numbers
  if (MARKETING_PATTERNS.some((p) => p.test(fact)) && !NUMBER_PATTERN.test(fact)) {
    issues.push("marketing_without_evidence");
    action = action === "remove" ? "remove" : "downgrade";
  }

  // Removed types must never reach this point — hard reject if they do
  const SYNTHESIS_ONLY_TYPES = new Set(["strategic_signal", "ecosystem_shift", "trust_boundary_shift"]);
  const METADATA_TYPES = new Set(["statistic", "timeline_event"]);
  if (SYNTHESIS_ONLY_TYPES.has(item.evidence_type)) {
    issues.push(`synthesis_only_type_in_extractor:${item.evidence_type}`);
    action = "remove";
  }
  if (METADATA_TYPES.has(item.evidence_type)) {
    issues.push(`metadata_type_not_extractable:${item.evidence_type}`);
    action = "remove";
  }

  // capability_delta requires explicit before/after comparison
  if (item.evidence_type === "capability_delta") {
    const hasCmp = /\b(now|previously|compared|before|after|than|improve|increase|exceed|surpass|first time|no longer|unable|could not|can now)\b/i.test(fact);
    if (!hasCmp) {
      issues.push("capability_delta_missing_comparison");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  // exploit_chain requires ordered steps or a concrete multi-step sequence
  if (item.evidence_type === "exploit_chain") {
    const hasSteps = /\b(step \d|first|then|next|finally|chain|sequence|subsequently|followed by|which (then|allows|enables|leads))\b/i.test(fact);
    if (!hasSteps) {
      issues.push("exploit_chain_no_ordered_steps");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  // benchmark_result should have a metric or a number
  if (item.evidence_type === "benchmark_result") {
    const hasNumber = NUMBER_PATTERN.test(fact) || (item.numbers || []).length > 0 || item.metric?.value;
    if (!hasNumber) {
      issues.push("benchmark_result_has_no_metric");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  // adversary_adoption requires named actor or direct evidence phrase
  if (item.evidence_type === "adversary_adoption") {
    const hasActor = (item.entities || []).length > 0;
    const hasObserved = /\b(observed|seen|detected|confirmed|attributed|reportedly|deploying|using|adopted|leveraging)\b/i.test(fact);
    if (!hasActor && !hasObserved) {
      issues.push("adversary_adoption_no_actor_or_evidence");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  // Governance sources should not produce attack claims
  if (GOVERNANCE_SOURCE_TYPES.has(source.source_type) &&
      ATTACK_EVIDENCE_TYPES.has(item.evidence_type)) {
    const hasConcreteEvidence = NUMBER_PATTERN.test(fact) ||
      (item.entities || []).some((e) => e.match(/CVE-\d+|APT\d+/i));
    if (!hasConcreteEvidence) {
      issues.push("governance_source_attack_claim_unsupported");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  // Strong items must pass the triage gate. (No claim-priority labels on evidence.)
  if (item.triage_data?.evidence_strength === "strong") {
    // Fail if triage says admissibility failed, OR if item has low confidence without multi-source corroboration
    const triageFailed = item.triage_data?.admissibility === "failed";
    const weakAndAlone = item.evidence_confidence === "low" &&
                         !item.evidence_cluster?.is_multi_source;
    if (triageFailed || weakAndAlone) {
      issues.push("strong_evidence_gate_failed");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  return { action, issues };
}

// Downgrade an item ONE evidence-strength level (categorical; no scores/priorities).
const STRENGTH_DOWNGRADE = { strong: "usable", usable: "context", context: "archive", archive: "archive" };

function downgradeItemStrength(item, issues) {
  const curStrength  = item.triage_data?.evidence_strength || "context";
  const nextStrength = STRENGTH_DOWNGRADE[curStrength] || "archive";
  return {
    ...item,
    triage_data: item.triage_data
      ? { ...item.triage_data, evidence_strength: nextStrength }
      : { evidence_strength: nextStrength },
    qa_issues: [...(item.qa_issues || []), ...(issues || [])],
  };
}

// ── Source-level QA ───────────────────────────────────────────────────────────

function qaSourceItems(source) {
  const items = source.evidence_items || [];
  if (items.length === 0) return source;

  const result = [];
  let removedCount = 0;

  for (const item of items) {
    const { action, issues } = qaItem(item, source);
    if (action === "remove") {
      removedCount++;
      continue;
    }
    if (action === "downgrade") {
      result.push(downgradeItemStrength(item, issues));
    } else {
      result.push(item);
    }
  }

  if (removedCount > 0) {
    process.stdout.write(
      `  [QA] "${(source.title || "").slice(0, 50)}" — removed ${removedCount}/${items.length} items\n`
    );
  }

  return { ...source, evidence_items: result };
}

// ── Pack-level QA ─────────────────────────────────────────────────────────────

function qaEvidencePack(pack) {
  // Ensure statistics contain numbers
  const statistics = (pack.statistics || []).filter((i) =>
    NUMBER_PATTERN.test(i.fact || "") || (i.numbers || []).length > 0
  );

  // strong_evidence must still be strong + admissible after item-level QA.
  const strong_evidence = (pack.strong_evidence || []).filter((i) =>
    i.triage_data?.evidence_strength === "strong" &&
    i.triage_data?.admissibility !== "failed"
  );

  // Remove duplicates within case_study_candidates
  const seenIds = new Set();
  const case_study_candidates = (pack.case_study_candidates || []).filter((i) => {
    if (seenIds.has(i.evidence_id)) return false;
    seenIds.add(i.evidence_id);
    return true;
  });

  return {
    ...pack,
    strong_evidence,
    statistics,
    case_study_candidates,
    qa_done: true,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run QA on all evidence items and packs.
 *
 * @param {object[]} sources      - Sources with evidence_items[]
 * @param {object[]} evidencePacks - Output of assembleEvidencePacks()
 * @returns {{ sources: object[], evidence_packs: object[] }}
 */
export function qaEvidenceItems(sources, evidencePacks) {
  const qaSources = sources.map(qaSourceItems);
  const qaPacks   = (evidencePacks || []).map(qaEvidencePack);

  const removed = sources.reduce((sum, s, i) => {
    const before = (s.evidence_items || []).length;
    const after  = (qaSources[i].evidence_items || []).length;
    return sum + (before - after);
  }, 0);

  process.stdout.write(
    `  [QA] Evidence QA complete — ${removed} items removed/downgraded across ${sources.length} sources\n`
  );

  return { sources: qaSources, evidence_packs: qaPacks };
}
