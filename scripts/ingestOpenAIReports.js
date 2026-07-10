#!/usr/bin/env node
/**
 * ingestOpenAIReports.js — ingest OpenAI's "Disrupting malicious uses of AI"
 * threat intelligence report series into the corpus.
 *
 * Reports are pulled as PDFs (richer text) where available, falling back to
 * the web page. Each report covers a distinct period of observed misuse.
 *
 * Usage:
 *   node scripts/ingestOpenAIReports.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { extractPdfText } from "../lib/pipeline/ingest/connectors/pdfConnector.js";
import { fetchPageText, extractDateFromHtml } from "../lib/pipeline/discovery/fetchCandidateText.js";
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

// ── Source list ───────────────────────────────────────────────────────────────
// PDF URLs used where available — they carry the full multi-page report text
// rather than the truncated web summary.

const SOURCES = [
  {
    name:          "OpenAI: Disrupting Malicious Uses of AI — October 2025",
    // Use the PDF for full report text
    url:           "https://cdn.openai.com/threat-intelligence-reports/7d662b68-952f-4dfd-a2f2-fe55b041cc4a/disrupting-malicious-uses-of-ai-october-2025.pdf",
    publisher:     "OpenAI",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-10-01",
  },
  {
    name:          "OpenAI: Disrupting Malicious Uses of AI — June 2025",
    url:           "https://cdn.openai.com/threat-intelligence-reports/5f73af09-a3a3-4a55-992e-069237681620/disrupting-malicious-uses-of-ai-june-2025.pdf",
    publisher:     "OpenAI",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-06-01",
  },
  {
    name:          "OpenAI: Disrupting Deceptive Uses of AI — Feb 2025 (State Actors Update)",
    url:           "https://openai.com/global-affairs/an-update-on-disrupting-deceptive-uses-of-ai/",
    publisher:     "OpenAI",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2025-02-01",
  },
  {
    name:          "OpenAI: Disrupting Malicious Uses of AI by State-Affiliated Threat Actors — Feb 2024",
    url:           "https://openai.com/index/disrupting-malicious-uses-of-ai-by-state-affiliated-threat-actors/",
    publisher:     "OpenAI",
    source_type:   "threat_intelligence",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2024-02-14",
  },
  {
    name:          "OpenAI Cybersecurity Action Plan — April 2026",
    url:           "https://cdn.openai.com/pdf/7ca95dce-4424-4b62-9eab-89233bb38f82/oai-cybersecurity-action-plan.pdf",
    publisher:     "OpenAI",
    source_type:   "governance_signal",
    trust_tier:    "primary",
    main_category: "ai_enabled_threats",
    date_published:"2026-04-01",
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
  console.log(`\nIngesting ${SOURCES.length} OpenAI threat intelligence reports${DRY_RUN ? " [DRY RUN]" : ""}\n`);

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
    const { relevant, discarded, counts } = await understandAllSources(imported, {
      skipLlm: false,
      supabase,
      concurrency: 2,
    });
    console.log(`\nUnderstand: ${relevant.length} relevant, ${discarded.length} discarded`);
    console.log("By category:", JSON.stringify(counts.by_category, null, 2));
  }
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
