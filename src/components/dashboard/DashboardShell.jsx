/**
 * DashboardShell — top-nav shell. Each page owns its own data fetching.
 */

import { useState } from "react";
import { OverviewPage }       from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }       from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }        from "../../pages/dashboard/SourcesPage.jsx";
import { IngestionPage }      from "../../pages/dashboard/IngestionPage.jsx";
import { LogsPage }           from "../../pages/dashboard/LogsPage.jsx";
import { GenerateSlidesPage } from "../../pages/dashboard/GenerateSlidesPage.jsx";

const NAV_ITEMS = [
  { id: "overview",  label: "Overview"   },
  { id: "ask",       label: "Ask Agent"  },
  { id: "sources",   label: "Sources"    },
  { id: "ingestion", label: "Ingestion"  },
  { id: "logs",      label: "Logs"       },
  { id: "generate",  label: "Generate"   },
];

function PageContent({ page }) {
  switch (page) {
    case "overview":  return <OverviewPage />;
    case "ask":       return <AskAgentPage />;
    case "sources":   return <SourcesPage />;
    case "ingestion": return <IngestionPage />;
    case "logs":      return <LogsPage />;
    case "generate":  return <GenerateSlidesPage />;
    default:          return <OverviewPage />;
  }
}

export function DashboardShell() {
  const [activePage, setActivePage] = useState("overview");

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
        <PageContent page={activePage} />
      </div>
    </div>
  );
}
