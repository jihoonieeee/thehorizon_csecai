/**
 * OverviewPage — AI threat landscape with real data for all time windows.
 * All content sourced from Supabase — no generated summaries.
 * Auto-refreshes every 5 minutes while the page is open.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchOverview } from "../../api/dashboardApi.js";

const CAT_COLOR = {
  traditional_ai_threats: "#3583C9",
  llm_threats:            "#9C62A7",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

const DOMAIN_COLOR = {
  traditional_ai_threats: "#3583C9",
  llm_threats:            "#9C62A7",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

const TRUST_BADGE = {
  primary:  { label: "Primary",  cls: "hz-trust-primary"  },
  high:     { label: "High",     cls: "hz-trust-high"     },
  curated:  { label: "Curated",  cls: "hz-trust-curated"  },
  medium:   { label: "Medium",   cls: "hz-trust-medium"   },
  low:      { label: "Low",      cls: "hz-trust-low"      },
  unknown:  { label: "Unknown",  cls: "hz-trust-unknown"  },
};

const CAT_LABEL = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const WINDOWS = [
  { id: "week",    label: "This Week"   },
  { id: "month",   label: "This Month"  },
  { id: "quarter", label: "Last 90 Days" },
];

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ── Sparkline ──────────────────────────────────────────────────────────────────

function Sparkline({ values, color, width = 90, height = 32 }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - Math.round((v / max) * (height - 4)) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1];
  const [lx, ly] = last.split(",").map(Number);
  const area =
    `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(" ") +
    ` L${((values.length - 1) * step).toFixed(1)},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
      <path d={area} fill={color} opacity="0.13" />
      <polyline points={pts.join(" ")} stroke={color} strokeWidth="1.5"
        fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.5" fill={color} />
    </svg>
  );
}

// ── Multi-line trend chart ─────────────────────────────────────────────────────

function TrendChart({ trend }) {
  const { week_labels = [], by_category = {} } = trend || {};
  if (!week_labels.length) return null;

  const W = 600, H = 160, PAD_L = 28, PAD_B = 24, PAD_T = 10, PAD_R = 12;
  const gW = W - PAD_L - PAD_R;
  const gH = H - PAD_B - PAD_T;

  const cats = Object.keys(CAT_COLOR);
  const allVals = cats.flatMap(c => by_category[c] || []);
  const maxVal  = Math.max(...allVals, 1);

  const n = week_labels.length;
  const xPos = (i) => PAD_L + (i / (n - 1)) * gW;
  const yPos = (v) => PAD_T + gH - (v / maxVal) * gH;

  // Y-axis ticks
  const yTicks = [0, Math.round(maxVal / 2), maxVal].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {/* Grid lines */}
      {yTicks.map(v => (
        <g key={v}>
          <line
            x1={PAD_L} y1={yPos(v)} x2={W - PAD_R} y2={yPos(v)}
            stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3 3"
          />
          <text x={PAD_L - 4} y={yPos(v) + 4} textAnchor="end"
            fontSize="9" fill="#9ca3af">{v}</text>
        </g>
      ))}

      {/* X labels: show every 2nd */}
      {week_labels.map((lbl, i) => (i % 2 === 1) && (
        <text key={i} x={xPos(i)} y={H - 4} textAnchor="middle"
          fontSize="9" fill="#9ca3af">{lbl}</text>
      ))}

      {/* Category lines */}
      {cats.map(cat => {
        const vals  = by_category[cat] || [];
        if (!vals.length) return null;
        const color = CAT_COLOR[cat];
        const pts   = vals.map((v, i) => `${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`);
        const area  = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(" ") +
          ` L${xPos(n-1).toFixed(1)},${yPos(0).toFixed(1)} L${xPos(0).toFixed(1)},${yPos(0).toFixed(1)} Z`;
        return (
          <g key={cat}>
            <path d={area} fill={color} opacity="0.06" />
            <polyline points={pts.join(" ")} stroke={color} strokeWidth="1.8"
              fill="none" strokeLinejoin="round" strokeLinecap="round" />
            <circle
              cx={xPos(n-1)} cy={yPos(vals[n-1] || 0)} r="3"
              fill={color} stroke="#fff" strokeWidth="1.5"
            />
          </g>
        );
      })}
    </svg>
  );
}

// ── Category card ─────────────────────────────────────────────────────────────

function CategoryCard({ cat, trendValues }) {
  const [open, setOpen] = useState(false);
  const color = CAT_COLOR[cat.key];
  const count = cat.source_count ?? 0;
  const hasTop = (cat.top_sources || []).length > 0;

  return (
    <div className="hz-cat-card" style={{ "--cat-color": color }}>
      <div className="hz-cat-card-strip" style={{ background: color }} />
      <div className="hz-cat-card-body">
        <div className="hz-cat-card-header">
          <div>
            <div className="hz-cat-card-count">{count}</div>
            <div className="hz-cat-card-count-label">sources</div>
          </div>
          {trendValues && (
            <Sparkline values={trendValues} color={color} width={80} height={28} />
          )}
        </div>

        <div className="hz-cat-card-name">{cat.label}</div>

        {cat.insight_points?.length > 0 && (
          <div className="hz-cat-card-insight">
            {cat.insight_from && (
              <div className="hz-cat-card-insight-from">From {cat.insight_from}</div>
            )}
            <ul className="hz-cat-card-insight-list">
              {cat.insight_points.map((pt, i) => (
                <li key={i}>{pt}</li>
              ))}
            </ul>
          </div>
        )}

        {count === 0 && (
          <div className="hz-cat-card-empty">No sources this period.</div>
        )}

        {hasTop && (
          <button className="hz-cat-card-toggle" onClick={() => setOpen(o => !o)}>
            {open ? "Hide sources ▲" : `Top sources ▼`}
          </button>
        )}

        {open && hasTop && (
          <ul className="hz-cat-card-sources">
            {cat.top_sources.slice(0, 5).map((s, i) => (
              <li key={i}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title || s.url}
                  </a>
                ) : (
                  <span>{s.title}</span>
                )}
                {s.publisher && <span className="hz-cat-card-pub"> · {s.publisher}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Top incidents ─────────────────────────────────────────────────────────────

function TopIncidents({ incidents }) {
  if (!incidents?.length) return (
    <p className="hz-overview-empty">No high-trust sources in this period.</p>
  );

  return (
    <div className="hz-incidents-list">
      {incidents.map((inc, i) => {
        const color  = CAT_COLOR[inc.category] || "#64748b";
        const trust  = TRUST_BADGE[inc.trust_tier] || TRUST_BADGE.unknown;
        return (
          <div key={i} className="hz-incident-row">
            <div className="hz-incident-dot" style={{ background: color }} />
            <div className="hz-incident-body">
              <div className="hz-incident-title">
                {inc.url ? (
                  <a href={inc.url} target="_blank" rel="noopener noreferrer">{inc.title}</a>
                ) : inc.title}
              </div>
              <div className="hz-incident-meta">
                <span className="hz-incident-publisher">{inc.publisher}</span>
                <span className="hz-incident-date">{inc.date}</span>
                <span className="hz-incident-cat" style={{ color }}>{CAT_LABEL[inc.category] || inc.category}</span>
                <span className={`hz-trust-badge ${trust.cls}`}>{trust.label}</span>
              </div>
              {inc.summary && <div className="hz-incident-summary">{inc.summary}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Taxonomy heatmap ──────────────────────────────────────────────────────────

const DOMAINS = [
  { key: "traditional_ai_threats", prefix: "TAI", label: "Traditional AI"  },
  { key: "llm_threats",            prefix: "LLM", label: "LLM"            },
  { key: "agentic_ai_threats",     prefix: "ASI", label: "Agentic AI"     },
  { key: "ai_enabled_threats",     prefix: "AE",  label: "AI-Enabled"     },
];

const CAT_HEADERS = [
  { key: "traditional_ai_threats", short: "Traditional" },
  { key: "llm_threats",            short: "LLM"         },
  { key: "agentic_ai_threats",     short: "Agentic"     },
  { key: "ai_enabled_threats",     short: "AI-Enabled"  },
];

function cellIntensity(count, maxCount) {
  if (!count || !maxCount) return 0;
  return Math.min(count / maxCount, 1);
}

function TaxonomyHeatmap({ tagMatrix }) {
  const { tags = [], by_category = {} } = tagMatrix || {};
  if (!tags.length) return <p className="hz-overview-empty">No taxonomy data for this period.</p>;

  // Find global max for colour scaling
  const allCounts = tags.flatMap(t => CAT_HEADERS.map(c => by_category[t.id]?.[c.key] || 0));
  const maxCount  = Math.max(...allCounts, 1);

  // Group tags by domain
  const grouped = DOMAINS.map(d => ({
    ...d,
    tags: tags.filter(t => t.domain === d.key),
  })).filter(d => d.tags.length > 0);

  return (
    <div className="hz-heatmap-wrap">
      <table className="hz-heatmap-table">
        <thead>
          <tr>
            <th className="hz-heatmap-th-label">Technique</th>
            {CAT_HEADERS.map(c => (
              <th key={c.key} className="hz-heatmap-th-cat">
                <span style={{ color: CAT_COLOR[c.key] }}>{c.short}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grouped.map(domain => (
            <>
              <tr key={`domain-${domain.key}`} className="hz-heatmap-domain-row">
                <td colSpan={5} className="hz-heatmap-domain-label"
                  style={{ color: DOMAIN_COLOR[domain.key] }}>
                  {domain.label}
                </td>
              </tr>
              {domain.tags.map(tag => {
                const rowTotal = CAT_HEADERS.reduce((s, c) => s + (by_category[tag.id]?.[c.key] || 0), 0);
                return (
                  <tr key={tag.id} className="hz-heatmap-row">
                    <td className="hz-heatmap-td-label" title={tag.id}>
                      {tag.label}
                    </td>
                    {CAT_HEADERS.map(c => {
                      const count = by_category[tag.id]?.[c.key] || 0;
                      const alpha = cellIntensity(count, maxCount);
                      const color = CAT_COLOR[c.key];
                      const bg = alpha > 0
                        ? `${color}${Math.round(alpha * 200).toString(16).padStart(2, "0")}`
                        : "transparent";
                      return (
                        <td key={c.key} className="hz-heatmap-td-cell"
                          style={{ background: bg }}
                          title={`${tag.label} × ${CAT_HEADERS.find(h => h.key === c.key)?.short}: ${count} source${count !== 1 ? "s" : ""}`}>
                          {count > 0 ? count : ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function OverviewPage() {
  const [win,     setWin]     = useState("quarter");
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback((w) => {
    setLoading(true);
    setError(null);
    fetchOverview(w)
      .then(d => { setData(d); setLoading(false); setLastFetch(new Date()); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // Initial load and window change
  useEffect(() => {
    load(win);
  }, [win, load]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    timerRef.current = setInterval(() => load(win), REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [win, load]);

  const trend     = data?.trend;
  const catTrend  = (key) => trend?.by_category?.[key] || [];

  return (
    <div className="hz-overview-page">

      {/* Header */}
      <div className="hz-overview-header">
        <div>
          <h1 className="hz-page-title">AI Threat Landscape</h1>
          {data && !loading && (
            <p className="hz-page-sub">
              {data.window_label} · {data.summary?.total ?? 0} validated sources
              {lastFetch && (
                <span className="hz-overview-refresh-ts">
                  {" "}· Updated {lastFetch.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </p>
          )}
          {loading && <p className="hz-page-sub">Loading…</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="hz-seg-group">
            {WINDOWS.map(o => (
              <button
                key={o.id}
                className={`hz-seg-btn${win === o.id ? " active" : ""}`}
                onClick={() => setWin(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            className="hz-overview-refresh-btn"
            onClick={() => load(win)}
            disabled={loading}
            title="Refresh now"
          >
            ↺
          </button>
        </div>
      </div>

      {error && (
        <div className="hz-overview-error">
          Failed to load data: {error}. Make sure the API server is running.
        </div>
      )}

      {/* Summary stat row */}
      {data && !loading && (
        <div className="hz-insight-stats">
          <div className="hz-insight-stat">
            <span className="hz-insight-stat-value">{data.summary?.total ?? "—"}</span>
            <span className="hz-insight-stat-label">Total sources</span>
          </div>
          <div className="hz-insight-stat">
            <span className="hz-insight-stat-value">{data.summary?.high_trust ?? "—"}</span>
            <span className="hz-insight-stat-label">High-trust</span>
          </div>
          {Object.entries(CAT_COLOR).map(([key, color]) => (
            <div key={key} className="hz-insight-stat">
              <span className="hz-insight-stat-value" style={{ color }}>
                {data.summary?.by_category?.[key] ?? "—"}
              </span>
              <span className="hz-insight-stat-label">{CAT_LABEL[key]?.split(" ")[0]}</span>
            </div>
          ))}
        </div>
      )}

      {/* Category cards */}
      {data && (
        <>
          <div className="hz-overview-section-title">Threat categories</div>
          <div className="hz-cat-grid">
            {(data.categories || []).map(cat => (
              <CategoryCard
                key={cat.key}
                cat={cat}
                trendValues={catTrend(cat.key)}
              />
            ))}
          </div>
        </>
      )}

      {/* Trend chart */}
      {data?.trend?.week_labels?.length > 1 && (
        <>
          <div className="hz-overview-section-title">Weekly source volume (12 weeks)</div>
          <div className="hz-trend-panel">
            <TrendChart trend={data.trend} />
            <div className="hz-trend-legend">
              {Object.entries(CAT_COLOR).map(([key, color]) => (
                <div key={key} className="hz-trend-legend-item">
                  <span className="hz-trend-legend-dot" style={{ background: color }} />
                  <span>{CAT_LABEL[key]}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Top incidents */}
      {data && (
        <>
          <div className="hz-overview-section-title">
            Top sources
            <span className="hz-overview-section-note">primary, high, and curated trust tiers · newest first</span>
          </div>
          <TopIncidents incidents={data.top_incidents} />
        </>
      )}

      {/* Taxonomy heatmap */}
      {data && (
        <>
          <div className="hz-overview-section-title">
            Taxonomy coverage
            <span className="hz-overview-section-note">sources per technique × category</span>
          </div>
          <TaxonomyHeatmap tagMatrix={data.tag_matrix} />
        </>
      )}

    </div>
  );
}
