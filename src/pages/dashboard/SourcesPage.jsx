/**
 * SourcesPage — filterable source list with period and archive browsing.
 * Fetches from GET /api/sources with full period + filter support.
 */

import { useState, useEffect, useCallback } from "react";

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

const TRUST_OPTIONS = [
  { value: "primary",  label: "Primary" },
  { value: "high",     label: "High" },
  { value: "medium",   label: "Medium" },
  { value: "curated",  label: "Curated" },
  { value: "low",      label: "Low" },
];

const ALL_CATS = Object.keys(CAT_COLOR);
const PAGE_SIZE = 50;

// ── Period helpers ─────────────────────────────────────────────────────────────

function buildPeriodOptions() {
  const list = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const short = d.toLocaleDateString("en-SG", { month: "short", year: "numeric" });
    list.push({ value: val, label: i === 0 ? `${short} (this month)` : i === 1 ? `${short} (last month)` : short });
  }
  return list;
}

const PERIOD_OPTIONS = [
  { value: "last-7d",  label: "Last 7 days" },
  { value: "last-30d", label: "Last 30 days" },
  { value: "last-90d", label: "Last 90 days" },
  { value: "all-time", label: "All time" },
  ...buildPeriodOptions(),
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function TrustBadge({ tier }) {
  const cls = tier || "unknown";
  return <span className={`hz-trust-badge ${cls}`}>{tier || "unknown"}</span>;
}

function CategoryDot({ category }) {
  const color = CAT_COLOR[category] || "#94a3b8";
  return <span className="hz-cat-dot" style={{ background: color }} />;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SourcesPage({ data, period: globalPeriod, onPeriodChange }) {
  // Local period override — starts synced to nav, can diverge
  const [localPeriod,  setLocalPeriod]  = useState(globalPeriod || "last-90d");
  const [sources,      setSources]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);
  const [periodLabel,  setPeriodLabel]  = useState("");
  const [dateRange,    setDateRange]    = useState(null);
  const [totalCount,   setTotalCount]   = useState(0);

  // Filters
  const [catFilter,    setCatFilter]    = useState("");
  const [trustFilter,  setTrustFilter]  = useState("");
  const [search,       setSearch]       = useState("");
  const [page,         setPage]         = useState(1);

  // Sync local period when nav period changes (unless user overrode locally)
  const [userOverride, setUserOverride] = useState(false);
  useEffect(() => {
    if (!userOverride && globalPeriod) setLocalPeriod(globalPeriod);
  }, [globalPeriod, userOverride]);

  const handlePeriodChange = (val) => {
    setLocalPeriod(val);
    setUserOverride(true);
    setPage(1);
  };

  const loadSources = useCallback(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set("period", localPeriod);
    if (catFilter)   params.set("category",   catFilter);
    if (trustFilter) params.set("trust_tier", trustFilter);
    if (search)      params.set("search",     search);
    params.set("limit", "500");

    fetch(`/api/sources?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const rows = Array.isArray(json) ? json : (json.sources || []);
        setSources(rows);
        setTotalCount(json.count ?? rows.length);
        setPeriodLabel(json.period_label || "");
        setDateRange(json.date_range || null);
        setLoading(false);
        setPage(1);
      })
      .catch((e) => {
        setError(e.message);
        setSources([]);
        setLoading(false);
      });
  }, [localPeriod, catFilter, trustFilter, search]);

  useEffect(() => { loadSources(); }, [loadSources]);

  // Client-side search (instant, no re-fetch)
  const filtered = sources;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Category counts from currently loaded sources
  const catCounts = {};
  for (const s of sources) {
    if (s.main_category) catCounts[s.main_category] = (catCounts[s.main_category] || 0) + 1;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
        <div>
          <h1 className="hz-page-title" style={{ marginBottom: 0 }}>Sources</h1>
          <p className="hz-page-sub" style={{ marginBottom: 0 }}>
            Browse validated threat intelligence sources.
            {periodLabel && (
              <> Showing <strong>{periodLabel}</strong>
                {dateRange?.start && (
                  <span style={{ color: "var(--text-tertiary)" }}> ({dateRange.start} – {dateRange.end})</span>
                )}
              </>
            )}
          </p>
        </div>

        {/* Period selector */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Time range
          </span>
          <select
            className="hz-period-select"
            value={localPeriod}
            onChange={(e) => handlePeriodChange(e.target.value)}
            style={{ fontSize: "0.82rem", padding: "6px 10px" }}
          >
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {userOverride && localPeriod !== globalPeriod && (
            <button
              className="hz-cat-pill"
              onClick={() => { setLocalPeriod(globalPeriod || "last-90d"); setUserOverride(false); }}
              style={{ fontSize: "0.7rem", padding: "3px 10px" }}
              title="Reset to global period"
            >
              ↩ Reset
            </button>
          )}
        </div>
      </div>

      {/* Category pills with counts */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
        <button
          className={`hz-cat-pill${catFilter === "" ? " active" : ""}`}
          onClick={() => { setCatFilter(""); setPage(1); }}
        >
          All
        </button>
        {ALL_CATS.map((cat) => {
          const count = catCounts[cat] ?? 0;
          const color = CAT_COLOR[cat];
          const active = catFilter === cat;
          return (
            <button
              key={cat}
              onClick={() => { setCatFilter(active ? "" : cat); setPage(1); }}
              style={{
                display: "flex", alignItems: "center", gap: "5px",
                padding: "4px 12px", borderRadius: "20px",
                border: `1px solid ${active ? color : "var(--border)"}`,
                background: active ? color : "var(--surface)",
                cursor: "pointer", fontSize: "0.75rem", fontWeight: active ? 600 : 500,
                color: active ? "#fff" : "var(--text-secondary)",
                transition: "all 0.12s",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? "rgba(255,255,255,0.7)" : color, flexShrink: 0 }} />
              {CAT_LABEL[cat]}
              {count > 0 && (
                <span style={{
                  fontSize: "0.65rem", fontWeight: 700,
                  background: active ? "rgba(255,255,255,0.2)" : "var(--surface-2)",
                  color: active ? "#fff" : "var(--text-tertiary)",
                  padding: "0 5px", borderRadius: "10px", minWidth: "18px", textAlign: "center",
                }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search + trust filter */}
      <div className="hz-sources-filters">
        <input
          className="hz-search-input"
          type="text"
          placeholder="Search title, publisher…"
          value={search}
          style={{ width: "260px" }}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        <select
          className="hz-period-select"
          value={trustFilter}
          onChange={(e) => { setTrustFilter(e.target.value); setPage(1); }}
          style={{ fontSize: "0.8rem" }}
        >
          <option value="">All trust tiers</option>
          {TRUST_OPTIONS.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {(catFilter || trustFilter || search) && (
          <button
            className="hz-cat-pill"
            onClick={() => { setCatFilter(""); setTrustFilter(""); setSearch(""); setPage(1); }}
            style={{ fontSize: "0.75rem" }}
          >
            Clear filters
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginLeft: "auto" }}>
          {loading ? "Loading…" : `${totalCount} source${totalCount !== 1 ? "s" : ""}${filtered.length < totalCount ? ` (${filtered.length} shown)` : ""}`}
        </span>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="hz-empty" style={{ color: "var(--danger)" }}>
          Could not load sources: {error}
          <br />
          <span style={{ color: "var(--text-tertiary)", fontSize: "0.8rem" }}>
            Make sure the API server is running (npx vercel dev).
          </span>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && paged.length === 0 && (
        <div className="hz-empty">
          No sources found for this period{catFilter ? ` in ${CAT_LABEL[catFilter]}` : ""}{search ? ` matching "${search}"` : ""}.
        </div>
      )}

      {/* Loading skeleton */}
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
                <th>Category</th>
                <th>Trust</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((s) => (
                <tr key={s.id || s.url}>
                  <td>
                    {s.url
                      ? <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontWeight: 500 }}>
                          {s.title || "(no title)"}
                        </a>
                      : <span style={{ fontWeight: 500 }}>{s.title || "(no title)"}</span>
                    }
                    {s.short_summary && (
                      <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "3px", lineHeight: 1.4 }}>
                        {s.short_summary.slice(0, 130)}{s.short_summary.length > 130 ? "…" : ""}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: "0.78rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {s.publisher || "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <CategoryDot category={s.main_category} />
                    <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                      {CAT_LABEL[s.main_category] || s.main_category || "—"}
                    </span>
                  </td>
                  <td><TrustBadge tier={s.trust_tier} /></td>
                  <td style={{ fontSize: "0.74rem", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
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
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", marginTop: "16px" }}>
          <button
            className="hz-cat-pill"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ opacity: page === 1 ? 0.4 : 1 }}
          >
            ← Previous
          </button>
          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Page {page} of {totalPages}
            <span style={{ color: "var(--text-tertiary)", marginLeft: "4px" }}>
              ({(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length})
            </span>
          </span>
          <button
            className="hz-cat-pill"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{ opacity: page === totalPages ? 0.4 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
