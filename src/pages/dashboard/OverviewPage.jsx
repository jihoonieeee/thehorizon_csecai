/**
 * Overview — monthly executive summary.
 * Shows this month's numbers with 6-month trend context.
 * No technical IDs shown anywhere — analysts only see findings.
 */

import { DashboardChart } from "../../components/dashboard/DashboardChart.jsx";
import { StatusBadge }    from "../../components/dashboard/StatusBadge.jsx";

const CAT_COLOR = {
  llm_threats:            "#6366f1",
  agentic_ai_threats:     "#0ea5e9",
  traditional_ai_threats: "#f59e0b",
  ai_enabled_threats:     "#ef4444",
};

const PRIORITY_COLOR = { critical: "#ef4444", high: "#f97316", medium: "#f59e0b" };
const TRAJ_ICON = { escalating: "↑", stable: "→", declining: "↓", emerging: "⬡" };
const TRAJ_COLOR = { escalating: "#f87171", stable: "#64748b", declining: "#34d399", emerging: "#fbbf24" };

// ── Helpers ───────────────────────────────────────────────────────────────────

function delta(current, prev) {
  const d = current - prev;
  return { value: d, sign: d > 0 ? "+" : "", color: d > 0 ? "#f87171" : d < 0 ? "#34d399" : "#64748b" };
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, prev, unit = "", accent = "#6366f1", sublabel }) {
  const d = prev != null ? delta(value, prev) : null;
  return (
    <div style={{
      padding:      "16px 18px",
      borderRadius: "10px",
      background:   "rgba(8,12,20,0.7)",
      border:       `1px solid ${accent}22`,
    }}>
      <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <span style={{ fontSize: "2rem", fontWeight: 800, color: "#f1f5f9", lineHeight: 1 }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: "0.8rem", color: "#475569" }}>{unit}</span>}
        {d && (
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: d.color, marginLeft: "2px" }}>
            {d.sign}{d.value} vs last month
          </span>
        )}
      </div>
      {sublabel && (
        <div style={{ fontSize: "0.72rem", color: "#334155", marginTop: "5px" }}>{sublabel}</div>
      )}
    </div>
  );
}

// ── Sparkline (pure CSS bar series) ──────────────────────────────────────────

function Sparkline({ counts, color, months }) {
  const max = Math.max(...counts, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "28px" }}>
      {counts.map((v, i) => (
        <div key={i} title={`${months?.[i] || i}: ${v}`} style={{
          flex:         1,
          height:       `${Math.round((v / max) * 100)}%`,
          minHeight:    "2px",
          borderRadius: "2px",
          background:   i === counts.length - 1 ? color : `${color}44`,
          transition:   "height 0.3s",
        }} />
      ))}
    </div>
  );
}

// ── Category card ─────────────────────────────────────────────────────────────

function CategoryCard({ cat, months, onDrilldown }) {
  const color    = CAT_COLOR[cat.id] || "#6366f1";
  const isGap    = cat.assessment_status === "evidence_insufficient";
  const d        = delta(cat.source_count, cat.prev_source_count ?? cat.source_count);

  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "category",
        title:       cat.label,
        description: cat.headline,
        confidence:  cat.confidence,
        caveat_if_any: isGap ? "Insufficient evidence — category not assessed this period." : null,
        evidence_ids:   cat.evidence_ids || [],
        source_ids:     [],
        claim_ids:      cat.claim_ids    || [],
        analytics_evidence_ids: cat.analytics_evidence_ids || [],
      })}
      style={{
        padding:      "14px 16px",
        borderRadius: "10px",
        background:   "rgba(8,12,20,0.7)",
        border:       `1px solid ${isGap ? "#1e293b" : color}33`,
        cursor:       "pointer",
        textAlign:    "left",
        width:        "100%",
        opacity:      isGap ? 0.55 : 1,
        transition:   "border-color 0.15s, opacity 0.15s",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", marginBottom: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontSize: "0.84rem", fontWeight: 700, color: "#e2e8f0" }}>{cat.label}</span>
        </div>
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <StatusBadge status={cat.confidence} />
          {(cat.claim_counts?.critical || 0) > 0 && (
            <span style={{ fontSize: "0.66rem", fontWeight: 700, color: "#f87171", background: "rgba(239,68,68,0.1)", padding: "1px 6px", borderRadius: "6px" }}>
              {cat.claim_counts.critical} critical
            </span>
          )}
          {(cat.claim_counts?.high || 0) > 0 && (
            <span style={{ fontSize: "0.66rem", fontWeight: 700, color: "#fb923c", background: "rgba(249,115,22,0.08)", padding: "1px 6px", borderRadius: "6px" }}>
              {cat.claim_counts.high} high
            </span>
          )}
        </div>
      </div>

      {/* Headline */}
      <div style={{ fontSize: "0.78rem", color: "#94a3b8", lineHeight: 1.55, marginBottom: "10px" }}>
        {cat.headline}
      </div>

      {/* Top signal */}
      {!isGap && cat.top_signal && (
        <div style={{ fontSize: "0.72rem", color: "#475569", borderLeft: `2px solid ${color}44`, paddingLeft: "8px", lineHeight: 1.4, marginBottom: "12px" }}>
          {cat.top_signal}
        </div>
      )}

      {/* Source count + sparkline */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <span style={{ fontSize: "1.3rem", fontWeight: 800, color: "#e2e8f0", lineHeight: 1 }}>{cat.source_count}</span>
          <span style={{ fontSize: "0.72rem", color: "#475569", marginLeft: "5px" }}>sources</span>
          {d.value !== 0 && (
            <span style={{ fontSize: "0.72rem", color: d.color, marginLeft: "6px", fontWeight: 600 }}>
              {d.sign}{d.value} vs last month
            </span>
          )}
          {d.value === 0 && (
            <span style={{ fontSize: "0.72rem", color: "#334155", marginLeft: "6px" }}>stable</span>
          )}
        </div>
        {cat.monthly_counts && (
          <div style={{ width: "80px" }}>
            <Sparkline counts={cat.monthly_counts} color={color} months={months} />
          </div>
        )}
      </div>
    </button>
  );
}

// ── Claim row ─────────────────────────────────────────────────────────────────

function ClaimRow({ claim, onDrilldown }) {
  const color = PRIORITY_COLOR[claim.claim_priority] || "#64748b";
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "claim",
        title:       claim.claim_text.slice(0, 70) + (claim.claim_text.length > 70 ? "…" : ""),
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
        padding:     "11px 14px",
        borderRadius:"8px",
        background:  "rgba(15,23,42,0.5)",
        border:      `1px solid ${color}22`,
        borderLeft:  `3px solid ${color}`,
        cursor:      "pointer",
        textAlign:   "left",
        width:       "100%",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "5px" }}>
          <span style={{
            display: "inline-block",
            minWidth: "62px",
            textAlign: "center",
            fontSize: "0.66rem",
            fontWeight: 700,
            color,
            background: `${color}18`,
            padding: "2px 8px",
            borderRadius: "8px",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            flexShrink: 0,
          }}>
            {claim.claim_priority}
          </span>
          <span style={{ fontSize: "0.7rem", color: "#475569" }}>
            {claim.claim_type?.replace(/_/g, " ")}
          </span>
        </div>
        <div style={{ fontSize: "0.86rem", color: "#e2e8f0", lineHeight: 1.55 }}>{claim.claim_text}</div>
      </div>
      <StatusBadge status={claim.confidence} />
    </button>
  );
}

// ── Happening row ─────────────────────────────────────────────────────────────

function HappeningRow({ hap, onDrilldown }) {
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "happening",
        title:       hap.title,
        description: hap.description,
        confidence:  hap.significance,
        evidence_ids:hap.evidence_ids || [],
        source_ids:  hap.source_ids   || [],
        claim_ids:   hap.claim_ids    || [],
        analytics_evidence_ids: [],
      })}
      style={{
        display:     "flex",
        gap:         "14px",
        padding:     "12px 14px",
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
        <div style={{ fontSize: "0.86rem", fontWeight: 600, color: "#e2e8f0", marginBottom: "4px" }}>{hap.title}</div>
        <div style={{ fontSize: "0.78rem", color: "#64748b", lineHeight: 1.5 }}>{hap.description}</div>
        {hap.date && <div style={{ fontSize: "0.7rem", color: "#334155", marginTop: "5px" }}>{hap.date}</div>}
      </div>
      <StatusBadge status={hap.significance} label={hap.significance} />
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function OverviewPage({ data, onDrilldown }) {
  if (!data) return null;
  const { summary, categories, claims, happenings, early_signals, outlook_6_months, visualization_specs, six_month_trend } = data;

  const trend     = six_month_trend || {};
  const months    = trend.months || [];
  const critClaims = claims.filter((c) => c.claim_priority === "critical");
  const highClaims = claims.filter((c) => c.claim_priority === "high").slice(0, 3);
  const evidenceStrengthSpec = visualization_specs.find((s) => s.visualization_id === "vs_evidence_strength");
  const totalSources    = summary.total_sources;
  const prevTotal       = trend.total_sources?.[4] ?? totalSources;
  const criticalCount   = categories.reduce((n, c) => n + (c.claim_counts?.critical || 0), 0);
  const prevCritical    = trend.critical_findings?.[4] ?? criticalCount;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>

      {/* ── Executive headline ───────────────────────────────────────────── */}
      <div style={{
        padding:      "18px 20px",
        borderRadius: "10px",
        background:   "rgba(8,12,20,0.8)",
        border:       "1px solid #0f1827",
      }}>
        <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>
          {summary.period_label} — AI Threat Scan
        </div>
        <p style={{ margin: "0 0 8px", fontSize: "0.96rem", color: "#e2e8f0", lineHeight: 1.65, fontWeight: 400 }}>
          {summary.executive_headline}
        </p>
        {summary.caveat && (
          <div style={{ fontSize: "0.76rem", color: "#f59e0b", display: "flex", gap: "7px", alignItems: "flex-start" }}>
            <span>⚠</span>
            <span>{summary.caveat}</span>
          </div>
        )}
      </div>

      {/* ── At-a-glance stats ─────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px" }}>
        <StatCard
          label="Sources collected"
          value={totalSources}
          prev={prevTotal}
          accent="#6366f1"
          sublabel={`${summary.sources_validated} validated`}
        />
        <StatCard
          label="Critical findings"
          value={criticalCount}
          prev={prevCritical}
          accent="#ef4444"
          sublabel="Require immediate attention"
        />
        <StatCard
          label="Categories assessed"
          value={summary.categories_assessed}
          accent="#10b981"
          sublabel={`${summary.categories_not_assessed || 0} insufficient evidence`}
        />
        <StatCard
          label="Coverage"
          value={summary.coverage_months}
          unit="months"
          accent="#0ea5e9"
          sublabel="Rolling history window"
        />
      </div>

      {/* ── Category cards ───────────────────────────────────────────────── */}
      <section>
        <div style={{ marginBottom: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>This Month by Threat Category</h2>
          <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>
            Source counts with 6-month trend. Click a category to explore evidence and claims.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: "10px" }}>
          {categories.map((cat) => (
            <CategoryCard key={cat.id} cat={cat} months={months} onDrilldown={onDrilldown} />
          ))}
        </div>
      </section>

      {/* ── Critical & high claims ────────────────────────────────────────── */}
      <section>
        <div style={{ marginBottom: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>Key Findings This Month</h2>
          <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>
            Validated claims ranked by priority. Click to see supporting sources and evidence.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
          {[...critClaims, ...highClaims].map((claim) => (
            <ClaimRow key={claim.claim_id} claim={claim} onDrilldown={onDrilldown} />
          ))}
        </div>
      </section>

      {/* ── Happenings + Early signals ────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }} className="landscape-chart-grid">
        <section>
          <div style={{ marginBottom: "12px" }}>
            <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>Main Happenings</h2>
            <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>Concrete events observed this period.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
            {happenings.map((hap) => (
              <HappeningRow key={hap.happening_id} hap={hap} onDrilldown={onDrilldown} />
            ))}
          </div>
        </section>

        <section>
          <div style={{ marginBottom: "12px" }}>
            <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>Early Signals</h2>
            <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>Preliminary indicators — not yet confirmed. Treat as watch items.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
            {early_signals.map((sig) => (
              <button
                key={sig.signal_id}
                onClick={() => onDrilldown?.({
                  type:        "signal",
                  title:       sig.signal,
                  description: `${sig.signal}\n\nImplication: ${sig.implication}`,
                  confidence:  sig.confidence,
                  evidence_ids:sig.evidence_ids || [],
                  source_ids:  [],
                  claim_ids:   sig.claim_ids    || [],
                  analytics_evidence_ids: [],
                })}
                style={{
                  padding:     "11px 14px",
                  borderRadius:"8px",
                  background:  "rgba(15,23,42,0.5)",
                  border:      "1px solid rgba(245,158,11,0.15)",
                  borderLeft:  "3px solid rgba(245,158,11,0.5)",
                  cursor:      "pointer",
                  textAlign:   "left",
                  width:       "100%",
                  display:     "flex",
                  gap:         "12px",
                  alignItems:  "flex-start",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.84rem", color: "#e2e8f0", lineHeight: 1.5 }}>{sig.signal}</div>
                  <div style={{ fontSize: "0.74rem", color: "#64748b", marginTop: "4px" }}>→ {sig.implication}</div>
                </div>
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                  <StatusBadge status={sig.confidence} />
                  <span style={{ fontSize: "0.68rem", color: "#334155" }}>{sig.source_count} sources</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* ── 6-month outlook ───────────────────────────────────────────────── */}
      {outlook_6_months.length > 0 && (
        <section>
          <div style={{ marginBottom: "12px" }}>
            <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>6-Month Outlook</h2>
            <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>
              Forward projection based on current evidence trajectory — confidence varies.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {outlook_6_months.map((out) => {
              const color = CAT_COLOR[out.category] || "#0ea5e9";
              const traj  = out.trajectory || "stable";
              return (
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
                    padding:     "14px 16px",
                    borderRadius:"8px",
                    background:  "rgba(14,165,233,0.04)",
                    border:      `1px solid ${color}22`,
                    borderLeft:  `3px solid ${color}55`,
                    cursor:      "pointer",
                    textAlign:   "left",
                    width:       "100%",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          {out.category.replace(/_/g, " ")}
                        </span>
                        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: TRAJ_COLOR[traj] }}>
                          {TRAJ_ICON[traj]} {traj}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.86rem", color: "#e2e8f0", lineHeight: 1.6 }}>{out.statement}</div>
                      <div style={{ fontSize: "0.74rem", color: "#475569", marginTop: "6px" }}>
                        Based on: {out.observed_basis}
                      </div>
                    </div>
                    <StatusBadge status={out.confidence} />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Evidence strength ─────────────────────────────────────────────── */}
      {evidenceStrengthSpec && (
        <section>
          <div style={{ marginBottom: "12px" }}>
            <h2 style={{ margin: 0, fontSize: "0.94rem", fontWeight: 700, color: "#e2e8f0" }}>Evidence Quality by Category</h2>
            <p style={{ margin: "3px 0 0", fontSize: "0.74rem", color: "#475569" }}>
              How strong is the evidence behind each threat category this month.
            </p>
          </div>
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "rgba(8,12,20,0.5)", border: "1px solid #0f1827" }}>
            <DashboardChart spec={evidenceStrengthSpec} height={160} onDrilldown={onDrilldown} />
          </div>
        </section>
      )}

    </div>
  );
}
