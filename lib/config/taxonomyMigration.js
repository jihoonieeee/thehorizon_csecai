/**
 * Legacy → taxonomy-v9 migration.
 *
 * Maps old flat tag names (from registry v1–v8) onto new coded primary tags
 * (TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE09).
 *
 * Strategy:
 *   - Unambiguous old primary tags → new primary tag (confidence: low, status: weak)
 *   - Old "child" LLM/agentic tags → new primary tag + sub-technique hint
 *   - Ambiguous legacy tags → needs_manual_review
 *   - Non-threat tags (excessive_agency etc.) → ignore as primary; record in notes
 */

import { VALID_PRIMARY_TAGS, domainOf } from "./taxonomyRegistry.js";

// ── Old primary tag → new primary tag ────────────────────────────────────────

export const OLD_TO_NEW = {
  // Traditional AI
  data_poisoning:              "TAI01_data_poisoning",
  training_data_poisoning:     "TAI01_data_poisoning",
  model_poisoning:             "TAI02_model_poisoning",
  backdoor_attack:             "TAI02_model_poisoning",
  backdoor_model:              "TAI02_model_poisoning",
  adversarial_evasion:         "TAI03_adversarial_evasion",
  evasion:                     "TAI03_adversarial_evasion",
  adversarial_data:            "TAI04_adversarial_data",
  adversarial_example:         "TAI04_adversarial_data",
  model_extraction:            "TAI05_model_extraction",
  model_theft:                 "TAI05_model_extraction",
  model_inversion:             "TAI06_model_inversion",
  reconstruction_attack:       "TAI06_model_inversion",
  membership_inference:        "TAI07_membership_inference",
  inference_api_abuse:         "TAI08_inference_api_abuse",
  model_denial_of_service:     "TAI09_model_denial_of_service",
  model_integrity_erosion:     "TAI09_model_denial_of_service",
  ai_supply_chain_compromise:  "TAI10_ai_supply_chain_compromise",
  model_repository_risk:       "TAI10_ai_supply_chain_compromise",
  training_pipeline_compromise:"TAI10_ai_supply_chain_compromise",
  model_supply_chain:          "TAI10_ai_supply_chain_compromise",

  // LLM primary tags
  prompt_injection:            "LLM01_prompt_injection",
  llm_prompt_injection_atlas:  "LLM01_prompt_injection",
  jailbreak:                   "LLM01_prompt_injection",
  guardrail_bypass:            "LLM01_prompt_injection",
  sensitive_information_disclosure: "LLM02_sensitive_information_disclosure",
  context_leakage:             "LLM02_sensitive_information_disclosure",
  llm_supply_chain_compromise: "LLM03_llm_supply_chain",
  vector_embedding_weaknesses: "LLM08_vector_embedding_weaknesses",
  vector_database_exposure:    "LLM08_vector_embedding_weaknesses",
  improper_output_handling:    "LLM05_improper_output_handling",
  system_prompt_leakage:       "LLM07_system_prompt_leakage",
  unbounded_consumption:       "LLM10_unbounded_consumption",

  // LLM child tags (old) → primary tag (new); sub-technique preserved in hint
  direct_prompt_injection:     "LLM01_prompt_injection",
  indirect_prompt_injection:   "LLM01_prompt_injection",
  multimodal_prompt_injection: "LLM01_prompt_injection",
  rag_prompt_injection:        "LLM01_prompt_injection",
  multimodal_injection:        "LLM01_prompt_injection",
  rag_poisoning:               "LLM04_data_model_poisoning",

  // Agentic primary tags → new ASI codes
  agent_prompt_injection:          "ASI01_agent_goal_hijack",
  indirect_agent_prompt_injection: "ASI01_agent_goal_hijack",
  workflow_poisoning:              "ASI01_agent_goal_hijack",
  orchestration_compromise:        "ASI01_agent_goal_hijack",
  orchestration_manipulation:      "ASI01_agent_goal_hijack",
  agentic_workflow_compromise:     "ASI01_agent_goal_hijack",
  goal_manipulation:               "ASI01_agent_goal_hijack",
  tool_poisoning:                  "ASI02_tool_misuse_exploitation",
  tool_misuse:                     "ASI02_tool_misuse_exploitation",
  tool_hijacking:                  "ASI02_tool_misuse_exploitation",
  function_hijacking:              "ASI02_tool_misuse_exploitation",
  unsafe_function_calling:         "ASI02_tool_misuse_exploitation",
  prompt_to_tool_execution:        "ASI02_tool_misuse_exploitation",
  agent_privilege_abuse:           "ASI03_identity_privilege_abuse",
  agent_credential_abuse:          "ASI03_identity_privilege_abuse",
  permission_overreach:            "ASI03_identity_privilege_abuse",
  agent_permission_abuse:          "ASI03_identity_privilege_abuse",
  agent_identity_spoofing:         "ASI03_identity_privilege_abuse",
  mcp_server_compromise:           "ASI04_agentic_supply_chain_vulnerabilities",
  mcp_abuse:                       "ASI04_agentic_supply_chain_vulnerabilities",
  tool_supply_chain_compromise:    "ASI04_agentic_supply_chain_vulnerabilities",
  tool_supply_chain_risk:          "ASI04_agentic_supply_chain_vulnerabilities",
  tool_supply_chain:               "ASI04_agentic_supply_chain_vulnerabilities",
  plugin_supply_chain_risk:        "ASI04_agentic_supply_chain_vulnerabilities",
  unsafe_code_execution:           "ASI05_unexpected_code_execution",
  sandbox_escape:                  "ASI05_unexpected_code_execution",
  coding_agent_risk:               "ASI05_unexpected_code_execution",
  agent_memory_poisoning:          "ASI06_memory_context_poisoning",
  agent_context_poisoning:         "ASI06_memory_context_poisoning",
  memory_poisoning:                "ASI06_memory_context_poisoning",
  context_manipulation:            "ASI06_memory_context_poisoning",
  memory_exfiltration:             "ASI06_memory_context_poisoning",
  agent_communication_poisoning:   "ASI07_insecure_inter_agent_communication",
  multi_agent_coordination_abuse:  "ASI07_insecure_inter_agent_communication",
  multi_agent_abuse:               "ASI07_insecure_inter_agent_communication",
  human_agent_manipulation:        "ASI09_human_agent_trust_exploitation",
  human_manipulation:              "ASI09_human_agent_trust_exploitation",
  multi_agent_human_attack:        "ASI09_human_agent_trust_exploitation",
  autonomous_execution_risk:       "ASI10_rogue_agents",
  misaligned_behavior:             "ASI10_rogue_agents",

  // AI-enabled
  ai_assisted_reconnaissance:     "AE01_ai_enabled_reconnaissance",
  ai_target_profiling:            "AE01_ai_enabled_reconnaissance",
  ai_reconnaissance:              "AE01_ai_enabled_reconnaissance",
  reconnaissance:                 "AE01_ai_enabled_reconnaissance",
  ai_assisted_phishing:           "AE02_ai_enabled_social_engineering",
  ai_social_engineering:          "AE02_ai_enabled_social_engineering",
  phishing:                       "AE02_ai_enabled_social_engineering",
  ai_enabled_fraud:               "AE02_ai_enabled_social_engineering",
  fraud:                          "AE02_ai_enabled_social_engineering",
  ai_assisted_vulnerability_research: "AE03_ai_enabled_vulnerability_research",
  ai_assisted_vulnerability_exploitation: "AE03_ai_enabled_vulnerability_research",
  ai_exploit_development:         "AE04_ai_enabled_exploit_development",
  ai_exploit_generation:          "AE04_ai_enabled_exploit_development",
  ai_malware_development:         "AE05_ai_enabled_malware_development",
  ai_assisted_malware:            "AE05_ai_enabled_malware_development",
  ai_malware_generation:          "AE05_ai_enabled_malware_development",
  malware_development:            "AE05_ai_enabled_malware_development",
  ai_payload_obfuscation:         "AE06_ai_enabled_evasion_obfuscation",
  ai_command_generation:          "AE08_ai_enabled_attack_orchestration",
  ai_attack_automation:           "AE08_ai_enabled_attack_orchestration",
  ai_orchestrated_intrusion:      "AE08_ai_enabled_attack_orchestration",
  ai_voice_impersonation:         "AE07_ai_enabled_identity_abuse",
  ai_deepfake_impersonation:      "AE07_ai_enabled_identity_abuse",
  deepfake_impersonation:         "AE07_ai_enabled_identity_abuse",
  voice_cloning:                  "AE07_ai_enabled_identity_abuse",
  synthetic_identity_abuse:       "AE07_ai_enabled_identity_abuse",
  ai_generated_disinformation:    "AE09_ai_enabled_disinformation_influence",
  disinformation:                 "AE09_ai_enabled_disinformation_influence",
};

// Old tags that were secondary dimensions (not primary threats). Not migrated as
// primary tags in the new taxonomy either — they're handled outside the tag system.
export const OLD_SECONDARY_TAGS = new Set([
  "excessive_agency", "misinformation", "overreliance",
  "resource_overload", "cascading_hallucination",
]);

// Genuinely ambiguous — require human or LLM re-tag.
export const AMBIGUOUS_LEGACY = new Set([
  "supply_chain", "supply_chain_compromise", "supply_chain_vulnerabilities",
  "training_data_poisoning_llm", "data_model_poisoning", "insecure_plugin_design",
  "federated_learning_attack", "repudiation", "human_in_the_loop_overload",
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
  // Also migrate old primary_threat_tags if they used old IDs
  for (const t of u.primary_threat_tags || []) {
    const tag = t.tag || (typeof t === "string" ? t : null);
    if (tag) push(tag, t.supporting_quote || t.evidence || "");
  }
  const seen = new Set();
  return out.filter(({ tag }) => (seen.has(tag) ? false : (seen.add(tag), true)));
}

/**
 * Migrate one source's legacy taxonomy onto taxonomy-v9.
 * Sets understanding.primary_tags (new format), .legacy_tags (old format preserved),
 * .taxonomy_migration_status, .taxonomy_version.
 */
export function migrateLegacyTaxonomy(source) {
  const u = source.understanding || {};
  const legacy = collectLegacyTags(source);

  const primaryTags = [];
  const unmapped = [];
  const secondaryNotes = [];
  const seenPrimary = new Set();

  for (const { tag, evidence } of legacy) {
    // Already a new v9 tag?
    if (VALID_PRIMARY_TAGS.has(tag)) {
      if (!seenPrimary.has(tag)) {
        seenPrimary.add(tag);
        primaryTags.push({
          tag,
          domain: domainOf(tag),
          supporting_quote: evidence,
          confidence: "low",
          validation_status: "weak",
          origin: "legacy_migration",
        });
      }
      continue;
    }

    // Map old → new
    const newTag = OLD_TO_NEW[tag];
    if (newTag) {
      if (!seenPrimary.has(newTag)) {
        seenPrimary.add(newTag);
        primaryTags.push({
          tag: newTag,
          domain: domainOf(newTag),
          supporting_quote: evidence,
          confidence: "low",
          validation_status: "weak",
          origin: "legacy_migration",
        });
      }
      continue;
    }

    if (OLD_SECONDARY_TAGS.has(tag)) {
      secondaryNotes.push(tag);
      continue;
    }

    unmapped.push(tag);
  }

  const taxonomy_migration_status = unmapped.length > 0 ? "needs_manual_review" : "migrated";

  return {
    ...source,
    understanding: {
      ...u,
      primary_tags: primaryTags,
      // Preserve old primary_threat_tags for backward compat reads
      primary_threat_tags: primaryTags,
      secondary_notes: secondaryNotes,
      taxonomy_unmapped: unmapped,
      taxonomy_migration_status,
      taxonomy_version: "taxonomy-v9-2026-06",
    },
  };
}

export function migrateLegacyTaxonomyAll(sources = []) {
  return sources.map(migrateLegacyTaxonomy);
}
