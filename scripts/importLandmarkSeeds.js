#!/usr/bin/env node
/**
 * importLandmarkSeeds.js — import the curated LANDMARK_SEEDS (lib/config/
 * landmarkSeeds.js) into the corpus.
 *
 * The seeds are hand-verified, high-value reference URLs (MITRE ATLAS, NIST AML
 * taxonomy, agency guidance, landmark incidents) that arXiv/NVD structurally
 * under-supply. There was no importer for them — this is it. Each seed is
 * fetched (PDF via Anthropic Files API, else HTML → section extractor),
 * normalized, run through Layer-3 validation (relevance + typing), and persisted.
 *
 * main_category is left null so the classify layer re-derives it (the seed's
 * `category` field is documentation only, per landmarkSeeds.js).
 *
 * Usage:
 *   node scripts/importLandmarkSeeds.js --dry     # fetch + validate, print, no write
 *   node scripts/importLandmarkSeeds.js           # import + persist
 *   node scripts/importLandmarkSeeds.js --new      # only the 2026-07-09 traditional-AI anchors
 */

import "dotenv/config";
import { LANDMARK_SEEDS } from "../lib/config/landmarkSeeds.js";
import { normalizeSource } from "../lib/pipeline/ingest/normalizeSource.js";
import { validateAndTypeSources } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import { looksLikePdf, extractPdfText } from "../lib/pipeline/ingest/connectors/pdfConnector.js";
import { extractDocumentSections } from "../lib/pipeline/ingest/extractDocumentSections.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const DRY = process.argv.includes("--dry");
const NEW_ONLY = process.argv.includes("--new");

// The 4 traditional-AI anchors added 2026-07-09 (identified by URL substring),
// with their real publication dates so they don't get a fabricated recent date.
const NEW_URLS = ["atlas.mitre.org", "csrc.nist.gov/pubs/ai/100/2", "guidelines-secure-ai-system-development", "red-teaming-100-generative-ai-products"];
const KNOWN_DATES = {
  "csrc.nist.gov/pubs/ai/100/2": "2025-03-24",
  "guidelines-secure-ai-system-development": "2023-11-27",
  "red-teaming-100-generative-ai-products": "2025-01-13",
  // MITRE ATLAS is a living knowledge base — no single date; left as estimated.
};

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchText(url) {
  try {
    if (looksLikePdf(url)) {
      const r = await extractPdfText(url);
      return r.full_text || "";
    }
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!res.ok) return "";
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("pdf")) { const r = await extractPdfText(url); return r.full_text || ""; }
    const html = await res.text();
    if (!html || html.length < 300) return "";
    const { text } = extractDocumentSections(html, { url, maxChars: 15000 });
    return text || "";
  } catch (e) {
    console.log(`    fetch failed: ${e.message.slice(0, 60)}`);
    return "";
  }
}

function dateFor(url) {
  for (const [frag, date] of Object.entries(KNOWN_DATES)) if (url.includes(frag)) return date;
  return null;
}

async function main() {
  const seeds = NEW_ONLY ? LANDMARK_SEEDS.filter(s => NEW_URLS.some(u => s.url.includes(u))) : LANDMARK_SEEDS;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Landmark Seed Import — ${seeds.length} seeds${NEW_ONLY ? " (new traditional-AI anchors)" : ""}${DRY ? "  [DRY RUN]" : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  const raw = [];
  for (const seed of seeds) {
    process.stdout.write(`  • ${seed.publisher}: ${seed.title.slice(0, 55)}… `);
    const full_text = await fetchText(seed.url);
    const date = dateFor(seed.url);
    process.stdout.write(`${full_text.length} chars\n`);
    raw.push(normalizeSource({
      title:           seed.title,
      url:             seed.url,
      publisher:       seed.publisher,
      author:          seed.publisher,
      date_published:  date,
      date_confidence: date ? "exact" : "estimated",
      source_type:     seed.source_type,
      full_text,
      trust_tier:      "primary",
      collection_metadata: {
        connector_name:   "landmark_seed",
        retrieval_method: "curated_seed",
        trust_tier:       "primary",
        seed_category:    seed.category,
        date_accessed:    new Date().toISOString(),
      },
    }));
  }

  const usable = raw.filter(s => (s.full_text || "").length > 200);
  console.log(`\n  ${usable.length}/${raw.length} fetched usable text (>200 chars)`);
  if (usable.length < raw.length) {
    for (const s of raw) if ((s.full_text || "").length <= 200) console.log(`    ⚠ thin: ${s.publisher} — ${s.url}`);
  }

  const { accepted, rejected, stats } = await validateAndTypeSources(usable, {});
  console.log(`\n  Layer 3: ${accepted.length} accepted, ${rejected.length} rejected`);
  for (const s of accepted) console.log(`    ✓ ${s.publisher}: ${(s.validation_summary || s.short_summary || "").slice(0, 80)}`);
  for (const s of rejected) console.log(`    ✗ ${s.publisher}: ${(s.final_validity_reason || s.validation_summary || "rejected").slice(0, 80)}`);

  if (DRY) { console.log("\n  DRY RUN — nothing written.\n"); await flushCostBuffer(); return; }
  if (!accepted.length) { console.log("\n  Nothing accepted — nothing to persist.\n"); await flushCostBuffer(); return; }

  // Landmark refs are timeless; give the snapshot a wide window covering the
  // seeds' publication span so getSnapshotDateKey / snapshot row build succeed.
  const now = new Date();
  const twoYearsAgo = new Date(now.getTime() - 730 * 86400000);
  await saveSnapshotToDatabase({
    generated_at:     now.toISOString(),
    period:           "landmark",
    stage:            "landmark_seed_import",
    reporting_window: { start_utc: twoYearsAgo.toISOString(), end_utc: now.toISOString() },
    count:            accepted.length,
    sources:          accepted,
  });
  console.log(`\n  ✓ Persisted ${accepted.length} landmark sources.\n`);
  await flushCostBuffer();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
