/**
 * SourcesPage — category tabs + sub-tag exploration + period pill switcher.
 * No trust-tier filter. Categories are first-class tabs.
 */

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { LegendPanel, TaxonomyPanel, TAXONOMY_GROUPS } from "../../components/dashboard/LegendPanel.jsx";
import { getAdminToken, getAccessLevel, onAuthChange } from "../../auth.js";

// Build a flat id → label map from the taxonomy so tags render as human-readable names.
const TAG_LABEL = new Map(
  TAXONOMY_GROUPS.flatMap(g => g.tags.map(t => [t.id, t.label]))
);

// Format any tag ID for display: use the taxonomy label if known,
// otherwise clean up underscores and capitalise.
function tagLabel(id) {
  if (TAG_LABEL.has(id)) return TAG_LABEL.get(id);
  return id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

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
// Evidence-maturity ladder — UNIFIED with the dashboard (lib/dashboard/
// evidenceMaturity.js MATURITY_RUNGS). Same five rungs, same words, same colours,
// so the Sources page and the Overview page never disagree on how "real" a threat
// is. Read from each source's `maturity` field (API). Higher rank = more mature.
const TIER_META = {
  operational:  { label: "Operational",  short: "Operational",  color: "#7f1d1d", bg: "#fee2e2", rank: 5 },
  observed:     { label: "Observed",     short: "Observed",     color: "#ef4444", bg: "#fee2e2", rank: 4 },
  disclosed:    { label: "Disclosed",    short: "Disclosed",    color: "#b45309", bg: "#ffedd5", rank: 3 },
  demonstrated: { label: "Demonstrated", short: "Demonstrated", color: "#1d4ed8", bg: "#dbeafe", rank: 2 },
  research:     { label: "Research",     short: "Research",     color: "#475569", bg: "#f1f5f9", rank: 1 },
};
const TIER_ORDER = ["operational", "observed", "disclosed", "demonstrated", "research"];

// Reading value — essential/recommended/analyst/background.
// Null until scripts/labelSources.js backfill runs on the corpus.
const LABEL_META = {
  essential:   { short: "Essential",   color: "#b91c1c", bg: "#fee2e2" },
  recommended: { short: "Recommended", color: "#c2410c", bg: "#ffedd5" },
  analyst:     { short: "Analyst",     color: "#475569", bg: "#e2e8f0" },
  background:  { short: "Background",  color: "#94a3b8", bg: "#f1f5f9" },
};
const LABEL_ORDER = ["essential", "recommended", "analyst", "background"];

const sigRank = () => 0;

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
    <span className="hz-imp-badge" title={`Evidence maturity: ${m.label}`}
      style={{ color: m.color, background: m.bg, fontSize: small ? "0.6rem" : "0.66rem" }}>
      {small ? m.short : m.label}
    </span>
  );
}

const DIRECTION_META = {
  increasing: { label: "Increasing", color: "#b91c1c", bg: "#fee2e2" },
  decreasing: { label: "Decreasing", color: "#15803d", bg: "#dcfce7" },
  emerging:   { label: "Emerging",   color: "#7c3aed", bg: "#ede9fe" },
  stable:     { label: "Stable",     color: "#475569", bg: "#e2e8f0" },
};

function WalkthroughBody({ w }) {
  return (
    <div className="hz-wt-body">
      {w.mechanism && (
        <div className="hz-wt-meta">
          <span className="hz-wt-meta-k">Mechanism</span>
          <span className="hz-wt-meta-v">{w.mechanism}</span>
        </div>
      )}

      {w.steps?.length > 0 && (
        <div className="hz-wt-steps">
          {w.steps.map((step, si) => (
            <div key={si} className="hz-wt-step">
              <span className="hz-wt-step-n">{si + 1}</span>
              <span className="hz-wt-step-text">{step}</span>
            </div>
          ))}
        </div>
      )}

      {w.quote && (
        <blockquote className="hz-wt-quote">{w.quote}</blockquote>
      )}
    </div>
  );
}

function ReportAnalysis({ ra }) {
  const [openWt, setOpenWt] = useState(null);
  if (!ra) return null;
  const { report_summary, attack_walkthroughs = [], critical_insights = [], trends = [] } = ra;
  const total = attack_walkthroughs.length + critical_insights.length + trends.length;
  if (total === 0) return null;

  return (
    <div className="hz-report-analysis">
      <div className="hz-ra-header">
        <span className="hz-ra-title">Report Intelligence</span>
        <span className="hz-ra-counts">
          {attack_walkthroughs.length > 0 && <span>{attack_walkthroughs.length} walkthroughs</span>}
          {critical_insights.length > 0   && <span>{critical_insights.length} insights</span>}
          {trends.length > 0              && <span>{trends.length} trends</span>}
        </span>
      </div>

      {report_summary && (
        <p className="hz-ra-summary">{report_summary}</p>
      )}

      {attack_walkthroughs.length > 0 && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">Attack Walkthroughs</div>
          {attack_walkthroughs.map((w, i) => (
            <div key={i} className={`hz-wt${openWt === i ? " open" : ""}`}>
              <button className="hz-wt-header" onClick={() => setOpenWt(openWt === i ? null : i)}>
                <span className="hz-wt-caret">{openWt === i ? "▾" : "▸"}</span>
                <span className="hz-wt-technique">{w.technique}</span>
              </button>
              {openWt === i && (
                <WalkthroughBody w={w} />
              )}
            </div>
          ))}
        </div>
      )}

      {critical_insights.length > 0 && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">Critical Insights</div>
          <div className="hz-ra-insights">
            {critical_insights.map((ins, i) => (
              <div key={i} className="hz-ra-insight">
                <div className="hz-ra-insight-finding">{ins.finding}</div>
                {ins.taxonomy_hint && (
                  <span className="hz-src-detail-tag domain" style={{ marginTop: 4, display: "inline-block" }}>{ins.taxonomy_hint}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {trends.length > 0 && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">Observed Trends</div>
          <div className="hz-ra-trends">
            {trends.map((t, i) => {
              const dm = DIRECTION_META[t.direction] || DIRECTION_META.stable;
              return (
                <div key={i} className="hz-ra-trend">
                  <span className="hz-ra-trend-dir" style={{ color: dm.color, background: dm.bg }}>{dm.label}</span>
                  <span className="hz-ra-trend-text">{t.trend}</span>
                  {t.timeframe && <span className="hz-ra-trend-time">{t.timeframe}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── MITRE ATLAS chain panel ───────────────────────────────────────────────────

function mermaidInkUrl(dsl) {
  try {
    const b64 = btoa(unescape(encodeURIComponent(dsl)));
    return `https://mermaid.ink/img/${b64}?type=png&bgColor=F8FAFC&width=900`;
  } catch {
    return null;
  }
}

function AtlasChainPanel({ atlas }) {
  const [showDiagram, setShowDiagram] = useState(false);
  const [imgError,    setImgError]    = useState(false);
  if (!atlas) return null;

  const { atlas_id, atlas_type, actor_type, incident_date, publication_date,
          chain = [], chain_analysis, references = [], mermaid } = atlas;
  const diagramUrl = mermaid && !imgError ? mermaidInkUrl(mermaid) : null;

  // Compute readable lag between incident and publication
  const dateLag = (() => {
    if (!incident_date || !publication_date) return null;
    const months = Math.round(
      (new Date(publication_date) - new Date(incident_date)) / (1000 * 60 * 60 * 24 * 30)
    );
    if (months <= 0) return null;
    return months === 1 ? "1 month after incident" : `${months} months after incident`;
  })();

  return (
    <div className="hz-atlas-panel">
      <div className="hz-ra-header">
        <span className="hz-ra-title">MITRE ATLAS Case Study</span>
        <span className="hz-ra-counts">
          <span>{atlas_id}</span>
          {atlas_type && <span>{atlas_type}</span>}
          {actor_type && <span>{actor_type}</span>}
        </span>
      </div>

      {/* Date provenance */}
      {(incident_date || publication_date) && (
        <div className="hz-atlas-dates">
          {incident_date && (
            <span className="hz-atlas-date-item">
              <span className="hz-atlas-date-k">Incident</span>
              <span className="hz-atlas-date-v">{incident_date}</span>
            </span>
          )}
          {publication_date && (
            <span className="hz-atlas-date-item">
              <span className="hz-atlas-date-k">Documented</span>
              <span className="hz-atlas-date-v">{publication_date}{dateLag ? ` (${dateLag})` : ""}</span>
            </span>
          )}
        </div>
      )}

      {/* Chain structural analysis */}
      {chain_analysis && (chain_analysis.trust_boundary_crossings?.length > 0 ||
                          chain_analysis.kill_chain_compressed ||
                          chain_analysis.has_unusual_ordering) && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">Chain Analysis</div>
          <div className="hz-atlas-chain-analysis">
            {chain_analysis.trust_boundary_crossings?.length > 0 && (
              <span className="hz-atlas-ca-tag" title="Attack crosses component trust boundaries">
                ⛓ {chain_analysis.trust_boundary_crossings.join(", ")}
              </span>
            )}
            {chain_analysis.kill_chain_compressed && (
              <span className="hz-atlas-ca-tag" title="Compressed kill chain — few tactic phases for step count">
                ⚡ Compressed chain ({chain_analysis.tactic_phases_covered} phases / {chain_analysis.step_count} steps)
              </span>
            )}
            {chain_analysis.has_unusual_ordering && (
              <span className="hz-atlas-ca-tag" title="Techniques executed out of canonical ATLAS tactic order">
                ↺ Non-linear tactic ordering
              </span>
            )}
          </div>
        </div>
      )}

      {/* Attack chain steps */}
      {chain.length > 0 && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">Attack Chain ({chain.length} steps)</div>
          <div className="hz-atlas-chain">
            {chain.map((step, i) => (
              <div key={step.order ?? i} className="hz-atlas-step">
                <span className="hz-atlas-step-n">{step.order ?? i + 1}</span>
                <div className="hz-atlas-step-body">
                  <div className="hz-atlas-step-header">
                    <span className="hz-atlas-tech-id">{step.technique_id}</span>
                    <span className="hz-atlas-tech-name">{step.technique_name}</span>
                  </div>
                  {step.description && (
                    <p className="hz-atlas-step-desc">{step.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attack chain diagram */}
      {mermaid && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">
            Attack Flow Diagram
            <button
              className="hz-atlas-diagram-toggle"
              onClick={() => { setShowDiagram(v => !v); setImgError(false); }}
            >
              {showDiagram ? "Hide" : "Show"}
            </button>
          </div>
          {showDiagram && diagramUrl && !imgError && (
            <img
              className="hz-atlas-diagram"
              src={diagramUrl}
              alt={`Attack flow diagram for ${atlas_id}`}
              onError={() => setImgError(true)}
            />
          )}
          {showDiagram && imgError && (
            <p className="hz-atlas-diagram-error">
              Diagram could not be rendered. Mermaid source is stored and available.
            </p>
          )}
        </div>
      )}

      {/* Reference sources */}
      {references.length > 0 && (
        <div className="hz-ra-section">
          <div className="hz-ra-section-label">References ({references.length})</div>
          <div className="hz-atlas-refs">
            {references.map((ref, i) => (
              <div key={i} className="hz-atlas-ref">
                {ref.reference_type && ref.reference_type !== "report" && (
                  <span className="hz-atlas-ref-type">{ref.reference_type}</span>
                )}
                <a href={ref.url} target="_blank" rel="noopener noreferrer" className="hz-atlas-ref-link">
                  {ref.title || ref.url}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Expanded detail — everything an analyst needs to vet the source without opening it.
// Also hosts the admin controls: edit the publish date and delete the source.
function SourceDetail({ s, isAdmin, onUpdateDate, onConfirmDate, onDelete, onSaveClassification, onSaveSummary, knownTags, busy }) {
  const imp  = s.importance || {};
  const mech = s.mechanism || null;
  const full = s.short_summary || s.analyst_brief || s.summary;
  const domainTag = t => /^(TAI|LLM|ASI|AE)\d/.test(t);
  const [dateVal, setDateVal] = useState((s.date_published || "").slice(0, 10));
  const dirty = dateVal && dateVal !== (s.date_published || "").slice(0, 10);

  // Summary editor
  const [summaryVal, setSummaryVal] = useState(s.short_summary || "");
  const summaryDirty = summaryVal.trim() !== (s.short_summary || "").trim();

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

      <ReportAnalysis ra={s.report_analysis} />
      <AtlasChainPanel atlas={s.atlas} />

      <div className="hz-src-detail-grid">
        <div className="hz-src-detail-field">
          <span className="hz-src-detail-k">Evidence maturity</span>
          <span className="hz-src-detail-v">
            <ImportanceBadge tier={s.maturity} />
            {LABEL_META[s.label] && (
              <span className="hz-imp-badge" title={`Priority label: ${s.label}`}
                style={{ color: LABEL_META[s.label].color, background: LABEL_META[s.label].bg, fontSize: "0.6rem", fontWeight: 700, marginLeft: 4 }}>
                {LABEL_META[s.label].short}
              </span>
            )}
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
              <span key={t} title={t} className={`hz-src-detail-tag${domainTag(t) ? " domain" : ""}`}>{tagLabel(t)}</span>
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

      {/* Admin controls — only shown when accessLevel === 'admin' */}
      {isAdmin && <div className="hz-src-admin" onClick={e => e.stopPropagation()}>
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

        <div className="hz-src-admin-row hz-src-summary-row">
          <label className="hz-src-admin-summary">
            Summary
            <textarea
              className="hz-src-summary-textarea"
              value={summaryVal}
              disabled={busy}
              rows={4}
              maxLength={1000}
              onChange={e => setSummaryVal(e.target.value)}
            />
          </label>
          <div className="hz-src-summary-footer">
            <span className="hz-src-summary-count">{summaryVal.length}/1000</span>
            <button className="hz-src-admin-save" disabled={!summaryDirty || busy}
              onClick={() => onSaveSummary(s, summaryVal.trim())}>
              {busy ? "Saving…" : "Save summary"}
            </button>
          </div>
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
          {/* Confirm the existing date as authoritative (date_confidence → exact)
              without changing its value. Shows a confirmed state when already exact. */}
          {s.date_confidence === "exact" ? (
            <span className="hz-src-date-confirmed" title="Publish date is confirmed (exact)">✓ Date confirmed</span>
          ) : (
            <button className="hz-src-admin-confirm" disabled={busy || !dateVal}
              title="Mark this publish date as confirmed/exact — re-admits the source to the newsletter, chatbot, slides, and insights"
              onClick={() => onConfirmDate(s)}>
              {busy ? "Saving…" : "Confirm date exact"}
            </button>
          )}
          <button className="hz-src-admin-delete" disabled={busy}
            onClick={() => onDelete(s)}>
            Delete source
          </button>
        </div>
        {s.date_discovered && (
          <div className="hz-src-admin-row hz-src-ingest-row">
            <span className="hz-src-detail-k">Date ingested</span>
            <span className="hz-src-ingest-date">{s.date_discovered.slice(0, 10)}</span>
            <span className="hz-src-ingest-note">
              {(s.date_confidence === "low" || s.date_confidence === "none") &&
                "Publish date unconfirmed — ingestion date shown in the table instead"}
              {s.date_confidence === "estimated" && "Publish date is estimated"}
              {s.date_confidence === "exact" && "Publish date is confirmed exact"}
              {!s.date_confidence && "Date confidence unknown"}
            </span>
          </div>
        )}
      </div>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SourcesPage() {
  const [showLegend,    setShowLegend]    = useState(false);
  const [showTaxonomy,  setShowTaxonomy]  = useState(false);
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
  const [sortBy,      setSortBy]      = useState("importance"); // "importance" | "date" | "ingested"
  const [accessLevel, setAccessLevel] = useState(getAccessLevel);
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
  useEffect(() => onAuthChange(() => setAccessLevel(getAccessLevel())), []);

  // ── Admin mutations (persist to DB via api/sources.js PATCH/DELETE) ──────────
  const authHeaders = () => {
    const tok = getAdminToken();
    return {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    };
  };
  const updateDate = useCallback((s, date) => {
    if (!date) return;
    setBusyId(s.id); setAdminMsg(null);
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, date_published: date }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(j => {
        // A date edit confirms the date: server sets date_confidence="exact" and
        // clears needs_review — reflect all three locally (already persisted).
        setSources(prev => prev.map(x => x.id === s.id
          ? { ...x, date_published: j.date_published, date_confidence: "exact", needs_review: false } : x));
        setAdminMsg({ ok: true, text: `Date confirmed → ${date} (marked exact)` });
      })
      .catch(e => setAdminMsg({ ok: false, text: `Date update failed: ${e.message}` }))
      .finally(() => setBusyId(null));
  }, []);

  // Confirm the EXISTING date as authoritative without changing its value:
  // re-sends the current date so the server marks date_confidence="exact" and
  // clears the review flag, re-admitting the source to newsletter/agent/slides.
  const confirmDate = useCallback((s) => {
    const date = (s.date_published || "").slice(0, 10);
    if (!date) { setAdminMsg({ ok: false, text: "No date to confirm — enter one first" }); return; }
    updateDate(s, date);
  }, [updateDate]);

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
  }, []);

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
  }, []);

  const saveSummary = useCallback((s, summary) => {
    const prev = s.short_summary;
    setBusyId(s.id); setAdminMsg(null);
    setSources(prev => prev.map(x => x.id === s.id ? { ...x, short_summary: summary } : x));  // optimistic
    fetch("/api/sources", {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({ id: s.id, short_summary: summary }),
    })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then(() => setAdminMsg({ ok: true, text: "Summary updated" }))
      .catch(err => {
        setSources(prev => prev.map(x => x.id === s.id ? { ...x, short_summary: prev } : x));  // revert
        setAdminMsg({ ok: false, text: `Summary update failed: ${err.message}` });
      })
      .finally(() => setBusyId(null));
  }, []);

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
  }, []);

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
  }, []);

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
    tier:     tierFilter ? (s => s.maturity === tierFilter) : null,
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
        const ra = TIER_META[a.maturity]?.rank || 0;
        const rb = TIER_META[b.maturity]?.rank || 0;
        if (rb !== ra) return rb - ra;
        const sa = sigRank(a), sb = sigRank(b);      // landmark research rises within its tier
        if (sb !== sa) return sb - sa;
        return (b.date_published || "").localeCompare(a.date_published || "");
      });
    } else if (sortBy === "ingested") {
      rows.sort((a, b) => (b.date_collected || "").localeCompare(a.date_collected || ""));
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
    for (const s of base) { const t = s.maturity; if (t) c[t] = (c[t] || 0) + 1; }
    return c;
  }, [rowsExcept]);

  const starredCount = useMemo(() => rowsExcept("starred").filter(s => s.starred).length, [rowsExcept]);
  const flaggedCount = useMemo(() => rowsExcept("flagged").filter(s => s.needs_review).length, [rowsExcept]);

  // Group child sources immediately after their parent so digest findings are
  // always adjacent to the report they came from. Children whose parent is not
  // in the current filtered set appear in place (they match a filter the parent
  // doesn't, e.g. a specific category tab).
  const grouped = useMemo(() => {
    const childMap = new Map();
    for (const s of filtered) {
      if (s.parent_source_id) {
        if (!childMap.has(s.parent_source_id)) childMap.set(s.parent_source_id, []);
        childMap.get(s.parent_source_id).push(s);
      }
    }
    const result = [];
    const placed = new Set();
    for (const s of filtered) {
      if (placed.has(s.id)) continue;
      result.push(s);
      placed.add(s.id);
      // If this is a parent source, slot its children right below it.
      for (const child of (childMap.get(s.id) || [])) {
        if (!placed.has(child.id)) { result.push(child); placed.add(child.id); }
      }
    }
    return result;
  }, [filtered]);

  const totalPages = Math.ceil(grouped.length / PAGE_SIZE);
  const paged = grouped.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="hz-legend-btn" onClick={() => setShowLegend(true)} title="Labels, maturity, and reading value">
            ⓘ Legend
          </button>
          <button className="hz-legend-btn" onClick={() => setShowTaxonomy(true)} title="Taxonomy tag reference">
            ⓘ Taxonomy
          </button>
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
      </div>

      {showLegend    && <LegendPanel    onClose={() => setShowLegend(false)} />}
      {showTaxonomy  && <TaxonomyPanel  onClose={() => setShowTaxonomy(false)} />}

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
                  {tagLabel(tag)}
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
          <button className={`hz-seg-btn${sortBy === "ingested" ? " active" : ""}`}
            onClick={() => { setSortBy("ingested"); setPage(1); }}>Ingested</button>
        </div>
        <span className="hz-sources-count">
          {loading ? "Loading…" : `${filtered.length.toLocaleString()} source${filtered.length !== 1 ? "s" : ""}`}
          {activeTab !== "all" && (
            <span className="hz-sources-count-cat"> in {CAT_LABEL_FULL[activeTab] || activeTab}</span>
          )}
        </span>
      </div>

      {adminMsg && (
        <div className="hz-sources-admin-bar">
          <span className={`hz-admin-msg ${adminMsg.ok ? "ok" : "err"}`}>{adminMsg.text}</span>
        </div>
      )}

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
                      className={`hz-src-row${open ? " open" : ""}${s.is_child_source ? " hz-src-row-child" : ""}`}
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
                          {s.is_child_source
                            ? <span className="hz-src-child-marker" title="Sub-finding from a longer report">↳</span>
                            : <TrustDot tier={s.trust_tier} />
                          }
                          <div>
                            {s.is_child_source ? (
                              <>
                                {/* Sub-finding title — the specific finding within the parent report */}
                                {s.url
                                  ? <a href={s.url} target="_blank" rel="noopener noreferrer"
                                       className="hz-src-link hz-src-child-finding"
                                       onClick={e => e.stopPropagation()}>
                                      {s.finding_title || s.title}
                                    </a>
                                  : <span className="hz-src-link-plain hz-src-child-finding">
                                      {s.finding_title || s.title}
                                    </span>
                                }
                                {/* Parent report attribution */}
                                <div className="hz-src-child-parent-ref">
                                  from: <span>{s.parent_title || s.title.split(" [")[0]}</span>
                                </div>
                              </>
                            ) : (
                              <>
                                {s.url
                                  ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hz-src-link"
                                       onClick={e => e.stopPropagation()}>
                                      {s.title || "(no title)"}
                                    </a>
                                  : <span className="hz-src-link-plain">{s.title || "(no title)"}</span>
                                }
                              </>
                            )}
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
                          <ImportanceBadge tier={s.maturity} small />
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
                              title={t}
                              onClick={e => { e.stopPropagation(); activeTab !== "all" && toggleTag(t); }}
                              style={{
                                cursor: activeTab !== "all" ? "pointer" : "default",
                                ...(activeTags.includes(t) ? { background: tabColor, borderColor: tabColor, color: "#fff" } : {}),
                              }}>
                              {tagLabel(t)}
                            </button>
                          ))}
                          {(s.tags || []).length > 3 && (
                            <span className="hz-src-tag-more">+{s.tags.length - 3}</span>
                          )}
                        </div>
                      </td>
                      <td className="hz-src-date">
                        {s.date_confidence === "low" || s.date_confidence === "none" || !s.date_published ? (
                          <span className="hz-src-date-unconfirmed" title="Publish date unconfirmed — showing ingestion date">
                            <span className="hz-src-date-warn">?</span>
                            {s.date_discovered ? s.date_discovered.slice(0, 10) : "—"}
                            <span className="hz-src-date-ingest-label">ingested</span>
                          </span>
                        ) : (
                          <>
                            {s.date_published.slice(0, 10)}
                            {s.date_confidence === "estimated" && (
                              <span className="hz-src-date-est" title="Publish date is estimated">~</span>
                            )}
                          </>
                        )}
                        {s.date_collected && (
                          <div className="hz-src-date-collected" title="Date ingested into the system">
                            {s.date_collected.slice(0, 10)}
                            <span className="hz-src-date-ingest-label">ingested</span>
                          </div>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="hz-src-detail-row">
                        <td colSpan={colSpan}>
                          <SourceDetail s={s} busy={busyId === s.id}
                            isAdmin={accessLevel === "admin"}
                            knownTags={knownTags}
                            onUpdateDate={updateDate} onConfirmDate={confirmDate} onDelete={deleteSource}
                            onSaveClassification={saveClassification}
                            onSaveSummary={saveSummary} />
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
              &nbsp;({(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, grouped.length)} of {grouped.length})
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
