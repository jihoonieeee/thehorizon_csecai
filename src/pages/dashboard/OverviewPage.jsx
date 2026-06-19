/**
 * OverviewPage — weekly / monthly / quarterly insight switcher.
 * Month view uses live data; week + quarter show placeholders.
 */

import { useState } from "react";

const CAT_COLOR = {
  traditional_ai_threats: "#3583C9",
  llm_threats:            "#9C62A7",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

const CAT_LABEL = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ values, color, width = 100, height = 36 }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - Math.round((v / max) * (height - 4)) - 2;
    return `${x},${y}`;
  });
  const areaPath =
    `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(" ") +
    ` L${(values.length - 1) * step},${height} L0,${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      <path d={areaPath} fill={color} opacity="0.12" />
      <polyline points={pts.join(" ")} stroke={color} strokeWidth="1.5"
        fill="none" strokeLinejoin="round" strokeLinecap="round" />
      {(() => {
        const lx = (values.length - 1) * step;
        const ly = height - Math.round((values[values.length - 1] / max) * (height - 4)) - 2;
        return <circle cx={lx} cy={ly} r="2.5" fill={color} />;
      })()}
    </svg>
  );
}

// ── Period switcher ────────────────────────────────────────────────────────────

function PeriodSwitcher({ value, onChange }) {
  const options = [
    { id: "week",    label: "This Week" },
    { id: "month",   label: "This Month" },
    { id: "quarter", label: "Last 90 Days" },
  ];
  return (
    <div className="hz-seg-group">
      {options.map((o) => (
        <button
          key={o.id}
          className={`hz-seg-btn${value === o.id ? " active" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Insight stat block ────────────────────────────────────────────────────────

function StatBlock({ stats }) {
  return (
    <div className="hz-insight-stats">
      {stats.map((s, i) => (
        <div key={i} className="hz-insight-stat">
          <span className="hz-insight-stat-value">{s.value}</span>
          <span className="hz-insight-stat-label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Placeholder finding card ──────────────────────────────────────────────────

function FindingCard({ color, label, finding, note }) {
  return (
    <div className="hz-finding-card" style={{ borderLeftColor: color }}>
      <div className="hz-finding-card-cat" style={{ color }}>{label}</div>
      <div className="hz-finding-card-text">{finding}</div>
      {note && <div className="hz-finding-card-note">{note}</div>}
    </div>
  );
}

// ── Category card (month view) ────────────────────────────────────────────────

function CategoryCard({ cat }) {
  const color = CAT_COLOR[cat.key] || "#64748b";
  const count = cat.source_count ?? 0;
  return (
    <div className="hz-cat-card">
      <div className="hz-cat-card-strip" style={{ background: color }} />
      <div className="hz-cat-card-top">
        <div>
          <div className="hz-cat-card-count">{count}</div>
          <div className="hz-cat-card-count-label">sources</div>
        </div>
        {cat.confidence && (
          <span className={`hz-conf ${cat.confidence}`}>{cat.confidence}</span>
        )}
      </div>
      <div className="hz-cat-card-name">{cat.label}</div>
      {cat.headline && <div className="hz-cat-card-headline">{cat.headline}</div>}
      {cat.top_signal && (
        <div className="hz-cat-card-signal" style={{ borderLeftColor: `${color}60` }}>
          {cat.top_signal}
        </div>
      )}
      {cat.monthly_counts?.length > 1 && (
        <div className="hz-cat-card-footer">
          <Sparkline values={cat.monthly_counts} color={color} width={80} height={28} />
        </div>
      )}
    </div>
  );
}

// ── Week view (placeholder) ───────────────────────────────────────────────────

function WeekView() {
  return (
    <div className="hz-insight-view">
      <StatBlock stats={[
        { value: "—", label: "New sources" },
        { value: "—", label: "High-trust" },
        { value: "—", label: "New findings" },
      ]} />
      <div className="hz-insight-section-title">Key developments this week</div>
      <div className="hz-finding-list">
        <FindingCard
          color={CAT_COLOR.llm_threats}
          label="LLM Threats"
          finding="Weekly ingestion data will appear here once pipeline runs are available for the current 7-day window."
          note="Placeholder — connect pipeline to populate"
        />
        <FindingCard
          color={CAT_COLOR.agentic_ai_threats}
          label="Agentic AI Threats"
          finding="Agent-related threat intelligence from this week will surface here automatically."
          note="Placeholder — connect pipeline to populate"
        />
        <FindingCard
          color={CAT_COLOR.ai_enabled_threats}
          label="AI-Enabled Threats"
          finding="Deepfake, phishing, and AI-assisted attack reports from the past 7 days."
          note="Placeholder — connect pipeline to populate"
        />
      </div>
      <div className="hz-insight-placeholder-banner">
        Weekly insights require a completed pipeline run within the last 7 days.
        Run <code>npx vercel dev</code> and trigger <code>/api/refresh</code> to populate.
      </div>
    </div>
  );
}

// ── Month view (live data) ────────────────────────────────────────────────────

function MonthView({ data, loading }) {
  const { summary, categories = [] } = data || {};
  const cats = categories.map(c => ({ ...c, key: c.key || c.id }));

  const now = new Date();
  const monthLabel = now.toLocaleDateString("en-SG", { month: "long", year: "numeric" });

  if (loading) {
    return (
      <div className="hz-insight-view">
        <p className="hz-insight-loading">Loading {monthLabel} data…</p>
      </div>
    );
  }

  return (
    <div className="hz-insight-view">
      <StatBlock stats={[
        { value: summary?.total_sources     ?? "—", label: "Sources ingested" },
        { value: summary?.sources_validated ?? "—", label: "Validated" },
        { value: summary?.categories_assessed ?? (cats.length || "—"), label: "Categories" },
        ...(summary?.date_range?.start ? [{
          value: `${summary.date_range.start.slice(5)} – ${summary.date_range.end.slice(5)}`,
          label: "Date range",
        }] : []),
      ]} />

      {summary?.executive_headline && (
        <div className="hz-insight-headline">{summary.executive_headline}</div>
      )}

      {cats.length > 0 ? (
        <>
          <div className="hz-insight-section-title">Threat categories</div>
          <div className="hz-cat-grid">
            {cats.map(cat => <CategoryCard key={cat.key} cat={cat} />)}
          </div>
        </>
      ) : (
        <div className="hz-insight-empty">
          No category data available for this month yet.
          Run the pipeline to populate this view.
        </div>
      )}
    </div>
  );
}

// ── Quarter view (placeholder) ────────────────────────────────────────────────

function QuarterView() {
  return (
    <div className="hz-insight-view">
      <StatBlock stats={[
        { value: "—", label: "Total sources (90d)" },
        { value: "—", label: "Unique publishers" },
        { value: "—", label: "Peak week" },
        { value: "—", label: "Trend direction" },
      ]} />
      <div className="hz-insight-section-title">90-day threat landscape</div>
      <div className="hz-finding-list">
        <FindingCard
          color={CAT_COLOR.traditional_ai_threats}
          label="Traditional AI Threats"
          finding="Quarterly trend data for adversarial ML, model extraction, and data poisoning will be synthesised here."
          note="Placeholder — requires 90-day pipeline analysis"
        />
        <FindingCard
          color={CAT_COLOR.llm_threats}
          label="LLM Threats"
          finding="Prompt injection and jailbreak activity trends across the past quarter will appear here."
          note="Placeholder — requires 90-day pipeline analysis"
        />
        <FindingCard
          color={CAT_COLOR.agentic_ai_threats}
          label="Agentic AI Threats"
          finding="MCP vulnerability and autonomous agent abuse patterns over the past 90 days."
          note="Placeholder — requires 90-day pipeline analysis"
        />
        <FindingCard
          color={CAT_COLOR.ai_enabled_threats}
          label="AI-Enabled Threats"
          finding="Deepfake, AI phishing, and voice cloning incident volume across the past quarter."
          note="Placeholder — requires 90-day pipeline analysis"
        />
      </div>
      <div className="hz-insight-placeholder-banner">
        Quarterly synthesis requires the L6 pipeline to run across the 90-day window.
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function OverviewPage({ data, loading }) {
  const [view, setView] = useState("month");

  return (
    <div className="hz-overview-page">
      <div className="hz-overview-header">
        <div>
          <h1 className="hz-page-title">AI Threat Landscape</h1>
          <p className="hz-page-sub">Horizon scan overview across time windows</p>
        </div>
        <PeriodSwitcher value={view} onChange={setView} />
      </div>

      {view === "week"    && <WeekView />}
      {view === "month"   && <MonthView data={data} loading={loading} />}
      {view === "quarter" && <QuarterView />}
    </div>
  );
}
