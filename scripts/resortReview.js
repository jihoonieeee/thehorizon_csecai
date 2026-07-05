#!/usr/bin/env node
/**
 * resortReview.js — category-by-category, batch-of-10 corpus resort with review.
 *
 * The analyst (LLM in-conversation) reads a batch, decides the MECHANISM fields
 * for each source, and this script runs them through the SAME normalise() path
 * that live ingestion uses (mechanism → deterministic map → tag) so the corpus
 * ends up identical to future ingestion output.
 *
 * Two modes:
 *
 *   fetch  — print a batch of 10 sources for review.
 *     node scripts/resortReview.js fetch <category> <offset> [limit]
 *     categories: traditional_ai_threats | llm_threats | agentic_ai_threats |
 *                 ai_enabled_threats | unclear_or_adjacent
 *
 *   apply  — read a JSON array of judgments from a file and apply via normalise().
 *     node scripts/resortReview.js apply <judgments.json>            # dry-run diff
 *     node scripts/resortReview.js apply <judgments.json> --live     # write to DB
 *
 *   Judgment shape (one per source):
 *     { "id": "...", "primary_exploit_mechanism": "...", "primary_consequence": "...",
 *       "affected_layer": "...", "primary_security_property": "...",
 *       "mechanism_evidence_role": "attack|defense|benchmark|...",
 *       "is_defensive": false, "attack_medium": null,
 *       "mechanism_rationale": "one sentence" }
 */
import "dotenv/config";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { normalise } from "../lib/pipeline/understandSource.js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SELECT = "id,title,url,publisher,date_published,full_text,clean_text,summary,short_summary,tags,source_type,trust_tier,main_category,intelligence";
const isDomainTag = (t) => /^(TAI|LLM|ASI|AE)\d/.test(t);

async function fetchCategory(category, afterId, limit) {
  let q = sb.from("sources").select(SELECT)
    .eq("main_category", category)
    .order("id", { ascending: true })
    .limit(limit);
  if (afterId) q = q.gt("id", afterId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchByIds(ids) {
  const { data, error } = await sb.from("sources").select(SELECT).in("id", ids);
  if (error) throw new Error(error.message);
  return data || [];
}

async function countCategory(category) {
  const { count } = await sb.from("sources").select("*", { count: "exact", head: true }).eq("main_category", category);
  return count;
}

function printSource(s, i) {
  const tags = (s.tags || []).filter(isDomainTag);
  const body = (s.short_summary || s.summary || (s.full_text || s.clean_text || "").slice(0, 500) || "").replace(/\s+/g, " ").trim();
  console.log(`\n[${i}] id=${s.id}`);
  console.log(`    TITLE: ${s.title || "(untitled)"}`);
  console.log(`    PUBLISHER: ${s.publisher || "?"}   TYPE: ${s.source_type || "?"}   TRUST: ${s.trust_tier || "?"}`);
  console.log(`    CURRENT: ${s.main_category}  [${tags.join(", ") || "no domain tags"}]${(s.tags||[]).includes("defensive") ? " +defensive" : ""}`);
  console.log(`    SUMMARY: ${body.slice(0, 500)}`);
}

async function doFetch() {
  const category = process.argv[3];
  // Keyset pagination: pass the last processed id as the 4th arg ("-" or omitted = start).
  const afterArg = process.argv[4];
  const afterId = (!afterArg || afterArg === "-" || afterArg === "0") ? null : afterArg;
  const limit = parseInt(process.argv[5] || "10", 10);
  if (!category) { console.error("usage: fetch <category> <afterId|-> [limit]"); process.exit(1); }
  const total = await countCategory(category);
  const rows = await fetchCategory(category, afterId, limit);
  console.log(`\n═══ ${category}  (${total} remaining)  after id=${afterId || "START"} ═══`);
  rows.forEach((s, i) => printSource(s, i));
  const lastId = rows.length ? rows[rows.length - 1].id : afterId;
  console.log(`\n(${rows.length} sources; next: fetch ${category} ${lastId})`);
}

async function doApply() {
  const file = process.argv[3];
  const live = process.argv.includes("--live");
  if (!file) { console.error("usage: apply <judgments.json> [--live]"); process.exit(1); }
  const judgments = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = Object.fromEntries((await fetchByIds(judgments.map(j => j.id))).map(s => [String(s.id), s]));

  console.log(`\n═══ APPLY ${live ? "(LIVE)" : "(DRY RUN)"} — ${judgments.length} judgments ═══`);
  const writes = [];
  for (const j of judgments) {
    const s = byId[String(j.id)];
    if (!s) { console.log(`  ⚠ ${j.id}: not found`); continue; }
    // Curated sources ARE reclassified (retag only; never deleted).

    const raw = {
      relevant: true,
      primary_security_property: j.primary_security_property,
      primary_exploit_mechanism: j.primary_exploit_mechanism,
      primary_consequence: j.primary_consequence,
      affected_layer: j.affected_layer,
      mechanism_evidence_role: j.mechanism_evidence_role,
      attack_medium: j.attack_medium ?? null,
      mechanism_rationale: j.mechanism_rationale ?? null,
      benchmark_target_mechanism: j.benchmark_target_mechanism ?? null,
      target_is_llm: j.target_is_llm === true,
      is_defensive: j.is_defensive === true,
      source_type: s.source_type,
      trust_tier: s.trust_tier,
      short_summary: s.short_summary || s.summary || "",
    };
    const r = normalise(raw, s);

    const oldTags = (s.tags || []).filter(isDomainTag).join(", ") || "—";
    const newTags = (r.primary_tags || []).filter(isDomainTag).join(", ") || "—";
    const changed = s.main_category !== r.category || oldTags !== newTags;
    const mark = changed ? "→" : "=";
    console.log(`  ${mark} ${String(j.id).slice(0,10)} ${s.main_category}[${oldTags}] ${mark} ${r.category}[${newTags}]  (${j.primary_exploit_mechanism}/${j.primary_consequence})`);

    writes.push({
      id: s.id,
      main_category: r.category,
      tags: r.primary_tags || [],
      source_type: r.source_type,
      validation_status: "pass",
      layer3_status: "pass",
      intelligence: {
        ...(s.intelligence || {}),
        is_defensive: r.is_defensive || false,
        defended_category: r.defended_category || null,
        mechanism_classification: r.mechanism_classification || null,
      },
    });
  }

  if (!live) { console.log(`\n  DRY RUN — ${writes.length} would be written. Add --live to apply.`); return; }
  let n = 0;
  for (const w of writes) {
    const { id, ...patch } = w;
    const { error } = await sb.from("sources").update(patch).eq("id", id);
    if (error) console.warn(`  ✗ ${String(id).slice(0,10)}: ${error.message.slice(0,60)}`); else n++;
  }
  console.log(`\n  Applied ${n}/${writes.length}.`);
}

const mode = process.argv[2];
(mode === "fetch" ? doFetch() : mode === "apply" ? doApply() : Promise.reject(new Error("mode must be 'fetch' or 'apply'")))
  .catch(e => { console.error("FATAL:", e.message); process.exit(1); });
