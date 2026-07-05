#!/usr/bin/env node
/**
 * reprocessDigests.js — fan multi-topic reports out into per-item child sources.
 *
 * Finds digest sources (weekly bulletins / roundups / newsletters), extracts each
 * distinct AI-security item with ONE LLM call, classifies every item through the
 * same deterministic mapToTaxonomy path (via normalise), and writes the items back
 * as CHILD sources (parent_source_id → the digest). The parent is flagged is_digest.
 *
 * This is intentionally an opt-in SCRIPT (not wired into the live cron) so it can
 * be run and reviewed deliberately — same pattern as the web-discovery branch.
 *
 * Requires migration 012_digest_fanout.sql (parent_source_id, is_digest columns).
 *
 * Usage:
 *   node scripts/reprocessDigests.js                 # dry run — detect + extract, print, no writes
 *   node scripts/reprocessDigests.js --live          # write child sources + flag parents
 *   node scripts/reprocessDigests.js --id <sourceId> # a single source
 *   node scripts/reprocessDigests.js --limit 20      # cap how many digests to process
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { callLLM } from "../lib/llm/callLLM.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const idArg = args.includes("--id") ? args[args.indexOf("--id") + 1] : null;
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : 25;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SELECT = "id,title,url,publisher,date_published,source_type,trust_tier,full_text,clean_text,summary,intelligence,is_digest";

// callLLM(sys, usr, opts) is the production extractor; the module stays test-injectable.
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

async function candidateDigests() {
  if (idArg) {
    const { data } = await sb.from("sources").select(SELECT).eq("id", idArg);
    return data || [];
  }
  // Only top-level sources (never fan out a child), not already fanned out.
  const { data } = await sb.from("sources").select(SELECT)
    .is("parent_source_id", null)
    .not("is_digest", "is", true)
    .order("date_published", { ascending: false })
    .limit(1000);
  return (data || []).filter(s => detectDigest(s).is_digest).slice(0, limit);
}

async function main() {
  const scoredAt = new Date().toISOString();
  const digests = await candidateDigests();
  console.log(`\n${digests.length} digest candidate(s) ${LIVE ? "(LIVE)" : "(DRY RUN)"}\n`);

  let totalChildren = 0, wroteParents = 0;
  for (const s of digests) {
    let result;
    try {
      result = await fanOutDigest(s, { llmFn, scoredAt });
    } catch (e) {
      console.log(`  ✗ ${s.id.slice(0, 8)} ${s.title?.slice(0, 50)} — ${e.message.slice(0, 60)}`);
      continue;
    }
    if (!result.is_digest || !result.children.length) {
      console.log(`  – ${s.id.slice(0, 8)} ${s.title?.slice(0, 50)} — no items (${result.reason || "single-topic"})`);
      continue;
    }
    console.log(`  ▸ ${s.title?.slice(0, 60)}  →  ${result.children.length} items:`);
    for (const c of result.children) {
      console.log(`      [${c.main_category}${c.tags?.length ? " " + c.tags.filter(t => /^(TAI|LLM|ASI|AE)\d/.test(t)).join(",") : ""}] ${c.title?.slice(0, 60)}`);
    }
    totalChildren += result.children.length;

    if (LIVE) {
      const rows = result.children.map(({ _norm, ...row }) => row);
      const { error: ce } = await sb.from("sources").upsert(rows, { onConflict: "id", ignoreDuplicates: false });
      if (ce) { console.log(`      ! child write: ${ce.message.slice(0, 70)}`); continue; }
      const { error: pe } = await sb.from("sources").update({ is_digest: true, intelligence: result.parent_patch.intelligence }).eq("id", s.id);
      if (pe) console.log(`      ! parent flag: ${pe.message.slice(0, 70)}`); else wroteParents++;
    }
  }

  console.log(`\n${LIVE ? "Wrote" : "Would write"} ${totalChildren} child sources across ${wroteParents || digests.length} digests.`);
  if (!LIVE) console.log("Re-run with --live to apply.");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
