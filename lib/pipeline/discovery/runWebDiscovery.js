/**
 * Web Discovery — Orchestrator (Layer 1B + 1C)
 *
 * Recall-first discovery, then triage. For each mission:
 *   1. Build query families (seed → taxonomy → artifact → site_scoped →
 *      entity_seeded), capped by a per-mission query budget.
 *   2. Run searches, collecting RAW candidates and tracking which source classes
 *      appeared (source-class quotas prevent news domination).
 *   3. If target source classes return nothing, run RETRY-expansion queries
 *      before recording an unsupported query.
 *   4. Normalize candidates (deterministic gates) grounded against opened URLs.
 *
 * Then, across the whole run:
 *   5. Dedupe + cluster (original vs syndicated/derivative).
 *   6. Triage (cheap-LLM enrichment + deterministic early-signal + routing).
 *   7. Enforce source-class quotas (over-quota accepted → reject).
 *   8. Optional frontier QA on moderate/strong early signals.
 *   9. Split: accepted (→ Layer 2) vs rejected and record
 *      unsupported queries.
 *
 * Fully degradable: with no ANTHROPIC_API_KEY (and no injected searchFn) it
 * returns an empty-but-well-formed result with a note — never fabricated sources.
 * `searchFn`, `triageFn`, and `qaFn` are injectable for deterministic testing.
 */

import { createHash } from "crypto";

import { allMissions, getMissionDef } from "../../config/discoveryMissions.js";
import { ROUTES_INTO_PIPELINE, sourceClassCap } from "../../config/webDiscoveryVocab.js";
import { buildDiscoveryQueries } from "./buildDiscoveryQueries.js";
import { craftLlmQueries } from "./craftLlmQueries.js";
import { WEB_DISCOVERY_VERSION, buildGroundedUrlSet } from "./webDiscoverySearch.js";
import { runDiscoverySearch, hasAnyDiscoveryProvider } from "./discoverySearchRouter.js";
import { normalizeCandidate } from "./normalizeCandidate.js";
import { dedupeCandidates } from "./dedupeCandidates.js";
import { triageCandidates } from "./triageCandidates.js";
import { applyEarlySignalQa } from "./earlySignal.js";
import { enrichCandidatesWithText, contentQualityOk } from "./fetchCandidateText.js";
import { buildDiscoveryCacheKey, discoveryCacheGet, discoveryCacheSet } from "../../cache/webDiscoveryCache.js";
import { supabase } from "../../storage/supabaseClient.js";

function candidateId(url = "") {
  return createHash("sha256").update(url).digest("hex").slice(0, 36);
}

const QUALITY_RANK = { primary: 4, high: 3, medium: 2, low: 1 };

/**
 * @param {object} [opts]
 * @param {string[]} [opts.missions]              missions to run (default: all)
 * @param {string[]} [opts.seedEntities]          entities to seed targeted searches
 * @param {boolean}  [opts.skipLlm=false]         skip cheap-LLM triage enrichment AND query planning
 * @param {boolean}  [opts.skipLlmQueries=false]  skip LLM query planning only (keep triage)
 * @param {number}   [opts.maxQueriesPerMission=8]
 * @param {string[]} [opts.recentTitles]          titles of recently ingested sources (LLM context)
 * @param {Date}     [opts.now]
 * @param {boolean}  [opts.useCache=true]
 * @param {Function} [opts.searchFn]              override runDiscoveryQuery (tests)
 * @param {Function} [opts.triageFn]              override triageCandidates (tests)
 * @param {Function} [opts.queryPlannerFn]        override craftLlmQueries (tests)
 * @param {Function} [opts.qaFn]                  frontier QA for moderate/strong signals
 * @returns {Promise<object>} discovery result (see return shape at bottom)
 */
export async function runWebDiscovery(opts = {}) {
  const {
    missions = allMissions(),
    seedEntities = [],
    skipLlm = false,
    skipLlmQueries = false,
    maxQueriesPerMission = 8,
    recentTitles = [],
    now = new Date(),
    useCache = true,
    searchFn = runDiscoverySearch,
    triageFn = triageCandidates,
    queryPlannerFn = craftLlmQueries,
    qaFn = null,
  } = opts;

  const usingDefaultSearch = searchFn === runDiscoverySearch;
  const discoveryEnabled = process.env.WEB_DISCOVERY_ENABLED !== "0";

  // Hard short-circuit: default network path with no provider or disabled → empty.
  if (usingDefaultSearch && (!discoveryEnabled || !hasAnyDiscoveryProvider())) {
    return emptyResult(missions, !discoveryEnabled ? "web_discovery_disabled" : "no_discovery_provider");
  }

  const rawCandidates = [];
  const unsupported_queries = [];
  const unsupported_queries_by_source_class = {};
  const unsupported_queries_by_mission = {};
  const notes = [];

  // ── Phase 1: cache check + deterministic family build ────────────────────
  // Build all mission plans upfront so Phase 2 can parallelise LLM planning.
  const missionPlans = new Map(); // mission → { def, cacheKey, families, cached }
  for (const mission of missions) {
    const def = getMissionDef(mission);
    if (!def) continue;

    const cacheKey = buildDiscoveryCacheKey(mission, WEB_DISCOVERY_VERSION);
    let cached = null;
    if (useCache && usingDefaultSearch) {
      cached = await discoveryCacheGet(cacheKey);
      if (cached) {
        for (const c of cached.candidates || []) rawCandidates.push(c);
        for (const q of cached.unsupported || []) unsupported_queries.push(q);
      }
    }

    missionPlans.set(mission, {
      def,
      cacheKey,
      families: cached ? null : buildDiscoveryQueries(mission, { entities: seedEntities }),
      cached:   !!cached,
    });
  }

  // ── Phase 2: parallel LLM query planning (cap 4 concurrent) ──────────────
  // LLM calls are independent across missions; searches must stay sequential
  // (rate-limit sensitive). Planning all missions in parallel before any search
  // fires cuts cumulative LLM round-trip time from N×RTT to ⌈N/4⌉×RTT.
  const llmPlansByMission = new Map(); // mission → llmQueries[]
  const needsPlanning = [...missionPlans.entries()].filter(([, p]) =>
    !p.cached && !skipLlm && !skipLlmQueries && !p.def.seed_queries_only
  );
  const PLAN_CONCURRENCY = 4;
  for (let i = 0; i < needsPlanning.length; i += PLAN_CONCURRENCY) {
    await Promise.all(
      needsPlanning.slice(i, i + PLAN_CONCURRENCY).map(async ([mission, { def, families }]) => {
        const llmBudget = Math.max(maxQueriesPerMission - Math.min(families.seed.length, 3), 4);
        // .catch(() => []) ensures a planner failure never aborts the search phase.
        const queries = await queryPlannerFn(def, {
          now, maxQueries: llmBudget, recentTitles, seedEntities,
        }).catch(() => []);
        process.stdout.write(` [LLM queries for "${def.label}": ${queries.length}]\n`);
        llmPlansByMission.set(mission, queries);
      })
    );
  }

  // ── Phase 3: sequential search execution per mission ─────────────────────
  for (const [mission, plan] of missionPlans) {
    if (plan.cached) continue;

    const { def, cacheKey, families } = plan;
    const useLlm = !skipLlm && !skipLlmQueries && !def.seed_queries_only;
    const llmQueries = useLlm ? (llmPlansByMission.get(mission) || []) : [];

    // Ordering: seeds first (capped to seedBudget so they don't consume the
    // whole slot allocation), then LLM-crafted, then entity-seeded (corpus-derived).
    const seedBudget = useLlm ? Math.min(families.seed.length, 3) : families.seed.length;
    const ordered = useLlm
      ? [
          ...families.seed.slice(0, seedBudget),
          ...llmQueries,
          ...families.entity_seeded,
        ].slice(0, maxQueriesPerMission)
      : [
          ...families.seed, ...families.taxonomy, ...families.artifact,
          ...families.site_scoped, ...families.entity_seeded,
        ].slice(0, maxQueriesPerMission);

    const missionRaw = [];
    const missionUnsupported = [];
    const classesSeen = new Set();

    for (const q of ordered) {
      const res = await searchFn(
        { mission, missionLabel: def.label, query: q.query, family: q.family, source_class_hint: q.source_class_hint },
        {}
      );
      if (res?.note && res.note !== "search_error") notes.push(`${mission}:${res.note}`);
      const groundedUrlSet = buildGroundedUrlSet(res?.grounded || {});
      const groundedQuotes = (res?.grounded?.citations || []).map((c) => c.cited_text).filter(Boolean);

      const normalized = (res?.candidates || [])
        .map((raw) => normalizeCandidate(raw, {
          mission, search_query: q.query, search_query_family: q.family,
          groundedUrlSet, groundedQuotes, now,
        }))
        .filter(Boolean);

      for (const c of normalized) { missionRaw.push(c); classesSeen.add(c.source_class); }
      if (res?.no_results || normalized.length === 0) missionUnsupported.push(q.query);
    }

    // ── Retry expansion for target source classes that returned nothing ───────
    const missingClasses = def.target_source_classes.filter((cls) => !classesSeen.has(cls));
    if (missingClasses.length > 0 && families.retry.length > 0) {
      const retryQueries = families.retry
        .filter((q) => !q.source_class_hint || missingClasses.includes(q.source_class_hint))
        .slice(0, 4);
      for (const q of retryQueries) {
        const res = await searchFn(
          { mission, missionLabel: def.label, query: q.query, family: "retry", source_class_hint: q.source_class_hint },
          {}
        );
        const groundedUrlSet = buildGroundedUrlSet(res?.grounded || {});
        const groundedQuotes = (res?.grounded?.citations || []).map((c) => c.cited_text).filter(Boolean);
        const normalized = (res?.candidates || [])
          .map((raw) => normalizeCandidate(raw, {
            mission, search_query: q.query, search_query_family: "retry",
            groundedUrlSet, groundedQuotes, now,
          }))
          .filter(Boolean);
        for (const c of normalized) { missionRaw.push(c); classesSeen.add(c.source_class); }
      }
    }

    // After retry, any still-missing target class is genuinely unsupported.
    for (const cls of def.target_source_classes) {
      if (!classesSeen.has(cls)) {
        (unsupported_queries_by_source_class[cls] ||= []).push(mission);
      }
    }
    if (missionRaw.length === 0) {
      unsupported_queries_by_mission[mission] = missionUnsupported;
      for (const q of missionUnsupported) unsupported_queries.push(q);
    }

    for (const c of missionRaw) rawCandidates.push(c);

    if (useCache && usingDefaultSearch) {
      await discoveryCacheSet(cacheKey, { candidates: missionRaw, unsupported: missionRaw.length === 0 ? missionUnsupported : [] });
    }
  }

  // ── Dedupe + cluster across the whole run ─────────────────────────────────
  const clustered = dedupeCandidates(rawCandidates);

  // ── Corpus pre-filter — skip candidates already validated in the DB ──────────
  // Search APIs return the same top URLs on every run. Without this filter,
  // discovery_triage LLM calls are made for URLs already in the corpus —
  // identical to the L3 re-validation waste fixed in collectRawSources.js.
  // Filter by URL hash (same derivation as normalizeSource.js) before text
  // enrichment so we also skip the HTTP re-fetch cost for known URLs.
  let corpusSkippedCount = 0;
  let filtered = clustered;
  if (!skipLlm && clustered.length > 0) {
    try {
      const ids = clustered.map(c => candidateId(c.opened_url || "")).filter(Boolean);
      const corpusIds = new Set();
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await supabase
          .from("sources")
          .select("id")
          .in("id", ids.slice(i, i + 500))
          .not("layer3_status", "is", null);
        for (const row of data || []) corpusIds.add(row.id);
      }
      filtered = clustered.filter(c => !corpusIds.has(candidateId(c.opened_url || "")));
      corpusSkippedCount = clustered.length - filtered.length;
      if (corpusSkippedCount > 0) {
        console.log(`  [discovery pre-filter] ${corpusSkippedCount}/${clustered.length} already in corpus — skipping triage`);
      }
    } catch (err) {
      console.warn("  [discovery pre-filter] DB lookup failed — triaging all candidates:", err.message);
    }
  }

  // ── Text enrichment before triage ─────────────────────────────────────────
  // Providers that return full page content (Exa, Tavily) sometimes get
  // bot-detection pages, nav chrome, or cookie-consent walls instead of the
  // actual article body. enrichCandidatesWithText re-fetches any candidate
  // where hasUsableText() returns false — which calls contentQualityOk() on
  // the existing page_text and triggers a real HTTP fetch when it fails.
  //
  // After fetching, verbatim_quote and summary are updated from the new content
  // so the triage LLM reads real article text rather than nav menus.
  // Candidates that still have no usable text after re-fetch are marked
  // text_status:"thin" and will hit zero_ai_threat_anchors at triage (correct).
  //
  // Runs with bounded concurrency; skipped in skipLlm/test mode.
  let enriched = filtered;
  if (!skipLlm) {
    enriched = await enrichCandidatesWithText(filtered, { concurrency: 4, fetch: true });
    // Backfill verbatim_quote and summary from newly fetched content so the
    // triage LLM (which reads those fields, not page_text) benefits from it.
    for (const c of enriched) {
      if (c.text_status === "fetched" && c.page_text) {
        const fresh = c.page_text.replace(/\s+/g, " ").trim();
        if (fresh.length > (c.verbatim_quote || "").length) {
          c.verbatim_quote = fresh.slice(0, 400);
          c.summary        = fresh.slice(0, 600);
        }
      }
    }
  }

  // ── Triage (enrichment + early signal + routing) ──────────────────────────
  let triaged = await triageFn(enriched, { skipLlm });

  // ── Source-class quota enforcement (over-quota accepted → reject) ───────────
  triaged = enforceSourceClassQuotas(triaged);

  // ── Frontier QA on moderate/strong early signals (optional) ───────────────
  if (typeof qaFn === "function") {
    for (let i = 0; i < triaged.length; i++) {
      const c = triaged[i];
      if (c.needs_early_signal_qa && c.early_signal_qa_status === "pending") {
        try {
          const verdict = await qaFn(c);
          const signal = applyEarlySignalQa(
            {
              early_signal_value: c.early_signal_value,
              early_signal_type: c.early_signal_type,
              needs_early_signal_qa: c.needs_early_signal_qa,
              early_signal_qa_status: c.early_signal_qa_status,
            },
            verdict || {},
          );
          triaged[i] = { ...c, ...signal };
        } catch { /* leave pending */ }
      }
    }
  }

  // ── Split accepted vs audit ────────────────────────────────────────────────
  const accepted = triaged.filter((c) => ROUTES_INTO_PIPELINE.has(c.route));
  const audit = triaged.filter((c) => !ROUTES_INTO_PIPELINE.has(c.route));

  return {
    version: WEB_DISCOVERY_VERSION,
    enabled: true,
    missions_run: missions,
    candidates_total: triaged.length,
    corpus_skipped_count: corpusSkippedCount,
    accepted,
    audit,
    accepted_count: accepted.length,
    audit_count: audit.length,
    rejected_count: triaged.filter((c) => c.route === "reject").length,
    unsupported_queries: [...new Set(unsupported_queries)],
    unsupported_queries_by_source_class,
    unsupported_queries_by_mission,
    notes,
  };
}

/**
 * Enforce per-mission per-source-class caps. Over-quota accepted candidates are
 * rejected. Keeps the highest source_quality / strongest early signal per class.
 */
export function enforceSourceClassQuotas(candidates) {
  const out = candidates.map((c) => ({ ...c }));
  const byMissionClass = {};

  // Order: accepted first, then by quality + early-signal strength.
  const signalRank = { strong: 3, moderate: 2, weak: 1, none: 0 };
  const sorted = [...out].sort((a, b) => {
    const qa = QUALITY_RANK[a.source_quality] || 1, qb = QUALITY_RANK[b.source_quality] || 1;
    if (qb !== qa) return qb - qa;
    return (signalRank[b.early_signal_value] || 0) - (signalRank[a.early_signal_value] || 0);
  });

  for (const c of sorted) {
    if (!ROUTES_INTO_PIPELINE.has(c.route)) continue;
    const key = `${c.discovery_mission}:${c.source_class}`;
    const count = byMissionClass[key] || 0;
    const cap = sourceClassCap(c.source_class);
    if (count >= cap) {
      c.route = "reject";
      c.route_reason = "source_class_quota_exceeded";
      c.rejection_reason = "source_class_quota_exceeded";
      c.candidate_route_reasons = [...(c.candidate_route_reasons || []), "source_class_quota_exceeded"];
    } else {
      byMissionClass[key] = count + 1;
    }
  }
  return out;
}

function emptyResult(missions, note) {
  return {
    version: WEB_DISCOVERY_VERSION,
    enabled: false,
    missions_run: missions,
    candidates_total: 0,
    accepted: [],
    audit: [],
    accepted_count: 0,
    audit_count: 0,
    rejected_count: 0,
    unsupported_queries: [],
    unsupported_queries_by_source_class: {},
    unsupported_queries_by_mission: {},
    notes: [note],
  };
}
