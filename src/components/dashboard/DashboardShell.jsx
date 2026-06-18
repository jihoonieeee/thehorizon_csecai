/**
 * DashboardShell — monthly AI threat landscape explorer shell.
 *
 * Manages:
 *   - period selection (current month / compare period)
 *   - 4-page navigation (Overview, Landscape, Ask Agent, Reports)
 *   - global drilldown panel state passed to child pages
 */

import { useState }          from "react";
import { Sidebar }           from "./Sidebar.jsx";
import { DrilldownPanel }    from "./DrilldownPanel.jsx";
import { OverviewPage }      from "../../pages/dashboard/OverviewPage.jsx";
import { LandscapePage }     from "../../pages/dashboard/LandscapePage.jsx";
import { AskAgentPage }      from "../../pages/dashboard/AskAgentPage.jsx";
import { LogsPage }          from "../../pages/dashboard/LogsPage.jsx";
import { UsagePage }         from "../../pages/dashboard/UsagePage.jsx";
import { CURRENT_PERIOD }    from "../../mockData/dashboardData.js";
import { useDashboardData }  from "../../hooks/useDashboardData.js";

const PERIODS = [
  { value: "2026-05", label: "May 2026" },
  { value: "2026-04", label: "Apr 2026" },
  { value: "2026-03", label: "Mar 2026" },
  { value: "2026-02", label: "Feb 2026" },
];

function PageContent({ page, data, onDrilldown }) {
  switch (page) {
    case "overview":  return <OverviewPage  data={data} onDrilldown={onDrilldown} />;
    case "landscape": return <LandscapePage data={data} onDrilldown={onDrilldown} />;
    case "ask":       return <AskAgentPage  data={data} />;
    case "logs":      return <LogsPage />;
    case "usage":     return <UsagePage />;
    default:          return <OverviewPage  data={data} onDrilldown={onDrilldown} />;
  }
}

export function DashboardShell() {
  const [activePage,  setActivePage]  = useState("overview");
  const [period,      setPeriod]      = useState(CURRENT_PERIOD);
  const [drilldown,   setDrilldown]   = useState(null);   // null = closed

  const { data, loading } = useDashboardData(period);

  const handleDrilldown = (item) => setDrilldown(item);
  const closeDrilldown  = ()     => setDrilldown(null);

  const totalCritical = data.categories.reduce((n, c) => n + (c.claim_counts?.critical || 0), 0);
  const totalHigh     = data.categories.reduce((n, c) => n + (c.claim_counts?.high     || 0), 0);

  return (
    <div className="dashboard-shell">
      {/* Top bar */}
      <div className="dashboard-topbar">
        <div className="dashboard-topbar-left">
          <span style={{ fontWeight: 800, fontSize: "0.95rem", color: "#e2e8f0", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
            Horizon
          </span>
          <span style={{ width: "1px", height: "16px", background: "#1e293b", flexShrink: 0 }} />
          <span style={{ fontSize: "0.76rem", color: "#475569", whiteSpace: "nowrap" }}>AI Threat Intelligence</span>
          {/* Period selector */}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{
              background:   "#0f172a",
              border:       "1px solid #1e293b",
              borderRadius: "6px",
              color:        "#94a3b8",
              fontSize:     "0.78rem",
              padding:      "4px 10px",
              cursor:       "pointer",
              fontWeight:   500,
            }}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Alert badges */}
        <div className="dashboard-topbar-badges">
          {totalCritical > 0 && (
            <span style={{
              fontSize: "0.68rem", fontWeight: 700, padding: "3px 9px", borderRadius: "10px",
              background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)",
              whiteSpace: "nowrap",
            }}>
              {totalCritical} Critical
            </span>
          )}
          {totalHigh > 0 && (
            <span style={{
              fontSize: "0.68rem", fontWeight: 700, padding: "3px 9px", borderRadius: "10px",
              background: "rgba(249,115,22,0.1)", color: "#fb923c", border: "1px solid rgba(249,115,22,0.2)",
              whiteSpace: "nowrap",
            }}>
              {totalHigh} High
            </span>
          )}
          <span style={{ fontSize: "0.68rem", color: "#1e3a5f", padding: "3px 9px", borderRadius: "10px", background: "#0f172a", border: "1px solid #0f1827", whiteSpace: "nowrap" }}>
            {data.summary.sources_validated}/{data.summary.total_sources} validated
          </span>
        </div>
      </div>

      {/* Layout: sidebar + content */}
      <div className="dashboard-body">
        <Sidebar
          activePage={activePage}
          onNavigate={setActivePage}
          periodLabel={PERIODS.find((p) => p.value === period)?.label}
          sourceCount={data.summary.sources_validated}
        />

        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <PageContent
            page={activePage}
            data={data}
            onDrilldown={handleDrilldown}
          />
        </div>
      </div>

      {/* Drilldown panel — right side overlay */}
      {drilldown && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeDrilldown}
            style={{
              position: "fixed", inset: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 999,
            }}
          />
          <DrilldownPanel
            item={drilldown}
            onClose={closeDrilldown}
            data={data}
          />
        </>
      )}
    </div>
  );
}
