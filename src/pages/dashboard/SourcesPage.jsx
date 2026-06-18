/**
 * SourcesPage — filterable source list.
 * Uses category_counts from dashboard data for a category breakdown,
 * and fetches from GET /api/sources for the table.
 */

import { useState, useEffect } from "react";

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

const ALL_CATS = Object.keys(CAT_COLOR);

function TrustBadge({ tier }) {
  const cls = tier || "unknown";
  return <span className={`hz-trust-badge ${cls}`}>{tier || "unknown"}</span>;
}

function CategoryDot({ category }) {
  const color = CAT_COLOR[category] || "#94a3b8";
  return <span className="hz-cat-dot" style={{ background: color }} />;
}

export function SourcesPage({ data, period }) {
  const [sources,    setSources]    = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [catFilter,  setCatFilter]  = useState("");
  const [search,     setSearch]     = useState("");
  const [page,       setPage]       = useState(1);

  const PAGE_SIZE = 50;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setPage(1);

    const params = new URLSearchParams();
    if (catFilter) params.set("category", catFilter);
    if (period)    params.set("period", period);
    params.set("limit", "200");

    fetch(`/api/sources?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        // API may return { sources: [...] } or an array directly
        setSources(Array.isArray(json) ? json : (json.sources || json.data || []));
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
        // Fall back to showing summary counts from dashboard data
        setSources([]);
      });
  }, [catFilter, period]);

  // Client-side search filter
  const filtered = sources.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (s.title      || "").toLowerCase().includes(q) ||
      (s.publisher  || "").toLowerCase().includes(q) ||
      (s.summary    || "").toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Summary counts from dashboard data
  const catCounts = data?.summary?.category_counts || {};

  return (
    <div>
      <h1 className="hz-page-title">Sources</h1>
      <p className="hz-page-sub">Browse validated threat intelligence sources by category.</p>

      {/* Category summary pills */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
        {ALL_CATS.map((cat) => {
          const count = catCounts[cat] ?? 0;
          const color = CAT_COLOR[cat];
          const active = catFilter === cat;
          return (
            <button
              key={cat}
              onClick={() => setCatFilter(active ? "" : cat)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                borderRadius: "8px",
                border: `1px solid ${active ? color : "var(--border)"}`,
                background: active ? `${color}15` : "var(--surface)",
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                {CAT_LABEL[cat]}
              </span>
              {count > 0 && (
                <span style={{ fontSize: "0.7rem", fontWeight: 700, color: active ? color : "var(--text-tertiary)", background: active ? `${color}20` : "var(--surface-2)", padding: "1px 7px", borderRadius: "10px" }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search + active filter */}
      <div className="hz-sources-filters">
        <input
          className="hz-search-input"
          type="text"
          placeholder="Search title, publisher..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        {catFilter && (
          <button
            className="hz-cat-pill active"
            onClick={() => setCatFilter("")}
            style={{ background: CAT_COLOR[catFilter], borderColor: CAT_COLOR[catFilter] }}
          >
            {CAT_LABEL[catFilter]} x
          </button>
        )}
        {filtered.length > 0 && (
          <span style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginLeft: "auto" }}>
            {filtered.length} source{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Error / loading / empty states */}
      {loading && (
        <div className="hz-empty">Loading sources...</div>
      )}

      {error && !loading && sources.length === 0 && (
        <div className="hz-empty" style={{ color: "var(--danger)" }}>
          Could not load sources: {error}
          <br />
          <span style={{ color: "var(--text-tertiary)", fontSize: "0.8rem" }}>
            Make sure the API server is running (npx vercel dev).
          </span>
        </div>
      )}

      {!loading && !error && paged.length === 0 && (
        <div className="hz-empty">No sources found{search ? ` for "${search}"` : ""}.</div>
      )}

      {/* Table */}
      {paged.length > 0 && (
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
                      : <span>{s.title || "(no title)"}</span>
                    }
                    {s.short_summary && (
                      <div style={{ fontSize: "0.73rem", color: "var(--text-secondary)", marginTop: "2px", lineHeight: 1.4 }}>
                        {s.short_summary.slice(0, 120)}{s.short_summary.length > 120 ? "…" : ""}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: "0.78rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {s.publisher || "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <CategoryDot category={s.main_category} />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      {CAT_LABEL[s.main_category] || s.main_category || "—"}
                    </span>
                  </td>
                  <td>
                    <TrustBadge tier={s.trust_tier} />
                  </td>
                  <td style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
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
        <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "16px" }}>
          <button
            className="hz-cat-pill"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ opacity: page === 1 ? 0.4 : 1 }}
          >
            Previous
          </button>
          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)", padding: "4px 8px" }}>
            Page {page} of {totalPages}
          </span>
          <button
            className="hz-cat-pill"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{ opacity: page === totalPages ? 0.4 : 1 }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
