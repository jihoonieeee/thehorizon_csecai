/**
 * SourceList — compact list of sources with publisher, date, and URL.
 */

const TRUST_COLOR = {
  primary:  "#10b981",
  high:     "#6366f1",
  medium:   "#f59e0b",
  curated:  "#0ea5e9",
  low:      "#64748b",
  unknown:  "#334155",
};

const TYPE_LABEL = {
  incident:           "Incident",
  research_finding:   "Research",
  governance_signal:  "Governance",
  threat_intelligence:"Threat Intel",
  vulnerability:      "Vulnerability",
  exploit_disclosure: "Exploit",
  defensive_capability:"Defense",
  benchmark_evaluation:"Benchmark",
  unknown:            "Unknown",
};

export function SourceList({ sources = [] }) {
  if (sources.length === 0) return <div style={{ color: "#334155", fontSize: "0.75rem" }}>No sources available.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {sources.map((src) => (
        <div key={src.source_id} style={{
          padding:      "8px 10px",
          borderRadius: "6px",
          background:   "rgba(15,23,42,0.5)",
          border:       "1px solid #1e293b",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", justifyContent: "space-between" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>
                {src.title}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#64748b", marginTop: "3px" }}>
                {src.publisher}
                {src.date_published && ` · ${src.date_published.slice(0, 10)}`}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "3px", alignItems: "flex-end", flexShrink: 0 }}>
              {src.trust_tier && (
                <span style={{
                  fontSize:   "0.6rem",
                  padding:    "1px 5px",
                  borderRadius:"6px",
                  background: `${TRUST_COLOR[src.trust_tier] || "#334155"}22`,
                  color:      TRUST_COLOR[src.trust_tier] || "#64748b",
                  fontWeight: 600,
                }}>
                  {src.trust_tier}
                </span>
              )}
              {src.source_type && (
                <span style={{ fontSize: "0.6rem", color: "#475569" }}>
                  {TYPE_LABEL[src.source_type] || src.source_type}
                </span>
              )}
            </div>
          </div>
          {src.url && (
            <a
              href={src.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.68rem", color: "#6366f1", textDecoration: "none", marginTop: "4px", display: "block" }}
            >
              {src.url.slice(0, 55)}{src.url.length > 55 ? "…" : ""}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
