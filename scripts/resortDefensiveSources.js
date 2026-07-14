#!/usr/bin/env node
/**
 * resortDefensiveSources.js — file existing defensive sources under the domain they
 * DEFEND, instead of dumping them in unclear_or_adjacent ("Other").
 *
 * Policy (2026-07-06): a defensive source keeps the category of the threat it
 * counters, tagged `defensive` and posture=defensive (so it's discoverable
 * alongside the attacks it addresses without inflating the offensive signal). The
 * pipeline now does this at ingest (understandSource.normalise), but existing
 * defensive sources in unclear were classified before the change and mostly carry
 * no defended_category — so this one-off re-infers the defended domain via a cheap
 * Haiku call and moves them.
 *
 * Deterministic fast-path: if the stored attack-mechanism already resolves to a
 * domain, use that (no LLM). Only sources with an unknown/generic mechanism need
 * the LLM inference.
 *
 * Usage:
 *   node scripts/resortDefensiveSources.js                # dry run — print moves
 *   node scripts/resortDefensiveSources.js --live         # apply
 *   node scripts/resortDefensiveSources.js --live --limit 50
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { computeImportance } from "../lib/pipeline/scoring/importance.js";

const args  = process.argv.slice(2);
const LIVE  = args.includes("--live");
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : 1000;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DOMAINS = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];
const DOMAIN_HINT = `traditional_ai_threats = attacks on ML models (poisoning, evasion, extraction, backdoors)
llm_threats = LLM-specific (prompt injection, jailbreak, RAG poisoning, data leakage, LLM supply chain)
agentic_ai_threats = AI agents/tools (MCP, agent skills, autonomous agent abuse, tool misuse)
ai_enabled_threats = AI used AS a weapon (deepfakes, AI phishing/malware, disinformation)`;

const SYS = `You classify DEFENSIVE AI-security sources by the offensive domain they PROTECT AGAINST.
Given a defense/mitigation/detector/framework, pick the ONE domain whose threats it counters:
${DOMAIN_HINT}
Only answer "none" if the defense genuinely spans no single domain (a broad governance/standards framework with no specific threat class).
Return ONLY JSON: {"defended_category":"traditional_ai_threats|llm_threats|agentic_ai_threats|ai_enabled_threats|none","reason":"one short clause"}`;

const SCHEMA = {
  type: "object",
  properties: {
    defended_category: { type: "string", enum: [...DOMAINS, "none"] },
    reason: { type: "string" },
  },
  required: ["defended_category"],
};

async function inferDefended(s) {
  // Deterministic first: the classifier already assigns a defensive source to the
  // OFFENSIVE domain it protects (mechanism_classification.main_category, or the
  // source's own main_category), so use that when it is a real offensive domain.
  const m = s.intelligence?.mechanism_classification || {};
  const dom = m.main_category || s.main_category;
  if (dom && DOMAINS.includes(dom) && dom !== "unclear_or_adjacent") {
    return { defended_category: dom, reason: `assigned category ${dom}`, via: "deterministic" };
  }
  // LLM inference.
  const usr = `TITLE: ${s.title || ""}\nTAGS: ${(s.tags || []).join(", ")}\nSUMMARY: ${(s.short_summary || s.summary || "").slice(0, 500)}\n\nWhich offensive domain does this defense protect against?`;
  const { result } = await routedLLM(SYS, usr, { task: "source_understanding", requires_json: true, schema: SCHEMA });
  const r = typeof result === "string" ? JSON.parse(result) : result;
  return { defended_category: DOMAINS.includes(r?.defended_category) ? r.defended_category : "none", reason: r?.reason || "", via: "llm" };
}

async function main() {
  const scoredAt = new Date().toISOString();
  // Load defensive sources currently in unclear.
  let rows = [];
  const { count } = await sb.from("sources").select("*", { count: "exact", head: true }).eq("main_category", "unclear_or_adjacent");
  for (let f = 0; f < count; f += 1000) {
    const { data } = await sb.from("sources").select("id,title,tags,source_type,trust_tier,short_summary,summary,intelligence").eq("main_category", "unclear_or_adjacent").range(f, f + 999);
    rows.push(...(data || []));
  }
  const defensive = rows
    .filter(s => s.intelligence?.is_defensive === true || (s.tags || []).includes("defensive"))
    .slice(0, limit);

  console.log(`\n${defensive.length} defensive sources in unclear ${LIVE ? "(LIVE)" : "(DRY RUN)"}\n`);
  const dist = {}; let moved = 0, stayed = 0, det = 0, llm = 0;

  for (const s of defensive) {
    let inf;
    try { inf = await inferDefended(s); }
    catch (e) { console.log(`  ✗ ${s.id.slice(0, 8)} — ${e.message.slice(0, 50)}`); continue; }
    inf.via === "deterministic" ? det++ : llm++;

    if (inf.defended_category === "none") { stayed++; continue; }
    dist[inf.defended_category] = (dist[inf.defended_category] || 0) + 1;
    moved++;
    console.log(`  → [${inf.defended_category}] ${(s.title || "").slice(0, 60)}  (${inf.via})`);

    if (LIVE) {
      const imp = { ...computeImportance({ source_type: s.source_type, is_defensive: true, trust_tier: s.trust_tier, main_category: inf.defended_category }), scored_at: scoredAt };
      const { error } = await sb.from("sources").update({
        main_category: inf.defended_category,
        tags: [...new Set([...(s.tags || []), "defensive"])],
        validation_status: "pass", layer3_status: "pass", relevance_tier: "adjacent",
        intelligence: { ...(s.intelligence || {}), is_defensive: true, defended_category: inf.defended_category, importance: imp },
      }).eq("id", s.id);
      if (error) console.log(`     ! write: ${error.message.slice(0, 60)}`);
    }
  }

  console.log(`\n${LIVE ? "Moved" : "Would move"} ${moved} → ${JSON.stringify(dist)}; ${stayed} stay in unclear (no single domain). [${det} deterministic, ${llm} LLM]`);
  if (!LIVE) console.log("Re-run with --live to apply.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
