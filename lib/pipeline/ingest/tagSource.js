// Lightweight pre-classification pass applied before storage.
// Only assigns context tags and a handful of unambiguous threat signals.
// Full classification (LLM) runs later and replaces these tags.
const QUICK_RULES = [
  // Unambiguous threat signals — enough keyword evidence to be confident
  { tag: "prompt_injection",      phrases: ["prompt injection", "indirect prompt injection"] },
  { tag: "jailbreak",             phrases: ["jailbreak", "jailbreaking", "dan attack", "many-shot jailbreak"] },
  { tag: "rag_attack",            phrases: ["rag poisoning", "retrieval poisoning", "vector database poisoning"] },
  { tag: "mcp_exploitation",      phrases: ["model context protocol", "mcp server", "mcp vulnerability", "mcp exploit"] },
  { tag: "data_poisoning",        phrases: ["data poisoning", "poisoned training data", "clean-label attack"] },
  { tag: "model_backdoor",        phrases: ["model backdoor", "trojaned model", "neural backdoor", "hidden trigger"] },
  { tag: "adversarial_examples",  phrases: ["adversarial example", "adversarial input", "evasion attack"] },
  { tag: "ml_supply_chain",       phrases: ["hugging face", "huggingface model", "malicious model file", "pickle exploit"] },
  { tag: "deepfake",              phrases: ["deepfake", "face swap", "synthetic face"] },
  { tag: "voice_cloning",         phrases: ["voice cloning", "audio deepfake", "voice spoofing"] },
  { tag: "ai_generated_phishing", phrases: ["ai phishing", "ai-generated phishing", "llm phishing", "ai spear phishing"] },
  { tag: "ai_generated_malware",  phrases: ["ai-generated malware", "wormgpt", "darkgpt", "fraudgpt", "llm malware"] },
  { tag: "ai_disinformation",     phrases: ["ai disinformation", "ai influence operation", "synthetic propaganda"] },
  { tag: "agent_hijacking",       phrases: ["agent hijacking", "goal hijacking", "agentic ai attack"] },
  { tag: "coding_agent_risk",     phrases: ["claude code", "github copilot", "cursor vulnerability", "ai coding assistant"] },

  // Operational context tags
  { tag: "actively_exploited",    phrases: ["actively exploited", "exploited in the wild", "zero-day exploit"] },
  { tag: "proof_of_concept",      phrases: ["proof of concept", "proof-of-concept", "exploit code released"] },
  { tag: "vulnerability",         phrases: ["security vulnerability", "security flaw", "security bug", "patch tuesday", "security advisory"] },
  { tag: "cve",                   phrases: ["cve-"] },
  { tag: "supply_chain",          phrases: ["supply chain attack", "supply chain compromise", "malicious npm", "malicious pypi"] },
  { tag: "critical_infrastructure", phrases: ["critical infrastructure", "ics security", "scada", "industrial control"] },
  { tag: "nation_state",          phrases: ["nation-state", "nation state actor", "state-sponsored", "apt group"] },
  { tag: "research",              phrases: ["arxiv", "research paper", "academic paper", "ieee", "usenix security"] },
];

export function inferSourceTags(source) {
  const text = `${source.title || ""} ${source.summary || ""} ${source.full_text || ""}`.toLowerCase();
  const tags = new Set();

  for (const rule of QUICK_RULES) {
    if (rule.phrases.some((p) => text.includes(p))) {
      tags.add(rule.tag);
    }
  }

  return [...tags];
}

export function attachInitialTags(sources) {
  return sources.map((source) => ({
    ...source,
    // Write to primary_tags (pre-classification signals) not tags (canonical taxonomy column).
    // The tags column is owned by L4 classify; writing here caused free-form strings to
    // persist on discarded sources because the discard writeback never cleared them.
    primary_tags: inferSourceTags(source),
  }));
}
