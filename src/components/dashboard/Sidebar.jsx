/**
 * Dashboard Sidebar — 4-page nav: Overview, Landscape Explorer, Ask Agent, Reports.
 * Evidence and Visuals removed as top-level pages (now drilldown panels).
 */

const NAV_ITEMS = [
  { id: "overview",   label: "Overview",           icon: "⬡",  description: "Monthly summary and claims" },
  { id: "landscape",  label: "Landscape Explorer", icon: "◈",  description: "Explore by category, tag, month" },
  { id: "ask",        label: "Ask Agent",          icon: "◎",  description: "Evidence-backed Q&A" },
  { id: "reports",    label: "Reports",            icon: "▤",  description: "Generate deck, script, brief" },
  { id: "logs",       label: "Logs",               icon: "≡",  description: "Ingestion runs and processed sources" },
  { id: "usage",      label: "API Usage",          icon: "◉",  description: "Token and cost tracking by provider" },
];

export function Sidebar({ activePage, onNavigate, periodLabel, sourceCount }) {
  return (
    <nav style={{
      width:         "200px",
      flexShrink:    0,
      paddingRight:  "16px",
      display:       "flex",
      flexDirection: "column",
      gap:           "2px",
      borderRight:   "1px solid #0f1827",
    }}>
      <div style={{
        fontSize:     "0.6rem",
        fontWeight:   700,
        color:        "#334155",
        letterSpacing:"0.1em",
        textTransform:"uppercase",
        padding:      "0 10px 12px",
      }}>
        Navigation
      </div>

      {NAV_ITEMS.map((item) => {
        const isActive = activePage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            title={item.description}
            style={{
              display:     "flex",
              alignItems:  "center",
              gap:         "10px",
              padding:     "9px 10px",
              borderRadius:"8px",
              border:      "none",
              background:  isActive ? "rgba(99,102,241,0.14)" : "transparent",
              color:       isActive ? "#a5b4fc" : "#64748b",
              cursor:      "pointer",
              textAlign:   "left",
              fontWeight:  isActive ? 600 : 400,
              fontSize:    "0.82rem",
              transition:  "background 0.12s, color 0.12s",
              width:       "100%",
            }}
          >
            <span style={{
              width:      "18px",
              textAlign:  "center",
              fontSize:   "0.85rem",
              color:      isActive ? "#818cf8" : "#334155",
              flexShrink: 0,
            }}>
              {item.icon}
            </span>
            {item.label}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <div style={{
        marginTop:  "16px",
        paddingTop: "12px",
        borderTop:  "1px solid #0f1827",
        padding:    "12px 10px 0",
      }}>
        <div style={{ fontSize: "0.65rem", color: "#1e3a5f", fontWeight: 700, marginBottom: "4px" }}>CORPUS</div>
        <div style={{ fontSize: "0.7rem", color: "#334155" }}>
          {periodLabel || "2026-05"}
        </div>
        <div style={{ fontSize: "0.7rem", color: "#1e3a5f", marginTop: "2px" }}>
          {sourceCount || "51"} validated sources
        </div>
      </div>
    </nav>
  );
}
