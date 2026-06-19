/**
 * SourcesPage — category tabs + sub-tag exploration + period pill switcher.
 * No trust-tier filter. Categories are first-class tabs.
 */

import { useState, useEffect, useCallback, useMemo } from "react";

const CAT_COLOR = {
  traditional_ai_threats: "#3583C9",
  llm_threats:            "#9C62A7",
  agentic_ai_threats:     "#19BC9D",
  ai_enabled_threats:     "#FFAA22",
};

const CAT_LABEL = {
  traditional_ai_threats: "Traditional AI",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI",
  ai_enabled_threats:     "AI-Enabled",
  unclear_or_adjacent:    "Other",
};

const CAT_LABEL_FULL = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const ALL_CATS = Object.keys(CAT_COLOR);

const PERIOD_OPTIONS = [
  { value: "last-7d",  label: "7 days" },
  { value: "last-30d", label: "30 days" },
  { value: "last-90d", label: "90 days" },
  { value: "all-time", label: "All time" },
];

const PAGE_SIZE = 50;

// ── Sub-components ────────────────────────────────────────────────────────────

function TrustDot({ tier }) {
  const colors = {
    primary: "#16a34a", high: "#2563eb", medium: "#9ca3af",
    curated: "#7c3aed", low: "#d97706", unknown: "#e5e7eb",
  };
  return (
    <span
      title={tier || "unknown"}
      style={{
        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
        background: colors[tier] || colors.unknown, flexShrink: 0, marginTop: 2,
      }}
    />
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SourcesPage() {
  const [period,      setPeriod]      = useState("last-90d");
  const [activeTab,   setActiveTab]   = useState("all");
  const [activeTags,  setActiveTags]  = useState([]);
  const [search,      setSearch]      = useState("");
  const [page,        setPage]        = useState(1);
  const [sources,     setSources]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [totalCount,  setTotalCount]  = useState(0);

  // Fetch sources whenever period changes (fetch all categories, filter client-side)
  const loadSources = useCallback(() => {
    setLoading(true);
    setError(null);
    setActiveTags([]);
    setPage(1);

    const params = new URLSearchParams({ period, limit: "500" });
    fetch(`/api/sources?${params}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        const rows = Array.isArray(json) ? json : (json.sources || []);
        setSources(rows);
        setTotalCount(json.count ?? rows.length);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setSources([]); setLoading(false); });
  }, [period]);

  useEffect(() => { loadSources(); }, [loadSources]);

  // Reset tags when tab changes
  useEffect(() => { setActiveTags([]); setPage(1); }, [activeTab]);

  // Available tags for the active category tab (from loaded sources)
  const availableTags = useMemo(() => {
    const counts = {};
    for (const s of sources) {
      if (activeTab !== "all" && s.main_category !== activeTab) continue;
      for (const t of (s.tags || [])) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [sources, activeTab]);

  // Client-side filtering
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return sources.filter(s => {
      if (activeTab !== "all" && s.main_category !== activeTab) return false;
      if (activeTags.length > 0 && !activeTags.every(t => s.tags?.includes(t))) return false;
      if (q && !s.title?.toLowerCase().includes(q) && !s.publisher?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sources, activeTab, activeTags, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Category counts from all loaded sources
  const catCounts = useMemo(() => {
    const c = {};
    for (const s of sources) {
      if (s.main_category) c[s.main_category] = (c[s.main_category] || 0) + 1;
    }
    return c;
  }, [sources]);

  const toggleTag = (tag) => {
    setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
    setPage(1);
  };

  const tabColor = CAT_COLOR[activeTab] || null;

  return (
    <div className="hz-sources-page">

      {/* Header row */}
      <div className="hz-sources-header">
        <div>
          <h1 className="hz-page-title" style={{ marginBottom: 0 }}>Sources</h1>
          <p className="hz-page-sub" style={{ marginBottom: 0 }}>
            Browse validated threat intelligence sources
          </p>
        </div>

        {/* Period pill switcher */}
        <div className="hz-seg-group">
          {PERIOD_OPTIONS.map(o => (
            <button
              key={o.value}
              className={`hz-seg-btn${period === o.value ? " active" : ""}`}
              onClick={() => { setPeriod(o.value); setPage(1); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Category tabs */}
      <div className="hz-cat-tabs">
        <button
          className={`hz-cat-tab${activeTab === "all" ? " active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All
          <span className="hz-cat-tab-count">{sources.length}</span>
        </button>
        {ALL_CATS.map(cat => {
          const count = catCounts[cat] ?? 0;
          const active = activeTab === cat;
          return (
            <button
              key={cat}
              className={`hz-cat-tab${active ? " active" : ""}`}
              style={active ? {
                "--tab-color": CAT_COLOR[cat],
                borderBottomColor: CAT_COLOR[cat],
                color: CAT_COLOR[cat],
              } : {}}
              onClick={() => setActiveTab(cat)}
            >
              <span
                className="hz-cat-tab-dot"
                style={{ background: CAT_COLOR[cat] }}
              />
              {CAT_LABEL[cat]}
              {count > 0 && <span className="hz-cat-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Sub-tag pills (only when a category is selected) */}
      {activeTab !== "all" && availableTags.length > 0 && (
        <div className="hz-tag-filter-row">
          <span className="hz-tag-filter-label">Filter by tag</span>
          <div className="hz-tag-pills">
            {availableTags.map(([tag, count]) => {
              const on = activeTags.includes(tag);
              return (
                <button
                  key={tag}
                  className={`hz-tag-pill${on ? " active" : ""}`}
                  style={on ? { background: tabColor, borderColor: tabColor, color: "#fff" } : {}}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                  <span className="hz-tag-pill-count">{count}</span>
                </button>
              );
            })}
          </div>
          {activeTags.length > 0 && (
            <button className="hz-tag-clear" onClick={() => setActiveTags([])}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* Search + result count */}
      <div className="hz-sources-filters">
        <input
          className="hz-search-input"
          type="text"
          placeholder="Search title, publisher…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <span className="hz-sources-count">
          {loading ? "Loading…" : `${filtered.length.toLocaleString()} source${filtered.length !== 1 ? "s" : ""}`}
          {activeTab !== "all" && (
            <span className="hz-sources-count-cat"> in {CAT_LABEL_FULL[activeTab] || activeTab}</span>
          )}
        </span>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="hz-empty" style={{ color: "var(--danger)" }}>
          Could not load sources: {error}
          <br />
          <span style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
            Make sure the API server is running (npx vercel dev).
          </span>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && paged.length === 0 && (
        <div className="hz-empty">
          No sources found{activeTab !== "all" ? ` in ${CAT_LABEL[activeTab]}` : ""}
          {activeTags.length > 0 ? ` with tag${activeTags.length > 1 ? "s" : ""} ${activeTags.join(", ")}` : ""}
          {search ? ` matching "${search}"` : ""}.
        </div>
      )}

      {loading && (
        <div className="hz-empty" style={{ color: "var(--text-tertiary)" }}>Loading sources…</div>
      )}

      {/* Table */}
      {!loading && paged.length > 0 && (
        <div className="hz-sources-table-wrap">
          <table className="hz-sources-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Publisher</th>
                {activeTab === "all" && <th>Category</th>}
                <th>Tags</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(s => (
                <tr key={s.id || s.url}>
                  <td>
                    <div className="hz-src-title-cell">
                      <TrustDot tier={s.trust_tier} />
                      <div>
                        {s.url
                          ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hz-src-link">
                              {s.title || "(no title)"}
                            </a>
                          : <span className="hz-src-link-plain">{s.title || "(no title)"}</span>
                        }
                        {(s.short_summary || s.summary) && (
                          <div className="hz-src-summary">
                            {(s.short_summary || s.summary).slice(0, 120)}
                            {(s.short_summary || s.summary).length > 120 ? "…" : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hz-src-publisher">{s.publisher || "—"}</td>
                  {activeTab === "all" && (
                    <td>
                      <span
                        className="hz-src-cat-badge"
                        style={{
                          background: `${CAT_COLOR[s.main_category] || "#94a3b8"}18`,
                          color: CAT_COLOR[s.main_category] || "#64748b",
                          borderColor: `${CAT_COLOR[s.main_category] || "#94a3b8"}40`,
                        }}
                      >
                        {CAT_LABEL[s.main_category] || s.main_category || "—"}
                      </span>
                    </td>
                  )}
                  <td>
                    <div className="hz-src-tags">
                      {(s.tags || []).slice(0, 3).map(t => (
                        <button
                          key={t}
                          className={`hz-src-tag${activeTags.includes(t) ? " active" : ""}`}
                          onClick={() => activeTab !== "all" && toggleTag(t)}
                          style={{
                            cursor: activeTab !== "all" ? "pointer" : "default",
                            ...(activeTags.includes(t) ? { background: tabColor, borderColor: tabColor, color: "#fff" } : {}),
                          }}
                        >
                          {t}
                        </button>
                      ))}
                      {(s.tags || []).length > 3 && (
                        <span className="hz-src-tag-more">+{s.tags.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="hz-src-date">
                    {s.date_published ? s.date_published.slice(0, 10) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="hz-pagination">
          <button
            className="hz-page-btn"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            ← Prev
          </button>
          <span className="hz-page-info">
            {page} / {totalPages}
            <span className="hz-page-info-range">
              &nbsp;({(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length})
            </span>
          </span>
          <button
            className="hz-page-btn"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
