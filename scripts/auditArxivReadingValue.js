#!/usr/bin/env node
/**
 * auditArxivReadingValue.js — Audit and correct inflated reading_value on arXiv sources.
 *
 * Root cause (identified 2026-07-20): arXiv papers use "we introduce", "first systematic
 * study", "novel" as standard academic framing, which triggered the L3 LLM to classify
 * them as first_of_kind + changes_threat_model → essential. Fixes to layer3.md prompt
 * add:
 *   1. Academic paper calibration note in the first_of_kind definition
 *   2. Explicit tightening of changes_threat_model (new deployment context ≠ new threat model)
 *   3. Research-maturity cap: research_only papers cannot be essential unless the attack
 *      CLASS is genuinely new at the literature level
 *   4. Calibration examples for common misclassified papers
 *
 * This script applies targeted corrections to the specific mislabeled sources, then
 * optionally re-runs L3 with the new prompt on all arXiv sources.
 *
 * Usage:
 *   node scripts/auditArxivReadingValue.js --dry-run        # preview only
 *   node scripts/auditArxivReadingValue.js                  # apply targeted patches
 *   node scripts/auditArxivReadingValue.js --rerun          # re-run L3 on all arxiv sources
 *   node scripts/auditArxivReadingValue.js --rerun --limit 20
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";

const args    = process.argv.slice(2);
const hasFlag = f => args.includes(f);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DRY_RUN = hasFlag("--dry-run");
const RERUN   = hasFlag("--rerun");
const LIMIT   = parseInt(getArg("--limit", "9999"), 10);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Known mislabeled sources — targeted patches ───────────────────────────────
// Each entry: { url_fragment, current: wrongValue, correct: rightValue, reason }
// Identified from 2026-07-20 audit of reading_value=essential arXiv sources.

const PATCHES = [
  {
    url_fragment: "arxiv.org/abs/2607.14651",  // MemPoison
    correct: "analyst",
    reason:  "Memory poisoning in LLM agents is a known attack class (variant of indirect prompt injection / data poisoning). Paper introduces a taxonomy and benchmark for a known class, not a new attack class. research_only + adds_technical_detail → analyst.",
  },
  {
    url_fragment: "arxiv.org/abs/2607.14493",  // Context Contamination
    correct: "recommended",
    reason:  "Context Stitching is a new evasion technique within the known prompt injection class (new_variant). First systematic empirical measurement in SIEM/log analysis pipelines. New deployment context does not change the threat model — defenders already knew AI-powered log analysis was susceptible. research_only + changes_priority → recommended.",
  },
  {
    url_fragment: "arxiv.org/abs/2607.11288",  // Mako SE-AOS
    correct: "recommended",
    reason:  "Self-evolving agentic OS for offensive exploitation is a novel research concept but a prototype, not operationally deployed. research_only + the self-evolution mechanism is interesting but not yet a confirmed threat model change → recommended.",
  },
  {
    url_fragment: "arxiv.org/abs/2607.11751",  // When Local Monitors Miss Compositional Harm
    correct: "recommended",
    reason:  "Distributed backdoor mechanism that defeats per-step monitoring is an interesting finding. However the 'first' claim in the text referred to a model condition, not literature priority. Similar distributed backdoor concepts exist in prior work. new_variant + changes_priority → recommended. (Would be essential only if confirmed as first paper demonstrating this specific monitor-evasion mechanism.)",
  },
  {
    url_fragment: "arxiv.org/abs/2605.28999",  // Measuring Real-World Prompt Injection (resume screening)
    correct: "recommended",
    reason:  "First systematic measurement of real-world prompt injection in a deployed application (LLM-based resume screening). Has operational measurement data. new_variant + changes_priority (confirms the attack is real and measurable at scale) → recommended. Does not change the threat model (prompt injection in AI applications was already known).",
  },
  {
    url_fragment: "arxiv.org/abs/2604.27202",  // Indirect Prompt Injection in the Wild
    correct: "recommended",
    reason:  "Empirical study of real-world indirect prompt injection prevalence. Operational measurement data. new_variant + changes_priority → recommended.",
  },
  {
    url_fragment: "arxiv.org/abs/2604.01438",  // ClawSafety
    correct: "analyst",
    reason:  "Benchmark paper (CLAWSAFETY) with 120 adversarial test scenarios for testing AI agents against prompt injection in elevated-privilege contexts. The primary deliverable is a benchmark/evaluation framework, not an offensive finding. Known attack class (prompt injection in AI agents). research_only + adds_technical_detail → analyst.",
  },
  {
    url_fragment: "arxiv.org/abs/2604.08407",  // Your Agent Is Mine
    correct: "recommended",
    reason:  "Malicious LLM API router supply chain attack — third-party API routers with plaintext access to all in-flight JSON payloads can intercept/modify LLM tool calls. New attack surface in LLM infrastructure (new_variant). 'First systematic study' of this supply chain threat. research_only but a distinct new sub-surface within LLM infrastructure threats → recommended.",
  },
  {
    url_fragment: "arxiv.org/abs/2511.05797",  // When AI Meets the Web: Chatbot Plugin Prompt Injection
    correct: "recommended",
    reason:  "Large-scale study of prompt injection vulnerabilities in 17 third-party chatbot plugins on 10,000+ real websites — new deployment context (browser-based chatbot plugins) for a known attack class. 'Uncovering previously unknown vulnerabilities' in production software is new_variant + demonstrated. Not operationally confirmed as adversary-exploited → recommended.",
  },
];

// Sources that STAY essential (do not patch):
// - arxiv.org/abs/2605.28588 (Technical Report: Agent Skill Ecosystem — 76 confirmed
//   malicious payloads in real marketplaces, "first documented coordinated malware campaign
//   targeting Claude Code" = operational, not research_only)

// ── Main ─────────────────────────────────────────────────────────────────────

async function applyTargetedPatches() {
  console.log("\n══ TARGETED PATCHES ══\n");

  for (const patch of PATCHES) {
    const { data: rows } = await sb
      .from("sources")
      .select("id, title, reading_value, url")
      .ilike("url", `%${patch.url_fragment}%`)
      .limit(5);

    if (!rows?.length) {
      console.log(`  [NOT FOUND] ${patch.url_fragment}`);
      continue;
    }

    for (const row of rows) {
      const current = row.reading_value || "(null)";
      if (current === patch.correct) {
        console.log(`  [OK]        ${row.title?.slice(0, 60)} — already ${patch.correct}`);
        continue;
      }

      console.log(`  [PATCH]     ${row.title?.slice(0, 60)}`);
      console.log(`              ${current} → ${patch.correct}`);
      console.log(`              Reason: ${patch.reason.slice(0, 120)}...`);

      if (!DRY_RUN) {
        const { error } = await sb
          .from("sources")
          .update({
            reading_value:         patch.correct,
            recommendation_reason: patch.reason,
          })
          .eq("id", row.id);

        if (error) console.error("  [ERROR]", error.message);
        else       console.log("  [SAVED]");
      }
    }
  }
}

async function showCurrentStats() {
  const { data } = await sb
    .from("sources")
    .select("reading_value, validation_status")
    .ilike("url", "%arxiv%")
    .not("reading_value", "is", null);

  const counts = {};
  for (const s of data || []) counts[s.reading_value] = (counts[s.reading_value] || 0) + 1;

  console.log("\n══ CURRENT ARXIV READING_VALUE DISTRIBUTION ══");
  console.log(`  Total: ${data?.length || 0}`);
  for (const [v, c] of Object.entries(counts).sort(([,a],[,b]) => b - a)) {
    console.log(`  ${v.padEnd(14)} ${c}`);
  }
}

async function rerunL3OnArxiv() {
  console.log("\n══ RE-RUNNING L3 ON ARXIV SOURCES ══\n");

  let from = 0; const page = 500;
  const all = [];
  while (true) {
    const { data, error } = await sb
      .from("sources")
      .select("*")
      .ilike("url", "%arxiv%")
      .eq("validation_status", "pass")
      .not("reading_value", "is", null)
      .range(from, from + page - 1);
    if (error || !data?.length) break;
    all.push(...data);
    if (data.length < page) break;
    from += page;
  }

  const sources = all.slice(0, LIMIT);
  console.log(`Processing ${sources.length} arXiv sources...\n`);

  let changed = 0, unchanged = 0, errors = 0;

  for (const source of sources) {
    try {
      const result = await validateAndTypeSource(source, { skipUrlCheck: true });
      const prev = source.reading_value;
      const next = result.reading_value;

      if (prev !== next) {
        console.log(`  [CHANGED] ${source.title?.slice(0, 60)}`);
        console.log(`            ${prev} → ${next}`);
        if (result.recommendation_reason) {
          console.log(`            ${result.recommendation_reason.slice(0, 100)}`);
        }

        if (!DRY_RUN) {
          const updates = {
            reading_value:         next,
            distribution_recommendation: result.distribution_recommendation || null,
            recommendation_reason: result.recommendation_reason || null,
          };
          if (result.reasoning) updates.validation_reasoning = result.reasoning;
          await sb.from("sources").update(updates).eq("id", source.id);
        }
        changed++;
      } else {
        unchanged++;
      }
    } catch (e) {
      console.error(`  [ERROR] ${source.title?.slice(0, 50)}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Changed: ${changed}, unchanged: ${unchanged}, errors: ${errors}`);
  if (DRY_RUN) console.log("(dry run — no writes)");
}

// ── Entry point ───────────────────────────────────────────────────────────────

await showCurrentStats();

if (RERUN) {
  await rerunL3OnArxiv();
} else {
  await applyTargetedPatches();
  if (!DRY_RUN) await showCurrentStats();
}

if (DRY_RUN) console.log("\n[dry-run] no changes written.");
