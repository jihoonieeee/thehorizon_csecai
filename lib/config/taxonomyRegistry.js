/**
 * Canonical AI Threat Taxonomy Registry — v9 (docs/TAXONOMY.md)
 *
 * Source of truth: docs/TAXONOMY.md
 *
 * Architecture:
 *  • Four domains: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats
 *  • Primary tags use coded IDs: TAI01–TAI10, LLM01–LLM10, ASI01–ASI10, AE01–AE10
 *  • Sub-techniques belong to exactly one primary tag; they are NOT primary tags themselves
 *  • AI-enabled (AE01–AE10) serves dual roles:
 *      1. Primary domain when the source is mainly about AI-assisted conventional cyber operations
 *      2. Cross-cutting overlay on any other domain (ai_enabled=true + ai_enabled_roles[])
 *  • AI-enabled categories intentionally have no sub-techniques — use metadata overlays instead
 *
 * Helpers:
 *   getPrimaryTags(domain)
 *   getSubTechniques(primaryTag)
 *   validatePrimaryTag(tag)
 *   validateSubTechnique(primaryTag, subtag)
 *   validateAiEnabledRole(role)
 *   normalizeTaxonomyAssignment(raw)
 *   buildTaxonomyContextForPrompt(domain?)
 */
import { PRIMARY_TAGS as CANON_PRIMARY_TAGS, SUB_TECHNIQUES as CANON_SUB_TECHNIQUES } from "../pipeline/understand/taxonomy.js";

export const TAXONOMY_VERSION = "taxonomy-v9-2026-06";

export const DOMAINS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Reference URLs ────────────────────────────────────────────────────────────

export const REFERENCE_URLS = {
  MITRE_ATLAS:            "https://atlas.mitre.org/",
  MITRE_ATLAS_SAFE_AI:    "https://atlas.mitre.org/pdf-files/SAFEAI_Full_Report.pdf",
  OWASP_LLM_TOP_10:       "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
  OWASP_AGENTIC_AI:       "https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/",
  OWASP_MCP_TOP_10:       "https://owasp.org/www-project-mcp-top-10/",
  MITRE_ATTACK:           "https://attack.mitre.org/",
  DISARM:                 "https://www.disarm.foundation/framework",
  NIST_AI_RMF:            "https://airc.nist.gov/RMF/About",
};

// ── Domain assignment rules ───────────────────────────────────────────────────

export const DOMAIN_ASSIGNMENT_RULES = {
  traditional_ai_threats:
    "Assign when the ML model, training data, inference path, or ML supply chain is specifically attacked. Do not assign for ordinary software compromise with no AI/ML model involvement.",
  llm_threats:
    "Assign when there is LLM-specific evidence: prompts, guardrails, context window, RAG, embeddings, system prompt. Do not assign for generic AI model risks.",
  agentic_ai_threats:
    "Assign when the AI system acts through memory, context, tools, MCP, runtime, credentials, workflow, orchestration, communication, or autonomy. Do not assign for a plain LLM with no agentic action.",
  ai_enabled_threats:
    "Assign as primary domain ONLY when the source is primarily about AI being used as an offensive tool to enhance conventional cyber operations. For AI-augmented attacks where the primary subject is an AI-specific technique, use ai_enabled as an overlay instead.",
};

// ── Primary tag definitions ───────────────────────────────────────────────────
// Each primary tag: { id, domain, label, description, framework_refs, mapping_type }

// ── Primary tag + sub-technique data (DERIVED) ────────────────────────────────
// Tag IDs, labels, domains, descriptions, and framework refs come from the single
// canonical taxonomy (lib/pipeline/understand/taxonomy.js) so the two never diverge.
const PRIMARY_TAG_DEFS = CANON_PRIMARY_TAGS.map((t) => ({
  id: t.id,
  domain: t.domain,
  label: t.label,
  description: t.description || "",
  framework_refs: t.framework_refs || [],
  mapping_type: "direct_framework_mapping",
}));

const SUB_TECHNIQUE_DEFS = CANON_SUB_TECHNIQUES.map((s) => ({ id: s.id, parent_tag: s.parent }));

// ── Controlled vocabulary for ai_capabilities overlay ────────────────────────

export const VALID_AI_CAPABILITIES = new Set([
  "synthetic_text_generation",
  "synthetic_image_generation",
  "synthetic_audio_generation",
  "synthetic_video_generation",
  "code_generation",
  "automation",
  "autonomous_planning",
  "reconnaissance_automation",
  "vulnerability_analysis",
  "natural_language_understanding",
  "multimodal_processing",
  "adversarial_optimization",
]);

// ── Build indexes ─────────────────────────────────────────────────────────────

export const TAXONOMY = {};
for (const def of PRIMARY_TAG_DEFS) {
  TAXONOMY[def.id] = {
    ...def,
    tag_type: "primary_threat",
    requires_concrete_evidence: true,
    assignment_rule: DOMAIN_ASSIGNMENT_RULES[def.domain],
  };
}

export const SUB_TECHNIQUES = {};
for (const def of SUB_TECHNIQUE_DEFS) {
  SUB_TECHNIQUES[def.id] = def;
}

// Sub-techniques by parent tag
const _subTechByParent = {};
for (const def of SUB_TECHNIQUE_DEFS) {
  (_subTechByParent[def.parent_tag] = _subTechByParent[def.parent_tag] || []).push(def.id);
}

export const VALID_PRIMARY_TAGS = new Set(Object.keys(TAXONOMY));
export const VALID_SUB_TECHNIQUES = new Set(Object.keys(SUB_TECHNIQUES));

export const VALID_AI_ENABLED_ROLES = new Set(
  Object.keys(TAXONOMY).filter((t) => TAXONOMY[t].domain === "ai_enabled_threats")
);

export const PRIMARY_TAGS_BY_DOMAIN = DOMAINS.reduce((acc, d) => {
  acc[d] = PRIMARY_TAG_DEFS.filter((e) => e.domain === d).map((e) => e.id);
  return acc;
}, {});

// ── Lookup helpers ────────────────────────────────────────────────────────────

export function getTag(tag) { return TAXONOMY[tag] || null; }
export function domainOf(tag) { return TAXONOMY[tag]?.domain || null; }
export function isPrimaryTag(tag) { return VALID_PRIMARY_TAGS.has(tag); }
export function isValidSubTechnique(subtag) { return VALID_SUB_TECHNIQUES.has(subtag); }
export function isValidAiEnabledRole(role) { return VALID_AI_ENABLED_ROLES.has(role); }

/**
 * Get primary tags for a domain.
 */
export function getPrimaryTags(domain) {
  return PRIMARY_TAGS_BY_DOMAIN[domain] || [];
}

/**
 * Get sub-techniques for a primary tag.
 */
export function getSubTechniques(primaryTag) {
  return _subTechByParent[primaryTag] || [];
}

/**
 * Check if subtag is a valid sub-technique of primaryTag.
 */
export function validateSubTechnique(primaryTag, subtag) {
  const def = SUB_TECHNIQUES[subtag];
  return !!(def && def.parent_tag === primaryTag);
}

/**
 * Validate a primary tag string.
 * Returns { valid, reason }.
 */
export function validatePrimaryTag(tag) {
  if (!tag) return { valid: false, reason: "no tag supplied" };
  if (!VALID_PRIMARY_TAGS.has(tag)) return { valid: false, reason: `'${tag}' is not a primary tag` };
  return { valid: true, reason: null };
}

/**
 * Validate an AI-enabled role string (AE01–AE09).
 * Returns { valid, reason }.
 */
export function validateAiEnabledRole(role) {
  if (!role) return { valid: false, reason: "no role supplied" };
  if (!VALID_AI_ENABLED_ROLES.has(role)) return { valid: false, reason: `'${role}' is not a valid AE role (AE01–AE10)` };
  return { valid: true, reason: null };
}

/**
 * Normalize a raw taxonomy assignment from LLM output into canonical shape.
 * Returns a validated assignment object.
 */
export function normalizeTaxonomyAssignment(raw) {
  if (!raw || typeof raw !== "object") return null;

  const primaryDomain = DOMAINS.includes(raw.primary_domain) ? raw.primary_domain : null;

  // Validate and filter primary_tags
  const primaryTags = (Array.isArray(raw.primary_tags) ? raw.primary_tags : [])
    .filter((t) => typeof t === "string" && VALID_PRIMARY_TAGS.has(t))
    .filter((t) => !primaryDomain || TAXONOMY[t]?.domain === primaryDomain)
    .slice(0, 4);

  // Validate sub_techniques — must belong to one of the selected primary tags
  const allowedParents = new Set(primaryTags);
  const subTechniques = (Array.isArray(raw.sub_techniques) ? raw.sub_techniques : [])
    .filter((s) => {
      if (typeof s === "string") {
        const def = SUB_TECHNIQUES[s];
        return def && allowedParents.has(def.parent_tag);
      }
      if (typeof s === "object" && s.id) {
        const def = SUB_TECHNIQUES[s.id];
        return def && allowedParents.has(def.parent_tag);
      }
      return false;
    })
    .map((s) => typeof s === "string" ? s : s.id);

  // AI-enabled overlay
  const aiEnabled = raw.ai_enabled === true;
  const aiEnabledRoles = (Array.isArray(raw.ai_enabled_roles) ? raw.ai_enabled_roles : [])
    .filter((r) => typeof r === "string" && VALID_AI_ENABLED_ROLES.has(r));
  const aiCapabilities = (Array.isArray(raw.ai_capabilities) ? raw.ai_capabilities : [])
    .filter((c) => typeof c === "string" && VALID_AI_CAPABILITIES.has(c));

  const AUTOMATION_LEVELS = new Set(["human_assisted", "semi_autonomous", "autonomous", "unknown"]);
  const AUTONOMY_LEVELS = new Set(["human_assisted", "semi_autonomous", "autonomous", "multi_agent", "unknown"]);
  const MAPPING_TYPES = new Set(["direct_framework_mapping", "operational_abstraction", "synthesized_research_category"]);
  const EVIDENCE_STRENGTHS = new Set(["weak", "moderate", "strong"]);

  return {
    primary_domain:      primaryDomain,
    primary_tags:        primaryTags,
    sub_techniques:      subTechniques,
    ai_enabled:          aiEnabled,
    ai_enabled_roles:    aiEnabledRoles,
    ai_capabilities:     aiCapabilities,
    automation_level:    AUTOMATION_LEVELS.has(raw.automation_level) ? raw.automation_level : "unknown",
    autonomy_level:      AUTONOMY_LEVELS.has(raw.autonomy_level) ? raw.autonomy_level : "unknown",
    mapping_type:        MAPPING_TYPES.has(raw.mapping_type) ? raw.mapping_type : null,
    mapped_frameworks:   Array.isArray(raw.mapped_frameworks) ? raw.mapped_frameworks.slice(0, 8) : [],
    evidence_strength:   EVIDENCE_STRENGTHS.has(raw.evidence_strength) ? raw.evidence_strength : "moderate",
    confidence_score:    typeof raw.confidence_score === "number"
      ? Math.max(0, Math.min(1, raw.confidence_score)) : null,
    delivery_vector:     typeof raw.delivery_vector === "string" ? raw.delivery_vector : null,
    attack_modality:     typeof raw.attack_modality === "string" ? raw.attack_modality : null,
    target_platform:     typeof raw.target_platform === "string" ? raw.target_platform : null,
    disclosed_data_type: typeof raw.disclosed_data_type === "string" ? raw.disclosed_data_type : null,
    taxonomy_version:    TAXONOMY_VERSION,
  };
}

// ── Prompt context builder (for L4 understand prompt) ────────────────────────

export function buildTaxonomyContextForPrompt(domain = null) {
  const domains = domain ? [domain] : DOMAINS;
  const lines = [];

  for (const d of domains) {
    lines.push(`### ${d}`);
    lines.push(DOMAIN_ASSIGNMENT_RULES[d]);
    lines.push("Primary tags:");
    for (const tag of PRIMARY_TAGS_BY_DOMAIN[d]) {
      const e = TAXONOMY[tag];
      const subs = getSubTechniques(tag);
      const subLine = subs.length ? ` — sub-techniques: ${subs.slice(0, 5).join(", ")}${subs.length > 5 ? "…" : ""}` : "";
      lines.push(`  - ${tag} (${e.label}) — ${e.description}${subLine}`);
    }
    lines.push("");
  }

  lines.push("### AI-Enabled Overlay");
  lines.push("AI-enabled roles (AE01–AE10) can appear as overlay metadata on ANY domain when AI materially enhances the attack.");
  lines.push("Only set primary_domain=ai_enabled_threats when the source is PRIMARILY about AI being used for conventional cyber operations.");
  for (const tag of PRIMARY_TAGS_BY_DOMAIN.ai_enabled_threats) {
    const e = TAXONOMY[tag];
    lines.push(`  - ${tag} (${e.label}) — ${e.description}`);
  }

  return lines.join("\n");
}

// ── Reference seed helper (for taxonomyStore seeding) ────────────────────────

export function allReferenceRecords() {
  const seen = new Set();
  const records = [];
  for (const e of Object.values(TAXONOMY)) {
    for (const ref of e.framework_refs || []) {
      const key = `${e.domain}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ framework: e.domain, framework_item: ref, url: "", description: e.description });
    }
  }
  return records;
}
