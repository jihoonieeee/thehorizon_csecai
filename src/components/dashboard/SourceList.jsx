/**
 * SourceList — sources with publisher, date, trust tier, and clickable URL.
 */

const TRUST_COLOR = {
  primary: "#10b981",
  high:    "#6366f1",
  curated: "#0ea5e9",
  medium:  "#f59e0b",
  low:     "#64748b",
  unknown: "#334155",
};

const TYPE_LABEL = {
  incident:            "Incident",
  research_finding:    "Research",
  governance_signal:   "Governance",
  threat_intelligence: "Threat Intel",
  vulnerability:       "Vulnerability",
  exploit_disclosure:  "Exploit",
  defensive_capability:"Defense",
  benchmark_evaluation:"Benchmark",
  unknown:             "Unknown",
};

export function SourceList({ sources = [] }) {
  if (sources.length === 0) {
    return <div style={{ color: "#475569", fontSize: "0.82rem", padding: "6px 0" }}>No sources available.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {sources.map((src) => {
        const trustColor = TRUST_COLOR[src.trust_tier] || "#334155";
        return (
          <div key={src.source_id} style={{
            padding:      "12px 14px",
            borderRadius: "8px",
            background:   "rgba(15,23,42,0.5)",
            border:       "1px solid #1e293b",
          }}>

            {/* Title — full link if URL exists */}
            <div style={{ marginBottom: "5px" }}>
              {src.url ? (
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize:       "0.88rem",
                    fontWeight:     600,
                    color:          "#93c5fd",
                    textDecoration: "none",
                    lineHeight:     1.5,
                    display:        "block",
                    wordBreak:      "break-word",
                  }}
                >
                  {src.title}
                </a>
              ) : (
                <span style={{ fontSize: "0.88rem", fontWeight: 600, color: "#e2e8f0", lineHeight: 1.5 }}>
                  {src.title}
                </span>
              )}
            </div>

            {/* Meta row */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.76rem", color: "#64748b" }}>{src.publisher}</span>
              {src.date_published && (
                <span style={{ fontSize: "0.74rem", color: "#475569" }}>
                  · {src.date_published.slice(0, 10)}
                </span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                {src.source_type && (
                  <span style={{ fontSize: "0.7rem", color: "#475569" }}>
                    {TYPE_LABEL[src.source_type] || src.source_type}
                  </span>
                )}
                {src.trust_tier && (
                  <span style={{
                    fontSize:    "0.68rem",
                    padding:     "2px 7px",
                    borderRadius:"8px",
                    background:  `${trustColor}18`,
                    color:       trustColor,
                    fontWeight:  600,
                  }}>
                    {src.trust_tier}
                  </span>
                )}
              </div>
            </div>

            {/* URL as readable link on its own line */}
            {src.url && (
              <a
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display:        "block",
                  marginTop:      "6px",
                  fontSize:       "0.73rem",
                  color:          "#475569",
                  textDecoration: "none",
                  wordBreak:      "break-all",
                }}
              >
                {src.url}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
