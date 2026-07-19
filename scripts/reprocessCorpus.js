#!/usr/bin/env node
/**
 * reprocessCorpus.js — Full L3→L4→L5 reprocess of the entire source corpus.
 *
 * Works a priority queue in batches of 10:
 *   P1  null validation_status        → run L3 + L4 + L5
 *   P2  pass + null source_family     → run L4 + L5
 *   P3  pass + offensive category + no evidence → run L5
 *   P4  --force-all: re-run L4 + L5 on everything already classified
 *
 * After each batch: prints a quality report and flags issues.
 * Sources L3 now rejects that were previously "pass" → prompt to discard.
 *
 * Usage:
 *   node scripts/reprocessCorpus.js [options]
 *
 * Options:
 *   --batch-size=10     Sources per batch (default 10)
 *   --max-batches=N     Stop after N batches (default: all)
 *   --phase=l3|l4|l5|all  Only run specific phases (default: all)
 *   --force-all         Re-run L4+L5 on all pass sources (not just gaps)
 *   --dry-run           No DB writes
 *   --verbose           Print full evidence items
 *   --from-offset=N     Skip first N sources (resume cursor)
 *   --category=<cat>    Limit L5 to a specific category
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args      = process.argv.slice(2);
const getArg    = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const getArgEq  = (prefix, d) => { const a = args.find(a => a.startsWith(prefix + "=")); return a ? a.slice(prefix.length + 1) : d; };
const hasFlag   = (f) => args.includes(f);

const BATCH_SIZE  = parseInt(getArgEq("--batch-size",  "10"), 10);
const MAX_BATCHES = parseInt(getArgEq("--max-batches", "0"),  10);  // 0 = no limit
const PHASE_ARG   = getArgEq("--phase", "all");
const FORCE_ALL   = hasFlag("--force-all");
const DRY_RUN     = hasFlag("--dry-run");
const VERBOSE     = hasFlag("--verbose");
const FROM_OFFSET = parseInt(getArgEq("--from-offset", "0"), 10);
const CAT_FILTER  = getArgEq("--category", null);

const RUN_L3 = PHASE_ARG === "all" || PHASE_ARG === "l3";
const RUN_L4 = PHASE_ARG === "all" || PHASE_ARG === "l4";
const RUN_L5 = PHASE_ARG === "all" || PHASE_ARG === "l5";

const CATS = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];
const TAG_RE = /^(TAI|LLM|ASI|AE)\d{2}/;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function pad(str, w) { return String(str ?? "").slice(0, w).padEnd(w); }
function trunc(str, w) { const s = String(str ?? ""); return s.length > w ? s.slice(0, w - 1) + "…" : s; }
const HR  = "═".repeat(120);
const SEP = "─".repeat(120);

function header(t)    { console.log(`\n${HR}\n  ${t}\n${HR}`); }
function subheader(t) { console.log(`\n${SEP}\n  ${t}\n${SEP}`); }

// ── Source loading helpers ─────────────────────────────────────────────────────

const SOURCE_COLS = [
  "id", "title", "url", "publisher", "date_published", "source_type", "trust_tier",
  "main_category", "tags", "layer3_status", "validation_status", "downstream_route",
  "reading_value", "source_family", "full_text", "clean_text", "summary", "short_summary",
  "intelligence", "ai_specificity_score", "ai_threat_focus", "is_digest", "parent_source_id",
  "author", "trust_tier", "publisher_class",
].join(",");

async function loadSourcePage(from, limit) {
  const { data, error } = await sb.from("sources")
    .select(SOURCE_COLS)
    .order("date_published", { ascending: false })
    .range(from, from + limit - 1);
  if (error) throw new Error("DB load: " + error.message);
  return data || [];
}

async function getEvidenceSourceIds() {
  const ids = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("evidence").select("source_id").range(from, from + 999);
    if (!data?.length) break;
    data.forEach(r => ids.add(r.source_id));
    if (data.length < 1000) break;
  }
  return ids;
}

// ── Queue builder ──────────────────────────────────────────────────────────────

async function buildQueue() {
  console.log("  Building reprocess queue...");

  // Load full corpus in pages (avoid 1000-row cap)
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id, validation_status, layer3_status, source_family, main_category, full_text, reading_value, research_gate_maturity")
      .range(from, from + 999);
    if (error) throw new Error("Queue load: " + error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  const evidSet = await getEvidenceSourceIds();

  // Eligibility for L5: reading_value must be essential or recommended,
  // OR research_gate_maturity is a high-confidence tier (demonstrated/weaponized/operational).
  // Sources classified as analyst-level or lower are skipped — they add noise without
  // enough intelligence density to justify the extraction cost.
  const HIGH_MATURITY = new Set(["demonstrated", "weaponized", "operational", "observed"]);
  const isL5Eligible = s =>
    ["essential", "recommended"].includes(s.reading_value) ||
    HIGH_MATURITY.has(s.research_gate_maturity);

  // Sort within P3: essential first, then recommended, then high-maturity-only,
  // preserving date_published order within each tier (newest first per tier).
  const RV_ORDER = { essential: 0, recommended: 1 };
  const p3SortKey = s => {
    const rv = RV_ORDER[s.reading_value] ?? 2;
    return rv;
  };

  // P1: null validation_status → needs L3 + L4 + L5
  const p1 = RUN_L3 ? all.filter(s => !s.validation_status && !s.layer3_status) : [];

  // Helper: a source is "effectively pass" only when BOTH status fields agree.
  // layer3_status=pass + validation_status=reject means a sweep overrode L3 → treat as reject.
  const isPass = s => s.validation_status === "pass" && s.layer3_status === "pass";

  // P2: pass + null source_family → needs L4 + L5
  const p2 = RUN_L4 ? all.filter(s => isPass(s) && !s.source_family) : [];

  // P3: pass + offensive category + no evidence + eligible reading_value/maturity → L5 only
  const p3Raw = RUN_L5 ? all.filter(s =>
    isPass(s) &&
    s.source_family &&
    CATS.includes(s.main_category) &&
    !evidSet.has(s.id) &&
    isL5Eligible(s) &&
    (!CAT_FILTER || s.main_category === CAT_FILTER)
  ) : [];
  // Sort: essential → recommended → high-maturity-only (stable within tier)
  const p3 = p3Raw.slice().sort((a, b) => p3SortKey(a) - p3SortKey(b));

  const skipped = RUN_L5 ? all.filter(s =>
    isPass(s) && s.source_family && CATS.includes(s.main_category) && !isL5Eligible(s)
  ).length : 0;
  if (skipped) console.log(`  Skipping ${skipped} ineligible sources (analyst/null reading_value, low maturity)`);

  // P4 (force-all): re-run L4+L5 on already-classified pass sources
  const p4 = FORCE_ALL ? all.filter(s =>
    isPass(s) &&
    s.source_family &&
    CATS.includes(s.main_category) &&
    evidSet.has(s.id) &&
    !p3.some(x => x.id === s.id) &&
    (!CAT_FILTER || s.main_category === CAT_FILTER)
  ) : [];

  // De-duplicate across priorities (an ID shouldn't appear in multiple queues)
  const seen = new Set();
  const dedup = (arr) => arr.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });

  const queue = [
    ...dedup(p1).map(s => ({ ...s, _priority: "P1_l3_l4_l5" })),
    ...dedup(p2).map(s => ({ ...s, _priority: "P2_l4_l5"    })),
    ...dedup(p3).map(s => ({ ...s, _priority: "P3_l5"        })),
    ...dedup(p4).map(s => ({ ...s, _priority: "P4_force"     })),
  ];

  console.log(`  Queue: P1=${p1.length}(L3+L4+L5)  P2=${p2.length}(L4+L5)  P3=${p3.length}(L5)  P4=${p4.length}(force)  total=${queue.length}`);
  return queue;
}

// ── Issue flags ────────────────────────────────────────────────────────────────

function flagIssues(flags, batchN) {
  if (!flags.length) {
    console.log("  ✓ No issues flagged in this batch");
    return;
  }
  console.log(`\n  ⚠  ISSUES FLAGGED (batch ${batchN}):`);
  for (const f of flags) {
    console.log(`     [${f.severity}] ${f.source} — ${f.issue}`);
    if (f.detail) console.log(`              ${f.detail}`);
  }
}

// ── L3 processing ─────────────────────────────────────────────────────────────

async function runL3(sources, flags) {
  const { validateAndTypeSource } = await import("../lib/pipeline/validation/validateAndTypeSource.js");

  subheader(`L3 VALIDATION (${sources.length} sources)`);
  const results = [];
  for (const source of sources) {
    process.stdout.write(`  [L3] ${trunc(source.title || source.url, 65)}... `);
    try {
      const r = await validateAndTypeSource(source, { skipUrlCheck: true });
      results.push({ source, result: r });
      process.stdout.write(`${r.layer3_status}  ${r.reading_value || "—"}\n`);

      // Flag: sources that were previously pass now rejected
      if (r.layer3_status === "reject" && source.validation_status === "pass") {
        flags.push({ severity: "WARN", source: trunc(source.title, 50), issue: "L3 now rejects a previously-pass source", detail: r.final_validity_reason || r.route_reason_codes?.join(", ") });
      }
      // Flag: reading_value=analyst on non-trivial source
      if (r.reading_value === "analyst" && (source.full_text || "").length > 2000) {
        flags.push({ severity: "INFO", source: trunc(source.title, 50), issue: "reading_value=analyst on substantial source (may be mis-gated)", detail: r.source_type });
      }
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      results.push({ source, result: null, error: e.message });
      flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "L3 threw: " + e.message });
    }
  }
  return results;
}

async function persistL3(results) {
  let ok = 0, fail = 0;
  for (const { source, result } of results) {
    if (!result) continue;
    const patch = {
      validation_status:    result.validation_status || result.layer3_status,
      layer3_status:        result.layer3_status,
      downstream_route:     result.downstream_route,
      source_type:          result.source_type || source.source_type,
      ai_specificity_score: result.ai_specificity_score ?? null,
      relevance_tier:       result.relevance_tier ?? null,
      ai_threat_focus:      result.ai_threat_focus ?? null,
      validation_summary:   result.validation_summary ?? null,
      reading_value:        result.reading_value ?? null,
      ai_materiality:       result.ai_materiality ?? null,
      trust_tier:           result.trust_tier ?? source.trust_tier,
      publisher_class:      result.publisher_class ?? null,
    };
    const { error } = await sb.from("sources").update(patch).eq("id", source.id);
    if (error) { console.log(`  ✗ L3 persist ${source.id}: ${error.message}`); fail++; }
    else ok++;
  }
  console.log(`  L3 persisted: ${ok} ok  ${fail} failed`);
}

// ── L4 processing ─────────────────────────────────────────────────────────────

async function runL4(sources, l3Map, flags) {
  const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");

  // Build inputs: merge L3 results if available
  const inputs = sources
    .filter(s => {
      const l3 = l3Map[s.id];
      if (l3 && l3.layer3_status === "reject") return false;
      if (!l3 && s.layer3_status === "reject") return false;
      if (!l3 && s.validation_status === "reject") return false;
      return true;
    })
    .map(s => {
      const l3 = l3Map[s.id];
      return l3 ? { ...s, ...l3 } : {
        ...s,
        source_family: s.source_family || s.intelligence?.source_family,
        primary_tags:  s.tags || [],
        primary_tag:   (s.tags || [])[0] || null,
      };
    });

  if (!inputs.length) { console.log("  (no L4-eligible sources in this batch)"); return {}; }

  subheader(`L4 CLASSIFICATION (${inputs.length} sources)`);
  const results = {};
  for (const source of inputs) {
    process.stdout.write(`  [L4] ${trunc(source.title || source.url, 65)}... `);
    try {
      const r = await understandSource(source, { skipLlm: false });
      results[source.id] = r;
      process.stdout.write(`${r.category || "—"}  ${r.primary_tags?.[0] || "—"}\n`);

      // Flag: is_defensive=true only when the title LOOKS offensive (attacker/red-team framing).
      // Papers with "Detect", "Defense", "Shield", "Prevent", "Mitigat", "Robust", "Repair"
      // in the title are almost certainly correctly defensive — skip those to reduce noise.
      const DEFENSIVE_TITLE_RE = /\b(detect|defense|defend|shield|prevent|mitigat|robust|repair|protect|safe|guardrail|certif|hardening)\b/i;
      if (r.is_defensive && !DEFENSIVE_TITLE_RE.test(source.title || "")) {
        flags.push({ severity: "WARN", source: trunc(source.title, 50), issue: "is_defensive=true on non-obviously-defensive title — confirm correct", detail: `category=${r.category}  tags=${r.primary_tags?.join(",")}` });
      }
      // Flag: invalid taxonomy tags
      // "defensive" is an internal understandSource marker, not a real taxonomy tag — exclude from ERROR
      const badTags = (r.primary_tags || []).filter(t => !TAG_RE.test(t) && !["adjacent_context", "defensive"].includes(t));
      if (badTags.length) {
        flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "Invalid taxonomy tags: " + badTags.join(", "), detail: "Tags must match TAI/LLM/ASI/AE + 2-digit code" });
      }
      // Flag: unclear_or_adjacent on arXiv or high-trust research
      if (r.category === "unclear_or_adjacent" && source.publisher === "arXiv") {
        flags.push({ severity: "WARN", source: trunc(source.title, 50), issue: "arXiv paper routed to unclear_or_adjacent — check if it should be offensive", detail: r.rejection_reason || "—" });
      }
      // Flag: off_topic (would be discarded)
      if (r.keep === false) {
        flags.push({ severity: "INFO", source: trunc(source.title, 50), issue: "L4 routes off_topic → will be discarded", detail: r.rejection_reason || "—" });
      }
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      results[source.id] = null;
      flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "L4 threw: " + e.message });
    }
  }
  return results;
}

async function persistL4(sources, l4Map) {
  const { deterministicMaturity } = await import("../lib/pipeline/scoring/maturityLevel.js");
  const now = new Date().toISOString();
  let ok = 0, fail = 0;
  for (const source of sources) {
    const r = l4Map[source.id];
    if (!r) continue;
    const origIntel = source.intelligence || {};
    const maturity  = deterministicMaturity(r);
    const isAdjacent = r.disposition === "adjacent" || (!r.relevant && r.keep !== false);
    const row = {
      id:               source.id,
      main_category:    r.category,
      tags:             isAdjacent
        ? [...new Set([...(r.primary_tags || []), "adjacent_context"])]
        : (r.primary_tags || []),
      source_type:      r.source_type,
      trust_tier:       r.trust_tier,
      short_summary:    r.short_summary || null,
      validation_status: "pass",
      layer3_status:    "pass",
      relevance_tier:   isAdjacent ? "adjacent" : "core",
      ai_specificity_score: isAdjacent ? 40 : 80,
      source_family:    r.source_family || null,
      intelligence: {
        ...origIntel,
        is_defensive:         r.is_defensive || false,
        defended_category:    r.defended_category || null,
        defensive_techniques: r.defensive_techniques || [],
        key_entities:         r.key_entities || [],
        source_family:        r.source_family || null,
        maturity_level:       maturity.level,
        maturity_confidence:  maturity.confidence,
        maturity_reason:      maturity.reason,
        maturity_at:          now,
      },
    };
    const { error } = await sb.from("sources").upsert(row, { onConflict: "id", ignoreDuplicates: false });
    if (error) { console.log(`  ✗ L4 persist ${source.id}: ${error.message}`); fail++; }
    else ok++;
  }
  console.log(`  L4 persisted: ${ok} ok  ${fail} failed`);
}

// ── L5 processing ─────────────────────────────────────────────────────────────

async function runL5(sources, l3Map, l4Map, flags) {
  const { extractEvidence }               = await import("../lib/pipeline/extraction/extractEvidence.js");
  const { saveSourceEvidence, contentHashOf } = await import("../lib/storage/evidenceStore.js");

  // Build L5 inputs
  const inputs = [];
  for (const source of sources) {
    const l3 = l3Map[source.id];
    const l4 = l4Map[source.id];

    // Skip rejects
    if (l3?.layer3_status === "reject") continue;
    if (!l3 && (source.validation_status === "reject" || source.layer3_status === "reject")) continue;

    // Build merged source
    let s = { ...source };
    if (l4) {
      s = { ...s, category: l4.category, main_category: l4.category, source_family: l4.source_family, primary_tags: l4.primary_tags, tags: l4.primary_tags, trust_tier: l4.trust_tier, source_type: l4.source_type, key_entities: l4.key_entities, short_summary: l4.short_summary };
    } else {
      s = { ...s, category: s.main_category, source_family: s.source_family || s.intelligence?.source_family, primary_tags: s.tags || [], primary_tag: (s.tags || [])[0] || null };
    }

    const cat = s.category || s.main_category;
    if (!CATS.includes(cat)) continue;
    if (CAT_FILTER && cat !== CAT_FILTER) continue;
    if (!s.source_family) continue;

    inputs.push(s);
  }

  if (!inputs.length) { console.log("  (no L5-eligible sources in this batch)"); return; }

  subheader(`L5 EVIDENCE EXTRACTION (${inputs.length} sources)`);
  for (const source of inputs) {
    process.stdout.write(`  [L5] ${trunc(source.title || source.url, 65)}... `);
    let items = [];
    try {
      items = await extractEvidence(source, {});
      process.stdout.write(`${items.length} items\n`);
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "L5 threw: " + e.message });
      continue;
    }

    if (items.length === 0) {
      console.log(`       ⚠ 0 items extracted (check eligibility gate or source_family routing)`);
      flags.push({ severity: "WARN", source: trunc(source.title, 50), issue: "L5 extracted 0 items", detail: `family=${source.source_family}  category=${source.category}` });
      continue;
    }

    // Quality metrics
    const highSpec = items.filter(i => i.specificity === "high").length;
    const grounded = items.filter(i => i.quote_grounded).length;
    const withNums = items.filter(i => i.numbers?.length > 0).length;
    const badTags  = items.flatMap(i => (i.technique_tags || []).filter(t => !TAG_RE.test(t)));
    console.log(`       family=${source.source_family}  high=${highSpec}  grounded=${grounded}  nums=${withNums}  items=${items.length}`);

    if (badTags.length) {
      flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "Invalid technique_tags in evidence: " + [...new Set(badTags)].join(", ") });
    }
    if (grounded === 0 && items.length > 1) {
      flags.push({ severity: "WARN", source: trunc(source.title, 50), issue: "All items quote_grounded=false — quote extraction may be failing" });
    }

    if (VERBOSE) {
      for (const [i, item] of items.slice(0, 3).entries()) {
        console.log(`       [${i+1}] ${item.evidence_type}  ${item.specificity}  grounded=${item.quote_grounded}`);
        console.log(`            ${trunc(item.fact, 100)}`);
        if (item.quote) console.log(`            "${trunc(item.quote, 80)}"`);
      }
      if (items.length > 3) console.log(`       … and ${items.length - 3} more`);
    } else {
      for (const item of items.slice(0, 2)) {
        console.log(`       [${item.evidence_type}] ${trunc(item.fact, 100)}`);
      }
      if (items.length > 2) console.log(`       … and ${items.length - 2} more`);
    }

    if (!DRY_RUN) {
      const textHash = contentHashOf(source.full_text || source.clean_text || "");
      const { error } = await saveSourceEvidence(sb, source.id, textHash, items);
      if (error) {
        console.log(`       ✗ persist failed: ${JSON.stringify(error)}`);
        flags.push({ severity: "ERROR", source: trunc(source.title, 50), issue: "Evidence persist failed: " + JSON.stringify(error) });
      } else {
        console.log(`       ✓ ${items.length} items saved`);
      }
    }
  }
}

// ── Reject handling ────────────────────────────────────────────────────────────

async function handleRejects(batchSources, l3Map, flags) {
  // Find sources L3 now rejects that were previously pass
  const newRejects = batchSources.filter(s => {
    const l3 = l3Map[s.id];
    return l3?.layer3_status === "reject" && s.validation_status === "pass";
  });

  if (!newRejects.length) return;

  console.log(`\n  ⚠  ${newRejects.length} source(s) now rejected by L3 (were previously pass):`);
  for (const s of newRejects) {
    const l3 = l3Map[s.id];
    console.log(`     - ${trunc(s.title, 70)}`);
    console.log(`       reason: ${l3.final_validity_reason || l3.route_reason_codes?.join(", ") || "—"}`);
    console.log(`       trust_tier: ${s.trust_tier}  category: ${s.main_category}`);
  }

  if (!DRY_RUN) {
    console.log("  → Updating to validation_status=reject in DB...");
    for (const s of newRejects) {
      const l3 = l3Map[s.id];
      await sb.from("sources").update({
        validation_status: "reject",
        layer3_status: "reject",
      }).eq("id", s.id);
      // Delete any evidence for rejected sources
      await sb.from("evidence").delete().eq("source_id", s.id);
    }
    console.log(`  → Updated ${newRejects.length} reject(s) and deleted their evidence`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

header(`CORPUS REPROCESS  [batch-size=${BATCH_SIZE}  max-batches=${MAX_BATCHES||"∞"}  phase=${PHASE_ARG}  force-all=${FORCE_ALL}  dry-run=${DRY_RUN}]`);

const queue  = await buildQueue();
const total  = queue.length;

if (!total) {
  console.log("\n  ✓ Nothing to reprocess — corpus is up to date.");
  process.exit(0);
}

const batchCount = Math.ceil(total / BATCH_SIZE);
console.log(`\n  Processing ${total} sources in ${batchCount} batches of ${BATCH_SIZE}${MAX_BATCHES ? ` (max ${MAX_BATCHES} batches)` : ""}`);
if (FROM_OFFSET > 0) console.log(`  Skipping first ${FROM_OFFSET} sources (resume from offset ${FROM_OFFSET})`);
if (DRY_RUN) console.log("  DRY RUN — no DB writes");

let batchN = 0;
let totalIssues = 0;
const startTime = Date.now();

const effectiveQueue = queue.slice(FROM_OFFSET);

for (let i = 0; i < effectiveQueue.length; i += BATCH_SIZE) {
  batchN++;
  if (MAX_BATCHES && batchN > MAX_BATCHES) {
    console.log(`\n  Reached max-batches=${MAX_BATCHES}. Resume with --from-offset=${FROM_OFFSET + i}`);
    break;
  }

  const slimBatch = effectiveQueue.slice(i, i + BATCH_SIZE);
  const batchIds  = slimBatch.map(s => s.id);
  const elapsed   = ((Date.now() - startTime) / 1000).toFixed(0);
  const remaining = total - FROM_OFFSET - i;

  header(`BATCH ${batchN}/${batchCount}  [${i+1}–${i+slimBatch.length} of ${effectiveQueue.length}]  priorities=${[...new Set(slimBatch.map(s => s._priority))].join(",")}  elapsed=${elapsed}s`);

  // Load full source objects for this batch
  const { data: fullSources, error: loadErr } = await sb.from("sources")
    .select(SOURCE_COLS)
    .in("id", batchIds);
  if (loadErr) { console.error("Batch load failed:", loadErr.message); continue; }

  const sources = batchIds.map(id => fullSources.find(s => s.id === id)).filter(Boolean);
  const flags = [];

  // Print batch selection
  console.log(`\n  ${"TITLE".padEnd(50)} ${"PRIORITY".padEnd(12)} ${"STATUS".padEnd(8)} FAMILY`);
  console.log("  " + "─".repeat(100));
  for (const s of sources) {
    const slim = slimBatch.find(x => x.id === s.id);
    console.log(`  ${trunc(s.title || s.url, 50).padEnd(50)} ${(slim?._priority||"—").padEnd(12)} ${(s.validation_status||"null").padEnd(8)} ${s.source_family || "—"}`);
  }

  // Identify which phases to run per source
  const needL3 = RUN_L3 ? sources.filter(s => !s.validation_status && !s.layer3_status) : [];
  const needL4 = RUN_L4 ? sources.filter(s => {
    const slim = slimBatch.find(x => x.id === s.id);
    return slim?._priority === "P1_l3_l4_l5" || slim?._priority === "P2_l4_l5" || (FORCE_ALL && slim?._priority === "P4_force");
  }) : [];
  const needL5 = RUN_L5 ? sources.filter(s => {
    const slim = slimBatch.find(x => x.id === s.id);
    return slim?._priority !== "P2_l4_l5" || FORCE_ALL || true; // all non-reject sources in batch get L5
  }) : [];

  // ── L3 ──
  const l3Map = {};
  if (needL3.length) {
    const l3Results = await runL3(needL3, flags);
    for (const { source, result } of l3Results) { if (result) l3Map[source.id] = result; }
    await handleRejects(needL3, l3Map, flags);
    if (!DRY_RUN) await persistL3(l3Results);
  }

  // ── L4 ──
  const l4Map = {};
  const l4Sources = FORCE_ALL
    ? sources.filter(s => !l3Map[s.id]?.layer3_status?.match(/reject/))
    : [...needL4, ...needL3.filter(s => !l3Map[s.id]?.layer3_status?.match(/reject/))];
  const l4Unique = [...new Map(l4Sources.map(s => [s.id, s])).values()];

  if (l4Unique.length && RUN_L4) {
    const l4Results = await runL4(l4Unique, l3Map, flags);
    Object.assign(l4Map, l4Results);
    if (!DRY_RUN) await persistL4(l4Unique, l4Map);
  }

  // ── L5 ──
  if (RUN_L5) {
    await runL5(sources, l3Map, l4Map, flags);
  }

  // ── Batch quality report ──
  subheader(`BATCH ${batchN} QUALITY REPORT`);
  flagIssues(flags, batchN);
  totalIssues += flags.filter(f => f.severity !== "INFO").length;

  // Cost flush
  try {
    const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js");
    if (flushCostBuffer) await flushCostBuffer();
  } catch { /* cost tracking optional */ }

  console.log(`\n  Batch ${batchN} done. Issues: ${flags.filter(f=>f.severity!=="INFO").length}  cumulative: ${totalIssues}`);
}

// ── Final summary ──────────────────────────────────────────────────────────────

const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
header(`REPROCESS COMPLETE`);
console.log(`  Batches processed: ${batchN}`);
console.log(`  Total elapsed:     ${totalElapsed}s`);
console.log(`  Total issues:      ${totalIssues}`);
if (DRY_RUN) console.log("  (DRY RUN — no DB writes made)");
if (batchN < batchCount && !MAX_BATCHES) console.log("  ✓ All queued sources processed");
else if (MAX_BATCHES && batchN >= MAX_BATCHES) {
  console.log(`\n  Resume with: --from-offset=${FROM_OFFSET + batchN * BATCH_SIZE}`);
}
