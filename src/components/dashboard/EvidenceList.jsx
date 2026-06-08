/**
 * EvidenceList — compact list of rawfact evidence items with source quotes.
 */

const STRENGTH_STYLE = {
  strong:  { bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.25)", color: "#34d399" },
  usable:  { bg: "rgba(99,102,241,0.1)", border: "rgba(99,102,241,0.25)", color: "#818cf8" },
  context: { bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.2)", color: "#fbbf24" },
  archive: { bg: "rgba(71,85,105,0.1)", border: "rgba(71,85,105,0.2)", color: "#64748b" },
};

export function SourceQuoteBlock({ quote }) {
  if (!quote) return null;
  return (
    <blockquote style={{
      margin:       "8px 0 0",
      padding:      "6px 10px",
      borderLeft:   "2px solid #1e3a5f",
      borderRadius: "0 4px 4px 0",
      background:   "rgba(15,23,42,0.5)",
      fontSize:     "0.75rem",
      color:        "#94a3b8",
      fontStyle:    "italic",
      lineHeight:   1.5,
    }}>
      "{quote}"
    </blockquote>
  );
}

export function EvidenceList({ items = [], sourceIndex = {} }) {
  if (items.length === 0) return <div style={{ color: "#334155", fontSize: "0.75rem" }}>No in-corpus evidence available.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {items.map((ev) => {
        const style = STRENGTH_STYLE[ev.evidence_strength] || STRENGTH_STYLE.archive;
        const src   = sourceIndex[ev.source_id];
        return (
          <div key={ev.evidence_id} style={{
            padding:      "8px 10px",
            borderRadius: "6px",
            background:   style.bg,
            border:       `1px solid ${style.border}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{
                fontSize:   "0.6rem",
                fontWeight: 700,
                padding:    "1px 6px",
                borderRadius:"8px",
                background: `${style.color}22`,
                color:      style.color,
              }}>
                {ev.evidence_strength}
              </span>
              {ev.evidence_type && (
                <span style={{ fontSize: "0.65rem", color: "#475569" }}>{ev.evidence_type}</span>
              )}
              <span style={{ fontSize: "0.6rem", color: "#334155", marginLeft: "auto" }}>{ev.evidence_id}</span>
            </div>

            <div style={{ fontSize: "0.8rem", color: "#e2e8f0", lineHeight: 1.5 }}>
              {ev.fact || ev.normalized_fact || ev.summary}
            </div>

            {ev.numbers?.length > 0 && (
              <div style={{ marginTop: "4px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
                {ev.numbers.map((n, i) => (
                  <span key={i} style={{
                    fontSize: "0.68rem", padding: "1px 6px", borderRadius: "8px",
                    background: "rgba(14,165,233,0.1)", color: "#38bdf8", fontWeight: 600,
                  }}>{n}</span>
                ))}
              </div>
            )}

            <SourceQuoteBlock quote={ev.source_quote} />

            {src && (
              <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: "6px" }}>
                {src.publisher}{src.date_published ? ` · ${src.date_published.slice(0, 10)}` : ""}
                {src.url && (
                  <a href={src.url} target="_blank" rel="noopener noreferrer"
                     style={{ color: "#6366f1", marginLeft: "6px", textDecoration: "none" }}>
                    source ↗
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
