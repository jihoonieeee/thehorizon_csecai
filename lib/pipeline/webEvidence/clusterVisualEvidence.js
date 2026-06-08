/**
 * Layer 5C.9b — Cluster + dedupe visual evidence.
 *
 * Clusters by image hash, source URL, caption similarity, visual-claim similarity,
 * and linked evidence ID. Keeps the clearest / highest-usefulness representative;
 * non-representatives are archived with a duplicate_reason + representative_id.
 */

import { randomUUID } from "crypto";
import { canonicalUrlKey } from "./webEvidenceSchemas.js";

const USEFULNESS_RANK = { high: 3, medium: 2, low: 1, not_useful: 0 };
const CAPTURE_RANK = { direct_image: 4, html_table_extract: 4, pdf_table_extract: 3, pdf_page_screenshot: 2, page_screenshot: 2, manual_review: 1 };

function tokens(s) { return new Set((String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])); }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); }

// Conservative: only merge visuals that are genuinely the SAME image/figure.
// Two distinct visuals on one page (e.g. a diagram + a table) must NOT cluster
// just because they share a source page or a linked evidence id.
function sameCluster(a, b) {
  if (a.image_hash && b.image_hash && a.image_hash === b.image_hash) return true;
  if (a.visual_url && b.visual_url && canonicalUrlKey(a.visual_url) === canonicalUrlKey(b.visual_url)) return true;
  // Different visual kinds are never the same visual.
  if (a.visual_kind !== b.visual_kind) return false;
  const capSim = jaccard(tokens(a.caption_or_nearby_text), tokens(b.caption_or_nearby_text));
  const sameSource = canonicalUrlKey(a.source_url) === canonicalUrlKey(b.source_url);
  // Same page + near-identical caption → same figure; or identical caption across mirrors.
  if (sameSource && capSim >= 0.75) return true;
  if (capSim >= 0.85) return true;
  return false;
}

function repRank(v) {
  return (USEFULNESS_RANK[v.visual_usefulness?.level] || 0) * 100 +
    (CAPTURE_RANK[v.capture_method] || 0) * 10 +
    (v.visual_quality?.data_extractable ? 3 : 0) +
    (v.visual_quality?.has_axis_or_labels ? 1 : 0);
}

export function clusterVisualEvidence(items = []) {
  const arr = items.map((v) => ({ ...v }));
  const clusters = [];
  for (const item of arr) {
    const c = clusters.find((cl) => cl.some((m) => sameCluster(m, item)));
    if (c) c.push(item); else clusters.push([item]);
  }
  for (const cluster of clusters) {
    const id = `vec_${randomUUID().slice(0, 8)}`;
    cluster.sort((a, b) => repRank(b) - repRank(a));
    const rep = cluster[0];
    rep.duplicate_cluster_id = id; rep.is_cluster_representative = true; rep.duplicate_reason = null; rep.representative_id = rep.visual_evidence_id;
    for (const m of cluster.slice(1)) {
      m.duplicate_cluster_id = id;
      m.is_cluster_representative = false;
      m.representative_id = rep.visual_evidence_id;
      m.duplicate_reason = "duplicate_visual_of_representative";
    }
  }
  return arr;
}
