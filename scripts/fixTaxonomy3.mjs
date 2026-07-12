import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fixByTitle(titleLike, fromCat, patch, label) {
  const { data, error } = await sb
    .from("sources")
    .select("id, title, main_category")
    .ilike("title", titleLike)
    .eq("main_category", fromCat);
  if (error) { console.error("QUERY FAIL", label, error.message); return; }
  if (!data.length) { console.error("NO MATCH", label); return; }
  if (data.length > 1) { console.error("AMBIGUOUS", label, "->", data.map(d => d.id.slice(0,10))); return; }
  const { error: uErr } = await sb.from("sources").update(patch).eq("id", data[0].id);
  if (uErr) console.error("UPDATE FAIL", label, uErr.message);
  else console.log("OK  ", data[0].id.slice(0,12), "|", label);
}

// ── traditional_ai_threats → llm_threats ──────────────────────────────────────
// The llama_index ArxivReader hash-collision CVE is a RAG-ingestion data-integrity
// bug in LlamaIndex — an LLM/RAG orchestration framework, not a traditional ML
// model/system. Its near-identical sibling (LlamaIndex DocugamiReader hash
// collision) is correctly llm_threats/LLM04, so align this one to match.

await fixByTitle("CVE-2025-3044: A vulnerability in the ArxivReader class%", "traditional_ai_threats",
  { main_category: "llm_threats", tags: ["LLM04_data_model_poisoning"] },
  "llama_index ArxivReader hash collision (LLM/RAG framework -> llm_threats)");

// ── traditional_ai_threats → agentic_ai_threats ───────────────────────────────
// Microsoft APM is a dependency manager FOR AI AGENTS; the symlink attack
// compromises AI-agent dependencies. That is an agentic supply-chain compromise
// (ASI04), not a traditional ML-model supply-chain issue (TAI10).

await fixByTitle("CVE-2026-45539: Microsoft APM is an open-source%", "traditional_ai_threats",
  { main_category: "agentic_ai_threats", tags: ["ASI04_agentic_supply_chain"] },
  "Microsoft APM AI-agent dependency manager symlink attack (agentic supply chain)");

console.log("\nDone.");
