/**
 * Layer 5C — Gap-Fill Web Scrape orchestrator.
 *
 * Identifies evidence gaps in the rawfact + analytics output, then scrapes
 * the open web page-by-page to fill them. Produces atomic web evidence items
 * and visual assets specifically targeting what 5A/5B are missing.
 * Flow: needs → missions → queries → search → open+cache → trace original →
 * extract evidence + visuals → validate → classify + evaluate visuals →
 * cluster → select best → frontier QA (shortlist) → package for dossiers + slides.
 *
 * Fully disable-able (WEB_EVIDENCE_ENABLED=false → no-op result) and degrades on
 * every failure (records failures, never throws). `searchFn` / `openFn` are
 * injectable for deterministic testing.
 */

import { getWebEvidenceConfig, openingPriorityOf } from "./webEvidenceConfig.js";
import { buildWebEvidenceNeeds } from "./buildWebEvidenceNeeds.js";
import { buildWebEvidenceMissions } from "./buildWebEvidenceMissions.js";
import { generateWebEvidenceQueries } from "./generateWebEvidenceQueries.js";
import { executeWebSearch } from "./executeWebSearch.js";
import { openAndCacheWebSource } from "./openAndCacheWebSources.js";
import { traceOriginalSource } from "./traceOriginalSources.js";
import { extractWebEvidence } from "./extractWebEvidence.js";
import { extractVisualCandidates } from "./extractVisualEvidence.js";
import { validateWebEvidence } from "./validateWebEvidence.js";
import { applyVisualClassification } from "./classifyVisuals.js";
import { evaluateVisual } from "./evaluateVisualUsefulness.js";
import { validateVisualEvidence } from "./validateVisualEvidence.js";
import { clusterWebEvidence } from "./clusterWebEvidence.js";
import { clusterVisualEvidence } from "./clusterVisualEvidence.js";
import { selectBestWebEvidence } from "./selectBestWebEvidence.js";
import { qaWebEvidence, qaVisual } from "./webEvidenceQa.js";
import { packageWebEvidenceForDossiers } from "./packageWebEvidenceForDossiers.js";
import { packageVisualAssetsForSlides } from "./packageVisualAssetsForSlides.js";
import { canonicalUrlKey } from "./webEvidenceSchemas.js";

export const WEB_EVIDENCE_VERSION = "web-evidence-5c-v1";

function emptyResult(note) {
  return {
    version: WEB_EVIDENCE_VERSION, enabled: false, note,
    evidence_items: [], visual_evidence: [], rejected_items: [], rejected_visuals: [],
    manual_review_items: [], unsupported_queries: [], failures: [],
    dossier_sections: {}, slide_assets: { auto_slide_candidates: [], reference_only: [], manual_review_pack: [], excluded: [] },
  };
}

/**
 * @param {object} params
 * @param {object[]} [params.evidencePacks]   rawfact packs (5A)
 * @param {object}   [params.analyticsResult] analytics result (5B)
 * @param {object}   [params.slideNeedsByCategory]
 * @param {string[]} [params.seedEntities]
 * @param {object}   [params.opts] { config, searchFn, openFn, skipLlm }
 * @returns {Promise<object>}
 */
export async function runWebEvidenceBranch(params = {}) {
  const config = params.opts?.config || getWebEvidenceConfig();
  const searchFn = params.opts?.searchFn || executeWebSearch;
  const openFn = params.opts?.openFn || openAndCacheWebSource;
  const skipLlm = params.opts?.skipLlm || false;

  const usingDefaultSearch = searchFn === executeWebSearch;
  if (!config.enabled) return emptyResult("web_evidence_disabled");
  if (usingDefaultSearch && !(process.env.TAVILY_API_KEY || process.env.SERPAPI_API_KEY)) {
    return emptyResult("no_search_provider");
  }

  // 5C.1 needs → 5C.2 missions
  const needs = buildWebEvidenceNeeds({
    evidencePacks: params.evidencePacks, analyticsResult: params.analyticsResult,
    slideNeedsByCategory: params.slideNeedsByCategory,
  });
  const missions = buildWebEvidenceMissions(needs);
  if (missions.length === 0) return emptyResult("no_evidence_gaps");

  const failures = [];
  const unsupportedByCategory = {};
  const openedByUrl = new Map();    // canonical key → opened source
  const extractedKeys = new Set();  // canonical key → already extracted (no re-extract)
  let openedCount = 0;

  const rawEvidence = [];
  const rawVisuals = [];

  for (const mission of missions) {
    // 5C.3 queries
    const queries = generateWebEvidenceQueries(mission, { entities: params.seedEntities || [], maxQueries: config.max_queries_per_category });
    let openedThisMission = 0;
    const missionResults = [];

    // 5C.4 search across providers
    for (const q of queries) {
      if (openedCount >= config.max_opened_urls) break;
      let search;
      try {
        search = await searchFn(q.query, { source_class_hint: q.source_class_hint, mission: mission.mission, category: mission.category }, { config, fetchImpl: params.opts?.fetchImpl });
      } catch (err) {
        failures.push({ provider: "search", query: q.query, failure_reason: err.message });
        continue;
      }
      for (const f of (search?.failures || [])) failures.push(f);
      if (!search?.results?.length) { (unsupportedByCategory[mission.category] ||= []).push(q.query); continue; }
      missionResults.push(...search.results.map((r) => ({ ...r, _visualMission: q.visual })));
    }

    // 5C opening priority: original/primary first, news last.
    missionResults.sort((a, b) => openingPriorityOf(a.source_class_hint) - openingPriorityOf(b.source_class_hint));

    for (const r of missionResults) {
      if (openedThisMission >= config.max_opened_urls_per_mission || openedCount >= config.max_opened_urls) break;
      const key = canonicalUrlKey(r.result_url);
      let opened = openedByUrl.get(key);
      if (!opened) {
        try { opened = await openFn(r.result_url, { config, fetchImpl: params.opts?.fetchImpl }); }
        catch (err) { failures.push({ provider: r.provider, query: r.query, failed_url: r.result_url, failure_reason: err.message }); continue; }
        openedByUrl.set(key, opened);
        openedCount++; openedThisMission++;
        if (!opened.opened_url_confirmed) { failures.push({ provider: r.provider, failed_url: r.result_url, failure_reason: opened.failure_reason || "open_failed" }); continue; }
      }

      // 5C.5 trace original source (prefer original for extraction)
      let primary = opened, lineage = { source_lineage_status: "original", original_source_url: null, derivative_source_url: null };
      try {
        const traced = await traceOriginalSource(opened, { config, fetchImpl: params.opts?.fetchImpl });
        primary = traced.primary_opened || opened;
        lineage = {
          source_lineage_status: traced.source_lineage,
          original_source_url: traced.original_source_url,
          derivative_source_url: traced.derivative_source_url,
        };
      } catch { /* keep original */ }

      // Extract each unique page only once (cached pages are reused across missions).
      const extractKey = canonicalUrlKey(primary.source_url);
      if (extractedKeys.has(extractKey)) continue;
      extractedKeys.add(extractKey);

      const ctx = { category: mission.category, mission: mission.mission, taxonomy_context: { primary_domain: mission.category, primary_tags: mission.taxonomy_tags || [], sub_techniques: [] } };

      // 5C.6 extract evidence
      try {
        const ev = await extractWebEvidence(primary, ctx, { skipLlm });
        ev.source_lineage = lineage;
        rawEvidence.push(ev);
      } catch (err) { failures.push({ provider: r.provider, failed_url: primary.source_url, failure_reason: `extract:${err.message}` }); }

      // 5C.6b extract visuals (when mission seeks visuals or page has them)
      if (r._visualMission || true) {
        try {
          const vis = await extractVisualCandidates(primary, ctx, { config });
          rawVisuals.push(...vis);
        } catch (err) { failures.push({ failed_url: primary.source_url, failure_reason: `visual_extract:${err.message}` }); }
      }
    }
  }

  // 5C.7 validate text evidence
  let evidence = rawEvidence.map(validateWebEvidence);

  // Bind visuals to evidence on the same source BEFORE usefulness/suitability,
  // so the visual-to-claim binding gate sees the linkage.
  bindVisualsToEvidence(rawVisuals, evidence);

  // visuals: classify → evaluate usefulness + slide suitability → validate
  let visuals = rawVisuals
    .map(applyVisualClassification)
    .map((v) => evaluateVisual(v, { flags: v._classification_flags }))
    .map(validateVisualEvidence);

  // 5C.9 cluster
  evidence = clusterWebEvidence(evidence);
  visuals = clusterVisualEvidence(visuals);

  // 5C.10 select best evidence
  const { selected } = selectBestWebEvidence(evidence, {
    maxPerCategory: config.max_final_evidence_per_category, visualEvidence: visuals,
  });

  // frontier QA on the shortlist only
  let qaSelected = selected;
  if (config.frontier_qa_enabled) {
    qaSelected = [];
    for (const e of selected) qaSelected.push(await qaWebEvidence(e, { skipLlm }));
    // QA top visuals (cap)
    const shortlistVisuals = visuals.filter((v) => v.is_cluster_representative !== false && ["embed", "redraw"].includes(v.slide_suitability?.decision)).slice(0, config.max_frontier_qa_visuals);
    const qaIds = new Set(shortlistVisuals.map((v) => v.visual_evidence_id));
    const qadVisuals = [];
    for (const v of visuals) qadVisuals.push(qaIds.has(v.visual_evidence_id) ? await qaVisual(v, { skipLlm }) : v);
    visuals = qadVisuals;
  }

  // 5C.11 / 5C.12 package
  const pkg = packageWebEvidenceForDossiers({
    selectedEvidence: qaSelected, allEvidence: evidence, visuals, unsupportedByCategory, missions,
  });
  const slideAssets = packageVisualAssetsForSlides(
    visuals.filter((v) => v.is_cluster_representative !== false),
    { maxFinalVisualsPerCategory: config.max_final_visuals_per_category, maxHeroVisualsPerCategory: config.max_hero_visuals_per_category },
  );

  return {
    version: WEB_EVIDENCE_VERSION, enabled: true,
    missions_run: missions.map((m) => `${m.mission}:${m.category}`),
    evidence_items: pkg.flat.evidence_items,
    visual_evidence: pkg.flat.visual_evidence,
    rejected_items: pkg.flat.rejected_items,
    rejected_visuals: visuals.filter((v) => v.slide_suitability?.decision === "reject"),
    manual_review_items: pkg.flat.manual_review_items,
    // Structured unsupported_queries (new) alongside flat list (backward compat)
    unsupported_queries: Object.values(unsupportedByCategory).flat(),
    unsupported_queries_structured: pkg.unsupported_queries_structured || [],
    unsupported_queries_by_category: unsupportedByCategory,
    failures,
    dossier_sections: pkg.byCategory,
    slide_assets: slideAssets,
    counts: {
      missions: missions.length, opened: openedCount,
      evidence_total: evidence.length, evidence_selected: qaSelected.length,
      visuals_total: visuals.length, visuals_auto_slide: slideAssets.auto_slide_candidates.length,
      failures: failures.length,
    },
  };
}

// Visual-to-claim binding: link a visual to evidence from the same source.
function bindVisualsToEvidence(visuals, evidence) {
  const byUrl = new Map();
  for (const e of evidence) {
    const k = canonicalUrlKey(e.source_grounding?.source_url || "");
    if (!k) continue;
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push(e);
  }
  for (const v of visuals) {
    if ((v.supports_evidence_ids || []).length > 0) continue;
    const matches = byUrl.get(canonicalUrlKey(v.source_url)) || [];
    if (matches.length) {
      v.supports_evidence_ids = [matches[0].web_evidence_id];
      v.claim_supported_by_visual = true;
      if (!v.visual_claim) v.visual_claim = matches[0].concrete_claim;
    }
  }
}
