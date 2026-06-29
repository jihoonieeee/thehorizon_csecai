#!/usr/bin/env node
/**
 * discoverOperationalSources.js — LLM web-search discovery of AI-OPERATIONAL sources.
 *
 * The corpus is research/CVE-heavy because arXiv+NVD are high-volume, high-AI-fraction
 * structured APIs, while general security feeds are only 2-13% AI-specific (see
 * docs/CORPUS_COMPOSITION_AUDIT.md §7 + VALIDATION_CALIBRATION_AUDIT.md). This script
 * grows the operational side precisely: it uses Claude's server-side web_search tool
 * (LLM-native, returns REAL grounded URLs — never fabricated) to find real-world AI
 * incidents, AI-enabled campaigns, adversary AI adoption, and AI supply-chain
 * compromises, then runs each candidate through a heavy QA gauntlet before persisting.
 *
 * QA gauntlet (a candidate must survive ALL of it to be saved):
 *   1. web_search grounding     — URL must come from a real search result (webDiscoverySearch)
 *   2. deterministic gates      — URL/domain/quote grounding (candidateGates via triage)
 *   3. anti-hallucination triage— categorical route accept / accept_with_review / reject
 *   4. source-class quotas       — caps any single source class (no monoculture)
 *   5. corpus dedup              — skip URLs already in the DB (sha256 id)
 *   6. text floor                — >=200 chars of real page text
 *   7. Layer 3 validation gate   — validateAndTypeSource: validity + AI-relevance LLM +
 *                                  relevance QA + content-quality gate + final gate
 *                                  (incl. the P1 operational AI-nexus pass)
 *   8. persist                   — only pass/review reach the DB; reject is logged, not saved
 *
 * Requires ANTHROPIC_API_KEY (web_search). Forces the LLM provider regardless of
 * Tavily/SerpAPI availability, per the "use an LLM with web search" requirement.
 *
 * Usage:
 *   node scripts/discoverOperationalSources.js --dry-run
 *   node scripts/discoverOperationalSources.js --missions new_incident_or_case_study --limit 20
 *   node scripts/discoverOperationalSources.js --max-queries 6 --concurrency 3
 */

import "dotenv/config";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { runWebDiscovery } from "../lib/pipeline/discovery/runWebDiscovery.js";
import { runDiscoveryQuery } from "../lib/pipeline/discovery/webDiscoverySearch.js";
import { runDiscoverySearch } from "../lib/pipeline/discovery/discoverySearchRouter.js";
import { candidatesToSources } from "../lib/pipeline/discovery/candidateToSource.js";
import { normalizeSource } from "../lib/pipeline/ingest/normalizeSource.js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { fetchPageText } from "../lib/pipeline/discovery/fetchCandidateText.js";
import { understandSource } from "../lib/pipeline/understandSource.js";
import { DOMAINS } from "../lib/pipeline/taxonomy.js";

// Valid offensive/adjacent v2 domains (excludes the catch-all for the v2ok gate).
const DOMAINS_SET = new Set(DOMAINS.filter(d => d !== "unclear_or_adjacent"));

const args   = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (f) => args.includes(f);
const DRY      = hasFlag("--dry-run");
const LIMIT    = parseInt(getArg("--limit", "9999"), 10);
const MAXQ     = parseInt(getArg("--max-queries", "6"), 10);
const CONC     = parseInt(getArg("--concurrency", "3"), 10);
// --provider tavily|serpapi|anthropic — default keeps Anthropic web_search.
// Use tavily/serpapi when Anthropic web_search is rate-limited/unavailable.
const PROVIDER = (getArg("--provider", "") || "").trim().toLowerCase();

// The four operational missions — the buckets the corpus is missing.
const DEFAULT_MISSIONS = [
  "new_incident_or_case_study",   // real-world AI security incidents
  "new_actor_adoption",           // adversary / nation-state AI adoption
  "new_ai_enabled_cybercrime",    // AI phishing, deepfake fraud, AI malware
  "new_ai_supply_chain_compromise", // malicious models, poisoned ML deps
];
const MISSIONS = (getArg("--missions", "") || "").trim()
  ? getArg("--missions", "").split(",").map((s) => s.trim())
  : DEFAULT_MISSIONS;

const makeId = (url) => createHash("sha256").update(url).digest("hex").slice(0, 36);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("════════════════════════════════════════════════════════════");
console.log("  Operational Source Discovery  (Claude web_search)" + (DRY ? "  [DRY RUN]" : ""));
console.log(`  Missions: ${MISSIONS.join(", ")}`);
console.log(`  Max queries/mission: ${MAXQ}   Concurrency: ${CONC}`);
console.log("════════════════════════════════════════════════════════════\n");

if (!PROVIDER && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required (web_search). Aborting. (Or pass --provider tavily|serpapi.)");
  process.exit(2);
}

// ── Stage 1-4: discovery + triage + quotas (existing Layer 1B/1C infra) ───────
// Default: force the Anthropic web_search path (LLM-grounded URLs).
// --provider tavily|serpapi routes through the provider router instead — used
// when Anthropic web_search is rate-limited/hanging. The QA gauntlet downstream
// (triage + Layer-3 validation) is identical regardless of search provider.
process.env.WEB_DISCOVERY_ENABLED = "1";
let searchFn = runDiscoveryQuery;
if (PROVIDER) {
  process.env.WEB_DISCOVERY_PROVIDER = PROVIDER;
  searchFn = runDiscoverySearch;
  console.log(`  Search provider: ${PROVIDER} (via router)\n`);
}
const discovery = await runWebDiscovery({
  missions: MISSIONS,
  maxQueriesPerMission: MAXQ,
  searchFn,
  useCache: false,
});

console.log(`Discovery: ${discovery.candidates_total} candidates → ${discovery.accepted_count} accepted, ` +
  `${discovery.rejected_count} rejected, ${discovery.candidates_total - discovery.accepted_count - discovery.rejected_count} archived\n`);

const acceptedSources = candidatesToSources(discovery.accepted).slice(0, LIMIT);
if (acceptedSources.length === 0) {
  console.log("No accepted candidates to validate. (Check ANTHROPIC_API_KEY / web_search availability.)");
  process.exit(0);
}

// ── Stage 5: corpus dedup (skip URLs already in the DB) ───────────────────────
const ids = acceptedSources.map((s) => makeId(s.url)).filter(Boolean);
const existing = new Set();
for (let i = 0; i < ids.length; i += 200) {
  const { data } = await sb.from("sources").select("id").in("id", ids.slice(i, i + 200));
  for (const r of (data || [])) existing.add(r.id);
}
const fresh = acceptedSources.filter((s) => !existing.has(makeId(s.url)));
console.log(`Dedup: ${acceptedSources.length} accepted → ${fresh.length} new (${existing.size} already in corpus)\n`);

// ── Stage 6-8: text floor + Layer 3 validation gate + persist ─────────────────
const tally = { pass: 0, review: 0, reject: 0, too_short: 0, errored: 0, saved: 0 };

async function processOne(src) {
  try {
    // web_search returns short snippets — fetch the real article body before QA
    // so the text floor + Layer-3 relevance call judge the full source, not a teaser.
    if ((src.full_text || "").length < 600) {
      const fetched = await fetchPageText(src.url).catch(() => "");
      if (fetched && fetched.length > (src.full_text || "").length) src.full_text = fetched;
    }
    if ((src.full_text || "").length < 200) { tally.too_short++; return; }
    const id = makeId(src.url);
    const row = normalizeSource({
      id,
      title:          src.title,
      url:            src.url,
      publisher:      src.publisher || "Unknown",
      author:         src.author || src.publisher || "",
      date_published: src.date_published,
      source_type:    src.source_type && src.source_type !== "unknown" ? src.source_type : "incident",
      full_text:      src.full_text,
      trust_tier:     src.trust_tier && src.trust_tier !== "unknown" ? src.trust_tier : "medium",
    });

    const v = await validateAndTypeSource(row, { runQa: true });
    tally[v.validation_status] = (tally[v.validation_status] || 0) + 1;

    const keep = v.validation_status === "pass" || v.validation_status === "review";
    if (keep && !DRY) {
      // v2 understand-layer classification so discovered sources are born with a
      // v2 main_category + tags + defensive flag (legacy validateAndTypeSource does
      // not assign the v2 taxonomy, which left discovered sources at null category
      // and invisible to the dashboard / insights / slides).
      let u = null;
      try { u = await understandSource(row); } catch { /* fall back to legacy */ }
      const v2ok = u && u.relevant && DOMAINS_SET.has(u.category);

      const tags = v2ok ? (u.primary_tags || []) : [];
      const intelligence = v2ok
        ? {
            is_defensive:         u.is_defensive || false,
            defended_category:    u.defended_category || null,
            defensive_techniques: u.defensive_techniques || [],
            key_entities:         u.key_entities || [],
            main_claims:          u.main_claims || [],
          }
        : null;

      const { error } = await sb.from("sources").upsert({
        id:                 row.id,
        url:                row.url,
        title:              row.title,
        publisher:          row.publisher,
        author:             row.publisher,
        date_published:     row.date_published,
        source_type:        (v2ok && u.source_type) || v.source_type || row.source_type,
        full_text:          row.full_text,
        summary:            row.full_text?.slice(0, 500) || "",
        short_summary:      v2ok ? (u.short_summary || null) : null,
        trust_tier:         (v2ok && u.trust_tier && u.trust_tier !== "unknown") ? u.trust_tier : row.trust_tier,
        main_category:      v2ok ? u.category : (v.main_category || null),
        tags,
        intelligence,
        validation_status:  v.validation_status,
        layer3_status:      v.layer3_status || v.validation_status,
        downstream_route:   v.downstream_route || null,
        ai_threat_focus:    v.ai_threat_focus || null,
        ai_specificity_score: v.ai_specificity_score ?? null,
        relevance_tier:     v.relevance_tier ?? null,
        validation_summary: v.validation_summary || null,
        claim_extraction_status: null,
        source_origin:      "web_discovery",
      }, { onConflict: "id" });
      if (error) { console.log(`  ! save failed ${id}: ${error.message}`); return; }
      tally.saved++;
      const defMark = v2ok && u.is_defensive ? " [defensive]" : "";
      const catMark = v2ok ? u.category.split("_")[0] : "null-cat";
      process.stdout.write(`  ${v.validation_status.padEnd(6)} ${(DRY ? "would-save" : "saved").padEnd(10)} ${catMark.padEnd(12)}${defMark} ${(row.publisher || "").slice(0, 18).padEnd(18)} ${(row.title || "").slice(0, 42)}\n`);
      return;
    }
    const mark = keep ? (DRY ? "would-save" : "saved") : "drop";
    process.stdout.write(`  ${v.validation_status.padEnd(6)} ${mark.padEnd(10)} ${(row.publisher || "").slice(0, 20).padEnd(20)} ${(row.title || "").slice(0, 46)}\n`);
  } catch (e) {
    tally.errored++;
    console.log(`  ! error: ${e.message}`);
  }
}

for (let i = 0; i < fresh.length; i += CONC) {
  await Promise.all(fresh.slice(i, i + CONC).map(processOne));
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Validated ${fresh.length} new candidates`);
console.log(`  → pass: ${tally.pass}   review: ${tally.review}   reject: ${tally.reject}   too_short: ${tally.too_short}   errored: ${tally.errored}`);
console.log(`  ${DRY ? "Would save" : "Saved"}: ${DRY ? tally.pass + tally.review : tally.saved} (pass + review)${DRY ? "  [DRY RUN — no writes]" : ""}`);

const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushCostBuffer) await flushCostBuffer().catch(() => {});
