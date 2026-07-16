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
 *   7. Enforce source-class quotas (over-quota → archive_only).
 *   8. Optional frontier QA on moderate/strong early signals.
 *   9. Split: accepted (→ Layer 2) vs audit (archive_only/reject) and record
 *      unsupported queries.
 *
 * Fully degradable: with no ANTHROPIC_API_KEY (and no injected searchFn) it
 * returns an empty-but-well-formed result with a note — never fabricated sources.
 * `searchFn`, `triageFn`, and `qaFn` are injectable for deterministic testing.
 */

import { allMissions, getMissionDef } from "../../config/discoveryMissions.js";
import { ROUTES_INTO_PIPELINE, sourceClassCap } from "../../config/webDiscoveryVocab.js";
import { buildDiscoveryQueries } from "./buildDiscoveryQueries.js";
import { WEB_DISCOVERY_VERSION, buildGroundedUrlSet } from "./webDiscoverySearch.js";
import { runDiscoverySearch, hasAnyDiscoveryProvider } from "./discoverySearchRouter.js";
import { normalizeCandidate } from "./normalizeCandidate.js";
import { dedupeCandidates } from "./dedupeCandidates.js";
import { triageCandidates } from "./triageCandidates.js";
import { applyEarlySignalQa } from "./earlySignal.js";
import { enrichCandidatesWithText, contentQualityOk } from "./fetchCandidateText.js";
import { buildDiscoveryCacheKey, discoveryCacheGet, discoveryCacheSet } from "../../cache/webDiscoveryCache.js";

const QUALITY_RANK = { primary: 4, high: 3, medium: 2, low: 1 };

/**
 * @param {object} [opts]
 * @param {string[]} [opts.missions]              missions to run (default: all)
 * @param {string[]} [opts.seedEntities]          entities to seed targeted searches
 * @param {boolean}  [opts.skipLlm=false]         skip cheap-LLM triage enrichment
 * @param {number}   [opts.maxQueriesPerMission=8]
 * @param {Date}     [opts.now]
 * @param {boolean}  [opts.useCache=true]
 * @param {Function} [opts.searchFn]              override runDiscoveryQuery (tests)
 * @param {Function} [opts.triageFn]              override triageCandidates (tests)
 * @param {Function} [opts.qaFn]                  frontier QA for moderate/strong signals
 * @returns {Promise<object>} discovery result (see return shape at bottom)
 */
export async function runWebDiscovery(opts = {}) {
  const {
    missions = allMissions(),
    seedEntities = [],
    skipLlm = false,
    maxQueriesPerMission = 8,
    now = new Date(),
    useCache = true,
    searchFn = runDiscoverySearch,
    triageFn = triageCandidates,
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

  for (const mission of missions) {
    const def = getMissionDef(mission);
    if (!def) continue;

    // ── Cache ───────────────────────────────────────────────────────────────
    const cacheKey = buildDiscoveryCacheKey(mission, WEB_DISCOVERY_VERSION);
    if (useCache && usingDefaultSearch) {
      const cached = await discoveryCacheGet(cacheKey);
      if (cached) {
        for (const c of cached.candidates || []) rawCandidates.push(c);
        for (const q of cached.unsupported || []) unsupported_queries.push(q);
        continue;
      }
    }

    const families = buildDiscoveryQueries(mission, { entities: seedEntities });
    const ordered = [
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
  let enriched = clustered;
  if (!skipLlm) {
    enriched = await enrichCandidatesWithText(clustered, { concurrency: 4, fetch: true });
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

  // ── Source-class quota enforcement (over-quota accepted → archive_only) ────
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
    accepted,
    audit,
    accepted_count: accepted.length,
    audit_count: audit.length,
    rejected_count: triaged.filter((c) => c.route === "reject").length,
    archive_only_count: triaged.filter((c) => c.route === "archive_only").length,
    context_only_count: triaged.filter((c) => c.route === "context_only").length,
    high_priority_count: triaged.filter((c) => c.route === "accept_high_priority").length,
    unsupported_queries: [...new Set(unsupported_queries)],
    unsupported_queries_by_source_class,
    unsupported_queries_by_mission,
    notes,
  };
}

/**
 * Enforce per-mission per-source-class caps. Over-quota ACCEPTED candidates are
 * demoted to archive_only (kept for audit, not dropped). Keeps the highest
 * source_quality / strongest early signal per class.
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
      c.route = "archive_only";
      c.route_reason = "source_class_quota_exceeded";
      c.candidate_route_reasons = [...(c.candidate_route_reasons || []), "source_class_quota_exceeded"];
      c.route_flags = [...(c.route_flags || []), "source_class_quota_exceeded"];
      c.manual_review_required = false;
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
    archive_only_count: 0,
    unsupported_queries: [],
    unsupported_queries_by_source_class: {},
    unsupported_queries_by_mission: {},
    notes: [note],
  };
}
