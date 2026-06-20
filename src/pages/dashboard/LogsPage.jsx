/**
 * LogsPage — AI spending dashboard + pipeline run history.
 * All cost data is persistent (stored in Supabase llm_cost_log).
 */

import { useState, useEffect, Fragment } from "react";

function fmt(n)      { if (n == null) return "—"; return Number(n).toLocaleString(); }
function fmtK(n)     { if (!n) return "—"; return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n/1000).toFixed(0)}K` : String(n); }
function fmtCost(usd, precision) {
  if (usd == null || usd === 0) return "$0.00";
  if (usd < 0.001)  return `$${Number(usd).toFixed(6)}`;
  if (usd < 0.01)   return `$${Number(usd).toFixed(4)}`;
  if (usd < 1)      return `$${Number(usd).toFixed(3)}`;
  return `$${Number(usd).toFixed(precision ?? 2)}`;
}

function relativeTime(iso) {
  if (!iso) return "—";
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return "just now";
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function statusBadge(s) {
  const cls = s === "success" ? "hz-badge-success" : s === "failed" ? "hz-badge-error"
    : s === "running" ? "hz-badge-running" : "hz-badge-neutral";
  return <span className={`hz-badge ${cls}`}>{s}</span>;
}

// ── Provider colour map ───────────────────────────────────────────────────────

const PROVIDER_COLOR = {
  anthropic:  "#c26d2e",
  gemini:     "#4285f4",
  openai:     "#10a37f",
  groq:       "#f55036",
  cloudflare: "#f48120",
  openrouter: "#6366f1",
};

function provColor(prov) { return PROVIDER_COLOR[prov?.toLowerCase()] || "#6b7280"; }

// ── Mini bar ──────────────────────────────────────────────────────────────────

function MiniBar({ value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="hz-minibar-track">
      <div className="hz-minibar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ── Cost History (main panel) ─────────────────────────────────────────────────

const WIN_OPTS = [
  { label: "7 days",  days: 7   },
  { label: "30 days", days: 30  },
  { label: "90 days", days: 90  },
  { label: "All",     days: 365 },
];

function CostHistory() {
  const [win,     setWin]     = useState(30);
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/usage?days=${win}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [win]);

  return (
    <section className="hz-log-section">
      <div className="hz-log-section-header">
        <div>
          <h3 className="hz-log-section-title">AI Spend</h3>
          <p className="hz-log-section-sub">All LLM costs — ingestion, enrichment, synthesis, agent, insights. Persistent.</p>
        </div>
        <div className="hz-log-section-actions">
          {WIN_OPTS.map(o => (
            <button key={o.days}
              className={`hz-log-window-btn${win === o.days ? " active" : ""}`}
              onClick={() => setWin(o.days)}>{o.label}</button>
          ))}
        </div>
      </div>

      {loading && <p className="hz-log-loading">Loading…</p>}
      {error   && <p className="hz-log-error">Failed to load: {error}</p>}

      {data && !loading && (
        <>
          {/* ── Summary cards ── */}
          <div className="hz-log-cost-summary">
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">Today</span>
              <span className="hz-log-cost-value">{fmtCost(data.today_cost_usd)}</span>
            </div>
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">This month</span>
              <span className="hz-log-cost-value">{fmtCost(data.month_cost_usd)}</span>
            </div>
            <div className="hz-log-cost-card hz-log-cost-card-total">
              <span className="hz-log-cost-label">Last {win} days</span>
              <span className="hz-log-cost-value">{fmtCost(data.total_cost_usd)}</span>
            </div>
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">Tokens</span>
              <span className="hz-log-cost-value">{fmtK(data.total_input_tokens + data.total_output_tokens)}</span>
              <span className="hz-log-cost-sub">{fmtK(data.total_input_tokens)} in · {fmtK(data.total_output_tokens)} out</span>
            </div>
            <div className="hz-log-cost-card">
              <span className="hz-log-cost-label">API calls</span>
              <span className="hz-log-cost-value">{fmtK(data.total_calls)}</span>
            </div>
          </div>

          {/* ── Provider breakdown ── */}
          {data.provider_breakdown?.length > 0 && (
            <div className="hz-log-breakdown-row">
              <div className="hz-log-breakdown-panel">
                <h4 className="hz-log-breakdown-title">By provider</h4>
                <table className="hz-log-table hz-log-table-sm">
                  <thead><tr><th>Provider</th><th>Cost</th><th>Calls</th><th>Tokens</th><th></th></tr></thead>
                  <tbody>
                    {data.provider_breakdown.map((p, i) => (
                      <tr key={i}>
                        <td>
                          <span className="hz-log-provider-dot" style={{ background: provColor(p.provider) }} />
                          {p.label}
                        </td>
                        <td className="hz-log-td-num hz-log-td-cost">{fmtCost(p.cost_usd)}</td>
                        <td className="hz-log-td-num">{fmtK(p.calls)}</td>
                        <td className="hz-log-td-num">{fmtK(p.input_tokens + p.output_tokens)}</td>
                        <td style={{ width: 80 }}>
                          <MiniBar value={p.cost_usd} max={data.provider_breakdown[0]?.cost_usd} color={provColor(p.provider)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Context breakdown ── */}
              {data.context_breakdown?.length > 0 && (
                <div className="hz-log-breakdown-panel">
                  <h4 className="hz-log-breakdown-title">By workload</h4>
                  <table className="hz-log-table hz-log-table-sm">
                    <thead><tr><th>Workload</th><th>Cost</th><th>Calls</th><th></th></tr></thead>
                    <tbody>
                      {data.context_breakdown.map((c, i) => (
                        <tr key={i}>
                          <td>{c.label}</td>
                          <td className="hz-log-td-num hz-log-td-cost">{fmtCost(c.cost_usd)}</td>
                          <td className="hz-log-td-num">{fmtK(c.calls)}</td>
                          <td style={{ width: 80 }}>
                            <MiniBar value={c.cost_usd} max={data.context_breakdown[0]?.cost_usd} color="#6366f1" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Model breakdown ── */}
          {data.model_breakdown?.length > 0 && (
            <div className="hz-log-breakdown-full">
              <h4 className="hz-log-breakdown-title">By model</h4>
              <table className="hz-log-table hz-log-table-sm">
                <thead>
                  <tr><th>Model</th><th>Provider</th><th>Cost</th><th>Calls</th><th>Input tok.</th><th>Output tok.</th><th></th></tr>
                </thead>
                <tbody>
                  {data.model_breakdown.map((m, i) => (
                    <tr key={i}>
                      <td className="hz-log-td-mono">{m.model}</td>
                      <td>
                        <span className="hz-log-provider-dot" style={{ background: provColor(m.provider) }} />
                        {m.provider_label}
                      </td>
                      <td className="hz-log-td-num hz-log-td-cost">{fmtCost(m.cost_usd)}</td>
                      <td className="hz-log-td-num">{fmtK(m.calls)}</td>
                      <td className="hz-log-td-num">{fmtK(m.input_tokens)}</td>
                      <td className="hz-log-td-num">{fmtK(m.output_tokens)}</td>
                      <td style={{ width: 80 }}>
                        <MiniBar value={m.cost_usd} max={data.model_breakdown[0]?.cost_usd} color={provColor(m.provider)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Daily series ── */}
          {data.daily_series?.length > 0 ? (
            <div className="hz-log-breakdown-full">
              <h4 className="hz-log-breakdown-title">Daily</h4>
              <div className="hz-log-table-wrap">
                <table className="hz-log-table hz-log-table-sm">
                  <thead>
                    <tr>
                      <th>Date</th>
                      {Object.keys(data.daily_series[0]?.by_provider || {}).map(p => (
                        <th key={p}>
                          <span className="hz-log-provider-dot" style={{ background: provColor(p) }} />
                          {p}
                        </th>
                      ))}
                      <th>Total</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.daily_series].reverse().map((d, i) => (
                      <tr key={i}>
                        <td className="hz-log-td-mono">{d.date}</td>
                        {Object.entries(d.by_provider || {}).map(([p, c]) => (
                          <td key={p} className="hz-log-td-num">{c > 0 ? fmtCost(c) : "—"}</td>
                        ))}
                        <td className="hz-log-td-num hz-log-td-cost hz-log-td-bold">{fmtCost(d.total_cost)}</td>
                        <td className="hz-log-td-num">{fmtK(d.total_tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="hz-log-empty">No cost data yet. Costs are logged on every LLM call.</p>
          )}

          <p className="hz-log-note">Costs use published pricing per model. Token counts are estimates (chars ÷ 4) for non-Anthropic providers.</p>
        </>
      )}
    </section>
  );
}

// ── Pipeline Runs ─────────────────────────────────────────────────────────────

function PipelineRuns() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
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
          <h3 className="hz-log-section-title">Ingestion Runs</h3>
          <p className="hz-log-section-sub">Last {runs.length} pipeline runs.</p>
        </div>
        <div className="hz-log-section-actions">
          <span className="hz-log-summary-chip">{runs.filter(r => r.status === "success").length} / {runs.length} successful</span>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="hz-log-empty">No ingestion runs found.</p>
      ) : (
        <div className="hz-log-table-wrap">
          <table className="hz-log-table">
            <thead>
              <tr>
                <th>Started</th><th>Status</th><th>Duration</th>
                <th>Sources</th><th>Rejected</th><th>Window</th><th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const ms  = run.finished_at && run.started_at ? new Date(run.finished_at) - new Date(run.started_at) : null;
                const dur = ms == null ? "—" : ms < 60000 ? `${Math.round(ms/1000)}s` : `${Math.round(ms/60000)}m`;
                const isOpen = expanded === i;
                return (
                  <Fragment key={i}>
                    <tr className={isOpen ? "hz-log-tr-expanded" : ""}>
                      <td className="hz-log-td-mono" title={run.started_at}>
                        {relativeTime(run.started_at)}
                        <span className="hz-log-td-date">{run.started_at?.slice(0,10)}</span>
                      </td>
                      <td>{statusBadge(run.status)}</td>
                      <td className="hz-log-td-num">{dur}</td>
                      <td className="hz-log-td-num hz-log-td-bold">{fmt(run.source_count)}</td>
                      <td className="hz-log-td-num">{fmt(run.rejected_count)}</td>
                      <td className="hz-log-td-window">{
                        typeof run.reporting_window === "string" ? run.reporting_window
                        : run.reporting_window?.start_sgt?.slice(0,10) ?? "—"
                      }</td>
                      <td><button className="hz-log-expand-btn" onClick={() => setExpanded(isOpen ? null : i)}>{isOpen ? "▲" : "▼"}</button></td>
                    </tr>
                    {isOpen && (
                      <tr className="hz-log-tr-detail">
                        <td colSpan={7}>
                          <div className="hz-log-detail-body">
                            {run.error_message && <p className="hz-log-error-msg">Error: {run.error_message}</p>}
                            {Array.isArray(run.connector_results) && run.connector_results.length > 0 && (
                              <div className="hz-log-connector-list">
                                <strong>Connectors:</strong>
                                {run.connector_results.map((c, ci) => (
                                  <span key={ci} className="hz-log-connector-chip">
                                    {c.connector||c.name||`connector-${ci}`}
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
      <PipelineRuns />
    </div>
  );
}
