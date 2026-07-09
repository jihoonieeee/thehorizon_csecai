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
  unclear_or_adjacent:    "#94a3b8",   // "Other" — adjacent/reference sources
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
  unclear_or_adjacent:    "Other / Adjacent",
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

// Categorical importance label (critical/important/supporting/archive) from the API.
const LABEL_META = {
  critical:   { short: "Critical",   color: "#b91c1c", bg: "#fee2e2" },
  important:  { short: "Important",  color: "#c2410c", bg: "#ffedd5" },
  supporting: { short: "Supporting", color: "#475569", bg: "#e2e8f0" },
  archive:    { short: "Archive",    color: "#94a3b8", bg: "#f1f5f9" },
};
const LABEL_ORDER = ["critical", "important", "supporting", "archive"];

// Advisory significance overlay (research sources only) — breaks ties WITHIN an
// importance tier so a landmark paper outranks a routine one.
const SIGNIFICANCE_RANK = { landmark: 3, notable: 2, routine: 1, incremental: 0 };
const sigRank = s => SIGNIFICANCE_RANK[s.significance?.level] ?? 0;
const SIG_META = {
  landmark: { short: "Landmark", color: "#7c3aed", bg: "#ede9fe" },
  notable:  { short: "Notable",  color: "#2563eb", bg: "#dbeafe" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

// Admin secret — reuses the same localStorage key as the Generate-Slides page, so
// the CRON_SECRET is entered once and shared across admin actions. Sent as a Bearer
// token on the PATCH/DELETE mutation calls (see api/sources.js).
const SECRET_KEY = "hz_api_secret";
const loadSecret = () => { try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; } };
const saveSecret = (v) => { try { localStorage.setItem(SECRET_KEY, v); } catch { /* ignore */ } };

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
// Also hosts the admin controls: edit the publish date and delete the source.
function SourceDetail({ s, onUpdateDate, onDelete, onSaveClassification, knownTags, busy }) {
  const imp  = s.importance || {};
  const mech = s.mechanism || null;
  const full = s.analyst_brief || s.short_summary || s.summary;
  const domainTag = t => /^(TAI|LLM|ASI|AE)\d/.test(t);
  const [dateVal, setDateVal] = useState((s.date_published || "").slice(0, 10));
  const dirty = dateVal && dateVal !== (s.date_published || "").slice(0, 10);

  // ── Classification draft (main_category + tags) ──────────────────────────────
  const [catVal,  setCatVal]  = useState(s.main_category || "unclear_or_adjacent");
  const [tagList, setTagList] = useState(s.tags || []);
  const [newTag,  setNewTag]  = useState("");
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  const classDirty = catVal !== (s.main_category || "") || !sameSet(tagList, s.tags || []);
  const addTag = () => {
    const t = newTag.trim();
    if (t && !tagList.includes(t)) setTagList([...tagList, t]);
    setNewTag("");
  };
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

      {/* Admin controls — edit classification / publish date + delete (persist to DB). */}
      <div className="hz-src-admin" onClick={e => e.stopPropagation()}>
        <span className="hz-src-detail-k">Edit</span>

        {/* Classification: main category + tags */}
        <div className="hz-src-class-editor">
          <label className="hz-src-admin-cat">
            Category
            <select value={catVal} disabled={busy} onChange={e => setCatVal(e.target.value)}>
              {ALL_CATS.map(c => (
                <option key={c} value={c}>{CAT_LABEL_FULL[c] || c}</option>
              ))}
            </select>
          </label>

          <div className="hz-src-class-tags">
            <span className="hz-src-class-tags-label">Tags</span>
            <div className="hz-src-tag-chips">
              {tagList.length === 0 && <span className="hz-src-tag-empty">no tags</span>}
              {tagList.map(t => (
                <span key={t} className={`hz-src-edit-tag${domainTag(t) ? " domain" : ""}`}>
                  {t}
                  <button className="hz-src-tag-x" disabled={busy} title="Remove tag"
                    onClick={() => setTagList(tagList.filter(x => x !== t))}>×</button>
                </span>
              ))}
            </div>
            <div className="hz-src-tag-add">
              <input list="hz-known-tags" placeholder="add tag…" value={newTag} disabled={busy}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
              <datalist id="hz-known-tags">
                {(knownTags || []).map(t => <option key={t} value={t} />)}
              </datalist>
              <button className="hz-src-tag-add-btn" disabled={busy || !newTag.trim()} onClick={addTag}>Add</button>
            </div>
          </div>

          <button className="hz-src-admin-save" disabled={!classDirty || busy}
            onClick={() => onSaveClassification(s, { main_category: catVal, tags: tagList })}>
            {busy ? "Saving…" : "Save classification"}
          </button>
        </div>

        <div className="hz-src-admin-row">
          <label className="hz-src-admin-date">
            Publish date
            <input type="date" value={dateVal} disabled={busy}
              onChange={e => setDateVal(e.target.value)} />
          </label>
          <button className="hz-src-admin-save" disabled={!dirty || busy}
            onClick={() => onUpdateDate(s, dateVal)}>
            {busy ? "Saving…" : "Save date"}
          </button>
          <button className="hz-src-admin-delete" disabled={busy}
            onClick={() => onDelete(s)}>
            Delete source
          </button>
        </div>
      </div>
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
  const [starredOnly, setStarredOnly] = useState(false);  // filter to starred sources
  const [flaggedOnly, setFlaggedOnly] = useState(false);  // filter to flagged (needs_review) sources
  const [labelFilter, setLabelFilter] = useState(null);   // filter to one importance label
  const [sortBy,      setSortBy]      = useState("importance"); // "importance" | "date"
  const [secret,      setSecret]      = useState(loadSecret());   // CRON_SECRET for admin mutations
  const [busyId,      setBusyId]      = useState(null);   // id of the source mid-mutation
  const [adminMsg,    setAdminMsg]    = useState(null);   // { ok, text } feedback

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

  // ── Admin mutations (persist to DB via api/sources.js PATCH/DELETE) ──────────
  const authHeaders = () => ({
    "Content-Type": "application/json",
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  });

  const updateDate = useCallback((s, date) => {
    if (!date) return;
    setBusyId(s.id); setAdminMsg(null);
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, date_published: date }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(j => {
        // Reflect in local state immediately (already persisted in DB).
        setSources(prev => prev.map(x => x.id === s.id ? { ...x, date_published: j.date_published } : x));
        setAdminMsg({ ok: true, text: `Date updated → ${date}` });
      })
      .catch(e => setAdminMsg({ ok: false, text: `Date update failed: ${e.message}` }))
      .finally(() => setBusyId(null));
  }, [secret]);

  const deleteSource = useCallback((s) => {
    if (!window.confirm(`Delete this source permanently?\n\n${s.title || s.url}\n\nThis removes it (and its evidence) from the database.`)) return;
    setBusyId(s.id); setAdminMsg(null);
    fetch(`/api/sources?id=${encodeURIComponent(s.id)}`, { method: "DELETE", headers: authHeaders() })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(() => {
        setSources(prev => prev.filter(x => x.id !== s.id));
        setExpandedId(null);
        setAdminMsg({ ok: true, text: "Source deleted" });
      })
      .catch(e => setAdminMsg({ ok: false, text: `Delete failed: ${e.message}` }))
      .finally(() => setBusyId(null));
  }, [secret]);

  // Save classification (main_category + tags) — persists to DB; optimistic local
  // update with revert on failure. Gated by the admin secret like the others.
  const saveClassification = useCallback((s, { main_category, tags }) => {
    const prevCat = s.main_category, prevTags = s.tags;
    setBusyId(s.id); setAdminMsg(null);
    setSources(prev => prev.map(x => x.id === s.id ? { ...x, main_category, tags } : x));   // optimistic
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, main_category, tags }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(() => setAdminMsg({ ok: true, text: "Classification updated" }))
      .catch(err => {
        setSources(prev => prev.map(x => x.id === s.id ? { ...x, main_category: prevCat, tags: prevTags } : x));   // revert
        setAdminMsg({ ok: false, text: `Classification update failed: ${err.message}` });
      })
      .finally(() => setBusyId(null));
  }, [secret]);

  // Star toggle — persists starred to the DB; optimistic local update. No admin
  // secret required to READ starred, but the mutation is gated like the others.
  const toggleStar = useCallback((s, e) => {
    if (e) e.stopPropagation();
    const next = !s.starred;
    setSources(prev => prev.map(x => x.id === s.id ? { ...x, starred: next } : x));   // optimistic
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, starred: next }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); })
      .catch(err => {
        setSources(prev => prev.map(x => x.id === s.id ? { ...x, starred: s.starred } : x));   // revert
        setAdminMsg({ ok: false, text: `Star failed: ${err.message}` });
      });
  }, [secret]);

  // Flag toggle — marks a source needs_review (distinct from starring). Same
  // persist-with-revert pattern. 🚩 = "come back to this / mis-classified", vs
  // ★ = "bookmark/favorite".
  const toggleFlag = useCallback((s, e) => {
    if (e) e.stopPropagation();
    const next = !s.needs_review;
    setSources(prev => prev.map(x => x.id === s.id ? { ...x, needs_review: next } : x));   // optimistic
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, needs_review: next }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); })
      .catch(err => {
        setSources(prev => prev.map(x => x.id === s.id ? { ...x, needs_review: s.needs_review } : x));   // revert
        setAdminMsg({ ok: false, text: `Flag failed: ${err.message}` });
      });
  }, [secret]);

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

  // ── Composable, faceted filtering ────────────────────────────────────────────
  // Each active filter is one predicate. The visible list applies ALL of them.
  // For a given facet's option counts, we count over the rows that pass every
  // OTHER active predicate — so the numbers compose: the Starred count while
  // "Critical" is selected is "starred sources that are also Critical", and the
  // Label counts while "★ Starred" is on are "…among starred", etc. That is the
  // behaviour that was missing (each facet previously counted in isolation).
  const searchPred = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return null;
    return s => `${s.title || ""} ${s.publisher || ""} ${s.short_summary || s.summary || ""} ${(s.tags || []).join(" ")}`.toLowerCase().includes(q);
  }, [search]);

  const predicates = useMemo(() => ({
    category: activeTab === "all" ? null : (s => s.main_category === activeTab),
    label:    labelFilter ? (s => s.label === labelFilter) : null,
    tier:     tierFilter ? (s => s.importance?.tier === tierFilter) : null,
    starred:  starredOnly ? (s => s.starred) : null,
    flagged:  flaggedOnly ? (s => s.needs_review) : null,
    tags:     activeTags.length ? (s => activeTags.every(t => s.tags?.includes(t))) : null,
    search:   searchPred,
  }), [activeTab, labelFilter, tierFilter, starredOnly, flaggedOnly, activeTags, searchPred]);

  // Rows passing every predicate EXCEPT the named one (for that facet's counts).
  const rowsExcept = useCallback((exceptKey) => {
    const active = Object.entries(predicates).filter(([k, p]) => p && k !== exceptKey);
    return sources.filter(s => active.every(([, p]) => p(s)));
  }, [sources, predicates]);

  // The visible list: passes ALL predicates.
  const filtered = useMemo(() => {
    const active = Object.values(predicates).filter(Boolean);
    const rows = sources.filter(s => active.every(p => p(s)));
    if (sortBy === "importance") {
      rows.sort((a, b) => {
        const ra = TIER_META[a.importance?.tier]?.rank || 0;
        const rb = TIER_META[b.importance?.tier]?.rank || 0;
        if (rb !== ra) return rb - ra;
        const sa = sigRank(a), sb = sigRank(b);      // landmark research rises within its tier
        if (sb !== sa) return sb - sa;
        return (b.date_published || "").localeCompare(a.date_published || "");
      });
    }
    return rows; // already date-desc from the API when sortBy === "date"
  }, [sources, predicates, sortBy]);

  // Faceted counts — each computed over rows passing all OTHER active filters.
  const catCountsFaceted = useMemo(() => {
    const base = rowsExcept("category");
    const c = {};
    for (const s of base) if (s.main_category) c[s.main_category] = (c[s.main_category] || 0) + 1;
    return { counts: c, total: base.length };
  }, [rowsExcept]);

  const labelCounts = useMemo(() => {
    const base = rowsExcept("label");
    const c = {};
    for (const s of base) if (s.label) c[s.label] = (c[s.label] || 0) + 1;
    return c;
  }, [rowsExcept]);

  const tierCounts = useMemo(() => {
    const base = rowsExcept("tier");
    const c = {};
    for (const s of base) { const t = s.importance?.tier; if (t) c[t] = (c[t] || 0) + 1; }
    return c;
  }, [rowsExcept]);

  const starredCount = useMemo(() => rowsExcept("starred").filter(s => s.starred).length, [rowsExcept]);
  const flaggedCount = useMemo(() => rowsExcept("flagged").filter(s => s.needs_review).length, [rowsExcept]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // All distinct tags across the corpus, most-common first — feeds the tag editor's
  // autocomplete so manual tagging reuses the existing controlled vocabulary.
  const knownTags = useMemo(() => {
    const c = {};
    for (const s of sources) for (const t of (s.tags || [])) c[t] = (c[t] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t]) => t);
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
          <span className="hz-cat-tab-count">{catCountsFaceted.total}</span>
        </button>
        {ALL_CATS.map(cat => {
          const count = catCountsFaceted.counts[cat] ?? 0;
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
      {/* Categorical label filter — critical / important / supporting / archive */}
      <div className="hz-tier-filter-row">
        <span className="hz-tag-filter-label">Label</span>
        <div className="hz-tier-chips">
          {LABEL_ORDER.map(lb => {
            const m = LABEL_META[lb];
            const n = labelCounts[lb] || 0;
            const on = labelFilter === lb;
            if (!n && !on) return null;
            return (
              <button key={lb}
                className={`hz-tier-chip${on ? " active" : ""}`}
                style={on ? { background: m.color, borderColor: m.color, color: "#fff" } : { color: m.color, borderColor: `${m.color}55` }}
                onClick={() => { setLabelFilter(on ? null : lb); setPage(1); setExpandedId(null); }}>
                {m.short}<span className="hz-tier-chip-count">{n}</span>
              </button>
            );
          })}
          {labelFilter && <button className="hz-tag-clear" onClick={() => { setLabelFilter(null); setPage(1); }}>Clear</button>}
        </div>
      </div>

      <div className="hz-tier-filter-row">
        <span className="hz-tag-filter-label">Importance</span>
        <div className="hz-tier-chips">
          {TIER_ORDER.filter(t => tierCounts[t] || tierFilter === t).map(t => {
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
                {m.short}<span className="hz-tier-chip-count">{tierCounts[t] || 0}</span>
              </button>
            );
          })}
          {tierFilter && (
            <button className="hz-tag-clear" onClick={() => { setTierFilter(null); setPage(1); }}>Clear</button>
          )}
          {/* Starred filter — count reflects the other active filters (e.g. starred
              WITHIN the current category + label), so the facets compose. */}
          <button
            className={`hz-tier-chip hz-star-chip${starredOnly ? " active" : ""}`}
            onClick={() => { setStarredOnly(v => !v); setPage(1); setExpandedId(null); }}
            title="Show only starred sources (count reflects the other active filters)"
          >
            ★ Starred{starredCount ? <span className="hz-tier-chip-count">{starredCount}</span> : null}
          </button>
          {/* Flagged filter — sources marked needs_review (manual 🚩 or pipeline). */}
          <button
            className={`hz-tier-chip hz-flag-chip${flaggedOnly ? " active" : ""}`}
            onClick={() => { setFlaggedOnly(v => !v); setPage(1); setExpandedId(null); }}
            title="Show only flagged sources (needs review) — count reflects the other active filters"
          >
            🚩 Flagged{flaggedCount ? <span className="hz-tier-chip-count">{flaggedCount}</span> : null}
          </button>
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

      {/* Admin bar — the secret unlocks the per-source edit/delete controls (expand a row). */}
      <div className="hz-sources-admin-bar">
        <input
          className="hz-admin-secret"
          type="password"
          placeholder="Admin secret (CRON_SECRET) — to edit dates / delete"
          value={secret}
          onChange={e => { setSecret(e.target.value); saveSecret(e.target.value); }}
        />
        <span className="hz-admin-hint">Expand a source to edit its date or delete it.</span>
        {adminMsg && (
          <span className={`hz-admin-msg ${adminMsg.ok ? "ok" : "err"}`}>{adminMsg.text}</span>
        )}
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
                const colSpan = activeTab === "all" ? 8 : 7;   // +1 for the star column
                return (
                  <Fragment key={id}>
                    <tr
                      className={`hz-src-row${open ? " open" : ""}`}
                      onClick={() => setExpandedId(open ? null : id)}
                    >
                      <td className="hz-src-caret">{open ? "▾" : "▸"}</td>
                      <td className="hz-src-star-cell">
                        <div className="hz-src-mark-btns">
                          <button
                            className={`hz-star-btn${s.starred ? " on" : ""}`}
                            title={s.starred ? "Starred — click to unstar" : "Star this source"}
                            onClick={(e) => toggleStar(s, e)}
                          >
                            {s.starred ? "★" : "☆"}
                          </button>
                          <button
                            className={`hz-flag-btn${s.needs_review ? " on" : ""}`}
                            title={s.needs_review ? "Flagged for review — click to clear" : "Flag this source for review"}
                            onClick={(e) => toggleFlag(s, e)}
                          >
                            {s.needs_review ? "🚩" : "⚐"}
                          </button>
                        </div>
                      </td>
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
                      <td>
                        {LABEL_META[s.label] && (
                          <span className="hz-imp-badge" title={`Label: ${s.label}`}
                            style={{ color: LABEL_META[s.label].color, background: LABEL_META[s.label].bg, fontSize: "0.6rem", fontWeight: 700 }}>
                            {LABEL_META[s.label].short}
                          </span>
                        )}
                        {s.is_report && (
                          <span className="hz-imp-badge" title={`Landscape report${s.finding_count ? ` — ${s.finding_count} findings extracted` : ""}`}
                            style={{ color: "#7c3aed", background: "#ede9fe", fontSize: "0.6rem", marginLeft: 4 }}>
                            📄{s.finding_count ? ` ${s.finding_count}` : ""}
                          </span>
                        )}
                        <div style={{ marginTop: 2 }}>
                          <ImportanceBadge tier={s.importance?.tier} small />
                          {SIG_META[s.significance?.level] && (
                            <span className="hz-imp-badge" title={`Research significance: ${s.significance.level}${s.significance.reason ? " — " + s.significance.reason : ""}`}
                              style={{ color: SIG_META[s.significance.level].color, background: SIG_META[s.significance.level].bg, fontSize: "0.6rem", marginLeft: 4 }}>
                              {SIG_META[s.significance.level].short}
                            </span>
                          )}
                        </div>
                      </td>
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
                        <td colSpan={colSpan}>
                          <SourceDetail s={s} busy={busyId === s.id}
                            knownTags={knownTags}
                            onUpdateDate={updateDate} onDelete={deleteSource}
                            onSaveClassification={saveClassification} />
                        </td>
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
