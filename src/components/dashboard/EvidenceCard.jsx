/**
 * EvidenceCard — displays a single evidence item with source quote,
 * validation badge, and taxonomy tags.
 */

import { StatusBadge } from "./StatusBadge.jsx";

export function EvidenceCard({ item, expanded = false, onToggle }) {
  const {
    evidence_id, title, publisher, date_published, url,
    evidence_type, evidence_strength, category,
    fact, source_quote, entities = [], numbers = [],
    validation_status, tags = [],
  } = item;

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
            {url ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : title}
          </div>
          <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "3px" }}>
            {publisher}
            {date_published && <span> · {date_published}</span>}
            <span style={{ marginLeft: "8px", color: "#475569" }}>{evidence_id}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <StatusBadge status={evidence_strength} />
          {validation_status === "validated" && <StatusBadge status="validated" />}
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
    </div>
  );
}
