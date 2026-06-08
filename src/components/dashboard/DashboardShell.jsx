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
import { ReportsPage }       from "../../pages/dashboard/ReportsPage.jsx";
import { LogsPage }          from "../../pages/dashboard/LogsPage.jsx";
import { UsagePage }         from "../../pages/dashboard/UsagePage.jsx";
import { MONTHLY_DASHBOARD, CURRENT_PERIOD } from "../../mockData/dashboardData.js";

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
    case "reports":   return <ReportsPage   data={data} />;
    case "logs":      return <LogsPage />;
    case "usage":     return <UsagePage />;
    default:          return <OverviewPage  data={data} onDrilldown={onDrilldown} />;
  }
}

export function DashboardShell() {
  const [activePage,  setActivePage]  = useState("overview");
  const [period,      setPeriod]      = useState(CURRENT_PERIOD);
  const [drilldown,   setDrilldown]   = useState(null);   // null = closed

  // In a real app, data would be fetched by useDashboardData(period).
  // For now, use static mock data regardless of period.
  const data = MONTHLY_DASHBOARD;

  const handleDrilldown = (item) => setDrilldown(item);
  const closeDrilldown  = ()     => setDrilldown(null);

  const totalCritical = data.categories.reduce((n, c) => n + (c.claim_counts?.critical || 0), 0);
  const totalHigh     = data.categories.reduce((n, c) => n + (c.claim_counts?.high     || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Top bar */}
      <div style={{
        display:         "flex",
        justifyContent:  "space-between",
        alignItems:      "center",
        padding:         "10px 16px",
        marginBottom:    "20px",
        borderRadius:    "10px",
        background:      "rgba(8,12,20,0.8)",
        border:          "1px solid #0f1827",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "#e2e8f0", letterSpacing: "0.02em" }}>
            Horizon AI Threat Dashboard
          </span>
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
              padding:      "4px 8px",
              cursor:       "pointer",
            }}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <span style={{ fontSize: "0.7rem", color: "#334155" }}>vs</span>
          <span style={{ fontSize: "0.75rem", color: "#334155", background: "#0f172a", padding: "4px 8px", borderRadius: "6px", border: "1px solid #0f1827" }}>
            {PERIODS.find((p) => p.value === data.compare_period)?.label || data.compare_period}
          </span>
        </div>

        {/* Alert badges */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {totalCritical > 0 && (
            <span style={{
              fontSize: "0.68rem", fontWeight: 700, padding: "2px 8px", borderRadius: "10px",
              background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)",
            }}>
              {totalCritical} Critical
            </span>
          )}
          {totalHigh > 0 && (
            <span style={{
              fontSize: "0.68rem", fontWeight: 700, padding: "2px 8px", borderRadius: "10px",
              background: "rgba(249,115,22,0.1)", color: "#fb923c", border: "1px solid rgba(249,115,22,0.2)",
            }}>
              {totalHigh} High
            </span>
          )}
          <span style={{ fontSize: "0.68rem", color: "#1e3a5f", padding: "2px 8px", borderRadius: "10px", background: "#0f172a", border: "1px solid #0f1827" }}>
            {data.summary.sources_validated}/{data.summary.total_sources} validated
          </span>
        </div>
      </div>

      {/* Layout: sidebar + content */}
      <div style={{ display: "flex", gap: "24px", alignItems: "flex-start" }}>
        <Sidebar
          activePage={activePage}
          onNavigate={setActivePage}
          periodLabel={PERIODS.find((p) => p.value === period)?.label}
          sourceCount={data.summary.sources_validated}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
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
