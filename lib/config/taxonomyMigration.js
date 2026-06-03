/**
 * Legacy → validated-June-2026 taxonomy migration.
 *
 * Deterministically remaps the old flat tags (framework_tags / attack_mappings /
 * tags) onto the new ontology. Unambiguous renames map straight across; non-threat
 * items become secondary_dimensions; genuinely ambiguous tags are flagged
 * needs_manual_review. Migrated primary tags are marked validation_status "weak"
 * (legacy origin) — the next full pipeline run re-tags them with proper evidence
 * via the LLM. Replaces the old normalizeLegacyTaxonomy().
 */

import {
  VALID_PRIMARY_TAGS, VALID_SECONDARY_DIMENSIONS, domainOf,
} from "./taxonomyRegistry.js";

// Unambiguous renames: legacy tag → new primary tag.
export const OLD_TO_NEW = {
  // traditional
  training_data_poisoning: "data_poisoning",
  evasion: "adversarial_evasion",
  adversarial_example: "adversarial_data",
  reconstruction_attack: "model_inversion",
  backdoor_attack: "model_poisoning",
  backdoor_model: "model_poisoning",
  model_repository_risk: "ai_supply_chain_compromise",
  training_pipeline_compromise: "ai_supply_chain_compromise",
  model_supply_chain: "ai_supply_chain_compromise",
  // llm
  llm_prompt_injection_atlas: "prompt_injection",
  multimodal_injection: "multimodal_prompt_injection",
  rag_poisoning: "rag_prompt_injection",
  // agentic
  memory_poisoning: "agent_memory_poisoning",
  unsafe_function_calling: "tool_misuse",
  prompt_to_tool_execution: "tool_misuse",
  permission_overreach: "agent_privilege_abuse",
  agent_permission_abuse: "agent_privilege_abuse",
  context_manipulation: "agent_context_poisoning",
  orchestration_manipulation: "orchestration_compromise",
  agentic_workflow_compromise: "workflow_poisoning",
  coding_agent_risk: "unsafe_code_execution",
  multi_agent_abuse: "multi_agent_coordination_abuse",
  multi_agent_human_attack: "human_agent_manipulation",
  human_manipulation: "human_agent_manipulation",
  function_hijacking: "tool_hijacking",
  mcp_abuse: "mcp_server_compromise",
  plugin_supply_chain_risk: "tool_supply_chain_compromise",
  tool_supply_chain_risk: "tool_supply_chain_compromise",
  tool_supply_chain: "tool_supply_chain_compromise",
  // ai-enabled
  phishing: "ai_assisted_phishing",
  ai_social_engineering: "ai_assisted_phishing",
  reconnaissance: "ai_assisted_reconnaissance",
  ai_reconnaissance: "ai_assisted_reconnaissance",
  malware_development: "ai_malware_development",
  ai_assisted_malware: "ai_malware_development",
  ai_malware_generation: "ai_malware_development",
  ai_exploit_generation: "ai_exploit_development",
  ai_assisted_vulnerability_exploitation: "ai_assisted_vulnerability_research",
  deepfake_impersonation: "ai_deepfake_impersonation",
  voice_cloning: "ai_voice_impersonation",
  disinformation: "ai_generated_disinformation",
  fraud: "ai_enabled_fraud",
};

// Non-threat legacy tags → secondary dimensions.
export const OLD_TO_SECONDARY = {
  excessive_agency: "excessive_agency",
  misinformation: "misinformation",
  overreliance: "overreliance",
  resource_overload: "resource_overload",
  cascading_hallucination: "cascading_hallucination",
};

// Genuinely ambiguous legacy tags — require a human or an LLM re-tag.
export const AMBIGUOUS_LEGACY = new Set([
  "supply_chain", "supply_chain_compromise", "supply_chain_vulnerabilities",
  "training_data_poisoning_llm", "data_model_poisoning", "insecure_plugin_design",
  "federated_learning_attack", "goal_manipulation", "autonomous_execution_risk",
  "misaligned_behavior", "repudiation", "human_in_the_loop_overload",
  "cross_agent_context_leakage", "social_engineering", "synthetic_identity_fraud",
  "synthetic_identity_impersonation", "exploit_public_facing_application",
  "command_execution", "credential_access", "persistence", "privilege_escalation",
  "discovery", "lateral_movement", "remote_service_abuse", "collection", "exfiltration",
]);

function collectLegacyTags(source) {
  const u = source.understanding || {};
  const out = [];
  const push = (tag, evidence) => { if (tag) out.push({ tag, evidence: evidence || "" }); };
  for (const t of u.framework_tags || []) push(t.tag || t.name || (typeof t === "string" ? t : null), t.evidence);
  for (const t of u.attack_mappings || []) push(t.tag, t.evidence);
  for (const t of source.tags || []) push(typeof t === "string" ? t : t?.tag);
  // De-dup by tag.
  const seen = new Set();
  return out.filter(({ tag }) => (seen.has(tag) ? false : (seen.add(tag), true)));
}

/**
 * Migrate one source's legacy taxonomy onto the new ontology (in place on a copy).
 * Sets understanding.primary_threat_tags, .secondary_dimensions,
 * .taxonomy_migration_status, .taxonomy_unmapped, .taxonomy_version.
 */
export function migrateLegacyTaxonomy(source) {
  const u = source.understanding || {};
  const legacy = collectLegacyTags(source);

  const primary_threat_tags = [];
  const secondary = new Set();
  const unmapped = [];
  const seenPrimary = new Set();

  for (const { tag, evidence } of legacy) {
    let newTag = null;
    if (VALID_PRIMARY_TAGS.has(tag)) newTag = tag;                 // already a new tag
    else if (OLD_TO_NEW[tag]) newTag = OLD_TO_NEW[tag];

    if (newTag) {
      if (seenPrimary.has(newTag)) continue;
      seenPrimary.add(newTag);
      primary_threat_tags.push({
        tag: newTag,
        domain: domainOf(newTag),
        supporting_quote: evidence,
        confidence: "low",
        validation_status: "weak",      // legacy origin — re-tag on next LLM run
        origin: "legacy_migration",
      });
      continue;
    }
    if (OLD_TO_SECONDARY[tag] || VALID_SECONDARY_DIMENSIONS.has(tag)) {
      secondary.add(OLD_TO_SECONDARY[tag] || tag);
      continue;
    }
    // Ambiguous or unknown → manual review.
    unmapped.push(tag);
  }

  const taxonomy_migration_status = unmapped.length > 0 ? "needs_manual_review" : "migrated";

  return {
    ...source,
    understanding: {
      ...u,
      primary_threat_tags,
      secondary_dimensions: [...secondary],
      taxonomy_unmapped: unmapped,
      taxonomy_migration_status,
      taxonomy_version: "taxonomy-2026-06",
    },
  };
}

/** Batch helper. */
export function migrateLegacyTaxonomyAll(sources = []) {
  return sources.map(migrateLegacyTaxonomy);
}
