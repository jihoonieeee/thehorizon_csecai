/**
 * Overview — 4 category cards, summary bar, and weekly sparkline.
 */

// Category colors: keep the brand palette
const CAT_COLOR = {
  traditional_ai_threats: "#3583C9",
  llm_threats:            "#9C62A7",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

// ── Inline SVG sparkline ──────────────────────────────────────────────────────

function Sparkline({ values, color, width = 100, height = 36 }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - Math.round((v / max) * (height - 4)) - 2;
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  // Area fill path
  const areaPath =
    `M${pts[0]} ` +
    pts.slice(1).map((p) => `L${p}`).join(" ") +
    ` L${(values.length - 1) * step},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
    >
      <path d={areaPath} fill={color} opacity="0.12" />
      <polyline points={polyline} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      {/* Last dot */}
      {(() => {
        const lastX = (values.length - 1) * step;
        const lastY = height - Math.round((values[values.length - 1] / max) * (height - 4)) - 2;
        return <circle cx={lastX} cy={lastY} r="2.5" fill={color} />;
      })()}
    </svg>
  );
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function ConfBadge({ confidence }) {
  const cls = confidence === "high" ? "high"
    : confidence === "medium" ? "medium"
    : confidence === "low"    ? "low"
    : "assessed";
  return <span className={`hz-conf ${cls}`}>{confidence || "—"}</span>;
}

// ── Category card ─────────────────────────────────────────────────────────────

function CategoryCard({ cat }) {
  const color    = CAT_COLOR[cat.key || cat.id] || "#64748b";
  const isGap    = cat.assessed === false || cat.assessment_status === "evidence_insufficient";
  const count    = cat.source_count ?? 0;
  const monthly  = cat.monthly_counts;

  return (
    <div className="hz-cat-card" style={{ opacity: isGap ? 0.7 : 1 }}>
      {/* Color strip */}
      <div className="hz-cat-card-strip" style={{ background: color }} />

      {/* Top row: count + confidence */}
      <div className="hz-cat-card-top">
        <div>
          <div className="hz-cat-card-count">{count}</div>
          <div className="hz-cat-card-count-label">sources</div>
        </div>
        <ConfBadge confidence={cat.confidence} />
      </div>

      {/* Name */}
      <div className="hz-cat-card-name">{cat.label}</div>

      {/* Headline */}
      {cat.headline && (
        <div className="hz-cat-card-headline">{cat.headline}</div>
      )}

      {/* Top signal */}
      {!isGap && cat.top_signal && (
        <div
          className="hz-cat-card-signal"
          style={{ borderLeftColor: `${color}60` }}
        >
          {cat.top_signal}
        </div>
      )}

      {/* Footer: claim counts + sparkline */}
      <div className="hz-cat-card-footer">
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {(cat.claim_counts?.critical || 0) > 0 && (
            <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "#dc2626", background: "#fee2e2", padding: "1px 7px", borderRadius: "10px" }}>
              {cat.claim_counts.critical} critical
            </span>
          )}
          {(cat.claim_counts?.high || 0) > 0 && (
            <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "#d97706", background: "#fef9c3", padding: "1px 7px", borderRadius: "10px" }}>
              {cat.claim_counts.high} high
            </span>
          )}
          {(cat.claim_counts?.medium || 0) > 0 && (
            <span style={{ fontSize: "0.68rem", fontWeight: 600, color: "#475569", background: "#f1f5f9", padding: "1px 7px", borderRadius: "10px" }}>
              {cat.claim_counts.medium} medium
            </span>
          )}
        </div>
        {monthly && monthly.length > 1 && (
          <Sparkline values={monthly} color={color} width={80} height={32} />
        )}
      </div>
    </div>
  );
}

// ── Weekly trend sparkline card ───────────────────────────────────────────────

function TrendCard({ trend }) {
  const values = trend?.total_sources;
  if (!values || values.length === 0) return null;

  const weeks = values.length;
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div className="hz-trend-card">
      <div className="hz-trend-header">
        <span className="hz-trend-title">Weekly source volume</span>
        <span className="hz-trend-sub">{weeks} weeks / {total} total</span>
      </div>
      <svg
        width="100%"
        height="64"
        viewBox={`0 0 ${weeks} 64`}
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
      >
        {values.map((v, i) => {
          const max = Math.max(...values, 1);
          const h = Math.max(2, Math.round((v / max) * 56));
          const x = i * (100 / weeks);
          const w = (100 / weeks) - 0.5;
          return (
            <rect
              key={i}
              x={`${x}%`}
              y={64 - h}
              width={`${w}%`}
              height={h}
              rx="1"
              fill={i === values.length - 1 ? "#2563eb" : "#93c5fd"}
              opacity={i === values.length - 1 ? 0.9 : 0.5}
            >
              <title>{`Week ${i + 1}: ${v} sources`}</title>
            </rect>
          );
        })}
      </svg>
      {/* Week labels — first and last */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
        <span style={{ fontSize: "0.68rem", color: "var(--text-tertiary)" }}>12 weeks ago</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-tertiary)" }}>This week</span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function OverviewPage({ data }) {
  if (!data) return null;

  const { summary, categories = [], trend } = data;

  // Normalise categories — handle both dashboard API shape (key) and mock shape (id)
  const cats = categories.map((c) => ({
    ...c,
    key: c.key || c.id,
  }));

  const periodLabel = summary?.period_label || data.period || "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>

      {/* Page heading */}
      <div>
        <h1 className="hz-page-title">AI Threat Landscape</h1>
        <p className="hz-page-sub">{periodLabel} — {summary?.executive_headline || "Horizon scan overview"}</p>
      </div>

      {/* Summary bar */}
      <div className="hz-summary-bar">
        <div className="hz-summary-stat">
          <span className="hz-summary-stat-value">{summary?.total_sources ?? "—"}</span>
          <span className="hz-summary-stat-label">Sources</span>
        </div>
        <div className="hz-summary-divider" />
        <div className="hz-summary-stat">
          <span className="hz-summary-stat-value">{summary?.sources_validated ?? "—"}</span>
          <span className="hz-summary-stat-label">Validated</span>
        </div>
        <div className="hz-summary-divider" />
        <div className="hz-summary-stat">
          <span className="hz-summary-stat-value">{summary?.categories_assessed ?? cats.length}</span>
          <span className="hz-summary-stat-label">Categories assessed</span>
        </div>
        {summary?.date_range?.start && (
          <>
            <div className="hz-summary-divider" />
            <div className="hz-summary-stat">
              <span className="hz-summary-stat-value" style={{ fontSize: "0.9rem" }}>
                {summary.date_range.start} – {summary.date_range.end}
              </span>
              <span className="hz-summary-stat-label">Date window</span>
            </div>
          </>
        )}
        {summary?.caveat && (
          <div style={{ marginLeft: "auto", maxWidth: 380, fontSize: "0.75rem", color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "4px 10px", lineHeight: 1.4 }}>
            {summary.caveat}
          </div>
        )}
      </div>

      {/* 4 category cards */}
      <section>
        <p className="hz-section-title">Threat categories</p>
        <div className="hz-cat-grid">
          {cats.map((cat) => (
            <CategoryCard key={cat.key || cat.id} cat={cat} />
          ))}
        </div>
      </section>

      {/* Weekly trend */}
      {trend?.total_sources && (
        <TrendCard trend={trend} />
      )}
      {/* six_month_trend from mock data */}
      {!trend?.total_sources && data.six_month_trend?.total_sources && (
        <TrendCard trend={{ total_sources: data.six_month_trend.total_sources }} />
      )}

    </div>
  );
}
