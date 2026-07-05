#!/usr/bin/env node
/**
 * spotCheck.js — blind re-classification audit of the resort.
 *
 *   node scripts/spotCheck.js sample        # print N sampled sources, FULL text, HIDING my prior call
 *   node scripts/spotCheck.js reveal        # reveal the stored category/tags/rationale for the sample
 *
 * Sampling: stratified across current categories, only sources I touched
 * (intelligence.mechanism_classification.rationale is set), with real body text.
 * Chosen IDs are persisted to scripts/_spotcheck_ids.json so `reveal` matches `sample`.
 */
import "dotenv/config";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const IDS_FILE = "scripts/_spotcheck_ids.json";
const isDomainTag = (t) => /^(TAI|LLM|ASI|AE)\d/.test(t);
const SELECT = "id,title,url,publisher,date_published,full_text,clean_text,summary,short_summary,tags,source_type,main_category,intelligence";

// how many to draw from each current category
const STRATA = { llm_threats: 12, unclear_or_adjacent: 10, agentic_ai_threats: 5, ai_enabled_threats: 3 };

function pick(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

async function sample() {
  const chosen = [];
  for (const [cat, n] of Object.entries(STRATA)) {
    const { data } = await sb.from("sources").select(SELECT).eq("main_category", cat).limit(1000);
    const touched = (data || []).filter(s => s.intelligence?.mechanism_classification?.rationale);
    for (const s of pick(touched, n)) chosen.push(s);
  }
  fs.writeFileSync(IDS_FILE, JSON.stringify(chosen.map(s => s.id)));
  console.log(`\n═══ SPOT-CHECK SAMPLE — ${chosen.length} sources (full text; my prior call HIDDEN) ═══\n`);
  chosen.forEach((s, i) => {
    const body = (s.full_text || s.clean_text || s.summary || "").replace(/\s+/g, " ").trim();
    console.log(`\n──────── [${i}] id=${s.id} ────────`);
    console.log(`TITLE: ${s.title || "(untitled)"}`);
    console.log(`PUBLISHER: ${s.publisher || "?"}   TYPE: ${s.source_type || "?"}`);
    console.log(`BODY (${body.length} chars): ${body.slice(0, 2800)}`);
  });
  console.log(`\n(${chosen.length} sampled; ids saved to ${IDS_FILE})`);
}

async function reveal() {
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  const { data } = await sb.from("sources").select(SELECT).in("id", ids);
  const byId = Object.fromEntries((data || []).map(s => [s.id, s]));
  console.log(`\n═══ REVEAL — what I stored for the ${ids.length} sampled sources ═══\n`);
  ids.forEach((id, i) => {
    const s = byId[id]; if (!s) return;
    const tags = (s.tags || []).filter(isDomainTag).join(", ") || "—";
    const mc = s.intelligence?.mechanism_classification || {};
    console.log(`[${i}] ${s.main_category}  [${tags}]  mech=${mc.primary_exploit_mechanism || "?"}/${mc.primary_consequence || "?"}`);
    console.log(`     ${mc.rationale || "(no rationale)"}`);
  });
}

const mode = process.argv[2];
(mode === "sample" ? sample() : mode === "reveal" ? reveal() : Promise.reject(new Error("mode must be 'sample' or 'reveal'")))
  .catch(e => { console.error("FATAL:", e.message); process.exit(1); });
