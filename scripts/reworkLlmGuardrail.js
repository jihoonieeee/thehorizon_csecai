#!/usr/bin/env node
/**
 * One-off: rework the LLM Q2 guardrail-brittleness insight from exactly two
 * sources (UNIATTACK + Adversarial Humanities Benchmark), grounded strictly in
 * their abstracts — no fabricated numbers, one coherent pattern. Also drops the
 * TrojanMerge/FloatDoor stapled insight from the same card.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const UNIATTACK_ID = "d5d065a1172441c7d9e54543f89c7f7c3f63";
const AHB_ID       = "cc0007e237a4e76e45a5eb33ddad4b3ccc9a";

async function main() {
  const { data: srcs } = await sb.from("sources").select("id,title,url,publisher,date_published,source_type,intelligence").in("id", [UNIATTACK_ID, AHB_ID]);
  const byId = Object.fromEntries((srcs || []).map(s => [s.id, s]));
  const mkCite = (s) => ({ title: s.title, url: s.url, publisher: s.publisher || "arXiv", date: s.date_published?.slice(0,10) || null, source_type: s.source_type || "research_finding", importance: "research", significance: s.intelligence?.significance?.level || null });

  // Grounded strictly in the two abstracts. ONE pattern (guardrail brittleness to
  // request FORM), two studies as evidence — the allowed pattern-synthesis shape.
  const insight = {
    insight: "Two 2026 studies show that frontier-model safety guardrails are brittle to HOW a harmful request is phrased, not just what it asks: rewriting a request in an unfamiliar style, or recomposing known attack features, defeats layered defenses while the intent is unchanged. Stylistic rewrites lifted attack success from 3.8% to 55.8% across 31 frontier models, and an automated feature-composition attack improved success 64.6%-248.8% against multi-layered defenses.",
    explanation_points: [
      "Safety guardrails are trained to recognise and refuse FAMILIAR phrasings of harmful requests — they learn word patterns associated with disallowed content, not the underlying intent.",
      "The Adversarial Humanities Benchmark (AHB) rewrote harmful tasks into humanities styles (poetry, tales, other literary forms) while preserving the same objective; refusal held on the original prompts (3.84% attack success) but success rose to 55.75% overall across 31 frontier models after the stylistic rewrite.",
      "UNIATTACK, a separate automated framework, evidences the SAME weakness by a different route: it extracts high-impact features from existing jailbreaks and recomposes them into reusable one-shot templates, improving attack success 64.63%-248.82% against models with multi-layered defenses.",
      "UNIATTACK reached that at 0.03%-4.96% of the cost of prior methods, meaning the attack is not only more effective but far cheaper to run at scale.",
      "AHB found the highest residual risk in the CBRN (chemical, biological, radiological, nuclear) category — the gap is widest exactly where a refusal matters most.",
      "The shared lesson is weak generalisation: safety training keyed to known attack FORMS fails when the surface form changes, so guardrails cannot be assumed robust to rephrasing and must be tested against stylistic and feature-recomposed variants, not just canonical harmful prompts.",
    ],
    evidence: "Two frontier-model safety studies: AHB (3.84%->55.75% ASR across 31 models via stylistic rewrites) and UNIATTACK (64.63%-248.82% ASR improvement vs multi-layered defenses at 0.03%-4.96% cost).",
    broken_assumption: "That a model's refusal training generalises to the intent of a request rather than its surface form.",
    implication: "Test guardrails against stylistic and feature-recomposed variants of harmful prompts, not just canonical phrasings, before trusting them.",
    watch_next: "Whether these surface-form attacks are observed in real misuse, and whether intent-based (not form-based) safety training closes the gap.",
    confidence: "Medium",
    confidence_reason: "two peer-style research benchmarks demonstrating capability; no confirmed in-the-wild misuse",
    explanation_qa: "hand_grounded",
    sources: [mkCite(byId[AHB_ID]), mkCite(byId[UNIATTACK_ID])],
  };

  const { data: card } = await sb.from("dashboard_insights").select("points,window_label,source_count").eq("window_key","2026-Q2").eq("category","llm_threats").single();
  const existing = (card?.points?.insights || []);
  // Keep insights that are NOT the stapled TrojanMerge/FloatDoor one and NOT an old guardrail one.
  const keep = existing.filter(i => !/TrojanMerge|FloatDoor|82\.7|guardrail/i.test(i.insight + JSON.stringify(i.explanation_points || [])));
  const insights = [insight, ...keep];
  console.log(`kept ${keep.length} existing + 1 reworked = ${insights.length}`);
  insights.forEach((i, n) => console.log(`  [${n}] ${i.insight.slice(0, 70)}`));

  const { error } = await sb.from("dashboard_insights").upsert({
    win: "quarter", window_key: "2026-Q2", window_label: card?.window_label || "Q2 2026 · Apr – Jun", category: "llm_threats",
    points: { ...card.points, insights },
    source_count: card?.source_count || 85,
  }, { onConflict: "window_key,category" });
  if (error) throw new Error(error.message);
  console.log("\n✓ LLM Q2 card updated");
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
