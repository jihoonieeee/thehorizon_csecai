#!/usr/bin/env node
/**
 * ingestMitreAtlas.js — ingest MITRE ATLAS case studies into the sources table.
 *
 * Fetches the latest ATLAS v6 YAML bundle from GitHub, extracts case studies
 * with their technique-application step descriptions, and upserts them as
 * source records for classification by dailyClassify.js.
 *
 * Each case study becomes one source. The relationship step descriptions
 * (how each ATLAS technique was applied) are folded into full_text so the
 * classifier has rich context beyond the abstract.
 *
 * Reference URLs inside case studies are printed at the end so you can
 * optionally feed them to backfillSources.js (arxiv) or importCuratedPdfs.js.
 *
 * Usage:
 *   node scripts/ingestMitreAtlas.js [--dry-run] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--flag-as TAG]
 *
 * Defaults: ingests all case studies with incident date <= today.
 * --since   skip case studies with incident date before this date
 * --flag-as store TAG in intelligence.backfill_source on each new row
 */

import "dotenv/config";
import { createHash }   from "crypto";
import { createClient } from "@supabase/supabase-js";
import { load as yamlLoad } from "js-yaml";

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const untilIdx  = args.indexOf("--until");
const UNTIL     = untilIdx >= 0 && args[untilIdx + 1] ? args[untilIdx + 1] : new Date().toISOString().slice(0, 10);
const sinceIdx  = args.indexOf("--since");
const SINCE     = sinceIdx >= 0 && args[sinceIdx + 1] ? args[sinceIdx + 1] : null;
const flagIdx   = args.indexOf("--flag-as");
const FLAG_AS   = flagIdx  >= 0 && args[flagIdx + 1]  ? args[flagIdx + 1]  : null;

const ATLAS_URL = "https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.06.yaml";
const ATLAS_BASE = "https://atlas.mitre.org/studies";

const supabase = DRY_RUN ? null : createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

function sourceTypeFor(atlasType) {
  if (!atlasType) return "research_finding";
  const t = atlasType.toLowerCase();
  if (t === "incident") return "incident";
  if (t === "exercise" || t === "demo" || t === "demonstration") return "capability_demonstration";
  return "research_finding";
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MITRE ATLAS Ingest — case studies ${SINCE ? `from ${SINCE} ` : ""}until ${UNTIL}${DRY_RUN ? "  [DRY RUN]" : ""}${FLAG_AS ? `  [flag: ${FLAG_AS}]` : ""}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Fetch YAML bundle ────────────────────────────────────────────────────────
  process.stdout.write("  Fetching ATLAS YAML bundle... ");
  const r = await fetch(ATLAS_URL, {
    signal: AbortSignal.timeout(30000),
    headers: { "User-Agent": "the-horizon-ingester/1.0" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ATLAS`);
  const raw = await r.text();
  console.log(`${(raw.length / 1024).toFixed(0)} KB`);

  // ── Parse YAML ───────────────────────────────────────────────────────────────
  process.stdout.write("  Parsing YAML... ");
  const atlas = yamlLoad(raw);
  const caseStudies   = atlas["case-studies"]  || {};
  const relationships = atlas["relationships"] || {};
  const techniques    = atlas["techniques"]    || {};
  console.log(`${Object.keys(caseStudies).length} case studies, ${Object.keys(techniques).length} techniques`);

  // ── Process case studies ─────────────────────────────────────────────────────
  const refUrls = [];   // collect paper/report URLs for optional follow-up ingest
  let saved = 0, skipped = 0, existing = 0;

  const entries = Object.entries(caseStudies).filter(([, cs]) =>
    cs && cs.name && cs["object-type"] === "case-study"
  );
  console.log(`\n  Processing ${entries.length} named case studies...\n`);

  // Bulk-check which IDs already have validation_status set (already classified)
  const allIds = entries.map(([id]) => makeId(`${ATLAS_BASE}/${id}`));
  const { data: existingRows } = DRY_RUN ? { data: [] } : await supabase
    .from("sources")
    .select("id,validation_status")
    .in("id", allIds);
  const classifiedSet = new Set(
    (existingRows || []).filter(r => r.validation_status !== null).map(r => r.id)
  );

  for (const [atlasId, cs] of entries) {
    const incidentDate = cs.date || cs["created-date"] || "";
    if (incidentDate && incidentDate > UNTIL) { skipped++; continue; }
    if (SINCE && incidentDate && incidentDate < SINCE) { skipped++; continue; }

    const url      = `${ATLAS_BASE}/${atlasId}`;
    const sourceId = makeId(url);

    if (classifiedSet.has(sourceId)) { existing++; continue; }

    // Build full_text: description + technique step descriptions from relationships
    const steps = (relationships[atlasId]?.employs || []);
    const stepLines = steps.map(s => {
      const techName = techniques[s.target]?.name || s.target;
      return `[${techName}] ${(s.description || "").trim()}`;
    }).filter(Boolean);

    const fullText = [
      cs.name,
      cs.description ? `\n${cs.description.trim()}` : "",
      cs.actor   ? `\nActor: ${cs.actor}`   : "",
      cs.target  ? `\nTarget: ${cs.target}` : "",
      stepLines.length ? `\n\nTechnique steps:\n${stepLines.join("\n")}` : "",
    ].join("").trim();

    // Collect reference URLs for optional follow-up
    for (const ref of (cs.references || [])) {
      if (ref.url && ref.url.startsWith("http")) refUrls.push({ atlasId, url: ref.url, title: ref.title });
    }

    const row = {
      id:                sourceId,
      title:             cs.name,
      url,
      publisher:         "MITRE ATLAS",
      author:            cs.actor || "MITRE ATLAS",
      date_published:    incidentDate ? `${incidentDate.slice(0, 10)}T00:00:00+00:00` : null,
      source_type:       sourceTypeFor(cs.type),
      trust_tier:        "high",
      full_text:         fullText,
      summary:           (cs.description || "").trim().slice(0, 500),
      main_category:     null,       // let dailyClassify handle
      validation_status: null,       // triggers dailyClassify pickup
      layer3_status:     null,
      intelligence: {
        atlas_id:       atlasId,
        atlas_type:     cs.type || null,
        actor_type:     cs["actor-type"] || null,
        technique_ids:  steps.map(s => s.target),
        date_granularity: cs["date-granularity"] || null,
        ...(FLAG_AS ? { backfill_source: FLAG_AS } : {}),
      },
    };

    if (!DRY_RUN) {
      const { error } = await supabase
        .from("sources")
        .upsert(row, { onConflict: "id", ignoreDuplicates: false });
      if (error) { console.error(`  ✗ ${atlasId}: ${error.message}`); continue; }
    }

    saved++;
    const dateStr = incidentDate ? incidentDate.slice(0, 10) : "no date";
    console.log(`  ✓ ${atlasId.padEnd(14)} ${cs.type?.padEnd(12) || "".padEnd(12)} [${dateStr}] ${cs.name.slice(0, 60)}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Saved: ${saved}  Already classified: ${existing}  Skipped (post-${UNTIL}): ${skipped}`);
  console.log(`  Reference URLs found: ${refUrls.length}`);

  if (refUrls.length > 0) {
    console.log(`\n  Reference paper URLs (feed to arxiv backfill or importCuratedPdfs):`);
    const arxivRefs = refUrls.filter(r => r.url.includes("arxiv.org"));
    const otherRefs = refUrls.filter(r => !r.url.includes("arxiv.org"));
    console.log(`    arXiv: ${arxivRefs.length}   Other: ${otherRefs.length}`);
    if (arxivRefs.length) {
      console.log("\n  arXiv URLs:");
      arxivRefs.slice(0, 20).forEach(r => console.log(`    ${r.url}`));
      if (arxivRefs.length > 20) console.log(`    ... and ${arxivRefs.length - 20} more`);
    }
  }

  if (!DRY_RUN && saved > 0) {
    console.log(`\n  Next step:`);
    console.log(`    node scripts/dailyClassify.js --since-hours 2 --limit ${saved + 50}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
