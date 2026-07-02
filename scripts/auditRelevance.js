#!/usr/bin/env node
/**
 * auditRelevance.js
 *
 * Two-stage relevance audit of the pass corpus:
 *   Stage 1 (triage): a strict LLM judge scans title + summary in batches and
 *     flags any source that is not clearly a concrete AI cyber-threat finding
 *     (marketing, explainers, event recaps, opinion, off-topic, vague).
 *   Stage 2 (recheck): each flagged source is re-run through the full
 *     understandSource() classifier (with the tightened prompt + gates).
 *   Purge: sources the full classifier now judges irrelevant OR
 *     unclear_or_adjacent are deleted (curated sources are never deleted).
 *
 * Usage:
 *   node scripts/auditRelevance.js --dry-run            # report only, no deletes
 *   node scripts/auditRelevance.js                       # live: recheck + purge
 *   node scripts/auditRelevance.js --triage-only          # stage 1 only, list flags
 *   node scripts/auditRelevance.js --limit 500            # cap sources scanned
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understandSource.js";
import { callLLM } from "../lib/llm/callLLM.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const TRIAGE_ONLY = args.includes("--triage-only");
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT    = parseInt(getArg("--limit", "0"), 10);
const BATCH    = 25;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Stage 1: strict triage judge ────────────────────────────────────────────────

const TRIAGE_SYSTEM = `You are a relevance auditor for an AI CYBER threat-intelligence corpus. You screen out sources that do NOT belong, while KEEPING all genuine AI-threat research and reporting.

KEEP (v="keep") — any source that contributes knowledge about a specific AI attack or defense, INCLUDING:
  • research demonstrating or measuring an attack on/using AI (jailbreaks, prompt injection, data/model poisoning, membership inference, model extraction/inversion, adversarial evasion of a security classifier, RAG poisoning, backdoors)
  • a CVE/vulnerability in an AI system or dependency
  • a real incident, breach, campaign, or threat actor using AI
  • red-teaming frameworks, attack benchmarks, or evaluations that PRODUCE attack results
  • a specific defense/mitigation/detection against a named AI threat
  Research papers and benchmarks that study AI attacks ARE in scope — keep them.

FLAG (v="flag") — only if the source does NOT establish any AI-attack/defense knowledge, i.e. it is:
  • vendor marketing / product launch / funding / partnership / "Introducing <product>"
  • a generic explainer or "what is X" / beginner guide / "X 101" with no new finding
  • an event/webinar/summit/podcast promo or recap
  • opinion / thought-leadership / year-in-review with no specific technique or incident
  • a trend roundup with no new finding
  • off-topic: general IT/business/finance/politics/non-security, or an AI capability/benchmark with NO security or attack angle at all
  • PHYSICAL-WORLD / robotics adversarial ML: evading facial recognition/CCTV via clothing or makeup, autonomous-vehicle/drone/robot sensor attacks, physical camouflage (these target the physical world, not cyber systems)

Bias toward KEEP for genuine research. Only flag clear marketing, explainers, events, opinion, off-topic, or physical-world items. When genuinely unsure whether it's research vs marketing, flag it (a full re-check decides).

Return ONLY JSON: {"verdicts":[{"i":0,"v":"keep"|"flag","why":"short reason if flag, else null"}]}`;

function buildTriagePrompt(batch) {
  const lines = batch.map((s, i) =>
    `[${i}] (${s.main_category?.replace("_ai_threats","")||"?"}) ${(s.title||"").slice(0,140)}\n     ${(s.short_summary||"").slice(0,180)}`
  ).join("\n\n");
  return `Audit these ${batch.length} sources:\n\n${lines}\n\nReturn a verdict for every index 0..${batch.length-1}.`;
}

async function triageBatch(batch) {
  try {
    const raw = await callLLM(TRIAGE_SYSTEM, buildTriagePrompt(batch), {
      task: "relevance_audit", json: true,
      schema: {
        type: "object",
        properties: { verdicts: { type: "array", items: {
          type: "object",
          properties: { i: { type: "integer" }, v: { type: "string", enum: ["keep","flag"] }, why: { type: "string" } },
          required: ["i","v"],
        } } },
        required: ["verdicts"],
      },
    });
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const byIdx = new Map((parsed?.verdicts||[]).map(v => [v.i, v]));
    return batch.map((s, i) => {
      const v = byIdx.get(i);
      return { source: s, flagged: v?.v === "flag", why: v?.why || null };
    });
  } catch (e) {
    // On triage failure, don't flag (conservative — avoid false purges)
    console.warn(`  [triage] batch error: ${e.message.slice(0,50)}`);
    return batch.map(s => ({ source: s, flagged: false, why: "triage_error" }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  Relevance Audit  ${DRY_RUN ? "(DRY RUN)" : TRIAGE_ONLY ? "(TRIAGE ONLY)" : "(LIVE — will purge)"}`);
  console.log(`${"═".repeat(62)}\n`);

  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("sources")
      .select("id,title,url,publisher,date_published,trust_tier,full_text,clean_text,summary,main_category,validation_status,source_type,tags,short_summary,intelligence")
      .eq("validation_status","pass").range(from, from+999);
    if (!data?.length) break;
    all.push(...data); if (data.length < 1000) break;
    if (LIMIT && all.length >= LIMIT) break;
  }
  const sources = LIMIT ? all.slice(0, LIMIT) : all;
  console.log(`  Scanning ${sources.length} pass sources\n`);

  // ── Stage 1: triage ────────────────────────────────────────────────────────
  const flagged = [];
  let done = 0;
  for (let i = 0; i < sources.length; i += BATCH) {
    const batch = sources.slice(i, i + BATCH);
    const results = await triageBatch(batch);
    for (const r of results) if (r.flagged) flagged.push(r);
    done += batch.length;
    process.stdout.write(`  triage ${done}/${sources.length} · flagged ${flagged.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`\n  Stage 1: ${flagged.length}/${sources.length} flagged for re-check\n`);

  if (TRIAGE_ONLY) {
    console.log("  Flagged sources:");
    flagged.forEach(f => console.log(`    [${f.source.main_category?.replace("_ai_threats","")}] ${f.source.title?.slice(0,66)}\n        why: ${f.why}`));
    return;
  }

  // ── Stage 2: full re-check ──────────────────────────────────────────────────
  const CURATED = s => s.trust_tier === "curated" || (s.tags||[]).includes("curated");
  const toPurge = [];
  const reclassified = [];
  let rechecked = 0;
  const CONC = 4;

  for (let i = 0; i < flagged.length; i += CONC) {
    const chunk = flagged.slice(i, i + CONC);
    const results = await Promise.all(chunk.map(async f => {
      const src = { ...f.source, main_category: null, validation_status: null };
      const u = await understandSource(src, { skipLlm: false }).catch(() => null);
      return { f, u };
    }));

    for (const { f, u } of results) {
      rechecked++;
      if (!u) continue;
      const irrelevant = !u.relevant || u.category === "unclear_or_adjacent";
      if (irrelevant) {
        if (CURATED(f.source)) {
          // Never delete curated — just demote category
          if (!DRY_RUN) await sb.from("sources").update({ main_category: "unclear_or_adjacent" }).eq("id", f.source.id);
        } else {
          toPurge.push({ ...f.source, _why: f.why, _new: u.category, _rel: u.relevant });
        }
      } else if (u.category !== f.source.main_category) {
        // Still relevant but re-categorised — update in place
        reclassified.push({ id: f.source.id, from: f.source.main_category, to: u.category, title: f.source.title });
        if (!DRY_RUN) {
          await sb.from("sources").update({
            main_category: u.category,
            tags: u.primary_tags || [],
            source_type: u.source_type,
            short_summary: u.short_summary || f.source.short_summary,
          }).eq("id", f.source.id);
        }
      }
    }
    process.stdout.write(`  recheck ${rechecked}/${flagged.length} · purge ${toPurge.length} · reclass ${reclassified.length}\r`);
  }
  process.stdout.write("\n");

  // ── Purge ────────────────────────────────────────────────────────────────────
  console.log(`\n  Stage 2 results:`);
  console.log(`    Re-checked:    ${rechecked}`);
  console.log(`    Reclassified:  ${reclassified.length} (still relevant, new category)`);
  console.log(`    To purge:      ${toPurge.length} (irrelevant on full re-check)\n`);

  if (reclassified.length) {
    console.log("  Reclassified (sample):");
    reclassified.slice(0,10).forEach(r => console.log(`    ${r.from?.replace("_ai_threats","")} → ${r.to?.replace("_ai_threats","")}  ${r.title?.slice(0,55)}`));
  }

  if (toPurge.length) {
    console.log("\n  Purging (sample):");
    toPurge.slice(0,20).forEach(s => console.log(`    [${s.main_category?.replace("_ai_threats","")}] ${s.title?.slice(0,60)}  (${s._why?.slice(0,30)})`));
    if (toPurge.length > 20) console.log(`    ... and ${toPurge.length-20} more`);

    if (!DRY_RUN) {
      const ids = toPurge.map(s => s.id);
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i+100);
        const { error, count } = await sb.from("sources").delete({ count: "exact" }).in("id", chunk);
        if (error) console.warn(`    delete error: ${error.message.slice(0,50)}`);
        else deleted += count || chunk.length;
      }
      console.log(`\n  Purged ${deleted} sources.`);
    } else {
      console.log(`\n  DRY RUN — would purge ${toPurge.length} sources.`);
    }
  }

  console.log(`\n${"═".repeat(62)}\n`);
}

main().then(() => flushCostBuffer()).catch(err => { console.error("FATAL:", err.message); process.exit(1); });
