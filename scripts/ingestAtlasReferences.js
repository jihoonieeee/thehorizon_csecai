#!/usr/bin/env node
/**
 * ingestAtlasReferences.js — fetch and ingest the primary reference sources
 * cited by MITRE ATLAS traditional ML attack case studies.
 *
 * ATLAS case studies cite the original incident reports, vendor blog posts,
 * CVE advisories, and news articles that corroborate each attack. These
 * are high-quality primary sources that don't appear in arXiv or RSS feeds.
 *
 * Scope: references from case studies that use traditional ML attack techniques
 * (evasion, poisoning, model extraction, backdoor, supply chain on ML models).
 * Excludes LLM/agentic/prompt-injection cases.
 *
 * Usage:
 *   node scripts/ingestAtlasReferences.js [--dry-run]
 */

import "dotenv/config";
import { createHash }    from "crypto";
import { createClient }  from "@supabase/supabase-js";
import { load as yamlLoad } from "js-yaml";

const DRY_RUN = process.argv.includes("--dry-run");

const supabase = DRY_RUN ? null : createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeId(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

// Traditional ML attack case study IDs — evasion, poisoning, extraction,
// backdoor, supply chain attacks ON ML models (not prompt injection / agentic)
const TRADITIONAL_ML_CASES = new Set([
  "AML.CS0000", // Evasion of Deep Learning Detector for Malware C&C
  "AML.CS0001", // Botnet DGA Detection Evasion
  "AML.CS0002", // VirusTotal Poisoning
  "AML.CS0003", // Bypassing Cylance's AI Malware Detection
  "AML.CS0004", // Camera Hijack Attack on Facial Recognition System
  "AML.CS0005", // Attack on Machine Translation Services
  "AML.CS0006", // ClearviewAI Misconfiguration (model data exfiltration)
  "AML.CS0007", // GPT-2 Model Replication (model extraction)
  "AML.CS0008", // ProofPoint Evasion (email ML classifier bypass)
  "AML.CS0009", // Tay Poisoning (training-time data poisoning)
  "AML.CS0011", // Microsoft Edge AI Evasion
  "AML.CS0012", // Face Identification System Evasion (physical countermeasures)
  "AML.CS0013", // Backdoor Attack on Deep Learning Models in Mobile Apps
  "AML.CS0014", // Confusing Antimalware Neural Networks
  "AML.CS0015", // Compromised PyTorch Dependency Chain (ML supply chain)
  "AML.CS0017", // Bypassing ID.me Identity Verification (biometric ML bypass)
  "AML.CS0023", // ShadowRay (ML infrastructure CVE exploitation)
  "AML.CS0025", // Web-Scale Data Poisoning: Split-View Attack
  "AML.CS0027", // Organization Confusion on Hugging Face (ML supply chain)
  "AML.CS0028", // AI Model Tampering via Supply Chain Attack
  "AML.CS0031", // Malicious Models on Hugging Face (2025)
  "AML.CS0032", // Attempted Evasion of ML Phishing Webpage Detection
  "AML.CS0058", // Google Photos AI Model Extraction (2025)
]);

// Domains to skip — not fetchable as sources
const SKIP_DOMAINS = new Set([
  "twitter.com", "x.com", "youtube.com", "youtu.be",
  "shodan.io", "github.com", "avidml.org",
  "help.id.me",                     // auth-gated help pages
  "incidentdatabase.ai",            // already covered by AIID connector
  "nvd.nist.gov", "cve.org",        // CVE pages — minimal text, covered by CISA KEV
]);

function skipUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SKIP_DOMAINS.has(host);
  } catch { return true; }
}

// Fetch article text via Jina Reader (free, no API key, handles JS-rendered pages)
async function fetchViaJina(url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain", "X-Return-Format": "text" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    // Strip Jina metadata headers
    const body = raw.replace(/^(Title:|URL Source:|Published Time:|Markdown Content:)[^\n]*\n/gm, "").trim();
    return body.length > 200 ? body : null;
  } catch { return null; }
}

// Minimal date extraction from fetched text
function extractDateFromText(text) {
  const head = (text || "").slice(0, 2000);
  const m = head.match(/\b(20\d{2})[-\/](0[1-9]|1[0-2])[-\/](0[1-9]|[12]\d|3[01])\b/)
         || head.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!m) return null;
  if (m[1]?.length === 4) return `${m[1]}-${m[2]}-${m[3]}`;
  const months = { january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12" };
  return `${m[3]}-${months[m[1].toLowerCase()]}-${String(m[2]).padStart(2,"0")}`;
}

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ATLAS Traditional ML Reference Ingest${DRY_RUN ? "  [DRY RUN]" : ""}`);
  console.log(`${"═".repeat(64)}\n`);

  // Fetch ATLAS YAML
  process.stdout.write("  Fetching ATLAS bundle... ");
  const r = await fetch(
    "https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.06.yaml",
    { headers: { "User-Agent": "the-horizon-ingester/1.0" }, signal: AbortSignal.timeout(30000) }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const atlas = yamlLoad(await r.text());
  const caseStudies = atlas["case-studies"] || {};
  console.log("done");

  // Collect reference URLs from traditional ML cases only
  const refs = [];
  const seen = new Set();
  for (const [atlasId, cs] of Object.entries(caseStudies)) {
    if (!TRADITIONAL_ML_CASES.has(atlasId)) continue;
    const incidentDate = (cs.date || cs["created-date"] || "").slice(0, 10);
    for (const ref of (cs.references || [])) {
      const url = ref.url?.trim();
      if (!url?.startsWith("http") || skipUrl(url) || seen.has(url)) continue;
      seen.add(url);
      refs.push({ atlasId, url, title: ref.title || "", incidentDate, caseTitle: cs.name });
    }
  }
  console.log(`  ${refs.length} reference URLs from ${TRADITIONAL_ML_CASES.size} traditional ML cases\n`);

  // Check which URLs are already in DB
  const refIds = refs.map(r => makeId(r.url));
  const { data: existing } = DRY_RUN ? { data: [] } : await supabase
    .from("sources").select("id").in("id", refIds);
  const existingSet = new Set((existing || []).map(r => r.id));
  const toFetch = refs.filter(r => !existingSet.has(makeId(r.url)));
  console.log(`  Already in DB: ${existingSet.size}  To fetch: ${toFetch.length}\n`);

  const toUpsert = [];
  let fetched = 0, failed = 0;

  for (const ref of toFetch) {
    const id = makeId(ref.url);
    process.stdout.write(`  [${String(fetched + failed + 1).padStart(2)}/${toFetch.length}] ${ref.atlasId} ${ref.url.slice(0, 60)} ... `);

    const text = await fetchViaJina(ref.url);
    if (!text) {
      console.log("failed (no content)");
      failed++;
    } else {
      const dateFromText = extractDateFromText(text);
      const datePublished = dateFromText
        ? new Date(dateFromText).toISOString()
        : ref.incidentDate ? new Date(ref.incidentDate).toISOString() : new Date().toISOString();

      const publisher = (() => { try { return new URL(ref.url).hostname.replace(/^www\./, ""); } catch { return "unknown"; } })();
      const title = ref.title || text.split("\n")[0].slice(0, 200) || ref.url;

      toUpsert.push({
        id,
        title: title.slice(0, 300),
        url:            ref.url,
        publisher,
        date_published: datePublished,
        source_type:    "incident",
        trust_tier:     "high",
        full_text:      text.slice(0, 15000),
        summary:        text.slice(0, 500),
        intelligence: {
          backfill_source:  "atlas_reference_ingest",
          atlas_case_id:    ref.atlasId,
          atlas_case_title: ref.caseTitle,
          atlas_incident_date: ref.incidentDate,
        },
      });
      console.log(`ok (${text.length} chars)`);
      fetched++;
    }

    await sleep(1200); // Jina rate limit
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Fetched: ${fetched}  Failed: ${failed}`);

  if (DRY_RUN || toUpsert.length === 0) {
    if (DRY_RUN) console.log(`  [DRY RUN] Would save ${toUpsert.length} sources.`);
    else console.log("  Nothing new to save.");
    return;
  }

  const { error } = await supabase
    .from("sources")
    .upsert(toUpsert, { onConflict: "id", ignoreDuplicates: false });
  if (error) throw new Error(`Upsert failed: ${error.message}`);
  console.log(`  Saved ${toUpsert.length} ATLAS reference sources.`);
  console.log(`\n  Next: node scripts/dailyClassify.js --since-hours 1 --limit ${toUpsert.length + 50}`);
}

main().catch(err => { console.error(err); process.exit(1); });
