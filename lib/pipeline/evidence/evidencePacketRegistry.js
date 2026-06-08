/**
 * EvidencePacketRegistry
 *
 * In-memory store of all EvidencePackets produced by L5A/B/C in a single pipeline run.
 * Enables:
 *   - ID resolution: slide → evidence_id → EvidencePacket → provenance
 *   - Traceability validation: detect broken links before slides are rendered
 *   - Claim writeback: track which claims reference which packets
 *   - Backtracking: slide_element → claim_id → evidence_packet → source URL
 *
 * Usage:
 *   const registry = new EvidencePacketRegistry();
 *   registry.register(normalizedPackets);
 *   registry.validateIds(["ev_abc", "metric_xyz"]); // → { valid, missing }
 *   registry.writeBackClaimIds(claimChainResult);   // mutates packets in place
 */

import { canSupportClaim } from "../../schemas/evidencePacketSchema.js";

export class EvidencePacketRegistry {
  constructor() {
    this._packets   = new Map();   // evidence_id → EvidencePacket
    this._visuals   = new Map();   // visual_id   → VisualRef
    this._byCategory = new Map();  // category    → Set<evidence_id>
    this._byLayer   = new Map();   // L5A/B/C     → Set<evidence_id>
    this._claimIndex = new Map();  // claim_id    → Set<evidence_id>
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register one or more EvidencePackets.
   * @param {object|object[]} packets
   */
  register(packets) {
    const arr = Array.isArray(packets) ? packets : [packets];
    for (const p of arr) {
      if (!p?.evidence_id) continue;
      this._packets.set(p.evidence_id, p);

      if (p.category) {
        if (!this._byCategory.has(p.category)) this._byCategory.set(p.category, new Set());
        this._byCategory.get(p.category).add(p.evidence_id);
      }

      const layer = p.provenance?.extraction_layer || "unknown";
      if (!this._byLayer.has(layer)) this._byLayer.set(layer, new Set());
      this._byLayer.get(layer).add(p.evidence_id);

      // Register visual refs from this packet
      for (const vr of (p.visual_refs || [])) {
        if (vr?.visual_id) this._visuals.set(vr.visual_id, vr);
      }
    }
    return this;
  }

  /**
   * Register standalone VisualRefs (e.g. from L5C visual evidence).
   */
  registerVisuals(visuals) {
    for (const v of (Array.isArray(visuals) ? visuals : [visuals])) {
      if (v?.visual_id) this._visuals.set(v.visual_id, v);
    }
    return this;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * Resolve one evidence_id → EvidencePacket. Returns null if not found.
   */
  resolve(evidenceId) {
    return this._packets.get(evidenceId) || null;
  }

  /**
   * Resolve multiple IDs → array of (packet | null) preserving order.
   */
  resolveAll(evidenceIds = []) {
    return evidenceIds.map((id) => this._packets.get(id) || null);
  }

  resolveVisual(visualId) {
    return this._visuals.get(visualId) || null;
  }

  getByCategory(category) {
    const ids = this._byCategory.get(category) || new Set();
    return [...ids].map((id) => this._packets.get(id)).filter(Boolean);
  }

  getByLayer(layer) {
    const ids = this._byLayer.get(layer) || new Set();
    return [...ids].map((id) => this._packets.get(id)).filter(Boolean);
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  /**
   * Validate that a list of evidence IDs all resolve to registered packets.
   * @param {string[]} ids
   * @returns {{ valid: boolean, missing: string[] }}
   */
  validateIds(ids = []) {
    const missing = ids.filter((id) => id && !this._packets.has(id));
    return { valid: missing.length === 0, missing };
  }

  /**
   * Validate that a list of visual IDs all resolve.
   */
  validateVisualIds(ids = []) {
    const missing = ids.filter((id) => id && !this._visuals.has(id));
    return { valid: missing.length === 0, missing };
  }

  /**
   * Validate that every claim has at least one supporting packet that can support a claim.
   * @param {object[]} claims - claim objects with { claim_id, supporting_evidence_ids[] }
   * @returns {{ valid: boolean, unsupported_claim_ids: string[] }}
   */
  validateClaimSupport(claims = []) {
    const unsupported = [];
    for (const claim of claims) {
      const ids = claim.supporting_evidence_ids || [];
      const hasSupport = ids.some((id) => {
        const p = this._packets.get(id);
        return p && canSupportClaim(p);
      });
      if (!hasSupport) unsupported.push(claim.claim_id);
    }
    return { valid: unsupported.length === 0, unsupported_claim_ids: unsupported };
  }

  /**
   * Full traceability validation: checks evidence IDs, visual provenance, analytics lineage.
   * @param {object[]} allIds   - all evidence_ids referenced in slides or claims
   * @param {object[]} visualIds - all visual_ids referenced in slides
   * @returns {{ valid, errors[], warnings[] }}
   */
  validateTraceability(allIds = [], visualIds = []) {
    const errors = [];
    const warnings = [];

    // Check evidence ID resolution
    const { missing } = this.validateIds(allIds);
    for (const id of missing) {
      errors.push(`Unresolved evidence_id: ${id} — no EvidencePacket registered`);
    }

    // Check visual ID resolution and provenance
    for (const vizId of visualIds) {
      const vr = this._visuals.get(vizId);
      if (!vr) {
        errors.push(`Unresolved visual_id: ${vizId} — no VisualRef registered`);
        continue;
      }
      if (!vr.source_evidence_id && (!vr.generated_from_metric_ids?.length)) {
        errors.push(`Visual ${vizId} has no source_evidence_id or generated_from_metric_ids`);
      }
      if (vr.type === "external_figure" && !vr.source_url) {
        errors.push(`Visual ${vizId} is external_figure but has no source_url`);
      }
      if (vr.allowed_slide_use && vr.manual_review_required) {
        warnings.push(`Visual ${vizId} marked allowed_slide_use but manual_review_required`);
      }
    }

    // Check analytics packets have computation_method
    for (const [id, p] of this._packets) {
      if (p.provenance?.extraction_layer === "L5B") {
        if (!p.provenance?.computation_method) {
          errors.push(`Analytics packet ${id} missing computation_method`);
        }
        if (!Array.isArray(p.provenance?.input_evidence_ids)) {
          errors.push(`Analytics packet ${id} missing input_evidence_ids`);
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Claim writeback ──────────────────────────────────────────────────────────

  /**
   * Write back claim_ids onto the packets they reference.
   * Call after claim chain / analyzeCategory has produced claims.
   *
   * @param {object[]} claims - array of { claim_id, supporting_evidence_ids[] }
   */
  writeBackClaimIds(claims = []) {
    for (const claim of claims) {
      const ids = claim.supporting_evidence_ids || [];
      if (!this._claimIndex.has(claim.claim_id)) {
        this._claimIndex.set(claim.claim_id, new Set());
      }
      for (const id of ids) {
        this._claimIndex.get(claim.claim_id).add(id);
        const p = this._packets.get(id);
        if (p) {
          if (!Array.isArray(p.linked_claim_ids)) p.linked_claim_ids = [];
          if (!p.linked_claim_ids.includes(claim.claim_id)) {
            p.linked_claim_ids.push(claim.claim_id);
          }
        }
      }
    }
    return this;
  }

  // ── Backtracking ────────────────────────────────────────────────────────────

  /**
   * Backtrack from a slide element to full provenance chain.
   *
   * @param {string} evidenceId
   * @returns {{ evidence_id, claim_ids, provenance, content_summary, quality_flags }}
   */
  backtrack(evidenceId) {
    const p = this._packets.get(evidenceId);
    if (!p) return { evidence_id: evidenceId, found: false, error: "not_in_registry" };

    return {
      evidence_id:    p.evidence_id,
      found:          true,
      claim_ids:      p.linked_claim_ids || [],
      layer:          p.provenance?.extraction_layer,
      provenance: {
        title:        p.provenance?.title,
        publisher:    p.provenance?.publisher,
        url:          p.provenance?.url,
        published_at: p.provenance?.published_at,
        extraction_layer: p.provenance?.extraction_layer,
        // L5B only
        input_evidence_ids: p.provenance?.input_evidence_ids,
        computation_method: p.provenance?.computation_method,
      },
      content_summary: p.content?.normalized_fact || p.content?.summary || "",
      strength:       p.claim_relevance?.evidence_strength,
      admissibility:  p.claim_relevance?.admissibility,
      quality_flags:  p.quality_flags || [],
    };
  }

  // ── Serialization ────────────────────────────────────────────────────────────

  asMap()  { return new Map(this._packets); }
  asList() { return [...this._packets.values()]; }

  get size()       { return this._packets.size; }
  get visualCount(){ return this._visuals.size; }

  /**
   * Generate a summary of the registry contents.
   */
  summary() {
    const byLayer = {};
    for (const [layer, ids] of this._byLayer) byLayer[layer] = ids.size;
    const admissCounts = { passed: 0, context_only: 0, failed: 0 };
    for (const p of this._packets.values()) {
      const a = p.claim_relevance?.admissibility || "failed";
      admissCounts[a] = (admissCounts[a] || 0) + 1;
    }
    return {
      total_packets:   this._packets.size,
      total_visuals:   this._visuals.size,
      by_layer:        byLayer,
      admissibility:   admissCounts,
      categories:      [...this._byCategory.keys()],
    };
  }
}

/**
 * Factory: build a populated EvidencePacketRegistry from normalizeAllL5ToPackets output.
 *
 * @param {{ packets, visualRefs, byId }} registryData - from normalizeToPackets.buildPacketRegistry()
 * @returns {EvidencePacketRegistry}
 */
export function createRegistry(registryData) {
  const registry = new EvidencePacketRegistry();
  if (registryData?.packets) registry.register(registryData.packets);
  if (registryData?.visualRefs) registry.registerVisuals(registryData.visualRefs);
  return registry;
}
