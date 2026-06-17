const NAV_ITEMS = [
  { id: "overview",   label: "Overview",           icon: "⬡",  description: "Monthly summary and claims" },
  { id: "landscape",  label: "Landscape Explorer", icon: "◈",  description: "Explore by category, tag, month" },
  { id: "ask",        label: "Ask Agent",          icon: "◎",  description: "Evidence-backed Q&A" },
  { id: "logs",       label: "Logs",               icon: "≡",  description: "Ingestion runs and processed sources" },
  { id: "usage",      label: "API Usage",          icon: "◉",  description: "Token and cost tracking by provider" },
];

export function Sidebar({ activePage, onNavigate, periodLabel, sourceCount }) {
  return (
    <nav className="dashboard-sidebar">
      <div className="dashboard-sidebar-label">Navigation</div>

      {NAV_ITEMS.map((item) => {
        const isActive = activePage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            title={item.label}
            className={`dashboard-nav-btn${isActive ? " active" : ""}`}
          >
            <span className="dashboard-nav-icon">{item.icon}</span>
            <span className="dashboard-nav-label">{item.label}</span>
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <div className="dashboard-sidebar-footer">
        <div style={{ fontSize: "0.6rem", color: "#1e3a5f", fontWeight: 700, letterSpacing: "0.08em", marginBottom: "3px" }}>CORPUS</div>
        <div style={{ fontSize: "0.69rem", color: "#334155" }}>{periodLabel || "2026-05"}</div>
        <div style={{ fontSize: "0.69rem", color: "#1e3a5f", marginTop: "1px" }}>{sourceCount || "51"} validated</div>
      </div>
    </nav>
  );
}
