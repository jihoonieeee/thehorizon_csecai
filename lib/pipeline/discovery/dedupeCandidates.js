/**
 * Web Discovery — Duplicate Clustering (Layer 1C)
 *
 * Many discovered candidates repeat one underlying report (vendor press release
 * syndicated across outlets, news coverage of one research paper, etc.). We
 * cluster them and keep:
 *   - the original report (highest independence + trust)
 *   - the best technical explanation if it ADDS detail
 *   - the best visual/data source if it ADDS a chart/table/diagram
 * and archive the rest as derivative.
 *
 * Deterministic. Clustering keys: normalized URL host+path, title similarity,
 * quote similarity, and entity overlap.
 *
 * Each candidate gets:
 *   duplicate_cluster_id, is_cluster_representative, duplicate_reason,
 *   original_source_url, derivative_sources[], source_independence_status
 */

import { randomUUID } from "crypto";
import { normalizeUrlForGrounding } from "./candidateGates.js";

const QUALITY_RANK = { primary: 4, high: 3, medium: 2, low: 1 };

function titleTokens(title = "") {
  return new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function quoteFingerprint(quote = "") {
  return (quote.toLowerCase().match(/[a-z0-9]{4,}/g) || []).slice(0, 20).join(" ");
}

/**
 * Determine whether two candidates belong to the same cluster.
 */
function sameCluster(a, b) {
  // Exact same page.
  if (normalizeUrlForGrounding(a.opened_url) === normalizeUrlForGrounding(b.opened_url)) return true;

  // Strong title overlap → same story.
  const titleSim = jaccard(titleTokens(a.title), titleTokens(b.title));
  if (titleSim >= 0.6) return true;

  // Same verbatim quote (syndicated repost).
  if (a.verbatim_quote && b.verbatim_quote &&
      quoteFingerprint(a.verbatim_quote) === quoteFingerprint(b.verbatim_quote)) return true;

  // Same named entities + moderate title overlap (coverage of one report).
  const aEnt = new Set((a.entities?.all || []).map((e) => e.toLowerCase()));
  const bEnt = new Set((b.entities?.all || []).map((e) => e.toLowerCase()));
  const entOverlap = jaccard(aEnt, bEnt);
  if (entOverlap >= 0.5 && titleSim >= 0.35 && aEnt.size > 0) return true;

  return false;
}

/**
 * Score a candidate's suitability as the cluster representative.
 * Higher = better. Prefers original primary/high-trust sources with richer
 * technical detail. (This is a tie-break ordering, not an evidence score that
 * leaves the module.)
 */
function representativeRank(c) {
  let rank = (QUALITY_RANK[c.source_quality] || 1) * 100;
  // Prefer primary/standards/research over news.
  if (["government_advisory", "standards_or_framework", "vulnerability_database"].includes(c.source_class)) rank += 60;
  if (["research_paper", "conference_paper", "vendor_research"].includes(c.source_class)) rank += 40;
  if (c.source_class === "news_report") rank -= 40;
  // Reward technical detail and data.
  rank += Math.min(40, Math.floor((c.candidate_claim?.length || 0) / 20));
  rank += Math.min(30, Math.floor((c.verbatim_quote?.length || 0) / 20));
  if (c.quote_status === "present") rank += 20;
  if (c.opened_url_confirmed) rank += 20;
  return rank;
}

/**
 * Decide independence status for non-representative members.
 * - syndicated : identical quote fingerprint as the representative (reposted)
 * - derivative : same story/entities but distinct text (coverage of the original)
 */
function independenceOf(member, representative) {
  if (member.verbatim_quote && representative.verbatim_quote &&
      quoteFingerprint(member.verbatim_quote) === quoteFingerprint(representative.verbatim_quote)) {
    return "syndicated";
  }
  return "derivative";
}

/**
 * Does a non-representative member add unique technical detail or data worth
 * keeping as a secondary representative? (better explanation / has a chart)
 */
function addsUniqueValue(member, representative) {
  const memberHasData = /\b\d+(?:\.\d+)?%|\btable\b|\bchart\b|\bfigure\b|\bbenchmark\b|\bdataset\b/i.test(
    `${member.candidate_claim} ${member.verbatim_quote} ${member.summary || ""}`
  );
  const repHasData = /\b\d+(?:\.\d+)?%|\btable\b|\bchart\b|\bfigure\b/i.test(
    `${representative.candidate_claim} ${representative.verbatim_quote}`
  );
  if (memberHasData && !repHasData) return true;
  // Substantially longer technical explanation.
  const memberLen = (member.candidate_claim?.length || 0) + (member.verbatim_quote?.length || 0);
  const repLen = (representative.candidate_claim?.length || 0) + (representative.verbatim_quote?.length || 0);
  return memberLen > repLen * 1.5 && member.source_class !== "news_report";
}

/**
 * Cluster + annotate candidates.
 * @param {object[]} candidates
 * @returns {object[]} same candidates, mutated copies with dedup fields set
 */
export function dedupeCandidates(candidates = []) {
  const items = candidates.map((c) => ({ ...c }));
  const clusters = [];

  for (const item of items) {
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.some((m) => sameCluster(m, item))) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }

  for (const cluster of clusters) {
    const clusterId = `dc_${randomUUID().slice(0, 8)}`;
    cluster.sort((a, b) => representativeRank(b) - representativeRank(a));
    const rep = cluster[0];

    rep.duplicate_cluster_id = clusterId;
    rep.is_cluster_representative = true;
    rep.duplicate_reason = null;
    rep.original_source_url = rep.opened_url;
    rep.source_independence_status = "original";
    rep.derivative_sources = cluster.slice(1).map((m) => m.opened_url);

    for (const member of cluster.slice(1)) {
      member.duplicate_cluster_id = clusterId;
      member.original_source_url = rep.opened_url;
      const independence = independenceOf(member, rep);
      member.source_independence_status = independence;

      if (addsUniqueValue(member, rep)) {
        // Keep as a secondary representative (adds technical detail / data).
        member.is_cluster_representative = true;
        member.duplicate_reason = "retained_adds_unique_detail";
      } else {
        member.is_cluster_representative = false;
        member.duplicate_reason = independence === "syndicated"
          ? "syndicated_repost_of_original"
          : "derivative_coverage_of_original";
      }
    }

    // Corroboration: when a cluster has ≥2 RETAINED representatives that are not
    // mere syndicated reposts, the technique is described by independent sources.
    const retainedReps = cluster.filter((m) => m.is_cluster_representative &&
      m.source_independence_status !== "syndicated");
    const corroboration = retainedReps.length >= 2 ? "independent_sources" : "single_source";
    for (const m of cluster) {
      // Only upgrade corroboration for retained representatives; non-reps keep their own.
      if (m.is_cluster_representative) m.corroboration_status = corroboration;
    }
  }

  return items;
}
