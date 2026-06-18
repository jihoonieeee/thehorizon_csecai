/**
 * DashboardShell — minimal top-nav shell with 3 pages.
 * Period defaults to the current calendar month, computed dynamically.
 */

import { useState } from "react";
import { useDashboardData } from "../../hooks/useDashboardData.js";
import { OverviewPage }     from "../../pages/dashboard/OverviewPage.jsx";
import { AskAgentPage }     from "../../pages/dashboard/AskAgentPage.jsx";
import { SourcesPage }      from "../../pages/dashboard/SourcesPage.jsx";

// ── Period helpers ─────────────────────────────────────────────────────────────

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function buildPeriods() {
  const now = new Date();
  const list = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const short = d.toLocaleDateString("en-SG", { month: "short", year: "numeric" });
    const label = i === 0 ? `${short} (this month)` : i === 1 ? `${short} (last month)` : short;
    list.push({ value: val, label });
  }
  return list;
}

const MONTH_PERIODS = buildPeriods();

const ALL_PERIODS = [
  { value: "last-90d",  label: "Last 90 days" },
  { value: "last-30d",  label: "Last 30 days" },
  { value: "last-7d",   label: "Last 7 days" },
  { value: "divider",   label: "─────────────" },
  ...MONTH_PERIODS,
];

const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "ask",      label: "Ask Agent" },
  { id: "sources",  label: "Sources" },
];

function PageContent({ page, data, period, onPeriodChange }) {
  switch (page) {
    case "overview": return <OverviewPage data={data} />;
    case "ask":      return <AskAgentPage data={data} period={period} />;
    case "sources":  return <SourcesPage  data={data} period={period} onPeriodChange={onPeriodChange} />;
    default:         return <OverviewPage data={data} />;
  }
}

export function DashboardShell() {
  const [activePage, setActivePage] = useState("overview");
  const [period,     setPeriod]     = useState(currentMonthKey());

  const { data, loading } = useDashboardData(period);

  const validated = data?.summary?.sources_validated ?? 0;
  const total     = data?.summary?.total_sources ?? 0;
  const periodLabel = data?.period_label || ALL_PERIODS.find(p => p.value === period)?.label || period;

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
            <span style={{ fontSize: "0.72rem", color: "var(--text-tertiary)" }}>Loading…</span>
          )}
          {!loading && (
            <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
              {validated}/{total} validated
            </span>
          )}
          <select
            className="hz-period-select"
            value={period}
            onChange={(e) => {
              if (e.target.value !== "divider") setPeriod(e.target.value);
            }}
          >
            {ALL_PERIODS.map((p) => (
              <option key={p.value} value={p.value} disabled={p.value === "divider"}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </nav>

      {/* Period context bar */}
      {activePage !== "ask" && (
        <div className="hz-period-bar">
          <span className="hz-period-bar-label">Showing:</span>
          <span className="hz-period-bar-value">{periodLabel}</span>
          {data?.summary?.date_range?.start && (
            <span className="hz-period-bar-range">
              {data.summary.date_range.start} – {data.summary.date_range.end}
            </span>
          )}
          <div className="hz-period-bar-pills">
            {[
              { value: currentMonthKey(), label: "This month" },
              { value: "last-30d",        label: "30 days" },
              { value: "last-90d",        label: "90 days" },
            ].map(p => (
              <button
                key={p.value}
                className={`hz-period-pill${period === p.value ? " active" : ""}`}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Page content */}
      <div className="hz-content">
        <PageContent
          page={activePage}
          data={data}
          period={period}
          onPeriodChange={setPeriod}
        />
      </div>
    </div>
  );
}
