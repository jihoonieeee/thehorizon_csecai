/**
 * ThreatCategoryCard — summary card for a single threat category.
 * Shows claim priority breakdown, confidence, headline, and top signal.
 */

import { StatusBadge } from "./StatusBadge.jsx";

export function ThreatCategoryCard({ category }) {
  const { label, color, source_count, claim_counts, headline, confidence, top_signal } = category;
  const { critical = 0, high = 0, medium = 0 } = claim_counts || {};
  const hasRealSignal = critical > 0 || high > 0;

  return (
    <div style={{
      border:       `1px solid ${color}33`,
      borderLeft:   `3px solid ${color}`,
      borderRadius: "10px",
      padding:      "16px",
      background:   "rgba(15,23,42,0.6)",
      display:      "flex",
      flexDirection:"column",
      gap:          "10px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "#e2e8f0" }}>{label}</span>
        <StatusBadge status={confidence} />
      </div>

      <div style={{ fontSize: "0.8rem", color: "#94a3b8", lineHeight: 1.4 }}>{headline}</div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {critical > 0 && <StatusBadge status="critical" label={`${critical} Critical`} />}
        {high > 0     && <StatusBadge status="high"     label={`${high} High`} />}
        {medium > 0   && <StatusBadge status="medium"   label={`${medium} Medium`} />}
        <span style={{ fontSize: "0.72rem", color: "#475569", alignSelf: "center" }}>
          {source_count} sources
        </span>
      </div>

      {hasRealSignal && top_signal && (
        <div style={{
          fontSize:     "0.75rem",
          color:        "#64748b",
          borderTop:    "1px solid #1e293b",
          paddingTop:   "8px",
          lineHeight:   1.4,
          fontStyle:    "italic",
        }}>
          "{top_signal}"
        </div>
      )}
    </div>
  );
}
