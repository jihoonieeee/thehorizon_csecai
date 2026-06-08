import { useState, useEffect } from "react";

const CARD = {
  background:   "rgba(8,12,20,0.8)",
  border:       "1px solid #0f1827",
  borderRadius: "10px",
  padding:      "16px 20px",
};

const LABEL = { fontSize: "0.62rem", color: "#334155", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" };

const STATUS_STYLE = {
  success: { background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.25)" },
  running: { background: "rgba(99,102,241,0.1)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.25)" },
  failed:  { background: "rgba(239,68,68,0.1)",  color: "#f87171", border: "1px solid rgba(239,68,68,0.25)" },
  default: { background: "rgba(100,116,139,0.1)", color: "#64748b", border: "1px solid rgba(100,116,139,0.2)" },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.default;
  return (
    <span style={{ fontSize: "0.65rem", fontWeight: 700, padding: "2px 8px", borderRadius: "6px", ...style }}>
      {status}
    </span>
  );
}

function duration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt) - new Date(startedAt);
  if (ms < 0)     return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function relTime(iso) {
  if (!iso) return "—";
  const delta = Date.now() - new Date(iso).getTime();
  const m = Math.floor(delta / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ago`;
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  return "just now";
}

function ConnectorBreakdown({ connectorResults }) {
  if (!connectorResults?.length) return null;
  return (
    <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {connectorResults.map((r, i) => (
        <span key={i} style={{
          fontSize: "0.62rem", color: "#64748b",
          background: "#0a0f1e", border: "1px solid #0f1827",
          padding: "2px 8px", borderRadius: "4px",
        }}>
          {r.connector || r.name || `connector-${i}`}: {r.count ?? r.fetched ?? r.sources ?? "?"}
        </span>
      ))}
    </div>
  );
}

function RunRow({ run }) {
  const [expanded, setExpanded] = useState(false);
  const pc = run.pipeline_counts || {};

  return (
    <div style={{ borderBottom: "1px solid #0a0f1e" }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "10px 0", cursor: "pointer",
        }}
      >
        <span style={{ color: "#1e3a5f", fontSize: "0.7rem", flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
        <StatusBadge status={run.status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.78rem", color: "#94a3b8", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {run.id?.slice(0, 8)}…
          </div>
          <div style={{ fontSize: "0.65rem", color: "#334155", marginTop: "2px" }}>
            {new Date(run.started_at).toLocaleString()} · {relTime(run.started_at)}
          </div>
        </div>
        <div style={{ display: "flex", gap: "16px", fontSize: "0.72rem", color: "#64748b", flexShrink: 0 }}>
          <span style={{ color: "#60a5fa" }}>{run.source_count ?? "—"} accepted</span>
          <span style={{ color: "#f87171" }}>{run.rejected_count ?? "—"} rejected</span>
          <span style={{ color: "#334155" }}>{run.discarded_count ?? "—"} discarded</span>
          <span style={{ color: "#334155" }}>{duration(run.started_at, run.finished_at)}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ paddingBottom: "12px", paddingLeft: "20px" }}>
          {run.error_message && (
            <div style={{ color: "#f87171", fontSize: "0.72rem", fontFamily: "monospace", marginBottom: "8px", background: "rgba(239,68,68,0.05)", padding: "8px 10px", borderRadius: "6px", border: "1px solid rgba(239,68,68,0.15)" }}>
              {run.error_message}
            </div>
          )}
          {Object.keys(pc).length > 0 && (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "8px" }}>
              {Object.entries(pc).map(([k, v]) => (
                <div key={k} style={{ fontSize: "0.65rem" }}>
                  <span style={{ color: "#334155", textTransform: "capitalize" }}>{k.replace(/_/g, " ")}: </span>
                  <span style={{ color: "#94a3b8", fontWeight: 600 }}>{String(v)}</span>
                </div>
              ))}
            </div>
          )}
          <ConnectorBreakdown connectorResults={run.connector_results} />
          {run.reporting_window && (
            <div style={{ fontSize: "0.65rem", color: "#1e3a5f", marginTop: "6px" }}>
              Window: {run.reporting_window}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceRow({ source }) {
  const TIER_COLOR = {
    primary:  "#34d399",
    high:     "#60a5fa",
    medium:   "#94a3b8",
    curated:  "#a78bfa",
    low:      "#64748b",
    unknown:  "#334155",
  };
  const color = TIER_COLOR[source.trust_tier] || "#334155";

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", padding: "9px 0", borderBottom: "1px solid #0a0f1e" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.78rem", color: "#94a3b8", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {source.title || source.url}
        </div>
        <div style={{ fontSize: "0.65rem", color: "#334155", marginTop: "2px", display: "flex", gap: "10px" }}>
          <span>{source.publisher || "unknown"}</span>
          {source.source_type && <span>· {source.source_type.replace(/_/g, " ")}</span>}
          <span>· {source.date_discovered ? relTime(source.date_discovered) : relTime(source.date_published)}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: "6px", flexShrink: 0, alignItems: "center" }}>
        {source.validation_status && (
          <span style={{
            fontSize: "0.62rem", fontWeight: 700, padding: "2px 7px", borderRadius: "4px",
            background: source.validation_status === "pass"
              ? "rgba(52,211,153,0.1)" : "rgba(239,68,68,0.1)",
            color: source.validation_status === "pass" ? "#34d399" : "#f87171",
            border: `1px solid ${source.validation_status === "pass" ? "rgba(52,211,153,0.25)" : "rgba(239,68,68,0.2)"}`,
          }}>
            {source.validation_status}
          </span>
        )}
        {source.main_category && (
          <span style={{ fontSize: "0.62rem", color: "#334155", background: "#0a0f1e", padding: "2px 7px", borderRadius: "4px", border: "1px solid #0f1827" }}>
            {source.main_category.replace(/_/g, " ")}
          </span>
        )}
        <span style={{ fontSize: "0.65rem", fontWeight: 700, color, minWidth: "56px", textAlign: "right" }}>
          {source.trust_tier || "unknown"}
        </span>
      </div>
    </div>
  );
}

export function LogsPage() {
  const [runs, setRuns]           = useState(null);
  const [sources, setSources]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [activeTab, setActiveTab] = useState("runs");
  const [tick, setTick]           = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/ingestion-runs?limit=50").then(r => r.json()),
      fetch("/api/period-sources?period=weekly").then(r => r.json()).catch(() => ({ sources: [] })),
    ])
      .then(([runsData, sourcesData]) => {
        setRuns(runsData.runs || []);
        setSources(sourcesData.sources || []);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [tick]);

  const refresh = () => setTick(t => t + 1);

  const latestRun = runs?.[0];
  const successRuns = runs?.filter(r => r.status === "success").length ?? 0;
  const failedRuns  = runs?.filter(r => r.status === "failed").length ?? 0;
  const totalSources = runs?.reduce((s, r) => s + (r.source_count || 0), 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#e2e8f0" }}>Logs</div>
          <div style={{ fontSize: "0.7rem", color: "#334155", marginTop: "2px" }}>
            Ingestion runs and recently processed sources
          </div>
        </div>
        <button
          onClick={refresh}
          style={{
            background: "transparent", border: "1px solid #1e293b", borderRadius: "6px",
            color: "#64748b", fontSize: "0.72rem", padding: "5px 12px", cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {loading && <div style={{ color: "#334155", fontSize: "0.8rem" }}>Loading logs…</div>}
      {error   && <div style={{ color: "#f87171", fontSize: "0.8rem" }}>Error: {error}</div>}

      {runs && (
        <>
          {/* Summary stats */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {[
              { label: "Last Run",        value: latestRun ? relTime(latestRun.started_at) : "—", accent: "#94a3b8", sub: latestRun?.status },
              { label: "Successful Runs", value: successRuns, accent: "#34d399" },
              { label: "Failed Runs",     value: failedRuns,  accent: failedRuns > 0 ? "#f87171" : "#334155" },
              { label: "Sources Ingested (total)", value: totalSources.toLocaleString(), accent: "#60a5fa" },
            ].map(({ label, value, accent, sub }) => (
              <div key={label} style={{ ...CARD, flex: 1, minWidth: "120px" }}>
                <div style={LABEL}>{label}</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, color: accent, marginTop: "6px" }}>{value}</div>
                {sub && <div style={{ fontSize: "0.68rem", color: "#334155", marginTop: "2px" }}>{sub}</div>}
              </div>
            ))}
          </div>

          {/* Tab switcher */}
          <div style={{ display: "flex", gap: "4px" }}>
            {[
              { id: "runs",    label: `Runs (${runs.length})` },
              { id: "sources", label: `Recent Sources (${sources?.length || 0})` },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background:   activeTab === tab.id ? "rgba(99,102,241,0.14)" : "transparent",
                  border:       activeTab === tab.id ? "1px solid rgba(99,102,241,0.3)" : "1px solid #0f1827",
                  borderRadius: "6px",
                  color:        activeTab === tab.id ? "#a5b4fc" : "#64748b",
                  fontSize:     "0.75rem",
                  padding:      "5px 14px",
                  cursor:       "pointer",
                  fontWeight:   activeTab === tab.id ? 600 : 400,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Runs tab */}
          {activeTab === "runs" && (
            <div style={CARD}>
              {runs.length === 0
                ? <div style={{ color: "#334155", fontSize: "0.8rem" }}>No ingestion runs found.</div>
                : runs.map(run => <RunRow key={run.id} run={run} />)
              }
            </div>
          )}

          {/* Sources tab */}
          {activeTab === "sources" && (
            <div style={CARD}>
              {!sources?.length
                ? <div style={{ color: "#334155", fontSize: "0.8rem" }}>No sources found.</div>
                : sources.map(s => <SourceRow key={s.id} source={s} />)
              }
            </div>
          )}
        </>
      )}
    </div>
  );
}
