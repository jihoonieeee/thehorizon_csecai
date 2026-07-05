#!/usr/bin/env node
/**
 * ingestCriticalFindings2025b.js — second curated batch of high-priority
 * AI threat incidents and operational intelligence, 2025 Q1 – mid-2026.
 *
 * Covers: Bybit/$1.5B Lazarus heist, Scattered Spider UK retail attacks,
 * DPRK fake IT workers, EchoLeak zero-click Copilot, AI phishing surge,
 * LLM agents autonomously exploiting zero-days, RAG poisoning taxonomy,
 * Mexican gov breach (Claude Code), HexStrike-AI, GTIG vulnerability report.
 *
 * Usage:
 *   node scripts/ingestCriticalFindings2025b.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { extractPdfText } from "../lib/pipeline/ingest/connectors/pdfConnector.js";
import { fetchPageText, extractDateFromHtml } from "../lib/pipeline/discovery/fetchCandidateText.js";
import { understandAllSources } from "../lib/pipeline/understandSource.js";

const DRY_RUN = process.argv.includes("--dry-run");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function makeId(url) {
  return createHash("sha256").update(url.toLowerCase().trim()).digest("hex").slice(0, 36);
}
async function alreadyExists(id) {
  const { data } = await supabase.from("sources").select("id").eq("id", id).maybeSingle();
  return !!data;
}

const SOURCES = [

  // ══════════════════════════════════════════════════════════════════════════
  // AI-ENABLED THREATS
  // ══════════════════════════════════════════════════════════════════════════

  // Bybit $1.5B Lazarus heist — largest crypto theft ever
  {
    name:          "BleepingComputer: FBI Confirms Lazarus Hackers Behind $1.5B Bybit Crypto Heist",
    url:           "https://www.bleepingcomputer.com/news/security/fbi-confirms-lazarus-hackers-were-behind-15b-bybit-crypto-heist/",
    publisher:     "BleepingComputer",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-03-01",
  },
  {
    name:          "Picus Security: FBI Confirms North Korean Lazarus Group Behind $1.5B Bybit Crypto Heist",
    url:           "https://www.picussecurity.com/resource/blog/fbi-north-korean-lazarus-group-bybit-crypto-heist",
    publisher:     "Picus Security",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-03-01",
  },
  {
    name:          "CSIS: The Bybit Heist and the Future of US Crypto Regulation",
    url:           "https://www.csis.org/analysis/bybit-heist-and-future-us-crypto-regulation",
    publisher:     "CSIS",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-03-01",
  },
  {
    name:          "Expel: Inside Lazarus — How North Korea Uses AI to Industrialize Attacks on Developers",
    url:           "https://expel.com/blog/inside-lazarus-how-north-korea-uses-ai-to-industrialize-attacks-on-developers/",
    publisher:     "Expel",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-09-01",
  },

  // Scattered Spider UK retail attacks — M&S, Co-op, Harrods (£440M)
  {
    name:          "The Hacker News: Scattered Spider Behind Cyberattacks on M&S and Co-op Causing $592M in Damages",
    url:           "https://thehackernews.com/2025/06/scattered-spider-behind-cyberattacks-on.html",
    publisher:     "The Hacker News",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-06-01",
  },
  {
    name:          "The Hacker News: Four Arrested in £440M Cyber Attack on Marks & Spencer, Co-op and Harrods",
    url:           "https://thehackernews.com/2025/07/four-arrested-in-440m-cyber-attack-on.html",
    publisher:     "The Hacker News",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-07-01",
  },
  {
    name:          "The Hacker News: Google Warns Scattered Spider Targeting IT Support Teams at US Insurance Firms",
    url:           "https://thehackernews.com/2025/06/google-warns-of-scattered-spider.html",
    publisher:     "The Hacker News",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-06-01",
  },

  // North Korea DPRK fake IT workers
  {
    name:          "Axios: North Korea's IT Worker Fraud Has Fooled Nearly Every Fortune 500 Firm",
    url:           "https://www.axios.com/2025/08/19/north-korea-it-worker-fraud-fortune-500",
    publisher:     "Axios",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-08-19",
  },
  {
    name:          "Microsoft Security Blog: Jasper Sleet — North Korean Remote IT Workers Evolving Tactics to Infiltrate Organizations",
    url:           "https://www.microsoft.com/en-us/security/blog/2025/06/30/jasper-sleet-north-korean-remote-it-workers-evolving-tactics-to-infiltrate-organizations/",
    publisher:     "Microsoft",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-06-30",
  },
  {
    name:          "Fortune: North Korean IT Worker Infiltrations Exploded 220% — Gen AI Weaponized at Every Stage of Hiring",
    url:           "https://fortune.com/2025/08/04/north-korean-it-worker-infiltrations-exploded/",
    publisher:     "Fortune",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-08-04",
  },

  // AI phishing surge
  {
    name:          "Hoxhunt: Phishing Trends Report 2026 — AI-Generated Phishing Surge",
    url:           "https://hoxhunt.com/guide/phishing-trends-report",
    publisher:     "Hoxhunt",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Malwarebytes: AI-Supported Spear Phishing Fools More Than 50% of Targets",
    url:           "https://www.malwarebytes.com/blog/news/2025/01/ai-supported-spear-phishing-fools-more-than-50-of-targets",
    publisher:     "Malwarebytes",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-01-01",
  },

  // Google Cloud GTIG vulnerability exploitation
  {
    name:          "Google Cloud GTIG: Adversaries Leverage AI for Vulnerability Exploitation and Initial Access",
    url:           "https://cloud.google.com/blog/topics/threat-intelligence/ai-vulnerability-exploitation-initial-access",
    publisher:     "Google Threat Intelligence Group",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-10-01",
  },

  // Check Point HexStrike-AI
  {
    name:          "Check Point: HexStrike-AI — When LLMs Meet Real-World Zero-Day Exploitation",
    url:           "https://blog.checkpoint.com/executive-insights/hexstrike-ai-when-llms-meet-zero-day-exploitation/",
    publisher:     "Check Point",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-10-01",
  },

  // Mexican government breach
  {
    name:          "SecurityWeek: Hackers Weaponize Claude Code in Mexican Government Cyberattack",
    url:           "https://www.securityweek.com/hackers-weaponize-claude-code-in-mexican-government-cyberattack/",
    publisher:     "SecurityWeek",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2026-02-01",
  },
  {
    name:          "Security Affairs: Claude Code Abused to Steal 150GB in Cyberattack on Mexican Agencies",
    url:           "https://securityaffairs.com/188696/ai/claude-code-abused-to-steal-150gb-in-cyberattack-on-mexican-agencies.html",
    publisher:     "Security Affairs",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-02-01",
  },
  {
    name:          "TechRadar: Hackers Use Claude and ChatGPT in Significant Evolution in Offensive Capability to Breach Government Agencies",
    url:           "https://www.techradar.com/pro/security/hackers-use-claude-and-chatgpt-in-a-significant-evolution-in-offensive-capability-to-breach-government-agencies-leak-hundreds-of-millions-of-citizen-records",
    publisher:     "TechRadar",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-02-01",
  },

  // Dark Reading — DPRK good year
  {
    name:          "Dark Reading: A Good Year for North Korean Cybercriminals (2025 Review)",
    url:           "https://www.darkreading.com/cyberattacks-data-breaches/good-year-north-korean-cybercriminals",
    publisher:     "Dark Reading",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LLM THREATS
  // ══════════════════════════════════════════════════════════════════════════

  // EchoLeak — zero-click Microsoft 365 Copilot (CVE-2025-32711)
  {
    name:          "arXiv: EchoLeak — First Real-World Zero-Click Prompt Injection Exploit in Production LLM System (CVE-2025-32711)",
    url:           "https://arxiv.org/abs/2509.10540",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2025-09-01",
  },
  {
    name:          "Rescana: CVE-2025-32711 EchoLeak — Zero-Click Microsoft 365 Copilot Stealth Data Exfiltration via Prompt Injection",
    url:           "https://www.rescana.com/post/cve-2025-32711-zero-click-echoleak-vulnerability-in-microsoft-365-copilot-enables-stealth-data-exfiltration-via-prompt-i",
    publisher:     "Rescana",
    source_type:   "exploit_disclosure",
    trust_tier:    "medium",
    main_category: "llm_threats",
    date_published:"2025-09-01",
  },
  {
    name:          "Checkmarx: EchoLeak CVE-2025-32711 Shows AI Security is Challenging",
    url:           "https://checkmarx.com/zero-post/echoleak-cve-2025-32711-show-us-that-ai-security-is-challenging/",
    publisher:     "Checkmarx",
    source_type:   "exploit_disclosure",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2025-09-01",
  },

  // Claude Claude misuse — Malwarebytes cybercrime spree
  {
    name:          "Malwarebytes: Claude AI Chatbot Abused to Launch Cybercrime Spree — Extortion and Ransomware",
    url:           "https://www.malwarebytes.com/blog/news/2025/08/claude-ai-chatbot-abused-to-launch-cybercrime-spree",
    publisher:     "Malwarebytes",
    source_type:   "incident",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2025-08-01",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // AGENTIC AI THREATS
  // ══════════════════════════════════════════════════════════════════════════

  // LLM agents autonomously exploiting zero-days
  {
    name:          "arXiv: Teams of LLM Agents Can Exploit Zero-Day Vulnerabilities Autonomously",
    url:           "https://arxiv.org/abs/2406.01637",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2025-06-01",
  },

  // SOCRadar Mexican government breach
  {
    name:          "SOCRadar: Claude Code and ChatGPT Used to Steal Millions of Records in Mexican Government Breach",
    url:           "https://socradar.io/blog/mexican-government-breach-claude-chatgpt/",
    publisher:     "SOCRadar",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "agentic_ai_threats",
    date_published:"2026-02-01",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRADITIONAL AI THREATS — RAG poisoning, model supply chain
  // ══════════════════════════════════════════════════════════════════════════

  // RAG poisoning taxonomy — authoritative arXiv survey
  {
    name:          "arXiv: Securing Retrieval-Augmented Generation — A Taxonomy of Attacks, Defenses, and Future Directions",
    url:           "https://arxiv.org/abs/2604.08304",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2026-04-01",
  },
  {
    name:          "arXiv: The RAG Paradox — Black-Box Attack Exploiting Unintentional Vulnerabilities in RAG Systems",
    url:           "https://arxiv.org/abs/2502.20995",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2025-02-01",
  },
  {
    name:          "arXiv: AI Security in the Foundation Model Era — Survey of Attacks and Defenses",
    url:           "https://arxiv.org/abs/2603.24857",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "traditional_ai_threats",
    date_published:"2026-03-01",
  },
];

// ── Fetch + persist ───────────────────────────────────────────────────────────

async function fetchText(url) {
  const isPdf = /\.pdf($|\?)/i.test(url);
  if (isPdf) {
    const { full_text } = await extractPdfText(url);
    return { text: full_text || "", html: null };
  }
  let capturedHtml = null;
  const text = await fetchPageText(url, {
    timeoutMs: 15000,
    onRawHtml: (html) => { capturedHtml = html; },
  });
  return { text, html: capturedHtml };
}

async function main() {
  console.log(`\nIngesting ${SOURCES.length} sources (batch 2: 2025 Q1–mid-2026)${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const imported = [];
  let skipped = 0, failed = 0;

  for (const src of SOURCES) {
    const id = makeId(src.url);
    process.stdout.write(`  ${src.name.slice(0, 72).padEnd(72)} `);

    if (!DRY_RUN && await alreadyExists(id)) {
      process.stdout.write("SKIP\n");
      skipped++;
      continue;
    }

    let full_text = "", date_published = src.date_published;
    try {
      const { text, html } = await fetchText(src.url);
      full_text = text;
      if (html) {
        const htmlDate = extractDateFromHtml(html);
        if (htmlDate?.date) {
          const d = new Date(htmlDate.date);
          if (!Number.isNaN(d.getTime())) date_published = d.toISOString().slice(0, 10);
        }
      }
    } catch (err) {
      process.stdout.write(`FAIL (${err.message.slice(0, 50)})\n`);
      failed++;
      continue;
    }

    if (!full_text || full_text.length < 100) {
      process.stdout.write("FAIL (no text)\n");
      failed++;
      continue;
    }

    process.stdout.write(`${full_text.length} chars `);
    if (DRY_RUN) { process.stdout.write("[dry-run]\n"); continue; }

    const row = {
      id,
      title:             src.name,
      url:               src.url,
      publisher:         src.publisher,
      source_type:       src.source_type,
      trust_tier:        src.trust_tier,
      is_curated:        true,
      main_category:     src.main_category,
      date_published:    new Date(date_published).toISOString(),
      date_confidence:   "estimated",
      full_text,
      summary:           full_text.slice(0, 500),
      validation_status: "pass",
      claim_extraction_status: null,
      source_origin:     "curated_search",
    };

    const { error } = await supabase.from("sources").upsert(row, { onConflict: "id" });
    if (error) {
      process.stdout.write(`FAIL (DB: ${error.message.slice(0, 50)})\n`);
      failed++;
    } else {
      process.stdout.write("SAVED\n");
      imported.push(row);
    }
  }

  console.log(`\nImported: ${imported.length}  Skipped: ${skipped}  Failed: ${failed}\n`);

  if (imported.length > 0 && !DRY_RUN) {
    console.log("Running Layer 4 understand + classify...\n");
    const { counts } = await understandAllSources(imported, {
      skipLlm: false, supabase, concurrency: 3,
    });
    console.log("By category:", JSON.stringify(counts.by_category, null, 2));
  }
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
