#!/usr/bin/env node
/**
 * fixFalseDefensives.js — manual DB corrections for sources the L4 LLM
 * incorrectly flagged as is_defensive=true.
 *
 * Run AFTER reprocessCorpus.js --phase=l4 completes to fix confirmed
 * false-defensive classifications before running L5.
 *
 * Each entry: { titleFragment, correct }
 *   correct: { main_category, tags, is_defensive }
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FIXES = [
  {
    titleFragment: "Ghost Packages",
    reason: "Attack intelligence on AI-assisted supply chain poisoning via hallucinated package names",
    correct: {
      main_category: "ai_enabled_threats",
      tags: ["AE05_ai_malware_dev", "TAI10_ai_supply_chain_compromise"],
      is_defensive: false,
    },
  },
  {
    titleFragment: "Data-Centric Benchmarking of Exploit Generation",
    reason: "Benchmarks how well AI generates CVE PoC exploits — offensive capability measurement",
    correct: {
      main_category: "ai_enabled_threats",
      tags: ["AE04_ai_exploit_dev", "AE03_ai_vuln_research"],
      is_defensive: false,
    },
  },
  {
    titleFragment: "Persona-Conditioned Adversarial Prompting",
    reason: "PCAP is an adversarial attack discovery framework using persona conditioning — 'Mitigation' in title is secondary use of discovered attacks",
    correct: {
      main_category: "llm_threats",
      tags: ["LLM11_jailbreak_safety_bypass", "LLM01_prompt_injection"],
      is_defensive: false,
    },
  },
  {
    titleFragment: "PISmith",
    reason: "RL red-team framework that breaks prompt injection defenses — deliverable is the attack method",
    correct: {
      main_category: "llm_threats",
      tags: ["LLM01_prompt_injection"],
      is_defensive: false,
    },
  },
];

console.log("Fixing false-defensive classifications...\n");
let fixed = 0, notFound = 0;

for (const fix of FIXES) {
  const { data, error: findErr } = await sb
    .from("sources")
    .select("id, title, intelligence")
    .ilike("title", `%${fix.titleFragment}%`)
    .limit(1);

  if (findErr || !data?.length) {
    console.log(`  ✗ NOT FOUND: ${fix.titleFragment}`);
    notFound++;
    continue;
  }

  const s = data[0];
  const { error } = await sb.from("sources").update({
    main_category: fix.correct.main_category,
    tags:          fix.correct.tags,
    intelligence:  { ...(s.intelligence || {}), is_defensive: fix.correct.is_defensive },
  }).eq("id", s.id);

  if (error) {
    console.log(`  ✗ UPDATE FAILED: ${s.title?.slice(0, 60)} — ${error.message}`);
  } else {
    console.log(`  ✓ Fixed: ${s.title?.slice(0, 60)}`);
    console.log(`    → ${fix.correct.main_category} / ${fix.correct.tags[0]} / is_defensive=${fix.correct.is_defensive}`);
    console.log(`    reason: ${fix.reason}`);
    fixed++;
  }
}

console.log(`\nDone. Fixed: ${fixed}  Not found: ${notFound}`);
