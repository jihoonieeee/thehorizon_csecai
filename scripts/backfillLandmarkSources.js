#!/usr/bin/env node
/**
 * backfillLandmarkSources.js — LLM-reasoned landmark backfill (NOT taxonomy search).
 *
 * The deterministic discovery families search by taxonomy technique ("prompt
 * injection attack 2026"). That misses named, real-world landmark EVENTS an
 * analyst would expect in the corpus (GTG-1002, PROMPTFLUX, EchoLeak, the s1ngularity
 * Nx attack, DARPA AIxCC …). This script asks an LLM (Gemini first, per
 * LLM_PROVIDER_ORDER) to reason as a threat-intel analyst about the biggest
 * operational developments per category in a window, emits a targeted search
 * query for each, runs those through the grounded web-search provider (Tavily),
 * and reports the live primary sources that are NOT already in the corpus.
 *
 * ⚠️ KNOWN LIMITATION (verified 2026-07-03): an LLM whose training cutoff predates
 * the window CANNOT recall real recent events — it HALLUCINATES them. A Gemini run
 * over 2025-Q3..2026-Q2 produced placeholder CVEs ("CVE-2025-XXXXX"), invented
 * campaigns, and one category literally answered "UNABLE TO PROVIDE ACCURATE LIST".
 * The grounded search then returns junk for the fake queries. DO NOT trust this
 * script's LLM-proposed events on faith. The reliable mechanism for recent landmarks
 * is grounded, named-entity queries (see the ai_orchestrated_operations /
 * mcp_infrastructure_cve / ai_autonomous_offensive_capability missions in
 * discoveryMissions.js, whose seeds were written FROM verified web-search facts).
 * Keep this script for (a) models with an in-window cutoff, or (b) a curate-not-recall
 * flow where the LLM ranks already-fetched grounded results.
 *
 * Report-only by default (Gemini + Tavily cost, NO DB writes). --out writes the
 * findings JSON so they can be reviewed and fed to the seed/import path.
 *
 *   node scripts/backfillLandmarkSources.js
 *   node scripts/backfillLandmarkSources.js --from=2025-07 --to=2026-06 --per=8 --out=/tmp/landmark-backfill.json
 */

import "dotenv/config";
process.env.WEB_DISCOVERY_PROVIDER = process.env.WEB_DISCOVERY_PROVIDER || "tavily"; // grounded, no Anthropic
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { runDiscoverySearch } from "../lib/pipeline/discovery/discoverySearchRouter.js";

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const FROM = args.from || "2025-07";
const TO   = args.to   || "2026-06";
const PER  = parseInt(args.per || "8", 10);
const OUT  = args.out || null;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CATEGORIES = [
  { key: "ai_enabled_threats",     desc: "AI used AS an offensive tool: nation-state AI-orchestrated operations, AI-generated/LLM-embedded malware, deepfake fraud, AI phishing/social engineering, autonomous offensive capability (AI finding/exploiting zero-days)" },
  { key: "agentic_ai_threats",     desc: "attacks on AI agents and tool use: MCP server/protocol vulnerabilities, tool poisoning, agent goal hijack, coding-agent (Claude Code/Cursor/Copilot) exploits, agent/plugin supply chain" },
  { key: "llm_threats",            desc: "LLM-specific application attacks: prompt injection (incl. zero-click), jailbreaks, RAG/data poisoning, data exfiltration/leakage, guardrail bypass" },
  { key: "traditional_ai_threats", desc: "classic adversarial ML: training-data/model poisoning, model extraction/inversion, evasion, and ML model supply-chain compromise (e.g. malicious Hugging Face models)" },
];

const SYSTEM =
  "You are a senior AI threat-intelligence analyst curating a reference corpus of the AI threat landscape. " +
  "You prioritise REAL-WORLD operational significance: named threat campaigns, confirmed incidents, first-of-kind disclosures, " +
  "major CVEs actively discussed, and authoritative vendor/government reports — NOT generic academic technique papers. " +
  "You only name developments you are confident actually happened; you never invent CVE numbers, dates, or URLs.";

function userPrompt(cat) {
  return `List the ${PER} MOST SIGNIFICANT landmark developments in the category "${cat.key}" (${cat.desc}) ` +
    `that occurred between ${FROM} and ${TO} and that a comprehensive AI threat-intelligence corpus MUST contain.\n\n` +
    `Think like an analyst briefing leadership: favour named incidents/campaigns, first-of-kind events, and the biggest disclosures/reports over routine papers. ` +
    `For each, write a SPECIFIC web-search query (named entities: actor, tool, CVE, campaign, vendor) most likely to surface the PRIMARY source.\n\n` +
    `Respond with ONLY a JSON array, each item: ` +
    `{"event": string, "approx_date": "YYYY-MM", "why_landmark": string, "search_query": string}.`;
}

function parseArray(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.items)) return result.items;
  if (typeof result === "string") {
    const m = result.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  }
  if (result && typeof result === "object") {
    const arr = Object.values(result).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

function urlKey(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, "").toLowerCase() + x.pathname.replace(/\/+$/, "").toLowerCase(); }
  catch { return (u || "").toLowerCase(); }
}

async function loadCorpusKeys() {
  const keys = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("sources").select("url").range(f, f + 999);
    if (!data?.length) break;
    for (const s of data) if (s.url) keys.add(urlKey(s.url));
    if (data.length < 1000) break;
  }
  return keys;
}

async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  LLM-reasoned landmark backfill  ${FROM} → ${TO}  (${PER}/category)`);
  console.log(`  query-gen: routedLLM (Gemini-first)   search: ${process.env.WEB_DISCOVERY_PROVIDER}   NO DB writes`);
  console.log(`${"═".repeat(72)}\n`);

  const corpus = await loadCorpusKeys();
  console.log(`  Corpus URLs loaded: ${corpus.size}\n`);

  const findings = [];
  const seenThisRun = new Set();

  for (const cat of CATEGORIES) {
    console.log(`\n── ${cat.key} ─────────────────────────────────────────`);
    let events = [];
    try {
      const { result } = await routedLLM(SYSTEM, userPrompt(cat), { task: "discovery_query_gen", requires_json: true });
      events = parseArray(result).slice(0, PER);
    } catch (e) { console.log(`  LLM error: ${e.message}`); continue; }
    console.log(`  Gemini proposed ${events.length} landmark events. Searching…`);

    for (const ev of events) {
      const q = ev.search_query || ev.event;
      if (!q) continue;
      let res;
      try { res = await runDiscoverySearch({ query: q, source_class_hint: null }, {}); }
      catch { res = null; }
      const cands = res?.candidates || [];
      // best candidate URL from grounded search results
      const urls = [...cands.map(c => c.opened_url || c.url), ...((res?.grounded?.search_results || []).map(s => s.url))].filter(Boolean);
      const fresh = urls.map(u => ({ u, k: urlKey(u) })).find(({ k }) => k && !corpus.has(k) && !seenThisRun.has(k));
      const status = !urls.length ? "no_result" : fresh ? "NEW" : "already_in_corpus";
      if (fresh) seenThisRun.add(fresh.k);
      findings.push({
        category: cat.key, event: ev.event, approx_date: ev.approx_date || null,
        why_landmark: ev.why_landmark || null, search_query: q,
        status, url: fresh?.u || urls[0] || null,
      });
      const tag = status === "NEW" ? "🆕" : status === "already_in_corpus" ? "✓ have" : "· none";
      console.log(`   ${tag}  ${(ev.event || "").slice(0, 52)}${fresh ? "  → " + fresh.u.slice(0, 48) : ""}`);
    }
  }

  const news = findings.filter(f => f.status === "NEW");
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  Proposed: ${findings.length}   NEW (not in corpus): ${news.length}   already have: ${findings.filter(f => f.status === "already_in_corpus").length}`);
  const byCat = {};
  for (const f of news) (byCat[f.category] ||= []).push(f);
  for (const [c, list] of Object.entries(byCat)) {
    console.log(`\n  ${c} — ${list.length} new landmark sources:`);
    for (const f of list) console.log(`    • [${f.approx_date || "?"}] ${f.event}\n        ${f.url}`);
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify(findings, null, 2)); console.log(`\n  Wrote ${findings.length} findings → ${OUT}`); }
  console.log(`\n  Report only — nothing written to the DB. Review the NEW list, then seed/import.\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
