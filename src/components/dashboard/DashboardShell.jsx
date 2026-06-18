/**
 * DashboardShell — minimal top-nav shell with 3 pages.
 * Pages: Overview, Ask Agent, Sources
 */

import { useState } from "react";
import { useDashboardData }  from "../../hooks/useDashboardData.js";
import { CURRENT_PERIOD }    from "../../mockData/dashboardData.js";
import { OverviewPage }      from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }      from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }       from "../../pages/dashboard/SourcesPage.jsx";

const PERIODS = [
  { value: "last-90d", label: "Last 90 days" },
  { value: "2026-06",  label: "Jun 2026" },
  { value: "2026-05",  label: "May 2026" },
  { value: "2026-04",  label: "Apr 2026" },
  { value: "2026-03",  label: "Mar 2026" },
  { value: "2026-02",  label: "Feb 2026" },
  { value: "2026-01",  label: "Jan 2026" },
];

const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "ask",      label: "Ask Agent" },
  { id: "sources",  label: "Sources" },
];

function PageContent({ page, data, period }) {
  switch (page) {
    case "overview": return <OverviewPage data={data} />;
    case "ask":      return <AskAgentPage data={data} />;
    case "sources":  return <SourcesPage  data={data} period={period} />;
    default:         return <OverviewPage data={data} />;
  }
}

export function DashboardShell() {
  const [activePage, setActivePage] = useState("overview");
  const [period,     setPeriod]     = useState(CURRENT_PERIOD);

  const { data, loading } = useDashboardData(period);

  const validated = data?.summary?.sources_validated ?? 0;
  const total     = data?.summary?.total_sources ?? 0;

  return (
    <div className="hz-shell">
      {/* Top nav */}
      <nav className="hz-nav">
        <div className="hz-nav-brand">
          The Horizon
          <small>AI Threat Intelligence</small>
        </div>

        <div className="hz-nav-links">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`hz-nav-link${activePage === item.id ? " active" : ""}`}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="hz-nav-right">
          {loading && (
            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>
              Loading...
            </span>
          )}
          <span style={{
            fontSize: "0.72rem",
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
          }}>
            {validated}/{total} validated
          </span>
          <select
            className="hz-period-select"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </nav>

      {/* Page content */}
      <div className="hz-content">
        <PageContent page={activePage} data={data} period={period} />
      </div>
    </div>
  );
}
