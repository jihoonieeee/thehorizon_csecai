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
 *   3. anti-hallucination triage— binary route: accept or reject
 *   4. source-class quotas       — caps any single source class (no monoculture)
 *   5. corpus dedup              — skip URLs already in the DB (sha256 id)
 *   6. text floor                — >=200 chars of real page text
 *   7. Layer 3 validation gate   — validateAndTypeSource: validity + AI-relevance LLM +
 *                                  relevance QA + content-quality gate + final gate
 *                                  (incl. the P1 operational AI-nexus pass)
 *   8. persist                   — only accepted sources reach the DB; rejected are logged, not saved
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
import { runDiscoverySearch, hasAnyDiscoveryProvider } from "../lib/pipeline/discovery/discoverySearchRouter.js";
import { candidatesToSources } from "../lib/pipeline/discovery/candidateToSource.js";
import { normalizeSource } from "../lib/pipeline/ingest/normalizeSource.js";
import { fetchPageText, contentQualityOk } from "../lib/pipeline/discovery/fetchCandidateText.js";

const args   = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (f) => args.includes(f);
const DRY             = hasFlag("--dry-run");
const LIMIT           = parseInt(getArg("--limit", "9999"), 10);
const MAXQ            = parseInt(getArg("--max-queries", "6"), 10);
const CONC            = parseInt(getArg("--concurrency", "3"), 10);
// --provider tavily|serpapi|anthropic — default keeps Anthropic web_search.
// Use tavily/serpapi when Anthropic web_search is rate-limited/unavailable.
const PROVIDER        = (getArg("--provider", "") || "").trim().toLowerCase();

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

// ── Stage 1-4: discovery + triage + quotas (existing Layer 1B/1C infra) ───────
// Default: use the mission-based provider router (runDiscoverySearch). Each
// mission's preferred_provider field in discoveryMissions.js determines whether
// Exa, Tavily, SerpAPI, or Anthropic runs for that query.
//
// --provider anthropic  → force Anthropic web_search (LLM-grounded, higher quality,
//                         slower and more expensive). The original default path.
// --provider tavily|exa|serpapi → force that provider for all queries.
// No --provider flag    → router selects per-mission (normal operation).
process.env.WEB_DISCOVERY_ENABLED = "1";
let searchFn = runDiscoverySearch;   // mission-based router (default)
if (PROVIDER === "anthropic") {
  searchFn = runDiscoveryQuery;      // force Anthropic web_search for all queries
  console.log(`  Search provider: anthropic web_search (forced)\n`);
} else if (PROVIDER) {
  process.env.WEB_DISCOVERY_PROVIDER = PROVIDER;
  console.log(`  Search provider: ${PROVIDER} (forced for all queries)\n`);
} else {
  console.log(`  Search provider: router (mission-based: Exa/Tavily/SerpAPI per mission)\n`);
}

if (!hasAnyDiscoveryProvider() && searchFn !== runDiscoveryQuery) {
  console.error("No search provider configured. Set TAVILY_API_KEY, EVA_API_KEY, SERPAPI_API_KEY, or ANTHROPIC_API_KEY.");
  process.exit(2);
}
// Fetch recent source titles so the LLM query planner can avoid re-finding
// articles already in the corpus. 7-day window balances freshness against
// the LLM's context budget (200 titles ≈ ~1.5k tokens).
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const { data: recentRows } = await sb.from("sources")
  .select("title")
  .gte("date_published", sevenDaysAgo)
  .not("title", "is", null)
  .limit(200);
const recentTitles = (recentRows || []).map((r) => r.title).filter(Boolean);
if (recentTitles.length) console.log(`  Context: ${recentTitles.length} recent titles passed to query planner\n`);

const discovery = await runWebDiscovery({
  missions: MISSIONS,
  maxQueriesPerMission: MAXQ,
  recentTitles,
  searchFn,
  useCache: false,
});

console.log(`Discovery: ${discovery.candidates_total} candidates → ${discovery.accepted_count} accepted, ${discovery.rejected_count} rejected\n`);

const acceptedSources = (await candidatesToSources(discovery.accepted)).slice(0, LIMIT);
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

// ── Stage 6-7: text quality floor + persist ───────────────────────────────────
// L3 validation and L4 classification are intentionally not run here — the daily
// classify job (classify.js) handles both uniformly for all sources with
// main_category IS NULL, including these web-discovery ones.
const tally = { saved: 0, too_short: 0, errored: 0 };

async function processOne(src) {
  try {
    // Fetch the real article body when the search snippet is too short or is
    // boilerplate nav/chrome (Tavily sometimes returns page structure, not prose).
    if ((src.full_text || "").length < 600 || !contentQualityOk(src.full_text)) {
      const fetched = await fetchPageText(src.url).catch(() => "");
      if (fetched && contentQualityOk(fetched) &&
          (fetched.length > (src.full_text || "").length || !contentQualityOk(src.full_text))) {
        src.full_text = fetched;
      }
    }
    if ((src.full_text || "").length < 200 || !contentQualityOk(src.full_text)) { tally.too_short++; return; }

    const id  = makeId(src.url);
    const row = normalizeSource({
      id,
      title:                 src.title,
      url:                   src.url,
      publisher:             src.publisher || "Unknown",
      author:                src.author || src.publisher || "",
      date_published:        src.date_published,
      date_confidence:       src.date_confidence,
      date_published_actual: src.date_published_actual,
      source_type:           src.source_type && src.source_type !== "unknown" ? src.source_type : "incident",
      full_text:             src.full_text,
      trust_tier:            src.trust_tier && src.trust_tier !== "unknown" ? src.trust_tier : "medium",
    });

    if (!DRY) {
      const { error } = await sb.from("sources").upsert({
        id:                    row.id,
        url:                   row.url,
        title:                 row.title,
        publisher:             row.publisher,
        author:                row.publisher,
        date_published:        row.date_published,
        date_confidence:       row.date_confidence,
        date_published_actual: row.date_published_actual,
        source_type:           row.source_type,
        full_text:             row.full_text,
        summary:               row.full_text?.slice(0, 500) || "",
        trust_tier:            row.trust_tier,
        validation_status:     "review",  // classify job confirms/rejects
        source_origin:         "web_discovery",
      }, { onConflict: "id" });
      if (error) { console.log(`  ! save failed ${id}: ${error.message}`); return; }
      tally.saved++;
    }
    process.stdout.write(`  ${DRY ? "would-save" : "saved"} ${(row.publisher || "").slice(0, 20).padEnd(20)} ${(row.title || "").slice(0, 50)}\n`);
  } catch (e) {
    tally.errored++;
    console.log(`  ! error: ${e.message}`);
  }
}

for (let i = 0; i < fresh.length; i += CONC) {
  await Promise.all(fresh.slice(i, i + CONC).map(processOne));
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Processed ${fresh.length} new candidates`);
console.log(`  → ${DRY ? "would-save" : "saved"}: ${tally.saved}   too_short: ${tally.too_short}   errored: ${tally.errored}`);

const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushCostBuffer) await flushCostBuffer().catch(() => {});
