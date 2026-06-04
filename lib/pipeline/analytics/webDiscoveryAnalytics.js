/**
 * Web Discovery Analytics (Layer 1C → analytics)
 *
 * Deterministic aggregation over the discovery run (accepted + audit
 * candidates). No LLM. Feeds the analytics branch and slide appendix.
 *
 * IMPORTANT — trend language: every count here describes the DISCOVERED CORPUS
 * within this run, not real-world prevalence. Downstream phrasing must use
 * "within the discovered corpus" / "within this run" / "candidate signal".
 */

import { getMissionDef } from "../../config/discoveryMissions.js";

function countBy(items, keyFn) {
  const c = {};
  for (const it of items) {
    const k = keyFn(it);
    if (k != null && k !== "") c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function countByArray(items, arrFn) {
  const c = {};
  for (const it of items) for (const v of (arrFn(it) || [])) if (v) c[v] = (c[v] || 0) + 1;
  return c;
}

function monthBucket(c) {
  const d = c.published_date || c.event_date;
  if (!d) return null;
  const m = String(d).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? m : null;
}

function domainOf(c) {
  if (c.taxonomy_hint?.primary_domain) return c.taxonomy_hint.primary_domain;
  const def = getMissionDef(c.discovery_mission);
  return def?.domains?.[0] || "unknown";
}

/**
 * @param {object} discoveryResult  output of runWebDiscovery
 * @returns {object} aggregated discovery analytics
 */
export function aggregateWebDiscovery(discoveryResult = {}) {
  const accepted = discoveryResult.accepted || [];
  const audit = discoveryResult.audit || [];
  const all = [...accepted, ...audit];

  const rejected = audit.filter((c) => c.route === "reject");
  const archiveOnly = audit.filter((c) => c.route === "archive_only");

  // Early-signal candidates: anything with a non-none early_signal_value.
  const signalled = all.filter((c) => c.early_signal_value && c.early_signal_value !== "none");

  // AI-enabled roles surfaced via taxonomy hints.
  const aiEnabledRoles = all.flatMap((c) =>
    (c.taxonomy_hint?.primary_tags || []).filter((t) => /^AE\d\d_/.test(t))
  );

  // "within the discovered corpus" — monthly new-attack-mode candidate counts.
  const newAttackModesByMonth = {};
  for (const c of signalled.filter((s) => s.early_signal_type === "new_attack_mode")) {
    const m = monthBucket(c);
    if (m) newAttackModesByMonth[m] = (newAttackModesByMonth[m] || 0) + 1;
  }

  return {
    // Totals
    web_discovery_candidates_total: all.length,
    web_discovery_accepted_total:   accepted.length,
    web_discovery_rejected_total:   rejected.length,
    web_discovery_archive_only_total: archiveOnly.length,
    rejected_as_buzzword_only:
      rejected.filter((c) => (c.rejection_reason || "").startsWith("buzzword_only")).length,

    // Unsupported queries (recall gaps)
    unsupported_queries_total: (discoveryResult.unsupported_queries || []).length,
    unsupported_queries_by_mission: discoveryResult.unsupported_queries_by_mission || {},
    unsupported_queries_by_source_class: discoveryResult.unsupported_queries_by_source_class || {},

    // Early-signal distributions
    early_signal_value_distribution: countBy(all, (c) => c.early_signal_value || "none"),
    early_signal_candidates_by_domain: countBy(signalled, domainOf),
    early_signal_candidates_by_type: countBy(signalled, (c) => c.early_signal_type || "none"),

    // Mission-specific candidate signals (within this run)
    new_attack_modes_by_month: newAttackModesByMonth,
    new_actor_adoption_signals: signalled.filter((c) => c.early_signal_type === "new_actor_adoption").length,
    new_agentic_attack_surfaces: signalled.filter((c) =>
      c.early_signal_type === "new_attack_surface" && domainOf(c) === "agentic_ai_threats").length,
    new_ai_enabled_roles: countBy(aiEnabledRoles.map((r) => r), (r) => r),

    // Corroboration + independence
    sources_pending_corroboration: all.filter((c) =>
      c.corroboration_status === "single_source" &&
      c.early_signal_value && c.early_signal_value !== "none").length,
    source_independence_distribution: countBy(all, (c) => c.source_independence_status || "unknown"),

    // Source typing
    discovered_source_type_distribution: countBy(all, (c) => c.source_type_hint || "unknown"),
    discovered_source_class_distribution: countBy(all, (c) => c.source_class || "unknown"),

    // Routing + QA
    route_distribution: countBy(all, (c) => c.route || "unrouted"),
    early_signal_qa_status_distribution: countBy(signalled, (c) => c.early_signal_qa_status || "not_required"),

    // Always-on caveat for downstream language.
    corpus_scope_note:
      "All web-discovery counts describe the discovered corpus within this run (candidate signals), not real-world prevalence.",
  };
}
