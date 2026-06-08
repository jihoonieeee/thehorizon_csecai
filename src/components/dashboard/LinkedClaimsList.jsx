/**
 * LinkedClaimsList — shows claims linked to a selected evidence/chart element.
 */

const PRIORITY_STYLE = {
  critical: { color: "#f87171", bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.25)" },
  high:     { color: "#fb923c", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.2)" },
  medium:   { color: "#fbbf24", bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.2)" },
};

export function LinkedClaimsList({ claims = [] }) {
  if (claims.length === 0) return <div style={{ color: "#334155", fontSize: "0.75rem" }}>No linked claims.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {claims.map((claim) => {
        const s = PRIORITY_STYLE[claim.claim_priority] || { color: "#64748b", bg: "transparent", border: "#1e293b" };
        return (
          <div key={claim.claim_id} style={{
            padding:      "8px 10px",
            borderRadius: "6px",
            background:   s.bg,
            border:       `1px solid ${s.border}`,
          }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" }}>
              <span style={{
                fontSize:   "0.6rem",
                fontWeight: 700,
                padding:    "1px 6px",
                borderRadius:"8px",
                color:      s.color,
                background: `${s.color}22`,
                textTransform:"uppercase",
              }}>
                {claim.claim_priority}
              </span>
              <span style={{ fontSize: "0.6rem", color: "#475569" }}>{claim.claim_type?.replace(/_/g, " ")}</span>
              <span style={{ fontSize: "0.6rem", color: "#334155", marginLeft: "auto" }}>{claim.claim_id}</span>
            </div>
            <div style={{ fontSize: "0.8rem", color: "#e2e8f0", lineHeight: 1.5 }}>
              {claim.claim_text}
            </div>
            {claim.caveat_if_any && (
              <div style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                ⚠ {claim.caveat_if_any}
              </div>
            )}
            <div style={{ display: "flex", gap: "6px", marginTop: "4px", alignItems: "center" }}>
              <span style={{ fontSize: "0.65rem", color: "#334155" }}>Confidence:</span>
              <span style={{ fontSize: "0.65rem", color: claim.confidence === "high" ? "#10b981" : claim.confidence === "medium" ? "#f59e0b" : "#64748b" }}>
                {claim.confidence}
              </span>
              <span style={{ fontSize: "0.65rem", color: "#334155", marginLeft: "6px" }}>
                Evidence IDs: {(claim.supporting_evidence_ids || []).join(", ") || "none"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
