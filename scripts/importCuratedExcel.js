import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import XLSX from "xlsx";
import { supabase } from "../lib/storage/supabaseClient.js";
import { uploadArchiveJson } from "../lib/storage/blobArchiveStore.js";
import { cleanPlaintext } from "../lib/pipeline/clean/cleanPlaintext.js";
import { checkSourceValidity } from "../lib/pipeline/ingest/sourceValidity.js";

const FILE_PATH = process.argv[2];

if (!FILE_PATH) {
  throw new Error("Usage: node scripts/importCuratedExcel.js <path-to-xlsx>");
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function inferTrustTier(publisher = "") {
  const p = publisher.toLowerCase();
  if (
    p.includes("cisa") || p.includes("nist") || p.includes("ncsc") ||
    p.includes("enisa") || p.includes("anthropic") || p.includes("openai") ||
    p.includes("csa") || p.includes("white house") || p.includes("government")
  ) return "primary";
  if (
    p.includes("google") || p.includes("microsoft") || p.includes("crowdstrike") ||
    p.includes("unit 42") || p.includes("palo alto") || p.includes("owasp") ||
    p.includes("arxiv") || p.includes("mandiant") || p.includes("trail of bits") ||
    p.includes("recorded future") || p.includes("sentinelone") || p.includes("elastic") ||
    p.includes("university") || p.includes("ieee") || p.includes("acm")
  ) return "high";
  return "medium";
}

function publisherFromUrl(rawUrl = "") {
  try {
    const host = new URL(rawUrl).hostname.replace("www.", "");

    if (host.includes("thehackernews")) return "The Hacker News";
    if (host.includes("darkreading")) return "Dark Reading";
    if (host.includes("cloud.google")) return "Google Cloud Threat Intelligence";
    if (host.includes("microsoft")) return "Microsoft";
    if (host.includes("cisa")) return "CISA";
    if (host.includes("nist")) return "NIST";
    if (host.includes("owasp")) return "OWASP";
    if (host.includes("arxiv")) return "arXiv";

    return host;
  } catch {
    return "Unknown";
  }
}

function parseDate(value) {
  if (!value) return null;

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000).toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceTypeFromPublisher(publisher) {
  if (publisher.includes("Google Cloud")) return "threat_intelligence_report";
  if (publisher.includes("Microsoft")) return "threat_intelligence_report";
  if (publisher.includes("CISA")) return "government_advisory";
  if (publisher.includes("NIST")) return "standards_document";
  if (publisher.includes("OWASP")) return "standards_document";
  if (publisher.includes("arXiv")) return "research_paper";
  return "security_blog";
}

function tagsFromSheet(sheetName) {
  // v2: tags are assigned by the classify-only pass (L4). Leave empty so the
  // LLM assigns proper taxonomy tags. The sheet hint is preserved in main_category.
  return [];
}

function baselineFromSheet(sheetName) {
  // Set main_category to null so classify-only runs on every curated source.
  // Sheet names give a strong signal but the v2 AE gate must still verify.
  // trust_tier is set per-source by inferTrustTier() — not overridden here.
  return { main_category: null };
}

function getSgtWindowForDate(dateIso) {
  const date = new Date(dateIso);
  const sgtMs = date.getTime() + 8 * 60 * 60 * 1000;
  const sgt = new Date(sgtMs);

  const y = sgt.getUTCFullYear();
  const m = sgt.getUTCMonth();
  const d = sgt.getUTCDate();
  const hour = sgt.getUTCHours();

  let endSgt = new Date(Date.UTC(y, m, d, 6, 0, 0));

  if (hour >= 6) {
    endSgt = new Date(endSgt.getTime() + 24 * 60 * 60 * 1000);
  }

  const startSgt = new Date(endSgt.getTime() - 24 * 60 * 60 * 1000);

  return {
    timezone: "Asia/Singapore",
    start_sgt: startSgt.toISOString(),
    end_sgt: endSgt.toISOString(),
    start_utc: new Date(startSgt.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    end_utc: new Date(endSgt.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function snapshotIdFromWindow(window) {
  return `snapshot-${window.end_sgt.slice(0, 10)}`;
}

if (!fs.existsSync(FILE_PATH)) {
  throw new Error(`File not found: ${FILE_PATH}`);
}

const workbook = XLSX.readFile(FILE_PATH);
const acceptedSheets = ["Security of AI", "AI for Cyber", "AI-Enabled Threats"];

const rows = [];

for (const sheetName of acceptedSheets) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) continue;

  const data = XLSX.utils.sheet_to_json(sheet);

  const baseline = baselineFromSheet(sheetName);

  for (const row of data) {
    const title = cleanPlaintext(row.Title);
    const url = cleanPlaintext(row.URL);
    const summary = cleanPlaintext(row.Summary);
    const content = cleanPlaintext(row.Content);
    const date_published = parseDate(row.Published);

    if (!title || !url || !date_published) continue;

    const publisher = publisherFromUrl(url);
    const usableText = content || summary || "";
    const content_hash = sha256(`${title}|${url}|${usableText}`);

    rows.push({
      id: `curated-${content_hash.slice(0, 24)}`,
      title,
      url,
      publisher,
      date_published,
      source_type: sourceTypeFromPublisher(publisher),
      trust_tier: inferTrustTier(publisher),
      sheet_category: sheetName,
      full_text: usableText,
      summary,
      source_text_quality: content ? "partial_text" : "summary_only",
      needs_full_text_fetch: true,
      tags: tagsFromSheet(sheetName),
      content_hash,
      clean_text_hash: sha256(usableText),
      ...baseline,
    });
  }
}

console.log(`Parsed ${rows.length} curated rows`);

const dedupedRows = [...new Map(rows.map((row) => [row.id, row])).values()];

console.log(`After dedupe: ${dedupedRows.length} curated rows`);

if (dedupedRows.length === 0) {
  process.exit(0);
}

const { error: curatedError } = await supabase
  .from("curated_sources")
  .upsert(
    dedupedRows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      publisher: row.publisher,
      date_published: row.date_published,
      source_type: row.source_type,
      sheet_category: row.sheet_category,
      content: row.full_text,
      summary: row.summary,
      tags: row.tags,
      content_hash: row.content_hash,
    })),
    { onConflict: "id" }
  );

if (curatedError) throw curatedError;

const grouped = new Map();

for (const row of dedupedRows) {
  const window = getSgtWindowForDate(row.date_published);
  const snapshotId = snapshotIdFromWindow(window);

  if (!grouped.has(snapshotId)) {
    grouped.set(snapshotId, {
      snapshot_id: snapshotId,
      window,
      sources: [],
    });
  }

  grouped.get(snapshotId).sources.push(row);
}

for (const group of grouped.values()) {
  // Run real validity checks on all sources in this group concurrently.
  const validities = await Promise.all(
    group.sources.map((row) => checkSourceValidity(row))
  );

  // Drop sources that fail the hard gates (missing title, unsafe URL, etc.).
  const validSources = group.sources.filter((_, i) => validities[i].usable);
  const discarded = group.sources.length - validSources.length;

  if (discarded > 0) {
    console.warn(`  [${group.snapshot_id}] Discarded ${discarded} invalid curated sources (failed validation)`);
  }

  const snapshot = {
    snapshot_id: group.snapshot_id,
    generated_at: new Date().toISOString(),
    period: "daily",
    stage: "curated_excel_import_summary_only",
    reporting_window: group.window,
    count: validSources.length,
    discarded_count: discarded,
    rejected_count: 0,
    sources: validSources.map((row, i) => {
      const validity = validities[group.sources.indexOf(row)];
      return {
        id: row.id,
        title: row.title,
        url: row.url,
        publisher: row.publisher,
        author: "",
        date_published: row.date_published,
        date_collected: new Date().toISOString(),
        source_type: row.source_type,
        raw_html: "",
        full_text: row.full_text,
        summary: row.summary,
        source_text_quality: row.source_text_quality,
        needs_full_text_fetch: row.needs_full_text_fetch,
        relevance_tier: row.relevance_tier,
        ai_specificity_score: row.ai_specificity_score,
        main_category: row.main_category,
        attachments: [],
        trust_tier: row.trust_tier,
        validity,
        tags: row.tags,
        content_hash: row.content_hash,
        clean_text_hash: row.clean_text_hash,
      };
    }),
  };

  const blob = await uploadArchiveJson(
    `curated-snapshots/${group.snapshot_id}.json`,
    snapshot
  );

  const { error: snapshotError } = await supabase.from("snapshots").upsert(
    {
      snapshot_id: group.snapshot_id,
      period: "daily",
      generated_at: snapshot.generated_at,
      start_utc: group.window.start_utc,
      end_utc: group.window.end_utc,
      start_local: group.window.start_sgt,
      end_local: group.window.end_sgt,
      count: snapshot.count,
      discarded_count: snapshot.discarded_count,
      rejected_count: 0,
      blob_path: blob.url,
    },
    { onConflict: "snapshot_id" }
  );

  if (snapshotError) throw snapshotError;

  const sourceRows = snapshot.sources.map((source) => ({
    id: source.id,
    snapshot_id: group.snapshot_id,
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    author: source.author,
    date_published: source.date_published,
    source_type: source.source_type,
    trust_tier: source.trust_tier,
    credibility_label: source.validity.credibility_label,
    validity_score: source.validity.source_validity_score,
    tags: source.tags,
    full_text: source.full_text,
    summary: source.summary,
    source_text_quality: source.source_text_quality,
    needs_full_text_fetch: source.needs_full_text_fetch,
    content_hash: source.content_hash,
    clean_text_hash: source.clean_text_hash,
    blob_path: blob.url,
    relevance_tier: source.relevance_tier,
    ai_specificity_score: source.ai_specificity_score,
    main_category: source.main_category,
  }));

  const { error: sourceError } = await supabase
    .from("sources")
    .upsert(sourceRows, { onConflict: "id" });

  if (sourceError) throw sourceError;

  console.log(`Imported ${group.snapshot_id}: ${snapshot.count} sources`);
}

console.log("Curated Excel import complete.");
