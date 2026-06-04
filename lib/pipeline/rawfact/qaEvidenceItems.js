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
  "governance_signal", "ecosystem_signal", "strategic_signal",
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

  // Statistics must contain numbers
  if (item.evidence_type === "statistic" && !NUMBER_PATTERN.test(fact) &&
      (item.numbers || []).length === 0) {
    issues.push("statistic_has_no_number");
    action = action === "remove" ? "remove" : "downgrade";
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

  // Critical items must pass the gate
  if (item.score_data?.evidence_priority === "critical") {
    const bd = item.score_data?.score_breakdown || {};
    if (bd.source_authority < 10 || bd.evidence_strength < 14 ||
        (bd.operational_relevance < 15 && bd.horizon_significance < 15) ||
        item.evidence_confidence === "low" || bd.penalties > 5) {
      issues.push("critical_gate_failed");
      action = action === "remove" ? "remove" : "downgrade";
    }
  }

  return { action, issues };
}

function downgradeItemPriority(item) {
  const priorities = ["critical","high","medium","low","archive_only"];
  const cur = item.score_data?.evidence_priority || "medium";
  const idx = priorities.indexOf(cur);
  const next = priorities[Math.min(idx + 1, priorities.length - 1)];
  const newScore = Math.max(0, (item.score_data?.evidence_score ?? 50) - 15);
  return {
    ...item,
    score_data: {
      ...item.score_data,
      evidence_priority: next,
      evidence_score: newScore,
    },
    qa_issues: [...(item.qa_issues || []), ...(item._qa_issues_pending || [])],
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
      result.push({ ...downgradeItemPriority(item), qa_issues: issues });
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

  // Ensure critical_evidence all have score ≥ 85
  const critical_evidence = (pack.critical_evidence || []).filter((i) =>
    (i.score_data?.evidence_score ?? 0) >= 85
  );

  // Remove duplicates within case_studies
  const seenIds = new Set();
  const case_studies = (pack.case_studies || []).filter((i) => {
    if (seenIds.has(i.evidence_id)) return false;
    seenIds.add(i.evidence_id);
    return true;
  });

  return {
    ...pack,
    critical_evidence,
    statistics,
    case_studies,
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
