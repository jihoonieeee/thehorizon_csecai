/**
 * TaxonomyExplorer — full-width matrix explorer.
 *
 * Top level: one row per technique family, columns = threat categories, cells = source counts.
 * Click a row → expands inline sub-table of sub-techniques with AI-enabled badges + use cases.
 * Search filters technique rows. AI-only toggle shows only AI-enabled techniques.
 */

import { useState, useMemo } from "react";

// ── Theme constants ───────────────────────────────────────────────────────────

const COL_META = {
  llm_threats:            { label: "LLM",         short: "LLM",  color: "#6366f1" },
  agentic_ai_threats:     { label: "Agentic AI",   short: "Agt",  color: "#0ea5e9" },
  traditional_ai_threats: { label: "Traditional",  short: "Trad", color: "#f59e0b" },
  ai_enabled_threats:     { label: "AI-Enabled",   short: "AI-E", color: "#ef4444" },
};

const DOMAIN_PREFIX = {
  LLM: { label: "LLM Threats",       color: "#6366f1" },
  ASI: { label: "Agentic AI",        color: "#0ea5e9" },
  TAI: { label: "Traditional AI",    color: "#f59e0b" },
  AE:  { label: "AI-Enabled",        color: "#ef4444" },
};

// ── Heat colour ───────────────────────────────────────────────────────────────

function heat(val, max) {
  if (!val) return { bg: "transparent", text: "#1e293b" };
  const r = Math.min(val / max, 1);
  if (r < 0.15) return { bg: "rgba(99,102,241,0.06)",  text: "#6366f1" };
  if (r < 0.35) return { bg: "rgba(99,102,241,0.14)",  text: "#818cf8" };
  if (r < 0.6)  return { bg: "rgba(99,102,241,0.26)",  text: "#a5b4fc" };
  return              { bg: "rgba(99,102,241,0.44)",  text: "#c7d2fe" };
}

// ── Reusable cells ────────────────────────────────────────────────────────────

function CountCell({ val, max }) {
  const { bg, text } = heat(val, max);
  return (
    <td style={{ padding: "0 6px", width: "70px", textAlign: "center" }}>
      {val > 0
        ? <span style={{ display: "inline-block", minWidth: "28px", padding: "3px 8px", borderRadius: "12px", background: bg, color: text, fontSize: "0.78rem", fontWeight: 600 }}>{val}</span>
        : <span style={{ color: "#1e3a5f", fontSize: "0.72rem" }}>—</span>
      }
    </td>
  );
}

function AIBadge({ small }) {
  return (
    <span style={{
      display:    "inline-flex", alignItems: "center", gap: "2px",
      padding:    small ? "1px 5px" : "2px 6px",
      borderRadius:"8px",
      background: "rgba(16,185,129,0.1)",
      border:     "1px solid rgba(16,185,129,0.22)",
      color:      "#34d399",
      fontSize:   small ? "0.6rem" : "0.66rem",
      fontWeight: 700,
      flexShrink: 0,
      whiteSpace: "nowrap",
    }}>
      ✦ AI
    </span>
  );
}

// ── Sub-technique row ─────────────────────────────────────────────────────────

function SubRow({ sub, columns, max }) {
  const hasUseCases = sub.use_cases?.length > 0;
  const [showUC, setShowUC] = useState(false);

  return (
    <>
      <tr
        style={{ background: "rgba(99,102,241,0.025)", cursor: hasUseCases ? "pointer" : "default" }}
        onClick={() => hasUseCases && setShowUC((v) => !v)}
      >
        {/* Indent + chevron */}
        <td style={{ width: "36px", paddingLeft: "36px", color: "#1e3a5f", fontSize: "0.65rem" }}>
          {hasUseCases ? (showUC ? "▾" : "▸") : "└"}
        </td>
        <td style={{ padding: "7px 8px 7px 4px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#334155" }}>{sub.key}</span>
            <span style={{ fontSize: "0.78rem", color: "#94a3b8", fontWeight: 400 }}>{sub.label}</span>
            {sub.ai_enabled && <AIBadge small />}
            {hasUseCases && (
              <span style={{ fontSize: "0.6rem", color: "#334155" }}>
                {showUC ? "hide examples" : `${sub.use_cases.length} examples`}
              </span>
            )}
          </div>
        </td>
        {columns.map((col, ci) => <CountCell key={col.key} val={sub.values?.[ci] || 0} max={max} />)}
        <td style={{ padding: "0 8px 0 4px", width: "52px", textAlign: "right" }}>
          <span style={{ fontSize: "0.72rem", color: "#475569" }}>
            {(sub.values || []).reduce((s, v) => s + (v || 0), 0) || ""}
          </span>
        </td>
      </tr>
      {showUC && sub.use_cases?.length > 0 && (
        <tr style={{ background: "rgba(16,185,129,0.02)" }}>
          <td />
          <td colSpan={columns.length + 1} style={{ padding: "6px 12px 10px 32px" }}>
            <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "#1e5040", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "5px" }}>
              Example use cases
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {sub.use_cases.map((uc, i) => (
                <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <span style={{ color: "#34d399", fontSize: "0.65rem", marginTop: "2px", flexShrink: 0 }}>▸</span>
                  <span style={{ fontSize: "0.78rem", color: "#64748b", lineHeight: 1.5 }}>{uc}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main technique row ────────────────────────────────────────────────────────

function TechRow({ row, columns, max, expanded, onToggle, onDrilldown }) {
  const prefix = row.key.split(".")[0];
  const meta   = DOMAIN_PREFIX[prefix] || {};
  const total  = (row.values || []).reduce((s, v) => s + (v || 0), 0);
  const subs   = row.subtechniques || [];

  return (
    <tr
      onClick={() => subs.length > 0 ? onToggle() : onDrilldown?.({ type: "chart_click", chart_id: "vs_taxonomy_heatmap", clicked_key: row.key, label: row.label, evidence_ids: [], source_ids: [], analytics_evidence_ids: [], chart_title: "Taxonomy Explorer" })}
      style={{ cursor: "pointer", borderBottom: "1px solid #080d15", transition: "background 0.1s" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {/* Chevron */}
      <td style={{ width: "36px", paddingLeft: "12px", color: expanded ? meta.color : "#334155", fontSize: "0.68rem" }}>
        {subs.length > 0 ? (expanded ? "▾" : "▸") : ""}
      </td>

      {/* Tag key + label + AI badge + description */}
      <td style={{ padding: "10px 8px 10px 4px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "nowrap", overflow: "hidden" }}>
          <span style={{ fontFamily: "monospace", fontSize: "0.64rem", color: meta.color || "#475569", flexShrink: 0 }}>
            {row.key}
          </span>
          <span style={{ fontSize: "0.84rem", fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.label}
          </span>
          {row.ai_enabled && <AIBadge />}
          {subs.length > 0 && (
            <span style={{ fontSize: "0.64rem", color: "#334155", flexShrink: 0 }}>
              {subs.length} sub-technique{subs.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {row.description && (
          <div style={{ fontSize: "0.69rem", color: "#334155", marginTop: "2px", lineHeight: 1.4, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {row.description}
          </div>
        )}
      </td>

      {/* Count cells */}
      {columns.map((col, ci) => <CountCell key={col.key} val={row.values?.[ci] || 0} max={max} />)}

      {/* Total */}
      <td style={{ padding: "0 10px 0 4px", textAlign: "right", width: "52px" }}>
        <span style={{ fontSize: "0.78rem", color: total > 0 ? "#64748b" : "#1e3a5f", fontWeight: total > 0 ? 600 : 400 }}>
          {total > 0 ? total : ""}
        </span>
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TaxonomyExplorer({ spec, onDrilldown }) {
  const [search,       setSearch]       = useState("");
  const [aiOnly,       setAiOnly]       = useState(false);
  const [expandedKeys, setExpandedKeys] = useState(new Set());
  const [catFilter,    setCatFilter]    = useState("all");

  if (!spec?.chart_data) return null;
  const { columns = [], rows = [] } = spec.chart_data;

  const maxVal = useMemo(() => {
    let m = 1;
    for (const r of rows) {
      for (const v of r.values || []) m = Math.max(m, v || 0);
      for (const s of r.subtechniques || []) for (const v of s.values || []) m = Math.max(m, v || 0);
    }
    return m;
  }, [rows]);

  const catColIdx = catFilter !== "all" ? columns.findIndex((c) => c.key === catFilter) : -1;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (aiOnly && !r.ai_enabled) return false;
      if (catFilter !== "all" && catColIdx >= 0 && (r.values?.[catColIdx] || 0) === 0) return false;
      if (q) {
        const hay = [r.key, r.label, r.description || "", ...(r.subtechniques || []).map((s) => s.label)].join(" ").toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [rows, search, aiOnly, catFilter, catColIdx]);

  const toggle = (key) => setExpandedKeys((prev) => {
    const n = new Set(prev);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  const totalSources      = rows.reduce((n, r) => n + (r.values || []).reduce((s, v) => s + (v || 0), 0), 0);
  const aiEnabledCount    = rows.filter((r) => r.ai_enabled).length;
  const totalSubtechniques= rows.reduce((n, r) => n + (r.subtechniques || []).length, 0);

  return (
    <div style={{ borderRadius: "12px", background: "rgba(8,12,20,0.6)", border: "1px solid #0f1827", overflow: "hidden" }}>

      {/* Header */}
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #0f1827" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 700, color: "#e2e8f0" }}>Technique & Tactic Matrix</h3>
            <p style={{ margin: "3px 0 0", fontSize: "0.7rem", color: "#475569" }}>
              {rows.length} techniques · {totalSubtechniques} sub-techniques ·{" "}
              <span style={{ color: "#34d399" }}>{aiEnabledCount} AI-enabled</span> ·{" "}
              {totalSources} tagged sources
            </p>
          </div>
          {/* Category filter chips */}
          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
            <button onClick={() => setCatFilter("all")} style={{
              padding: "3px 10px", borderRadius: "20px", cursor: "pointer", fontSize: "0.7rem", fontWeight: catFilter === "all" ? 700 : 400,
              border: catFilter === "all" ? "1px solid #6366f1" : "1px solid #1e293b",
              background: catFilter === "all" ? "rgba(99,102,241,0.15)" : "transparent",
              color: catFilter === "all" ? "#a5b4fc" : "#475569",
            }}>All</button>
            {columns.map((col) => {
              const m = COL_META[col.key] || {};
              const active = catFilter === col.key;
              return (
                <button key={col.key} onClick={() => setCatFilter(active ? "all" : col.key)} style={{
                  padding: "3px 10px", borderRadius: "20px", cursor: "pointer", fontSize: "0.7rem", fontWeight: active ? 700 : 400,
                  border: `1px solid ${active ? m.color : "#1e293b"}`,
                  background: active ? `${m.color}18` : "transparent",
                  color: active ? m.color : "#475569",
                  whiteSpace: "nowrap",
                }}>
                  {m.label || col.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search + AI toggle */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 160px", minWidth: "140px" }}>
            <span style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", fontSize: "0.72rem", color: "#334155", pointerEvents: "none" }}>⌕</span>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search techniques…"
              style={{ width: "100%", padding: "6px 10px 6px 26px", borderRadius: "7px", border: "1px solid #1e293b", background: "#0a0f1a", color: "#e2e8f0", fontSize: "0.8rem", outline: "none", boxSizing: "border-box" }}
            />
          </div>
          <button onClick={() => setAiOnly(!aiOnly)} style={{
            padding: "6px 12px", borderRadius: "7px", cursor: "pointer", fontSize: "0.76rem", fontWeight: aiOnly ? 700 : 400, whiteSpace: "nowrap",
            border: `1px solid ${aiOnly ? "rgba(16,185,129,0.4)" : "#1e293b"}`,
            background: aiOnly ? "rgba(16,185,129,0.1)" : "transparent",
            color: aiOnly ? "#34d399" : "#475569",
          }}>✦ AI-enabled only</button>
          {(search || aiOnly || catFilter !== "all") && (
            <button onClick={() => { setSearch(""); setAiOnly(false); setCatFilter("all"); }} style={{ padding: "6px 10px", borderRadius: "7px", border: "1px solid #1e293b", background: "transparent", color: "#475569", fontSize: "0.72rem", cursor: "pointer", whiteSpace: "nowrap" }}>
              Clear
            </button>
          )}
          <span style={{ fontSize: "0.68rem", color: "#334155", marginLeft: "auto", whiteSpace: "nowrap" }}>
            {filteredRows.length} / {rows.length} shown
          </span>
        </div>
      </div>

      {/* Matrix table */}
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "580px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "36px" }} />
            <col style={{ minWidth: "240px" }} />
            {columns.map((c) => <col key={c.key} style={{ width: "70px" }} />)}
            <col style={{ width: "52px" }} />
          </colgroup>

          <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
            <tr style={{ background: "rgba(6,10,18,0.98)", borderBottom: "1px solid #0f1827" }}>
              <th />
              <th style={{ padding: "9px 8px 9px 4px", textAlign: "left", fontSize: "0.64rem", fontWeight: 700, color: "#334155", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Technique
              </th>
              {columns.map((col) => {
                const m = COL_META[col.key] || {};
                const active = catFilter === col.key;
                return (
                  <th key={col.key} style={{ padding: "9px 4px", textAlign: "center", fontSize: "0.62rem", fontWeight: 700, color: active ? (m.color || "#64748b") : "#334155", letterSpacing: "0.06em", textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.short || col.label}
                  </th>
                );
              })}
              <th style={{ padding: "9px 10px 9px 4px", textAlign: "right", fontSize: "0.62rem", fontWeight: 700, color: "#334155", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Total
              </th>
            </tr>
          </thead>

          <tbody>
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 3} style={{ padding: "32px 16px", textAlign: "center", color: "#334155", fontSize: "0.8rem" }}>No techniques match your filters.</td></tr>
            )}
            {filteredRows.map((row) => {
              const isExp = expandedKeys.has(row.key);
              return [
                <TechRow key={row.key} row={row} columns={columns} max={maxVal} expanded={isExp} onToggle={() => toggle(row.key)} onDrilldown={onDrilldown} />,
                ...(isExp ? (row.subtechniques || []).map((sub) => (
                  <SubRow key={sub.key} sub={sub} columns={columns} max={maxVal} />
                )) : []),
              ];
            })}
          </tbody>
        </table>
      </div>

      {/* Footer legend */}
      <div style={{ padding: "8px 20px", borderTop: "1px solid #0f1827", display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "0.65rem", color: "#1e3a5f" }}>
        <span>▸ Click technique to expand sub-techniques</span>
        <span>✦ AI = AI-assisted variant confirmed in corpus</span>
        <span style={{ marginLeft: "auto" }}>{spec.caveat_if_any}</span>
      </div>
    </div>
  );
}
