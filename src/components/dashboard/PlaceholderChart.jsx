/**
 * PlaceholderChart — visual placeholder for charts not yet wired to real data.
 */

export function PlaceholderChart({ label = "Chart", height = 180, description }) {
  return (
    <div style={{
      height,
      border:       "1px dashed #334155",
      borderRadius: "8px",
      display:      "flex",
      flexDirection:"column",
      alignItems:   "center",
      justifyContent:"center",
      gap:          "8px",
      color:        "#475569",
      background:   "rgba(15,23,42,0.4)",
    }}>
      <div style={{ fontSize: "1.8rem" }}>📊</div>
      <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{label}</div>
      {description && <div style={{ fontSize: "0.72rem", color: "#334155", maxWidth: "240px", textAlign: "center" }}>{description}</div>}
      <div style={{ fontSize: "0.7rem", color: "#334155", marginTop: "4px" }}>
        Backend integration needed
      </div>
    </div>
  );
}
