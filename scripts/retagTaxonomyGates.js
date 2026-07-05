#!/usr/bin/env node
/**
 * retagTaxonomyGates.js — deterministic taxonomy-tag hygiene (NO LLM / NO API cost)
 *
 * Applies the SAME deterministic tag gates that understandSource.normalise() now
 * enforces at classify time, retroactively across the whole `sources` table.
 * Currently:
 *
 *   TAI09 (Model Denial of Service) scope gate — TAI09 means an availability /
 *   resource-exhaustion attack (sponge, ReDoS, OOM, algorithmic-complexity blowup,
 *   crash). The classifier historically mis-applied it to adversarial-evasion and
 *   robustness papers where accuracy merely degrades. Strip TAI09 when the source
 *   text shows no DoS/availability signature.
 *
 *   ASI05 (Unexpected Code Execution) scope gate — ASI05 means actual code/command
 *   execution (RCE, shell injection, arbitrary code, deserialization, sandbox
 *   escape, SSTI). The classifier mis-applied it to other web-app CVE classes in
 *   AI/agent products (SSRF, path traversal, file read/write, IDOR, auth/ACL bypass,
 *   DoS). Strip ASI05 when the text shows no code-execution signature.
 *
 * A source is never left with an empty per-domain tag set by this script: if a strip
 * would remove the last tag of that prefix, the strip is skipped (surfaced instead
 * by layerQa's tag_coverage check).
 *
 * Usage:
 *   node scripts/retagTaxonomyGates.js --dry-run
 *   node scripts/retagTaxonomyGates.js
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Regexes MUST stay in sync with the gates in lib/pipeline/understandSource.js
const DOS_RE = /\b(denial[ -]of[ -]service|\bdos\b|\bddos\b|resource exhaust|sponge|memory exhaust|out[ -]of[ -]memory|\boom\b|redos|regular expression denial|algorithmic complexity|amplification|crash|segmentation fault|buffer overflow|unavailab|overload|exhaust the|connection pool|compute cost|latency|throughput|slowdown|hang\b|hanging)\b/i;
const CODE_EXEC_RE = /\b(remote code execution|\brce\b|arbitrary code|arbitrary (os |shell )?command|command execution|command injection|shell injection|shell command|reverse shell|code execution|execut(?:e|es|ed|ing) (arbitrary|malicious|unauthorized|os|shell|code)|deserializ|unsafe pickle|sandbox escape|os command|powershell|template injection|\bssti\b|spawn(?:ed|ing)? a? ?shell|run(?:s|ning)? (?:arbitrary|malicious) code)\b/i;

// Gate registry: each strips one tag from sources that carry it but lack the
// required text signature. `prefix` guards against stranding (won't remove the
// last tag of that domain prefix).
const GATES = [
  { tag: "TAI09_model_denial_of_service", prefix: "TAI", re: DOS_RE,       name: "TAI09 (no DoS signature)" },
  { tag: "ASI05_unexpected_code_execution", prefix: "ASI", re: CODE_EXEC_RE, name: "ASI05 (no code-exec signature)" },
];

async function loadWithTag(tag) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id,title,tags,short_summary,full_text,clean_text,summary")
      .contains("tags", [tag]).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Taxonomy tag-gate retag  ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`${"═".repeat(64)}\n`);

  for (const gate of GATES) {
    const all = await loadWithTag(gate.tag);
    console.log(`  ${all.length} sources carry ${gate.tag}`);

    const updates = [];
    for (const s of all) {
      const text = `${s.title || ""} ${s.short_summary || ""} ${(s.full_text || s.clean_text || s.summary || "").slice(0, 3000)}`;
      if (gate.re.test(text)) continue;                                  // genuine — keep
      const next = (s.tags || []).filter(t => t !== gate.tag);
      if (!next.some(t => t.startsWith(gate.prefix))) continue;          // don't strand tagless
      updates.push({ id: s.id, tags: next, title: s.title });
    }
    console.log(`  → ${gate.name}: strip ${updates.length}`);
    updates.slice(0, 12).forEach(u => console.log(`      − ${(u.title || "").slice(0, 72)}`));
    if (updates.length > 12) console.log(`      … and ${updates.length - 12} more`);

    if (!DRY_RUN) {
      let done = 0;
      for (const u of updates) {
        const { error } = await sb.from("sources").update({ tags: u.tags }).eq("id", u.id);
        if (error) console.warn(`      ${u.id}: ${error.message.slice(0, 60)}`);
        else done++;
      }
      console.log(`  → applied ${done}/${updates.length}\n`);
    } else {
      console.log("");
    }
  }
  if (DRY_RUN) console.log("  DRY RUN — no writes.\n");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
