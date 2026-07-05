/**
 * mechanism.js — mechanism-first taxonomy mapping (Phase 0)
 *
 * The core of the classifier overhaul. The LLM no longer names a taxonomy tag;
 * it emits an intermediate MECHANISM description (what security property is
 * attacked, by what mechanism, with what consequence, at what layer). This
 * module then maps that mechanism DETERMINISTICALLY to a single primary tag,
 * a domain, and any secondary tags.
 *
 * Why: the taxonomy is made MECE by this table, not by prompt prose. The same
 * mechanism always yields the same tag, and the mapping is pure JS — fully
 * unit-testable with no API. This replaces the ad-hoc regex gates that had
 * accreted in understandSource.normalise().
 *
 * The single rule that fixes LLM↔Agentic mixups: the DOMAIN is decided by where
 * the CONSEQUENCE lands, not by which nouns appear in the text. Prompt injection
 * whose consequence is a tool call is agentic (ASI02); prompt injection whose
 * consequence is a leaked answer is llm (LLM02); prompt injection with no further
 * consequence is llm (LLM01).
 */

// ── Controlled vocabularies ────────────────────────────────────────────────────

export const SECURITY_PROPERTIES = [
  "confidentiality", "integrity", "availability", "instruction_integrity",
  "output_handling", "agency_control", "supply_chain_integrity", "model_alignment",
  "factual_reliability", "evaluation", "unknown",
];

export const EXPLOIT_MECHANISMS = [
  // LLM-surface mechanisms
  "prompt_injection", "jailbreak_safety_bypass", "sensitive_info_disclosure",
  "system_prompt_leakage", "rag_knowledge_poisoning", "vector_embedding_attack",
  "unsafe_output_execution", "unsafe_output_rendering", "excessive_agency",
  "resource_exhaustion", "misinformation_generation", "hallucination_generation",
  // agent-specific mechanisms (ASI07-10; reachable directly, not only via injection consequence)
  "inter_agent_compromise", "cascading_failure", "human_agent_trust_exploit", "rogue_agent_behavior",
  // shared / traditional-ML mechanisms
  "data_poisoning", "model_poisoning", "supply_chain_compromise",
  "model_extraction", "model_inversion", "membership_inference", "adversarial_evasion",
  // AI-as-weapon (ai_enabled) capabilities
  "ai_reconnaissance", "ai_social_engineering", "ai_vuln_research", "ai_exploit_dev",
  "ai_malware", "ai_evasion_obfuscation", "ai_identity_abuse", "ai_attack_orchestration",
  "ai_disinformation", "ai_deepfake",
  // meta
  "generic_software_vulnerability", "benchmark_or_evaluation", "defense_only", "unknown",
];

export const EVIDENCE_ROLES = [
  "attack", "defense", "benchmark", "incident", "cve", "vendor_report",
  "academic_research", "standards_guidance", "adjacent", "wrong_category",
];

export const AFFECTED_LAYERS = [
  "model", "prompt", "application", "agent", "tool", "retrieval", "vector_database",
  "dataset", "fine_tuning", "inference_infrastructure", "plugin_extension",
  "package_dependency", "deployment_artifact", "user_interface", "unknown",
];

export const CONSEQUENCES = [
  "response_manipulation", "data_exfiltration", "tool_execution", "code_execution",
  "memory_persistence", "privilege_change", "resource_exhaustion", "false_information",
  "model_theft", "training_data_recovery", "none", "unknown",
];

const UNCLEAR = "unclear_or_adjacent";

// ── Domain resolution ──────────────────────────────────────────────────────────

const AGENTIC_LAYERS      = new Set(["agent", "tool"]);
const AGENTIC_CONSEQUENCES = new Set(["tool_execution", "code_execution", "memory_persistence", "privilege_change"]);
const TRADITIONAL_LAYERS  = new Set(["model", "dataset", "fine_tuning", "inference_infrastructure"]);
const LLM_LAYERS          = new Set(["prompt", "retrieval", "vector_database", "application", "user_interface"]);
// Mechanisms that are unambiguously traditional-ML (victim is the model/training pipe)
const TRADITIONAL_ONLY    = new Set(["model_extraction", "model_inversion", "membership_inference", "adversarial_evasion"]);
// Poisoning is shared: classic-ML poisoning → traditional (TAI01/02); LLM poisoning → llm (LLM04)
const POISONING_MECHS     = new Set(["data_poisoning", "model_poisoning"]);
const AE_MECHS            = new Set(["ai_reconnaissance", "ai_social_engineering", "ai_vuln_research", "ai_exploit_dev", "ai_malware", "ai_evasion_obfuscation", "ai_identity_abuse", "ai_attack_orchestration", "ai_disinformation", "ai_deepfake"]);
const AGENTIC_ONLY_MECHS  = new Set(["inter_agent_compromise", "cascading_failure", "human_agent_trust_exploit", "rogue_agent_behavior"]);

/**
 * Resolve the threat domain from the mechanism fields.
 * Domain is decided by WHERE THE CONSEQUENCE LANDS, not by keyword surface.
 */
export function resolveDomain({ primary_exploit_mechanism: mech, affected_layer: layer, primary_consequence: cons, target_is_llm } = {}) {
  // AI-as-weapon capabilities are always ai_enabled
  if (AE_MECHS.has(mech)) return "ai_enabled_threats";

  // Agent-specific mechanisms are always agentic (ASI07-10)
  if (AGENTIC_ONLY_MECHS.has(mech)) return "agentic_ai_threats";

  // Supply chain resolves by the COMPROMISED ARTIFACT's layer, not by an incidental
  // code_execution consequence — a malicious-model-load RCE is AI supply chain
  // (traditional TAI10), NOT agent autonomy.
  if (mech === "supply_chain_compromise") {
    if (AGENTIC_LAYERS.has(layer)) return "agentic_ai_threats";        // agent ecosystem → ASI04
    if (layer === "plugin_extension") return "llm_threats";            // LLM plugin/template → LLM03
    return "traditional_ai_threats";                                   // model/pkg/artifact → TAI10
  }

  // Unambiguously traditional-ML mechanisms target the model/data/training pipeline
  if (TRADITIONAL_ONLY.has(mech) && !AGENTIC_CONSEQUENCES.has(cons)) return "traditional_ai_threats";

  // Poisoning: route by TARGET model type. Agent context → agentic; LLM victim
  // (fine-tuning/RLHF/instruction-tuning of an LLM, or an LLM I/O surface) → llm
  // (LLM04); otherwise classic-ML training pipeline → traditional (TAI01/TAI02).
  if (POISONING_MECHS.has(mech)) {
    if (AGENTIC_CONSEQUENCES.has(cons) || AGENTIC_LAYERS.has(layer)) return "agentic_ai_threats";
    if (target_is_llm === true || LLM_LAYERS.has(layer)) return "llm_threats";
    return "traditional_ai_threats";
  }

  // The consequence lands in an autonomous action → agentic
  if (AGENTIC_CONSEQUENCES.has(cons) || AGENTIC_LAYERS.has(layer)) return "agentic_ai_threats";

  // resource exhaustion on the model/inference layer → traditional (TAI09)
  if (mech === "resource_exhaustion" && TRADITIONAL_LAYERS.has(layer)) return "traditional_ai_threats";

  // generic software vuln with no AI-specific surface
  if (mech === "generic_software_vulnerability") return UNCLEAR;
  if (mech === "unknown" || mech == null) return UNCLEAR;

  // default: an LLM I/O-surface mechanism
  return "llm_threats";
}

// ── Per-domain mechanism → tag maps ────────────────────────────────────────────

const LLM_MAP = {
  jailbreak_safety_bypass:  "LLM11_jailbreak_safety_bypass",
  sensitive_info_disclosure:"LLM02_sensitive_info_disclosure",
  system_prompt_leakage:    "LLM07_system_prompt_leakage",
  rag_knowledge_poisoning:  "LLM04_data_model_poisoning",
  data_poisoning:           "LLM04_data_model_poisoning",
  model_poisoning:          "LLM04_data_model_poisoning",
  vector_embedding_attack:  "LLM08_vector_embedding_weakness",
  unsafe_output_execution:  "LLM05_improper_output_handling",
  unsafe_output_rendering:  "LLM05_improper_output_handling",
  excessive_agency:         "LLM06_excessive_agency",
  resource_exhaustion:      "LLM10_unbounded_consumption",
  misinformation_generation:"LLM09_misinformation",
  hallucination_generation: "LLM09_misinformation",
  supply_chain_compromise:  "LLM03_llm_supply_chain",
};

const TAI_MAP = {
  data_poisoning:     "TAI01_data_poisoning",
  model_poisoning:    "TAI02_model_poisoning",
  adversarial_evasion:"TAI03_adversarial_evasion",
  model_extraction:   "TAI05_model_extraction",
  model_inversion:    "TAI06_model_inversion",
  membership_inference:"TAI07_membership_inference",
  resource_exhaustion:"TAI09_model_denial_of_service",
  supply_chain_compromise:"TAI10_ai_supply_chain_compromise",
};

const AE_MAP = {
  ai_reconnaissance:     "AE01_ai_recon",
  ai_social_engineering: "AE02_ai_social_engineering",
  ai_vuln_research:      "AE03_ai_vuln_research",
  ai_exploit_dev:        "AE04_ai_exploit_dev",
  ai_malware:            "AE05_ai_malware_dev",
  ai_evasion_obfuscation:"AE06_ai_evasion_obfuscation",
  ai_identity_abuse:     "AE07_ai_identity_abuse",
  ai_attack_orchestration:"AE08_ai_attack_orchestration",
  ai_disinformation:     "AE09_ai_disinformation",
  ai_deepfake:           "AE10_ai_deepfake",
};

/**
 * Route prompt_injection by domain + consequence.
 * Injection is a DELIVERY mechanism; the primary tag is the CONSEQUENCE, with
 * LLM01 retained as a secondary tag to record the injection vector.
 */
function routeInjection(domain, cons) {
  if (domain === "agentic_ai_threats") {
    switch (cons) {
      case "tool_execution":     return { primary_tag: "ASI02_tool_misuse_exploitation", secondary_tags: ["LLM01_prompt_injection"] };
      case "code_execution":     return { primary_tag: "ASI05_unexpected_code_execution", secondary_tags: ["LLM01_prompt_injection"] };
      case "memory_persistence": return { primary_tag: "ASI06_memory_context_poisoning", secondary_tags: ["LLM01_prompt_injection"] };
      case "privilege_change":   return { primary_tag: "ASI03_identity_privilege_abuse", secondary_tags: ["LLM01_prompt_injection"] };
      case "data_exfiltration":  return { primary_tag: "LLM02_sensitive_info_disclosure", secondary_tags: ["LLM01_prompt_injection"] };
      default:                   return { primary_tag: "ASI01_agent_goal_hijack", secondary_tags: ["LLM01_prompt_injection"] };
    }
  }
  // llm domain
  if (cons === "data_exfiltration") {
    return { primary_tag: "LLM02_sensitive_info_disclosure", secondary_tags: ["LLM01_prompt_injection"] };
  }
  return { primary_tag: "LLM01_prompt_injection", secondary_tags: [] };
}

// ── Main mapping ────────────────────────────────────────────────────────────────

/**
 * Map a mechanism description to a taxonomy assignment.
 *
 * @param {object} sig
 * @param {string} sig.primary_exploit_mechanism
 * @param {string} [sig.affected_layer]
 * @param {string} [sig.primary_consequence]
 * @param {string} [sig.evidence_role]
 * @param {boolean}[sig.is_cve]
 * @param {string} [sig.benchmark_target_mechanism]  — for evidence_role=benchmark
 * @returns {{domain, primary_tag, secondary_tags, keep, is_defensive, evidence_role, rationale}}
 */
export function mapToTaxonomy(sig = {}) {
  const mech = sig.primary_exploit_mechanism;
  const cons = sig.primary_consequence || "unknown";
  const role = sig.evidence_role || "attack";

  const out = (domain, primary_tag, secondary_tags, keep, rationale, extra = {}) => ({
    domain, primary_tag, secondary_tags: secondary_tags || [], keep,
    is_defensive: role === "defense" || mech === "defense_only",
    evidence_role: role, rationale, ...extra,
  });

  // ── Meta mechanisms first ────────────────────────────────────────────────────
  if (mech === "generic_software_vulnerability") {
    return out(UNCLEAR, null, [], false,
      "Generic software vulnerability with no AI-specific attack surface → not a taxonomy threat.");
  }
  if (mech === "unknown" || mech == null) {
    return out(UNCLEAR, null, [], false, "Mechanism could not be determined → unclear_or_adjacent.");
  }
  if (mech === "benchmark_or_evaluation") {
    // Keep only if the benchmark directly evaluates a real taxonomy mechanism.
    if (sig.benchmark_target_mechanism && sig.benchmark_target_mechanism !== "benchmark_or_evaluation") {
      const inner = mapToTaxonomy({ ...sig, primary_exploit_mechanism: sig.benchmark_target_mechanism, evidence_role: "benchmark" });
      return { ...inner, rationale: `Benchmark evaluating ${sig.benchmark_target_mechanism} → ${inner.primary_tag || "unclear"}.` };
    }
    return out(UNCLEAR, null, [], false, "General benchmark/evaluation not tied to a taxonomy mechanism → unclear.");
  }
  if (mech === "defense_only") {
    return out(UNCLEAR, null, [], false,
      "Defensive contribution with no specific defended mechanism identified → unclear (is_defensive).");
  }

  const domain = resolveDomain(sig);

  // ── Prompt injection — consequence-routed (fixes LLM↔Agentic mixup) ────────────
  if (mech === "prompt_injection") {
    const r = routeInjection(domain, cons);
    return out(domain, r.primary_tag, r.secondary_tags, true,
      `Prompt injection with consequence "${cons}" in ${domain} → ${r.primary_tag}.`);
  }

  // ── Per-domain mechanism lookup ───────────────────────────────────────────────
  let tag = null;
  if (domain === "traditional_ai_threats") tag = TAI_MAP[mech];
  else if (domain === "ai_enabled_threats") tag = AE_MAP[mech];
  else if (domain === "agentic_ai_threats") {
    // Non-injection agentic mechanisms
    if (mech === "excessive_agency")            tag = "ASI01_agent_goal_hijack";
    else if (mech === "supply_chain_compromise") tag = "ASI04_agentic_supply_chain";
    else if (mech === "inter_agent_compromise")  tag = "ASI07_insecure_agent_comms";
    else if (mech === "cascading_failure")       tag = "ASI08_cascading_failures";
    else if (mech === "human_agent_trust_exploit") tag = "ASI09_human_agent_trust_exploit";
    else if (mech === "rogue_agent_behavior")    tag = "ASI10_rogue_agents";
    else if (mech === "resource_exhaustion")     tag = "LLM10_unbounded_consumption"; // consumption is cross-domain
    else tag = LLM_MAP[mech]; // fall back to llm-surface mapping for agent-hosted llm attacks
  } else {
    // llm_threats
    tag = LLM_MAP[mech];
  }

  if (!tag) {
    return out(UNCLEAR, null, [], false,
      `Mechanism "${mech}" has no mapping in domain ${domain} → unclear_or_adjacent.`);
  }

  return out(domain, tag, [], true, `Mechanism "${mech}" (${cons}) → ${tag}.`);
}

// ── Validation + reconciliation ─────────────────────────────────────────────────

const MECH_SET  = new Set(EXPLOIT_MECHANISMS);
const PROP_SET  = new Set(SECURITY_PROPERTIES);
const ROLE_SET  = new Set(EVIDENCE_ROLES);
const LAYER_SET = new Set(AFFECTED_LAYERS);
const CONS_SET  = new Set(CONSEQUENCES);

/**
 * Coerce raw LLM mechanism fields to the controlled vocabularies, defaulting
 * anything out-of-vocab to "unknown" so mapToTaxonomy degrades to unclear.
 */
export function validateMechanismFields(raw = {}) {
  const pick = (v, set) => (typeof v === "string" && set.has(v) ? v : "unknown");
  return {
    primary_security_property: pick(raw.primary_security_property, PROP_SET),
    primary_exploit_mechanism: pick(raw.primary_exploit_mechanism, MECH_SET),
    primary_consequence:       pick(raw.primary_consequence, CONS_SET),
    affected_layer:            pick(raw.affected_layer, LAYER_SET),
    evidence_role:             (typeof raw.evidence_role === "string" && ROLE_SET.has(raw.evidence_role)) ? raw.evidence_role : "attack",
    attack_medium:             typeof raw.attack_medium === "string" ? raw.attack_medium : null,
    mechanism_rationale:       typeof raw.mechanism_rationale === "string" ? raw.mechanism_rationale.slice(0, 300) : null,
    benchmark_target_mechanism: pick(raw.benchmark_target_mechanism, MECH_SET),
    target_is_llm:             raw.target_is_llm === true,
  };
}

/**
 * Reconcile the deterministic mapping with the LLM's own tag suggestion.
 * The deterministic tag is AUTHORITATIVE (consistency); the suggestion is an
 * independent cross-check. Agreement raises confidence; disagreement is flagged
 * for review (surfaced by debugTaxonomyReport) without changing the outcome.
 *
 * @param {object} mapped     — result of mapToTaxonomy()
 * @param {string} suggestion — the LLM's primary_taxonomy_suggestion
 * @returns {{final_tag, agreement, conflict, llm_suggestion}}
 */
export function reconcileTag(mapped, suggestion) {
  const finalTag = mapped.primary_tag;
  const sug = (typeof suggestion === "string" && suggestion) ? suggestion : null;
  // Agreement if the LLM's primary suggestion equals the mapped primary tag, or
  // appears among the mapped secondaries (the map may re-prioritise into secondary).
  const agreement = sug != null && (sug === finalTag || (mapped.secondary_tags || []).includes(sug));
  return {
    final_tag: finalTag,
    llm_suggestion: sug,
    agreement,
    conflict: sug != null && finalTag != null && !agreement,
  };
}

// ── Prompt vocabulary definitions (informs the LLM's semantic judgment) ──────────
// Crisp, orthogonal, example-bearing. The definitional investment goes HERE
// (small orthogonal vocab) rather than into the 40 overlapping tags.

export const MECHANISM_DEFINITIONS = {
  prompt_injection:          "Attacker-controlled instructions arrive via an EXTERNAL/UNTRUSTED channel (web page, email, retrieved doc, tool output, file, image, code comment) and the model executes them. The channel is untrusted external input — NOT the direct user.",
  jailbreak_safety_bypass:   "The DIRECT user tries to bypass the model's own safety training/alignment/refusal (adversarial suffix, roleplay/DAN, many-shot, obfuscation, multi-turn erosion). Target is the model's alignment, not an external channel.",
  sensitive_info_disclosure: "Confidentiality is the primary loss: secrets, credentials, API keys, PII, private data leaked. (System-prompt leakage has its own mechanism.)",
  system_prompt_leakage:     "The objective is specifically to recover/expose hidden system/developer/agent instructions.",
  rag_knowledge_poisoning:   "The retrieval corpus / knowledge base is CORRUPTED so the model retrieves attacker content. The corpus is the weapon (integrity).",
  vector_embedding_attack:   "The embedding/vector representation is the VICTIM — stolen, inverted to recover private text, enumerated, or cross-tenant leaked. NOT corpus poisoning.",
  data_poisoning:            "Training/fine-tuning/federated/synthetic DATA is manipulated. Manipulated asset = data.",
  model_poisoning:           "Model PARAMETERS are manipulated — weights, gradients, checkpoints, LoRA/adapters, neural trojans, optimizer-triggered backdoors. Manipulated asset = model.",
  adversarial_evasion:       "Inference-time input perturbation makes a model misclassify while the object stays functionally similar (adversarial examples, detector evasion, patches). Store modality in attack_medium.",
  model_extraction:          "Objective is to steal/clone model functionality, parameters, or decision boundary. NOT membership or inversion.",
  model_inversion:           "Objective is to reconstruct training data/features/inputs from outputs, gradients, or parameters.",
  membership_inference:      "Objective is to determine whether a specific record was in the training/RAG/memory set. NOT extraction or inversion.",
  unsafe_output_execution:   "The app EXECUTES model output unsafely (generated shell/SQL/code run, tool call, file write).",
  unsafe_output_rendering:   "The app RENDERS/parses model output unsafely (HTML/Markdown/template → XSS/SSTI).",
  excessive_agency:          "An LLM/agent has too much authority/autonomy/permissions/tool access; the core risk is over-authorized action.",
  resource_exhaustion:       "Primary effect is availability loss / resource or cost exhaustion (GPU/memory/KV-cache/token/context exhaustion, denial-of-wallet, tool-call amplification).",
  supply_chain_compromise:   "Risk enters through a compromised artifact/dependency: model file, dataset, package, plugin/extension, MCP server, serving infra, deployment pipeline.",
  misinformation_generation: "AI generates/amplifies false or misleading information at scale (synthetic news, disinformation).",
  hallucination_generation:  "The model fabricates facts/citations/packages; false information is the central concern.",
  ai_reconnaissance:         "AI-as-weapon: gathering intelligence about targets (OSINT, profiling, scanning).",
  ai_social_engineering:     "AI-as-weapon: crafting persuasive human-targeted communications (phishing) at scale. Primary capability = persuasion.",
  ai_vuln_research:          "AI-as-weapon: autonomously discovering/analysing vulnerabilities.",
  ai_exploit_dev:            "AI-as-weapon: generating/refining working exploits.",
  ai_malware:                "AI-as-weapon: authoring/mutating/packaging malicious software.",
  ai_evasion_obfuscation:    "AI-as-weapon: making malicious content/behaviour harder to detect.",
  ai_identity_abuse:         "AI-as-weapon: impersonating specific individuals (voice/face/documents).",
  ai_attack_orchestration:   "AI-as-weapon: autonomously coordinating multi-stage attacks.",
  ai_disinformation:         "AI-as-weapon: generating/amplifying false narratives at scale (influence ops).",
  ai_deepfake:               "AI-as-weapon: synthetic audio/video/image where the medium itself is the primary weapon.",
  generic_software_vulnerability: "A conventional appsec bug (RCE/SSRF/XSS/SQLi/path traversal/auth) with NO AI-specific attack surface — even if the product is an AI product.",
  benchmark_or_evaluation:   "The source's primary contribution is a benchmark/eval/survey, not a new attack. Set benchmark_target_mechanism to what it evaluates.",
  defense_only:              "The primary contribution is a defense/mitigation with no specific attack of its own.",
  unknown:                   "The mechanism cannot be determined.",
};

export const CONSEQUENCE_DEFINITIONS = {
  response_manipulation: "The harm lands in the model's text response (wrong/altered answer, refusal bypass).",
  data_exfiltration:     "The harm is leaked secrets/PII/private data.",
  tool_execution:        "The agent invokes a tool/function/API as the harmful action.",
  code_execution:        "Attacker code/commands run on the agent or host.",
  memory_persistence:    "The attack persists into stored memory/context affecting FUTURE turns/sessions.",
  privilege_change:      "The agent's identity/credentials/permissions are abused or escalated.",
  resource_exhaustion:   "Availability/cost is exhausted.",
  false_information:     "False/misleading content is produced.",
  model_theft:           "Model functionality/parameters are stolen.",
  training_data_recovery:"Private training/corpus data is reconstructed or its membership inferred.",
  none:                  "No consequence beyond the mechanism itself.",
  unknown:               "The consequence cannot be determined.",
};

/**
 * Build the mechanism-vocabulary block for the classifier system prompt.
 */
export function buildMechanismPromptBlock() {
  const lines = [];
  lines.push("MECHANISM-FIRST CLASSIFICATION — do NOT pick a tag from keywords. First determine, from the source's PRIMARY security objective:");
  lines.push("");
  lines.push("primary_exploit_mechanism (choose ONE — the dominant mechanism):");
  for (const [k, v] of Object.entries(MECHANISM_DEFINITIONS)) lines.push(`  • ${k} — ${v}`);
  lines.push("");
  lines.push("primary_consequence (choose ONE — where the harm lands; THIS decides LLM vs Agentic):");
  for (const [k, v] of Object.entries(CONSEQUENCE_DEFINITIONS)) lines.push(`  • ${k} — ${v}`);
  lines.push("");
  lines.push("primary_security_property: " + SECURITY_PROPERTIES.join(" | "));
  lines.push("affected_layer: " + AFFECTED_LAYERS.join(" | "));
  lines.push("evidence_role: " + EVIDENCE_ROLES.join(" | "));
  lines.push("attack_medium (for adversarial_evasion only): image | audio | text | code | video | physical | multimodal | unknown");
  lines.push("");
  lines.push("KEY RULE — the CONSEQUENCE sets the domain, not the keywords:");
  lines.push("  prompt injection whose consequence is tool_execution → agentic (tool misuse)");
  lines.push("  prompt injection whose consequence is code_execution → agentic (code execution)");
  lines.push("  prompt injection whose consequence is memory_persistence → agentic (memory poisoning)");
  lines.push("  prompt injection whose consequence is data_exfiltration → llm (sensitive info disclosure)");
  lines.push("  prompt injection with no further consequence → llm (prompt injection)");
  lines.push("");
  lines.push("Then, as an INDEPENDENT CROSS-CHECK, also give primary_taxonomy_suggestion (one tag ID you think fits) and secondary_taxonomy_suggestions. This is advisory — a deterministic mapper assigns the final tag from your mechanism fields.");
  return lines.join("\n");
}
