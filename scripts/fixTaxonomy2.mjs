import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Resolve a source by a unique title substring, guarded by its CURRENT category
// (so we never touch the wrong digest sibling), then apply the patch.
async function fixByTitle(titleLike, fromCat, patch, label) {
  const { data, error } = await sb
    .from("sources")
    .select("id, title, main_category")
    .ilike("title", titleLike)
    .eq("main_category", fromCat);
  if (error) { console.error("QUERY FAIL", label, error.message); return; }
  if (!data.length) { console.error("NO MATCH", label, "(", titleLike, "/", fromCat, ")"); return; }
  if (data.length > 1) { console.error("AMBIGUOUS", label, "->", data.length, "rows:", data.map(d => d.id.slice(0,10))); return; }
  const { error: uErr } = await sb.from("sources").update(patch).eq("id", data[0].id);
  if (uErr) console.error("UPDATE FAIL", label, uErr.message);
  else console.log("OK  ", data[0].id.slice(0,12), "|", label);
}

// ── llm_threats → agentic_ai_threats (MCP / agent-skill supply chain) ──────────
// MCP is an agent protocol; agent-skill marketplaces (ClawHub/OpenClaw) are
// agentic infrastructure. These are supply-chain attacks ON agent systems, so
// they belong in agentic_ai_threats with ASI04_agentic_supply_chain, not
// llm_threats with LLM03_llm_supply_chain.

await fixByTitle("Malicious OpenClaw Skill Packages Lead to Code Execution%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "Malicious OpenClaw skill packages (agent marketplace supply chain)");

await fixByTitle("Fake AI Skill Hijacks Agents via Supply Chain%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "Fake AI skill hijacks 26k agents (agentic supply chain)");

await fixByTitle("What OpenClaw reveals about agentic AI security risks%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "IBM X-Force: OpenClaw agent-skill supply chain");

await fixByTitle("Tool Poisoning, Tool Shadowing, and Rugpull%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "Postmark MCP server tool poisoning (agentic supply chain)");

await fixByTitle("MCP Tool Poisoning: Enterprise AI Agent Security%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "MCP tool poisoning enterprise (agentic)");

await fixByTitle("MCP Security Crisis: Systemic Design Flaws%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "MCP security crisis systemic flaws (agentic infra)");

await fixByTitle("repomix: attach_packed_output can bypass file-read%", "llm_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI02_tool_misuse_exploitation", "LLM02_sensitive_info_disclosure"] },
  "repomix MCP server file-read bypass -> agent exfiltration");

// ── agentic_ai_threats → llm_threats (no real agent; plain LLM output/jailbreak)
// SQL injection through LLM output is improper output handling of a plain LLM —
// there is no agent taking autonomous tool actions. BioShocking is a jailbreak /
// guardrail-bypass technique; its three sibling articles (rows 308/315/318) are
// all llm_threats/LLM11, and the mechanism is safety-guardrail bypass, so this
// one should match.

await fixByTitle("Insecure Output Handling: SQL Injection Through LLM Output%", "agentic_ai_threats",
  { main_category: "llm_threats", tags: ["LLM05_improper_output_handling"] },
  "SQL injection via LLM output (no agent -> llm_threats)");

await fixByTitle("BioShocking AI Bypasses Agentic Browser Guardrails%", "agentic_ai_threats",
  { main_category: "llm_threats", tags: ["LLM11_jailbreak_safety_bypass", "LLM01_prompt_injection"] },
  "BioShocking guardrail bypass (jailbreak -> llm_threats, matches siblings)");

// ── traditional_ai_threats → ai_enabled_threats (AI as the weapon) ─────────────
// An AI-GENERATED malicious npm package: the AI is the weapon used to author
// malware; the target is developers' files, not an ML model. TAI10 (supply-chain
// compromise OF AI models) is the wrong axis entirely.

await fixByTitle("Malicious AI-generated npm package steals developer files%", "traditional_ai_threats",
  { main_category: "ai_enabled_threats", tags: ["AE05_ai_malware_dev"] },
  "AI-generated malicious npm package (AI = weapon -> ai_enabled)");

// ── Tag-only: agentic category correct, but LLM05 mistag on MCP-RCE ─────────────
// MCP auto-execution leading to arbitrary command execution in a coding agent is
// ASI05_unexpected_code_execution via the agent, not LLM05 output handling.

await fixByTitle("MCP Auto-Execution in Claude Code (CVE-2026-21852)%", "agentic_ai_threats",
  { tags: ["ASI05_unexpected_code_execution", "LLM01_prompt_injection"] },
  "MCP auto-exec Claude Code: fix tag LLM05 -> ASI05");

await fixByTitle("MCP Auto-Execution in Cursor (CVE-2025-54136)%", "agentic_ai_threats",
  { tags: ["ASI05_unexpected_code_execution", "LLM01_prompt_injection"] },
  "MCP auto-exec Cursor: fix tag LLM05 -> ASI05");

console.log("\nDone.");
