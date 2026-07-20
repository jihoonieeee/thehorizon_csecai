#!/usr/bin/env node
/**
 * One-off: regenerate short_summary + analyst_brief for the HuggingFace
 * security incident disclosure strictly from its full_text, replacing the
 * LLM-embellished version that added facts not present in the source.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function callAnthropic({ system, user, model, maxTokens = 600 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: model || process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const text = data.content?.[0]?.text || "";
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { data: src } = await supabase
  .from("sources")
  .select("id,title,full_text")
  .eq("title", "Security incident disclosure — July 2026")
  .single();

if (!src?.full_text) { console.error("Source not found or no full_text"); process.exit(1); }

console.log("Full text length:", src.full_text.length);
console.log("Regenerating summaries from full text...\n");

const result = await callAnthropic({
  system: "Return only valid JSON with no markdown fences. Do not invent or infer any detail not explicitly stated in the source text. Use exact figures from the text.",
  user: `Read this incident disclosure and write two summaries grounded ONLY in what the text actually states.

SOURCE TEXT:
${src.full_text.slice(0, 8000)}

Requirements:
- short_summary (2-3 sentences, max 400 chars): What happened, how the attacker got in, key defensive finding. Exact numbers only.
- analyst_brief (3-4 sentences, max 600 chars): Full attack chain, how HuggingFace detected and responded, the specific practical lesson for defenders stated in the disclosure.

Return JSON: {"short_summary": "...", "analyst_brief": "..."}`,
  task: "regenerate_summary",
  model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
  maxTokens: 600,
});

console.log("Generated summaries:");
console.log("short_summary:", result?.short_summary);
console.log("\nanalyst_brief:", result?.analyst_brief);

if (!result?.short_summary || !result?.analyst_brief) {
  console.error("\nUnexpected response shape — aborting DB write.");
  process.exit(1);
}

const { error } = await supabase
  .from("sources")
  .update({ short_summary: result.short_summary, analyst_brief: result.analyst_brief })
  .eq("id", src.id);

if (error) { console.error("\nDB error:", error.message); process.exit(1); }
console.log("\nUpdated DB successfully.");
