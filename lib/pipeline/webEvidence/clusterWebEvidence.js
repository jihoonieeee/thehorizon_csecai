/**
 * Layer 5C.9 — Cluster + dedupe text web evidence.
 *
 * Clusters by canonical/original URL, title similarity, claim similarity, quote
 * fingerprint, and entity overlap. Keeps the highest-lineage / highest-depth
 * representative; non-representatives are archived with a duplicate_reason +
 * representative_id (nothing is dropped).
 */

import { randomUUID } from "crypto";
import { canonicalUrlKey } from "./webEvidenceSchemas.js";
import { extractEntities } from "../discovery/candidateGates.js";

const DEPTH_RANK = { walkthrough_grade: 4, detailed: 3, concrete: 2, thin: 1 };
const LINEAGE_RANK = { original: 3, derivative_with_value: 2, derivative_archive_only: 1, unknown: 0 };

function tokens(s) { return new Set((String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])); }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); }
function quoteFp(ev) { const q = (ev.source_grounding?.verbatim_quotes || [])[0] || ""; return (q.toLowerCase().match(/[a-z0-9]{4,}/g) || []).slice(0, 20).join(" "); }
function entitiesOf(ev) {
  return new Set(extractEntities(`${ev.concrete_claim} ${(ev.source_grounding?.verbatim_quotes || []).join(" ")}`).all.map((e) => e.toLowerCase()));
}

function sameCluster(a, b) {
  const aUrl = canonicalUrlKey(a.source_grounding?.source_url || "");
  const bUrl = canonicalUrlKey(b.source_grounding?.source_url || "");
  if (aUrl && aUrl === bUrl) return true;
  const aOrig = canonicalUrlKey(a.source_lineage?.original_source_url || "");
  const bOrig = canonicalUrlKey(b.source_lineage?.original_source_url || "");
  if (aOrig && (aOrig === bOrig || aOrig === bUrl || bOrig === aUrl)) return true;
  if (a.title || b.title) { /* titles live in source_grounding */ }
  const titleSim = jaccard(tokens(a.source_grounding?.title), tokens(b.source_grounding?.title));
  if (titleSim >= 0.6) return true;
  const claimSim = jaccard(tokens(a.concrete_claim), tokens(b.concrete_claim));
  if (claimSim >= 0.6) return true;
  const fpA = quoteFp(a), fpB = quoteFp(b);
  if (fpA && fpA === fpB) return true;
  const entSim = jaccard(entitiesOf(a), entitiesOf(b));
  if (entSim >= 0.5 && claimSim >= 0.35) return true;
  return false;
}

function repRank(ev) {
  return (LINEAGE_RANK[ev.source_lineage?.source_lineage_status] || 0) * 100 +
    (DEPTH_RANK[ev.evidence_depth] || 0) * 10 +
    ((ev.source_grounding?.verbatim_quotes || []).length ? 3 : 0) +
    (ev.confidence === "high" ? 2 : ev.confidence === "medium" ? 1 : 0);
}

export function clusterWebEvidence(items = []) {
  const arr = items.map((e) => ({ ...e }));
  const clusters = [];
  for (const item of arr) {
    const c = clusters.find((cl) => cl.some((m) => sameCluster(m, item)));
    if (c) c.push(item); else clusters.push([item]);
  }
  for (const cluster of clusters) {
    const id = `wec_${randomUUID().slice(0, 8)}`;
    cluster.sort((a, b) => repRank(b) - repRank(a));
    const rep = cluster[0];
    rep.duplicate_cluster_id = id; rep.is_cluster_representative = true; rep.duplicate_reason = null; rep.representative_id = rep.web_evidence_id;
    for (const m of cluster.slice(1)) {
      m.duplicate_cluster_id = id;
      m.is_cluster_representative = false;
      m.representative_id = rep.web_evidence_id;
      m.duplicate_reason = m.source_lineage?.source_lineage_status === "derivative_archive_only"
        ? "derivative_archive_only" : "duplicate_of_representative";
    }
  }
  return arr;
}
