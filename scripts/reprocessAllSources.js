#!/usr/bin/env node
/**
 * reprocessAllSources.js
 *
 * Walks ALL pass sources most-recent-first in small batches. Per batch:
 *   1. Apply deterministic QA gates (TAI10 artifact, Agentic editorial, AE tag)
 *   2. URL liveness check (HEAD request, 8s timeout)
 *   3. Sources that fail classification gates → reset + LLM re-run
 *   4. Dead URLs (confirmed 404/410/NXDOMAIN) → mark validation_status="review"
 *   5. Print a per-batch quality report with before/after for reclassified rows
 *
 * Usage:
 *   node scripts/reprocessAllSources.js [options]
 *
 * Options:
 *   --batch-size=N      Sources per batch (default 20)
 *   --max-batches=N     Stop after N batches, print resume hint (default: all)
 *   --from-date=DATE    Resume cursor: start from DATE (YYYY-MM-DD), newest first
 *   --dry-run           Gate checks + URL checks only; no DB writes or LLM calls
 *   --force-llm         Force LLM re-run on every source (not just gate failures)
 *   --skip-url          Skip URL liveness checks (faster)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understandSource.js";

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v !== undefined ? v : true];
  })
);
const DRY_RUN    = Boolean(argv["dry-run"]);
const FORCE_LLM  = Boolean(argv["force-llm"]);
const SKIP_URL   = Boolean(argv["skip-url"]);
const BATCH_SIZE = parseInt(argv["batch-size"]  || "20", 10);
const MAX_BATCHES= parseInt(argv["max-batches"] || "0",  10);
const FROM_DATE  = argv["from-date"] || null;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── QA gate constants (kept in sync with understandSource.js normalise()) ──────

const AI_ARTIFACT_RE = /\b(hugging.?face|model.hub|safetensor|gguf|onnx|pytorch|tensorflow|transformers|langchain|gradio|mlflow|keras|model.weight|llama|mistral|stable.diffusion|comfyui|ollama|vllm|triton|civitai|pkl|pickle|ml\.model|ai\.model|malicious.model|model.repositor|model.package|checkpoint|pre.?trained.model|skill.repositor)\b/i;

const AGENTIC_EDITORIAL_RE = /\b(trend|prediction|outlook|roundup|top \d+|year in review|state of ai|landscape|workforce|productivity|best practice|governance|risk management|challenges of|guide to|introduction to|overview of|policy for|checklist|how to secure|primer on|considerations for|ai in \d{4}|future of ai)\b/i;

/**
 * Returns an array of gate-failure reason strings.
 * Classification issues → LLM re-run.
 * Quality issues → logged only.
 */
function qaGateCheck(source) {
  const tags = source.tags || [];
  const cat  = source.main_category;
  const text = `${source.title || ""} ${(source.short_summary || source.full_text || "").slice(0, 2000)}`;
  const classification = [];
  const quality        = [];

  // Gate 1: TAI10 with no AI artifact keyword in source text
  if (cat === "traditional_ai_threats" && tags.includes("TAI10_ai_supply_chain_compromise")) {
    if (!AI_ARTIFACT_RE.test(text)) classification.push("tai10_no_ai_artifact");
  }

  // Gate 2: agentic_ai_threats with editorial/trend content and no ASI attack tag
  if (cat === "agentic_ai_threats") {
    const agentText = `${source.title || ""} ${source.short_summary || ""}`;
    const asiTags   = tags.filter(t => /^ASI\d{2}/.test(t));
    if (AGENTIC_EDITORIAL_RE.test(agentText) && asiTags.length === 0) {
      classification.push("agentic_editorial_no_asi");
    }
  }

  // Gate 3: ai_enabled_threats with no AE tag (should have been caught by AE gate, belt-and-suspenders)
  if (cat === "ai_enabled_threats" && !tags.some(t => t.startsWith("AE"))) {
    classification.push("ae_missing_tag");
  }

  // Gate 4: No taxonomy tags on a classified threat source — triggers LLM re-run
  // to assign proper primary_tags. Defensive-only tags don't count.
  if (cat && cat !== "unclear_or_adjacent" && tags.filter(t => t !== "defensive").length === 0) {
    classification.push("no_tags_on_classified_source");
  }

  // Quality check: short/missing summary (only flag; re-run only if full_text available)
  const hasText = (source.full_text || "").length > 200;
  if (hasText && (!source.short_summary || source.short_summary.trim().length < 40)) {
    quality.push("summary_short_with_text_available");
  }

  return { classification, quality };
}

// ── URL liveness ──────────────────────────────────────────────────────────────

async function checkUrl(url, timeoutMs = 8000) {
  if (!url || !url.startsWith("https://")) {
    return { alive: false, status: 0, reason: "invalid_url" };
  }
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res   = await fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0; +https://thehorizon.ai)" },
    });
    clearTimeout(timer);
    const alive = res.status < 400;
    return { alive, status: res.status, reason: alive ? "ok" : `http_${res.status}` };
  } catch (err) {
    const reason = err.name === "AbortError"
      ? "timeout"
      : (err.code || err.cause?.code || err.message.slice(0, 30));
    return { alive: false, status: 0, reason };
  }
}

async function checkBatchUrls(sources) {
  return Promise.all(
    sources.map(async s => ({ id: s.id, url: s.url, title: s.title, ...await checkUrl(s.url) }))
  );
}

// ── LLM re-run for a single source ───────────────────────────────────────────

async function rerunSource(src) {
  const u = await understandSource(src);
  return { src, u };
}

// ── DB fetch ──────────────────────────────────────────────────────────────────

async function fetchBatch(cursor) {
  let q = sb.from("sources")
    .select("id,title,url,publisher,date_published,created_at,trust_tier,source_type,main_category,tags,short_summary,full_text,clean_text,summary,validation_status")
    .eq("validation_status", "pass")
    .not("date_published", "is", null)   // skip null-date rows (processed separately or stale)
    .order("date_published", { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  if (cursor) q = q.lt("date_published", cursor);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Per-batch quality report ──────────────────────────────────────────────────

function printBatchReport({ batchNum, sources, gateResults, urlResults, rerunResults }) {
  const classificationFails = gateResults.filter(r => r.classification.length > 0);
  const qualityWarnings     = gateResults.filter(r => r.quality.length > 0);
  const deadUrls            = urlResults.filter(r => !r.alive && r.reason !== "invalid_url");
  const confirmed404        = urlResults.filter(r => r.status === 404 || r.status === 410);
  const nxdomain            = urlResults.filter(r => r.reason === "ENOTFOUND" || r.reason === "ERR_NAME_NOT_RESOLVED");
  const definitelyDead      = [...confirmed404, ...nxdomain];
  const timeouts            = urlResults.filter(r => r.reason === "timeout");

  const reclassified = rerunResults.filter(r => r.categoryChanged);
  const demoted      = rerunResults.filter(r => !r.u.relevant);

  console.log(`\n  ── Batch ${batchNum} ─────────────────────────────────────────`);
  console.log(`  Sources:   ${sources.length}  range: ${sources[sources.length-1]?.date_published?.slice(0,10)} → ${sources[0]?.date_published?.slice(0,10)}`);

  // Classification gates
  if (classificationFails.length > 0) {
    const reasons = {};
    classificationFails.forEach(r => r.classification.forEach(i => { reasons[i] = (reasons[i]||0)+1; }));
    console.log(`  Gate fails: ${classificationFails.length}  [${Object.entries(reasons).map(([k,v])=>`${k}:${v}`).join(" | ")}]`);
    classificationFails.slice(0, 4).forEach(r => {
      const src = sources.find(s => s.id === r.id);
      console.log(`    [${r.classification.join(",")}] ${src?.title?.slice(0, 70)}`);
    });
  } else {
    console.log(`  Gate fails: 0 ✓`);
  }

  // Quality warnings
  if (qualityWarnings.length > 0) {
    const reasons = {};
    qualityWarnings.forEach(r => r.quality.forEach(i => { reasons[i] = (reasons[i]||0)+1; }));
    console.log(`  Quality:    ${qualityWarnings.length} warnings [${Object.entries(reasons).map(([k,v])=>`${k}:${v}`).join(" | ")}]`);
  }

  // URL liveness
  if (!SKIP_URL) {
    const accessDenied = urlResults.filter(r => r.status === 403 || r.status === 401 || r.status === 429);
    if (deadUrls.length === 0 && accessDenied.length === 0) {
      console.log(`  URLs:       all live ✓`);
    } else {
      if (definitelyDead.length > 0 || nxdomain.length > 0) {
        console.log(`  Dead URLs:  ${[...confirmed404, ...nxdomain].length} confirmed (404/410/NXDOMAIN)`);
        [...confirmed404, ...nxdomain].slice(0, 4).forEach(r =>
          console.log(`    [${r.reason.padEnd(14)}] ${r.url?.slice(0, 64)}`)
        );
      }
      if (accessDenied.length > 0) {
        console.log(`  Bot-blocked:${accessDenied.length} (403/401/429 — not marked dead)`);
        accessDenied.slice(0, 2).forEach(r =>
          console.log(`    [${r.reason.padEnd(14)}] ${r.url?.slice(0, 64)}`)
        );
      }
      if (timeouts.length > 0) {
        console.log(`  Timeouts:   ${timeouts.length} (transient — not marked dead)`);
      }
    }
  }

  // LLM re-run results
  if (rerunResults.length > 0) {
    console.log(`  LLM re-ran: ${rerunResults.length}  reclassified: ${reclassified.length}  demoted: ${demoted.length}`);
    reclassified.slice(0, 4).forEach(r => {
      const bc = (r.beforeCat || "null").replace("_ai_threats","").replace("traditional","trad");
      const ac = (r.u.category || "null").replace("_ai_threats","").replace("traditional","trad");
      const tgs = (r.u.primary_tags || []).filter(t => t !== "defensive").slice(0, 2).join(",");
      console.log(`    ${r.src.title?.slice(0, 60)}`);
      console.log(`    ${bc} → ${ac}${tgs ? `  [${tgs}]` : ""}`);
    });
    demoted.slice(0, 2).forEach(r =>
      console.log(`    [DEMOTED] ${r.src.title?.slice(0, 60)}`)
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  Source Reprocessing Pass — QA + URL liveness`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}  force-llm: ${FORCE_LLM}  batch: ${BATCH_SIZE}  skip-url: ${SKIP_URL}`);
  if (FROM_DATE) console.log(`  Resuming from: ${FROM_DATE}`);
  console.log(`${"═".repeat(62)}\n`);

  // Count total
  const { count } = await sb.from("sources").select("id", { count: "exact", head: true })
    .eq("validation_status", "pass");
  console.log(`  Total pass sources: ${count || "?"}`);
  if (MAX_BATCHES) console.log(`  Will process: ${MAX_BATCHES} batches × ${BATCH_SIZE} = up to ${MAX_BATCHES * BATCH_SIZE} sources`);

  // Cursor: use provided date, or start at today+1 to pick up the most recent
  let cursor = FROM_DATE ? `${FROM_DATE}T23:59:59.000Z` : null;
  let batchNum    = 0;
  let totalProc   = 0;
  let totalGateF  = 0;
  let totalDead   = 0;
  let totalRerun  = 0;
  let totalReclass= 0;
  let totalDemoted= 0;
  const allDeadUrls = [];

  while (true) {
    batchNum++;
    if (MAX_BATCHES && batchNum > MAX_BATCHES) {
      const resumeDate = cursor?.slice(0, 10);
      console.log(`\n  ── Stopping at --max-batches=${MAX_BATCHES} ──`);
      console.log(`  Resume: node scripts/reprocessAllSources.js --from-date=${resumeDate} --batch-size=${BATCH_SIZE}`);
      break;
    }

    const sources = await fetchBatch(cursor);
    if (!sources.length) {
      console.log("\n  No more sources. Complete.");
      break;
    }

    process.stdout.write(`  Batch ${batchNum} [${sources[0]?.date_published?.slice(0,10)}]… `);

    // 1. QA gate check (deterministic, free)
    const gateResults = sources.map(s => ({ id: s.id, ...qaGateCheck(s) }));
    const classiFails = sources.filter((s, i) => gateResults[i].classification.length > 0);
    const toRerun     = FORCE_LLM ? sources : classiFails;

    // 2. URL liveness (parallel HEAD requests)
    let urlResults = sources.map(s => ({ id: s.id, url: s.url, alive: true, status: 200, reason: "skipped" }));
    if (!SKIP_URL) {
      process.stdout.write("urls… ");
      urlResults = await checkBatchUrls(sources);
    }

    const confirmed404 = urlResults.filter(r => r.status === 404 || r.status === 410);
    const nxdomain     = urlResults.filter(r => r.reason === "ENOTFOUND" || r.reason === "ERR_NAME_NOT_RESOLVED");
    const definitelyDead = [...confirmed404, ...nxdomain];

    process.stdout.write(`gates:${classiFails.length} dead:${definitelyDead.length} `);

    let rerunResults = [];

    if (!DRY_RUN) {
      // 3. LLM re-run for gate failures (or all if --force-llm)
      if (toRerun.length > 0) {
        process.stdout.write(`llm:0/${toRerun.length}… `);

        // Reset sources before re-running so cache is bypassed
        await sb.from("sources")
          .update({ main_category: null, tags: null, validation_status: "review" })
          .in("id", toRerun.map(s => s.id));

        // Fetch fresh rows (with full_text)
        const { data: fresh } = await sb.from("sources")
          .select("id,title,url,publisher,date_published,trust_tier,full_text,clean_text,summary,main_category,validation_status")
          .in("id", toRerun.map(s => s.id));

        let done = 0;
        const CONC = 3;
        for (let i = 0; i < (fresh || []).length; i += CONC) {
          const chunk = (fresh || []).slice(i, i + CONC);
          const results = await Promise.all(chunk.map(async src => {
            const u = await understandSource(src).catch(err => ({
              relevant: false, rejection_reason: err.message, category: "unclear_or_adjacent",
              source_type: src.source_type || "unknown", trust_tier: src.trust_tier || "unknown",
              primary_tags: [], short_summary: "",
            }));
            done++;
            process.stdout.write(`\r  Batch ${batchNum} [${sources[0]?.date_published?.slice(0,10)}]… llm:${done}/${(fresh||[]).length}… `);
            return { src, u, beforeCat: toRerun.find(s => s.id === src.id)?.main_category };
          }));
          rerunResults.push(...results);

          // Write-back immediately
          const writes = results.filter(r => r.u.relevant).map(r => ({
            id:               r.src.id,
            main_category:    r.u.category,
            tags:             r.u.primary_tags || [],
            source_type:      r.u.source_type,
            trust_tier:       r.u.trust_tier,
            short_summary:    r.u.short_summary || null,
            validation_status:"pass",
            layer3_status:    "pass",
            intelligence: {
              key_entities:  r.u.key_entities || [],
              key_terms:     r.u.key_terms    || [],
              main_claims:   r.u.main_claims  || [],
              key_numbers:   r.u.key_numbers  || [],
              is_defensive:  r.u.is_defensive || false,
              defended_category:    r.u.defended_category || null,
              defensive_techniques: r.u.defensive_techniques || [],
            },
          }));
          const demotes = results.filter(r => !r.u.relevant).map(r => ({
            id:               r.src.id,
            main_category:    "unclear_or_adjacent",
            validation_status:"reject",
            layer3_status:    "reject",
          }));
          const allWrites = [...writes, ...demotes];
          if (allWrites.length > 0) {
            await sb.from("sources").upsert(allWrites, { onConflict: "id", ignoreDuplicates: false })
              .then(({ error }) => { if (error) console.warn(`\n  write-back err: ${error.message}`); });
          }
        }

        rerunResults = rerunResults.map(r => ({
          ...r,
          categoryChanged: r.beforeCat !== r.u.category,
        }));
      }

      // 4. Mark dead URLs as "review" (confirmed 404/410 only — transients stay untouched)
      if (definitelyDead.length > 0) {
        await sb.from("sources")
          .update({ validation_status: "review" })
          .in("id", definitelyDead.map(r => r.id))
          .then(({ error }) => { if (error) console.warn(`\n  dead-url mark err: ${error.message}`); });

        allDeadUrls.push(...definitelyDead.map(r => ({ ...r, date: sources.find(s=>s.id===r.id)?.date_published?.slice(0,10) })));
      }
    }

    process.stdout.write("\n");

    // 5. Quality report
    printBatchReport({ batchNum, sources, gateResults, urlResults, rerunResults });

    // Accumulate totals
    totalProc    += sources.length;
    totalGateF   += classiFails.length;
    totalDead    += definitelyDead.length;
    totalRerun   += rerunResults.length;
    totalReclass += rerunResults.filter(r => r.categoryChanged).length;
    totalDemoted += rerunResults.filter(r => !r.u?.relevant).length;

    // Advance cursor to the oldest date in this batch
    cursor = sources[sources.length - 1].date_published;

    await new Promise(r => setTimeout(r, 300));
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  Final summary`);
  console.log(`  Processed:    ${totalProc}`);
  console.log(`  Gate failures:${totalGateF}  →  LLM re-ran: ${totalRerun}`);
  console.log(`  Reclassified: ${totalReclass}  Demoted: ${totalDemoted}`);
  console.log(`  Dead URLs:    ${totalDead} marked review`);

  if (allDeadUrls.length > 0) {
    console.log(`\n  Dead URL log (${allDeadUrls.length}):`);
    allDeadUrls.slice(0, 20).forEach(r =>
      console.log(`    [${r.reason.padEnd(8)} ${r.status || ""}] ${r.date || ""} ${r.url?.slice(0, 58)}`)
    );
    if (allDeadUrls.length > 20) console.log(`    ... and ${allDeadUrls.length - 20} more`);
  }
  console.log(`${"═".repeat(62)}\n`);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
