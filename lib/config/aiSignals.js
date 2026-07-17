/**
 * AI-threat and cyber-threat signal dictionaries + normalization used by
 * hasAiSignal() and assessAiRelevance() in lib/pipeline/validation/aiRelevance.js.
 *
 * Design goal: HIGH RECALL at the deterministic pre-gate, followed by stricter
 * semantic filtering in the LLM relevance call. Many strong AI-security sources
 * never say "AI attack" or "prompt injection" — they name a product (LiteLLM),
 * a model format (safetensors), an agent protocol (MCP), or a technical attack
 * surface. The pre-gate must let those through to the LLM rather than discard
 * them for free.
 *
 * All dictionary entries are stored NORMALIZED (lowercase, hyphens collapsed to
 * spaces, US spelling) so they match text after normalizeText() has run. Keep
 * new entries in the same form — write "ai enabled threat", not "AI-enabled".
 *
 * Tiers / weights (see aiRelevance.js):
 *   AI_SIGNALS.high     = specific AI-threat techniques / attack types (pass alone)
 *   AI_SIGNALS.medium   = broader AI/security field vocabulary
 *   AI_SIGNALS.low      = generic terms (only count paired with a strong cyber signal)
 *   KNOWN_AI_ENTITIES   = products/frameworks/models/formats (pass only when PAIRED)
 *   CYBER_SIGNALS.*     = cyber vulnerability / attack vocabulary
 *   DOWNRANK_SIGNALS    = governance/marketing terms — down-rank when unaccompanied
 */

// ── Acronym / spelling / plural normalization ──────────────────────────────────

// Bidirectional expansion: whenever an acronym appears as a whole word, its
// long form is appended so BOTH the acronym and the expansion match dictionary
// entries (matching is presence-based, so duplication never inflates scores).
const ACRONYM_EXPANSIONS = [
  ["mcp", "model context protocol"],
  ["rag", "retrieval augmented generation"],
  ["a2a", "agent to agent"],
  ["llm", "large language model"],
  ["vlm", "vision language model"],
  ["slm", "small language model"],
  ["genai", "generative ai"],
  ["cot", "chain of thought"],
  ["rlhf", "reinforcement learning from human feedback"],
  ["rlaif", "reinforcement learning from ai feedback"],
  ["rce", "remote code execution"],
  ["lce", "local code execution"],
  ["ssrf", "server side request forgery"],
  ["xss", "cross site scripting"],
  ["ssti", "server side template injection"],
  ["redos", "regular expression denial of service"],
  ["dos", "denial of service"],
  ["ddos", "distributed denial of service"],
  ["c2", "command and control"],
  ["imds", "instance metadata service"],
  ["iam", "identity and access management"],
  ["tgi", "text generation inference"],
  ["tts", "text to speech"],
  ["asr", "automatic speech recognition"],
  ["dnn", "deep neural network"],
  ["cnn", "convolutional neural network"],
  ["gnn", "graph neural network"],
  ["fl", "federated learning"],
  ["dp", "differential privacy"],
  ["lora", "low rank adaptation"],
  ["peft", "parameter efficient fine tuning"],
  ["kev", "known exploited vulnerability"],
  ["poc", "proof of concept"],
];

// UK → US spelling normalization (prefix-based, applied as substring replace).
const SPELLING_NORMALIZE = [
  [/behaviour/g, "behavior"],
  [/organis/g, "organiz"],
  [/authoris/g, "authoriz"],
  [/optimis/g, "optimiz"],
  [/analyse/g, "analyze"],
  [/defence/g, "defense"],
];

// Targeted plural → singular normalization (whole-word, safe subset only —
// deliberately excludes words like "weights"/"series" where stemming corrupts).
const PLURAL_NORMALIZE = [
  ["vulnerabilities", "vulnerability"],
  ["attacks", "attack"],
  ["agents", "agent"],
  ["models", "model"],
  ["checkpoints", "checkpoint"],
  ["credentials", "credential"],
  ["exploits", "exploit"],
  ["plugins", "plugin"],
  ["connectors", "connector"],
  ["skills", "skill"],
  ["injections", "injection"],
  ["deepfakes", "deepfake"],
  ["backdoors", "backdoor"],
  ["instructions", "instruction"],
];

const _acronymRes = ACRONYM_EXPANSIONS.map(([ac, full]) => [
  new RegExp(`\\b${ac}\\b`, "g"),
  `${ac} ${full}`,
]);
const _pluralRes = PLURAL_NORMALIZE.map(([pl, sg]) => [
  new RegExp(`\\b${pl}\\b`, "g"),
  sg,
]);

/**
 * Light normalization: lowercase, strip possessives, collapse hyphens/underscores
 * to spaces, US spelling, whitespace collapse. Does NOT expand acronyms — used for
 * the NOVELTY regexes so proximity windows stay tight.
 */
export function normalizeLight(raw) {
  let t = (raw || "").toLowerCase();
  t = t.replace(/['’]s\b/g, "").replace(/['’]/g, "");
  for (const [re, rep] of SPELLING_NORMALIZE) t = t.replace(re, rep);
  t = t.replace(/(\w)[-_/](\w)/g, "$1 $2");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Full normalization for keyword matching: light normalization + acronym
 * expansion + targeted plural→singular. Applied to both the input text and (once,
 * at load) to every dictionary entry so the two are compared in the same space.
 */
export function normalizeText(raw) {
  let t = normalizeLight(raw);
  for (const [re, rep] of _pluralRes) t = t.replace(re, rep);
  for (const [re, rep] of _acronymRes) t = t.replace(re, rep);
  return t.replace(/\s+/g, " ").trim();
}

// Normalize a dictionary once at load. Acronym expansion is NOT applied to
// entries (they're already canonical); only spelling/hyphen/plural normalization,
// via normalizeLight + plural pass, keeps them aligned with normalizeText output.
function normDict(list) {
  const seen = new Set();
  const out = [];
  for (const term of list) {
    let t = normalizeLight(term);
    for (const [re, rep] of _pluralRes) t = t.replace(re, rep);
    t = t.replace(/\s+/g, " ").trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// ── AI signal dictionaries ─────────────────────────────────────────────────────

export const AI_SIGNALS = {
  // Specific AI-threat techniques and unambiguous attack types. A single hit
  // clears the pre-gate on its own.
  high: normDict([
    // Legacy core
    "prompt injection", "jailbreak", "llm", "large language model", "gpt", "gemini",
    "claude", "adversarial", "ai model", "machine learning attack", "data poisoning",
    "model extraction", "deepfake", "ai agent", "mcp", "agentic", "ai enabled threat",
    "ai powered attack", "ai safety", "ai security", "model backdoor", "rag poisoning",
    "model context protocol", "synthetic media", "voice cloning", "ai malware",
    "ai phishing", "training data poisoning", "model inversion", "foundation model attack",
    "embedding attack", "agent hijacking", "tool poisoning", "llm vulnerability",

    // Prompt / context / retrieval attacks
    "indirect prompt injection", "direct prompt injection", "prompt injection attack",
    "prompt manipulation", "prompt leakage", "prompt extraction", "prompt exfiltration",
    "promptware", "jailbreak attack", "guardrail bypass", "safety bypass", "refusal bypass",
    "adversarial suffix", "many shot jailbreak", "system prompt leakage",
    "context poisoning", "context injection", "retrieval poisoning", "retrieval manipulation",
    "rag attack", "rag vulnerability", "vector poisoning", "vector store poisoning",
    "embedding inversion", "embedding leakage", "embedding manipulation",
    "semantic injection", "semantic poisoning",

    // Model tampering / poisoning / artifact attacks
    "model poisoning", "fine tuning poisoning", "alignment poisoning",
    "synthetic data poisoning", "backdoored model", "poisoned model", "trojan model",
    "model trojan", "model artifact attack", "malicious model", "malicious checkpoint",
    "model loading attack", "model loading rce", "unsafe deserialization",
    "model deserialization", "model serialization attack", "model format vulnerability",
    "model hub compromise", "model supply chain", "ai supply chain", "llm supply chain",
    "agent supply chain",

    // Model theft / extraction / privacy
    "model extraction attack", "model stealing", "model theft", "capability extraction",
    "capability stealing", "model cloning", "black box extraction",
    "model distillation attack", "unauthorized distillation", "membership inference",
    "property inference", "training data extraction", "training data leakage",
    "gradient inversion", "gradient leakage", "federated learning attack",
    "split learning attack",

    // Traditional adversarial ML
    "adversarial example", "adversarial evasion", "evasion attack",
    "adversarial perturbation", "clean label poisoning", "backdoor trigger",
    "watermark removal", "watermark evasion", "watermark attack", "semantic watermark",
    "provenance evasion",

    // Alignment / oversight failures
    "model misalignment", "emergent misalignment", "deceptive alignment", "scheming",
    "reward hacking", "specification gaming", "alignment faking", "model sabotage",
    "oversight evasion", "chain of thought monitoring", "cot monitoring",
    "obfuscated reward hacking", "subliminal learning", "behavioral transfer",
    "behavioral contagion",

    // Agentic attacks
    "agent goal hijacking", "agent goal manipulation", "tool misuse", "tool abuse",
    "tool call abuse", "tool call injection", "tool invocation attack",
    "tool invocation hijacking", "function call abuse", "function calling attack",
    "malicious tool", "poisoned tool", "tool description poisoning",
    "tool metadata poisoning", "skill poisoning", "malicious skill", "poisoned skill",
    "skill registry attack", "skill marketplace attack", "malicious connector",
    "poisoned connector", "malicious plugin", "compromised plugin", "rogue plugin",
    "hostile mcp server", "malicious mcp server", "mcp poisoning", "mcp injection",
    "mcp attack", "mcp exploit", "mcp tool poisoning", "mcp rug pull", "mcp shadowing",
    "mcp server compromise", "agent memory poisoning", "memory poisoning",
    "persistent prompt injection", "cross session poisoning", "agent identity abuse",
    "agent privilege abuse", "confused deputy", "delegated authority abuse",
    "excessive agency", "rogue agent", "shadow agent", "multi agent attack",
    "cross agent attack", "agent to agent attack", "a2a attack",
    "agent communication attack", "agent cascade", "cascading agent failure",
    "autonomous code execution", "agentic code execution", "agent sandbox escape",
    "agent runtime compromise", "agent orchestration attack", "agent framework vulnerability",
    "coding agent vulnerability", "browser agent attack", "computer use attack",
    "autonomous agent attack", "agentic botnet",

    // AI-enabled threats
    "ai generated malware", "llm generated malware", "ai assisted malware",
    "ai generated phishing", "ai assisted phishing", "ai spear phishing",
    "ai social engineering", "ai enabled fraud", "deepfake scam", "deepfake extortion",
    "deepfake impersonation", "voice cloning scam", "synthetic identity fraud",
    "synthetic media fraud", "ai impersonation", "ai assisted intrusion",
    "ai enabled intrusion", "autonomous cyberattack", "autonomous attack agent",
    "offensive ai", "adversarial ai use", "ai cyber operations",
    "ai enabled cyber operations", "ai tradecraft", "nation state ai use",
    "llm as c2", "ai as c2", "ai generated exploit", "ai assisted exploitation",
    "ai reconnaissance", "automated reconnaissance", "ai vulnerability discovery",
    "ai generated exploit code", "deepfake phishing", "voice deepfake",
    "real time deepfake", "synthetic persona", "ai enabled disinformation",
    "ai generated disinformation", "automated influence operation",

    // AI-security field terms strong enough to pass alone
    "adversarial machine learning", "machine learning security", "ml security",
    "llm application security", "genai security", "ai red teaming", "ai red team",
  ]),

  // Broader AI/security field vocabulary. Two hits, or one hit + a strong cyber
  // signal, clears the pre-gate.
  medium: normDict([
    "artificial intelligence", "generative ai", "foundation model", "neural network",
    "ai system", "ai tool", "ai generated", "ai chatbot", "language model",
    "machine learning", "ml model", "ai risk",
    // New broad AI terminology
    "generative model", "frontier model", "reasoning model", "reasoning ai",
    "multimodal ai", "multimodal system", "vision model", "image generation model",
    "text to image", "text to speech", "speech synthesis", "synthetic voice",
    "voice synthesis", "ai assistant", "virtual assistant", "ai copilot",
    "ai application", "ai workload", "ai infrastructure", "ml infrastructure",
    "model serving", "model inference", "inference pipeline", "training pipeline",
    "fine tuning", "reinforcement learning", "rlhf", "rlaif", "synthetic data",
    "training corpus", "model deployment", "ai deployment", "model evaluation",
    "ai benchmark", "red teaming ai", "model monitoring", "model provenance",
    "ai provenance", "content provenance", "ai watermark", "model governance",
    "model risk", "ai assurance", "ai incident", "ai vulnerability", "ai advisory",
    "ai threat intelligence", "ai security research", "model integrity",
    "inference security", "agent security", "agentic security",
    "ai application security", "aml security",
  ]),

  // Generic terms — only count when paired with a strong cyber signal (recall hedge).
  low: normDict([
    "ai", "automation", "algorithm", "predictive", "intelligent system",
  ]),
};

// ── Known AI products / frameworks / models / formats ──────────────────────────
// These do NOT pass the pre-gate alone (a bare "we use LangChain" is not a threat
// source). They clear the gate only when PAIRED with a cyber/exec/supply-chain
// signal — see hasAiSignal() rules and the pair-bonus scoring in assessAiRelevance().
export const KNOWN_AI_ENTITIES = normDict([
  // Inference / gateway / serving
  "litellm", "vllm", "lmdeploy", "sglang", "ollama", "llama.cpp",
  "text generation inference", "tgi", "triton inference server", "nvidia triton",
  "openwebui", "open webui", "anythingllm", "localai", "ray serve", "bentoml",
  "torchserve", "model gateway", "ai gateway", "llm gateway", "inference gateway",
  "model router", "inference server", "model server", "serving framework",
  // Agent frameworks / orchestration
  "langchain", "langgraph", "llamaindex", "llama index", "semantic kernel", "autogen",
  "autogen studio", "crewai", "crew ai", "mastra", "openhands", "open hands",
  "camel ai", "smolagents", "pydanticai", "pydantic ai", "agno", "phidata", "haystack",
  "dspy", "flowise", "langflow", "n8n", "agentcore", "bedrock agentcore",
  "copilot studio", "vertex ai agent builder", "agent development kit", "google adk",
  "agent framework", "agent runtime", "agent orchestration", "agent platform",
  "multi agent framework", "agent marketplace", "skill marketplace", "tool registry",
  "plugin registry",
  // Coding assistants / agents
  "github copilot", "copilot", "cursor", "windsurf", "claude code", "openai codex",
  "codex cli", "gemini cli", "amazon q developer", "replit agent", "devin", "manus",
  "aider", "cline", "roo code", "continue.dev", "sourcegraph cody", "tabnine",
  "lovable", "bolt.new", "copilot coding agent", "ai coding assistant", "coding agent",
  // Model / API ecosystems
  "openai", "anthropic", "google deepmind", "gemini api", "claude api", "openai api",
  "azure openai", "amazon bedrock", "vertex ai", "mistral ai", "cohere",
  "huggingface", "hugging face", "modelscope", "replicate", "together ai", "groq",
  "fireworks ai", "cerebras inference", "deepseek", "qwen", "llama model",
  "mistral model", "phi model", "gemma", "command r", "stable diffusion", "flux model",
  "diffusion model", "vision language model", "vlm", "multimodal model",
  // Model formats / libraries
  "safetensors", "gguf", "ggml", "onnx", "tensorrt", "pytorch", "tensorflow", "keras",
  "scikit learn", "sklearn", "pickle", "joblib", "torch.load", "hydra instantiate",
  "hydra.utils.instantiate", "model checkpoint", "checkpoint file", "model weights",
  "adapter", "lora", "qlora", "peft", "quantized model", "quantization",
  "model metadata", "config.json", "model card", "dataset card", "model repository",
  "model registry", "model hub", "checkpoint repository",
  // RAG / memory / vector
  "rag", "retrieval augmented generation", "vector database", "vector db",
  "vector store", "embedding store", "embedding database", "semantic search",
  "reranker", "reranking", "chroma", "chromadb", "pinecone", "weaviate", "milvus",
  "qdrant", "pgvector", "faiss", "elasticsearch vector", "opensearch vector",
  "graphrag", "graph rag", "mem0", "agent memory", "long term memory",
  "context store", "semantic cache", "retrieval pipeline",
  // Agent protocols / capabilities
  "model context protocol", "mcp", "mcp server", "mcp client", "mcp host", "mcp tool",
  "mcp registry", "mcp marketplace", "agent to agent", "a2a protocol", "a2a",
  "tool calling", "function calling", "computer use", "browser use", "web agent",
  "tool descriptor", "tool description", "tool manifest", "agent skill", "skill.md",
  "skill file", "plugin manifest", "connector", "action connector", "agent handoff",
  "sub agent", "subagent", "supervisor agent", "planner agent", "executor agent",
  "reflection agent", "crawl4ai",
]);

// ── Cyber signal dictionaries ──────────────────────────────────────────────────

export const CYBER_SIGNALS = {
  high: normDict([
    // Legacy
    "vulnerability", "cve", "exploit", "malware", "ransomware", "threat actor",
    "apt", "zero day", "0 day", "data breach", "attack campaign", "ioc",
    "indicators of compromise", "command and control", "c2", "ttps",
    "remote code execution", "rce", "privilege escalation", "lateral movement",
    "phishing", "social engineering", "supply chain attack", "backdoor",
    // Injection / web
    "command injection", "code injection", "sql injection", "nosql injection",
    "prompt to sql injection", "path traversal", "directory traversal",
    "arbitrary file write", "arbitrary file read", "file overwrite",
    "server side request forgery", "ssrf", "cross site scripting", "xss",
    "template injection", "ssti", "deserialization", "unsafe deserialization",
    // Auth / access
    "authentication bypass", "authorization bypass", "access control bypass",
    "improper access control", "broken access control", "arbitrary code execution",
    "local code execution", "unauthenticated rce", "pre auth rce", "pre authentication",
    "sandbox escape", "container escape",
    // Secrets / identity
    "secret exposure", "credential exposure", "credential theft", "credential harvesting",
    "api key theft", "token theft", "oauth token theft", "jwt theft", "session hijacking",
    "account takeover", "identity theft", "privilege abuse", "confused deputy",
    // Supply chain
    "namespace hijacking", "dependency confusion", "typosquatting", "package poisoning",
    "malicious package", "compromised package", "registry compromise",
    "repository compromise", "maintainer compromise", "contributor account compromise",
    "cicd compromise", "ci cd compromise", "build pipeline compromise",
    "malicious dependency", "poisoned dependency", "supply chain compromise",
    "software supply chain", "plugin compromise", "extension compromise",
    "marketplace abuse",
    // Malware / persistence
    "persistence", "systemd backdoor", "web shell", "infostealer",
    "information stealer", "stealer malware", "crypto miner", "cryptominer",
    // DoS
    "denial of service", "dos", "distributed denial of service", "ddos",
    "resource exhaustion", "cpu exhaustion", "memory exhaustion", "redos",
    "regular expression denial of service", "denial of wallet",
    // Data / exfiltration
    "data poisoning attack", "data destruction", "data tampering", "database deletion",
    "destructive attack", "exfiltration", "data theft", "secret exfiltration",
    "internal reconnaissance", "cloud metadata", "instance metadata service", "imds",
    "network pivoting", "credential reuse", "blast radius",
    // Exploitation state
    "active exploitation", "exploited in the wild", "known exploited vulnerability",
    "kev", "proof of concept", "poc", "exploit chain", "attack chain",
    "post exploitation",
  ]),
  medium: normDict([
    "cybersecurity", "security vulnerability", "security advisory", "patch",
    "mitigation", "threat intelligence", "incident response", "soc", "siem",
    "penetration testing", "red team", "blue team", "security research",
    "disclosure", "security incident", "data exfiltration",
    // New
    "security flaw", "critical flaw", "high severity flaw", "vulnerability disclosure",
    "coordinated disclosure", "responsible disclosure", "affected versions",
    "vulnerable versions", "fixed version", "security fix", "remediation", "workaround",
    "detection guidance", "security bulletin", "psirt", "security update",
    "github advisory", "ghsa", "nvd", "cisa kev", "vendor advisory", "security patch",
    "threat campaign", "intrusion campaign", "malicious activity", "exploitation attempt",
    "attack attempt", "victim", "target organization", "affected organization",
    "compromise", "compromised environment", "exposed endpoint", "internet exposed",
    "publicly exposed", "unauthenticated endpoint", "malicious payload",
    "payload execution", "command execution", "shell execution",
    "lateral movement toolkit", "persistence mechanism", "attack surface",
    "trust boundary", "control plane", "data plane", "privilege boundary",
    "authentication logic", "authorization logic", "supply chain risk",
    "software dependency", "third party dependency", "open source package",
    "package registry", "extension marketplace", "plugin marketplace",
    "developer tooling", "cloud environment", "kubernetes cluster",
    "service account token", "cloud credential", "api credential", "provider credential",
    "environment variable", "secret management",
  ]),
  low: normDict([
    "security", "risk", "attack", "defense", "hacking", "breach",
  ]),
};

// ── Pair-scoring signal groups ─────────────────────────────────────────────────
// Subsets used by hasAiSignal() routing and assessAiRelevance() pair bonuses.
// Keeping them explicit (rather than deriving from the tiered dicts) makes the
// pairing rules auditable.

// Model-specific artifact tokens only. Deliberately EXCLUDES generic words like
// "adapter"/"artifact" that pair with any RCE (network adapter, build artifact).
export const MODEL_ARTIFACT_SIGNALS = normDict([
  "model", "checkpoint", "model weights", "lora", "safetensors",
  "gguf", "ggml", "onnx", "tensorrt", "pickle", "joblib", "torch.load",
  "model metadata", "config.json", "model card", "model hub", "model repository",
  "model registry", "model loading", "model serialization", "model deserialization",
]);

export const CODE_EXECUTION_SIGNALS = normDict([
  "remote code execution", "rce", "arbitrary code execution", "arbitrary code",
  "code execution", "local code execution", "unauthenticated rce", "payload",
  "unsafe deserialization", "deserialization", "sandbox escape", "container escape",
  "command injection", "command execution", "shell execution", "os.system",
  "subprocess", "eval(", "builtins.exec",
]);

export const TAMPER_SIGNALS = normDict([
  "poison", "poisoned", "poisoning", "backdoor", "backdoored", "trojan",
  "trojanized", "malicious", "compromised", "tampered", "rug pull", "rogue",
]);

// AI-agent-specific ecosystem tokens only. Bare "agent"/"tool"/"registry"/
// "namespace" are excluded — they match "user agent", "Windows registry", "k8s
// namespace". The explicit "malicious plugin"/"poisoned tool"/"malicious skill"
// forms already live in AI_SIGNALS.high and clear the gate on their own.
export const AGENT_ECOSYSTEM_SIGNALS = normDict([
  "ai agent", "llm agent", "coding agent", "browser agent", "agentic",
  "mcp", "mcp server", "mcp tool", "model context protocol",
  "tool description", "tool metadata", "tool manifest", "agent skill",
  "skill file", "skill.md", "plugin manifest", "sub agent", "subagent",
  "multi agent", "a2a", "agent to agent",
]);

export const SUPPLY_CHAIN_SIGNALS = normDict([
  "supply chain", "dependency confusion", "typosquatting", "namespace hijacking",
  "package poisoning", "malicious package", "compromised package", "malicious dependency",
  "poisoned dependency", "registry compromise", "repository compromise",
  "maintainer compromise", "marketplace abuse", "software supply chain",
  "model supply chain", "ai supply chain", "agent supply chain",
]);

// ── Down-rank (governance / marketing) signals ─────────────────────────────────
// Presence alone must NOT drive ingestion. When a source matches ONLY these and
// carries no cyber/attack/entity-pair signal, the pre-gate stays closed and the
// deterministic score is capped. Paired with a real threat signal they're ignored.
export const DOWNRANK_SIGNALS = normDict([
  "responsible ai", "ai ethics", "ai policy", "ai regulation", "ai act",
  "ai strategy", "ai adoption", "ai transformation", "ai productivity",
  "ai market growth", "ai investment", "ai funding", "ai product launch",
  "how to use ai", "ai tutorial", "prompt engineering guide", "ai career",
  "ai conference", "ai course", "ai governance",
]);

// ── Trusted AI-security publishers (pre-gate bypass) ───────────────────────────
// Sources from these publishers route straight to LLM relevance review regardless
// of keyword hits — their entire output is in-scope enough to warrant a look.
// Matched case-insensitively as substrings of source.publisher.
export const TRUSTED_AI_SECURITY_PUBLISHERS = [
  "mitre atlas", "nist", "cisa", "ncsc", "enisa", "ai security institute",
  "ai safety institute", "caisi", "google threat intelligence", "google deepmind",
  "microsoft security", "microsoft ai red team", "openai", "anthropic", "meta ai",
  "nvidia security", "hugging face security", "unit 42", "hiddenlayer", "protect ai",
  "trail of bits", "jfrog", "wiz research", "endor labs", "socket", "snyk",
  "reversinglabs", "checkmarx", "sysdig", "crowdstrike", "mandiant", "sentinelone",
  "cisco talos", "trend micro", "sophos x-ops", "sophos x ops", "elastic security labs",
  "datadog security", "tenable research", "rapid7", "github security lab",
  "gitlab security", "owasp genai", "cloud security alliance", "ai incident database",
  "mlcommons", "palo alto",
].map((p) => p.toLowerCase());

/**
 * True when the source publisher is a trusted AI-security entity whose output
 * warrants an LLM look even without keyword hits.
 */
export function isTrustedAiSecurityPublisher(source) {
  const pub = (source?.publisher || "").toLowerCase();
  if (!pub) return false;
  return TRUSTED_AI_SECURITY_PUBLISHERS.some((p) => pub.includes(p));
}

/**
 * Regex patterns for emerging AI-security techniques that may not use standard
 * AI-threat vocabulary. A match bypasses the keyword pre-gate and routes the
 * source to LLM confirmation. Patterns run against normalizeLight() text.
 */
export const NOVELTY_SIGNAL_PATTERNS = [
  // Legacy — autonomous system/agent + tool use + security boundary
  /autonomous\s+(?:system|agent).{0,80}(?:tool\s+use|security\s+boundary|access\s+control)/i,
  /(?:tool\s+use|function\s+call).{0,80}(?:autonomous|security\s+boundary|privilege)/i,
  /(?:model|service)\s+integration.{0,80}(?:exploit|abuse|compromise|attack)/i,
  /(?:exploit|abuse|compromise).{0,80}(?:model|service)\s+integration/i,
  /(?:identity|media)\s+synthesis.{0,80}(?:fraud|deception|scam|impersonation)/i,
  /synthetic\s+(?:identity|media|voice|face).{0,80}(?:fraud|deception|impersonation)/i,
  /workflow\s+automation.{0,80}(?:credential|data\s+access|system\s+access|exfiltrat)/i,
  /(?:agent|tool|plugin|memory|rag|mcp|browser|computer\s+use).{0,60}(?:misuse|failure|exploit|attack|abuse|compromise|hijack)/i,
  /(?:misuse|attack|exploit|abuse).{0,60}(?:agent|plugin|memory|rag|mcp|browser|computer\s+use)/i,

  // Model artifact execution
  /(?:model|checkpoint|weights|artifact|adapter|lora|safetensors|gguf|onnx|tensorrt).{0,100}(?:execute|execution|rce|payload|malicious code|arbitrary code)/i,
  /(?:load|loading|restore|deserialize|deserializ|instantiate).{0,100}(?:model|checkpoint|weights|metadata|config).{0,100}(?:execute|rce|code|payload)/i,
  /(?:metadata|config(?:uration)?).{0,80}(?:builtins\.exec|eval\(|os\.system|subprocess|callable|instantiate)/i,

  // Prompt injection without exact terminology
  /(?:hidden|embedded|invisible|concealed|malicious).{0,80}(?:instruction|directive|prompt|text).{0,80}(?:agent|assistant|model|copilot)/i,
  /(?:agent|assistant|model|copilot).{0,80}(?:follows|executes|obeys|processes).{0,80}(?:hidden|embedded|malicious|attacker controlled).{0,80}(?:instruction|content|text)/i,
  /(?:webpage|website|email|document|resume|pdf|image|tool response|retrieved content).{0,100}(?:instruction|prompt).{0,100}(?:agent|model|assistant)/i,

  // Model theft / distillation
  /(?:extract|steal|clone|replicate|distill|distillation).{0,100}(?:model|capabilit|behavior|reasoning|weights|outputs)/i,
  /(?:millions?|thousands?).{0,40}(?:queries|requests|accounts).{0,100}(?:distill|extract|replicate|train another model)/i,

  // Malicious agent ecosystem
  /(?:plugin|skill|connector|extension|mcp server|tool).{0,100}(?:malicious|poisoned|backdoored|trojanized|compromised|rogue)/i,
  /(?:marketplace|registry|repository|namespace|scope).{0,100}(?:plugin|skill|tool|connector|mcp).{0,100}(?:malicious|squat|hijack|poison|impersonat)/i,
  /(?:tool description|tool metadata|manifest|skill\.md|plugin manifest).{0,100}(?:poison|hidden instruction|malicious|hijack)/i,

  // Agent action / authority
  /(?:agent|assistant|copilot).{0,100}(?:send|delete|write|execute|transfer|pay|purchase|email|upload|download|exfiltrat)/i,
  /(?:delegated|oauth|token|credential|permission|scope|identity).{0,100}(?:agent|assistant|copilot).{0,100}(?:abuse|steal|escalat|impersonat|confused deputy)/i,
  /(?:agent|planner|orchestrator|sub agent|supervisor).{0,100}(?:goal|objective|plan|reasoning).{0,100}(?:hijack|redirect|manipulat|subvert)/i,

  // Memory / multi-agent
  /(?:agent memory|long term memory|persistent memory|context store|scratchpad).{0,100}(?:poison|inject|corrupt|manipulat)/i,
  /(?:multi agent|agent to agent|a2a|orchestrator).{0,100}(?:poison|attack|impersonat|cascade|propagat|compromise)/i,
  /(?:one agent|compromised agent).{0,100}(?:another agent|downstream agent|multi agent).{0,100}(?:trust|propagat|execute|fail)/i,

  // AI-enabled threats
  /(?:ai|llm|generative ai).{0,80}(?:generated|assisted|automated).{0,80}(?:malware|phishing|exploit|reconnaissance|social engineering|intrusion)/i,
  /(?:deepfake|voice clone|synthetic voice|synthetic identity).{0,80}(?:fraud|ransom|kidnap|impersonat|scam|payment)/i,
  /(?:threat actor|apt|ransomware group|nation state).{0,100}(?:used|leveraged|deployed).{0,100}(?:chatgpt|claude|gemini|llm|ai model|generative ai)/i,
  /(?:llm|ai agent|chatbot).{0,100}(?:command and control|c2|payload generation|malware generation|phishing generation)/i,

  // Traditional AI attacks
  /(?:adversarial|semantic|imperceptible).{0,80}(?:perturbation|example|evasion|attack).{0,80}(?:classifier|detector|model|watermark)/i,
  /(?:training data|dataset|fine tuning data|synthetic data).{0,100}(?:poison|backdoor|manipulat|corrupt)/i,
  /(?:membership|property|attribute).{0,40}(?:inference|reconstruction).{0,80}(?:model|training data|dataset)/i,
  /(?:federated learning|split learning|distributed training).{0,100}(?:poison|backdoor|gradient|attack|evasion)/i,
  /(?:watermark|provenance|detector).{0,100}(?:remove|break|bypass|evade|forge|misclassif)/i,

  // AI infrastructure vulnerabilities
  /(?:inference server|model server|ai gateway|llm gateway|vector database|embedding store|model loader).{0,100}(?:vulnerability|cve|rce|ssrf|sql injection|auth bypass|path traversal)/i,
  /(?:litellm|vllm|lmdeploy|ollama|langchain|langflow|flowise|openwebui|crawl4ai).{0,100}(?:cve|vulnerability|exploit|rce|ssrf|injection|credential)/i,
];
