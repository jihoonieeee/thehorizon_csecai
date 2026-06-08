/**
 * Overview — monthly executive summary with clickable category cards, claims,
 * happenings, early signals, outlook, and evidence confidence chart.
 *
 * All cards and chart segments pass drilldown data to the parent shell.
 */

import { DashboardChart } from "../../components/dashboard/DashboardChart.jsx";
import { StatusBadge }    from "../../components/dashboard/StatusBadge.jsx";

const PRIORITY_COLOR = {
  critical: "#ef4444",
  high:     "#f97316",
  medium:   "#f59e0b",
};

const CATEGORY_COLORS = {
  llm_threats:            "#6366f1",
  agentic_ai_threats:     "#0ea5e9",
  traditional_ai_threats: "#f59e0b",
  ai_enabled_threats:     "#ef4444",
};

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <h2 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 700, color: "#e2e8f0", letterSpacing: "0.01em" }}>{title}</h2>
      {subtitle && <p style={{ margin: "4px 0 0", fontSize: "0.73rem", color: "#475569" }}>{subtitle}</p>}
    </div>
  );
}

function CategoryCard({ cat, onDrilldown }) {
  const isInsufficient = cat.assessment_status === "evidence_insufficient";
  const color = CATEGORY_COLORS[cat.id] || "#6366f1";
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "category",
        title:       cat.label,
        description: cat.headline,
        confidence:  cat.confidence,
        caveat_if_any: isInsufficient ? "Insufficient evidence — category not assessed." : null,
        evidence_ids:   cat.evidence_ids || [],
        source_ids:     [],
        claim_ids:      cat.claim_ids || [],
        analytics_evidence_ids: cat.analytics_evidence_ids || [],
      })}
      style={{
        padding:      "14px 16px",
        borderRadius: "10px",
        background:   isInsufficient ? "rgba(15,23,42,0.4)" : "rgba(15,23,42,0.7)",
        border:       `1px solid ${isInsufficient ? "#1e293b" : color}44`,
        cursor:       "pointer",
        textAlign:    "left",
        width:        "100%",
        transition:   "border-color 0.15s, background 0.15s",
        opacity:      isInsufficient ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#e2e8f0" }}>{cat.label}</span>
          </div>
          <div style={{ fontSize: "0.76rem", color: "#94a3b8", lineHeight: 1.5, marginBottom: "10px" }}>
            {cat.headline}
          </div>
          {!isInsufficient && cat.top_signal && (
            <div style={{ fontSize: "0.7rem", color: "#475569", borderLeft: `2px solid ${color}44`, paddingLeft: "8px" }}>
              {cat.top_signal}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-end", flexShrink: 0 }}>
          <StatusBadge status={cat.confidence} />
          {!isInsufficient && (
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {(cat.claim_counts?.critical || 0) > 0 && (
                <span style={{ fontSize: "0.62rem", fontWeight: 700, color: "#f87171", background: "rgba(239,68,68,0.1)", padding: "1px 5px", borderRadius: "6px" }}>
                  {cat.claim_counts.critical} critical
                </span>
              )}
              {(cat.claim_counts?.high || 0) > 0 && (
                <span style={{ fontSize: "0.62rem", fontWeight: 700, color: "#fb923c", background: "rgba(249,115,22,0.08)", padding: "1px 5px", borderRadius: "6px" }}>
                  {cat.claim_counts.high} high
                </span>
              )}
            </div>
          )}
          <span style={{ fontSize: "0.65rem", color: "#334155", marginTop: "2px" }}>{cat.source_count} src</span>
        </div>
      </div>
    </button>
  );
}

function ClaimRow({ claim, onDrilldown }) {
  const color = PRIORITY_COLOR[claim.claim_priority] || "#64748b";
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "claim",
        title:       claim.claim_text.slice(0, 60) + "…",
        description: claim.claim_text,
        confidence:  claim.confidence,
        caveat_if_any: claim.caveat_if_any,
        evidence_ids:  claim.supporting_evidence_ids || [],
        source_ids:    [],
        claim_ids:     [claim.claim_id],
        analytics_evidence_ids: claim.supporting_analytics_ids || [],
      })}
      style={{
        display:     "flex",
        gap:         "12px",
        padding:     "10px 14px",
        borderRadius:"8px",
        background:  "rgba(15,23,42,0.5)",
        border:      `1px solid ${color}22`,
        borderLeft:  `3px solid ${color}`,
        cursor:      "pointer",
        textAlign:   "left",
        width:       "100%",
        transition:  "background 0.12s",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.78rem", color: "#e2e8f0", lineHeight: 1.5 }}>{claim.claim_text}</div>
        <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: "4px" }}>
          {claim.claim_id} · {claim.claim_type?.replace(/_/g, " ")}
          {claim.supporting_evidence_ids?.length > 0 && ` · ${claim.supporting_evidence_ids.length} evidence items`}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        <StatusBadge status={claim.confidence} />
      </div>
    </button>
  );
}

function HappeningRow({ hap, onDrilldown }) {
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "happening",
        title:       hap.title,
        description: hap.description,
        confidence:  hap.significance === "critical" ? "critical" : hap.significance,
        evidence_ids:hap.evidence_ids || [],
        source_ids:  hap.source_ids   || [],
        claim_ids:   hap.claim_ids    || [],
        analytics_evidence_ids: [],
      })}
      style={{
        display:     "flex",
        gap:         "12px",
        padding:     "10px 14px",
        borderRadius:"8px",
        background:  "rgba(15,23,42,0.5)",
        border:      "1px solid #1e293b",
        cursor:      "pointer",
        textAlign:   "left",
        width:       "100%",
        alignItems:  "flex-start",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#e2e8f0" }}>{hap.title}</div>
        <div style={{ fontSize: "0.73rem", color: "#64748b", marginTop: "3px", lineHeight: 1.4 }}>{hap.description}</div>
        <div style={{ fontSize: "0.65rem", color: "#334155", marginTop: "4px" }}>{hap.date}</div>
      </div>
      <StatusBadge status={hap.significance} label={hap.significance} />
    </button>
  );
}

export function OverviewPage({ data, onDrilldown }) {
  if (!data) return null;
  const { summary, categories, claims, happenings, early_signals, outlook_6_months, visualization_specs } = data;
  const topCriticalClaims = claims.filter((c) => c.claim_priority === "critical");
  const topHighClaims     = claims.filter((c) => c.claim_priority === "high").slice(0, 4);
  const evidenceStrengthSpec = visualization_specs.find((s) => s.visualization_id === "vs_evidence_strength");
  const categoryBarSpec      = visualization_specs.find((s) => s.visualization_id === "vs_category_bar");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>

      {/* Period summary banner */}
      <div style={{
        padding:      "14px 18px",
        borderRadius: "10px",
        background:   "rgba(8,12,20,0.8)",
        border:       "1px solid #0f1827",
      }}>
        <div style={{ fontWeight: 700, fontSize: "1rem", color: "#e2e8f0", marginBottom: "4px" }}>
          {summary.period_label} — AI Threat Horizon Scan
        </div>
        <div style={{ fontSize: "0.78rem", color: "#475569", lineHeight: 1.6 }}>
          {summary.executive_headline}
        </div>
        {summary.caveat && (
          <div style={{ fontSize: "0.7rem", color: "#f59e0b", marginTop: "6px", display: "flex", gap: "6px", alignItems: "flex-start" }}>
            <span>⚠</span> {summary.caveat}
          </div>
        )}
      </div>

      {/* Category cards */}
      <section>
        <SectionHeader
          title="Threat Categories"
          subtitle="Click a card to drill into evidence, claims, and sources."
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: "10px" }}>
          {categories.map((cat) => (
            <CategoryCard key={cat.id} cat={cat} onDrilldown={onDrilldown} />
          ))}
        </div>
      </section>

      {/* Two-column: claims + source volume chart */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <section>
          <SectionHeader
            title="Critical & High Claims"
            subtitle="Click to see supporting evidence and sources."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {[...topCriticalClaims, ...topHighClaims].map((claim) => (
              <ClaimRow key={claim.claim_id} claim={claim} onDrilldown={onDrilldown} />
            ))}
          </div>
        </section>

        {categoryBarSpec && (
          <section>
            <SectionHeader
              title="Source Volume by Category"
              subtitle="Within collected corpus. Click a bar to see sources."
            />
            <DashboardChart
              spec={categoryBarSpec}
              height={280}
              onDrilldown={onDrilldown}
            />
          </section>
        )}
      </div>

      {/* Main happenings */}
      <section>
        <SectionHeader
          title="Main Happenings"
          subtitle="Key events this period. Click to see linked evidence."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {happenings.map((hap) => (
            <HappeningRow key={hap.happening_id} hap={hap} onDrilldown={onDrilldown} />
          ))}
        </div>
      </section>

      {/* Early signals */}
      <section>
        <SectionHeader
          title="Early Signals"
          subtitle="Emerging indicators — not yet confirmed. Treat as preliminary."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {early_signals.map((sig) => (
            <button
              key={sig.signal_id}
              onClick={() => onDrilldown?.({
                type:        "signal",
                title:       sig.signal,
                description: `${sig.signal}\n→ ${sig.implication}`,
                confidence:  sig.confidence,
                evidence_ids:sig.evidence_ids || [],
                source_ids:  [],
                claim_ids:   sig.claim_ids    || [],
                analytics_evidence_ids: [],
              })}
              style={{
                padding:     "10px 14px",
                borderRadius:"8px",
                background:  "rgba(15,23,42,0.5)",
                border:      "1px solid #1e293b",
                cursor:      "pointer",
                textAlign:   "left",
                width:       "100%",
                display:     "flex",
                gap:         "12px",
                alignItems:  "flex-start",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "0.78rem", color: "#e2e8f0" }}>{sig.signal}</div>
                <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "4px" }}>→ {sig.implication}</div>
              </div>
              <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px" }}>
                <StatusBadge status={sig.confidence} />
                <span style={{ fontSize: "0.65rem", color: "#334155" }}>{sig.source_count} src</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* 6-month outlook */}
      {outlook_6_months.length > 0 && (
        <section>
          <SectionHeader
            title="6-Month Outlook"
            subtitle="Forward projection based on current corpus — confidence varies."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {outlook_6_months.map((out) => (
              <button
                key={out.outlook_id}
                onClick={() => onDrilldown?.({
                  type:        "outlook",
                  title:       `Outlook: ${out.category.replace(/_/g, " ")}`,
                  description: out.statement,
                  confidence:  out.confidence,
                  evidence_ids:out.evidence_ids || [],
                  source_ids:  [],
                  claim_ids:   out.claim_ids    || [],
                  analytics_evidence_ids: [],
                })}
                style={{
                  padding:     "12px 14px",
                  borderRadius:"8px",
                  background:  "rgba(14,165,233,0.05)",
                  border:      "1px solid rgba(14,165,233,0.15)",
                  cursor:      "pointer",
                  textAlign:   "left",
                  width:       "100%",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
                  <div>
                    <div style={{ fontSize: "0.7rem", color: "#0ea5e9", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
                      {out.category.replace(/_/g, " ")} · {out.trajectory}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "#e2e8f0", lineHeight: 1.5 }}>{out.statement}</div>
                    <div style={{ fontSize: "0.7rem", color: "#475569", marginTop: "4px" }}>{out.observed_basis}</div>
                  </div>
                  <StatusBadge status={out.confidence} />
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Evidence strength matrix */}
      {evidenceStrengthSpec && (
        <section>
          <SectionHeader
            title="Evidence Strength by Category"
            subtitle="Distribution of evidence quality across the corpus."
          />
          <div style={{
            padding:      "14px 16px",
            borderRadius: "10px",
            background:   "rgba(8,12,20,0.5)",
            border:       "1px solid #0f1827",
          }}>
            <DashboardChart spec={evidenceStrengthSpec} height={180} onDrilldown={onDrilldown} />
          </div>
        </section>
      )}

    </div>
  );
}
