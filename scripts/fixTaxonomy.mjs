import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function up(id, patch, label) {
  const { error } = await sb.from("sources").update(patch).eq("id", id);
  if (error) console.error("FAIL", label, error.message);
  else console.log("OK  ", label);
}

// ── agentic_ai_threats → ai_enabled_threats ───────────────────────────────────
// Attackers are USING AI agents as weapons (AI is the gun held by humans).
// The attack target is human infrastructure, not an AI system.

await up("8a0b157d84a2f843331ce33d5abcd02ab38f",
  { main_category: "ai_enabled_threats", tags: ["AE08_ai_attack_orchestration"] },
  "Sysdig JadePuffer: attackers use AI agent to attack databases");

await up("2ce789548de8308415c1d815ce346296e0af",
  { main_category: "ai_enabled_threats", tags: ["AE08_ai_attack_orchestration"] },
  "SecurityWeek: agentic AI ransomware via Langflow (AI = weapon)");

await up("d30f5fa7c10d0d7d0176bdb1426ad7c9650a",
  { main_category: "ai_enabled_threats", tags: ["AE08_ai_attack_orchestration"] },
  "Hacker News: AI agent automates ransomware attack (AI = weapon)");

await up("ea35fd97668c110bee3c3adbcfc979d76d13",
  { main_category: "ai_enabled_threats", tags: ["AE08_ai_attack_orchestration"] },
  "Check Point: criminals using Claude Code as multi-week operational tool");

await up("066bfd91a5e6ca526639e3993c400fb43f95",
  { main_category: "ai_enabled_threats", tags: ["AE02_ai_social_engineering", "AE06_ai_evasion_obfuscation"] },
  "Trend Micro: abusing claude.ai shared-chat for malvertising delivery");

await up("c96c98bf00ddeae3b035e6a6de59ef04083f",
  { main_category: "ai_enabled_threats", tags: ["AE08_ai_attack_orchestration", "AE04_ai_exploit_dev"] },
  "Red Canary: adversaries weaponising AI CLI tools (Claude Code etc)");

// ── llm_threats → agentic_ai_threats ─────────────────────────────────────────
// MCP is an AGENT protocol. Vulnerabilities in MCP servers, SDKs, and the MCP
// supply chain belong in agentic_ai_threats, not llm_threats.
// LLM03_llm_supply_chain → ASI04_agentic_supply_chain.

await up("f366d70de8c00eb02d682b5dc3d6d6a173c4",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain", "ASI05_unexpected_code_execution"] },
  "OX Security: MCP supply chain RCE in Windsurf (MCP = agentic)");

await up("79b5ec9293d536df7b4d59aefa042610f8bc",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain", "ASI05_unexpected_code_execution"] },
  "Anthropic MCP design vulnerability enabling RCE (MCP = agentic)");

await up("ed038d248b02c1a2c6be61db636110f4bdcf",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "40+ MCP CVEs in 2026 (MCP is an agent protocol)");

await up("baf7aa9081ad94e7b4ab6bd2fadb4b300a24",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain", "ASI05_unexpected_code_execution"] },
  "MCP-Inspector RCE CVE-2025-49596 (MCP toolchain)");

await up("48249a06846348fae64192ae023dab67e93e",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "MCP Security 2026 — four MCP-layer CVEs");

await up("a27bc4bfc8d29a176fa2f6aebbeb5c3e64ba",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "OWASP Agentic Skills Top 10 / ClawHub marketplace poisoning");

await up("90445ee8311efe98c575ad70070414fb9cbf",
  { main_category: "agentic_ai_threats", tags: ["LLM01_prompt_injection", "ASI02_tool_misuse_exploitation"] },
  "SOCFortress: indirect PI via schema objects — explicitly targets AI agents");

await up("be645665b3b3af974bbe50e57a8d9007b1b1",
  { main_category: "agentic_ai_threats", tags: ["LLM01_prompt_injection", "ASI02_tool_misuse_exploitation"] },
  "Unit 42: Fooling AI Agents — web IPI causing agents to take real actions");

await up("c5af68e4eadffc4c33728beb3f40f5d552a0",
  { main_category: "agentic_ai_threats", tags: ["ASI06_memory_context_poisoning", "LLM04_data_model_poisoning"] },
  "RAG poisoning of production AI agents (agentic RAG, not plain LLM)");

// ── ai_enabled_threats → agentic_ai_threats ───────────────────────────────────
// SkillCloak distributes malicious skills on ClawHub to infect agent systems.
// The threat is TO the agentic ecosystem (supply chain), not AI as weapon.

await up("5ab4c1aa49300ecae62dfd79fd50dd8b07fc",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain", "AE06_ai_evasion_obfuscation"] },
  "Unit 42 SkillCloak: malicious agent skills poisoning ClawHub marketplace");

// ── traditional_ai_threats → llm_threats ──────────────────────────────────────
// EchoGram appends adversarial token sequences to bypass LLM safety guardrails.
// The target is LLM safety training (guardrails/RLHF), not a classical ML
// classifier. Token manipulation is the mechanism, but it is a jailbreak —
// TAI03 adversarial evasion is for attacks on non-LLM ML models (image
// classifiers, tabular models, etc.).

await up("665f9243fbc853dacd27774f57a42e0b4e0e",
  { main_category: "llm_threats", tags: ["LLM11_jailbreak_safety_bypass", "LLM01_prompt_injection"] },
  "EchoGram: token-flip LLM guardrail bypass (jailbreak, not classical TAI03)");

// ── agentic_ai_threats → llm_threats ──────────────────────────────────────────
// vLLM is an inference server, not an agent framework. The RCE is in video-input
// parsing in the serving engine. LiteLLM is an AI gateway/proxy — infrastructure,
// not an agent. OWASP LLM05 demo: XSS from unsanitised LLM output, no agent.

await up("5644d6a82fd2d2c3e96998082f2b833a504a",
  { main_category: "llm_threats", tags: ["LLM03_llm_supply_chain"] },
  "vLLM RCE CVE-2026-22778 (inference server, not agent framework)");

await up("ba5c55b4a325572df422f7a3807619e9dcee",
  { main_category: "llm_threats", tags: ["LLM03_llm_supply_chain"] },
  "LiteLLM command injection CVE-2026-42271 (AI gateway, not agent framework)");

await up("534eae9af4c3bca2664d6323e85532d9be48",
  { main_category: "llm_threats", tags: ["LLM05_improper_output_handling"] },
  "OWASP LLM05 XSS demo: LLM output rendered without sanitisation (no agent)");

// ── Demotion to unclear_or_adjacent ───────────────────────────────────────────
// BRICKSTORM is a standard APT backdoor — the Volexity/GTIG reports describe
// traditional C2 malware with no documented AI component in either summary.
// SolarWinds Serv-U CVE is a buffer crash in a file-transfer server.
// Trivy/Checkmarx compromise is a DevSecOps CI/CD supply chain attack.
// Coruna is a traditional iOS exploit kit (no AI mentioned in summary).
// UNC5142 EtherHiding uses blockchain-based C2 (no AI in summary).

await up("618e76847ccb73e9a1116982d4987b6633fd",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "VerdantBamboo/BRICKSTORM: traditional APT backdoor — no AI component");

await up("64544251be238a48315657fe3a465e362063",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "BRICKSTORM v2 UNC5221: traditional backdoor — no AI component");

await up("7295d3105d8b33d8c3bd546b4b1e25fec41a",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "SolarWinds Serv-U DoS: buffer crash in FTP server — no AI");

await up("5adf3b6d586129767ebd7c4a2071715b9595",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "Vect/TeamPCP Trivy+Checkmarx: DevSecOps supply chain — no AI angle");

await up("5e768fe189b85d55eb6e48a79dc9ed5a9dbf",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "Coruna iOS exploit kit: traditional mobile exploits — no AI in summary");

await up("e08440e2db5ab6d34ce73c97d116e7014284",
  { main_category: "unclear_or_adjacent", validation_status: "review", tags: ["adjacent_context"] },
  "UNC5142 EtherHiding: blockchain C2 for info-stealer distribution — no AI");

// ── Tag-only corrections (category already correct) ────────────────────────────
// mcp-remote CVE: already agentic, but LLM05 (output handling) is wrong —
// this is RCE via malicious MCP server = agentic supply chain + code execution.
await up("140ead83c3621b4a1b04f243414d004194e5",
  { tags: ["ASI04_agentic_supply_chain", "ASI05_unexpected_code_execution"] },
  "mcp-remote CVE-2025-6514: fix tag LLM05 -> ASI04+ASI05");

// LangGraph RCE: agentic framework (correct), but LLM05 (output handling) wrong.
await up("3218565acba3e379d7886a3efe2523081323",
  { tags: ["ASI05_unexpected_code_execution"] },
  "LangGraph checkpointer RCE: fix tag LLM05 -> ASI05");

// VulnerableMCP: mcp-server-git chained CVEs → supply chain + RCE.
await up("ebf4853b3127d61eec1ce41879dd6e3187bc",
  { tags: ["ASI04_agentic_supply_chain", "ASI05_unexpected_code_execution"] },
  "VulnerableMCP mcp-server-git: fix tag LLM05 -> ASI04+ASI05");

console.log("\nDone.");
