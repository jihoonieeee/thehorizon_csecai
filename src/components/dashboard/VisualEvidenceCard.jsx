/**
 * VisualEvidenceCard — displays a visual evidence item with usefulness and
 * slide suitability badges.
 */

import { StatusBadge } from "./StatusBadge.jsx";

const SUITABILITY_ICONS = {
  embed:         "🖼️",
  redraw:        "📐",
  cite:          "🔗",
  manual_review: "⚠️",
  reject:        "🚫",
};

export function VisualEvidenceCard({ item }) {
  const {
    visual_id, title, source_url, publisher,
    category, visual_type, visual_usefulness,
    slide_suitability, description,
  } = item;

  const suitIcon = SUITABILITY_ICONS[slide_suitability] || "?";
  const isRejected = slide_suitability === "reject";

  return (
    <div style={{
      border:        "1px solid #1e293b",
      borderRadius:  "10px",
      overflow:      "hidden",
      background:    isRejected ? "rgba(10,10,15,0.5)" : "rgba(15,23,42,0.6)",
      opacity:       isRejected ? 0.55 : 1,
      display:       "flex",
      flexDirection: "column",
    }}>
      {/* Image placeholder */}
      <div style={{
        height:         "120px",
        background:     "#0f172a",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        borderBottom:   "1px solid #1e293b",
        color:          "#334155",
        fontSize:       "2.2rem",
      }}>
        {isRejected ? "🚫" : "🖼️"}
      </div>

      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {/* Title */}
        <div style={{ fontWeight: 600, fontSize: "0.8rem", color: "#cbd5e1", lineHeight: 1.4 }}>
          {source_url
            ? <a href={source_url} target="_blank" rel="noopener noreferrer">{title}</a>
            : title}
        </div>

        <div style={{ fontSize: "0.72rem", color: "#475569" }}>
          {publisher} · {visual_type}
        </div>

        {description && (
          <div style={{ fontSize: "0.75rem", color: "#64748b", lineHeight: 1.4 }}>{description}</div>
        )}

        {/* Badges */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
          <span style={{ fontSize: "0.75rem" }}>{suitIcon}</span>
          <StatusBadge status={slide_suitability} />
          <StatusBadge status={visual_usefulness} label={`${visual_usefulness} usefulness`} />
        </div>

        <div style={{ fontSize: "0.68rem", color: "#334155", fontFamily: "monospace" }}>{visual_id}</div>
      </div>
    </div>
  );
}
