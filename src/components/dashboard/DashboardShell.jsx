/**
 * DashboardShell — top-nav shell. Period controls live inside each page.
 */

import { useState } from "react";
import { useDashboardData } from "../../hooks/useDashboardData.js";
import { OverviewPage }     from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }     from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }      from "../../pages/dashboard/SourcesPage.jsx";
import { LogsPage }         from "../../pages/dashboard/LogsPage.jsx";

const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "ask",      label: "Ask Agent" },
  { id: "sources",  label: "Sources" },
  { id: "logs",     label: "Logs" },
];

// Current month key for the overview's "this month" data
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function PageContent({ page, data, loading }) {
  switch (page) {
    case "overview": return <OverviewPage data={data} loading={loading} />;
    case "ask":      return <AskAgentPage data={data} />;
    case "sources":  return <SourcesPage />;
    case "logs":     return <LogsPage />;
    default:         return <OverviewPage data={data} loading={loading} />;
  }
}

export function DashboardShell() {
  const [activePage, setActivePage] = useState("overview");
  const { data, loading } = useDashboardData(currentMonthKey());

  return (
    <div className="hz-shell">
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
      </nav>

      <div className="hz-content">
        <PageContent page={activePage} data={data} loading={loading} />
      </div>
    </div>
  );
}
