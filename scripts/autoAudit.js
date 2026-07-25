#!/usr/bin/env node
/**
 * autoAudit.js — automated corpus quality audit using Gemini 2.5 Flash as judge.
 *
 * Processes 5 sources per batch, calls Gemini to evaluate all 7 audit dimensions,
 * auto-applies safe fixes to Supabase, and prepends findings to docs/database_audit.md.
 * Progress is tracked in .audit-progress.json and resumes automatically.
 *
 * Usage:
 *   node scripts/autoAudit.js [options]
 *
 * Options:
 *   --page N     start from page N (overrides progress file)
 *   --batch N    start from batch N (overrides progress file)
 *   --limit N    stop after N batches (default: unlimited)
 *   --dry-run    show findings without DB writes or log changes
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { computeImportance } from "../lib/pipeline/scoring/importance.js";
import { deterministicMaturity } from "../lib/pipeline/scoring/maturityLevel.js";
import { PRIMARY_TAGS } from "../lib/pipeline/understand/taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.resolve(__dirname, "..");
const PROGRESS_FILE = path.join(ROOT, ".audit-progress.json");
const LOG_FILE      = path.join(ROOT, "docs", "database_audit.md");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] ?? d : d; };
const hasFlag = f => args.includes(f);

const DRY_RUN     = hasFlag("--dry-run");
const LIMIT       = parseInt(getArg("--limit", "0"), 10) || Infinity;
const CLI_PAGE    = parseInt(getArg("--page",  "0"), 10) || null;
const CLI_BATCH   = parseInt(getArg("--batch", "0"), 10) || null;

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE  = 5;
const WINDOW_SIZE = 200;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CANONICAL_TAG_IDS = new Set(PRIMARY_TAGS.map(t => t.id));

const READING_FROM_IMPORTANCE = {
  realized:  "essential",
  proven:    "recommended",
  research:  "analyst",
  reference: "analyst",
  noise:     "background",
};

const MATURITY_FROM_TYPE = {
  incident:                  "observed",
  threat_intelligence:       "operational",
  adversary_adoption_signal: "operational",
  attack_surface_signal:     "observed",
  exploit_disclosure:        "demonstrated",
  capability_demonstration:  "demonstrated",
  research_finding:          "research",
  benchmark_evaluation:      "research",
  vulnerability:             "disclosed",
  governance_signal:         "research",
  defensive_capability:      "research",
};

// ── Supabase ──────────────────────────────────────────────────────────────────

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Progress file ─────────────────────────────────────────────────────────────

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); }
  catch { return { page: 2, batch: 18, totalDone: 57 }; }
}

function saveProgress(p) {
  if (!DRY_RUN) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Gemini call (Gemini only — no provider rotation) ─────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(systemPrompt, userPrompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
  };

  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      try { return JSON.parse(text); }
      catch { return JSON.parse(text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim()); }
    }

    const bodyText = await res.text().catch(() => "");
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const wait = res.status === 503 ? 20000 + attempt * 15000 : 10000 + attempt * 8000;
      process.stdout.write(` [${res.status}, waiting ${wait / 1000}s]\n`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${bodyText.slice(0, 200)}`);
  }
}

// ── Risk score (matches auditCorpus.js) ───────────────────────────────────────

function riskScore(s) {
  let score = 0;
  if (s.hallucination_risk && s.hallucination_risk !== "none") score += 40;
  const origin = (s.source_origin || s.discovery_route || "").toLowerCase();
  if (origin.includes("discovery") || origin.includes("llm")) score += 30;
  if (s.trust_tier === "unknown")                              score += 20;
  if (s.date_confidence && s.date_confidence !== "exact")     score += 10;
  return score;
}

// ── Load sources from DB ──────────────────────────────────────────────────────

const DB_FIELDS = [
  "id", "title", "url", "publisher", "date_published", "date_published_actual",
  "date_confidence", "source_type", "trust_tier", "main_category", "all_categories",
  "tags", "short_summary", "full_text", "validation_status", "layer3_status",
  "claim_extraction_status", "reading_value", "intelligence",
  "source_origin", "discovery_route", "hallucination_risk",
  "needs_review", "starred", "is_curated", "is_digest", "parent_source_id",
].join(",");

async function loadBatch(page, batch) {
  const rangeStart = (page - 1) * WINDOW_SIZE;
  const rangeEnd   = rangeStart + WINDOW_SIZE - 1;
  const { data, error } = await sb
    .from("sources").select(DB_FIELDS)
    .eq("validation_status", "pass").order("date_published", { ascending: false })
    .range(rangeStart, rangeEnd);
  if (error) throw new Error(`DB: ${error.message}`);

  const rows = (data || []);
  rows.sort((a, b) => riskScore(b) - riskScore(a));

  const offset  = (batch - 1) * BATCH_SIZE;
  const sources = rows.slice(offset, offset + BATCH_SIZE);
  return { sources, totalInWindow: rows.length, offset };
}

// ── Load evidence ─────────────────────────────────────────────────────────────

async function loadEvidence(sourceId) {
  const { data } = await sb
    .from("evidence")
    .select("evidence_id,fact,quote,quote_grounded,evidence_type,specificity,technique_tags")
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true })
    .limit(12);
  return data || [];
}

// ── Format source for judge ───────────────────────────────────────────────────

function formatSource(s, evidence, idx) {
  const intel          = s.intelligence || {};
  const storedMaturity = intel.maturity_level ?? null;
  const storedImport   = intel.importance?.tier ?? null;
  const storedReading  = s.reading_value ?? intel.reading_value ?? null;

  const expImport  = computeImportance(s);
  const detMat     = deterministicMaturity(s);
  const expReading = (expImport.tier === "proven" && s.source_type === "threat_intelligence")
    ? "essential"
    : (READING_FROM_IMPORTANCE[expImport.tier] ?? "background");

  const fullLen    = (s.full_text || "").trim().length;
  const preview    = (s.full_text || "").trim().slice(0, 800);
  const tags       = s.tags || [];
  const badTags    = tags.filter(t => !CANONICAL_TAG_IDS.has(t));

  const evLines = evidence.map((e, i) => {
    const sentinel = e.fact === "__none__";
    return `  [${i + 1}] type=${e.evidence_type || "?"} spec=${e.specificity || "?"} grounded=${e.quote_grounded ? "yes" : "no"}${sentinel ? " ⚠SENTINEL" : ""}\n       FACT: ${sentinel ? "__none__ (SENTINEL)" : (e.fact || "").slice(0, 200)}${e.quote ? `\n       QUOTE: "${e.quote.slice(0, 150)}"` : ""}`;
  }).join("\n");

  return `SOURCE ${idx}
ID: ${s.id}
TITLE: ${(s.title || "(none)").slice(0, 120)}
URL: ${(s.url || "(none)").slice(0, 120)}
PUBLISHER: ${s.publisher || "(none)"} | TRUST: ${s.trust_tier || "unknown"} | SOURCE_TYPE: ${s.source_type || "(none)"}
DATE: ${(s.date_published || "(none)").slice(0, 10)} | CONFIDENCE: ${s.date_confidence || "none"} | DATE_ACTUAL: ${(s.date_published_actual || "(none)").slice(0, 10)}
MAIN_CATEGORY: ${s.main_category || "(null)"}
TAGS: [${tags.join(", ")}]${badTags.length ? `\n⚠ NON-CANONICAL TAGS: [${badTags.join(", ")}]` : ""}
IS_DIGEST: ${s.is_digest ?? false} | PARENT: ${s.parent_source_id ? "yes" : "no"} | HALL_RISK: ${s.hallucination_risk || "none"}

MATURITY stored=${storedMaturity || "NOT_SET"} | det_expect=${detMat.level} (source_type=${s.source_type})
IMPORTANCE stored=${storedImport || "NOT_SET"} | formula_expect=${expImport.tier} (reality=${expImport.reality})
READING_VALUE stored=${storedReading || "NOT_SET"} | formula_expect=${expReading} (from importance=${expImport.tier})

FULL_TEXT_CHARS: ${fullLen.toLocaleString()} | CLAIM_EXTRACTION: ${s.claim_extraction_status || "null"}
SHORT_SUMMARY: ${(s.short_summary || "(none)").slice(0, 400)}
FULL_TEXT_PREVIEW: ${preview || "(none)"}${fullLen > 800 ? `\n... [${(fullLen - 800).toLocaleString()} more chars]` : ""}

EVIDENCE (${evidence.length} items):
${evidence.length ? evLines : "  (none)"}`.trim();
}

// ── System prompt (built once) ────────────────────────────────────────────────

const CANONICAL_TAGS_TEXT = PRIMARY_TAGS
  .map(t => `  ${t.id} — ${t.label}: ${t.description}`)
  .join("\n");

const SYSTEM_PROMPT = `You are a security intelligence database auditor for an AI threat intelligence corpus. Evaluate each source against all dimensions and return structured JSON.

## CANONICAL TAXONOMY (40 valid tag IDs)

${CANONICAL_TAGS_TEXT}

## DETERMINISTIC FORMULAS

Importance tier from source_type:
  incident / threat_intelligence / adversary_adoption_signal → realized
  exploit_disclosure / capability_demonstration → proven
  research_finding / benchmark_evaluation → research
  governance_signal (non-primary publisher) → noise; (primary/curated publisher) → reference
  vulnerability WITHOUT active-exploitation language → noise
  vulnerability WITH "exploited in the wild" / "actively exploited" language → realized

Reading value from importance:
  realized → essential | proven → recommended | proven + source_type=threat_intelligence → essential
  research / reference → analyst (DEFAULT for all research papers)
  noise → background

Maturity level from source_type:
  incident → observed | threat_intelligence → operational | adversary_adoption_signal → operational
  exploit_disclosure / capability_demonstration → demonstrated
  research_finding / benchmark_evaluation → research
  vulnerability → disclosed | governance_signal → research

## KNOWN RECURRING ERRORS — check for these explicitly

S15 — AE05_ai_malware_dev MISAPPLICATION: AE05 = AI *generating* malware. Do NOT assign if malware TARGETS AI systems but was NOT AI-generated (ENCFORGE, SANDWORM_MODE), or if conventional malware was merely distributed via AI repos.

S17 — TAI01_data_poisoning MISAPPLICATION: TAI01 = poisoning TRAINING DATA. Do NOT assign for model inversion (TAI06), model extraction (TAI05), membership inference (TAI07), or supply chain code poisoning (TAI10).

S22 — capability_demonstration maturity=research WRONG: If a paper attacks REAL commercial models (GPT-4, Claude, Gemini, live production APIs) with measured results → DEMONSTRATED not research. Research only applies to synthetic/toy/lab environments.

S23 — LLM01/LLM04 on RAG/graph attacks WRONG: LLM01 = injection AT INFERENCE TIME into prompts. NOT for RAG corpus poisoning or routing hijacking. LLM04 = WRITING malicious content IN. NOT for extracting out (that is LLM08 or TAI05/TAI06).

S12 — source_type=vulnerability WRONG when: (a) full working exploit chain described → exploit_disclosure; (b) CISA KEV-confirmed active exploitation → incident.

Other recurring errors:
  AE03: requires AI *autonomously discovering* a NEW vulnerability. NOT for AI using a known CVE.
  AE04: AI generating/weaponizing NEW exploits. NOT for using an existing known CVE.
  AE02: social engineering of HUMANS only. NOT for AI targeting AI agents.
  ASI03: requires actual identity/privilege abuse. NOT for shell command filter bypasses.
  main_category=agentic_ai_threats for ATTACKER-operated autonomous agents → ai_enabled_threats + AE08.
  main_category=ai_enabled_threats for PyPI/npm/HF ML supply chain attacks → traditional_ai_threats + TAI10.
  trust_tier=high for media outlets (TechRepublic, TechTimes, TheHackerNews, SecurityWeek, Infosecurity, SecurityAffairs, TheRecord, CSO Online, Ars Technica) → should be medium.
  trust_tier=medium for arXiv papers → should be high.

## AUTO-FIX RULES

Use fix_type="auto" ONLY for these four cases:
  1. reading_value NOT SET → auto_field="reading_value", auto_value=formula result
  2. maturity_level NOT SET → auto_field="maturity_level", auto_value=deterministic map result
  3. is_digest=true on arXiv URL (contains "arxiv.org") → auto_field="is_digest", auto_value="false"
  4. Sentinel evidence item (fact="__none__") → auto_field="sentinel_evidence", auto_value="delete"

Everything else: fix_type="flag" (logged for manual review) or fix_type="wontfix" (known acceptable divergence).

## DIMENSIONS TO EVALUATE

For each source evaluate:
1. taxonomy — canonical tag IDs correct? category matches mechanism? no known misapplications?
2. maturity — maturity_level set and justified by evidence level?
3. reading_value — reading_value set and consistent with importance tier?
4. classification — source_type and main_category accurate for the content?
5. evidence — count adequate for reading_value? no sentinels? quality grounded/specific?
6. date — date_published plausible? not a feed ingest date for old papers?
7. trust — trust_tier appropriate for publisher?
8. data_integrity — is_digest correct? full_text adequate (>1500 chars for non-digest)? needs_review appropriate?

For clean sources: verdict="clean", issues=[], log_note=brief one-line verification (e.g. "ASI01+ASI02 ✓, demonstrated/proven/recommended ✓, 5 grounded evidence items ✓").
For issues: verdict="issues", each issue gets its own entry. verdict="wontfix" if all issues are S10-style acceptable divergences.`.trim();

// ── Response schema ───────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:          { type: "string" },
          verdict:     { type: "string", enum: ["clean", "issues", "wontfix"] },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension:   { type: "string" },
                description: { type: "string" },
                fix_type:    { type: "string", enum: ["auto", "flag", "wontfix"] },
                auto_field:  { type: "string" },
                auto_value:  { type: "string" },
              },
              required: ["dimension", "description", "fix_type"],
            },
          },
          log_note: { type: "string" },
        },
        required: ["id", "verdict", "issues", "log_note"],
      },
    },
  },
  required: ["sources"],
};

// ── Apply auto-fixes ──────────────────────────────────────────────────────────

async function applyAutoFixes(sourceId, issues, evidence) {
  const applied = [];

  for (const issue of issues) {
    if (issue.fix_type !== "auto") continue;

    if (issue.auto_field === "reading_value") {
      const { error } = await sb.from("sources")
        .update({ reading_value: issue.auto_value })
        .eq("id", sourceId);
      applied.push({ field: "reading_value", value: issue.auto_value, ok: !error, err: error?.message });
    }

    else if (issue.auto_field === "maturity_level") {
      const { data: src } = await sb.from("sources").select("intelligence").eq("id", sourceId).single();
      const intel = { ...(src?.intelligence || {}), maturity_level: issue.auto_value };
      const { error } = await sb.from("sources").update({ intelligence: intel }).eq("id", sourceId);
      applied.push({ field: "intelligence.maturity_level", value: issue.auto_value, ok: !error, err: error?.message });
    }

    else if (issue.auto_field === "is_digest") {
      const { error } = await sb.from("sources").update({ is_digest: false }).eq("id", sourceId);
      applied.push({ field: "is_digest", value: "false", ok: !error, err: error?.message });
    }

    else if (issue.auto_field === "sentinel_evidence") {
      const sentinels = evidence.filter(e => e.fact === "__none__");
      for (const e of sentinels) {
        const { error } = await sb.from("evidence").delete().eq("evidence_id", e.evidence_id);
        applied.push({ field: "sentinel_evidence", value: "deleted", ok: !error, err: error?.message });
      }
    }
  }

  return applied;
}

// ── Write to audit log ────────────────────────────────────────────────────────

function buildLogSection(page, batch, sources, judged) {
  const hasIssues = judged.some(j => j.issues.length > 0);
  const label     = `p${page}/b${batch}`;

  const rows = [];
  for (let i = 0; i < Math.min(judged.length, sources.length); i++) {
    const j = judged[i];
    const s = sources[i];              // always positional
    const title   = (s?.title || "").slice(0, 50).replace(/\|/g, "-");
    const shortId = `\`${s.id.slice(0, 8)}\``;

    if (!hasIssues || j.issues.length === 0) {
      rows.push(`| ${title} | ${shortId} | \`wontfix\` | — | Clean. ${j.log_note || ""} | No action. |`);
      continue;
    }

    let first = true;
    for (const iss of j.issues) {
      const status = iss.fix_type === "auto" ? "`fixed`" : iss.fix_type === "flag" ? "`open`" : "`wontfix`";
      const fixText = iss.fix_type === "auto"
        ? `Auto-set \`${iss.auto_field} → ${iss.auto_value}\`.`
        : iss.fix_type === "flag"
        ? "Flagged for manual review."
        : "Accepted divergence.";
      rows.push(`| ${first ? title : ""} | ${first ? shortId : ""} | ${status} | \`${iss.dimension}\` | ${iss.description} | ${fixText} |`);
      first = false;
    }
    if (j.log_note) {
      rows.push(`| | | | | **Note:** ${j.log_note} | |`);
    }
  }

  return `\n### Batch ${label}\n\n| Source | ID (first 8) | Status | Type | Issue | Fix applied |\n|--------|-------------|--------|------|-------|-------------|\n${rows.join("\n")}\n`;
}

function prependBatchToLog(section) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN — would prepend to database_audit.md:]");
    console.log(section);
    return;
  }

  let content = fs.readFileSync(LOG_FILE, "utf8");
  const HDR = "\n## Per-Source Issues\n";
  const hdrIdx = content.indexOf(HDR);

  if (hdrIdx < 0) {
    fs.writeFileSync(LOG_FILE, content + section, "utf8");
    return;
  }

  // Insert before the first ### Batch heading in the Per-Source Issues section
  const searchFrom = hdrIdx + HDR.length;
  const firstBatch = content.indexOf("\n### Batch", searchFrom);

  if (firstBatch < 0) {
    fs.writeFileSync(LOG_FILE, content + section, "utf8");
    return;
  }

  // Prepend new section before the first existing batch
  const before = content.slice(0, firstBatch);
  const after  = content.slice(firstBatch);
  fs.writeFileSync(LOG_FILE, before + section + "\n" + after, "utf8");
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  if (!GEMINI_API_KEY) { console.error("ERROR: GEMINI_API_KEY not set"); process.exit(1); }

  const prog = loadProgress();
  let page      = CLI_PAGE  ?? prog.page;
  let batch     = CLI_BATCH ?? prog.batch;
  let totalDone = prog.totalDone ?? 0;
  let runCount  = 0;

  console.log(`\n  The Horizon — Auto Corpus Audit  [Gemini ${GEMINI_MODEL}]`);
  console.log(`  Resuming from page ${page}, batch ${batch}  (${totalDone} batches done previously)`);
  if (DRY_RUN) console.log("  DRY RUN — no writes");
  console.log();

  while (runCount < LIMIT) {
    process.stdout.write(`  [p${page}/b${batch}] loading...`);

    let sources, totalInWindow, offset;
    try {
      ({ sources, totalInWindow, offset } = await loadBatch(page, batch));
    } catch (err) {
      console.error(`\n  DB error: ${err.message}`);
      break;
    }

    if (sources.length === 0) {
      if (totalInWindow === 0) {
        // No sources at all on this page — corpus exhausted
        console.log(` corpus exhausted at page ${page}. All done.`);
        break;
      }
      if (offset >= totalInWindow) {
        console.log(` page ${page} exhausted (${totalInWindow} sources). → page ${page + 1}`);
        page += 1; batch = 1;
        saveProgress({ page, batch, totalDone, lastRun: new Date().toISOString() });
        continue;
      }
      console.log(" (empty batch — skipping)");
      batch += 1;
      continue;
    }

    process.stdout.write(` ${sources.length} sources. Calling Gemini...`);

    // Load evidence in parallel
    const evMap = Object.fromEntries(
      await Promise.all(sources.map(async s => [s.id, await loadEvidence(s.id)]))
    );

    // Build user prompt
    const userPrompt = sources
      .map((s, i) => formatSource(s, evMap[s.id], i + 1))
      .join(`\n\n${"─".repeat(60)}\n\n`);

    // Call Gemini
    let judgeResult;
    try {
      judgeResult = await callGemini(SYSTEM_PROMPT, userPrompt, RESPONSE_SCHEMA);
      process.stdout.write(" ✓\n");
    } catch (err) {
      console.error(`\n  Gemini failed: ${err.message} — skipping batch`);
      batch += 1; runCount += 1;
      saveProgress({ page, batch, totalDone: totalDone + 1, lastRun: new Date().toISOString() });
      continue;
    }

    const judged = judgeResult.sources || [];

    // Print summary + apply auto-fixes
    // Always use positional matching — j.id can be wrong (Gemini may read parent_source_id
    // or other IDs from the prompt context instead of the actual source ID).
    for (let i = 0; i < Math.min(judged.length, sources.length); i++) {
      const j   = judged[i];
      const src = sources[i];            // positional — authoritative
      const ev  = evMap[src.id] || [];

      if (j.id && j.id !== src.id) {
        console.warn(`    ⚠ ID mismatch at position ${i + 1}: Gemini reported ${j.id.slice(0, 8)} but actual is ${src.id.slice(0, 8)} — using actual`);
        j.id = src.id;                   // correct it in place for log output
      }

      const autoCount = (j.issues || []).filter(x => x.fix_type === "auto").length;
      const flagCount = (j.issues || []).filter(x => x.fix_type === "flag").length;

      const summary = j.verdict === "clean"
        ? `clean`
        : `${autoCount} auto-fix, ${flagCount} flag: ${(j.issues || []).map(x => `${x.dimension}(${x.fix_type})`).join(", ")}`;
      console.log(`    ${src.id.slice(0, 8)} — ${summary}`);

      if (!DRY_RUN && (j.issues || []).length > 0) {
        const applied = await applyAutoFixes(src.id, j.issues, ev);
        for (const f of applied) {
          if (!f.ok) console.warn(`      ⚠ fix failed ${f.field}: ${f.err}`);
          else        console.log(`      ✓ ${f.field} → ${f.value}`);
        }
      }
    }

    // Write to log
    const section = buildLogSection(page, batch, sources, judged);
    prependBatchToLog(section);

    // Advance
    totalDone += 1;
    runCount  += 1;
    batch     += 1;

    // Check page exhaustion for next iteration
    const nextOffset = (batch - 1) * BATCH_SIZE;
    if (nextOffset >= totalInWindow) {
      console.log(`  Page ${page} exhausted. → page ${page + 1}`);
      page += 1; batch = 1;
    }

    saveProgress({ page, batch, totalDone, lastRun: new Date().toISOString() });

    if (runCount < LIMIT) await sleep(800);
  }

  console.log(`\n  Done. ${runCount} batch(es) this run, ${totalDone} total.`);
  console.log(`  Next run resumes at page ${page}, batch ${batch}.`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
