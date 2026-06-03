/**
 * L5A — Rawfacts Branch Orchestrator
 *
 * 10-step evidence-item pipeline (replaces old 5-step evidence-card pipeline).
 * All LLM calls are delegated to rawfactTaxonomy.js (Step 1) and
 * extractEvidenceItems.js (Step 4).
 *
 * ── PIPELINE STEPS ────────────────────────────────────────────────────────────
 * Step 1  (5a.1A): applyRawfactTaxonomies    — LLM or deterministic taxonomy tagging
 *   LLM call:  callLLM() via rawfactTaxonomy.js
 *   Fallback:  rule-based taxonomy from source_type + trust_tier
 *   Concurrency: 5
 *
 * Step 2  (5a.1):  applyEvidenceEligibility  — gate for evidence extraction
 *   Output: evidence_eligibility { eligible_for_evidence, evidence_use, reason }
 *   No LLM.
 *
 * Step 3  (5a.2):  applyExtractionProfiles   — attach per-source-type extraction profile
 *   Output: extraction_profile { allowed_evidence_types, max_items, ... }
 *   No LLM.
 *
 * Step 4  (5a.3):  extractEvidenceItems      — LLM evidence item extraction
 *   LLM call:  callLLM() via extractEvidenceItems.js
 *   Trigger:   evidence_use === "primary_evidence" | "supporting_evidence"
 *   Fallback:  legacy evidence_card → items, or understanding.main_claims
 *   Concurrency: 5
 *
 * Step 5  (5a.4):  normalizeAllEvidenceItems — validate, trim, cap, re-index
 *   No LLM.
 *
 * Step 6  (5a.5):  scoreAllEvidenceItems     — multi-dimensional evidence scoring (pass 1)
 *   No duplicate penalty in this pass.
 *   No LLM.
 *
 * Step 7  (5a.6):  clusterEvidenceItems      — Jaccard dedup at item level
 *   SIMILARITY_THRESHOLD = 0.40; also matches on shared CVEs/entities/URL.
 *   No LLM.
 *
 * Step 8  (5a.5b): rescoreWithDuplicatePenalty — apply -10 to non-representative items
 *   No LLM.
 *
 * Step 9  (5a.7):  assembleEvidencePacks     — per-category structured evidence bundles
 *   No LLM.
 *
 * Step 10 (5a.8):  qaEvidenceItems           — validate + downgrade/remove failing items
 *   No LLM.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * { rawfact_sources[], evidence_packs[], counts, rawfact_version }
 *
 * Backward compatibility (synthesisLayer + buildCategoryDossier read these):
 *   - rawfact_score_data  — derived from best evidence item in scoreSourceEvidenceItems
 *   - feed_score_data     — mirrored from rawfact_score_data
 *   - rawfact_cluster     — derived from best evidence item's cluster
 *   - evidence_card       — kept if already present; not regenerated
 */

import { applyRawfactTaxonomies }                           from "./rawfactTaxonomy.js";
import { applyEvidenceEligibility }                         from "./evidenceEligibility.js";
import { applyExtractionProfiles }                          from "./evidenceExtractionProfiles.js";
import { extractEvidenceItems }                             from "./extractEvidenceItems.js";
import { normalizeAllEvidenceItems }                        from "./normalizeEvidenceItems.js";
import { scoreAllEvidenceItems, rescoreWithDuplicatePenalty } from "./scoreEvidenceItems.js";
import { clusterEvidenceItems }                             from "./clusterEvidenceItems.js";
import { runSecondModelEvidenceQa }                         from "./qaEvidenceLlm.js";
import { assembleEvidencePacks }                            from "./assembleEvidencePacks.js";
import { qaEvidenceItems }                                  from "./qaEvidenceItems.js";

export const RAWFACT_VERSION = "rawfact-v2.0";

// ── Source-level cluster derivation (backward compat) ─────────────────────────

function deriveSourceClusters(sources) {
  return sources.map((source) => {
    const items = source.evidence_items || [];
    if (items.length === 0) {
      return {
        ...source,
        rawfact_cluster: {
          cluster_id:        null,
          cluster_size:      1,
          is_representative: true,
          cluster_theme:     "",
        },
      };
    }

    // Use best-scoring item's cluster as source-level cluster
    const bestItem = items.reduce((best, item) =>
      (item.score_data?.evidence_score ?? 0) > (best?.score_data?.evidence_score ?? 0) ? item : best
    , items[0]);

    const ec = bestItem?.evidence_cluster;
    if (!ec) return source;

    // Source is representative if it has at least one representative item
    const sourceIsRep = items.some((i) => i.evidence_cluster?.is_representative !== false);

    return {
      ...source,
      rawfact_cluster: {
        cluster_id:        ec.cluster_id,
        cluster_size:      ec.cluster_size,
        is_representative: sourceIsRep,
        cluster_theme:     ec.cluster_theme || "",
      },
    };
  });
}

// ── Taxonomy attachment (Validated AI Threat Taxonomy) ────────────────────────
// Stamp each evidence item with the source's validated taxonomy and build the
// normalized rows the taxonomy_rawfacts / ai_enabled_mappings tables persist.

function compactTags(tags) {
  return (tags || []).map((t) => ({
    tag: t.tag, domain: t.domain, parent_tag: t.parent_tag || null,
    subdomain: t.subdomain || null, confidence: t.confidence,
    validation_status: t.validation_status,
  }));
}

function attachRawfactTaxonomy(sources) {
  const taxonomy_rawfacts = [];
  const ai_enabled_mappings = [];

  const withTax = sources.map((source) => {
    const u = source.understanding || {};
    const primary_domain = source.primary_domain || u.primary_domain || "unclear_or_adjacent";
    const primary_threat_tags = compactTags(u.primary_threat_tags);
    const secondary_dimensions = u.secondary_dimensions || [];
    const validation_status = u.validation_status || "needs_manual_review";

    const items = (source.evidence_items || []).map((item) => ({
      ...item,
      taxonomy: { primary_domain, primary_threat_tags, secondary_dimensions, validation_status },
    }));

    // Normalized rows (one per evidence item) for the rawfacts table.
    for (const item of items) {
      taxonomy_rawfacts.push({
        rawfact_id:           item.evidence_id || `${source.id}_${taxonomy_rawfacts.length}`,
        source_id:            source.id,
        claim:                item.fact || item.short_label || null,
        supporting_quote:     item.source_quote || null,
        evidence_location:    item.evidence_location || item.location || null,
        primary_domain,
        primary_threat_tags,
        secondary_dimensions,
        taxonomy_confidence:  validation_status,
        validation_status,
        caveat_if_any:        (u.primary_threat_tags || []).map((t) => t.caveat_if_any).filter(Boolean)[0] || null,
      });
    }

    // Paired AI-enabled mappings, carrying the source's evidence ids.
    for (const m of u.ai_enabled_mappings || []) {
      ai_enabled_mappings.push({
        ...m,
        source_id: source.id,
        supporting_evidence_ids: items.map((i) => i.evidence_id).filter(Boolean),
      });
    }

    return { ...source, evidence_items: items, primary_domain };
  });

  return { sources: withTax, taxonomy_rawfacts, ai_enabled_mappings };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the full rawfact branch (10 steps).
 *
 * @param {object[]} sources - Sources from Layer 3+ (must have source_type, main_category, trust_tier).
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]   - Skip all LLM calls (deterministic only).
 * @param {number}   [opts.concurrency=5]   - Max parallel LLM calls per layer.
 * @param {string}   [opts.saveTo=null]     - If set, write debug JSON files to this directory.
 * @returns {Promise<{ rawfact_sources: object[], evidence_packs: object[], counts: object, rawfact_version: string }>}
 */
export async function runRawfactBranch(sources, opts = {}) {
  const { skipLlm = false, concurrency = 5, saveTo = null } = opts;

  // ── Step 1: Rawfact taxonomy ──────────────────────────────────────────────────
  process.stdout.write(`[L5A-rawfacts] step 1/10 — taxonomy (${sources.length} sources, skipLlm=${skipLlm})\n`);
  const withTaxonomy = await applyRawfactTaxonomies(sources, { skipLlm, concurrency });

  // ── Step 2: Evidence eligibility ─────────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  2/10 — evidence eligibility\n");
  const withEligibility = applyEvidenceEligibility(withTaxonomy);
  const eligibleCount   = withEligibility.filter((s) =>
    s.evidence_eligibility?.eligible_for_evidence
  ).length;
  process.stdout.write(`            eligible=${eligibleCount}/${withEligibility.length}\n`);

  // ── Step 3: Extraction profiles ───────────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  3/10 — extraction profiles\n");
  const withProfiles = applyExtractionProfiles(withEligibility);

  // ── Step 4: Evidence item extraction (LLM) ────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  4/10 — evidence item extraction\n");
  const withRawItems = await extractEvidenceItems(withProfiles, { skipLlm, concurrency });

  // ── Step 5: Normalize evidence items ─────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  5/10 — normalize evidence items\n");
  const withItems    = normalizeAllEvidenceItems(withRawItems);
  const totalRawItems = withItems.reduce((n, s) => n + (s.evidence_items || []).length, 0);
  process.stdout.write(`            total_items=${totalRawItems}\n`);

  // ── Step 6: Initial scoring ───────────────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  6/10 — initial scoring\n");
  const withScores   = scoreAllEvidenceItems(withItems);

  // ── Step 7: Cluster evidence items ────────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  7/10 — cluster evidence items\n");
  const withClusters = clusterEvidenceItems(withScores);

  // ── Step 8: Rescore with duplicate penalty ────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  8/10 — rescore with duplicate penalty\n");
  const withRescored = rescoreWithDuplicatePenalty(withClusters);

  // ── Step 8b: Second-model QA (different model verifies high-priority items) ────
  // Runs before pack assembly so any downgrade demotes the item out of the
  // critical/high packs. Bounded + graceful: no-op when skipLlm or no 2nd model.
  process.stdout.write("[L5A-rawfacts] step 8b/10 — second-model evidence QA\n");
  const { sources: withSecondQa, report: secondQaReport } =
    await runSecondModelEvidenceQa(withRescored, { skipLlm });

  // ── Step 9: Assemble evidence packs ───────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  9/10 — assemble evidence packs\n");
  const rawPacks     = assembleEvidencePacks(withSecondQa);

  // ── Step 10: Evidence QA (deterministic) ──────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step 10/10 — evidence QA\n");
  const { sources: withQa, evidence_packs: qaPacks } = qaEvidenceItems(withSecondQa, rawPacks);

  // ── Derive source-level rawfact_cluster (backward compat) ─────────────────────
  const withClustersFinal = deriveSourceClusters(withQa);

  // ── Attach Validated AI Threat Taxonomy to items + build normalized rows ──────
  const { sources: final, taxonomy_rawfacts, ai_enabled_mappings } = attachRawfactTaxonomy(withClustersFinal);

  // ── Build counts ──────────────────────────────────────────────────────────────
  const allItems = final.flatMap((s) => s.evidence_items || []);

  const itemCritical = allItems.filter((i) => i.score_data?.evidence_priority === "critical").length;
  const itemHigh     = allItems.filter((i) => i.score_data?.evidence_priority === "high").length;
  const itemMedium   = allItems.filter((i) => i.score_data?.evidence_priority === "medium").length;
  const itemLow      = allItems.filter((i) => i.score_data?.evidence_priority === "low").length;
  const itemArchive  = allItems.filter((i) => i.score_data?.evidence_priority === "archive_only").length;

  const multiSourceClusters = new Set(
    allItems
      .filter((i) => i.evidence_cluster?.is_multi_source)
      .map((i) => i.evidence_cluster?.cluster_id)
  ).size;

  const totalClusters = new Set(
    allItems.map((i) => i.evidence_cluster?.cluster_id).filter(Boolean)
  ).size;

  const counts = {
    total:                final.length,
    evidence_items_total: allItems.length,
    critical_items:       itemCritical,
    high_items:           itemHigh,
    medium_items:         itemMedium,
    low_items:            itemLow,
    archive_items:        itemArchive,
    // Source-level priority buckets — used by synthesisLayer for status reporting
    must_read:    final.filter((s) => s.rawfact_score_data?.rawfact_priority === "must_read").length,
    high:         final.filter((s) => s.rawfact_score_data?.rawfact_priority === "high").length,
    medium:       final.filter((s) => s.rawfact_score_data?.rawfact_priority === "medium").length,
    low:          final.filter((s) => s.rawfact_score_data?.rawfact_priority === "low").length,
    archive_only: final.filter((s) => s.rawfact_score_data?.rawfact_priority === "archive_only").length,
    // evidence_cards count = sources that have at least one extracted item
    evidence_cards:           final.filter((s) => (s.evidence_items || []).length > 0).length,
    evidence_packs:           qaPacks.length,
    clusters:                 totalClusters,
    multi_source_clusters:    multiSourceClusters,
    // Second-model QA outcome (Step 8b)
    second_model_qa:          secondQaReport,
  };

  process.stdout.write(
    `[rawfact] Done — items: critical=${itemCritical} high=${itemHigh} medium=${itemMedium} ` +
    `low=${itemLow} archive=${itemArchive} | packs=${qaPacks.length} ` +
    `clusters=${totalClusters} (multi=${multiSourceClusters})\n`
  );

  // ── Optional debug output ─────────────────────────────────────────────────────
  if (saveTo) {
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(saveTo, { recursive: true });

    writeFileSync(
      `${saveTo}/rawfact_evidence_items.json`,
      JSON.stringify(
        final.map((s) => ({ id: s.id, title: s.title, evidence_items: s.evidence_items })),
        null, 2
      )
    );

    writeFileSync(
      `${saveTo}/rawfact_evidence_packs.json`,
      JSON.stringify(qaPacks, null, 2)
    );

    writeFileSync(
      `${saveTo}/rawfact_scored_sources.json`,
      JSON.stringify(
        final.map((s) => ({ id: s.id, title: s.title, rawfact_score_data: s.rawfact_score_data })),
        null, 2
      )
    );

    writeFileSync(
      `${saveTo}/rawfact_clusters.json`,
      JSON.stringify(
        final.map((s) => ({ id: s.id, title: s.title, rawfact_cluster: s.rawfact_cluster })),
        null, 2
      )
    );

    process.stdout.write(`[rawfact] Debug files written to ${saveTo}\n`);
  }

  return {
    rawfact_sources: final,
    evidence_packs:  qaPacks,
    taxonomy_rawfacts,
    ai_enabled_mappings,
    counts,
    rawfact_version: RAWFACT_VERSION,
  };
}
