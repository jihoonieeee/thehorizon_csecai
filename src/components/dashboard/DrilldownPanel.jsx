/**
 * DrilldownPanel — right-side sliding panel for evidence/claim drilldown.
 *
 * Opens when user clicks a chart segment, category card, claim, happening, or trend.
 * Shows: title, explanation, linked claims, analytics evidence, rawfact evidence,
 * external evidence, source quotes, publisher/URL, caveats.
 *
 * Usage:
 *   <DrilldownPanel item={drilldownItem} onClose={() => setDrilldown(null)} data={MONTHLY_DASHBOARD} />
 *
 * drilldownItem shape:
 *   { type, chart_id, clicked_key, label, source_ids[], evidence_ids[], analytics_evidence_ids[], chart_title }
 *   OR
 *   { type: "claim", claim_id, ...claimData }
 *   OR
 *   { type: "happening", happening_id, ...happeningData }
 */

import { SourceList }         from "./SourceList.jsx";
import { EvidenceList }       from "./EvidenceList.jsx";
import { LinkedClaimsList }   from "./LinkedClaimsList.jsx";
import { StatusBadge }        from "./StatusBadge.jsx";

function PanelSection({ title, children }) {
  return (
    <div style={{ marginBottom: "20px" }}>
      <div style={{
        fontSize:     "0.65rem",
        fontWeight:   700,
        color:        "#475569",
        letterSpacing:"0.08em",
        textTransform:"uppercase",
        marginBottom: "8px",
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function resolveClaimTitle(claim) {
  if (!claim) return "Selected Claim";
  return claim.claim_text?.slice(0, 60) + (claim.claim_text?.length > 60 ? "…" : "");
}

export function DrilldownPanel({ item, onClose, data }) {
  if (!item) return null;

  const { claims = [], viewpoints = [], evidence_index = {}, external_evidence_index = {}, source_index = {}, analytics_evidence = [] } = data || {};

  // Resolve IDs to objects
  const resolvedEvidenceIds  = item.evidence_ids || [];
  const resolvedSourceIds    = item.source_ids    || [];
  const resolvedAnalyticsIds = item.analytics_evidence_ids || [];
  const resolvedClaimIds     = item.claim_ids     || [];

  const linkedClaims          = claims.filter((c) => resolvedClaimIds.includes(c.claim_id));
  const linkedAnalyticsEvidence = analytics_evidence.filter((ae) => resolvedAnalyticsIds.includes(ae.analytics_evidence_id));
  const linkedRawfactEvidence = resolvedEvidenceIds.map((id) => evidence_index[id]).filter(Boolean);
  const linkedSources         = resolvedSourceIds.map((id) => source_index[id]).filter(Boolean);

  const title = item.title || item.label || item.chart_title || "Evidence Drilldown";
  const confidence = item.confidence || null;

  return (
    <div style={{
      position:    "fixed",
      top:         0,
      right:       0,
      bottom:      0,
      width:       "420px",
      maxWidth:    "90vw",
      background:  "rgba(8,12,20,0.98)",
      borderLeft:  "1px solid #1e293b",
      zIndex:      1000,
      display:     "flex",
      flexDirection:"column",
      boxShadow:   "-8px 0 32px rgba(0,0,0,0.4)",
    }}>
      {/* Header */}
      <div style={{
        padding:      "16px 18px 12px",
        borderBottom: "1px solid #1e293b",
        display:      "flex",
        justifyContent:"space-between",
        alignItems:   "flex-start",
        gap:          "10px",
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "0.65rem", color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" }}>
            Evidence Drilldown
          </div>
          <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#e2e8f0", lineHeight: 1.4 }}>
            {title}
          </div>
          {confidence && (
            <div style={{ marginTop: "6px" }}>
              <StatusBadge status={confidence} label={`${confidence} confidence`} />
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background:  "transparent",
            border:      "none",
            color:       "#475569",
            cursor:      "pointer",
            fontSize:    "1.2rem",
            padding:     "0 4px",
            lineHeight:  1,
          }}
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>

        {/* Description / finding */}
        {item.description && (
          <PanelSection title="Finding">
            <div style={{ fontSize: "0.83rem", color: "#cbd5e1", lineHeight: 1.6 }}>
              {item.description}
            </div>
          </PanelSection>
        )}

        {/* Caveat */}
        {item.caveat_if_any && (
          <div style={{
            padding:      "8px 12px",
            borderRadius: "6px",
            background:   "rgba(245,158,11,0.08)",
            border:       "1px solid rgba(245,158,11,0.2)",
            fontSize:     "0.75rem",
            color:        "#fbbf24",
            marginBottom: "16px",
          }}>
            ⚠ {item.caveat_if_any}
          </div>
        )}

        {/* Linked claims */}
        {linkedClaims.length > 0 && (
          <PanelSection title={`Linked Claims (${linkedClaims.length})`}>
            <LinkedClaimsList claims={linkedClaims} />
          </PanelSection>
        )}

        {/* Analytics evidence */}
        {linkedAnalyticsEvidence.length > 0 && (
          <PanelSection title="Analytics Evidence">
            {linkedAnalyticsEvidence.map((ae) => (
              <div key={ae.analytics_evidence_id} style={{
                padding:      "8px 10px",
                borderRadius: "6px",
                background:   "rgba(99,102,241,0.08)",
                border:       "1px solid rgba(99,102,241,0.2)",
                marginBottom: "6px",
              }}>
                <div style={{ fontSize: "0.7rem", color: "#818cf8", fontWeight: 700, marginBottom: "4px" }}>
                  {ae.analytics_evidence_id} · {ae.metric_type}
                </div>
                <div style={{ fontSize: "0.78rem", color: "#c7d2fe", lineHeight: 1.5 }}>{ae.finding}</div>
                {ae.caveat_if_any && (
                  <div style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "4px" }}>⚠ {ae.caveat_if_any}</div>
                )}
              </div>
            ))}
          </PanelSection>
        )}

        {/* Rawfact evidence */}
        {linkedRawfactEvidence.length > 0 && (
          <PanelSection title={`In-Corpus Evidence (${linkedRawfactEvidence.length})`}>
            <EvidenceList items={linkedRawfactEvidence} sourceIndex={source_index} />
          </PanelSection>
        )}

        {/* Sources */}
        {linkedSources.length > 0 && (
          <PanelSection title={`Sources (${linkedSources.length})`}>
            <SourceList sources={linkedSources} />
          </PanelSection>
        )}

        {/* Empty state */}
        {linkedClaims.length === 0 && linkedAnalyticsEvidence.length === 0 &&
         linkedRawfactEvidence.length === 0 && linkedSources.length === 0 && (
          <div style={{ color: "#334155", fontSize: "0.78rem", textAlign: "center", paddingTop: "32px" }}>
            No linked evidence found for this selection.
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding:     "10px 18px",
        borderTop:   "1px solid #1e293b",
        fontSize:    "0.65rem",
        color:       "#334155",
      }}>
        {resolvedEvidenceIds.length > 0 && <span>Evidence IDs: {resolvedEvidenceIds.join(", ")} · </span>}
        {resolvedSourceIds.length > 0 && <span>Sources: {resolvedSourceIds.join(", ")}</span>}
      </div>
    </div>
  );
}
