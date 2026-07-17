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

// Unified 5-level maturity ladder — used for both the category bar and per-source badge.
// Mirrors MATURITY_RUNGS in lib/dashboard/evidenceMaturity.js.
const MATURITY_META = {
  research:     { label: "Research",     color: "#64748b", bg: "#f1f5f9" },
  demonstrated: { label: "Demonstrated", color: "#1d4ed8", bg: "#dbeafe" },
  disclosed:    { label: "Disclosed",    color: "#b45309", bg: "#fef3c7" },
  observed:     { label: "Observed",     color: "#dc2626", bg: "#fee2e2" },
  operational:  { label: "Operational",  color: "#7f1d1d", bg: "#fecaca" },
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

// Mirrors MATURITY_RUNGS in lib/dashboard/evidenceMaturity.js
const MATURITY_RUNGS = [
  { key: "research",     label: "Research",     color: "#94a3b8" },
  { key: "demonstrated", label: "Demonstrated", color: "#3b82f6" },
  { key: "disclosed",    label: "Disclosed",    color: "#f59e0b" },
  { key: "observed",     label: "Observed",     color: "#ef4444" },
  { key: "operational",  label: "Operational",  color: "#7f1d1d" },
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

// ── Insight item — terse by default, expandable on click ──────────────────────
// Click an insight to reveal its evidence + the ranked sources it was attributed to.

// Split a paragraph into individual fact bullets.
// Splits on sentence boundaries (". "), transitional connectives ("Separately,",
// "Additionally,", etc.), and semicolons. Filters fragments under 20 chars.
function splitToBullets(text) {
  if (!text) return [];
  // Step 1: break on strong transitional words first
  const CONNECTIVES = /(?<=[.!?])\s+(?=(?:Separately|Additionally|Also|However|Furthermore|Moreover|Meanwhile|In addition|At the same time|Notably|Importantly|Critically|By contrast|Unlike|Because|Worse|Crucially),?\s)/g;
  let parts = text.split(CONNECTIVES);
  // Step 2: within each part, split on sentence-ending period + capital letter
  parts = parts.flatMap(p =>
    p.split(/(?<=[a-z0-9"')\]])\.\s+(?=[A-Z"'])/)
  );
  // Step 3: strip leading/trailing whitespace, drop very short fragments
  return parts.map(s => s.trim()).filter(s => s.length > 25);
}

function InsightItem({ p }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const headlineRef = useRef(null);

  const sources = Array.isArray(p.sources) ? p.sources.filter(s => s && s.url) : [];
  // Preferred: the model now emits explanation_points as a real array of bullets.
  // Legacy fallback: split a prose `explanation`/`evidence` paragraph into sentences.
  const points = Array.isArray(p.explanation_points)
    ? p.explanation_points.map(s => String(s || "").trim()).filter(s => s.length > 3)
    : [];
  // Bullets come from explanation_points, or a split of the prose `explanation`.
  // NEVER fall back to `evidence` — it is a terse, semicolon-packed technical
  // string (e.g. "CVE-…; confirmed side-channel via auto-fetched Markdown images")
  // that reads as a cryptic wall. When the elaboration was QA-blanked, show the
  // clean headline (and sources) with no cryptic dropdown text.
  const bullets  = points.length ? points : splitToBullets((p.explanation || "").trim());
  const hasDetail = bullets.length > 0 || sources.length > 0;
  const expandable = hasDetail || clamped;

  useEffect(() => {
    const el = headlineRef.current;
    if (!el) return;
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

          {/* Fact bullets */}
          {bullets.length > 0 && (
            <ul className="hz-insight-bullets">
              {bullets.map((b, i) => (
                <li key={i} className="hz-insight-bullet">{b}</li>
              ))}
            </ul>
          )}

          {/* Source chips — one per source, compact, clickable */}
          {sources.length > 0 && (
            <div className="hz-insight-source-chips">
              <span className="hz-insight-tag">Sources</span>
              <div className="hz-insight-chips-row">
                {sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`hz-source-chip hz-source-chip--${s.importance || "research"}`}
                    onClick={e => e.stopPropagation()}
                    title={s.title || s.url}
                  >
                    <span className="hz-source-chip-pub">{s.publisher || new URL(s.url).hostname.replace("www.", "")}</span>
                    {s.date && <span className="hz-source-chip-date">{s.date.slice(0, 7)}</span>}
                    {(s.importance === "operational" || s.importance === "observed") && <span className="hz-source-chip-badge">confirmed</span>}
                  </a>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </li>
  );
}

// ── Threat maturity + priority legend (inline, above the 4 cards) ─────────────

const MATURITY_DEFS = [
  { key: "research",     color: "#94a3b8", label: "Research",
    desc: "Demonstrated in papers, benchmarks, or controlled lab environments only. No adversary has used it; no working exploit exists outside the research setting.",
    examples: "Prompt compression attack paper. Backdoor attack benchmark evaluation.",
    signals: '"we show that", "we demonstrate", academic/arXiv paper, red-team simulation, controlled experiment.' },
  { key: "demonstrated", color: "#3b82f6", label: "Demonstrated",
    desc: "A working exploit or capability exists and is reproducible outside a purely academic setting — a public PoC, a released tool, or a technique verified against a real product. No adversary has used it yet, but the barrier to use is low.",
    examples: "Wiz Research published working code showing symlink traversal against six real AI coding assistants. Researcher extracted training data from the live GPT-4 API.",
    signals: 'PoC released, exploit published, "successfully bypassed [real system]", "we exploited [real product]", CVE with working PoC.' },
  { key: "disclosed",    color: "#f59e0b", label: "Disclosed",
    desc: "A vendor, researcher, or government agency confirmed a vulnerability exists in a specific product or system. Exploitation has not been observed and no working public exploit exists.",
    examples: "CVE for prompt injection in LangChain, patched in 0.3.15, no exploit code. CISA advisory for an MCP server flaw.",
    signals: 'CVE with no known exploit, vendor advisory, "patched in version X", "responsibly disclosed", CISA/NIST advisory.' },
  { key: "observed",     color: "#ef4444", label: "Observed",
    desc: "The technique has been confirmed in real-world use against real victims. At least one documented incident with evidence of actual exploitation or harm.",
    examples: "Prompt injection campaign targeting enterprise chatbots with confirmed credential theft. Malware found in a live Hugging Face repo actively harvesting credentials.",
    signals: '"exploited in the wild", incident report, confirmed breach, named victims, threat intelligence documenting adversary use.' },
  { key: "operational",  color: "#7f1d1d", label: "Operational",
    desc: "In sustained, repeated, or scaled use by one or more threat actors. Multiple incidents, an ongoing campaign, or documented adversary adoption at scale.",
    examples: "Nation-state group integrating AI-generated spear-phishing into standard tradecraft across multiple operations. Ransomware group using AI for payload generation across multiple campaigns.",
    signals: '"ongoing campaign", "attributed to [named group]", "multiple victims", threat intelligence spanning weeks or months, GTIG/CrowdStrike campaign reporting.' },
];

const READING_VALUE_DEFS = [
  { key: "essential",   color: "#b91c1c", label: "Essential",
    desc: "Changes the threat model or establishes something the field had not seen before. First confirmed adversary operationalisation of a major AI capability, landmark frameworks leadership will repeatedly reference, named multi-government advisories declaring a strategic posture shift.",
    signals: "First confirmed in-the-wild AI technique; a named campaign establishing a new attack class; field-first framework (OWASP LLM Top 10 launch); Five Eyes / CISA strategic advisory." },
  { key: "recommended", color: "#c2410c", label: "Recommended",
    desc: "Materially changes prioritisation within a known attack surface. New variants with concrete evidence, confirmed adversary adoption, strong multi-incident syntheses, and reusable case studies with named actors and measurable impact.",
    signals: "Quarterly TI report with new adversary TTPs; first observed AI-generated phishing at scale; HuggingFace malware incident; vendor advisory with active exploitation." },
  { key: "analyst",     color: "#475569", label: "Analyst",
    desc: "Technically useful for practitioners but does not change strategic posture. Implementation mechanics, incremental research, exploit details, thin-text advisories. Leadership sees the summary rather than reading the source directly.",
    signals: "Advisory with no exploit; routine arXiv paper; 2nd/3rd writeup of a known incident; CVE disclosure without active exploitation." },
  { key: "background",  color: "#94a3b8", label: "Background",
    desc: "Adjacent guidance, policy context, defensive advice, or generic commentary with no distinct offensive intelligence. Sources that add nothing beyond stronger existing coverage.",
    signals: "Defensive/hardening content; policy/governance without offensive findings; off-topic despite passing the keyword gate; generic editorial." },
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
            <p className="hz-threat-legend-note">
              Every source is classified into exactly one level. The same level drives the category card bar and the badge on each source in Top Sources.
            </p>
            {MATURITY_DEFS.map(m => (
              <div key={m.key} className="hz-threat-legend-row">
                <div className="hz-threat-legend-row-head">
                  <span className="hz-threat-legend-dot" style={{ background: m.color }} />
                  <span className="hz-threat-legend-row-label" style={{ color: m.color }}>{m.label}</span>
                </div>
                <div className="hz-threat-legend-row-body">
                  <div className="hz-threat-legend-row-desc">{m.desc}</div>
                  <div className="hz-threat-legend-row-sub"><b>Examples:</b> {m.examples}</div>
                  <div className="hz-threat-legend-row-sub"><b>Signals:</b> {m.signals}</div>
                </div>
              </div>
            ))}
            <div className="hz-threat-legend-rules">
              <div className="hz-threat-legend-rules-title">Classification rules</div>
              <ul>
                <li>CVE alone → <b>Disclosed</b>. CVE + public PoC → <b>Demonstrated</b>. CVE + confirmed exploitation → <b>Observed</b>.</li>
                <li>Research paper in a controlled environment → <b>Research</b>, even if the attack "worked" there.</li>
                <li>Paper tested against a real live system (live API, real product) → <b>Demonstrated</b>.</li>
                <li>Single confirmed incident → <b>Observed</b>. Repeated or sustained campaign → <b>Operational</b>.</li>
                <li>The highest level present in a source wins.</li>
              </ul>
            </div>
          </div>
          <div className="hz-threat-legend-col">
            <div className="hz-threat-legend-col-title">Reading Value</div>
            <p className="hz-threat-legend-note">
              A separate axis from maturity. Maturity answers "how real is the threat?"; reading value answers "who should read this, and where should it surface?". A source can be high-maturity but analyst-only (routine advisory on a known technique) or the reverse (a field-first research paper at research maturity).
            </p>
            {READING_VALUE_DEFS.map(p => (
              <div key={p.key} className="hz-threat-legend-row">
                <div className="hz-threat-legend-row-head">
                  <span className="hz-threat-legend-dot" style={{ background: p.color }} />
                  <span className="hz-threat-legend-row-label" style={{ color: p.color }}>{p.label}</span>
                </div>
                <div className="hz-threat-legend-row-body">
                  <div className="hz-threat-legend-row-desc">{p.desc}</div>
                  <div className="hz-threat-legend-row-sub"><b>Signals:</b> {p.signals}</div>
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
    "Attacks against machine learning models, training data, or inference behavior that do not depend on language models, prompts, or autonomous agents.",
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

        <MaturityBar
          maturity={cat.evidence_maturity}
          selected={selectedMaturity}
          onSelect={level => onMaturitySelect(cat.key, level)}
        />

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
          <div className="hz-cat-card-empty">No significant developments this period — sources were routine (e.g. lone disclosed CVEs) with no insight-worthy pattern.</div>
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
  const [win,        setWin]        = useState("quarter");
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastFetch,  setLastFetch]  = useState(null);
  const [tagSelection,      setTagSelection]      = useState(null); // { tag, category }
  const [maturitySelection, setMaturitySelection] = useState(null); // { category, level }
  const [showThreatLegend,  setShowThreatLegend]  = useState(true);
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
              (defenses, frameworks, generic CVEs) — so the row sums to Sources. */}
          {data.summary?.other != null && (
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

      {/* Threat maturity + priority legend */}
      <ThreatLegend open={showThreatLegend} onToggle={() => setShowThreatLegend(v => !v)} />

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
