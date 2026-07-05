#!/usr/bin/env node
/**
 * ingestSearchFindings.js — one-shot ingestion of manually curated search findings.
 *
 * Sources were identified via web search on 2026-07-04 covering high-impact
 * incidents, exploits, and attack chains from 2025 Q3 to now.
 *
 * Usage:
 *   node scripts/ingestSearchFindings.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash }   from "crypto";
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

// ── Source list ───────────────────────────────────────────────────────────────
const SOURCES = [
  // ── Primary authority ──────────────────────────────────────────────────────
  {
    name:          "NSA/DoD: Model Context Protocol (MCP) Security Design Advisory",
    url:           "https://media.defense.gov/2026/Jun/02/2003943289/-1/-1/0/CSI_MCP_SECURITY.PDF",
    publisher:     "NSA / CISA",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "agentic_ai_threats",
    date_published:"2026-06-02",
  },

  // ── High-trust vendor threat intelligence ─────────────────────────────────
  {
    name:          "Google Cloud / GTIG: 2025 Zero-Day Vulnerability Review",
    url:           "https://cloud.google.com/blog/topics/threat-intelligence/2025-zero-day-review",
    publisher:     "Google Cloud / Mandiant",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "HP Wolf Security: Zero-Day Vulnerabilities Exploited in Malware Campaigns 2025",
    url:           "https://threatresearch.ext.hp.com/reviewing-zero-day-vulnerabilities-exploited-in-malware-campaigns-in-2025/",
    publisher:     "HP Wolf Security",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Unit 42 / Palo Alto: AI Agent Indirect Prompt Injection Observed in the Wild",
    url:           "https://unit42.paloaltonetworks.com/ai-agent-prompt-injection/",
    publisher:     "Palo Alto Networks / Unit 42",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "AuthZed: Timeline of Model Context Protocol (MCP) Security Breaches",
    url:           "https://authzed.com/blog/timeline-mcp-breaches",
    publisher:     "AuthZed",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Outpost24: Lessons From 2025 — Zero-Day Exploits Shaping 2026",
    url:           "https://outpost24.com/blog/top-zero-day-exploits-2025/",
    publisher:     "Outpost24",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },

  // ── Research / academic ───────────────────────────────────────────────────
  {
    name:          "arXiv: MCP Threat Modeling and Prompt Injection with Tool Poisoning",
    url:           "https://arxiv.org/abs/2603.22489",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2026-03-01",
  },

  // ── Medium-trust security news ─────────────────────────────────────────────
  {
    name:          "The Hacker News: 2026 — The Year of AI-Assisted Attacks",
    url:           "https://thehackernews.com/2026/05/2026-year-of-ai-assisted-attacks.html",
    publisher:     "The Hacker News",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-05-01",
  },
  {
    name:          "Help Net Security: Prompt Injection Still Drives Most Agentic AI Security Failures",
    url:           "https://www.helpnetsecurity.com/2026/06/11/owasp-prompt-injection-ai-security-failures/",
    publisher:     "Help Net Security",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "llm_threats",
    date_published:"2026-06-11",
  },
  {
    name:          "Infosecurity Magazine: Top 10 Cyber-Attacks of 2025",
    url:           "https://www.infosecurity-magazine.com/news-features/top-10-cyberattacks-of-2025/",
    publisher:     "Infosecurity Magazine",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Security Boulevard: Inside the Biggest Cyber Attacks of 2025",
    url:           "https://securityboulevard.com/2025/12/inside-the-biggest-cyber-attacks-of-2025/",
    publisher:     "Security Boulevard",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-12-01",
  },
  {
    name:          "Beam AI: 5 Real AI Agent Security Breaches in 2026 and Their Lessons",
    url:           "https://beam.ai/agentic-insights/ai-agent-security-breaches-2026-lessons",
    publisher:     "Beam AI",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "agentic_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "VulnerableMCP: Comprehensive MCP Security Vulnerability Database",
    url:           "https://vulnerablemcp.info/",
    publisher:     "VulnerableMCP Project",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "agentic_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "AI Hacking: AI Security Incidents Breach Log & Timeline 2026",
    url:           "https://ai-hacking.cyberchaos.nl/incidents",
    publisher:     "AI Hacking / CyberChaos",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "agentic_ai_threats",
    date_published:"2026-01-01",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nIngesting ${SOURCES.length} search-curated sources${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const imported = [];
  let skipped = 0, failed = 0;

  for (const src of SOURCES) {
    const id = makeId(src.url);
    process.stdout.write(`  ${src.name.slice(0, 70).padEnd(70)} `);

    if (!DRY_RUN && await alreadyExists(id)) {
      process.stdout.write("SKIP\n");
      skipped++;
      continue;
    }

    // Fetch text — PDF or HTML
    let full_text = "";
    let date_published = src.date_published;
    const isPdf = /\.pdf($|\?)/i.test(src.url);

    try {
      if (isPdf) {
        const { full_text: t } = await extractPdfText(src.url);
        full_text = t || "";
      } else {
        let capturedHtml = null;
        const text = await fetchPageText(src.url, {
          timeoutMs: 15000,
          onRawHtml: (html) => { capturedHtml = html; },
        });
        full_text = text;
        // Upgrade date if HTML metadata is more authoritative
        if (capturedHtml) {
          const htmlDate = extractDateFromHtml(capturedHtml);
          if (htmlDate?.date) {
            const d = new Date(htmlDate.date);
            if (!Number.isNaN(d.getTime())) date_published = d.toISOString().slice(0, 10);
          }
        }
      }
    } catch (err) {
      process.stdout.write(`FAIL (${err.message.slice(0, 60)})\n`);
      failed++;
      continue;
    }

    if (!full_text || full_text.length < 100) {
      process.stdout.write("FAIL (no text)\n");
      failed++;
      continue;
    }

    process.stdout.write(`${full_text.length} chars `);

    if (DRY_RUN) {
      process.stdout.write("[dry-run]\n");
      continue;
    }

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
      process.stdout.write(`FAIL (DB: ${error.message.slice(0, 60)})\n`);
      failed++;
    } else {
      process.stdout.write("SAVED\n");
      imported.push(row);
    }
  }

  console.log(`\nImported: ${imported.length}  Skipped: ${skipped}  Failed: ${failed}\n`);

  // ── Layer 4 understand + classify ─────────────────────────────────────────
  if (imported.length > 0 && !DRY_RUN) {
    console.log("Running Layer 4 understand + classify on imported sources...\n");
    const { relevant, discarded, counts } = await understandAllSources(imported, {
      skipLlm: false,
      supabase,
      concurrency: 3,
    });
    console.log(`\nUnderstand complete: ${relevant.length} relevant, ${discarded.length} discarded`);
    console.log("Counts:", JSON.stringify(counts, null, 2));
  }
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
