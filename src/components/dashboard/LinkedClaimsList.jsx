/**
 * LinkedClaimsList — claims linked to a selected evidence/chart element.
 *
 * Resolves supporting_evidence_ids → source titles + URLs via the provided
 * evidence_index and source_index so analysts see human-readable references,
 * not cryptic IDs.
 */

const PRIORITY_STYLE = {
  critical: { color: "#f87171", bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.25)" },
  high:     { color: "#fb923c", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.2)" },
  medium:   { color: "#fbbf24", bg: "rgba(245,158,11,0.07)", border: "rgba(245,158,11,0.2)" },
};

const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium" };

const CLAIM_TYPE_LABEL = {
  category_insight:  "Insight",
  trend_claim:       "Trend",
  recommendation:    "Recommendation",
  outlook:           "Outlook",
  happening:         "Happening",
};

const CONF_COLOR = { high: "#10b981", medium: "#f59e0b", low: "#64748b" };

const TRUST_COLOR = {
  primary: "#10b981", high: "#6366f1", curated: "#0ea5e9",
  medium: "#f59e0b", low: "#64748b", unknown: "#334155",
};

// ── Source resolution ─────────────────────────────────────────────────────────

function resolveClaimSources(claim, evidenceIndex, sourceIndex) {
  const seen    = new Set();
  const results = [];

  for (const evId of (claim.supporting_evidence_ids || [])) {
    const ev = evidenceIndex?.[evId];
    if (!ev) continue;

    // L5A rawfact: look up in source_index via source_id
    if (ev.source_id && sourceIndex?.[ev.source_id]) {
      const src = sourceIndex[ev.source_id];
      if (!seen.has(src.source_id)) {
        seen.add(src.source_id);
        results.push({
          key:        src.source_id,
          title:      src.title,
          publisher:  src.publisher,
          url:        src.url,
          date:       src.date_published?.slice(0, 10),
          trust_tier: src.trust_tier,
          source_type:src.source_type,
        });
      }
      continue;
    }

    // L5C external / packet-level provenance (url at root or in provenance)
    const url   = ev.url || ev.provenance?.url || null;
    const title = ev.source_title || ev.title || ev.provenance?.title || null;
    const pub   = ev.publisher    || ev.provenance?.publisher || null;
    if ((url || title) && !seen.has(url || title)) {
      seen.add(url || title);
      results.push({
        key:        url || title,
        title:      title || url,
        publisher:  pub,
        url,
        date:       null,
        trust_tier: null,
        source_type:ev.evidence_type,
      });
    }
  }

  return results;
}

// ── Source link row ───────────────────────────────────────────────────────────

function SourceRef({ src }) {
  const trustColor = TRUST_COLOR[src.trust_tier] || "#475569";

  return (
    <div style={{
      display:      "flex",
      alignItems:   "flex-start",
      gap:          "8px",
      padding:      "7px 0",
      borderBottom: "1px solid #0f1827",
    }}>
      {/* Coloured trust dot */}
      <span style={{
        width:      "6px",
        height:     "6px",
        borderRadius:"50%",
        background: trustColor,
        flexShrink: 0,
        marginTop:  "6px",
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        {src.url ? (
          <a
            href={src.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize:       "0.84rem",
              fontWeight:     500,
              color:          "#93c5fd",
              textDecoration: "none",
              lineHeight:     1.4,
              display:        "block",
              wordBreak:      "break-word",
            }}
          >
            {src.title || src.url}
          </a>
        ) : (
          <span style={{ fontSize: "0.84rem", fontWeight: 500, color: "#cbd5e1", lineHeight: 1.4 }}>
            {src.title || "Untitled source"}
          </span>
        )}

        <div style={{ display: "flex", gap: "6px", marginTop: "3px", flexWrap: "wrap", alignItems: "center" }}>
          {src.publisher && (
            <span style={{ fontSize: "0.74rem", color: "#64748b" }}>{src.publisher}</span>
          )}
          {src.date && (
            <span style={{ fontSize: "0.72rem", color: "#475569" }}>· {src.date}</span>
          )}
          {src.trust_tier && (
            <span style={{
              fontSize:    "0.68rem",
              padding:     "1px 6px",
              borderRadius:"6px",
              background:  `${trustColor}18`,
              color:       trustColor,
              fontWeight:  600,
            }}>
              {src.trust_tier}
            </span>
          )}
        </div>
      </div>

      {src.url && (
        <a
          href={src.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: "0.85rem", color: "#334155", flexShrink: 0, textDecoration: "none", paddingTop: "2px" }}
          aria-label="Open source"
        >
          ↗
        </a>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function LinkedClaimsList({ claims = [], evidenceIndex = {}, sourceIndex = {} }) {
  if (claims.length === 0) {
    return <div style={{ color: "#475569", fontSize: "0.82rem", padding: "6px 0" }}>No linked claims.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {claims.map((claim) => {
        const s       = PRIORITY_STYLE[claim.claim_priority] || { color: "#64748b", bg: "transparent", border: "#1e293b" };
        const sources = resolveClaimSources(claim, evidenceIndex, sourceIndex);

        return (
          <div key={claim.claim_id || claim.claim_text} style={{
            padding:      "12px 14px",
            borderRadius: "8px",
            background:   s.bg,
            border:       `1px solid ${s.border}`,
          }}>

            {/* Priority + type row */}
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
              <span style={{
                fontSize:     "0.7rem",
                fontWeight:   700,
                padding:      "2px 8px",
                borderRadius: "10px",
                color:        s.color,
                background:   `${s.color}20`,
                textTransform:"uppercase",
                letterSpacing:"0.04em",
              }}>
                {PRIORITY_LABEL[claim.claim_priority] || claim.claim_priority || "—"}
              </span>
              {claim.claim_type && (
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                  {CLAIM_TYPE_LABEL[claim.claim_type] || claim.claim_type.replace(/_/g, " ")}
                </span>
              )}
              {claim.confidence && (
                <span style={{ fontSize: "0.72rem", color: CONF_COLOR[claim.confidence] || "#64748b", marginLeft: "auto" }}>
                  {claim.confidence} confidence
                </span>
              )}
            </div>

            {/* Claim text */}
            <p style={{ margin: "0 0 8px", fontSize: "0.88rem", color: "#e2e8f0", lineHeight: 1.65, fontWeight: 400 }}>
              {claim.claim_text}
            </p>

            {/* Caveat */}
            {claim.caveat_if_any && (
              <div style={{
                display:      "flex",
                gap:          "6px",
                padding:      "6px 10px",
                borderRadius: "6px",
                background:   "rgba(245,158,11,0.07)",
                border:       "1px solid rgba(245,158,11,0.18)",
                fontSize:     "0.76rem",
                color:        "#fbbf24",
                marginBottom: "8px",
                lineHeight:   1.5,
              }}>
                <span>⚠</span>
                <span>{claim.caveat_if_any}</span>
              </div>
            )}

            {/* Supporting sources */}
            {sources.length > 0 && (
              <div>
                <div style={{
                  fontSize:     "0.68rem",
                  fontWeight:   700,
                  color:        "#334155",
                  letterSpacing:"0.07em",
                  textTransform:"uppercase",
                  marginBottom: "2px",
                }}>
                  Supporting sources
                </div>
                {sources.map((src) => <SourceRef key={src.key} src={src} />)}
              </div>
            )}

            {/* No sources resolved but IDs exist — show count without raw IDs */}
            {sources.length === 0 && (claim.supporting_evidence_ids || []).length > 0 && (
              <div style={{ fontSize: "0.73rem", color: "#334155", marginTop: "4px" }}>
                {claim.supporting_evidence_ids.length} evidence item{claim.supporting_evidence_ids.length > 1 ? "s" : ""} — sources not yet resolved in this view
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
