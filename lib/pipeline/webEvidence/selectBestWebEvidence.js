/**
 * Layer 5C.10 — Select best evidence (categorical, no numeric scores).
 *
 * Priority: walkthrough_grade > detailed > concrete. Then prefer original over
 * derivative, recent operational over old context, quote+visual-backed over
 * quote-only, high-trust over low-trust, named systems/actors/vulns over generic.
 * Caps per category. Each selected item records a selection_reason.
 */

import { DEPTH_ALLOWED_IN_ANALYSIS } from "./webEvidenceSchemas.js";

const DEPTH_RANK = { walkthrough_grade: 3, detailed: 2, concrete: 1, thin: 0 };
const LINEAGE_RANK = { original: 2, derivative_with_value: 1, derivative_archive_only: 0, unknown: 0 };

const PRIMARY_DOMAINS = ["cisa.gov", "ncsc.gov.uk", "nist.gov", "anthropic.com", "openai.com", "owasp.org", "atlas.mitre.org", "nvd.nist.gov"];
const HIGH_DOMAINS = ["arxiv.org", "usenix.org", "ieee.org", "acm.org", "mandiant.com", "crowdstrike.com", "paloaltonetworks.com", "trailofbits.com"];

function trustRank(url) {
  const u = String(url || "").toLowerCase();
  if (PRIMARY_DOMAINS.some((d) => u.includes(d))) return 2;
  if (HIGH_DOMAINS.some((d) => u.includes(d))) return 1;
  return 0;
}
function isRecent(ev, days = 180) {
  const d = ev.source_grounding?.published_date;
  if (!d) return false;
  const t = new Date(d).getTime();
  return Number.isFinite(t) && (Date.now() - t) <= days * 86400000;
}
function isNamed(ev) {
  const od = ev.operational_details || {};
  return !!(od.affected_system || od.technique || od.actor ||
    (od.tools_or_models || []).length || (od.vulnerabilities_or_weaknesses || []).length);
}

function compare(a, b, visualBackedIds) {
  const da = DEPTH_RANK[a.evidence_depth] || 0, db = DEPTH_RANK[b.evidence_depth] || 0;
  if (db !== da) return db - da;
  const la = LINEAGE_RANK[a.source_lineage?.source_lineage_status] || 0, lb = LINEAGE_RANK[b.source_lineage?.source_lineage_status] || 0;
  if (lb !== la) return lb - la;
  const ra = isRecent(a) ? 1 : 0, rb = isRecent(b) ? 1 : 0;
  if (rb !== ra) return rb - ra;
  const va = visualBackedIds.has(a.web_evidence_id) ? 1 : 0, vb = visualBackedIds.has(b.web_evidence_id) ? 1 : 0;
  if (vb !== va) return vb - va;
  const ta = trustRank(a.source_grounding?.source_url), tb = trustRank(b.source_grounding?.source_url);
  if (tb !== ta) return tb - ta;
  const na = isNamed(a) ? 1 : 0, nb = isNamed(b) ? 1 : 0;
  return nb - na;
}

function reasonFor(ev, visualBacked) {
  const bits = [`depth=${ev.evidence_depth}`];
  if (ev.source_lineage?.source_lineage_status === "original") bits.push("original source");
  if (isRecent(ev)) bits.push("recent");
  if (visualBacked) bits.push("visual-backed");
  if (trustRank(ev.source_grounding?.source_url) >= 1) bits.push("high-trust");
  if (isNamed(ev)) bits.push("named system/actor/vuln");
  return bits.join("; ");
}

/**
 * @param {object[]} items  validated, clustered web evidence
 * @param {object} [opts]   { maxPerCategory=5, visualEvidence=[] }
 * @returns {{ selected, not_selected }}
 */
export function selectBestWebEvidence(items = [], opts = {}) {
  const maxPerCategory = opts.maxPerCategory ?? 5;
  const visualBackedIds = new Set();
  for (const v of opts.visualEvidence || []) for (const id of (v.supports_evidence_ids || [])) visualBackedIds.add(id);

  // Only representatives that passed validation into the analysis bands.
  const eligible = items.filter((e) =>
    e.is_cluster_representative !== false &&
    e.validation_status !== "rejected" &&
    e.qa_status !== "rejected" &&
    DEPTH_ALLOWED_IN_ANALYSIS.has(e.evidence_depth));

  const byCat = {};
  for (const e of eligible) (byCat[e.category || "_"] ||= []).push(e);

  const selected = [];
  const selectedIds = new Set();
  for (const [, list] of Object.entries(byCat)) {
    list.sort((a, b) => compare(a, b, visualBackedIds));
    for (const e of list.slice(0, maxPerCategory)) {
      e.selection_reason = reasonFor(e, visualBackedIds.has(e.web_evidence_id));
      selected.push(e);
      selectedIds.add(e.web_evidence_id);
    }
  }
  const not_selected = items.filter((e) => !selectedIds.has(e.web_evidence_id));
  return { selected, not_selected };
}
