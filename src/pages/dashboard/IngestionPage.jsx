/**
 * IngestionPage — real-time ingestion progress.
 *
 * Reads the existing /api/ingestion-runs and /api/snapshots endpoints (no new
 * serverless function — we're at the Hobby 12-function cap). Auto-refreshes every
 * 20s so the page reflects live cron / GitHub-Actions activity. Shows: recent
 * ingestion runs (status, source counts, connector health, timing), snapshot
 * history, and connector yield from the latest run.
 */

import { useState, useEffect, useCallback, Fragment } from "react";

const REFRESH_MS = 20_000;

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

export function IngestionPage() {
  const [runs, setRuns]   = useState([]);
  const [snaps, setSnaps] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [expanded, setExpanded]   = useState(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch("/api/ingestion-runs?limit=25", { cache: "no-store" }).then(x => x.json()),
        fetch("/api/snapshots", { cache: "no-store" }).then(x => x.json()),
      ]);
      if (r.error) throw new Error(r.error);
      setRuns(r.runs || []);
      setSnaps((s.snapshots || []).slice(0, 12));
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

  // Derived: latest run, connector health, totals
  const latest = runs[0] || null;
  const running = runs.some(r => r.status === "running");
  const last24h = runs.filter(r => r.started_at && (Date.now() - new Date(r.started_at) < 864e5));
  const sources24h = last24h.reduce((n, r) => n + (r.source_count || 0), 0);

  const connectorHealth = (() => {
    const cr = latest?.connector_results;
    if (!Array.isArray(cr)) return null;
    const ok = cr.filter(c => c.status === "fulfilled" && c.count > 0);
    const empty = cr.filter(c => c.status === "fulfilled" && c.count === 0);
    const failed = cr.filter(c => c.status === "rejected");
    return { ok, empty, failed, total: cr.length };
  })();

  return (
    <div className="hz-ingestion-page">
      <div className="hz-ingestion-head">
        <div>
          <h2 className="hz-ingestion-title">Ingestion</h2>
          <p className="hz-ingestion-sub">
            Live pipeline activity · auto-refreshes every 20s
            {lastFetch && <span className="hz-ingestion-fetched"> · updated {relativeTime(lastFetch.toISOString())}</span>}
          </p>
        </div>
        <button className="hz-ingestion-refresh" onClick={load} title="Refresh now">↻</button>
      </div>

      {error && <div className="hz-ingestion-error">Could not load ingestion data: {error}</div>}
      {loading && !runs.length && <div className="hz-ingestion-loading">Loading…</div>}

      {/* Status cards */}
      <div className="hz-ingestion-cards">
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Status</div>
          <div className="hz-ingestion-card-value">
            {running ? <span className="hz-badge hz-badge-running">running</span> : <span className="hz-badge hz-badge-success">idle</span>}
          </div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Last run</div>
          <div className="hz-ingestion-card-value">{latest ? relativeTime(latest.started_at) : "—"}</div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Sources (24h)</div>
          <div className="hz-ingestion-card-value">{sources24h}</div>
        </div>
        <div className="hz-ingestion-card">
          <div className="hz-ingestion-card-label">Runs (24h)</div>
          <div className="hz-ingestion-card-value">{last24h.length}</div>
        </div>
        {connectorHealth && (
          <div className="hz-ingestion-card">
            <div className="hz-ingestion-card-label">Connectors (last run)</div>
            <div className="hz-ingestion-card-value hz-ingestion-conn">
              <span className="hz-conn-ok">{connectorHealth.ok.length} ✓</span>
              <span className="hz-conn-empty">{connectorHealth.empty.length} ∅</span>
              <span className="hz-conn-fail">{connectorHealth.failed.length} ✗</span>
            </div>
          </div>
        )}
      </div>

      {/* Recent runs */}
      <div className="hz-ingestion-section-title">Recent runs</div>
      <div className="hz-ingestion-runs">
        {runs.map((r) => {
          const pc = r.pipeline_counts || {};
          const open = expanded === r.id;
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
                  {Array.isArray(r.connector_results) && r.connector_results.length > 0 && (
                    <div className="hz-run-connectors">
                      {r.connector_results
                        .slice()
                        .sort((a, b) => (b.count || 0) - (a.count || 0))
                        .map((c, i) => (
                          <span key={i} className={`hz-conn-chip ${c.status === "rejected" ? "fail" : c.count === 0 ? "empty" : "ok"}`}
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

      {/* Snapshots */}
      <div className="hz-ingestion-section-title">Snapshots</div>
      <div className="hz-ingestion-snaps">
        {snaps.map((s) => (
          <div key={s.snapshot_id} className="hz-snap-row">
            <span className="hz-snap-id">{s.snapshot_id}</span>
            <span className="hz-snap-period">{s.period}</span>
            <span className="hz-snap-count">{s.count} sources</span>
            <span className="hz-snap-time">{relativeTime(s.generated_at)}</span>
          </div>
        ))}
        {!snaps.length && !loading && <div className="hz-ingestion-empty">No snapshots yet.</div>}
      </div>
    </div>
  );
}
