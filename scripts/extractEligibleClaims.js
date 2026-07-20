#!/usr/bin/env node
/**
 * extractEligibleClaims.js — run claim extraction only on sources that pass
 * a reading_value / maturity_level quality gate.
 *
 * Eligibility:
 *   Top-level sources: reading_value IN (essential, recommended)
 *                      OR (reading_value IS NULL AND maturity_level IN (operational, demonstrated, observed))
 *   Digest children:   maturity_level IN (operational, demonstrated, observed)
 *
 * Skips: research-only papers (maturity=research), CVE disclosures (maturity=disclosed),
 *        background reading_value, already-extracted sources.
 *
 * Usage:
 *   node scripts/extractEligibleClaims.js [--limit N] [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understand/understandSource.js";
import { scrubImpliedQuantitatives } from "../lib/utils/scrubQuantitatives.js";
import { callLLM } from "../lib/llm/callLLM.js";

const args     = process.argv.slice(2);
const LIMIT    = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : 0;
const DRY      = args.includes("--dry-run");
const CONC     = 5;

const HIGH_RV  = new Set(["essential", "recommended"]);
const HIGH_ML  = new Set(["operational", "demonstrated", "observed"]);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

async function loadEligible() {
  // Load top-level sources
  const { data: topLevel, error: e1 } = await sb
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,tags,validation_status,parent_source_id,is_digest,intelligence,reading_value")
    .eq("layer3_status", "pass")
    .is("claim_extraction_status", null)
    .is("parent_source_id", null);
  if (e1) throw new Error(e1.message);

  // Load children
  const { data: children, error: e2 } = await sb
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,tags,validation_status,parent_source_id,is_digest,intelligence,reading_value")
    .eq("layer3_status", "pass")
    .is("claim_extraction_status", null)
    .not("parent_source_id", "is", null);
  if (e2) throw new Error(e2.message);

  const eligible = [
    ...(topLevel || []).filter(s => {
      const ml = s.intelligence?.maturity_level;
      return s.reading_value ? HIGH_RV.has(s.reading_value) : HIGH_ML.has(ml);
    }),
    ...(children || []).filter(s => HIGH_ML.has(s.intelligence?.maturity_level)),
  ];

  return LIMIT > 0 ? eligible.slice(0, LIMIT) : eligible;
}

async function main() {
  console.log(`\nEligible claim extraction${DRY ? " [DRY RUN]" : ""}\n`);

  const sources = await loadEligible();
  console.log(`${sources.length} eligible sources (reading_value: essential/recommended; maturity: operational/demonstrated/observed)\n`);
  if (!sources.length) { console.log("Nothing to do."); return; }

  let pass = 0, discard = 0, failed = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < sources.length; i += CONC) {
    const batch = sources.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async src => {
      try {
        const u = await understandSource(src, { llmFn });
        return { src, u, ok: true };
      } catch (err) {
        return { src, err: err.message, ok: false };
      }
    }));

    if (!DRY) {
      const writes = [];
      for (const { src, u, ok } of results) {
        if (!ok) { failed++; continue; }
        if (!u.relevant) {
          writes.push({ id: src.id, validation_status: "reject", layer3_status: "reject", claim_extraction_status: "irrelevant" });
          discard++;
        } else {
          const rawSummary = u.short_summary || null;
          const sourceText = src.full_text || src.summary || "";
          const { text: cleanSummary } = rawSummary
            ? scrubImpliedQuantitatives(rawSummary, sourceText)
            : { text: rawSummary };
          writes.push({
            id:                     src.id,
            validation_status:      "pass",
            main_category:          u.category,
            tags:                   u.primary_tags || [],
            source_type:            u.source_type || src.source_type || "unknown",
            trust_tier:             u.trust_tier  || src.trust_tier  || "unknown",
            short_summary:          cleanSummary || null,
            claim_extraction_status: "success",
            intelligence: {
              ...(src.intelligence || {}),
              key_entities:         u.key_entities || [],
              mechanism_classification: u.mechanism_classification || null,
            },
          });
          pass++;
        }
      }
      if (writes.length) {
        const { error } = await sb.from("sources").upsert(writes, { onConflict: "id" });
        if (error) console.warn("  write error:", error.message);
      }
    } else {
      for (const { src, u, ok } of results) {
        if (!ok) { failed++; continue; }
        u.relevant ? pass++ : discard++;
      }
    }

    process.stdout.write(`\r  ${Math.min(i + CONC, sources.length)}/${sources.length} — pass: ${pass}, discard: ${discard}, failed: ${failed}`);
  }

  console.log(`\n\nDone — pass: ${pass}, discard: ${discard}, failed: ${failed}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
