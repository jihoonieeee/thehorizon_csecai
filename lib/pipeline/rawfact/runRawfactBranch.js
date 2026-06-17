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
import { judgeAllEvidence, runFocusedHighImpactReview }     from "./judgeEvidenceItems.js";
import { applyEvidenceFactQa }                              from "./evidenceFactQa.js";
import { applySourceIntentToSources }                       from "./sourceIntent.js";
import { scoreAllEvidenceItems, rescoreWithDuplicatePenalty } from "./scoreEvidenceItems.js";
import { clusterEvidenceItems }                             from "./clusterEvidenceItems.js";
import { runSecondModelEvidenceQa }                         from "./qaEvidenceLlm.js";
import { assembleEvidencePacks }                            from "./assembleEvidencePacks.js";
import { qaEvidenceItems }                                  from "./qaEvidenceItems.js";
import { strengthRank }                                     from "../evidenceTriage/evidenceTriageVocab.js";

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

    // Use strongest item's cluster as source-level cluster (categorical rank, no score)
    const bestItem = items.reduce((best, item) =>
      strengthRank(item.triage_data?.evidence_strength) > strengthRank(best?.triage_data?.evidence_strength) ? item : best
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
      const td = item.triage_data || {};
      const qv = item.quote_verification || {};
      taxonomy_rawfacts.push({
        rawfact_id:           item.evidence_id || `${source.id}_${taxonomy_rawfacts.length}`,
        source_id:            source.id,
        claim:                item.fact || null,   // fact only — display_label is never factual content
        supporting_quote:     item.source_quote || null,
        evidence_location:    item.evidence_location || item.location || null,
        primary_domain,
        primary_threat_tags,
        secondary_dimensions,
        taxonomy_confidence:  validation_status,
        validation_status,
        caveat_if_any:        (u.primary_threat_tags || []).map((t) => t.caveat_if_any).filter(Boolean)[0] || null,

        // Evidence-quality axis — persisted so packet quality is queryable in SQL,
        // not only inside the deck blob. Graceful: columns are added by 000_schema.sql
        // section 8; writeRows drops unknown columns rather than failing.
        evidence_type:        item.evidence_type || null,
        evidence_strength:    td.evidence_strength || null,
        admissibility:        td.admissibility || null,
        permitted_uses:       td.permitted_uses || null,
        limitations:          td.limitations || null,
        observed_use:         td.observed_use === true,
        materiality:          td.materiality || null,
        uniqueness:           td.uniqueness || null,
        quote_entailment:     qv.quote_entailment || null,
        claim_preservation:   qv.claim_preservation || null,
        method_quality:       item.method_quality || null,
        statistical_use:      item.statistical_use || null,
        origin_role:          item.origin_role || source.origin_role || null,
        independence_level:   item.independence_level || source.independence_level || null,
        primary_origin_url:   item.primary_origin_url || source.primary_origin_url || null,
        source_quality_status: source.source_quality_status || null,
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

  // ── Step 5b: LLM evidence judgement (feeds the deterministic triage) ──────────
  // One cheap per-source call supplies direct_demonstration / concrete_claim /
  // source_type_fit / observed_use / limitations. Graceful no-op when skipLlm or
  // no provider — the triage then falls back to deterministic inference.
  process.stdout.write("[L5A-rawfacts] step 5b/10 — LLM evidence judgement\n");
  const { sources: withJudged, judged_sources, judged_items } =
    await judgeAllEvidence(withItems, { skipLlm, concurrency });
  process.stdout.write(`            judged_sources=${judged_sources} judged_items=${judged_items}\n`);

  // ── Step 5c: Source intent classification (deterministic) ─────────────────────
  // Classifies source intent (vendor_marketing, primary_research, etc.) and
  // evidence posture (tone/evidence mismatch). Used by evidenceFactQa and triage.
  process.stdout.write("[L5A-rawfacts] step 5c/10 — source intent classification\n");
  const withSourceIntent = applySourceIntentToSources(withJudged);

  // ── Step 5d: Evidence Fact QA (deterministic, after judgement) ────────────────
  // Classifies each item's support_level, detects over-interpretation,
  // derives blocked_uses, and sets corrected_fact_text.
  process.stdout.write("[L5A-rawfacts] step 5d/10 — evidence fact QA\n");
  const withFactQa = applyEvidenceFactQa(withSourceIntent);
  const factQaItems = withFactQa.flatMap((s) => s.evidence_items || []);
  const unsupportedCount = factQaItems.filter((i) => i.fact_qa?.support_level === "unsupported").length;
  const overInterpretedCount = factQaItems.filter((i) => i.fact_qa?.over_interpreted).length;
  process.stdout.write(`            fact_qa: unsupported=${unsupportedCount} over_interpreted=${overInterpretedCount}\n`);

  // ── Step 5e: Focused high-impact evidence review (Item 4) ─────────────────────
  // High-impact source types (incident/threat_intel/exploit/adversary_adoption) that
  // lack semantic judgment for load-bearing fields get a targeted focused call.
  // This ensures adoption/trend/strategic claim gates have reliable signal.
  process.stdout.write("[L5A-rawfacts] step 5e/10 — focused high-impact evidence review\n");
  const { sources: withFocusedReview, reviewed_items: focusedReviewCount } =
    await runFocusedHighImpactReview(withFactQa, { skipLlm, concurrency });
  process.stdout.write(`            focused_reviewed=${focusedReviewCount}\n`);

  // ── Step 6: Initial scoring ───────────────────────────────────────────────────
  process.stdout.write("[L5A-rawfacts] step  6/10 — initial scoring\n");
  const withScores   = scoreAllEvidenceItems(withFocusedReview);

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

  // Triage-based item counts (the only importance model — strong/usable/context/archive)
  const itemStrong  = allItems.filter((i) => i.triage_data?.evidence_strength === "strong").length;
  const itemUsable  = allItems.filter((i) => i.triage_data?.evidence_strength === "usable").length;
  const itemContext = allItems.filter((i) => i.triage_data?.evidence_strength === "context").length;
  const itemArchive = allItems.filter((i) => i.triage_data?.evidence_strength === "archive").length;

  const sourceStrongest = (s) => s.rawfact_evidence_summary?.strongest_strength || "archive";

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
    // Triage-based item counts (strong/usable/context/archive)
    strong_items:   itemStrong,
    usable_items:   itemUsable,
    context_items:  itemContext,
    archive_items:  itemArchive,
    // Source-level buckets by strongest evidence strength (status reporting only)
    sources_strong:  final.filter((s) => sourceStrongest(s) === "strong").length,
    sources_usable:  final.filter((s) => sourceStrongest(s) === "usable").length,
    sources_context: final.filter((s) => sourceStrongest(s) === "context").length,
    sources_archive: final.filter((s) => sourceStrongest(s) === "archive").length,
    sources_with_evidence: final.filter((s) => (s.evidence_items || []).length > 0).length,
    evidence_packs:        qaPacks.length,
    clusters:              totalClusters,
    multi_source_clusters: multiSourceClusters,
    second_model_qa:       secondQaReport,
  };

  process.stdout.write(
    `[rawfact] Done — triage: strong=${itemStrong} usable=${itemUsable} context=${itemContext} ` +
    `archive=${itemArchive} | packs=${qaPacks.length} ` +
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
        final.map((s) => ({ id: s.id, title: s.title, rawfact_evidence_summary: s.rawfact_evidence_summary })),
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
