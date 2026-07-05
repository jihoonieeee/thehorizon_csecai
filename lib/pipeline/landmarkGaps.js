/**
 * landmarkGaps.js — per-tag landmark-topic coverage + targeted search directives
 *
 * Two jobs:
 *   1. Detect which expected landmark topics have ZERO coverage in the corpus
 *      (a recall failure, not a classifier error) — pure keyword scan, no API.
 *   2. Turn each gap into a TARGETED, well-formed search directive routed to the
 *      right provider — NOT a blind scrape. Phase 5 feeds these directives into
 *      the web-search/discovery connectors so gaps drive precise queries.
 *
 * Topics are grouped by taxonomy tag (existing IDs). Keep them lowercase-matchable.
 */

export const LANDMARK_TOPICS = {
  // ── LLM ────────────────────────────────────────────────────────────────────
  LLM01_prompt_injection: [
    "indirect prompt injection", "browser agent prompt injection",
    "coding agent prompt injection", "MCP prompt injection",
    "visual prompt injection", "multimodal prompt injection",
    "tool output injection", "email prompt injection",
  ],
  LLM02_sensitive_info_disclosure: [
    "training data extraction", "training data memorization", "prompt stealing",
    "system prompt extraction", "cross-session memory leakage",
    "RAG document leakage", "embedding inversion", "vector database leakage",
    "membership inference",
  ],
  LLM03_llm_supply_chain: [
    "malicious Hugging Face model", "malicious LoRA adapter",
    "malicious checkpoint", "GGUF security", "prompt template poisoning",
    "model provenance", "model signing", "safetensors security",
    "AI dependency compromise", "plugin extension compromise",
  ],
  LLM04_data_model_poisoning: [
    "instruction tuning poisoning", "fine-tuning poisoning",
    "RLHF poisoning", "reward model poisoning", "synthetic data poisoning",
    "LoRA poisoning", "checkpoint poisoning", "RAG corpus poisoning",
    "embedding poisoning", "model backdoor",
  ],
  LLM05_improper_output_handling: [
    "unsafe generated code execution", "shell command execution",
    "SQL generation injection", "unsafe markdown rendering", "unsafe HTML rendering",
    "browser execution", "file write via LLM", "template injection via LLM",
    "function calling abuse", "tool output parsing",
  ],
  LLM06_excessive_agency: [
    "MCP abuse", "browser agent abuse", "coding agent abuse",
    "autonomous tool chaining", "recursive agent", "permission escalation agent",
    "computer use abuse", "multi-agent orchestration failure",
  ],
  LLM07_system_prompt_leakage: [
    "system prompt extraction", "developer prompt leakage",
    "hidden instruction disclosure", "prompt recovery", "prompt stealing",
    "agent prompt exfiltration", "instruction hierarchy bypass",
  ],
  LLM08_vector_embedding_weakness: [
    "embedding inversion", "vector database enumeration",
    "cross-tenant vector leakage", "similarity search manipulation",
    "ANN attack", "embedding leakage", "representation leakage",
    "vector side channel", "semantic search manipulation",
  ],
  LLM09_misinformation: [
    "fabricated citation", "hallucinated citation", "package hallucination",
    "legal hallucination", "medical hallucination", "scientific hallucination",
    "fake evidence generation", "election misinformation", "synthetic news",
    "authority impersonation",
  ],
  LLM10_unbounded_consumption: [
    "denial of wallet", "token flooding", "context window exhaustion",
    "KV cache exhaustion", "GPU exhaustion", "API cost amplification",
    "recursive agent loop", "tool call amplification",
  ],
  LLM11_jailbreak_safety_bypass: [
    "adversarial suffix", "roleplay jailbreak", "multi-turn jailbreak",
    "many-shot jailbreak", "obfuscation jailbreak", "multimodal jailbreak",
    "audio jailbreak", "refusal bypass", "alignment bypass",
  ],

  // ── Traditional AI (existing IDs) ────────────────────────────────────────────
  TAI01_data_poisoning: [
    "clean-label poisoning", "dirty-label poisoning", "label flipping attack",
    "feature collision attack", "synthetic data poisoning",
    "federated data poisoning", "instruction-tuning data poisoning",
    "RAG corpus poisoning",
  ],
  TAI02_model_poisoning: [
    "checkpoint poisoning", "neural trojan", "weight poisoning",
    "gradient poisoning", "model replacement attack",
    "federated model update poisoning", "LoRA poisoning",
    "optimizer-triggered backdoor",
  ],
  TAI03_adversarial_evasion: [
    "adversarial patch", "universal adversarial perturbation", "transfer attack",
    "query-efficient attack", "physical-world attack", "object detection evasion",
    "face recognition evasion", "malware detector evasion",
    "audio adversarial attack", "code model evasion",
  ],
  TAI05_model_extraction: [
    "query synthesis attack", "Jacobian-based extraction", "Knockoff Nets",
    "surrogate model generation", "API model stealing",
    "decision boundary reconstruction", "hard-label extraction",
    "commercial API extraction",
  ],
  TAI06_model_inversion: [
    "deep leakage from gradients", "gradient inversion", "feature inversion",
    "image reconstruction attack", "face reconstruction", "input reconstruction",
    "attribute inference", "federated reconstruction", "split-learning reconstruction",
  ],
  TAI07_membership_inference: [
    "confidence-based membership inference", "loss-based membership inference",
    "label-only membership inference", "white-box membership inference",
    "federated membership inference", "diffusion membership inference",
    "LLM membership inference", "RAG membership inference",
  ],
  TAI09_model_denial_of_service: [
    "GPU exhaustion", "inference resource exhaustion", "batch amplification",
    "sponge example", "token flooding", "context window exhaustion",
    "KV cache exhaustion", "model-serving queue exhaustion",
    "adversarial compute amplification",
  ],
  TAI10_ai_supply_chain_compromise: [
    "malicious Hugging Face model", "malicious LoRA adapter",
    "malicious GGUF checkpoint", "safetensors security", "model provenance",
    "model signing", "model SBOM", "dependency confusion ML",
    "model registry compromise", "MLflow registry vulnerability",
    "SLSA for ML artifacts",
  ],

  // ── Agentic ──────────────────────────────────────────────────────────────────
  ASI01_agent_goal_hijack: [
    "agent goal hijack", "planner manipulation", "objective subversion",
    "agent instruction override",
  ],
  ASI02_tool_misuse_exploitation: [
    "MCP tool abuse", "tool description poisoning", "tool invocation exploit",
    "function calling abuse", "cross-tool exfiltration",
  ],
  ASI03_identity_privilege_abuse: [
    "agent privilege escalation", "agent credential theft",
    "agent delegation abuse", "agent authorization bypass",
  ],
  ASI04_agentic_supply_chain: [
    "malicious MCP server", "malicious agent plugin", "malicious skill",
    "compromised agent framework",
  ],
  ASI05_unexpected_code_execution: [
    "agent shell execution", "coding agent auto-execution",
    "agent sandbox escape", "agent code interpreter exploit",
  ],
  ASI06_memory_context_poisoning: [
    "agent memory poisoning", "persistent prompt injection",
    "cross-session context poisoning", "long-term memory poisoning",
  ],
  ASI07_insecure_agent_comms: [
    "agent-to-agent injection", "multi-agent attack chain",
    "orchestrator impersonation",
  ],

  // ── AI-Enabled ────────────────────────────────────────────────────────────────
  AE01_ai_recon: ["AI-assisted reconnaissance", "LLM OSINT", "AI target profiling"],
  AE02_ai_social_engineering: [
    "AI-assisted phishing campaign", "LLM spear phishing", "AI business email compromise",
  ],
  AE03_ai_vuln_research: ["AI-assisted vulnerability discovery", "LLM bug hunting", "autonomous vulnerability research"],
  AE04_ai_exploit_dev: ["AI-assisted exploit development", "LLM exploit generation"],
  AE05_ai_malware_dev: ["AI-generated malware campaign", "LLM polymorphic malware", "AI-assisted ransomware"],
  AE06_ai_evasion_obfuscation: ["AI-assisted evasion", "LLM malware obfuscation"],
  AE07_ai_identity_abuse: ["deepfake fraud", "AI voice cloning fraud", "AI-generated fake identity documents"],
  AE08_ai_attack_orchestration: ["autonomous attack orchestration", "AI-driven cyberattack", "nation-state AI operation"],
  AE09_ai_disinformation: ["AI influence campaign", "AI-generated disinformation", "coordinated inauthentic behavior AI"],
  AE10_ai_deepfake: ["deepfake video", "synthetic media generation", "AI voice deepfake"],
};

/**
 * Detect which landmark topics for a given tag are not covered by any source.
 * @param {string} tagId
 * @param {object[]} sources — objects with .title and .short_summary
 * @returns {string[]} missing topics
 */
export function detectLandmarkGaps(tagId, sources) {
  const expected = LANDMARK_TOPICS[tagId];
  if (!expected || expected.length === 0) return [];
  const covered = new Set();
  for (const src of sources) {
    const text = `${src.title || ""} ${src.short_summary || ""}`.toLowerCase();
    for (const topic of expected) if (text.includes(topic.toLowerCase())) covered.add(topic);
  }
  return expected.filter(t => !covered.has(t));
}

/**
 * Group all sources by tag, then report missing topics per tag.
 * @param {object[]} sources — with .tags[], .title, .short_summary
 * @returns {Object<string,string[]>}
 */
export function detectAllLandmarkGaps(sources) {
  const byTag = {};
  for (const src of sources) for (const tag of (src.tags || [])) {
    (byTag[tag] ||= []).push(src);
  }
  const out = {};
  for (const tagId of Object.keys(LANDMARK_TOPICS)) {
    out[tagId] = detectLandmarkGaps(tagId, byTag[tagId] || []);
  }
  return out;
}

// ── Targeted search directives (NOT blind scraping) ─────────────────────────────

const FRAMEWORK_RE = /\b(langchain|langgraph|mcp|crewai|autogen|flowise|open ?webui|langflow|vllm|ollama|litellm|mlflow|kubeflow|triton|hugging ?face|gguf|safetensors|lora|checkpoint|registry|dependency|sbom|slsa|plugin|adapter|model provenance|model signing)\b/i;
const VENDOR_RE    = /\b(openai|anthropic|microsoft|google|nvidia|deepmind|meta)\b/i;
const OPERATIONAL_RE = /\b(campaign|fraud|deepfake|phishing|ransomware|nation-state|malware|influence|voice cloning|business email|operation)\b/i;

/**
 * Route a single missing topic to the best provider + build a precise query.
 * Providers: arxiv | github_advisory | tavily | serpapi_news
 * @returns {{tag, topic, provider, query, target_source_types, modifiers}}
 */
export function directiveForTopic(tagId, topic) {
  const domain = tagId.slice(0, 3); // TAI | LLM | ASI | AE_
  let provider, target_source_types, modifiers = [];

  if (FRAMEWORK_RE.test(topic)) {
    // framework/artifact/supply-chain topics → advisory + web content
    provider = "github_advisory";
    target_source_types = ["vulnerability", "exploit_disclosure"];
    modifiers = ["CVE", "advisory"];
  } else if (domain === "AE_" || OPERATIONAL_RE.test(topic)) {
    // AI-as-weapon / operational topics → open-web threat intel + news
    provider = "tavily";
    target_source_types = ["incident", "threat_intelligence", "adversary_adoption_signal"];
    modifiers = ["in the wild", "campaign", "report"];
  } else if (VENDOR_RE.test(topic)) {
    provider = "tavily";
    target_source_types = ["vendor_report", "incident"];
    modifiers = ["disclosure", "security research"];
  } else {
    // research topics (TAI/LLM/ASI attack techniques) → arXiv, Scholar breadth
    provider = "arxiv";
    target_source_types = ["research_finding", "capability_demonstration", "exploit_disclosure"];
    modifiers = ["attack"];
  }

  const query = [`"${topic}"`, ...modifiers].join(" ");
  return { tag: tagId, topic, provider, query, target_source_types, modifiers };
}

/**
 * Turn a full gap map into a flat, deduped list of targeted search directives.
 * @param {Object<string,string[]>} gapsByTag — output of detectAllLandmarkGaps
 * @returns {Array} directives
 */
export function buildSearchDirectives(gapsByTag) {
  const directives = [];
  const seen = new Set();
  for (const [tagId, topics] of Object.entries(gapsByTag || {})) {
    for (const topic of topics) {
      const key = topic.toLowerCase();
      if (seen.has(key)) continue;   // a topic can be listed under two tags
      seen.add(key);
      directives.push(directiveForTopic(tagId, topic));
    }
  }
  return directives;
}
