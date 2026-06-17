/**
 * EvidenceList — rawfact evidence items with source quotes and provenance links.
 */

const STRENGTH_STYLE = {
  strong:  { bg: "rgba(16,185,129,0.08)",  border: "rgba(16,185,129,0.22)",  color: "#34d399", label: "Strong"  },
  usable:  { bg: "rgba(99,102,241,0.08)",  border: "rgba(99,102,241,0.22)",  color: "#818cf8", label: "Usable"  },
  context: { bg: "rgba(245,158,11,0.06)",  border: "rgba(245,158,11,0.18)",  color: "#fbbf24", label: "Context" },
  archive: { bg: "rgba(71,85,105,0.08)",   border: "rgba(71,85,105,0.18)",   color: "#64748b", label: "Archive" },
};

const TYPE_LABEL = {
  incident_report:        "Incident",
  exploit_demonstration:  "Exploit Demo",
  adversary_adoption:     "Adversary Use",
  vulnerability_disclosure:"Vulnerability",
  research_finding:       "Research",
  benchmark_result:       "Benchmark",
  capability_delta:       "Capability",
  policy_or_governance:   "Governance",
  background_context:     "Context",
  external_report_finding:"External Report",
  authoritative_statistic:"Statistic",
};

export function SourceQuoteBlock({ quote }) {
  if (!quote) return null;
  return (
    <blockquote style={{
      margin:       "10px 0 0",
      padding:      "8px 12px",
      borderLeft:   "2px solid #1e3a5f",
      borderRadius: "0 6px 6px 0",
      background:   "rgba(15,23,42,0.6)",
      fontSize:     "0.82rem",
      color:        "#94a3b8",
      fontStyle:    "italic",
      lineHeight:   1.6,
    }}>
      "{quote}"
    </blockquote>
  );
}

export function EvidenceList({ items = [], sourceIndex = {} }) {
  if (items.length === 0) {
    return <div style={{ color: "#475569", fontSize: "0.82rem", padding: "6px 0" }}>No in-corpus evidence available.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {items.map((ev) => {
        const style  = STRENGTH_STYLE[ev.evidence_strength] || STRENGTH_STYLE.archive;
        const src    = sourceIndex[ev.source_id];
        const srcUrl = src?.url || ev.url || null;
        const typeLabel = TYPE_LABEL[ev.evidence_type] || (ev.evidence_type || "").replace(/_/g, " ");

        return (
          <div key={ev.evidence_id} style={{
            padding:      "12px 14px",
            borderRadius: "8px",
            background:   style.bg,
            border:       `1px solid ${style.border}`,
          }}>

            {/* Strength + type — no raw ID */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
              <span style={{
                fontSize:    "0.7rem",
                fontWeight:  700,
                padding:     "2px 8px",
                borderRadius:"10px",
                background:  `${style.color}1a`,
                color:       style.color,
              }}>
                {style.label}
              </span>
              {typeLabel && (
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>{typeLabel}</span>
              )}
            </div>

            {/* Fact */}
            <div style={{ fontSize: "0.88rem", color: "#e2e8f0", lineHeight: 1.65 }}>
              {ev.fact || ev.normalized_fact || ev.summary}
            </div>

            {/* Numbers */}
            {ev.numbers?.length > 0 && (
              <div style={{ marginTop: "8px", display: "flex", gap: "5px", flexWrap: "wrap" }}>
                {ev.numbers.map((n, i) => (
                  <span key={i} style={{
                    fontSize:    "0.75rem",
                    padding:     "2px 8px",
                    borderRadius:"8px",
                    background:  "rgba(14,165,233,0.1)",
                    color:       "#38bdf8",
                    fontWeight:  600,
                  }}>
                    {n}
                  </span>
                ))}
              </div>
            )}

            <SourceQuoteBlock quote={ev.source_quote} />

            {/* Provenance — source title as link, no raw IDs */}
            {(src || ev.publisher || srcUrl) && (
              <div style={{
                marginTop:   "10px",
                paddingTop:  "8px",
                borderTop:   "1px solid rgba(255,255,255,0.05)",
                display:     "flex",
                alignItems:  "center",
                gap:         "8px",
                flexWrap:    "wrap",
              }}>
                {srcUrl ? (
                  <a
                    href={srcUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize:       "0.78rem",
                      color:          "#6366f1",
                      textDecoration: "none",
                      fontWeight:     500,
                      flex:           1,
                      minWidth:       0,
                      overflow:       "hidden",
                      textOverflow:   "ellipsis",
                      whiteSpace:     "nowrap",
                    }}
                  >
                    {src?.title || src?.publisher || ev.source_title || ev.publisher || srcUrl} ↗
                  </a>
                ) : (
                  <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
                    {src?.publisher || ev.publisher || ""}
                  </span>
                )}
                {(src?.date_published || ev.published_at) && (
                  <span style={{ fontSize: "0.74rem", color: "#475569", flexShrink: 0 }}>
                    {(src?.date_published || ev.published_at || "").slice(0, 10)}
                  </span>
                )}
                {(ev.visual_refs || []).filter((v) => v.source_url || v.visual_url).slice(0, 1).map((v) => (
                  <a
                    key={v.visual_id}
                    href={v.source_url || v.visual_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={v.caption || "visual evidence"}
                    style={{ fontSize: "0.74rem", color: "#94a3b8", textDecoration: "none", flexShrink: 0 }}
                  >
                    figure ↗
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
