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

// Short labels for the compact summary stat row (avoids ambiguous single words).
const CAT_SHORT = {
  traditional_ai_threats: "Traditional AI",
  llm_threats:            "LLM",
  agentic_ai_threats:     "Agentic",
  ai_enabled_threats:     "AI-Enabled",
};

// Importance tier — how consequential a source is (from the API, deterministic).
const TIER_META = {
  realized:  { label: "In the wild",  color: "#b91c1c", bg: "#fee2e2" },
  proven:    { label: "Demonstrated", color: "#c2410c", bg: "#ffedd5" },
  research:  { label: "Research",     color: "#1d4ed8", bg: "#dbeafe" },
};
function ImportanceBadge({ tier }) {
  const m = TIER_META[tier];
  if (!m) return null;
  return (
    <span className="hz-imp-badge" title={`Importance: ${m.label}`}
      style={{ color: m.color, background: m.bg, fontSize: "0.6rem" }}>
      {m.label}
    </span>
  );
}

const WINDOWS = [
  { id: "week",    label: "Last Week"    },
  { id: "month",   label: "Last Month"   },
  { id: "quarter", label: "Last Quarter" },
  { id: "annual",  label: "2025 Q3 – 2026 Q2" },
];

const WINDOW_NOUN = { week: "Week", month: "Month", quarter: "Quarter", annual: "Annual" };

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

// ── Confidence chip + evidence-maturity bar ─────────────────────────────────────

const MATURITY_RUNGS = [
  { key: "research",        label: "Research",       color: "#94a3b8" },
  { key: "vulnerabilities", label: "Vulnerabilities",color: "#f59e0b" },
  { key: "exploitation",    label: "Exploited",      color: "#ef4444" },
  { key: "incidents",       label: "Incidents",      color: "#b91c1c" },
  { key: "operational",     label: "Operational",    color: "#7f1d1d" },
];

function MaturityBar({ maturity }) {
  const m = maturity || {};
  const ladder = MATURITY_RUNGS.map(r => ({ ...r, n: m[r.key] || 0 }));
  const sum = ladder.reduce((s, r) => s + r.n, 0);
  if (!sum) return null;
  return (
    <div className="hz-maturity">
      <div className="hz-maturity-bar">
        {ladder.filter(r => r.n > 0).map(r => (
          <span key={r.key} className="hz-maturity-seg"
            style={{ flexGrow: r.n, background: r.color }}
            title={`${r.label}: ${r.n}`} />
        ))}
      </div>
      <div className="hz-maturity-legend">
        {ladder.filter(r => r.n > 0).map(r => (
          <span key={r.key} className="hz-maturity-legend-item">
            <span className="hz-maturity-dot" style={{ background: r.color }} />
            {r.label} {r.n}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Insight item — terse by default, expandable on click ──────────────────────


// Split a "so what" paragraph into digestible points. Prefer explicit sentence
// boundaries; keep each point substantive (drop tiny fragments).
function toPoints(text) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.;])\s+(?=[A-Z0-9"'(])/)
    .map(s => s.trim().replace(/[.;]\s*$/, ""))
    .filter(s => s.length > 12);
}

function InsightItem({ p }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const headlineRef = useRef(null);

  const sources = Array.isArray(p.sources) ? p.sources.filter(s => s && s.url) : [];
  const points  = toPoints(p.implication);
  const hasDetail = points.length > 0 || sources.length > 0;
  // The headline is clamped to 3 lines at rest. If the text overflows that clamp,
  // the item must be expandable even without detail fields — otherwise the full
  // insight is unreadable (cut off with "…" and no way to open it).
  const expandable = hasDetail || clamped;

  useEffect(() => {
    const el = headlineRef.current;
    if (!el) return;
    // scrollHeight exceeds clientHeight only when the 3-line clamp actually hides text.
    setClamped(el.scrollHeight - el.clientHeight > 1);
  }, [p.insight]);

  return (
    <li
      className={`hz-insight-item${expandable ? " expandable" : ""}${open ? " open" : ""}`}
      onClick={expandable ? () => setOpen(o => !o) : undefined}
    >
      <div className="hz-insight-headline" ref={headlineRef}>{p.insight}</div>
      {open && hasDetail && (
        <div className="hz-insight-detail-inner">
          {points.length > 0 && (
            <div className="hz-insight-line">
              <span className="hz-insight-tag">So what</span>
              <ul className="hz-insight-points">
                {points.map((pt, i) => <li key={i}>{pt}</li>)}
              </ul>
            </div>
          )}
          {sources.length > 0 && (
            <div className="hz-insight-line hz-insight-evidence">
              <span className="hz-insight-tag">Evidence</span>
              <ul className="hz-insight-sources">
                {sources.map((s, i) => (
                  <li key={i}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.title || s.url}
                    </a>
                    {(s.publisher || s.date) && (
                      <span className="hz-insight-source-meta">
                        {" · "}{[s.publisher, s.date].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Category card ─────────────────────────────────────────────────────────────

function CategoryCard({ cat, trendValues }) {
  const color = CAT_COLOR[cat.key];
  const count = cat.source_count ?? 0;
  const insights = cat.insights || [];

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

        <MaturityBar maturity={cat.evidence_maturity} />

        {insights.length > 0 && (
          <div className="hz-cat-card-insight">
            {cat.insight_from && (
              <div className="hz-cat-card-insight-from">{cat.insight_from}</div>
            )}
            <ul className="hz-insight-list">
              {insights.slice(0, 2).map((p, i) => (
                <InsightItem key={i} p={p} />
              ))}
            </ul>
          </div>
        )}

        {insights.length === 0 && count > 0 && (
          <div className="hz-cat-card-empty">No analysis generated for this period yet.</div>
        )}
        {count === 0 && (
          <div className="hz-cat-card-empty">No sources this period.</div>
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
                <span className="hz-incident-rank">{i + 1}</span>
                {inc.url ? (
                  <a href={inc.url} target="_blank" rel="noopener noreferrer">{inc.title}</a>
                ) : inc.title}
              </div>
              {/* Editor's justification — why this is a top source this period */}
              {inc.why && <div className="hz-incident-why">{inc.why}</div>}
              <div className="hz-incident-meta">
                <ImportanceBadge tier={inc.importance} />
                <span className="hz-incident-publisher">{inc.publisher}</span>
                <span className="hz-incident-date">{inc.date}</span>
                <span className="hz-incident-cat" style={{ color }}>{CAT_LABEL[inc.category] || inc.category}</span>
                <span className={`hz-trust-badge ${trust.cls}`}>{trust.label}</span>
              </div>
              {inc.summary && !inc.why && <div className="hz-incident-summary">{inc.summary}</div>}
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


// Taxonomy: one section per main category (4), each listing only its own tags
// with that category's source count. Click a tag to explore its sources.
function TaxonomyHeatmap({ tagMatrix, onSelect, selected }) {
  const { tags = [], by_category = {}, defense = {} } = tagMatrix || {};
  if (!tags.length) return <p className="hz-overview-empty">No taxonomy data for this period.</p>;

  const grouped = DOMAINS.map(d => ({
    ...d,
    // count = attack sources (defenses excluded); defCount = defensive sources
    // that defend against this technique (shown as a separate badge).
    tags: tags
      .filter(t => t.domain === d.key)
      .map(t => ({ ...t, count: by_category[t.id]?.[d.key] || 0, defCount: defense[t.id]?.[d.key] || 0 }))
      .sort((a, b) => b.count - a.count),
  })).filter(d => d.tags.length > 0);

  return (
    <div className="hz-taxonomy-cats">
      {grouped.map(domain => (
        <div key={domain.key} className="hz-taxonomy-cat">
          <div className="hz-taxonomy-cat-head" style={{ borderColor: CAT_COLOR[domain.key] }}>
            <span className="hz-taxonomy-cat-name" style={{ color: CAT_COLOR[domain.key] }}>
              {CAT_LABEL[domain.key] || domain.label}
            </span>
          </div>
          <div className="hz-taxonomy-tags">
            {domain.tags.map(tag => {
              const active = selected?.tag === tag.id;
              const clickable = tag.count > 0;
              return (
                <button
                  key={tag.id}
                  className={`hz-taxonomy-tag${active ? " active" : ""}${clickable ? " clickable" : ""}`}
                  style={active ? { borderColor: CAT_COLOR[domain.key] } : undefined}
                  title={clickable
                    ? `View ${tag.count} attack source${tag.count !== 1 ? "s" : ""} tagged ${tag.label}${tag.defCount ? ` · ${tag.defCount} defensive` : ""}`
                    : (tag.defCount ? `${tag.defCount} defensive source${tag.defCount !== 1 ? "s" : ""}, no attack evidence` : tag.id)}
                  onClick={clickable ? () => onSelect(tag, domain.key) : undefined}
                  disabled={!clickable}
                >
                  <span className="hz-taxonomy-tag-label">{tag.label}</span>
                  <span className="hz-taxonomy-tag-count">{tag.count}</span>
                  {tag.defCount > 0 && (
                    <span className="hz-taxonomy-tag-def" title={`${tag.defCount} defensive source${tag.defCount !== 1 ? "s" : ""}`}>
                      🛡{tag.defCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tag drilldown panel (inline source explorer) ───────────────────────────────

function TagDrilldownPanel({ tag, category, tagSources, onClose }) {
  if (!tag) return null;
  const all = tagSources?.[tag.id] || [];
  const rows = category ? all.filter(s => s.category === category) : all;
  const catLabel = category ? (CAT_LABEL[category] || category) : null;

  return (
    <div className="hz-tag-drilldown">
      <div className="hz-tag-drilldown-header">
        <div>
          <span className="hz-tag-drilldown-title">{tag.label}</span>
          {catLabel && (
            <span className="hz-tag-drilldown-cat" style={{ color: CAT_COLOR[category] }}>
              {" "}· {catLabel}
            </span>
          )}
          <span className="hz-tag-drilldown-count"> · {rows.length} source{rows.length !== 1 ? "s" : ""}</span>
        </div>
        <button className="hz-tag-drilldown-close" onClick={onClose} title="Close">✕</button>
      </div>

      {rows.length === 0 ? (
        <p className="hz-overview-empty">No sources for this selection in this period.</p>
      ) : (
        <ul className="hz-tag-drilldown-list">
          {rows.map((s, i) => {
            const color = CAT_COLOR[s.category] || "#64748b";
            return (
              <li key={i} className="hz-tag-drilldown-row">
                <span className="hz-incident-dot" style={{ background: color }} />
                <div className="hz-tag-drilldown-body">
                  <div className="hz-tag-drilldown-src-title">
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>
                    ) : (s.title || "Untitled")}
                  </div>
                  <div className="hz-incident-meta">
                    {s.publisher && <span className="hz-incident-publisher">{s.publisher}</span>}
                    {s.date && <span className="hz-incident-date">{s.date}</span>}
                    {!category && (
                      <span className="hz-incident-cat" style={{ color }}>
                        {CAT_LABEL[s.category] || s.category}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
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
  const [tagSelection, setTagSelection] = useState(null); // { tag, category }
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
    setTagSelection(null); // drilldown is window-scoped; clear when switching
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
              {data.date_from && data.date_to
                ? `${data.date_from} → ${data.date_to}, SGT`
                : data.window_label}
              {" · "}{data.summary?.total ?? 0} sources
              {lastFetch && (
                <span className="hz-overview-refresh-ts">
                  {" "}· {lastFetch.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </p>
          )}
          {data && !loading && data.insights_stale && (
            <p className="hz-overview-stale-note">
              ⚠ No insights generated for this period yet — showing the most recent available analysis.
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
            <span className="hz-insight-stat-label">Sources</span>
          </div>
          {Object.entries(CAT_COLOR).map(([key, color]) => (
            <div key={key} className="hz-insight-stat">
              <span className="hz-insight-stat-value" style={{ color }}>
                {data.summary?.by_category?.[key] ?? "—"}
              </span>
              <span className="hz-insight-stat-label">{CAT_SHORT[key] || CAT_LABEL[key]}</span>
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
          <div className="hz-overview-section-title">
            {data.window === "annual" ? "Monthly source volume" : "Weekly source volume"}
          </div>
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
            <span className="hz-overview-section-note">
              {data.top_sources_justified
                ? "editor-selected & ranked from this period's analysis — most consequential first"
                : "ranked by importance — in-the-wild incidents first, then demonstrated, then research"}
            </span>
          </div>
          <TopIncidents incidents={data.top_incidents} />
        </>
      )}

      {/* Taxonomy heatmap */}
      {data && (
        <>
          <div className="hz-overview-section-title">
            Taxonomy coverage
            <span className="hz-overview-section-note">sources per technique × category · click a cell or technique to explore</span>
          </div>
          <TaxonomyHeatmap
            tagMatrix={data.tag_matrix}
            selected={tagSelection ? { tag: tagSelection.tag.id, category: tagSelection.category } : null}
            onSelect={(tag, category) => setTagSelection({ tag, category })}
          />
          {tagSelection && (
            <TagDrilldownPanel
              tag={tagSelection.tag}
              category={tagSelection.category}
              tagSources={data.tag_matrix?.sources}
              onClose={() => setTagSelection(null)}
            />
          )}
        </>
      )}

    </div>
  );
}
