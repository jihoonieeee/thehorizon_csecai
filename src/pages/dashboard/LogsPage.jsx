/**
 * LogsPage — three panels:
 *   1. Agent Call Log  — per-query tokens + cost from localStorage
 *   2. Session LLM Usage — by provider and by task from /api/usage
 *   3. Pipeline Runs — ingestion run history from /api/ingestion-runs
 */

import { useState, useEffect, Fragment } from "react";

// ── helpers ────────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function fmtCost(usd) {
  if (usd == null) return "—";
  if (usd < 0.0001) return "<$0.01";
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function relativeTime(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return "just now";
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function statusBadge(status) {
  const cls = status === "success" ? "hz-badge-success"
    : status === "failed"          ? "hz-badge-error"
    : status === "running"         ? "hz-badge-running"
    : "hz-badge-neutral";
  return <span className={`hz-badge ${cls}`}>{status}</span>;
}

function confidenceBadge(conf) {
  if (!conf) return null;
  const cls = conf === "high" ? "hz-badge-success" : conf === "moderate" ? "hz-badge-warn" : "hz-badge-neutral";
  return <span className={`hz-badge ${cls}`}>{conf}</span>;
}

// ── Agent Call Log ─────────────────────────────────────────────────────────────

function AgentCallLog() {
  const [log, setLog] = useState([]);

  useEffect(() => {
    try {
      setLog(JSON.parse(localStorage.getItem("hz_agent_log") || "[]"));
    } catch (_) {}
  }, []);

  const clearLog = () => {
    localStorage.removeItem("hz_agent_log");
    setLog([]);
  };

  const totalTokens = log.reduce((s, e) => s + (e.token_usage?.total_tokens || 0), 0);
  const totalCost   = log.reduce((s, e) => s + (e.token_usage?.estimated_cost_usd || 0), 0);

  return (
    <section className="hz-log-section">
      <div className="hz-log-section-header">
        <div>
          <h3 className="hz-log-section-title">Agent Call Log</h3>
          <p className="hz-log-section-sub">Per-query token usage stored in your browser. Persists across page reloads.</p>
        </div>
        <div className="hz-log-section-actions">
          {log.length > 0 && (
            <>
              <span className="hz-log-summary-chip">{fmt(totalTokens)} total tokens</span>
              <span className="hz-log-summary-chip">{fmtCost(totalCost)} total cost</span>
              <button className="hz-log-clear-btn" onClick={clearLog}>Clear log</button>
            </>
          )}
        </div>
      </div>

      {log.length === 0 ? (
        <p className="hz-log-empty">No agent calls recorded yet. Ask a question on the Ask Agent page.</p>
      ) : (
        <div className="hz-log-table-wrap">
          <table className="hz-log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Query</th>
                <th>Confidence</th>
                <th>Tools</th>
                <th>Rounds</th>
                <th>Input tok.</th>
                <th>Output tok.</th>
                <th>Total tok.</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e, i) => (
                <tr key={i}>
                  <td className="hz-log-td-mono" title={e.ts}>{relativeTime(e.ts)}</td>
                  <td className="hz-log-td-query" title={e.query}>{e.query?.slice(0, 80)}{e.query?.length > 80 ? "…" : ""}</td>
                  <td>{confidenceBadge(e.confidence)}</td>
                  <td className="hz-log-td-tools">{[...new Set(e.tools || [])].join(", ") || "—"}</td>
                  <td className="hz-log-td-num">{e.token_usage?.rounds ?? "—"}</td>
                  <td className="hz-log-td-num">{fmt(e.token_usage?.input_tokens)}</td>
                  <td className="hz-log-td-num">{fmt(e.token_usage?.output_tokens)}</td>
                  <td className="hz-log-td-num hz-log-td-bold">{fmt(e.token_usage?.total_tokens)}</td>
                  <td className="hz-log-td-num hz-log-td-cost">{fmtCost(e.token_usage?.estimated_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Cost History ───────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "7 days",  days: 7  },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function CostHistory() {
  const [window, setWindow] = useState(30);
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/usage?days=${window}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [window]);

  return (
    <section className="hz-log-section">
      <div className="hz-log-section-header">
        <div>
          <h3 className="hz-log-section-title">Cost History</h3>
          <p className="hz-log-section-sub">Cumulative AI costs stored in the database. Persists across restarts.</p>
        </div>
        <div className="hz-log-section-actions">
          {WINDOW_OPTIONS.map(o => (
            <button
              key={o.days}
              className={`hz-log-window-btn${window === o.days ? " active" : ""}`}
              onClick={() => setWindow(o.days)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="hz-log-loading">Loading…</p>}
      {error   && <p className="hz-log-error">Failed to load cost history: {error}</p>}

      {data && !loading && (
        <>
          {/* Summary chips */}
          <div className="hz-log-cost-summary">
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">This month</span>
              <span className="hz-log-cost-value">{fmtCost(data.month_cost_usd)}</span>
            </div>
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">Ingestion &amp; processing</span>
              <span className="hz-log-cost-value">{fmtCost(data.pipeline_cost_usd)}</span>
              <span className="hz-log-cost-sub">last {window} days</span>
            </div>
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">AI Assistant queries</span>
              <span className="hz-log-cost-value">{fmtCost(data.agent_cost_usd)}</span>
              <span className="hz-log-cost-sub">last {window} days</span>
            </div>
            <div className="hz-log-cost-card hz-log-cost-card-total">
              <span className="hz-log-cost-label">Total</span>
              <span className="hz-log-cost-value">{fmtCost(data.total_cost_usd)}</span>
              <span className="hz-log-cost-sub">last {window} days</span>
            </div>
          </div>

          {/* Daily breakdown table */}
          {data.daily_series?.length > 0 ? (
            <div className="hz-log-table-wrap">
              <table className="hz-log-table hz-log-table-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Ingestion &amp; processing</th>
                    <th>AI Assistant</th>
                    <th>Day total</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily_series.map((d, i) => (
                    <tr key={i}>
                      <td className="hz-log-td-mono">{d.date}</td>
                      <td className="hz-log-td-num">{d.pipeline_cost > 0 ? fmtCost(d.pipeline_cost) : "—"}</td>
                      <td className="hz-log-td-num">{d.agent_cost    > 0 ? fmtCost(d.agent_cost)    : "—"}</td>
                      <td className="hz-log-td-num hz-log-td-cost hz-log-td-bold">{fmtCost(d.total_cost)}</td>
                      <td className="hz-log-td-num">{fmt(d.total_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hz-log-empty">No cost records yet. Costs are logged after each ingestion run and AI Assistant query.</p>
          )}

          <p className="hz-log-note">Cost estimates use approximate published pricing.</p>
        </>
      )}
    </section>
  );
}

// ── Pipeline Runs ──────────────────────────────────────────────────────────────

function PipelineRuns() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    fetch("/api/ingestion-runs?limit=30")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <section className="hz-log-section"><p className="hz-log-loading">Loading runs…</p></section>;
  if (error)   return <section className="hz-log-section"><p className="hz-log-error">Failed to load runs: {error}</p></section>;
  if (!data)   return null;

  const runs = data.runs || [];

  return (
    <section className="hz-log-section">
      <div className="hz-log-section-header">
        <div>
          <h3 className="hz-log-section-title">Pipeline Runs</h3>
          <p className="hz-log-section-sub">Last {runs.length} ingestion runs from the database.</p>
        </div>
        <div className="hz-log-section-actions">
          <span className="hz-log-summary-chip">{runs.length} runs</span>
          <span className="hz-log-summary-chip">
            {runs.filter(r => r.status === "success").length} successful
          </span>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="hz-log-empty">No ingestion runs found.</p>
      ) : (
        <div className="hz-log-table-wrap">
          <table className="hz-log-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Sources</th>
                <th>Rejected</th>
                <th>Discarded</th>
                <th>Window</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const durationMs = run.finished_at && run.started_at
                  ? new Date(run.finished_at) - new Date(run.started_at) : null;
                const durationStr = durationMs == null ? "—"
                  : durationMs < 60000 ? `${Math.round(durationMs / 1000)}s`
                  : `${Math.round(durationMs / 60000)}m`;
                const isOpen = expanded === i;

                return (
                  <Fragment key={i}>
                    <tr className={isOpen ? "hz-log-tr-expanded" : ""}>
                      <td className="hz-log-td-mono" title={run.started_at}>
                        {relativeTime(run.started_at)}
                        <span className="hz-log-td-date">{run.started_at?.slice(0, 10)}</span>
                      </td>
                      <td>{statusBadge(run.status)}</td>
                      <td className="hz-log-td-num">{durationStr}</td>
                      <td className="hz-log-td-num hz-log-td-bold">{fmt(run.source_count)}</td>
                      <td className="hz-log-td-num">{fmt(run.rejected_count)}</td>
                      <td className="hz-log-td-num">{fmt(run.discarded_count)}</td>
                      <td className="hz-log-td-window">{
                      typeof run.reporting_window === "string" ? run.reporting_window
                      : run.reporting_window?.start_sgt?.slice(0, 10) ?? "—"
                    }</td>
                      <td>
                        <button
                          className="hz-log-expand-btn"
                          onClick={() => setExpanded(isOpen ? null : i)}
                        >
                          {isOpen ? "▲" : "▼"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="hz-log-tr-detail">
                        <td colSpan={8}>
                          <div className="hz-log-detail-body">
                            {run.error_message && (
                              <p className="hz-log-error-msg">Error: {run.error_message}</p>
                            )}
                            {run.pipeline_counts && Object.keys(run.pipeline_counts).length > 0 && (
                              <div className="hz-log-detail-grid">
                                <strong>Pipeline counts:</strong>
                                {Object.entries(run.pipeline_counts).map(([k, v]) => (
                                  <span key={k} className="hz-log-kv"><span className="hz-log-k">{k}</span><span className="hz-log-v">{fmt(v)}</span></span>
                                ))}
                              </div>
                            )}
                            {Array.isArray(run.connector_results) && run.connector_results.length > 0 && (
                              <div className="hz-log-connector-list">
                                <strong>Connectors:</strong>
                                {run.connector_results.map((c, ci) => (
                                  <span key={ci} className="hz-log-connector-chip">
                                    {c.connector || c.name || `connector-${ci}`}
                                    {c.count != null && <span className="hz-log-connector-n">{c.count}</span>}
                                  </span>
                                ))}
                              </div>
                            )}
                            <p className="hz-log-run-id">Run ID: {run.id}</p>
                          </div>
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
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function LogsPage() {
  return (
    <div className="hz-logs-page">
      <CostHistory />
      <AgentCallLog />
      <PipelineRuns />
    </div>
  );
}
