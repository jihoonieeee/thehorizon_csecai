#!/usr/bin/env node
/**
 * importCuratedPdfs.js — Ingest specific PDF threat intelligence reports
 * directly from URL, bypassing RSS. Uses the PDF connector (Anthropic Files
 * API + Haiku extraction) to get full text.
 *
 * Known high-value reports are defined in CURATED_PDFS below.
 * Add new entries there; they will be skipped if already in the DB.
 *
 * Usage:
 *   node scripts/importCuratedPdfs.js [--dry-run] [--label <partial-name>]
 *
 * --dry-run   : extract text and print, don't write to DB
 * --label X   : only process entries whose name contains X (case-insensitive)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash }   from "crypto";
import { extractPdfText, looksLikePdf } from "../lib/pipeline/ingest/connectors/pdfConnector.js";
import { normalizeSource } from "../lib/pipeline/ingest/normalizeSource.js";

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const labelFilter = (() => { const i = args.indexOf("--label"); return i >= 0 ? args[i+1]?.toLowerCase() : null; })();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Curated PDF report list ───────────────────────────────────────────────────
// Add new reports here. date_published: the report's publication date (YYYY-MM-DD).
// main_category hint is used if Layer 3 LLM doesn't assign one.

const CURATED_PDFS = [
  // ── Government / Primary ───────────────────────────────────────────────────
  {
    name:          "CISA/NSA: Deploying AI Systems Securely",
    url:           "https://media.defense.gov/2024/Apr/15/2003439257/-1/-1/0/CSI-DEPLOYING-AI-SYSTEMS-SECURELY.PDF",
    publisher:     "CISA",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "agentic_ai_threats",
    date_published:"2024-04-15",
  },
  {
    name:          "NIST AI 100-1: Artificial Intelligence Risk Management Framework",
    url:           "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf",
    publisher:     "NIST",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "traditional_ai_threats",
    date_published:"2023-01-26",
  },
  {
    name:          "NIST AI 100-2: Adversarial Machine Learning Taxonomy",
    url:           "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2023.pdf",
    publisher:     "NIST",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "traditional_ai_threats",
    date_published:"2023-03-08",
  },
  {
    name:          "NCSC UK: Cyber Threat Landscape 2024",
    url:           "https://www.ncsc.gov.uk/files/NCSC-Annual-Review-2024.pdf",
    publisher:     "UK National Cyber Security Centre",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2024-11-01",
  },

  // ── Vendor Threat Intelligence ─────────────────────────────────────────────
  {
    name:          "Google Cloud: Threat Horizons Report H1 2025",
    url:           "https://services.google.com/fh/files/misc/gcat_threathorizons_full_h12025.pdf",
    publisher:     "Google Cloud / Mandiant",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2025-04-01",
  },
  {
    name:          "Google Cloud: Threat Horizons Report H2 2024",
    url:           "https://services.google.com/fh/files/misc/gcat_threathorizons_full_h22024.pdf",
    publisher:     "Google Cloud / Mandiant",
    source_type:   "threat_intelligence",
    trust_tier:    "high",
    main_category: "ai_enabled_threats",
    date_published:"2024-10-01",
  },
  {
    name:          "OpenAI: Preparedness Framework",
    url:           "https://cdn.openai.com/openai-preparedness-framework-beta.pdf",
    publisher:     "OpenAI",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "llm_threats",
    date_published:"2023-12-18",
  },
  {
    name:          "OpenAI: Disrupting Deceptive Uses of AI in Influence Operations",
    url:           "https://cdn.openai.com/threat-intelligence-reports/disrupting-deceptive-uses-of-ai-by-covert-influence-operations_july-2024.pdf",
    publisher:     "OpenAI",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2024-07-30",
  },
  {
    name:          "AWS Well-Architected: Agentic AI Lens",
    url:           "https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/wellarchitected-agentic-ai-lens.pdf",
    publisher:     "Amazon Web Services",
    source_type:   "governance_signal",
    trust_tier:    "high",
    main_category: "agentic_ai_threats",
    date_published:"2025-11-01",
  },

  // ── Research / Taxonomy ────────────────────────────────────────────────────
  {
    name:          "MITRE ATLAS: Adversarial Threat Landscape for AI Systems",
    url:           "https://atlas.mitre.org/resources/atlas.pdf",
    publisher:     "MITRE",
    source_type:   "research_finding",
    trust_tier:    "primary",
    main_category: "traditional_ai_threats",
    date_published:"2023-09-01",
  },
  {
    name:          "OWASP LLM Top 10 v1.1",
    url:           "https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-2023-v1_1.pdf",
    publisher:     "OWASP",
    source_type:   "governance_signal",
    trust_tier:    "high",
    main_category: "llm_threats",
    date_published:"2023-10-16",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

async function alreadyExists(id) {
  const { data } = await supabase.from("sources").select("id").eq("id", id).maybeSingle();
  return !!data;
}

async function fetchHtmlText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; the-horizon-ingester/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/pdf",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { text: "", status: res.status };
    const ctype = (res.headers?.get("content-type") || "").toLowerCase();
    if (ctype.includes("pdf")) return { text: "", isPdf: true };
    const html = await res.text();
    // Simple text extraction — strip tags, collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/")
      .replace(/\s+/g, " ").trim().slice(0, 12000);
    return { text, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { text: "", error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const toProcess = labelFilter
    ? CURATED_PDFS.filter(r => r.name.toLowerCase().includes(labelFilter))
    : CURATED_PDFS;

  console.log(`\nCurated PDF import — ${toProcess.length} reports${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  let imported = 0, skipped = 0, failed = 0;

  for (const report of toProcess) {
    const id = makeId(report.url);
    process.stdout.write(`  ${report.name.slice(0, 65).padEnd(65)} `);

    if (!DRY_RUN && await alreadyExists(id)) {
      process.stdout.write("SKIP (already in DB)\n");
      skipped++;
      continue;
    }

    // Extract text
    let full_text = "";
    try {
      if (looksLikePdf(report.url)) {
        const { full_text: t } = await extractPdfText(report.url);
        full_text = t || "";
      } else {
        const { text, isPdf } = await fetchHtmlText(report.url);
        if (isPdf) {
          const { full_text: t } = await extractPdfText(report.url);
          full_text = t || "";
        } else {
          full_text = text;
        }
      }
    } catch (err) {
      process.stdout.write(`FAIL (${err.message.slice(0, 60)})\n`);
      failed++;
      continue;
    }

    if (!full_text || full_text.length < 100) {
      process.stdout.write("FAIL (no text extracted)\n");
      failed++;
      continue;
    }

    process.stdout.write(`${full_text.length} chars `);

    if (DRY_RUN) {
      process.stdout.write("[dry-run, not saved]\n");
      console.log(`    Preview: ${full_text.slice(0, 200).replace(/\n/g, " ")}...\n`);
      continue;
    }

    const row = {
      id,
      title:          report.name,
      url:            report.url,
      publisher:      report.publisher,
      source_type:    report.source_type,
      trust_tier:     report.trust_tier,
      main_category:  report.main_category,
      date_published: new Date(report.date_published).toISOString(),
      full_text,
      summary:        full_text.slice(0, 500),
      validation_status: "pass",       // curated — bypasses Layer 3
      claim_extraction_status: null,   // understandCorpus will process these
    };

    const { error } = await supabase.from("sources").upsert(row, { onConflict: "id" });
    if (error) {
      process.stdout.write(`FAIL (DB: ${error.message.slice(0, 60)})\n`);
      failed++;
    } else {
      process.stdout.write("SAVED\n");
      imported++;
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${failed} failed`);
  if (imported > 0 && !DRY_RUN) {
    console.log("Run enrichment next:  node scripts/understandCorpus.js --concurrency 2");
  }
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
