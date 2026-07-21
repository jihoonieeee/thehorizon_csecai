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
const FORCE     = args.includes("--force");   // re-upsert already-classified sources (schema migration)
const untilIdx  = args.indexOf("--until");
const UNTIL     = untilIdx >= 0 && args[untilIdx + 1] ? args[untilIdx + 1] : new Date().toISOString().slice(0, 10);
const sinceIdx  = args.indexOf("--since");
const SINCE     = sinceIdx >= 0 && args[sinceIdx + 1] ? args[sinceIdx + 1] : null;
const flagIdx   = args.indexOf("--flag-as");
const FLAG_AS   = flagIdx  >= 0 && args[flagIdx + 1]  ? args[flagIdx + 1]  : null;

// ATLAS-latest.yaml is a pointer that always resolves to the most recent monthly release.
// It redirects via content (18 bytes = filename), so fetch follows to the actual bundle.
const ATLAS_URL = "https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.06.yaml";
// TODO: switch to ATLAS-latest.yaml once GitHub serves it as a redirect rather than a pointer file.
const ATLAS_BASE = "https://atlas.mitre.org/studies";

const supabase = DRY_RUN ? null : createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

function escapeMermaid(str) {
  return String(str || "").replace(/"/g, "'").replace(/[\n\r]/g, " ").slice(0, 60);
}

/**
 * Build a Mermaid flowchart DSL string from the ordered technique steps.
 * Stored in intelligence.atlas_mermaid and rendered in the UI via mermaid.ink.
 */
function buildAtlasMermaid(cs, steps, techniques) {
  if (!steps || steps.length === 0) return null;

  const lines = ["flowchart TD"];

  const actor = cs.actor ? escapeMermaid(cs.actor) : "Threat Actor";
  lines.push(`    A(["${actor}"])`);

  steps.forEach((s, i) => {
    const techName = escapeMermaid(techniques[s.target]?.name || s.target);
    const techId   = escapeMermaid(s.target);
    const desc     = escapeMermaid((s.description || "").trim());
    const nodeId   = `S${i}`;
    const label    = desc ? `${techId}\\n${techName}\\n${desc}` : `${techId}\\n${techName}`;
    lines.push(`    ${nodeId}["${label}"]`);
    if (i === 0) {
      lines.push(`    A --> ${nodeId}`);
    } else {
      lines.push(`    S${i - 1} --> ${nodeId}`);
    }
  });

  if (cs.target) {
    const target = escapeMermaid(cs.target);
    const last   = `S${steps.length - 1}`;
    lines.push(`    T(["Target: ${target}"])`);
    lines.push(`    ${last} --> T`);
  }

  return lines.join("\n");
}

function sourceTypeFor(atlasType) {
  if (!atlasType) return "research_finding";
  const t = atlasType.toLowerCase();
  if (t === "incident") return "incident";
  if (t === "exercise" || t === "demo" || t === "demonstration") return "capability_demonstration";
  return "research_finding";
}

// ATLAS tactic ordering — used to detect kill-chain compression and unusual ordering.
// Phase index = canonical position; gaps indicate compressed chains.
const ATLAS_TACTIC_ORDER = [
  "AML.TA0000", // Reconnaissance
  "AML.TA0001", // Resource Development
  "AML.TA0002", // Initial Access
  "AML.TA0003", // ML Attack Staging
  "AML.TA0004", // Execution
  "AML.TA0005", // Persistence
  "AML.TA0006", // Defense Evasion
  "AML.TA0007", // Discovery
  "AML.TA0008", // Collection
  "AML.TA0009", // ML Impact
  "AML.TA0010", // Exfiltration
  "AML.TA0011", // Impact
];

/**
 * Derive structural observations from the attack chain without LLM.
 * Returns an object stored in intelligence.atlas_chain_analysis.
 *
 * Each chain step must carry a `tactic` field (AML.TA* ID) for phase-level analysis.
 * Trust boundary crossings use technique ID prefixes (AML.T*) to detect supply-chain,
 * model-level, and inference-API boundary transitions.
 */
function deriveChainAnalysis(chain, cs) {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const techIds = chain.map(s => s.technique_id);

  // Tactic phase coverage — use the tactic field (AML.TA*) stored per step.
  // Fall back to graceful empty set if tactic is absent (legacy data).
  const tacticSet = new Set(chain.map(s => s.tactic).filter(Boolean));
  const tacticsPresent = ATLAS_TACTIC_ORDER.filter(t => tacticSet.has(t));
  const phaseCount  = tacticsPresent.length;
  const compressed  = phaseCount > 0 && phaseCount <= Math.ceil(ATLAS_TACTIC_ORDER.length * 0.4);

  // Technique co-occurrence pairs — passed to LLM context for notable combo detection
  const pairs = [];
  for (let i = 0; i < techIds.length - 1; i++) {
    for (let j = i + 1; j < techIds.length; j++) {
      pairs.push([techIds[i], techIds[j]]);
    }
  }

  // Trust boundary crossings: supply-chain → model → inference-API → downstream consumer.
  // Prefixes are technique ID roots (AML.T*), not tactic IDs.
  const SUPPLY_CHAIN_PREFIXES = ["AML.T0010", "AML.T0018", "AML.T0019", "AML.T0020", "AML.T0081"];
  const MODEL_PREFIXES        = ["AML.T0029", "AML.T0043", "AML.T0047", "AML.T0048"];
  const INFERENCE_PREFIXES    = ["AML.T0040", "AML.T0041", "AML.T0051"];
  const hasSupplyChain = techIds.some(id => SUPPLY_CHAIN_PREFIXES.some(p => id.startsWith(p)));
  const hasModel       = techIds.some(id => MODEL_PREFIXES.some(p => id.startsWith(p)));
  const hasInference   = techIds.some(id => INFERENCE_PREFIXES.some(p => id.startsWith(p)));
  const trustBoundaryCrossings = [
    hasSupplyChain && hasModel       ? "supply_chain→model"      : null,
    hasModel       && hasInference   ? "model→inference_api"     : null,
    hasSupplyChain && hasInference   ? "supply_chain→inference"  : null,
  ].filter(Boolean);

  // Unusual ordering: a step's tactic phase index is lower than the previous step's.
  // Only computed when tactic data is present.
  const phaseIndices = chain
    .map(s => s.tactic ? ATLAS_TACTIC_ORDER.indexOf(s.tactic) : -1)
    .filter(i => i >= 0);
  const hasUnusualOrdering = phaseIndices.length >= 2 &&
    phaseIndices.some((v, i) => i > 0 && v < phaseIndices[i - 1]);

  return {
    step_count:               chain.length,
    tactic_phases_covered:    phaseCount,
    tactics_present:          tacticsPresent,
    kill_chain_compressed:    compressed,
    trust_boundary_crossings: trustBoundaryCrossings,
    technique_pairs:          pairs.slice(0, 20),      // cap for JSONB size
    has_unusual_ordering:     hasUnusualOrdering,
    actor_type:               cs["actor-type"] || null,
    target:                   cs.target || null,
  };
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
  console.log(`\n  Processing ${entries.length} named case studies...${FORCE ? "  [--force: re-upsert all]" : ""}\n`);

  // Bulk-check which IDs already have validation_status set (already classified).
  // --force bypasses this so the intelligence schema can be updated without losing
  // the existing validation_status / classification that dailyClassify set.
  const allIds = entries.map(([id]) => makeId(`${ATLAS_BASE}/${id}`));
  const { data: existingRows } = DRY_RUN ? { data: [] } : await supabase
    .from("sources")
    .select("id,validation_status,layer3_status,main_category")
    .in("id", allIds);
  const classifiedSet = FORCE
    ? new Set()   // treat everything as unclassified so we re-upsert
    : new Set((existingRows || []).filter(r => r.validation_status !== null).map(r => r.id));
  // When forcing, preserve full classification state so a --force intelligence-schema
  // update doesn't strip main_category/layer3_status from already-classified sources
  // (which would strand them outside dailyClassify's time window).
  const existingClassificationMap = FORCE
    ? new Map((existingRows || []).filter(r => r.validation_status !== null).map(r => [r.id, {
        validation_status: r.validation_status,
        layer3_status:     r.layer3_status,
        main_category:     r.main_category,
      }]))
    : new Map();

  for (const [atlasId, cs] of entries) {
    // atlas_incident_date = when the attack occurred (cs.date)
    // atlas_publication_date = when MITRE published the case study (cs["created-date"])
    const incidentDate     = cs.date || "";
    const publicationDate  = cs["created-date"] || "";
    // Use incident date for window filtering; fall back to publication date only when absent
    const filterDate = incidentDate || publicationDate;
    if (filterDate && filterDate > UNTIL) { skipped++; continue; }
    if (SINCE && filterDate && filterDate < SINCE) { skipped++; continue; }

    const url      = `${ATLAS_BASE}/${atlasId}`;
    const sourceId = makeId(url);

    if (classifiedSet.has(sourceId)) { existing++; continue; }

    // Build full_text: description + technique step descriptions from relationships.
    // Sort by step-id (S00, S01, ...) so chain order matches actual attack sequence.
    const rawSteps = (relationships[atlasId]?.employs || []);
    const steps = [...rawSteps].sort((a, b) => {
      const ai = parseInt((a["step-id"] || "S9999").replace(/\D/g, ""), 10);
      const bi = parseInt((b["step-id"] || "S9999").replace(/\D/g, ""), 10);
      return ai - bi;
    });
    const stripHtml = s => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const stepLines = steps.map(s => {
      const techName = techniques[s.target]?.name || s.target;
      return `[${techName}] ${stripHtml(s.description)}`;
    }).filter(Boolean);

    const fullText = [
      cs.name,
      cs.description ? `\n${stripHtml(cs.description)}` : "",
      cs.actor   ? `\nActor: ${cs.actor}`   : "",
      cs.target  ? `\nTarget: ${cs.target}` : "",
      stepLines.length ? `\n\nTechnique steps:\n${stepLines.join("\n")}` : "",
    ].join("").trim();

    // Collect reference URLs for optional follow-up
    for (const ref of (cs.references || [])) {
      if (ref.url && ref.url.startsWith("http")) refUrls.push({ atlasId, url: ref.url, title: ref.title });
    }

    // Classify each reference by type so downstream extraction can prioritise
    const atlasRefs = (cs.references || [])
      .filter(r => r.url && r.url.startsWith("http"))
      .map(r => {
        const url   = r.url;
        const title = r.title || null;
        let reference_type = "report";
        if (url.includes("arxiv.org") || url.includes("semanticscholar") || url.includes("doi.org")) reference_type = "paper";
        else if (/CVE-\d{4}-\d+/i.test(title || "") || url.includes("cve.mitre") || url.includes("nvd.nist")) reference_type = "cve";
        else if (url.includes("github.com")) reference_type = "code";
        else if (/malware|ransomware|trojan|botnet|apt/i.test(title || "")) reference_type = "malware_family";
        return { title, url, reference_type, atlas_case_id: atlasId };
      });

    // Derive higher-order chain observations deterministically from step structure.
    // step-id (S00, S01...) drives order; tactic is the ATLAS tactic ID (AML.TA*).
    const atlasChain = steps.map((s, idx) => ({
      order:          idx + 1,
      step_id:        s["step-id"] || null,
      technique_id:   s.target,
      technique_name: techniques[s.target]?.name || s.target,
      tactic:         s.tactic || null,
      description:    (s.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }));

    const chainAnalysis = deriveChainAnalysis(atlasChain, cs);

    const row = {
      id:                sourceId,
      title:             cs.name,
      url,
      publisher:         "MITRE ATLAS",
      author:            cs.actor || "MITRE ATLAS",
      // date_published = incident date so temporal reasoning is grounded to when the attack happened
      date_published:    incidentDate  ? `${incidentDate.slice(0, 10)}T00:00:00+00:00`
                       : publicationDate ? `${publicationDate.slice(0, 10)}T00:00:00+00:00`
                       : null,
      source_type:       sourceTypeFor(cs.type),
      trust_tier:        "high",
      full_text:         fullText,
      summary:           stripHtml(cs.description).slice(0, 500),
      // --force: restore full classification so already-classified sources aren't
      // stripped of main_category/layer3_status and stranded outside dailyClassify's
      // time window. New sources get null so dailyClassify classifies them normally.
      main_category:     existingClassificationMap.get(sourceId)?.main_category     ?? null,
      validation_status: existingClassificationMap.get(sourceId)?.validation_status ?? null,
      layer3_status:     existingClassificationMap.get(sourceId)?.layer3_status     ?? null,
      intelligence: {
        atlas_id:              atlasId,
        atlas_type:            cs.type || null,
        actor_type:            cs["actor-type"] || null,
        technique_ids:         steps.map(s => s.target),
        // Separate incident vs publication dates — incident_date is when the attack
        // happened; publication_date is when MITRE documented it. Downstream evidence
        // extraction must use incident_date for event_date, not publication_date.
        atlas_incident_date:     incidentDate    ? incidentDate.slice(0, 10)    : null,
        atlas_publication_date:  publicationDate ? publicationDate.slice(0, 10) : null,
        date_granularity:        cs["date-granularity"] || null,
        // Structured attack chain — one entry per technique step in execution order.
        // Used by extractAtlasEvidence.js (deterministic pass) and the UI chain panel.
        atlas_chain: atlasChain,
        // Higher-order structural observations derived from the chain as a whole.
        atlas_chain_analysis: chainAnalysis,
        // Reference papers/reports with typed provenance — treated as first-class
        // intelligence inputs by extractAtlasEvidence.js, not just follow-up hints.
        atlas_references: atlasRefs,
        // Mermaid flowchart DSL — rendered via mermaid.ink in the UI and also passed
        // as structured context to the LLM during evidence extraction.
        atlas_mermaid: buildAtlasMermaid(cs, steps, techniques),
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
    const incDateStr = incidentDate ? incidentDate.slice(0, 10) : (publicationDate ? `pub:${publicationDate.slice(0, 10)}` : "no date");
    console.log(`  ✓ ${atlasId.padEnd(14)} ${cs.type?.padEnd(12) || "".padEnd(12)} [${incDateStr}] ${cs.name.slice(0, 60)}`);
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
