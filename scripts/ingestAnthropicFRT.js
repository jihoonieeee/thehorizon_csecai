#!/usr/bin/env node
/**
 * ingestAnthropicFRT.js — ingest Anthropic Frontier Red Team cybersecurity
 * research publications into the corpus.
 *
 * Usage:
 *   node scripts/ingestAnthropicFRT.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { fetchPageText } from "../lib/pipeline/discovery/fetchCandidateText.js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";

const DRY_RUN = process.argv.includes("--dry-run");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function makeId(url) {
  return createHash("sha256").update(url.toLowerCase().trim()).digest("hex").slice(0, 36);
}
async function alreadyExists(id) {
  const { data } = await supabase.from("sources").select("id").eq("id", id).maybeSingle();
  return !!data;
}

// Fallback summaries from web fetch — used when live page fetch fails or returns
// less content than the pre-fetched excerpt.
const FALLBACK_SUMMARIES = {
  "https://www.anthropic.com/news/AI-enabled-cyber-threats-mitre-attack":
    `Anthropic's Frontier Red Team analysis of 832 banned accounts (March 2025–March 2026) mapped to MITRE ATT&CK framework. Key findings: 67.3% used AI for malware development; medium-to-high risk actors rose from 33% to 56% year-over-year (1.7x); AI amplifies post-compromise sophistication rather than just initial access. Autonomous kill-chain orchestration, real-time pivot decisions, and AI-directed execution distinguish the highest-risk operators. MITRE ATT&CK lacks coverage for AI-specific orchestration behaviours. Partially published in Verizon 2026 DBIR.`,

  "https://www.anthropic.com/research/attack-navigator":
    `Companion research piece to the MITRE ATT&CK threat mapping. Analysed 13,873 malicious actions across all 14 ATT&CK tactics and 482 unique sub-techniques from 832 banned accounts. Risk escalation: medium/high-risk actors jumped from 33% to 56%. GTG-1002 campaign achieved maximum risk score of 100 through autonomous scaffolding. Framework gap: autonomous orchestration, real-time decision-making, and minimal-intervention chaining lack ATT&CK identifiers. Authors: Kyla Guru, Alex Moix, Jacob Klein.`,

  "https://www.anthropic.com/research/n-days":
    `Claude Mythos Preview autonomously created 8 working Firefox (SpiderMonkey) exploits from 18 patches, first PoC in ~12 minutes; 14 total functional PoCs, 13 within 40 minutes. Windows kernel: 18 of 21 local privilege escalation PoCs generated; 8 full exploit chains to SYSTEM in under 6 hours ($15,700 API cost). First exploit completed within one hour of Mozilla patch issuance vs 18-day public patch cycle. "N-day" terminology obsolete — "N-hour" better describes reality. Traditional monthly release cadences insufficient. Devices with fixed maintenance windows (medical, ICS, IoT) face dramatically elevated exposure.`,

  "https://www.anthropic.com/research/exploit-evals":
    `Claude Mythos Preview step-change in exploit development: achieved arbitrary code execution on 21 of 41 V8 CVEs on ExploitBench (competing models: at most 2); exploited 157 intended vulnerabilities with 226 total flag captures on ExploitGym (898 vulns) vs Opus 4.6's 15; exploited $35M of smart contract vulnerabilities on SCONE-bench. Model "can turn vulnerabilities into exploit primitives, and combine those primitives together into complete end-to-end attack chains." Exploit revenue doubling every 0.7 months for recent Claude models vs 1.1 months for earlier generations. Mythos-level models expected widely available within 6-12 months.`,

  "https://www.anthropic.com/research/mythos-preview":
    `Claude Mythos Preview cybersecurity capability assessment: identified zero-days across major OSes and browsers including a 27-year-old OpenBSD SACK vulnerability and 16-year-old FFmpeg H.264 bug. Chained four vulnerabilities in a browser exploit with JIT heap spray escaping renderer and OS sandboxes. Developed FreeBSD NFS RCE giving unauthenticated root via 20-gadget ROP chain split across packets. Vastly outperforms Opus 4.6: 181 working Firefox exploits vs 2 from Opus 4.6. Thousands of high/critical severity vulnerabilities found during testing; only 1% disclosed. Defenders advised to use current frontier models for bug-finding and shorten patch cycles.`,

  "https://www.anthropic.com/research/zero-days":
    `Claude Opus 4.6 discovered and validated over 500 high-severity zero-day vulnerabilities in open-source software, some undetected for decades. Case studies: GhostScript (incomplete bounds checking in font handling via commit history analysis), OpenSC (unsafe strcat buffer overflow), CGIF (LZW compression buffer overflow). Model operates without specialized scaffolding, reasoning about code like human researchers — examining commit histories, patterns, logic flows. Anthropic introduced cyber-specific probes for misuse detection and real-time intervention. Conclusion: "existing disclosure norms will need to evolve" given LLM discovery speed and scale.`,

  "https://www.anthropic.com/news/strategic-warning-for-ai-risk-progress-and-insights-from-our-frontier-red-team":
    `Frontier Red Team findings across four Claude model releases. Cybersecurity: dramatic CTF improvement from high-school to undergraduate level in one year; Claude 3.7 Sonnet solved ~1/3 of Cybench challenges. Incalmo toolkit (with CMU) enables successful attacks in realistic network environments. Biosecurity: virology performance exceeded world-class expert baseline; weaponisation studies with novices showed significant planning failures preventing real-world execution. Pre-deployment testing by US NIST AI Safety Institute and UK AISI. Constitutional classifiers mitigate harmful outputs. Frontier red-teaming accelerates responsible development by establishing capability thresholds in advance.`,
};

const SOURCES = [
  {
    title:         "What we learned mapping a year's worth of AI-enabled cyber threats",
    url:           "https://www.anthropic.com/news/AI-enabled-cyber-threats-mitre-attack",
    publisher:     "Anthropic",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-06-03",
  },
  {
    title:         "Mapping AI-enabled cyber threats: Insights from the LLM ATT&CK Navigator",
    url:           "https://www.anthropic.com/research/attack-navigator",
    publisher:     "Anthropic",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-06-03",
  },
  {
    title:         "Measuring LLMs' impact on N-day exploits",
    url:           "https://www.anthropic.com/research/n-days",
    publisher:     "Anthropic",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-06-08",
  },
  {
    title:         "Measuring LLMs' ability to develop exploits",
    url:           "https://www.anthropic.com/research/exploit-evals",
    publisher:     "Anthropic",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-05-22",
  },
  {
    title:         "Assessing Claude Mythos Preview's cybersecurity capabilities",
    url:           "https://www.anthropic.com/research/mythos-preview",
    publisher:     "Anthropic",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-04-07",
  },
  {
    title:         "Evaluating and mitigating the growing risk of LLM-discovered 0-days",
    url:           "https://www.anthropic.com/research/zero-days",
    publisher:     "Anthropic",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-02-05",
  },
  {
    title:         "Progress from our Frontier Red Team",
    url:           "https://www.anthropic.com/news/strategic-warning-for-ai-risk-progress-and-insights-from-our-frontier-red-team",
    publisher:     "Anthropic",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-03-19",
  },
];

async function main() {
  console.log(`\nIngesting ${SOURCES.length} Anthropic Frontier Red Team sources${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const imported = [];
  let skipped = 0, failed = 0;

  for (const src of SOURCES) {
    const id = makeId(src.url);
    process.stdout.write(`  ${src.title.slice(0, 70).padEnd(70)} `);

    if (!DRY_RUN && await alreadyExists(id)) {
      process.stdout.write("SKIP (already in corpus)\n");
      skipped++;
      continue;
    }

    // Try to fetch live page text; fall back to pre-fetched summary.
    let full_text = "";
    try {
      full_text = await fetchPageText(src.url, { timeoutMs: 20000 });
    } catch (err) {
      process.stdout.write(`[fetch failed: ${err.message.slice(0, 40)}] `);
    }

    const fallback = FALLBACK_SUMMARIES[src.url] || "";
    if (!full_text || full_text.length < 200) {
      full_text = fallback;
      process.stdout.write("[using fallback text] ");
    }

    if (!full_text || full_text.length < 50) {
      process.stdout.write("FAIL (no text)\n");
      failed++;
      continue;
    }

    process.stdout.write(`${full_text.length} chars `);
    if (DRY_RUN) { process.stdout.write("[dry-run]\n"); continue; }

    const summary = (full_text.length > 500 ? full_text.slice(0, 500) : full_text);

    // Save raw metadata only — do NOT pre-set main_category, validation_status,
    // or layer3_status. The pipeline (understandAllSources below) sets those.
    // Pre-setting them triggers the skip gate and bypasses Layer 3/4 entirely.
    const row = {
      id,
      title:           src.title,
      url:             src.url,
      publisher:       src.publisher,
      source_type:     src.source_type,   // hint; Layer 3 may refine
      trust_tier:      src.trust_tier,
      is_curated:      true,
      date_published:  new Date(src.date_published).toISOString(),
      date_confidence: "exact",
      full_text,
      summary,
      analyst_brief:   fallback || summary,
      source_origin:   "curated_search",
    };

    const { error } = await supabase.from("sources").upsert(row, { onConflict: "id" });
    if (error) {
      process.stdout.write(`FAIL (DB: ${error.message.slice(0, 60)})\n`);
      failed++;
    } else {
      process.stdout.write("SAVED\n");
      imported.push(row);
    }
  }

  console.log(`\nImported: ${imported.length}  Skipped: ${skipped}  Failed: ${failed}\n`);

  if (imported.length > 0 && !DRY_RUN) {
    console.log("Running Layer 4 understand + importance scoring...\n");
    try {
      const { relevant, discarded } = await understandAllSources(imported, {
        skipLlm: false,
        supabase,
        concurrency: 2,
      });
      console.log(`Understand complete: ${relevant.length} classified, ${discarded.length} discarded`);
    } catch (err) {
      console.warn("Layer 4 failed (sources saved, classification skipped):", err.message);
    }
  }
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
