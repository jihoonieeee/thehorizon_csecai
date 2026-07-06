#!/usr/bin/env node
/**
 * resortLlmEvidenceRole.js — apply the second-stage evidence-role classifier to the
 * existing llm_threats corpus so DATA matches the classifier gates (no API).
 *
 * For every llm_threats source:
 *   - if it carries LLM02, run classifyLlm02(); drop LLM02 if evidence_role is not a
 *     disclosure_* role, and add its secondary_tags (LLM01 / LLM04).
 *   - if it carries LLM01, run classifyLlm01(); drop LLM01 if not genuine prompt
 *     injection, and add its secondary_tags (LLM04).
 *   - after edits, if the source has NO offensive-domain technique tag left, move
 *     main_category → unclear_or_adjacent.
 * Curated sources are never modified.
 *
 * Usage: node scripts/resortLlmEvidenceRole.js [--live]
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { classifyLlm01, classifyLlm02 } from "../lib/pipeline/understand/classifyEvidenceRole.js";

const DRY = !process.argv.includes("--live");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const isDomainTag = (t) => /^(TAI|LLM|ASI|AE)\d/.test(t);

async function main() {
  console.log(`\n${"═".repeat(60)}\n  LLM evidence-role re-sort  ${DRY ? "(DRY RUN)" : "(LIVE)"}\n${"═".repeat(60)}\n`);
  const all = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("sources")
      .select("id,title,short_summary,full_text,clean_text,summary,tags,source_type,trust_tier,main_category")
      .eq("main_category", "llm_threats").range(f, f + 999);
    if (!data?.length) break; all.push(...data); if (data.length < 1000) break;
  }
  console.log(`  ${all.length} llm_threats sources\n`);

  const updates = [];
  const stat = { llm02_removed: 0, llm01_removed: 0, moved_unclear: 0, secondary_added: 0 };

  for (const s of all) {
    if (s.trust_tier === "curated" || String(s.id).startsWith("curated")) continue;
    let tags = [...(s.tags || [])];
    const before = tags.join("|");

    if (tags.includes("LLM02_sensitive_info_disclosure")) {
      const r = classifyLlm02(s);
      if (!r.keep) { tags = tags.filter(t => t !== "LLM02_sensitive_info_disclosure"); stat.llm02_removed++; }
      for (const st of r.secondary_tags) if (!tags.includes(st)) { tags.push(st); stat.secondary_added++; }
    }
    if (tags.includes("LLM01_prompt_injection")) {
      const r = classifyLlm01(s);
      if (!r.keep) { tags = tags.filter(t => t !== "LLM01_prompt_injection"); stat.llm01_removed++; }
      for (const st of r.secondary_tags) if (!tags.includes(st)) { tags.push(st); stat.secondary_added++; }
    }
    tags = [...new Set(tags)];

    const patch = { id: s.id };
    let changed = before !== tags.filter(t => t !== undefined).join("|");
    if (!tags.some(isDomainTag)) {           // no technique left → unclear
      patch.main_category = "unclear_or_adjacent";
      tags = tags.filter(t => t === "defensive");
      stat.moved_unclear++; changed = true;
    }
    if (changed) { patch.tags = tags; updates.push(patch); }
  }

  console.log(`  LLM02 dropped: ${stat.llm02_removed} | LLM01 dropped: ${stat.llm01_removed}`);
  console.log(`  secondary tags added: ${stat.secondary_added} | moved to unclear: ${stat.moved_unclear}`);
  console.log(`  rows to update: ${updates.length}\n`);

  if (DRY) { console.log("  DRY RUN — no writes.\n"); return; }
  let n = 0;
  for (const u of updates) {
    const { id, ...patch } = u;
    const { error } = await sb.from("sources").update(patch).eq("id", id);
    if (error) console.warn(`  ${id.slice(0,10)}: ${error.message.slice(0,50)}`); else n++;
    if (n % 50 === 0) process.stdout.write(`  ${n}/${updates.length}\r`);
  }
  console.log(`\n  Applied ${n}/${updates.length}.\n`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
