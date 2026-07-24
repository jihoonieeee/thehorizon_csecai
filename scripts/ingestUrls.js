#!/usr/bin/env node
/**
 * ingestUrls.js — fetch, ingest, fanout, and classify a fixed list of URLs.
 *
 * Usage: node scripts/ingestUrls.js [--dry-run]
 *
 * Each entry specifies the URL and known metadata so we don't rely on the LLM
 * to infer publisher/date/type from the page alone.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash }   from "crypto";
import { callLLM }      from "../lib/llm/callLLM.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { understandAllSources }       from "../lib/pipeline/understand/understandSource.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";

const DRY = process.argv.includes("--dry-run");
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

function idFromUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

async function fetchViaJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain", "X-Return-Format": "text" },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const raw = await res.text();
  return raw
    .replace(/^(Title:|URL Source:|Published Time:|Skip to main content\n|Skip to footer\n)[^\n]*\n/gm, "")
    .trim();
}

// ── Source catalogue ──────────────────────────────────────────────────────────

const SOURCES = [
  {
    url:            "https://www.anthropic.com/news/AI-enabled-cyber-threats-mitre-attack",
    title:          "What we learned mapping a year's worth of AI-enabled cyber threats",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2026-06-03",
    candidate_domain: "ai_enabled_threats",
    note: "832 accounts banned for malicious cyber activity, mapped to MITRE ATT&CK — likely multi-finding digest",
  },
  {
    url:            "https://www.anthropic.com/news/detecting-countering-misuse-aug-2025",
    title:          "Detecting and countering misuse of AI: August 2025",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2025-08-27",
    candidate_domain: "ai_enabled_threats",
    note: "Quarterly threat intelligence report — multiple misuse examples, likely digest",
  },
  {
    url:            "https://www.anthropic.com/news/disrupting-AI-espionage",
    title:          "Disrupting the first reported AI-orchestrated cyber espionage campaign",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "incident",
    date_published: "2025-11-13",
    candidate_domain: "ai_enabled_threats",
    note: "GTG-1002 incident report",
  },
  {
    url:            "https://www.aisi.gov.uk/blog/our-evaluation-of-claude-mythos-previews-cyber-capabilities",
    title:          "Our evaluation of Claude Mythos Preview's cyber capabilities",
    publisher:      "UK AI Safety Institute (AISI)",
    trust_tier:     "primary",
    source_type:    "capability_demonstration",
    date_published: "2026-04-13",
    candidate_domain: "ai_enabled_threats",
    note: "CTF + multi-step cyber-attack simulation evaluation of Claude Mythos Preview",
  },
  {
    url:            "https://www.anthropic.com/research/n-days",
    title:          "Measuring LLMs' impact on N-day exploits",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "capability_demonstration",
    date_published: "2026-06-08",
    candidate_domain: "ai_enabled_threats",
    note: "Frontier Red Team research on LLM-assisted N-day exploitation",
  },
  {
    url:            "https://www.anthropic.com/research/project-fetch-phase-two",
    title:          "Project Fetch: Phase two",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "research",
    date_published: "2026-06-18",
    candidate_domain: "agentic_ai_threats",
    note: "Claude controlling a robotic quadruped — agentic AI capability research",
  },
  {
    url:            "https://www.anthropic.com/research/claude-plays-robotics",
    title:          "Claude plays robotics",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "research",
    date_published: "2026-07-09",
    candidate_domain: "agentic_ai_threats",
    note: "Frontier Red Team robotics research — agentic AI control + 3D understanding",
  },

  // ── Batch 2 ──────────────────────────────────────────────────────────────────
  {
    url:            "https://www.anthropic.com/research/attack-navigator",
    title:          "Mapping AI-enabled cyber threats: Insights from the LLM ATT&CK Navigator",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2026-06-03",
    candidate_domain: "ai_enabled_threats",
    note: "Companion research to the MITRE ATT&CK report — maps real-world AI-enabled attacks to ATT&CK framework",
  },
  {
    url:            "https://www.anthropic.com/research/mythos-preview",
    title:          "Assessing Claude Mythos Preview's cybersecurity capabilities",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "capability_demonstration",
    date_published: "2026-04-07",
    candidate_domain: "ai_enabled_threats",
    note: "Internal red team evaluation of Mythos Preview on cyber tasks",
  },
  {
    url:            "https://www.anthropic.com/research/smart-contracts",
    title:          "AI agents find $4.6M in blockchain smart contract exploits",
    publisher:      "Anthropic",
    trust_tier:     "primary",
    source_type:    "capability_demonstration",
    date_published: "2025-12-01",
    candidate_domain: "ai_enabled_threats",
    note: "Frontier Red Team — AI agents autonomously finding and exploiting smart contract vulnerabilities",
  },
  // OpenAI disruption reports
  {
    url:            "https://openai.com/index/disrupting-malicious-uses-of-ai-by-state-affiliated-threat-actors/",
    title:          "Disrupting malicious uses of AI by state-affiliated threat actors",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2024-02-14",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI disruption of state-affiliated threat actors (DPRK, Iran, Russia, China) using GPT for cyber ops",
  },
  {
    url:            "https://openai.com/index/daybreak-securing-the-world/",
    title:          "Daybreak: Tools for securing every organization in the world",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2026-06-22",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI Daybreak security initiative — AI-powered security tooling for defenders",
  },
  {
    url:            "https://openai.com/index/disrupting-malicious-ai-uses/",
    title:          "Disrupting malicious uses of AI",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2026-02-25",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI threat intelligence report — disrupting malicious AI use cases Feb 2026",
  },
  {
    url:            "https://openai.com/global-affairs/disrupting-malicious-uses-of-ai/",
    title:          "Disrupting malicious uses of AI",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2025-02-21",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI global affairs threat report — malicious AI use disruption Feb 2025",
  },
  {
    url:            "https://openai.com/index/disrupting-a-covert-iranian-influence-operation/",
    title:          "Disrupting a covert Iranian influence operation",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2024-08-16",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI disruption of Iranian influence operation (Storm-2035) using ChatGPT",
  },
  {
    url:            "https://openai.com/index/disrupting-deceptive-uses-of-ai-by-covert-influence-operations/",
    title:          "Disrupting deceptive uses of AI by covert influence operations",
    publisher:      "OpenAI",
    trust_tier:     "primary",
    source_type:    "threat_intelligence",
    date_published: "2024-05-30",
    candidate_domain: "ai_enabled_threats",
    note: "OpenAI disruption of 5 covert influence operations from Russia, China, Iran, Israel",
  },

  // ── Batch 3 ──────────────────────────────────────────────────────────────────
  {
    url:            "https://www.bleepingcomputer.com/news/security/new-dolphin-x-malware-uses-ai-to-rank-high-value-targets/",
    title:          "New Dolphin-X malware uses AI to rank high-value targets",
    publisher:      "BleepingComputer",
    trust_tier:     "medium",
    source_type:    "news_article",
    date_published: "2026-07-23",
    candidate_domain: "ai_enabled_threats",
    note: "AI-enabled malware using LLMs to score and prioritise victims for follow-on attacks",
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const scoredAt = new Date().toISOString();
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ingestUrls.js — ${SOURCES.length} sources${DRY ? " [DRY RUN]" : ""}`);
  console.log(`${"═".repeat(64)}\n`);

  // ── Step 1: Fetch + upsert ─────────────────────────────────────────────────
  console.log("── Step 1: Fetch + upsert ──────────────────────────────────────");
  const ingested = [];

  for (const meta of SOURCES) {
    const id = idFromUrl(meta.url);
    console.log(`\n▸ [${id.slice(0,10)}] ${meta.title.slice(0,65)}`);
    console.log(`  ${meta.note}`);

    // Check if already in DB
    const { data: existing } = await sb.from("sources")
      .select("id,title,validation_status,is_digest,full_text,intelligence,main_category,layer3_status,parent_source_id,source_type,trust_tier,candidate_domain,ai_threat_focus,summary")
      .eq("id", id).single();

    if (existing) {
      console.log(`  Already in DB [${existing.validation_status}] — skipping fetch`);
      ingested.push(existing);
      continue;
    }

    let full_text;
    try {
      full_text = await fetchViaJina(meta.url);
      console.log(`  Fetched via Jina: ${full_text.length} chars`);
    } catch (err) {
      console.error(`  FETCH ERROR: ${err.message}`);
      continue;
    }

    if (DRY) {
      console.log(`  [dry-run] would upsert: ${full_text.slice(0, 120).replace(/\n/g, " ")}…`);
      continue;
    }

    const row = {
      id,
      title:           meta.title,
      url:             meta.url,
      publisher:       meta.publisher,
      trust_tier:      meta.trust_tier,
      source_type:     meta.source_type,
      date_published:  new Date(meta.date_published).toISOString(),
      date_confidence: "exact",
      full_text,
      summary:         full_text.slice(0, 600),
      candidate_domain: meta.candidate_domain,
    };

    const { error } = await sb.from("sources").upsert(row, { onConflict: "id", ignoreDuplicates: false });
    if (error) { console.error(`  DB ERROR: ${error.message}`); continue; }
    console.log(`  ✓ Upserted`);

    // Reload full row for pipeline
    const { data: saved } = await sb.from("sources")
      .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
      .eq("id", id).single();
    ingested.push(saved);
  }

  if (DRY || !ingested.length) return;

  // ── Step 2: Digest detection + fanout ─────────────────────────────────────
  console.log("\n── Step 2: Digest detection + fanout ───────────────────────────");
  const allChildren = [];

  for (const src of ingested) {
    if (src.is_digest) {
      console.log(`\n▸ ${src.title?.slice(0, 65)} — already fanned out, loading children`);
      const { data: kids } = await sb.from("sources")
        .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
        .eq("parent_source_id", src.id);
      allChildren.push(...(kids || []));
      continue;
    }

    // Skip sources that already have validation (already processed)
    if (src.validation_status === "pass" && !src.is_digest) continue;

    console.log(`\n▸ ${src.title?.slice(0, 65)}`);
    const det = detectDigest(src);
    console.log(`  detectDigest → is_digest: ${det.is_digest}, reason: ${det.reason}`);

    if (!det.is_digest) {
      console.log(`  ↳ Single-topic source — will classify directly`);
      allChildren.push(src);   // treat as "child" for the understand step
      continue;
    }

    // Check for existing children
    const { count: existingKids } = await sb.from("sources")
      .select("*", { count: "exact", head: true })
      .eq("parent_source_id", src.id);
    if (existingKids > 0) {
      console.log(`  ↳ Already fanned out (${existingKids} children) — loading`);
      const { data: kids } = await sb.from("sources")
        .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
        .eq("parent_source_id", src.id);
      allChildren.push(...(kids || []));
      continue;
    }

    console.log(`  Running fanOutDigest (LLM)…`);
    let fanout;
    try { fanout = await fanOutDigest(src, { llmFn, scoredAt }); }
    catch (err) { console.error(`  FANOUT ERROR: ${err.message}`); allChildren.push(src); continue; }

    const { is_digest, children, parent_patch } = fanout;
    if (!is_digest || !children.length) {
      console.log(`  ↳ LLM: single-topic — classifying directly`);
      await sb.from("sources").update({ validation_status: "pass", layer3_status: "pass", main_category: src.candidate_domain || "ai_enabled_threats" }).eq("id", src.id);
      allChildren.push(src);
      continue;
    }

    console.log(`  ↳ ${children.length} children extracted:`);
    children.forEach((c, i) => {
      const ft = c.intelligence?.report_finding?.finding_title || c.title?.slice(0, 60);
      console.log(`    [${i+1}] ${ft}`);
    });

    await sb.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
    await sb.from("sources").update({
      is_digest:         true,
      main_category:     "unclear_or_adjacent",
      validation_status: "pass",
      layer3_status:     "pass",
      intelligence: { ...(src.intelligence || {}), ...parent_patch.intelligence },
    }).eq("id", src.id);
    console.log(`  ✓ ${children.length} children written, parent marked as digest`);

    extractAndSaveReportInsights(
      { ...src, intelligence: { ...(src.intelligence || {}), ...parent_patch?.intelligence }, is_digest: true },
      sb,
    ).then(() => console.log(`  ✓ Report insights extracted for: ${src.title?.slice(0, 55)}`))
     .catch(e => console.warn(`  ! Report insights failed: ${e.message}`));

    allChildren.push(...children);
  }

  // ── Step 3: Classify unclassified sources ──────────────────────────────────
  const toClassify = allChildren.filter(s => !s.main_category);
  const alreadyDone = allChildren.filter(s => s.main_category && s.validation_status === "pass");

  console.log(`\n── Step 3: Classify ────────────────────────────────────────────`);
  console.log(`  ${toClassify.length} to classify, ${alreadyDone.length} already done`);

  if (alreadyDone.length) {
    alreadyDone.forEach(s => {
      const ft = s.intelligence?.report_finding?.finding_title || s.title;
      console.log(`  [skip] [${s.main_category}] ${ft?.slice(0, 60)}`);
    });
  }

  if (toClassify.length) {
    const { relevant, discarded, counts } = await understandAllSources(toClassify, {
      llmFn,
      concurrency: 3,
      supabase: sb,
      onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
    });
    console.log(`\n  Done — pass: ${counts?.pass ?? relevant.length}, discard: ${counts?.discard ?? discarded.length}`);
    relevant.forEach(s  => console.log(`    [pass]    [${s.category}] ${s.title?.slice(0, 60)}`));
    discarded.forEach(s => console.log(`    [discard] ${s.title?.slice(0, 60)}`));
  }

  console.log(`\n${"═".repeat(64)}\n  Done\n${"═".repeat(64)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message, e.stack); process.exit(1); });
