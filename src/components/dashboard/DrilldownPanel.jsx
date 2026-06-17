/**
 * DrilldownPanel — right-side sliding panel for evidence/claim drilldown.
 *
 * Opens when user clicks a chart segment, category card, claim, happening, or trend.
 * Shows: finding, linked claims (with resolved source URLs), analytics evidence,
 * rawfact evidence, sources, and visual figures.
 */

import { SourceList }       from "./SourceList.jsx";
import { EvidenceList }     from "./EvidenceList.jsx";
import { LinkedClaimsList } from "./LinkedClaimsList.jsx";
import { StatusBadge }      from "./StatusBadge.jsx";

const METRIC_TYPE_LABEL = {
  frequency_distribution:   "Frequency distribution",
  maturity_distribution:    "Maturity distribution",
  timeline:                 "Timeline trend",
  cross_tab_matrix:         "Cross-category breakdown",
  coverage_gap:             "Coverage gap",
  source_coverage:          "Source coverage",
  evidence_confidence:      "Evidence confidence",
  derived_metric:           "Derived metric",
  analytics_metric:         "Corpus metric",
  burst_pattern:            "Burst / cluster signal",
};

// ── Panel section wrapper ─────────────────────────────────────────────────────

function PanelSection({ title, count, children }) {
  return (
    <div style={{ marginBottom: "24px" }}>
      <div style={{
        fontSize:     "0.72rem",
        fontWeight:   700,
        color:        "#475569",
        letterSpacing:"0.08em",
        textTransform:"uppercase",
        marginBottom: "10px",
        display:      "flex",
        alignItems:   "center",
        gap:          "6px",
      }}>
        {title}
        {count != null && (
          <span style={{
            background:  "#1e293b",
            color:       "#64748b",
            borderRadius:"10px",
            padding:     "0 6px",
            fontSize:    "0.65rem",
            fontWeight:  600,
          }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Analytics evidence card ───────────────────────────────────────────────────

function AnalyticsCard({ ae }) {
  const typeLabel = METRIC_TYPE_LABEL[ae.metric_type] || (ae.metric_type || "").replace(/_/g, " ");
  return (
    <div style={{
      padding:      "12px 14px",
      borderRadius: "8px",
      background:   "rgba(99,102,241,0.07)",
      border:       "1px solid rgba(99,102,241,0.18)",
      marginBottom: "8px",
    }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
        <span style={{
          fontSize:    "0.7rem",
          fontWeight:  700,
          color:       "#818cf8",
          padding:     "2px 8px",
          borderRadius:"8px",
          background:  "rgba(99,102,241,0.12)",
        }}>
          {typeLabel || "Analytics"}
        </span>
        {ae.domain && (
          <span style={{ fontSize: "0.72rem", color: "#475569" }}>
            {ae.domain.replace(/_/g, " ")}
          </span>
        )}
        {ae.confidence && (
          <span style={{
            fontSize:  "0.7rem",
            color:     ae.confidence === "high" ? "#10b981" : ae.confidence === "medium" ? "#f59e0b" : "#64748b",
            marginLeft:"auto",
          }}>
            {ae.confidence} confidence
          </span>
        )}
      </div>
      <div style={{ fontSize: "0.88rem", color: "#c7d2fe", lineHeight: 1.65 }}>
        {ae.finding}
      </div>
      {ae.caveat_if_any && (
        <div style={{
          marginTop:   "8px",
          fontSize:    "0.76rem",
          color:       "#fbbf24",
          padding:     "5px 9px",
          borderRadius:"6px",
          background:  "rgba(245,158,11,0.07)",
          border:      "1px solid rgba(245,158,11,0.15)",
        }}>
          ⚠ {ae.caveat_if_any}
        </div>
      )}
    </div>
  );
}

// ── Visual figure card ────────────────────────────────────────────────────────

function VisualCard({ v, i }) {
  const figUrl = v.source_url || v.visual_url;
  return (
    <div style={{
      padding:      "12px 14px",
      borderRadius: "8px",
      background:   "rgba(14,165,233,0.05)",
      border:       "1px solid rgba(14,165,233,0.14)",
      marginBottom: "8px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
        <span style={{ fontSize: "0.74rem", color: "#38bdf8", fontWeight: 600, textTransform: "capitalize" }}>
          {(v.type || "figure").replace(/_/g, " ")}
        </span>
        {v.usage_rights_status === "unknown" && (
          <span style={{ fontSize: "0.7rem", color: "#fbbf24" }}>⚠ rights unknown</span>
        )}
      </div>
      {v.caption && (
        <div style={{ fontSize: "0.82rem", color: "#94a3b8", marginTop: "5px", lineHeight: 1.55 }}>
          {v.caption}
        </div>
      )}
      {figUrl && (
        <a
          href={figUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "block", marginTop: "8px", fontSize: "0.78rem", color: "#6366f1", textDecoration: "none" }}
        >
          View figure ↗
        </a>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function DrilldownPanel({ item, onClose, data }) {
  if (!item) return null;

  const {
    claims = [],
    evidence_index = {},
    source_index = {},
    analytics_evidence = [],
  } = data || {};

  const resolvedEvidenceIds  = item.evidence_ids || [];
  const resolvedSourceIds    = item.source_ids   || [];
  const resolvedAnalyticsIds = item.analytics_evidence_ids || [];
  const resolvedClaimIds     = item.claim_ids    || [];

  const resolvedVisuals = [
    ...(item.external_visual_callouts || []),
    ...resolvedEvidenceIds.flatMap((id) => {
      const ev = evidence_index[id];
      return (ev?.visual_refs || []).filter((v) => v.source_url || v.visual_url);
    }),
  ];

  const linkedClaims            = claims.filter((c) => resolvedClaimIds.includes(c.claim_id));
  const linkedAnalyticsEvidence = analytics_evidence.filter((ae) => resolvedAnalyticsIds.includes(ae.analytics_evidence_id));
  const linkedRawfactEvidence   = resolvedEvidenceIds.map((id) => evidence_index[id]).filter(Boolean);
  const linkedSources           = resolvedSourceIds.map((id) => source_index[id]).filter(Boolean);

  const title      = item.title || item.label || item.chart_title || "Evidence Drilldown";
  const confidence = item.confidence || null;

  const hasContent = linkedClaims.length > 0 || linkedAnalyticsEvidence.length > 0 ||
                     linkedRawfactEvidence.length > 0 || linkedSources.length > 0 || resolvedVisuals.length > 0;

  return (
    <div style={{
      position:     "fixed",
      top:          0,
      right:        0,
      bottom:       0,
      width:        "460px",
      maxWidth:     "92vw",
      background:   "rgba(6,10,18,0.99)",
      borderLeft:   "1px solid #1e293b",
      zIndex:       1000,
      display:      "flex",
      flexDirection:"column",
      boxShadow:    "-12px 0 40px rgba(0,0,0,0.5)",
    }}>

      {/* Header */}
      <div style={{
        padding:      "18px 20px 14px",
        borderBottom: "1px solid #1e293b",
        display:      "flex",
        justifyContent:"space-between",
        alignItems:   "flex-start",
        gap:          "12px",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize:     "0.68rem",
            color:        "#475569",
            fontWeight:   700,
            textTransform:"uppercase",
            letterSpacing:"0.08em",
            marginBottom: "5px",
          }}>
            Evidence Drilldown
          </div>
          <div style={{
            fontSize:   "1rem",
            fontWeight: 700,
            color:      "#f1f5f9",
            lineHeight: 1.4,
            wordBreak:  "break-word",
          }}>
            {title}
          </div>
          {confidence && (
            <div style={{ marginTop: "8px" }}>
              <StatusBadge status={confidence} label={`${confidence} confidence`} />
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background:  "transparent",
            border:      "1px solid #1e293b",
            borderRadius:"6px",
            color:       "#64748b",
            cursor:      "pointer",
            fontSize:    "1rem",
            width:       "30px",
            height:      "30px",
            display:     "flex",
            alignItems:  "center",
            justifyContent:"center",
            flexShrink:  0,
            transition:  "border-color 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#334155"; e.currentTarget.style.color = "#94a3b8"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1e293b"; e.currentTarget.style.color = "#64748b"; }}
        >
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>

        {/* Finding description */}
        {item.description && (
          <PanelSection title="Finding">
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#cbd5e1", lineHeight: 1.7 }}>
              {item.description}
            </p>
          </PanelSection>
        )}

        {/* Caveat */}
        {item.caveat_if_any && (
          <div style={{
            padding:      "10px 14px",
            borderRadius: "8px",
            background:   "rgba(245,158,11,0.07)",
            border:       "1px solid rgba(245,158,11,0.2)",
            fontSize:     "0.82rem",
            color:        "#fbbf24",
            marginBottom: "20px",
            lineHeight:   1.6,
            display:      "flex",
            gap:          "8px",
          }}>
            <span>⚠</span>
            <span>{item.caveat_if_any}</span>
          </div>
        )}

        {/* Linked claims — with full source URL resolution */}
        {linkedClaims.length > 0 && (
          <PanelSection title="Linked Claims" count={linkedClaims.length}>
            <LinkedClaimsList
              claims={linkedClaims}
              evidenceIndex={evidence_index}
              sourceIndex={source_index}
            />
          </PanelSection>
        )}

        {/* Analytics evidence */}
        {linkedAnalyticsEvidence.length > 0 && (
          <PanelSection title="Analytics Evidence" count={linkedAnalyticsEvidence.length}>
            {linkedAnalyticsEvidence.map((ae) => (
              <AnalyticsCard key={ae.analytics_evidence_id} ae={ae} />
            ))}
          </PanelSection>
        )}

        {/* Rawfact evidence */}
        {linkedRawfactEvidence.length > 0 && (
          <PanelSection title="In-Corpus Evidence" count={linkedRawfactEvidence.length}>
            <EvidenceList items={linkedRawfactEvidence} sourceIndex={source_index} />
          </PanelSection>
        )}

        {/* Sources */}
        {linkedSources.length > 0 && (
          <PanelSection title="Sources" count={linkedSources.length}>
            <SourceList sources={linkedSources} />
          </PanelSection>
        )}

        {/* Visual figures */}
        {resolvedVisuals.length > 0 && (
          <PanelSection title="Visual Evidence" count={resolvedVisuals.length}>
            {resolvedVisuals.map((v, i) => (
              <VisualCard key={v.visual_id || v.visualization_id || i} v={v} i={i} />
            ))}
          </PanelSection>
        )}

        {/* Empty state */}
        {!hasContent && (
          <div style={{
            textAlign:  "center",
            paddingTop: "48px",
            color:      "#334155",
            fontSize:   "0.86rem",
            lineHeight: 1.7,
          }}>
            No linked evidence found for this selection.
            <div style={{ marginTop: "8px", fontSize: "0.76rem", color: "#1e3a5f" }}>
              Click a chart segment or category card with source IDs attached.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
