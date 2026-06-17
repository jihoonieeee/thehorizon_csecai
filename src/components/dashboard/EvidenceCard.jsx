/**
 * EvidenceCard — displays a single evidence item with source quote,
 * validation badge, and taxonomy tags.
 */

import { StatusBadge } from "./StatusBadge.jsx";

/**
 * Flatten a canonical EvidencePacket (nested provenance/content/claim_relevance)
 * or pass-through a flat legacy shape.
 */
function flatten(item) {
  const prov = item.provenance || {};
  const cont = item.content    || {};
  const cr   = item.claim_relevance || {};
  return {
    evidence_id:      item.evidence_id,
    source_id:        item.source_id || prov.source_id || null,
    evidence_type:    item.evidence_type || "",
    evidence_strength:cr.evidence_strength || item.evidence_strength || "archive",
    admissibility:    cr.admissibility    || item.admissibility || null,
    category:         item.category       || null,
    title:            prov.title     || item.title     || "",
    publisher:        prov.publisher || item.publisher || "",
    url:              prov.url       || item.url       || null,
    published_at:     prov.published_at || item.date_published || item.published_at || null,
    extraction_layer: prov.extraction_layer || item.extraction_layer || null,
    fact:             cont.normalized_fact || item.fact || cont.summary || "",
    source_quote:     cont.quoted_text     || item.source_quote || "",
    entities:         cont.entities   || item.entities || [],
    numbers:          cont.numbers    || item.numbers  || [],
    tags:             item.taxonomy_tags || item.tags || [],
    visual_refs:      item.visual_refs || [],
    validation_status:item.validation_status || null,
  };
}

export function EvidenceCard({ item, expanded = false, onToggle }) {
  const {
    evidence_id, source_id, title, publisher, published_at, url,
    evidence_type, evidence_strength, admissibility, category,
    extraction_layer, fact, source_quote, entities = [], numbers = [],
    validation_status, tags = [], visual_refs = [],
  } = flatten(item);

  return (
    <div style={{
      border:       "1px solid #1e293b",
      borderLeft:   evidence_strength === "strong" ? "3px solid #4ade80" :
                    evidence_strength === "usable"  ? "3px solid #60a5fa" : "3px solid #3f3f46",
      borderRadius: "8px",
      padding:      "14px",
      background:   "rgba(15,23,42,0.6)",
      display:      "flex",
      flexDirection:"column",
      gap:          "8px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "#e2e8f0", lineHeight: 1.4 }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd", textDecoration: "none" }}>{title || url}</a>
              : (title || <span style={{ color: "#475569" }}>(no title)</span>)}
          </div>
          {/* Provenance line: publisher · date · extraction layer · evidence_id */}
          <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "3px", display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            {publisher && <span>{publisher}</span>}
            {published_at && <span>· {String(published_at).slice(0, 10)}</span>}
            {extraction_layer && <span style={{ color: "#334155" }}>· {extraction_layer}</span>}
            <span style={{ color: "#334155", fontFamily: "monospace", fontSize: "0.65rem" }}>{evidence_id}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <StatusBadge status={evidence_strength} />
          {admissibility === "context_only" && <StatusBadge status="context_only" label="context only" />}
          {validation_status === "validated"  && <StatusBadge status="validated" />}
        </div>
      </div>

      {/* Fact */}
      <div style={{ fontSize: "0.8rem", color: "#cbd5e1", lineHeight: 1.5 }}>{fact}</div>

      {/* Source quote */}
      {source_quote && (
        <div style={{
          fontSize:   "0.75rem",
          color:      "#94a3b8",
          fontStyle:  "italic",
          borderLeft: "2px solid #334155",
          paddingLeft:"10px",
          lineHeight: 1.4,
        }}>
          "{source_quote}"
        </div>
      )}

      {/* Entities + numbers */}
      {(entities.length > 0 || numbers.length > 0) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {entities.map((e) => (
            <span key={e} style={{
              fontSize: "0.7rem", padding: "2px 7px", borderRadius: "10px",
              background: "#1e293b", color: "#7dd3fc", border: "1px solid #1e40af44",
            }}>{e}</span>
          ))}
          {numbers.map((n) => (
            <span key={n} style={{
              fontSize: "0.7rem", padding: "2px 7px", borderRadius: "10px",
              background: "#1a1a2e", color: "#c084fc", border: "1px solid #7c3aed44",
            }}>{n}</span>
          ))}
        </div>
      )}

      {/* Taxonomy tags */}
      {tags.length > 0 && (
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {tags.map((t) => (
            <span key={t} style={{
              fontSize: "0.68rem", padding: "1px 6px", borderRadius: "4px",
              background: "#0f172a", color: "#475569", border: "1px solid #1e293b",
              fontFamily: "monospace",
            }}>{t}</span>
          ))}
        </div>
      )}

      {/* Visual refs — figures attached to this evidence */}
      {visual_refs.filter((v) => v.source_url || v.visual_url).length > 0 && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {visual_refs.filter((v) => v.source_url || v.visual_url).map((v) => (
            <a key={v.visual_id}
               href={v.source_url || v.visual_url}
               target="_blank"
               rel="noopener noreferrer"
               title={v.caption || v.visual_id}
               style={{
                 fontSize: "0.68rem", padding: "2px 8px", borderRadius: "8px",
                 background: "rgba(30,41,59,0.8)", color: "#7dd3fc",
                 border: "1px solid #1e3a5f", textDecoration: "none",
                 display: "flex", alignItems: "center", gap: "4px",
               }}>
              ▤ {v.type === "generated_chart" ? "chart" : "figure"}
              {v.usage_rights_status === "unknown" && (
                <span style={{ color: "#fbbf24", fontSize: "0.6rem" }}>⚠</span>
              )}
            </a>
          ))}
        </div>
      )}

      {/* Provenance traceability footer */}
      {(url || source_id) && (
        <div style={{ fontSize: "0.65rem", color: "#334155", borderTop: "1px solid #0f1827", paddingTop: "6px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer"
               style={{ color: "#475569", textDecoration: "none" }}>
              original source ↗
            </a>
          )}
          {source_id && (
            <a href={`/source/${source_id}`}
               style={{ color: "#334155", textDecoration: "none" }}>
              source record · {source_id}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
