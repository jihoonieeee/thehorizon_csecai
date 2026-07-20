#!/usr/bin/env node
/**
 * ingestGtigReports.js — one-shot ingest + fanout + understand for the 3 GTIG reports.
 *
 * Reports:
 *   A. "Distillation / Experimentation" (Feb 2026) — not yet in DB
 *   B. "Threat Actor Usage of AI Tools"  (Nov 2025) — not yet in DB
 *   C. "AI Vulnerability Exploitation"   (May 2026) — already in DB, not fanned out
 *
 * Pipeline:
 *   1. Fetch full text via Jina reader (JS-rendered pages)
 *   2. Build + upsert source rows into DB
 *   3. detectDigest → fanOutDigest (LLM) → upsert children
 *   4. understandAllSources on children
 *   5. extractAndSaveReportInsights on digest parents
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createHash }   from "crypto";
import { callLLM }      from "../lib/llm/callLLM.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { understandAllSources }       from "../lib/pipeline/understand/understandSource.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

function idFromUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

// ── Fetch via Jina reader (handles JS-rendered pages) ────────────────────────
async function fetchViaJina(url) {
  console.log(`  Fetching via Jina: ${url.slice(0, 80)}…`);
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain", "X-Return-Format": "text" },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status} for ${url}`);
  const raw = await res.text();
  // Strip Jina metadata header lines
  const text = raw.replace(/^(Title:|URL Source:|Published Time:|Jump to Content\n)[^\n]*\n/gm, "").trim();
  console.log(`  → ${text.length} chars`);
  return text;
}

// ── Source definitions ────────────────────────────────────────────────────────
const REPORTS = [
  {
    label: "A — Distillation/Experimentation (Feb 2026)",
    url:   "https://cloud.google.com/blog/topics/threat-intelligence/distillation-experimentation-integration-ai-adversarial-use",
    date_published: "2026-02-12",
    title: "GTIG AI Threat Tracker: Distillation, Experimentation, and (Continued) Integration of AI for Adversarial Use",
    publisher: "Google Threat Intelligence Group (GTIG)",
    trust_tier: "primary",
    source_type: "threat_intelligence",
    alreadyInDb: false,
  },
  {
    label: "B — Threat Actor Usage of AI Tools (Nov 2025)",
    url:   "https://cloud.google.com/blog/topics/threat-intelligence/threat-actor-usage-of-ai-tools",
    date_published: "2025-11-05",
    title: "GTIG AI Threat Tracker: Advances in Threat Actor Usage of AI Tools",
    publisher: "Google Threat Intelligence Group (GTIG)",
    trust_tier: "primary",
    source_type: "threat_intelligence",
    alreadyInDb: false,
  },
  {
    label: "C — AI Vulnerability Exploitation (May 2026) — already in DB",
    url:   "https://cloud.google.com/blog/topics/threat-intelligence/ai-vulnerability-exploitation-initial-access",
    date_published: "2026-05-12",
    title: "GTIG AI Threat Tracker: Adversaries Leverage AI for Vulnerability Exploitation, Augmented Operations, and Initial Access",
    publisher: "Google Threat Intelligence Group (GTIG) / Mandiant",
    trust_tier: "primary",
    source_type: "threat_intelligence",
    alreadyInDb: true,   // id 33239de8 exists — skip fetch/upsert, go straight to fanout
  },
];

async function main() {
  const scoredAt = new Date().toISOString();

  // ── Step 1 & 2: Fetch + upsert new sources ───────────────────────────────────
  console.log("\n══ Step 1/2: Fetch full text + upsert into DB ══════════════════");
  const sources = [];

  for (const r of REPORTS) {
    console.log(`\n▸ ${r.label}`);
    const id = idFromUrl(r.url);
    console.log(`  ID: ${id}`);

    let full_text;
    if (r.alreadyInDb) {
      // Load existing row's full_text from DB
      const { data } = await sb.from("sources")
        .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
        .eq("id", id)
        .single();
      if (!data) { console.error("  ERROR: not found in DB"); continue; }
      full_text = data.full_text || "";
      console.log(`  Loaded from DB — full_text: ${full_text.length} chars, is_digest: ${data.is_digest}`);
      sources.push(data);
      continue;
    }

    try {
      full_text = await fetchViaJina(r.url);
    } catch (err) {
      console.error(`  FETCH ERROR: ${err.message}`);
      continue;
    }

    const row = {
      id,
      title:          r.title,
      url:            r.url,
      publisher:      r.publisher,
      trust_tier:     r.trust_tier,
      source_type:    r.source_type,
      date_published: new Date(r.date_published).toISOString(),
      date_confidence: "exact",
      full_text,
      summary: full_text.slice(0, 600),
      candidate_domain: "ai_enabled_threats",
    };

    const { error } = await sb.from("sources").upsert(row, { onConflict: "id", ignoreDuplicates: false });
    if (error) { console.error(`  DB UPSERT ERROR: ${error.message}`); continue; }
    console.log(`  ✓ Upserted to DB`);

    // Load full row back (needed by fanout)
    const { data: saved } = await sb.from("sources")
      .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
      .eq("id", id)
      .single();
    sources.push(saved);
  }

  // ── Step 3: detectDigest + fanOutDigest ──────────────────────────────────────
  console.log("\n══ Step 3: Digest detection + fanout ═══════════════════════════");
  const allChildren = [];

  for (const src of sources) {
    console.log(`\n▸ ${src.title?.slice(0, 70)}`);

    const det = detectDigest(src);
    console.log(`  detectDigest → is_digest: ${det.is_digest}, reason: ${det.reason}`);

    if (!det.is_digest) {
      console.log(`  ↳ Not a digest — skipping fanout`);
      continue;
    }

    // Skip if already fanned out (has children in DB)
    const { count: existingChildren } = await sb.from("sources")
      .select("*", { count: "exact", head: true })
      .eq("parent_source_id", src.id);
    if (existingChildren > 0) {
      console.log(`  ↳ Already fanned out (${existingChildren} children in DB) — skipping`);
      // Load children for understand step
      const { data: kids } = await sb.from("sources")
        .select("id,title,url,publisher,date_published,full_text,source_type,trust_tier,is_digest,intelligence,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,parent_source_id,summary")
        .eq("parent_source_id", src.id);
      allChildren.push(...(kids || []));
      continue;
    }

    console.log(`  Running fanOutDigest (LLM)…`);
    let fanout;
    try {
      fanout = await fanOutDigest(src, { llmFn, scoredAt });
    } catch (err) {
      console.error(`  FANOUT ERROR: ${err.message}`);
      continue;
    }

    const { is_digest, reason, children, parent_patch } = fanout;
    if (!is_digest || !children.length) {
      console.log(`  ↳ LLM says single-topic (reason: ${reason}) — no children`);
      // Mark parent as classified (not a digest in the LLM's view)
      await sb.from("sources").update({
        is_digest: false,
        validation_status: "pass",
        layer3_status: "pass",
        main_category: "ai_enabled_threats",
      }).eq("id", src.id);
      continue;
    }

    console.log(`  ↳ LLM confirmed digest — ${children.length} children extracted`);
    children.forEach((c, i) => console.log(`    [${i+1}] ${c.title?.slice(0, 70)}`));

    // Write children to DB
    const { error: childErr } = await sb.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
    if (childErr) { console.error(`  CHILD WRITE ERROR: ${childErr.message}`); }
    else console.log(`  ✓ ${children.length} children written to DB`);

    // Mark parent as digest container
    const { error: parentErr } = await sb.from("sources").update({
      is_digest:         true,
      main_category:     "unclear_or_adjacent",
      validation_status: "pass",
      layer3_status:     "pass",
      intelligence: { ...(src.intelligence || {}), ...parent_patch.intelligence },
    }).eq("id", src.id);
    if (parentErr) { console.error(`  PARENT UPDATE ERROR: ${parentErr.message}`); }
    else console.log(`  ✓ Parent marked as digest container (unclear_or_adjacent)`);

    allChildren.push(...children);

    // Kick off report-insights extraction (async, don't block)
    console.log(`  Queuing extractAndSaveReportInsights…`);
    extractAndSaveReportInsights(
      { ...src, intelligence: { ...(src.intelligence || {}), ...parent_patch?.intelligence }, is_digest: true },
      sb,
    ).then(() => console.log(`  ✓ Report insights extracted for: ${src.title?.slice(0, 60)}`))
     .catch(e => console.warn(`  ! Report insights failed: ${e.message}`));
  }

  // ── Step 4: understandAllSources on children ──────────────────────────────────
  if (!allChildren.length) {
    console.log("\n══ Step 4: No children to classify ════════════════════════════");
    return;
  }

  // Only classify children that don't have a main_category yet
  const toClassify = allChildren.filter(c => !c.main_category);
  const alreadyDone = allChildren.filter(c => c.main_category);
  console.log(`\n══ Step 4: Classify ${toClassify.length} children (${alreadyDone.length} already classified) ═`);

  if (alreadyDone.length) {
    alreadyDone.forEach(c => console.log(`  [skip] ${c.main_category} — ${c.title?.slice(0, 60)}`));
  }

  if (toClassify.length) {
    console.log(`  Running understandAllSources on ${toClassify.length} children…`);
    const { relevant, discarded, counts } = await understandAllSources(toClassify, {
      llmFn,
      concurrency: 3,
      supabase: sb,
      onProgress: (done, total) => process.stdout.write(`\r  progress: ${done}/${total}`),
    });
    console.log(`\n  Classify complete — pass: ${counts?.pass ?? relevant.length}, discard: ${counts?.discard ?? discarded.length}`);
    relevant.forEach(c => console.log(`    [pass]    ${c.category} — ${c.title?.slice(0, 60)}`));
    discarded.forEach(c => console.log(`    [discard] ${c.title?.slice(0, 60)}`));
  }

  console.log("\n══ All done ════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("FATAL:", e.message, e.stack); process.exit(1); });
