/**
 * SourcesPage — category tabs + sub-tag exploration + period pill switcher.
 * No trust-tier filter. Categories are first-class tabs.
 */

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";

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

// Importance tier — how consequential the source is (deterministic, from the API).
const TIER_META = {
  realized:  { label: "In the wild",  short: "Realized",  color: "#b91c1c", bg: "#fee2e2", rank: 5 },
  proven:    { label: "Demonstrated", short: "Proven",    color: "#c2410c", bg: "#ffedd5", rank: 4 },
  research:  { label: "Research",     short: "Research",  color: "#1d4ed8", bg: "#dbeafe", rank: 3 },
  reference: { label: "Reference",    short: "Reference", color: "#475569", bg: "#e2e8f0", rank: 2 },
  noise:     { label: "Low signal",   short: "Low",       color: "#64748b", bg: "#f1f5f9", rank: 1 },
};
const TIER_ORDER = ["realized", "proven", "research", "reference", "noise"];

// ── Sub-components ────────────────────────────────────────────────────────────

function TrustDot({ tier }) {
  const colors = {
    primary: "#16a34a", high: "#2563eb", medium: "#9ca3af",
    curated: "#7c3aed", low: "#d97706", unknown: "#e5e7eb",
  };
  return (
    <span
      title={`Trust: ${tier || "unknown"}`}
      style={{
        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
        background: colors[tier] || colors.unknown, flexShrink: 0, marginTop: 2,
      }}
    />
  );
}

function ImportanceBadge({ tier, small }) {
  const m = TIER_META[tier];
  if (!m) return null;
  return (
    <span className="hz-imp-badge" title={`Importance: ${m.label}`}
      style={{ color: m.color, background: m.bg, fontSize: small ? "0.6rem" : "0.66rem" }}>
      {small ? m.short : m.label}
    </span>
  );
}

// Expanded detail — everything an analyst needs to vet the source without opening it.
function SourceDetail({ s }) {
  const imp  = s.importance || {};
  const mech = s.mechanism || null;
  const full = s.analyst_brief || s.short_summary || s.summary;
  const domainTag = t => /^(TAI|LLM|ASI|AE)\d/.test(t);
  return (
    <div className="hz-src-detail">
      {full && <p className="hz-src-detail-summary">{full}</p>}

      <div className="hz-src-detail-grid">
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Importance</span>
          <span className="hz-src-detail-v">
            <ImportanceBadge tier={imp.tier} />
            <span className="hz-src-detail-sub">{imp.reality} · {imp.posture}{s.is_defensive ? " · defensive" : ""}</span>
          </span>
        </div>
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Source type</span>
          <span className="hz-src-detail-v">{s.source_type || "—"}</span>
        </div>
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Trust</span>
          <span className="hz-src-detail-v"><TrustDot tier={s.trust_tier} /> {s.trust_tier || "unknown"}</span>
        </div>
      </div>

      {(s.tags || []).length > 0 && (
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Taxonomy</span>
          <span className="hz-src-detail-tags">
            {(s.tags || []).map(t => (
              <span key={t} className={`hz-src-detail-tag${domainTag(t) ? " domain" : ""}`}>{t}</span>
            ))}
          </span>
        </div>
      )}

      {mech?.rationale && (
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Why this classification</span>
          <span className="hz-src-detail-v hz-src-detail-rationale">
            {mech.conflict && <span className="hz-src-conflict" title="The LLM and deterministic mapper disagreed on the tag — worth an extra look.">⚠ tag conflict</span>}
            {mech.exploit && <span className="hz-src-detail-mech">{mech.exploit}{mech.consequence ? ` → ${mech.consequence}` : ""}</span>}
            {mech.rationale}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SourcesPage() {
  const [period,      setPeriod]      = useState("all-time");
  const [activeTab,   setActiveTab]   = useState("all");
  const [activeTags,  setActiveTags]  = useState([]);
  const [search,      setSearch]      = useState("");
  const [page,        setPage]        = useState(1);
  const [sources,     setSources]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [totalCount,  setTotalCount]  = useState(0);
  const [expandedId,  setExpandedId]  = useState(null);   // row open for vetting
  const [tierFilter,  setTierFilter]  = useState(null);   // filter to one importance tier
  const [sortBy,      setSortBy]      = useState("importance"); // "importance" | "date"

  // Fetch sources whenever period changes (fetch all categories, filter client-side)
  const loadSources = useCallback(() => {
    setLoading(true);
    setError(null);
    setActiveTags([]);
    setPage(1);

    // No limit param → the API returns the full filtered corpus (paged past the
    // PostgREST 1000-row cap). All faceting below is done client-side.
    const params = new URLSearchParams({ period });
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

  // Reset tags/tier/expansion when tab changes
  useEffect(() => { setActiveTags([]); setTierFilter(null); setExpandedId(null); setPage(1); }, [activeTab]);

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

  // Client-side filtering + sorting
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const rows = sources.filter(s => {
      if (activeTab !== "all" && s.main_category !== activeTab) return false;
      if (tierFilter && s.importance?.tier !== tierFilter) return false;
      if (activeTags.length > 0 && !activeTags.every(t => s.tags?.includes(t))) return false;
      if (q) {
        const hay = `${s.title || ""} ${s.publisher || ""} ${s.short_summary || s.summary || ""} ${(s.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sortBy === "importance") {
      rows.sort((a, b) => {
        const ra = TIER_META[a.importance?.tier]?.rank || 0;
        const rb = TIER_META[b.importance?.tier]?.rank || 0;
        if (rb !== ra) return rb - ra;
        return (b.date_published || "").localeCompare(a.date_published || "");
      });
    }
    return rows; // already date-desc from the API when sortBy === "date"
  }, [sources, activeTab, activeTags, search, tierFilter, sortBy]);

  // Importance-tier counts for the tier filter chips (respecting the active tab).
  const tierCounts = useMemo(() => {
    const c = {};
    for (const s of sources) {
      if (activeTab !== "all" && s.main_category !== activeTab) continue;
      const t = s.importance?.tier;
      if (t) c[t] = (c[t] || 0) + 1;
    }
    return c;
  }, [sources, activeTab]);

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

      {/* Importance tier filter chips */}
      <div className="hz-tier-filter-row">
        <span className="hz-tag-filter-label">Importance</span>
        <div className="hz-tier-chips">
          {TIER_ORDER.filter(t => tierCounts[t]).map(t => {
            const m = TIER_META[t];
            const on = tierFilter === t;
            return (
              <button
                key={t}
                className={`hz-tier-chip${on ? " active" : ""}`}
                style={on ? { background: m.color, borderColor: m.color, color: "#fff" }
                          : { color: m.color, borderColor: `${m.color}55` }}
                onClick={() => { setTierFilter(on ? null : t); setPage(1); setExpandedId(null); }}
                title={m.label}
              >
                {m.short}<span className="hz-tier-chip-count">{tierCounts[t]}</span>
              </button>
            );
          })}
          {tierFilter && (
            <button className="hz-tag-clear" onClick={() => { setTierFilter(null); setPage(1); }}>Clear</button>
          )}
        </div>
      </div>

      {/* Search + sort + result count */}
      <div className="hz-sources-filters">
        <input
          className="hz-search-input"
          type="text"
          placeholder="Search title, publisher…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <div className="hz-seg-group hz-sort-group">
          <button className={`hz-seg-btn${sortBy === "importance" ? " active" : ""}`}
            onClick={() => { setSortBy("importance"); setPage(1); }}>Importance</button>
          <button className={`hz-seg-btn${sortBy === "date" ? " active" : ""}`}
            onClick={() => { setSortBy("date"); setPage(1); }}>Newest</button>
        </div>
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
          <table className="hz-sources-table hz-sources-table-vet">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Title</th>
                <th>Importance</th>
                <th>Publisher</th>
                {activeTab === "all" && <th>Category</th>}
                <th>Tags</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(s => {
                const id = s.id || s.url;
                const open = expandedId === id;
                const colSpan = activeTab === "all" ? 7 : 6;
                return (
                  <Fragment key={id}>
                    <tr
                      className={`hz-src-row${open ? " open" : ""}`}
                      onClick={() => setExpandedId(open ? null : id)}
                    >
                      <td className="hz-src-caret">{open ? "▾" : "▸"}</td>
                      <td>
                        <div className="hz-src-title-cell">
                          <TrustDot tier={s.trust_tier} />
                          <div>
                            {s.url
                              ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hz-src-link"
                                   onClick={e => e.stopPropagation()}>
                                  {s.title || "(no title)"}
                                </a>
                              : <span className="hz-src-link-plain">{s.title || "(no title)"}</span>
                            }
                            {(s.short_summary || s.summary) && (
                              <div className="hz-src-summary">
                                {(s.short_summary || s.summary).slice(0, 150)}
                                {(s.short_summary || s.summary).length > 150 ? "…" : ""}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td><ImportanceBadge tier={s.importance?.tier} small /></td>
                      <td className="hz-src-publisher">{s.publisher || "—"}</td>
                      {activeTab === "all" && (
                        <td>
                          <span className="hz-src-cat-badge"
                            style={{
                              background: `${CAT_COLOR[s.main_category] || "#94a3b8"}18`,
                              color: CAT_COLOR[s.main_category] || "#64748b",
                              borderColor: `${CAT_COLOR[s.main_category] || "#94a3b8"}40`,
                            }}>
                            {CAT_LABEL[s.main_category] || s.main_category || "—"}
                          </span>
                        </td>
                      )}
                      <td>
                        <div className="hz-src-tags">
                          {(s.tags || []).slice(0, 3).map(t => (
                            <button key={t}
                              className={`hz-src-tag${activeTags.includes(t) ? " active" : ""}`}
                              onClick={e => { e.stopPropagation(); activeTab !== "all" && toggleTag(t); }}
                              style={{
                                cursor: activeTab !== "all" ? "pointer" : "default",
                                ...(activeTags.includes(t) ? { background: tabColor, borderColor: tabColor, color: "#fff" } : {}),
                              }}>
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
                    {open && (
                      <tr className="hz-src-detail-row">
                        <td colSpan={colSpan}><SourceDetail s={s} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
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
