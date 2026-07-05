import { fetchNvdSources } from "./connectors/nvdConnector.js";
import { fetchArxivSources } from "./connectors/arxivConnector.js";
import { fetchLlmDiscoverySources } from "./connectors/llmDiscoveryConnector.js";
import { fetchRegistryFeedSources } from "./connectors/registryFeedConnector.js";
import { fetchGithubAdvisorySources } from "./connectors/githubAdvisoryConnector.js";
import { fetchCisaKevSources } from "./connectors/cisaKevConnector.js";
import { fetchExploitResearchSources } from "./connectors/exploitResearchConnector.js";

import { SOURCE_REGISTRY } from "./sourceRegistry.js";
import { runConnector } from "./runConnector.js";
import { filterAcceptableSources } from "./filterAcceptableSources.js";
import { computeEligibilityFlags } from "./eligibilityFlags.js";

import { getSingaporeDailyWindow, get12MonthWindow, isWithinWindow } from "../../time/reportingWindow.js";
import { cleanSources } from "../clean/cleanSources.js";
import { dedupeSources } from "../../utils/dedupe.js";
import { detectNearDuplicates } from "../clean/detectNearDuplicates.js";
import { attachValidityToSources } from "./sourceValidity.js";
import { attachInitialTags } from "./tagSource.js";
import { archiveSources } from "./archiveStore.js";
import { validateAndTypeSources } from "../validation/validateAndTypeSource.js";

import { runWebDiscovery } from "../discovery/runWebDiscovery.js";
import { candidatesToSources } from "../discovery/candidateToSource.js";
import { extractEntities } from "../discovery/candidateGates.js";
import { enrichCandidatesWithText } from "../discovery/fetchCandidateText.js";


function filterByPublishedDateWindow(sources, window) {
  const kept = [];
  const removed = [];

  for (const source of sources) {
    if (source.date_published && isWithinWindow(source.date_published, window)) {
      kept.push(source);
    } else {
      removed.push({
        id: source.id,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        source_type: source.source_type,
        date_published: source.date_published,
        date_collected: source.date_collected,
        reason: source.date_published
          ? "Published date outside reporting window"
          : "Missing valid published date",
      });
    }
  }

  return { kept, removed };
}

/**
 * Collect and normalise raw sources.
 *
 * options.mode:
 *   "daily"        (default) — 24-hour SGT window; used by the daily cron
 *   "horizon_scan" — 12-month UTC window; used by the annual horizon scan pipeline
 *
 * options.connectors — array of connector keys to restrict which connectors run.
 *   NVD and arXiv honour the full window via date-range queries.
 *   RSS feeds always return their most recent ~50 items regardless of mode.
 */
export async function collectRawSources(customWindow = null, options = {}) {
  let window;
  if (customWindow) {
    window = customWindow;
  } else if (options.mode === "horizon_scan") {
    window = get12MonthWindow();
  } else {
    window = getSingaporeDailyWindow();
  }

  const includeFeeds = options.includeFeeds ?? true;
  const requestedConnectors = options.connectors || null;

  const registryConnectors = SOURCE_REGISTRY
    .filter((source) => source.enabled)
    .map((source) => ({
      name: source.name,
      key: source.name.toLowerCase().replaceAll(" ", "_"),
      trust_tier: source.trust_tier,
      retrieval_method: source.retrieval_method,
      timeout_ms: 15000,
      run: (runOptions) => fetchRegistryFeedSources(source, runOptions),
    }));

  // NVD splits the window into ≤120-day sub-ranges; a 12-month horizon scan is
  // ~4 sub-ranges and a single 45s budget would abort mid-fetch. Scale the
  // timeout to the number of sub-ranges (~35s each), capped.
  const nvdRangeCount = (() => {
    const s = new Date(window.start_utc).getTime();
    const e = new Date(window.end_utc).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 1;
    return Math.max(1, Math.ceil((e - s) / (119 * 24 * 60 * 60 * 1000)));
  })();
  const nvdTimeoutMs = Math.min(300000, nvdRangeCount * 35000);

  const apiConnectors = [
    {
      name: "NVD",
      key: "nvd",
      trust_tier: "primary",
      retrieval_method: "official_api",
      timeout_ms: nvdTimeoutMs,
      run: fetchNvdSources,
    },
    {
      // Lane B: AI/ML package CVEs from GitHub Advisory Database
      // Catches CVEs in LangChain, transformers, gradio, etc. that NVD keyword
      // search misses because NVD descriptions rarely name AI frameworks.
      name: "GitHub Advisory Database",
      key: "ghsa",
      trust_tier: "high",
      retrieval_method: "official_api",
      timeout_ms: 120000,
      run: fetchGithubAdvisorySources,
    },
    {
      // Lane B: CISA Known Exploited Vulnerabilities — confirmed-exploitation signal
      // Every KEV entry is adversary-confirmed exploitation. Highest operational
      // priority of any vulnerability source. Full catalog fetched + date-filtered.
      name: "CISA KEV",
      key: "cisa_kev",
      trust_tier: "primary",
      retrieval_method: "official_api",
      timeout_ms: 30000,
      run: fetchCisaKevSources,
    },
    {
      name: "arXiv",
      key: "arxiv",
      trust_tier: "high",
      retrieval_method: "official_api",
      timeout_ms: 180000,  // 10 queries × ~5s each + rate-limit retries
      run: fetchArxivSources,
    },
    // AI Incident Database is covered by the registry feed (incidentdatabase.ai/rss.xml)
    {
      name: "Exploit Research",
      key:  "exploit_research",
      trust_tier:       "high",
      retrieval_method: "mixed",
      timeout_ms:       180000,  // P0 + PortSwigger + SecLab (parallel RSS) + Exploit-DB sequential
      run: fetchExploitResearchSources,
    },
    {
      name: "LLM Discovery",
      key: "llm_discovery",
      trust_tier: "medium",
      retrieval_method: "llm_discovery",
      timeout_ms: 150000, // 4 Gemini calls (~48s) + full-text fetch for ~25 URLs at 4 concurrency (~52s)
      run: fetchLlmDiscoverySources,
    },
  ];

  const filteredApiConnectors = requestedConnectors
    ? apiConnectors.filter((connector) =>
        requestedConnectors.includes(connector.key)
      )
    : apiConnectors;

  // extraConnectors: additional connector descriptors injected by the caller
  // (e.g. aiidConnector, sitemapConnector in backfillOperational.js).
  // They must have the same { name, key, trust_tier, run, timeout_ms } shape.
  const extraConnectors = options.extraConnectors || [];

  const connectors = [
    ...(includeFeeds ? registryConnectors : []),
    ...filteredApiConnectors,
    ...extraConnectors,
  ];

  const connectorRuns = await Promise.all(
    connectors.map((connector) => runConnector(connector, { window }))
  );

  const rawSources = connectorRuns.flatMap((run) => run.sources);
  const cleaned = cleanSources(rawSources);

  const { kept: windowed, removed: removedByPublishDate } =
    filterByPublishedDateWindow(cleaned, window);

  // ── Layer 1B/1C — Web Discovery ─────────────────────────────────────────────
  // Opt-in (options.webDiscovery or WEB_DISCOVERY_ENABLED=1). Discovers fresh
  // candidate sources from the open web, triages them (deterministic gates +
  // cheap-LLM judgement), and merges ACCEPTED candidates into the normal pipeline
  // here — AFTER the publish-date window so freshness-vetted discoveries are not
  // dropped for lacking a precise in-window publish date. archive_only/reject
  // candidates are returned for audit only (never enter Layer 2+).
  const runDiscovery = options.webDiscovery ?? (process.env.WEB_DISCOVERY_ENABLED === "1");
  let webDiscovery = null;
  let discoverySources = [];
  let demotedThinDiscovery = [];
  if (runDiscovery) {
    try {
      // Seed entity-targeted searches from the fixed-feed corpus (CVEs, models, tools).
      const seedEntities = [...new Set(
        windowed.flatMap((s) => extractEntities(`${s.title || ""} ${s.summary || ""}`).all)
      )].slice(0, 20);

      webDiscovery = await runWebDiscovery({
        missions: options.discoveryMissions || undefined,
        seedEntities,
        skipLlm: options.skipLlm || false,
        // Bound discovery volume so the run fits a CI/serverless time budget.
        // Triage is one cheap-LLM call per candidate; 16 missions × 8 queries
        // yields ~800 candidates (~30 min). Callers on a clock pass a lower cap.
        ...(options.discoveryMaxQueriesPerMission
          ? { maxQueriesPerMission: options.discoveryMaxQueriesPerMission }
          : {}),
      });

      // Give accepted candidates real body text before they enter Layer 2/3.
      // Providers that already extract content (Tavily) carry page_text; SERP-only
      // candidates are fetched + cleaned here. Anything still without usable text
      // is demoted to audit instead of being persisted as a quote-only source —
      // such rows cannot support evidence extraction or slide generation.
      const enriched = await enrichCandidatesWithText(webDiscovery.accepted || [], {
        fetch: options.fetchDiscoveryText ?? true,
        fetchImpl: options.discoveryFetchImpl || undefined,
      });
      const usableCandidates = enriched.filter((c) => c.text_status !== "thin");
      demotedThinDiscovery = enriched
        .filter((c) => c.text_status === "thin")
        .map((c) => ({
          opened_url: c.opened_url,
          title: c.title,
          publisher: c.publisher,
          discovery_mission: c.discovery_mission,
          route: c.route,
          reason: "no_usable_body_text",
        }));

      discoverySources = cleanSources(candidatesToSources(usableCandidates));
    } catch (err) {
      console.warn("Web discovery skipped:", err.message);
      webDiscovery = { enabled: false, notes: [`error:${err.message}`], accepted: [], audit: [] };
    }
  }

  const deduped = dedupeSources([...windowed, ...discoverySources]);

  // ── Near-duplicate clustering ───────────────────────────────────────────────
  // dedupeSources only catches exact URL / normalised-title / content-hash
  // matches. Near-duplicate reporting (the same story rewritten by several
  // outlets) survives that pass and would otherwise count as many independent
  // sources — inflating corroboration and trend counts downstream. Collapse each
  // near-duplicate cluster to its highest-quality representative here, and keep
  // the removed members for audit (they never enter Layer 2+).
  const { kept: nearDeduped, removed: removedNearDuplicates } =
    detectNearDuplicates(deduped);

  // Annotate each representative with how many near-duplicate members it absorbed
  // so downstream "appears across N outlets" context is preserved without
  // counting each rewrite as separate evidence.
  const nearDupCountByKeeper = new Map();
  for (const r of removedNearDuplicates) {
    nearDupCountByKeeper.set(r.kept_id, (nearDupCountByKeeper.get(r.kept_id) || 0) + 1);
  }
  for (const source of nearDeduped) {
    const absorbed = nearDupCountByKeeper.get(source.id) || 0;
    if (absorbed > 0) source.near_duplicate_count = absorbed;
  }

  const { accepted, rejected } = filterAcceptableSources(nearDeduped);
  const withValidity = await attachValidityToSources(accepted);

  const usableSources = withValidity.filter(
    (source) => source.validity?.usable
  );

  const discardedByValidity = withValidity
    .filter((source) => !source.validity?.usable)
    .map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      source_type: source.source_type,
      date_published: source.date_published,
      reason: "Failed validity check",
      validity: source.validity,
    }));

  // ── Layer 3 — Validation (AI-threat relevance + summary + source typing) ─────
  // Deterministic AI-signal pre-gate discards obvious noise for free; keyword-positive
  // sources get a cheap LLM (Haiku) summary + AI-threat verdict + source_type, then a
  // second LLM QA check. Only accepted (pass + review) sources continue and are
  // archived; rejected sources are kept for audit but never written to the sources table.
  let validatedSources = usableSources;
  let validationStats = null;
  let discardedByRelevance = [];
  try {
    const validation = await validateAndTypeSources(usableSources, {
      skipLlm: options.skipLlm || false,
    });
    validatedSources = validation.accepted;
    validationStats  = validation.stats;
    discardedByRelevance = validation.rejected.map((source) => ({
      id:                 source.id,
      title:              source.title,
      url:                source.url,
      publisher:          source.publisher,
      source_type:        source.source_type,
      date_published:     source.date_published,
      ai_threat_focus:    source.ai_threat_focus,
      relevance_tier:     source.relevance_tier,
      validation_summary: source.validation_summary,
      validation_status:  source.validation_status,
      reason:             source.final_validity_reason,
    }));
  } catch (err) {
    console.warn("Validation layer skipped:", err.message);
  }

  // Attach initial tags and then compute per-source eligibility flags.
  // Eligibility depends on date_published, date_confidence, trust_tier, and source_type
  // which are all stable by this point in the pipeline.
  const taggedRaw = attachInitialTags(validatedSources);
  const tagged = taggedRaw.map((source) => ({
    ...source,
    ...computeEligibilityFlags(source, window),
  }));

  let archive = null;
  try {
    archive = await archiveSources(tagged, window);
  } catch (err) {
    console.warn("Local archive skipped:", err.message);
  }

  // ── Run-health / degradation signal ─────────────────────────────────────────
  // A connector that errored, or a PRIMARY-coverage connector (NVD/arXiv) that
  // returned zero, means the corpus this run is non-representative. Surface it so
  // callers can avoid generating an "evidence-backed" deck off a degraded run
  // without realising coverage was thin.
  const PRIMARY_COVERAGE = new Set(["NVD", "arXiv"]);
  const degraded_reasons = [];
  for (const run of connectorRuns) {
    if (run.status === "rejected") {
      degraded_reasons.push(`connector_error:${run.name}:${run.error || "unknown"}`);
    } else if (PRIMARY_COVERAGE.has(run.name) && run.count === 0) {
      degraded_reasons.push(`primary_connector_empty:${run.name}`);
    }
  }
  const degraded = degraded_reasons.length > 0;
  if (degraded) {
    console.warn(`Ingestion run degraded: ${degraded_reasons.join("; ")}`);
  }

  return {
    reporting_window: window,
    sources: tagged,

    // Run-health: true when a connector errored or a primary connector returned
    // nothing. Callers should treat trend/corroboration output as provisional.
    degraded,
    degraded_reasons,

    removed_by_publish_date: removedByPublishDate,
    removed_by_publish_date_count: removedByPublishDate.length,

    rejected_sources: rejected,
    rejected_count: rejected.length,

    // Layer 2 near-duplicate clustering: members collapsed into a higher-quality
    // representative. Audit-only; never written to the sources table.
    removed_near_duplicates: removedNearDuplicates,
    removed_near_duplicates_count: removedNearDuplicates.length,

    discarded_by_validity: discardedByValidity,
    discarded_count: discardedByValidity.length,

    // Layer 3 validation: sources discarded as not genuinely about an AI threat
    // (deterministic pre-gate or LLM verdict). Audit-only; not written to sources.
    discarded_by_relevance: discardedByRelevance,
    discarded_by_relevance_count: discardedByRelevance.length,
    validation_stats: validationStats,

    // Layer 1B/1C web-discovery result (null when not run). `web_discovery.audit`
    // holds archive_only/reject candidates for persistence + audit.
    web_discovery: webDiscovery,
    web_discovery_accepted_count: webDiscovery?.accepted_count ?? 0,
    web_discovery_audit_count: webDiscovery?.audit_count ?? 0,

    // Accepted discoveries demoted because they had no usable body text after
    // fetch enrichment (would have entered as quote-only / empty sources).
    demoted_thin_discovery: demotedThinDiscovery,
    demoted_thin_discovery_count: demotedThinDiscovery.length,

    pipeline_counts: {
      connectors_run: connectors.length,
      raw: rawSources.length,
      cleaned: cleaned.length,
      within_publish_date_window: windowed.length,
      removed_by_publish_date: removedByPublishDate.length,
      web_discovery_accepted: discoverySources.length,
      deduped: deduped.length,
      near_deduped: nearDeduped.length,
      removed_near_duplicates: removedNearDuplicates.length,
      accepted: accepted.length,
      rejected: rejected.length,
      validity_checked: withValidity.length,
      usable: usableSources.length,
      discarded_by_validity: discardedByValidity.length,
      validation_accepted: validatedSources.length,
      discarded_by_relevance: discardedByRelevance.length,
    },

    archive,

    connector_results: connectorRuns.map((run) => ({
      connector: run.name,
      status: run.status,
      count: run.count,
      error: run.error,
      trust_tier: run.trust_tier,
      retrieval_method: run.retrieval_method,
      started_at: run.started_at,
      finished_at: run.finished_at,
    })),
  };
}
