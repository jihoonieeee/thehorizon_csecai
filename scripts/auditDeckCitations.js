#!/usr/bin/env node
// One-off: audit every citation in a saved deck JSON.
//   Phase 1 — structural: each bullet's cited_sources/cited_urls/cite_nums are
//             consistent, resolve to a real footnote/reference, and are well-formed.
//   Phase 2 — semantic: fetch each cited source from the DB and check (LLM) whether
//             it actually supports the claim. A bullet passes if ANY cited source
//             supports it. Reports mis-cites and embellishments.
import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { loadEvidence } from "../lib/storage/evidenceStore.js";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { loadPrompt, interpolate } from "../lib/prompts/promptLoader.js";
import { buildEvidenceBlock } from "../lib/slides/buildCategoryContext.js";

const file = process.argv[2];
const deck = JSON.parse(fs.readFileSync(file, "utf8"));
const slides = deck.deck?.slides || [];
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const norm = u => (u || "").trim().replace(/\/+$/, "").toLowerCase();
const { system, user: userTmpl } = loadPrompt("slides/qa-report");

// Collect every cited bullet across content slides.
const bullets = [];
for (const s of slides) {
  if (!["strategic_shift", "case_study"].includes(s.type)) continue;
  for (const b of (s.bullets || [])) {
    if (!(b.cited_urls || []).length) continue;
    bullets.push({ slide: s.headline, cat: s.category, text: b.text, urls: b.cited_urls, nums: b.cite_nums || [] });
  }
}

// ── Phase 1: structural integrity ──────────────────────────────────────────────
const refByNum = {};
const refSlide = slides.filter(s => s.type === "references").flatMap(s => s.bullets || []);
for (const r of refSlide) refByNum[r.ref_num] = r;
const structural = [];
for (const b of bullets) {
  for (const u of b.urls) { try { new URL(u); } catch { structural.push(`BAD URL "${u}" — ${b.text.slice(0,50)}`); } }
  for (const n of b.nums) {
    if (!refByNum[n]) structural.push(`cite_num [${n}] has no reference entry — ${b.text.slice(0,50)}`);
    else if (norm(refByNum[n].url) !== norm(b.urls[b.nums.indexOf(n)])) {
      // num↔url ordering mismatch
      structural.push(`cite_num [${n}] url mismatch vs bullet — ${b.text.slice(0,50)}`);
    }
  }
}

// ── Fetch cited sources from DB ────────────────────────────────────────────────
const allUrls = [...new Set(bullets.flatMap(b => b.urls))];
const { data: rows } = await sb.from("sources")
  .select("id,title,url,short_summary,full_text,intelligence").in("url", allUrls);
const byUrl = new Map();
for (const r of rows || []) byUrl.set(norm(r.url), r);
const ev = await loadEvidence(sb, (rows || []).map(r => r.id));
const evBySrc = new Map();
for (const e of ev) { if (!evBySrc.has(e.source_id)) evBySrc.set(e.source_id, []); evBySrc.get(e.source_id).push(e); }

const missingInDb = allUrls.filter(u => !byUrl.has(norm(u)));

// ── Phase 2: semantic entailment (each cited source; pass if ANY supports) ──────
async function checkOne(claim, src) {
  // Ground against full_text (same basis as the insight + slide QA layers), not
  // the lossy short_summary. Fall back to summary + evidence when full text is absent.
  const evText = buildEvidenceBlock(evBySrc.get(src.id) || []);
  const user = interpolate(userTmpl, {
    bullet_text: claim, source_title: src.title,
    source_summary: src.full_text ? "(see source text below)" : (src.short_summary || "(no summary)"),
    source_evidence: src.full_text
      ? `\nSource text:\n${src.full_text.slice(0, 6000)}`
      : (evText ? `\nExtracted evidence items:\n${evText}` : ""),
  });
  try {
    const { result } = await routedLLM(system, user, { task: "source_relevance", requires_json: true });
    return result;
  } catch { return null; }
}

const semantic = [];
let checked = 0;
for (const b of bullets) {
  const results = [];
  for (const u of b.urls) {
    const src = byUrl.get(norm(u));
    if (!src) { results.push({ url: u, r: { verdict: "no_db", reason: "not in DB" } }); continue; }
    results.push({ url: u, r: await checkOne(b.text, src) });
    checked++;
  }
  // QA prompt returns verdict ok|correctable|unsupported. A bullet is clean when
  // at least one cited source fully supports it (verdict "ok"); flag otherwise.
  const anySupported = results.some(x => x.r?.verdict === "ok");
  if (!anySupported) {
    semantic.push({ ...b, results });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
console.log(`\n===== ${file} =====`);
console.log(`Bullets with citations: ${bullets.length} | unique URLs: ${allUrls.length} | semantic checks: ${checked}`);
console.log(`\n-- Phase 1 structural --`);
console.log(structural.length ? structural.map(x => "  ✗ " + x).join("\n") : "  ✓ all citations resolve, urls well-formed, num↔url consistent");
console.log(`  sources cited but not found in DB: ${missingInDb.length}${missingInDb.length ? "\n    " + missingInDb.join("\n    ") : ""}`);
console.log(`\n-- Phase 2 semantic (bullets where NO cited source supports the claim) --`);
if (!semantic.length) console.log("  ✓ every cited bullet is supported by at least one of its cited sources");
for (const s of semantic) {
  console.log(`\n  [${s.cat}] "${s.text}"`);
  for (const r of s.results) console.log(`     - ${r.r?.verdict || "?"} ${r.url}\n       ${r.r?.reason||""}`);
}
