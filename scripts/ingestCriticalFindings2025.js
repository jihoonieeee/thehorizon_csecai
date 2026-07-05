#!/usr/bin/env node
/**
 * ingestCriticalFindings2025.js — curated batch of high-priority AI threat
 * incidents, findings and frameworks from 2025 Q3 to mid-2026.
 *
 * Sources identified via targeted web search on 2026-07-05.
 * Covers: GTG-1002 espionage, PROMPTFLUX, GitHub Copilot RCE, DeepSeek jailbreak,
 * deepfake fraud campaigns, Hugging Face supply chain, OWASP Agentic Top 10, GTIG reports.
 *
 * Usage:
 *   node scripts/ingestCriticalFindings2025.js [--dry-run]
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

// ── Source list ───────────────────────────────────────────────────────────────

const SOURCES = [

  // ══════════════════════════════════════════════════════════════════════════
  // AI-ENABLED THREATS — AI as weapon, autonomous attack, deepfakes
  // ══════════════════════════════════════════════════════════════════════════

  {
    name:          "Anthropic: Disrupting the First AI-Orchestrated Cyber Espionage Campaign (GTG-1002)",
    url:           "https://www.anthropic.com/news/disrupting-AI-espionage",
    publisher:     "Anthropic",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-09-01",
  },
  {
    name:          "Anthropic: Detecting and Countering AI Misuse — Threat Intelligence Report Aug 2025",
    url:           "https://www.anthropic.com/news/detecting-countering-misuse-aug-2025",
    publisher:     "Anthropic",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-08-01",
  },
  {
    name:          "Google GTIG: Advances in Threat Actor Usage of AI Tools (Nov 2025)",
    url:           "https://cloud.google.com/blog/topics/threat-intelligence/threat-actor-usage-of-ai-tools",
    publisher:     "Google Threat Intelligence Group",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-11-01",
  },
  {
    name:          "Google GTIG: Distillation, Experimentation and Integration of AI for Adversarial Use",
    url:           "https://cloud.google.com/blog/topics/threat-intelligence/distillation-experimentation-integration-ai-adversarial-use",
    publisher:     "Google Threat Intelligence Group",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-09-01",
  },
  {
    name:          "The Hacker News: Google Uncovers PROMPTFLUX Malware That Uses Gemini AI to Rewrite Its Code Hourly",
    url:           "https://thehackernews.com/2025/11/google-uncovers-promptflux-malware-that.html",
    publisher:     "The Hacker News",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-11-05",
  },
  {
    name:          "Security Affairs: Google Sounds Alarm on Self-Modifying AI Malware (PROMPTFLUX)",
    url:           "https://securityaffairs.com/184275/malware/google-sounds-alarm-on-self-modifying-ai-malware.html",
    publisher:     "Security Affairs",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-11-05",
  },
  {
    name:          "Cybersecurity Dive: Anthropic Warns State-Linked Actor Abused Claude in Espionage Campaign",
    url:           "https://www.cybersecuritydive.com/news/anthropic-state-actor-ai-tool-espionage/805550/",
    publisher:     "Cybersecurity Dive",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-09-01",
  },
  {
    name:          "Adaptive Security: 11 Deepfake Attack Examples — Real-World AI Fraud Cases 2025-2026",
    url:           "https://www.adaptivesecurity.com/blog/11-deepfake-attack-examples-2026",
    publisher:     "Adaptive Security",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Keepnet Labs: Deepfake Statistics 2026 — Verified Benchmarks and Risks",
    url:           "https://keepnetlabs.com/blog/deepfake-statistics-and-trends",
    publisher:     "Keepnet Labs",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Cyble: Deepfake-as-a-Service Exploded in 2025 — 2026 Threats Ahead",
    url:           "https://cyble.com/knowledge-hub/deepfake-as-a-service-exploded-in-2025/",
    publisher:     "Cyble",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-12-01",
  },
  {
    name:          "Adversa AI: 2025 AI Security Incidents Report — Generative and Agentic AI Under Attack",
    url:           "https://adversa.ai/blog/adversa-ai-unveils-explosive-2025-ai-security-incidents-report-revealing-how-generative-and-agentic-ai-are-already-under-attack/",
    publisher:     "Adversa AI",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2025-12-01",
  },
  {
    name:          "Reco AI: AI and Cloud Security Breaches — 2025 Year in Review",
    url:           "https://www.reco.ai/blog/ai-and-cloud-security-breaches-2025",
    publisher:     "Reco AI",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "eSecurity Planet: AI Agent Attacks in Q4 2025 Signal New Risks for 2026",
    url:           "https://www.esecurityplanet.com/artificial-intelligence/ai-agent-attacks-in-q4-2025-signal-new-risks-for-2026/",
    publisher:     "eSecurity Planet",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "ai_enabled_threats",
    date_published:"2026-01-01",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // AGENTIC AI THREATS — agent exploits, MCP, coding agent RCE
  // ══════════════════════════════════════════════════════════════════════════

  {
    name:          "Embrace the Red: GitHub Copilot Remote Code Execution via Prompt Injection (CVE-2025-53773)",
    url:           "https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection/",
    publisher:     "Embrace the Red",
    source_type:   "exploit_disclosure",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2025-08-01",
  },
  {
    name:          "Cybersecurity News: GitHub Copilot RCE Vulnerability via Prompt Injection — Full System Compromise",
    url:           "https://cybersecuritynews.com/github-copilot-rce-vulnerability/",
    publisher:     "Cybersecurity News",
    source_type:   "exploit_disclosure",
    trust_tier:    "medium",
    main_category: "agentic_ai_threats",
    date_published:"2025-08-01",
  },
  {
    name:          "Persistent Security: CVE-2025-53773 — VS Code & Copilot Wormable Command Execution via Prompt Injection",
    url:           "https://www.persistent-security.net/post/part-iii-vscode-copilot-wormable-command-execution-via-prompt-injection",
    publisher:     "Persistent Security",
    source_type:   "exploit_disclosure",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2025-08-01",
  },
  {
    name:          "OWASP: Top 10 for Agentic Applications 2026",
    url:           "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/",
    publisher:     "OWASP",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "agentic_ai_threats",
    date_published:"2025-12-01",
  },
  {
    name:          "Palo Alto Networks: OWASP Top 10 for Agentic Applications 2026 — Why It Matters",
    url:           "https://www.paloaltonetworks.com/blog/cloud-security/owasp-agentic-ai-security/",
    publisher:     "Palo Alto Networks",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "Microsoft Security Blog: Addressing OWASP Top 10 Risks in Agentic AI with Copilot Studio",
    url:           "https://www.microsoft.com/en-us/security/blog/2026/03/30/addressing-the-owasp-top-10-risks-in-agentic-ai-with-microsoft-copilot-studio/",
    publisher:     "Microsoft",
    source_type:   "governance_signal",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2026-03-30",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LLM THREATS — jailbreaks, prompt injection, guardrail bypass
  // ══════════════════════════════════════════════════════════════════════════

  {
    name:          "Cisco Security: Evaluating Security Risk in DeepSeek R1 — 100% Jailbreak Success Rate",
    url:           "https://blogs.cisco.com/security/evaluating-security-risk-in-deepseek-and-other-frontier-reasoning-models",
    publisher:     "Cisco",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2025-01-31",
  },
  {
    name:          "OWASP: Top 10 for LLM Applications 2025 (PDF)",
    url:           "https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf",
    publisher:     "OWASP",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "llm_threats",
    date_published:"2025-01-01",
  },
  {
    name:          "Red Dog Security: LLM Security 2026 — Complete Attack Map, Prompt Injection, Jailbreaks, Agentic Exploitation",
    url:           "https://reddogsecurity.substack.com/p/llm-security-in-2026-a-complete-attack",
    publisher:     "Red Dog Security",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "llm_threats",
    date_published:"2026-01-01",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRADITIONAL AI THREATS — supply chain, model poisoning, Hugging Face
  // ══════════════════════════════════════════════════════════════════════════

  {
    name:          "Unit 42: Model Namespace Reuse — AI Supply Chain Attack Exploiting Model Name Trust",
    url:           "https://unit42.paloaltonetworks.com/model-namespace-reuse/",
    publisher:     "Palo Alto Networks / Unit 42",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "traditional_ai_threats",
    date_published:"2025-02-01",
  },
  {
    name:          "Acronis: Poisoning the Well — AI Supply Chain Attacks on Hugging Face and OpenClaw",
    url:           "https://www.acronis.com/en/tru/posts/poisoning-the-well-ai-supply-chain-attacks-on-hugging-face-and-openclaw/",
    publisher:     "Acronis",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "traditional_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "NSFOCUS: AI Supply Chain Security — Hugging Face Malicious ML Models",
    url:           "https://nsfocusglobal.com/ai-supply-chain-security-hugging-face-malicious-ml-models/",
    publisher:     "NSFOCUS",
    source_type:   "threat_intelligence",
    trust_tier:    "medium",
    main_category: "traditional_ai_threats",
    date_published:"2025-06-01",
  },
  {
    name:          "The Next Web: Hugging Face and ClawHub Compromised with Malicious AI Models — Supply Chain Attacks",
    url:           "https://thenextweb.com/news/hugging-face-clawhub-malware-ai-supply-chain",
    publisher:     "The Next Web",
    source_type:   "incident",
    trust_tier:    "medium",
    main_category: "traditional_ai_threats",
    date_published:"2026-01-01",
  },
  {
    name:          "arXiv: Surveying Operational Cybersecurity and Supply Chain Threats in AI Development and Deployment",
    url:           "https://arxiv.org/abs/2508.20307",
    publisher:     "arXiv",
    source_type:   "research_finding",
    trust_tier:    "high",
    main_category: "traditional_ai_threats",
    date_published:"2025-08-01",
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
  console.log(`\nIngesting ${SOURCES.length} critical findings (2025 Q3 – mid-2026)${DRY_RUN ? " [DRY RUN]" : ""}\n`);

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
      // Upgrade date from HTML metadata when available
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
    const { relevant, discarded, counts } = await understandAllSources(imported, {
      skipLlm: false,
      supabase,
      concurrency: 3,
    });
    console.log(`\nUnderstand: ${relevant.length} relevant, ${discarded.length} discarded`);
    console.log("By category:", JSON.stringify(counts.by_category, null, 2));
  }
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
