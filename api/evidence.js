/**
 * GET /api/evidence
 *
 * Returns flattened EvidencePacket items from the latest deck blob for the
 * Evidence Explorer dashboard page. Items include full provenance: source_id,
 * url, publisher, title, and visual_refs with their source_url / source_evidence_id.
 *
 * Query params:
 *   category  — filter to one of the four threat categories
 *   strength  — filter by evidence_strength (strong | usable | context | archive)
 *   layer     — filter by extraction_layer (L5A | L5B | L5C)
 *   q         — keyword search across fact / source_title / publisher
 *   limit     — max items to return (default 200)
 */

import { loadLatestDeck } from "../lib/storage/deckStore.js";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Flatten a canonical EvidencePacket (nested provenance) into a UI-ready shape.
 * Also handles flat legacy shapes that already have url/title at root.
 */
function flattenPacket(packet) {
  const prov = packet.provenance || {};
  const cr   = packet.claim_relevance || {};
  const cont = packet.content || {};

  return {
    evidence_id:      packet.evidence_id,
    branch_type:      packet.branch_type || (packet.provenance?.extraction_layer === "L5B" ? "analytics"
                        : packet.provenance?.extraction_layer === "L5C" ? "web_enrichment" : "rawfact"),
    enrichment:       packet.enrichment === true,
    source_id:        packet.source_id || prov.source_id || null,
    evidence_type:    packet.evidence_type || "",
    evidence_class:   packet.evidence_class || "",
    evidence_strength:cr.evidence_strength || packet.evidence_strength || "archive",
    admissibility:    cr.admissibility     || "failed",
    permitted_uses:   cr.permitted_uses    || [],
    limitations:      cr.limitations       || [],
    // Significance axis (separate from reliability) — read from either packet shape.
    materiality:      cr.materiality || packet.triage_data?.materiality || packet.materiality || null,
    uniqueness:       cr.uniqueness  || packet.triage_data?.uniqueness  || packet.uniqueness  || null,
    // Quality axis (now carried on the canonical packet)
    source_quality:   packet.source_quality || null,
    independence:     packet.independence   || null,
    grounding:        packet.grounding      || null,
    method:           packet.method         || null,
    category:         packet.category      || null,
    taxonomy_tags:    packet.taxonomy_tags || [],

    // Analytics chart-safety metadata (present on L5B packets)
    analytics_meta:   packet.analytics_meta || null,

    // Provenance — flat for UI consumption
    title:            prov.title     || packet.title     || "",
    publisher:        prov.publisher || packet.publisher || "",
    url:              prov.url       || packet.url       || null,
    published_at:     prov.published_at || packet.date_published || null,
    extraction_layer: prov.extraction_layer || packet.extraction_layer || null,
    connector:        prov.connector || null,

    // Content
    fact:             cont.normalized_fact || packet.fact || cont.summary || "",
    source_quote:     cont.quoted_text     || packet.source_quote || "",
    numbers:          cont.numbers         || packet.numbers  || [],
    entities:         cont.entities        || packet.entities || [],

    // Metrics
    metrics: packet.metrics || [],

    // Visual refs — with source_evidence_id and source_url for full traceability
    visual_refs: (packet.visual_refs || []).map((v) => ({
      visual_id:             v.visual_id,
      type:                  v.type,
      source_evidence_id:    v.source_evidence_id || null,
      source_url:            v.source_url || null,
      visual_url:            v.visual_url || v.image_url || null,
      caption:               v.caption || v.what_it_shows || "",
      allowed_slide_use:     v.allowed_slide_use ?? false,
      usage_rights_status:   v.usage_rights_status || "unknown",
      manual_review_required:v.manual_review_required ?? false,
    })),

    quality_flags: packet.quality_flags || [],
  };
}

/**
 * Extract all EvidencePackets from the synthesis blob.
 * Covers L5A dossier items, L5B analytics, L5C external, and evidence_inventory.
 */
function extractPackets(synthesis) {
  const seen   = new Set();
  const result = [];

  function addPacket(packet, layerHint, classHint) {
    if (!packet?.evidence_id) return;
    if (seen.has(packet.evidence_id)) return;
    seen.add(packet.evidence_id);
    result.push(flattenPacket({
      ...packet,
      extraction_layer: packet.extraction_layer || packet.provenance?.extraction_layer || layerHint || null,
      evidence_class:   packet.evidence_class || classHint || null,
    }));
  }

  // Fused dossiers (primary source)
  for (const dossier of (synthesis?.fused_dossiers || [])) {
    const rf = dossier.rawfact || {};
    for (const item of [
      ...(rf.strong_evidence        || []),
      ...(rf.usable_evidence        || []),
      ...(rf.case_study_candidates  || []),
      ...(rf.statistics             || []),
    ]) addPacket(item, "L5A", "research");

    for (const item of (dossier.rawfact_evidence  || [])) addPacket(item, "L5A", "research");
    for (const item of (dossier.external_evidence || [])) addPacket(item, "L5C", "external");
  }

  // Top-level evidence inventory
  for (const item of (synthesis?.evidence_inventory || [])) addPacket(item, null, null);

  return result;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { category, strength, layer, q, limit = "200" } = req.query || {};
  const maxItems = Math.min(parseInt(limit, 10) || 200, 500);

  try {
    const deck = await loadLatestDeck();
    if (!deck?.blob_path) {
      return res.status(200).json({ items: [], total: 0, source: "no_deck" });
    }

    const payload = await fetchJson(deck.blob_path);
    const synth   = payload?.synthesis;
    if (!synth) {
      return res.status(200).json({ items: [], total: 0, source: "no_synthesis" });
    }

    let items = extractPackets(synth);

    if (category) items = items.filter((e) => e.category === category);
    if (strength)  items = items.filter((e) => e.evidence_strength === strength);
    if (layer)     items = items.filter((e) => e.extraction_layer === layer);
    if (q) {
      const kw = q.toLowerCase();
      items = items.filter((e) =>
        (e.fact         || "").toLowerCase().includes(kw) ||
        (e.title        || "").toLowerCase().includes(kw) ||
        (e.publisher    || "").toLowerCase().includes(kw) ||
        (e.entities     || []).some((en) => en.toLowerCase().includes(kw))
      );
    }

    const STRENGTH_ORDER = { strong: 0, usable: 1, context: 2, archive: 3 };
    items.sort((a, b) =>
      (STRENGTH_ORDER[a.evidence_strength] ?? 3) - (STRENGTH_ORDER[b.evidence_strength] ?? 3)
    );

    return res.status(200).json({
      items:    items.slice(0, maxItems),
      total:    items.length,
      deck_id:  deck.deck_id,
      generated_at: deck.generated_at,
      source:   "deck_blob",
    });
  } catch (err) {
    console.error("[evidence] handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
