/**
 * OverviewPage — AI threat landscape with real data for all time windows.
 * All content sourced from Supabase — no generated summaries.
 * Auto-refreshes every 5 minutes while the page is open.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchOverview } from "../../api/dashboardApi.js";
import { useAuth } from "../../AuthContext.jsx";
import { getSessionToken, getAccessLevel } from "../../auth.js";

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

// Short labels for the compact summary stat row (avoids ambiguous single words).
const CAT_SHORT = {
  traditional_ai_threats: "Traditional AI",
  llm_threats:            "LLM",
  agentic_ai_threats:     "Agentic",
  ai_enabled_threats:     "AI-Enabled",
};

// Unified 4-level maturity ladder — used for both the category bar and per-source badge.
// Mirrors MATURITY_RUNGS in lib/dashboard/evidenceMaturity.js.
const MATURITY_META = {
  research:    { label: "Research",    color: "#64748b", bg: "#f1f5f9" },
  validated:   { label: "Validated",   color: "#b45309", bg: "#fef3c7" },
  observed:    { label: "Observed",    color: "#dc2626", bg: "#fee2e2" },
  operational: { label: "Operational", color: "#7f1d1d", bg: "#fecaca" },
};
function MaturityBadge({ level }) {
  const m = MATURITY_META[level];
  if (!m) return null;
  return (
    <span className="hz-imp-badge" title={`Maturity: ${m.label}`}
      style={{ color: m.color, background: m.bg, fontSize: "0.6rem" }}>
      {m.label}
    </span>
  );
}

const WINDOWS = [
  { id: "week",    label: "Last Week"    },
  { id: "month",   label: "Last Month"   },
  { id: "quarter", label: "Last Quarter" },
];

const WINDOW_NOUN = { week: "Week", month: "Month", quarter: "Quarter" };

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

// Mirrors MATURITY_RUNGS in lib/dashboard/evidenceMaturity.js
const MATURITY_RUNGS = [
  { key: "research",    label: "Research",    color: "#94a3b8" },
  { key: "validated",   label: "Validated",   color: "#f59e0b" },
  { key: "observed",    label: "Observed",    color: "#ef4444" },
  { key: "operational", label: "Operational", color: "#7f1d1d" },
];

function MaturityBar({ maturity, onSelect, selected }) {
  const m = maturity || {};
  const ladder = MATURITY_RUNGS.map(r => ({ ...r, n: m[r.key] || 0 }));
  const sum = ladder.reduce((s, r) => s + r.n, 0);
  if (!sum) return null;
  return (
    <div className="hz-maturity">
      <div className="hz-maturity-bar">
        {ladder.filter(r => r.n > 0).map(r => (
          <span key={r.key}
            className={`hz-maturity-seg${selected === r.key ? " active" : ""}${onSelect ? " clickable" : ""}`}
            style={{ flexGrow: r.n, background: r.color }}
            title={`${r.label}: ${r.n} — click to explore`}
            onClick={onSelect ? () => onSelect(r.key) : undefined}
          />
        ))}
      </div>
      <div className="hz-maturity-legend">
        {ladder.filter(r => r.n > 0).map(r => (
          <button key={r.key}
            className={`hz-maturity-legend-item${selected === r.key ? " active" : ""}${onSelect ? " clickable" : ""}`}
            onClick={onSelect ? () => onSelect(r.key) : undefined}
            title={`Explore ${r.n} ${r.label} source${r.n !== 1 ? "s" : ""}`}
          >
            <span className="hz-maturity-dot" style={{ background: r.color }} />
            {r.label} {r.n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Maturity side panel (fixed right drawer) ──────────────────────────────────
function MaturitySidePanel({ level, category, sources, onClose }) {
  if (!level || !category) return null;
  const rung  = MATURITY_RUNGS.find(r => r.key === level);
  const rows  = sources || [];
  const color = CAT_COLOR[category] || "#64748b";

  return (
    <>
      <div className="hz-side-panel-backdrop" onClick={onClose} />
      <div className="hz-side-panel">
        <div className="hz-side-panel-header">
          <div className="hz-side-panel-title-row">
            <span className="hz-maturity-dot hz-side-panel-dot" style={{ background: rung?.color }} />
            <span className="hz-side-panel-level">{rung?.label || level}</span>
            <span className="hz-side-panel-cat" style={{ color }}>
              {CAT_LABEL[category] || category}
            </span>
          </div>
          <div className="hz-side-panel-meta">{rows.length} source{rows.length !== 1 ? "s" : ""}</div>
          <button className="hz-side-panel-close" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="hz-side-panel-body">
          {rows.length === 0 ? (
            <p className="hz-overview-empty">No sources at this maturity level in this period.</p>
          ) : (
            <ul className="hz-side-panel-list">
              {rows.map((s, i) => (
                <li key={i} className="hz-side-panel-row">
                  <div className="hz-side-panel-src-title">
                    {s.url
                      ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>
                      : (s.title || "Untitled")}
                  </div>
                  <div className="hz-side-panel-src-meta">
                    {s.publisher && <span>{s.publisher}</span>}
                    {s.date      && <span>{s.date}</span>}
                  </div>
                  {s.summary && <div className="hz-side-panel-src-summary">{s.summary}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

// ── Insight item — headline always visible, drilldown expands on click ───────

// ── Source button ─────────────────────────────────────────────────────────────
// Renders one cited source as a compact clickable chip with a tooltip showing
// the verbatim quote used to ground this insight.

function SourceButton({ cs }) {
  const publisher = cs.publisher || null;
  const title     = cs.source_title || null;
  const tip       = title || cs.evidence_summary || cs.source_url;

  return (
    <a
      href={cs.source_url}
      target="_blank"
      rel="noopener noreferrer"
      className="hz-source-btn"
      title={tip}
      onClick={e => e.stopPropagation()}
    >
      {publisher && <span className="hz-source-btn-publisher">{publisher}</span>}
      {title && <span className="hz-source-btn-title">{title.length > 55 ? title.slice(0, 55) + "…" : title}</span>}
      {!publisher && !title && <span>{cs.source_url}</span>}
      <span className="hz-source-btn-arrow">↗</span>
    </a>
  );
}

// ── Insight item ──────────────────────────────────────────────────────────────
// Shape: { insight_id, title (≤12 words), insight_body (full sentence),
//           explanation_points[], evidence_maturity, is_priority, cited_sources[] }

function InsightItem({ insight, index }) {
  const [open, setOpen] = useState(false);

  const title      = insight.title || insight.insight || "";
  const body       = insight.insight_body || null;
  const maturity   = insight.evidence_maturity || null;
  const isPriority = insight.is_priority ?? false;
  const points     = Array.isArray(insight.explanation_points)
    ? insight.explanation_points.filter(p => p?.length > 3)
    : [];
  const sources    = Array.isArray(insight.cited_sources)
    ? insight.cited_sources.filter(cs => cs.source_url)
    : [];

  const hasDetail = !!(body || points.length || sources.length);
  const mat       = maturity ? MATURITY_META[maturity] : null;

  return (
    <li
      className={`hz-insight-item${hasDetail ? " expandable" : ""}${open ? " open" : ""}${isPriority ? " priority" : ""}`}
      onClick={hasDetail ? () => setOpen(o => !o) : undefined}
    >
      {/* Headline row: number badge + title + meta */}
      <div className="hz-insight-headline-row">
        <span className="hz-insight-num">{(index ?? 0) + 1}</span>
        <div className="hz-insight-headline">{title}</div>
        <div className="hz-insight-headline-meta">
          {mat && (
            <span
              className="hz-insight-maturity-pip"
              title={`Evidence maturity: ${mat.label}`}
              style={{ background: mat.color }}
            />
          )}
          {hasDetail && (
            <span className="hz-insight-chevron">{open ? "▲" : "▼"}</span>
          )}
        </div>
      </div>

      {/* Drilldown — expands on click */}
      {open && hasDetail && (
        <div className="hz-insight-drilldown">
          {body && <p className="hz-insight-body">{body}</p>}
          {points.length > 0 && (
            <ul className="hz-insight-bullets">
              {points.map((b, i) => (
                <li key={i} className="hz-insight-bullet">{b}</li>
              ))}
            </ul>
          )}
          {sources.length > 0 && (
            <div className="hz-insight-sources-row">
              {sources.map((cs, i) => (
                <SourceButton key={i} cs={cs} />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Threat maturity + priority legend (inline, above the 4 cards) ─────────────

// Worked examples and matching signals for each rung live in docs/legend.md.

const MATURITY_DEFS = [
  { key: "research",    color: "#94a3b8", label: "Research",
    desc: "The threat, attack technique, or vulnerability has been identified or demonstrated primarily through research, simulation, benchmarks, or controlled laboratory testing. There is no credible evidence of practical exploitation outside a research setting or of adversary use in the wild." },
  { key: "validated",   color: "#f59e0b", label: "Validated",
    desc: "The threat, vulnerability, or attack technique has been credibly confirmed to affect a real product, system, or implementation, or its practical feasibility has been demonstrated through a reproducible exploit, proof-of-concept, tool, or equivalent technical evidence. There is no credible evidence of adversary use in the wild." },
  { key: "observed",    color: "#ef4444", label: "Observed",
    desc: "Credible evidence confirms that the technique or exploit has been used against real-world targets outside controlled testing. At least one documented instance of attempted or successful exploitation by a threat actor has been established." },
  { key: "operational", color: "#7f1d1d", label: "Operational",
    desc: "The technique or exploit has progressed beyond isolated use and is being repeatedly, systematically, or at scale employed by one or more threat actors. Evidence indicates sustained adversary adoption, such as multiple incidents, an ongoing campaign, integration into operational tooling, or repeated use across targets." },
];

const READING_VALUE_DEFS = [
  { key: "essential",   color: "#b91c1c", label: "Essential",
    desc: "Materially changes the strategic understanding of the threat landscape or establishes a significant development not previously evidenced. Examples include the first confirmed adversary use of a consequential AI capability, authoritative evidence of a new class of threat, a landmark framework likely to shape security practice, or a multi-government advisory signalling a significant shift in strategic posture." },
  { key: "recommended", color: "#c2410c", label: "Recommended",
    desc: "Materially changes prioritisation or understanding within an established threat area. Examples include a significant technique variant supported by concrete evidence, first confirmed adversary adoption of a known technique, synthesis revealing a pattern across multiple incidents, or a substantive case study demonstrating measurable impact." },
  { key: "informative", color: "#475569", label: "Informative",
    desc: "Provides substantive technical or operational value but does not materially change strategic understanding or prioritisation. Examples include implementation mechanics, exploit details, incremental research on a well-understood technique, technical validation, or a vulnerability advisory without evidence of exploitation. Typically, practitioners may benefit from the source directly, while leadership can rely on its key findings." },
  { key: "background",  color: "#94a3b8", label: "Background",
    desc: "Provides contextual or supplementary information without materially adding to the current understanding of the threat. Examples include adjacent policy or guidance, general defensive advice, commentary without new evidence, derivative reporting, or sources substantially duplicating stronger existing coverage." },
];

function ThreatLegend({ open, onToggle }) {
  return (
    <div className="hz-threat-legend">
      <button className="hz-threat-legend-toggle" onClick={onToggle}>
        <span className="hz-threat-legend-toggle-title">Threat Maturity &amp; Reading Value Reference</span>
        <span className="hz-threat-legend-toggle-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="hz-threat-legend-body">
          <div className="hz-threat-legend-col">
            <div className="hz-threat-legend-col-title">Threat Maturity Ladder</div>
            {MATURITY_DEFS.map(m => (
              <div key={m.key} className="hz-threat-legend-row">
                <div className="hz-threat-legend-row-head">
                  <span className="hz-threat-legend-dot" style={{ background: m.color }} />
                  <span className="hz-threat-legend-row-label" style={{ color: m.color }}>{m.label}</span>
                </div>
                <div className="hz-threat-legend-row-body">
                  <div className="hz-threat-legend-row-desc">{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="hz-threat-legend-col">
            <div className="hz-threat-legend-col-title">Reading Value</div>
            {READING_VALUE_DEFS.map(p => (
              <div key={p.key} className="hz-threat-legend-row">
                <div className="hz-threat-legend-row-head">
                  <span className="hz-threat-legend-dot" style={{ background: p.color }} />
                  <span className="hz-threat-legend-row-label" style={{ color: p.color }}>{p.label}</span>
                </div>
                <div className="hz-threat-legend-row-body">
                  <div className="hz-threat-legend-row-desc">{p.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Category legend ───────────────────────────────────────────────────────────

const CAT_DESCRIPTIONS = {
  traditional_ai_threats:
    "Attacks against machine learning models, model artifacts and supply chains, training data, or inference behavior that do not depend on language-model-specific mechanisms or autonomous agents.",
  llm_threats:
    "Attacks against an LLM's prompts, context, retrieval, outputs, alignment, or model ecosystem where the harm remains within the model or its responses rather than autonomous actions.",
  agentic_ai_threats:
    "Attacks that exploit an AI system's ability to act autonomously through tools, memory, permissions, planning, orchestration, or external actions.",
  ai_enabled_threats:
    "Threats where AI is used by attackers as a capability amplifier, while the victim and attack surface are not inherently AI systems themselves.",
};

function CategoryLegend() {
  return (
    <div className="hz-cat-legend">
      {Object.entries(CAT_COLOR).map(([key, color]) => (
        <div key={key} className="hz-cat-legend-item">
          <div className="hz-cat-legend-dot" style={{ background: color }} />
          <div className="hz-cat-legend-body">
            <div className="hz-cat-legend-label" style={{ color }}>{CAT_LABEL[key]}</div>
            <div className="hz-cat-legend-desc">{CAT_DESCRIPTIONS[key]}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Category card ─────────────────────────────────────────────────────────────

function CategoryCard({ cat, trendValues, selectedMaturity, onMaturitySelect }) {
  const color    = CAT_COLOR[cat.key];
  const count    = cat.source_count ?? 0;
  const insights = (cat.insights || []).filter(ins => !ins.blocked);

  return (
    <div className="hz-cat-card" style={{ "--cat-color": color }}>
      <div className="hz-cat-card-strip" style={{ background: color }} />
      <div className="hz-cat-card-body">

        {/* Header: source count + sparkline */}
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

        <MaturityBar
          maturity={cat.evidence_maturity}
          selected={selectedMaturity}
          onSelect={level => onMaturitySelect(cat.key, level)}
        />

        {/* Stale label — small, non-alarming */}
        {cat.insights_stale && cat.insights_from && (
          <div className="hz-cat-insights-from">Analysis from {cat.insights_from}</div>
        )}

        {/* Category posture assessment — one sentence above the insight list */}
        {cat.assessment && (
          <div className="hz-cat-assessment">{cat.assessment}</div>
        )}

        {/* Insight list */}
        {insights.length > 0 && (
          <ul className="hz-insight-list">
            {insights.map((ins, i) => (
              <InsightItem key={ins.insight_id || i} insight={ins} index={i} />
            ))}
          </ul>
        )}

        {/* Coverage gap — shown when thin but sources exist */}
        {insights.length === 0 && count > 0 && cat.coverage_gaps?.length > 0 && (
          <div className="hz-cat-card-empty">{cat.coverage_gaps[0]}</div>
        )}
        {insights.length === 0 && count > 0 && !cat.coverage_gaps?.length && (
          <div className="hz-cat-card-empty">No significant developments identified for this period.</div>
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
    <p className="hz-overview-empty">No sources in this period.</p>
  );

  return (
    <div className="hz-incidents-list">
      {incidents.map((inc, i) => {
        const color = CAT_COLOR[inc.category] || "#64748b";
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
              {inc.why && <div className="hz-incident-why">{inc.why}</div>}
              <div className="hz-incident-meta">
                <MaturityBadge level={inc.importance} />
                <span className="hz-incident-publisher">{inc.publisher}</span>
                <span className="hz-incident-date">{inc.date}</span>
                <span className="hz-incident-cat" style={{ color }}>{CAT_LABEL[inc.category] || inc.category}</span>
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
  const { tags = [], by_category = {} } = tagMatrix || {};
  if (!tags.length) return <p className="hz-overview-empty">No taxonomy data for this period.</p>;

  const grouped = DOMAINS.map(d => ({
    ...d,
    // count = attack sources for this technique. Defensive counts are intentionally
    // not shown (they cluttered the row and misaligned the count column).
    tags: tags
      .filter(t => t.domain === d.key)
      .map(t => ({ ...t, count: by_category[t.id]?.[d.key] || 0 }))
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
                    ? `View ${tag.count} source${tag.count !== 1 ? "s" : ""} tagged ${tag.label}`
                    : `No sources tagged ${tag.label} this period`}
                  onClick={clickable ? () => onSelect(tag, domain.key) : undefined}
                  disabled={!clickable}
                >
                  <span className="hz-taxonomy-tag-label">{tag.label}</span>
                  <span className="hz-taxonomy-tag-count">{tag.count}</span>
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
  const session = useAuth();
  const token   = getSessionToken(session);
  const isAdmin = getAccessLevel(session) === "admin";

  const [win,        setWin]        = useState("week");
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastFetch,  setLastFetch]  = useState(null);
  const [tagSelection,      setTagSelection]      = useState(null); // { tag, category }
  const [maturitySelection, setMaturitySelection] = useState(null); // { category, level }
  const [showThreatLegend,  setShowThreatLegend]  = useState(true);
  const timerRef = useRef(null);

  // `fresh` bypasses the API's insight cache — passed only by the refresh button,
  // so routine loads and window switches still hit the cache.
  const load = useCallback((w, fresh = false) => {
    setLoading(true);
    setError(null);
    fetchOverview(w, token, fresh)
      .then(d => { setData(d); setLoading(false); setLastFetch(new Date()); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  // Initial load and window change
  useEffect(() => {
    load(win);
    setTagSelection(null);
    setMaturitySelection(null);
  }, [win, load]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    timerRef.current = setInterval(() => load(win), REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [win, load]);

  const trend     = data?.trend;
  const catTrend  = (key) => trend?.by_category?.[key] || [];

  // "Other" (unclear_or_adjacent) is an internal triage state, not an analyst-facing
  // category — guests see neither the bucket nor its contribution to the total, so
  // for them the headline count is the sum of the four offensive categories only.
  const rawTotal   = data?.summary?.total ?? 0;
  const otherCount = data?.summary?.other ?? 0;
  const shownTotal = isAdmin ? rawTotal : rawTotal - otherCount;

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
              {" · "}{shownTotal} sources
              {lastFetch && (
                <span className="hz-overview-refresh-ts">
                  {" "}· {lastFetch.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}
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
            onClick={() => load(win, true)}
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
            <span className="hz-insight-stat-value">{shownTotal}</span>
            <span className="hz-insight-stat-label">Sources</span>
          </div>
          <span className="hz-insight-stat-eq">·</span>
          {Object.entries(CAT_COLOR).map(([key, color]) => (
            <div key={key} className="hz-insight-stat">
              <span className="hz-insight-stat-value" style={{ color }}>
                {data.summary?.by_category?.[key] ?? "—"}
              </span>
              <span className="hz-insight-stat-label">{CAT_SHORT[key] || CAT_LABEL[key]}</span>
            </div>
          ))}
          {/* Everything outside the 4 offensive categories: adjacent context
              (defenses, frameworks, generic CVEs) — so the row sums to Sources.
              Admin-only: it is an internal triage state, and for guests it is
              already subtracted from shownTotal so the row still reconciles. */}
          {isAdmin && data.summary?.other != null && (
            <div className="hz-insight-stat" title="Adjacent context outside the 4 offensive categories: defenses, frameworks, generic CVEs">
              <span className="hz-insight-stat-value" style={{ color: "#94a3b8" }}>
                {data.summary.other}
              </span>
              <span className="hz-insight-stat-label">Other</span>
            </div>
          )}
        </div>
      )}

      {/* Category legend */}
      <CategoryLegend />

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
                selectedMaturity={maturitySelection?.category === cat.key ? maturitySelection.level : null}
                onMaturitySelect={(catKey, level) => {
                  // Toggle off if same selection
                  if (maturitySelection?.category === catKey && maturitySelection?.level === level) {
                    setMaturitySelection(null);
                  } else {
                    setMaturitySelection({ category: catKey, level });
                    setTagSelection(null); // close tag drilldown if open
                  }
                }}
              />
            ))}
          </div>

        </>
      )}

      {/* Top incidents */}
      {data && (
        <>
          <div className="hz-overview-section-title">Top threats</div>
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

      {/* Trend chart */}
      {data?.trend?.week_labels?.length > 1 && (
        <>
          <div className="hz-overview-section-title">
            Weekly source volume
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

      {/* Threat maturity + priority legend — reference material, kept at the foot.
          Gated on `data` like every other block: the legend is static, so without
          the gate it renders on the first paint and pops in alone while the rest
          of the page is still fetching. */}
      {data && (
        <ThreatLegend open={showThreatLegend} onToggle={() => setShowThreatLegend(v => !v)} />
      )}
        
      {/* Maturity side panel — fixed drawer, overlays everything */}
      {maturitySelection && (() => {
        const cat = (data?.categories || []).find(c => c.key === maturitySelection.category);
        return (
          <MaturitySidePanel
            level={maturitySelection.level}
            category={maturitySelection.category}
            sources={cat?.maturity_sources?.[maturitySelection.level] || []}
            onClose={() => setMaturitySelection(null)}
          />
        );
      })()}

    </div>
  );
}
