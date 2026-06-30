/**
 * IngestionPage — ingestion health, connector breakdown, monthly trends.
 *
 * Two fetches:
 *   /api/ingestion-runs?limit=30   → recent run list
 *   /api/ingestion-runs?stats=1    → connector aggregates, monthly counts, source types
 *
 * Auto-refreshes every 30s. No new serverless function needed.
 */

import { useState, useEffect, useCallback } from "react";

const REFRESH_MS = 30_000;

// ── helpers ────────────────────────────────────────────────────────────────────

function relativeTime(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}
function dur(a, b) {
  if (!a || !b) return "—";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function statusBadge(s) {
  const cls = s === "success" ? "hz-badge-success" : s === "failed" ? "hz-badge-error"
    : s === "running" ? "hz-badge-running" : "hz-badge-neutral";
  return <span className={`hz-badge ${cls}`}>{s || "—"}</span>;
}
function fmtMonth(mo) {
  if (!mo) return mo;
  const [y, m] = mo.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[Number(m) - 1]} ${y.slice(2)}`;
}

// ── Mini bar chart (SVG) ───────────────────────────────────────────────────────

function MonthlyChart({ monthly }) {
  if (!monthly?.length) return <div className="hz-ingestion-empty">No monthly data yet.</div>;
  const W = 600, H = 140, PAD_L = 32, PAD_B = 28, PAD_T = 8, PAD_R = 8;
  const gW = W - PAD_L - PAD_R;
  const gH = H - PAD_B - PAD_T;
  const maxTotal = Math.max(...monthly.map(m => m.total), 1);
  const barW = Math.max(4, Math.floor(gW / monthly.length) - 3);
  const xPos = (i) => PAD_L + (i / monthly.length) * gW + (gW / monthly.length - barW) / 2;
  const yH   = (v) => Math.max(1, (v / maxTotal) * gH);
  const yTop = (v) => PAD_T + gH - yH(v);

  const ticks = [0, Math.round(maxTotal / 2), maxTotal].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={PAD_L} y1={yTop(v)} x2={W - PAD_R} y2={yTop(v)}
            stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3 3" />
          <text x={PAD_L - 4} y={yTop(v) + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{v}</text>
        </g>
      ))}
      {monthly.map((m, i) => (
        <g key={m.month}>
          {/* total bar (muted) */}
          <rect x={xPos(i)} y={yTop(m.total)} width={barW} height={yH(m.total)}
            fill="#dbeafe" rx="1" />
          {/* pass bar (solid) */}
          <rect x={xPos(i)} y={yTop(m.pass)} width={barW} height={yH(m.pass)}
            fill="#3b82f6" rx="1" />
          <text x={xPos(i) + barW / 2} y={H - 8} textAnchor="middle" fontSize="8" fill="#9ca3af">
            {fmtMonth(m.month)}
          </text>
        </g>
      ))}
      {/* legend */}
      <rect x={PAD_L} y={H - 3} width={10} height={5} fill="#dbeafe" rx="1" />
      <text x={PAD_L + 13} y={H} fontSize="8" fill="#9ca3af">Fetched</text>
      <rect x={PAD_L + 58} y={H - 3} width={10} height={5} fill="#3b82f6" rx="1" />
      <text x={PAD_L + 71} y={H} fontSize="8" fill="#9ca3af">Passed</text>
    </svg>
  );
}

// ── Source type bar ────────────────────────────────────────────────────────────

function SourceTypeBar({ types }) {
  if (!types?.length) return null;
  const total = types.reduce((s, t) => s + t.count, 0) || 1;
  const TOP_COLORS = ["#3b82f6","#6366f1","#8b5cf6","#ec4899","#f97316","#10b981","#14b8a6","#f59e0b"];
  const top10 = types.slice(0, 10);
  return (
    <div className="hz-type-bar-wrap">
      <div className="hz-type-bar">
        {top10.map((t, i) => (
          <div key={t.type}
            className="hz-type-bar-seg"
            style={{ width: `${(t.count / total * 100).toFixed(1)}%`, background: TOP_COLORS[i % TOP_COLORS.length] }}
            title={`${t.type}: ${t.count}`}
          />
        ))}
      </div>
      <div className="hz-type-legend">
        {top10.map((t, i) => (
          <div key={t.type} className="hz-type-legend-item">
            <span className="hz-type-dot" style={{ background: TOP_COLORS[i % TOP_COLORS.length] }} />
            <span className="hz-type-label">{t.type.replace(/_/g, " ")}</span>
            <span className="hz-type-count">{t.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Connector table ────────────────────────────────────────────────────────────

const TRUST_COLOR = { primary: "#15803d", high: "#1d4ed8", medium: "#92400e", low: "#6b7280" };

function ConnectorTable({ connectors }) {
  if (!connectors?.length) return <div className="hz-ingestion-empty">No connector data yet.</div>;
  return (
    <div className="hz-conn-table-wrap">
      <table className="hz-conn-table">
        <thead>
          <tr>
            <th>Connector</th>
            <th>Trust</th>
            <th>Method</th>
            <th className="hz-col-r">Total fetched</th>
            <th className="hz-col-r">Runs active</th>
            <th className="hz-col-r">Last run</th>
            <th className="hz-col-r">Failures</th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((c) => (
            <tr key={c.connector}>
              <td className="hz-conn-name">{c.connector}</td>
              <td>
                <span className="hz-conn-trust" style={{ color: TRUST_COLOR[c.trust_tier] || "#6b7280" }}>
                  {c.trust_tier || "—"}
                </span>
              </td>
              <td className="hz-conn-method">{(c.retrieval_method || "—").replace(/_/g, " ")}</td>
              <td className="hz-col-r hz-conn-total">{c.total_fetched.toLocaleString()}</td>
              <td className="hz-col-r hz-conn-active">{c.runs_active}</td>
              <td className="hz-col-r hz-conn-last">{c.last_count != null ? c.last_count : "—"}</td>
              <td className="hz-col-r">
                {c.runs_failed > 0
                  ? <span className="hz-conn-fail-count">{c.runs_failed}</span>
                  : <span className="hz-conn-ok-mark">✓</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function IngestionPage() {
  const [runs,    setRuns]    = useState([]);
  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [expanded, setExpanded]   = useState(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch("/api/ingestion-runs?limit=30",  { cache: "no-store" }).then(x => x.json()),
        fetch("/api/ingestion-runs?stats=1",   { cache: "no-store" }).then(x => x.json()),
      ]);
      if (r.error) throw new Error(r.error);
      setRuns(r.runs || []);
      setStats(s.error ? null : s);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // Derived from run list
  const latest   = runs[0] || null;
  const running  = runs.some(r => r.status === "running");
  const last24h  = runs.filter(r => r.started_at && (Date.now() - new Date(r.started_at) < 864e5));
  const pass24h  = last24h.reduce((n, r) => n + (r.source_count || 0), 0);

  const latestCR = (() => {
    const cr = latest?.connector_results;
    if (!cr) return null;
    const arr = Array.isArray(cr) ? cr : Object.values(cr);
    const ok    = arr.filter(c => c.status === "fulfilled" && c.count > 0);
    const empty = arr.filter(c => c.status === "fulfilled" && c.count === 0);
    const failed= arr.filter(c => c.status === "rejected");
    return { ok, empty, failed, total: arr.length };
  })();

  // Monthly stats derived totals
  const monthly = stats?.monthly || [];
  const corpusTotal = monthly.reduce((s, m) => s + m.total, 0);
  const corpusPass  = monthly.reduce((s, m) => s + m.pass, 0);
  const passRate    = corpusTotal ? Math.round(100 * corpusPass / corpusTotal) : 0;

  return (
    <div className="hz-ingestion-page">
      {/* Header */}
      <div className="hz-ingestion-head">
        <div>
          <h2 className="hz-ingestion-title">Ingestion</h2>
          <p className="hz-ingestion-sub">
            Pipeline health · connector yields · auto-refreshes every 30s
            {lastFetch && <span className="hz-ingestion-fetched"> · updated {relativeTime(lastFetch.toISOString())}</span>}
          </p>
        </div>
        <button className="hz-ingestion-refresh" onClick={load} title="Refresh now">↻</button>
      </div>

      {error   && <div className="hz-ingestion-error">Could not load: {error}</div>}
      {loading && !runs.length && <div className="hz-ingestion-loading">Loading…</div>}

      {/* Status cards */}
      <div className="hz-ingestion-cards">
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Status</div>
          <div className="hz-ingestion-card-value">
            {running
              ? <span className="hz-badge hz-badge-running">running</span>
              : <span className="hz-badge hz-badge-success">idle</span>}
          </div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Last run</div>
          <div className="hz-ingestion-card-value">{latest ? relativeTime(latest.started_at) : "—"}</div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Sources (24h)</div>
          <div className="hz-ingestion-card-value">{pass24h}</div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Corpus (pass)</div>
          <div className="hz-ingestion-card-value">{corpusPass.toLocaleString()}</div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Pass rate (Jul–Jun)</div>
          <div className="hz-ingestion-card-value">{corpusTotal ? `${passRate}%` : "—"}</div>
        </div>
        {latestCR && (
          <div className="hz-ingestion-card">
            <div className="hz-ingestion-card-label">Connectors (last)</div>
            <div className="hz-ingestion-card-value hz-ingestion-conn">
              <span className="hz-conn-ok">{latestCR.ok.length} ✓</span>
              <span className="hz-conn-empty">{latestCR.empty.length} ∅</span>
              {latestCR.failed.length > 0 && <span className="hz-conn-fail">{latestCR.failed.length} ✗</span>}
            </div>
          </div>
        )}
      </div>

      {/* Monthly trend */}
      <div className="hz-ingestion-section-title">Monthly ingestion — Jul 2025 to Jun 2026</div>
      <div className="hz-chart-box">
        <MonthlyChart monthly={monthly} />
      </div>

      {/* Source type breakdown */}
      <div className="hz-ingestion-section-title">Source types in corpus (pass only)</div>
      <SourceTypeBar types={stats?.source_types} />

      {/* Connector table */}
      <div className="hz-ingestion-section-title">Connectors — cumulative yield</div>
      <ConnectorTable connectors={stats?.connectors} />

      {/* Recent runs */}
      <div className="hz-ingestion-section-title">Recent runs</div>
      <div className="hz-ingestion-runs">
        {runs.map((r) => {
          const pc   = r.pipeline_counts || {};
          const open = expanded === r.id;
          const cr   = (() => {
            const raw = r.connector_results;
            if (!raw) return [];
            return (Array.isArray(raw) ? raw : Object.values(raw))
              .slice().sort((a, b) => (b.count || 0) - (a.count || 0));
          })();
          return (
            <div key={r.id} className={`hz-run-row${open ? " open" : ""}`}>
              <div className="hz-run-main" onClick={() => setExpanded(open ? null : r.id)}>
                {statusBadge(r.status)}
                <span className="hz-run-time">{relativeTime(r.started_at)}</span>
                <span className="hz-run-count">{r.source_count ?? 0} sources</span>
                <span className="hz-run-meta">
                  {pc.raw != null && `${pc.raw} raw → ${pc.validation_accepted ?? r.source_count ?? 0} accepted`}
                </span>
                <span className="hz-run-dur">{dur(r.started_at, r.finished_at)}</span>
                <span className="hz-run-toggle">{open ? "▲" : "▼"}</span>
              </div>
              {open && (
                <div className="hz-run-detail">
                  {Object.keys(pc).length > 0 && (
                    <div className="hz-run-counts">
                      {Object.entries(pc).map(([k, v]) => (
                        <span key={k} className="hz-run-count-chip"><b>{v}</b> {k.replace(/_/g, " ")}</span>
                      ))}
                    </div>
                  )}
                  {cr.length > 0 && (
                    <div className="hz-run-connectors">
                      {cr.map((c, i) => (
                        <span key={i}
                          className={`hz-conn-chip ${c.status === "rejected" ? "fail" : c.count === 0 ? "empty" : "ok"}`}
                          title={c.error || ""}>
                          {c.connector}: {c.status === "rejected" ? "err" : c.count}
                        </span>
                      ))}
                    </div>
                  )}
                  {r.error_message && <div className="hz-run-error">{r.error_message}</div>}
                </div>
              )}
            </div>
          );
        })}
        {!runs.length && !loading && <div className="hz-ingestion-empty">No ingestion runs recorded.</div>}
      </div>
    </div>
  );
}
