/**
 * AttackVectorExplorer — large explorable attack vector panel.
 *
 * Shows a ranked list of vectors with counts and heat bars.
 * Clicking a vector expands an inline detail card with:
 *   - operational maturity stage pipeline
 *   - what's been happening this period
 *   - why it matters
 *   - 6-month mini trend
 *   - linked sources
 *
 * Filters by activeCat when not "all".
 */

import { useState } from "react";

// ── Maturity stage pipeline ────────────────────────────────────────────────────
// 4 ordered stages; current stage and all prior stages are lit.

const MATURITY_STAGES = [
  {
    key:   "research_only",
    label: "Research",
    full:  "Research Only",
    desc:  "Described in academic or industry research — not yet demonstrated under attack conditions.",
    color: "#6366f1",
  },
  {
    key:   "proof_of_concept",
    label: "PoC",
    full:  "Proof of Concept",
    desc:  "Independently demonstrated in lab or controlled settings — not yet observed in real-world attacks.",
    color: "#f59e0b",
  },
  {
    key:   "limited_operational",
    label: "Limited",
    full:  "Limited Exploitation",
    desc:  "Observed in a limited number of real-world attacks or incidents.",
    color: "#f97316",
  },
  {
    key:   "active_operational",
    label: "Active",
    full:  "Active Exploitation",
    desc:  "Confirmed in multiple real-world incidents — operationally active in the threat landscape.",
    color: "#ef4444",
  },
];

const MATURITY_INDEX = Object.fromEntries(MATURITY_STAGES.map((s, i) => [s.key, i]));

function MaturityPipeline({ maturityKey, basis }) {
  const currentIdx = MATURITY_INDEX[maturityKey] ?? 1;
  const current    = MATURITY_STAGES[currentIdx];

  return (
    <div style={{ marginBottom: "14px" }}>
      {/* Stage label + description */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{
          fontSize: "0.7rem", fontWeight: 700, padding: "3px 10px", borderRadius: "10px",
          background: `${current.color}18`, color: current.color, border: `1px solid ${current.color}33`,
        }}>
          {current.full}
        </span>
      </div>
      <div style={{ fontSize: "0.76rem", color: "#64748b", marginBottom: "10px", lineHeight: 1.5 }}>
        {current.desc}
      </div>

      {/* Visual pipeline bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {MATURITY_STAGES.map((stage, i) => {
          const isActive  = i === currentIdx;
          const isPast    = i < currentIdx;
          const isFuture  = i > currentIdx;
          const color     = stage.color;
          return (
            <div key={stage.key} style={{ display: "flex", alignItems: "center", flex: 1 }}>
              {/* Node */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                <div style={{
                  width:      isActive ? "12px" : "8px",
                  height:     isActive ? "12px" : "8px",
                  borderRadius: "50%",
                  background:  isFuture ? "#1e293b" : (isActive ? color : `${color}88`),
                  border:      isActive ? `2px solid ${color}` : "none",
                  transition:  "all 0.2s",
                  flexShrink:  0,
                }} />
                <span style={{
                  fontSize:  "0.6rem",
                  color:     isFuture ? "#1e3a5f" : (isActive ? color : `${color}99`),
                  fontWeight: isActive ? 700 : 400,
                  whiteSpace: "nowrap",
                }}>
                  {stage.label}
                </span>
              </div>
              {/* Connector line (not after last) */}
              {i < MATURITY_STAGES.length - 1 && (
                <div style={{
                  height:     "2px",
                  width:      "24px",
                  background: i < currentIdx ? `${MATURITY_STAGES[i + 1].color}55` : "#1e293b",
                  flexShrink: 0,
                  marginBottom: "14px",
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Basis */}
      {basis && (
        <div style={{ fontSize: "0.68rem", color: "#334155", marginTop: "8px", fontStyle: "italic" }}>
          Assessment basis: {basis}
        </div>
      )}
    </div>
  );
}

// ── Category helpers ───────────────────────────────────────────────────────────

const CAT_COLOR = {
  llm_threats:            "#6366f1",
  agentic_ai_threats:     "#0ea5e9",
  traditional_ai_threats: "#f59e0b",
  ai_enabled_threats:     "#ef4444",
};

const CAT_LABEL = {
  llm_threats:            "LLM",
  agentic_ai_threats:     "Agentic AI",
  traditional_ai_threats: "Traditional AI",
  ai_enabled_threats:     "AI-Enabled",
};

// ── Sparkline ─────────────────────────────────────────────────────────────────

function MiniSparkline({ counts, color }) {
  if (!counts?.length) return null;
  const max = Math.max(...counts, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "24px", width: "72px" }}>
      {counts.map((v, i) => (
        <div key={i} style={{
          flex:       1,
          height:     `${Math.round((v / max) * 100)}%`,
          minHeight:  "2px",
          borderRadius:"2px",
          background: i === counts.length - 1 ? color : `${color}55`,
        }} />
      ))}
    </div>
  );
}

// ── Bar cell ──────────────────────────────────────────────────────────────────

function VectorBar({ count, max, color }) {
  const pct = Math.round((count / max) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
      <div style={{
        height:      "6px",
        borderRadius:"3px",
        background:  `${color}30`,
        flex:        1,
        overflow:    "hidden",
      }}>
        <div style={{
          height:     "100%",
          width:      `${pct}%`,
          borderRadius:"3px",
          background: color,
          transition: "width 0.4s ease",
        }} />
      </div>
      <span style={{ fontSize: "0.84rem", fontWeight: 700, color: "#e2e8f0", width: "24px", textAlign: "right", flexShrink: 0 }}>
        {count}
      </span>
    </div>
  );
}

// ── Detail panel (inline expansion) ──────────────────────────────────────────

function VectorDetail({ detail, sourceIndex, onDrilldown }) {
  const color = CAT_COLOR[detail.category] || "#6366f1";
  const d     = detail.trend_delta ?? 0;

  return (
    <div style={{
      padding:   "16px 18px",
      background:`${color}08`,
      borderTop: `1px solid ${color}22`,
    }}>

      {/* Maturity pipeline */}
      <MaturityPipeline maturityKey={detail.maturity} basis={detail.maturity_basis} />

      {/* Trend delta + sparkline */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.72rem", color: d > 0 ? "#f87171" : d < 0 ? "#34d399" : "#64748b", fontWeight: 600 }}>
          {d > 0 ? `↑ +${d}` : d < 0 ? `↓ ${d}` : "→ stable"} sources vs last month
        </span>
        {detail.monthly_counts && (
          <div style={{ marginLeft: "auto" }}>
            <MiniSparkline counts={detail.monthly_counts} color={color} />
          </div>
        )}
      </div>

      {/* Description */}
      <p style={{ margin: "0 0 12px", fontSize: "0.86rem", color: "#cbd5e1", lineHeight: 1.7 }}>
        {detail.description}
      </p>

      {/* What happened */}
      {detail.what_happened?.length > 0 && (
        <div style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>
            This period
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {detail.what_happened.map((item, i) => (
              <div key={i} style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}>
                <span style={{ color, fontSize: "0.7rem", marginTop: "3px", flexShrink: 0 }}>▸</span>
                <span style={{ fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.55 }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Why it matters */}
      {detail.why_it_matters && (
        <div style={{
          padding:      "10px 14px",
          borderRadius: "8px",
          background:   "rgba(0,0,0,0.2)",
          border:       `1px solid ${color}18`,
          marginBottom: "12px",
        }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "5px" }}>
            Why it matters
          </div>
          <p style={{ margin: 0, fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.65 }}>{detail.why_it_matters}</p>
        </div>
      )}

      {/* Linked sources */}
      {detail.source_ids?.length > 0 && (
        <div>
          <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "7px" }}>
            Source references
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {detail.source_ids.map((sid) => {
              const src = sourceIndex?.[sid];
              if (!src) return null;
              return (
                <div key={sid} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: color, flexShrink: 0 }} />
                  {src.url ? (
                    <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.8rem", color: "#93c5fd", textDecoration: "none", lineHeight: 1.4 }}>
                      {src.title}
                    </a>
                  ) : (
                    <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{src.title}</span>
                  )}
                  <span style={{ fontSize: "0.7rem", color: "#334155" }}>· {src.publisher}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AttackVectorExplorer({ spec, attackVectorDetails = {}, sourceIndex = {}, activeCat = "all", onDrilldown }) {
  const [selected, setSelected] = useState(null);

  if (!spec?.chart_data?.items) return null;

  const allItems = spec.chart_data.items;

  // Filter by active category
  const items = activeCat === "all"
    ? allItems
    : allItems.filter((item) => {
        const detail = attackVectorDetails[item.key];
        return detail?.category === activeCat;
      });

  if (items.length === 0) {
    return (
      <div style={{ padding: "24px 18px", borderRadius: "12px", background: "rgba(8,12,20,0.6)", border: "1px solid #0f1827", textAlign: "center", color: "#334155", fontSize: "0.8rem" }}>
        No attack vectors tracked for this category this period.
      </div>
    );
  }

  const max = Math.max(...items.map((i) => i.count), 1);

  return (
    <div style={{
      borderRadius: "12px",
      background:   "rgba(8,12,20,0.6)",
      border:       "1px solid #0f1827",
      overflow:     "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding:      "14px 18px 12px",
        borderBottom: "1px solid #0f1827",
        display:      "flex",
        justifyContent:"space-between",
        alignItems:   "center",
        gap:          "12px",
        flexWrap:     "wrap",
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: 700, color: "#e2e8f0" }}>Top Attack Vectors</h3>
          <p style={{ margin: "3px 0 0", fontSize: "0.7rem", color: "#475569" }}>
            Source frequency within collected corpus. Click any vector for a detailed breakdown.
          </p>
        </div>
        <span style={{ fontSize: "0.68rem", color: "#334155", padding: "3px 8px", borderRadius: "6px", background: "#0f172a", border: "1px solid #0f1827" }}>
          {spec.caveat_if_any || "Corpus frequency — not real-world prevalence"}
        </span>
      </div>

      {/* Vector list */}
      <div>
        {items.map((item) => {
          const detail    = attackVectorDetails[item.key];
          const isOpen    = selected === item.key;
          const catKey    = detail?.category || "llm_threats";
          const color     = CAT_COLOR[catKey] || "#6366f1";
          const catLabel  = CAT_LABEL[catKey] || catKey;
          const delta     = detail?.trend_delta ?? null;

          return (
            <div key={item.key} style={{ borderBottom: "1px solid #0a0f1a" }}>
              <button
                onClick={() => setSelected(isOpen ? null : item.key)}
                style={{
                  width:       "100%",
                  display:     "flex",
                  alignItems:  "center",
                  gap:         "12px",
                  padding:     "13px 18px",
                  background:  isOpen ? `${color}0a` : "transparent",
                  border:      "none",
                  cursor:      "pointer",
                  textAlign:   "left",
                  transition:  "background 0.12s",
                }}
                onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ color: isOpen ? color : "#334155", fontSize: "0.7rem", width: "12px", flexShrink: 0 }}>
                  {isOpen ? "▾" : "▸"}
                </span>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: color, flexShrink: 0 }} />
                <div style={{ flex: "0 0 auto", minWidth: "180px" }}>
                  <span style={{ fontSize: "0.88rem", fontWeight: isOpen ? 600 : 400, color: isOpen ? "#f1f5f9" : "#cbd5e1" }}>
                    {item.label}
                  </span>
                  <span style={{ fontSize: "0.68rem", color: "#334155", marginLeft: "8px" }}>{catLabel}</span>
                </div>
                <VectorBar count={item.count} max={max} color={color} />
                {delta != null && (
                  <span style={{
                    fontSize:   "0.74rem",
                    fontWeight: 600,
                    color:      delta > 0 ? "#f87171" : delta < 0 ? "#34d399" : "#475569",
                    width:      "52px",
                    textAlign:  "right",
                    flexShrink: 0,
                  }}>
                    {delta > 0 ? `+${delta}` : delta === 0 ? "—" : delta}
                  </span>
                )}
              </button>

              {isOpen && detail && (
                <VectorDetail detail={detail} sourceIndex={sourceIndex} onDrilldown={onDrilldown} />
              )}
              {isOpen && !detail && (
                <div style={{ padding: "14px 18px", background: "rgba(255,255,255,0.02)", fontSize: "0.8rem", color: "#334155" }}>
                  No detailed breakdown available for this vector yet.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: "8px 18px", borderTop: "1px solid #0a0f1a", fontSize: "0.66rem", color: "#1e3a5f", display: "flex", justifyContent: "space-between" }}>
        <span>{items.length} vector{items.length !== 1 ? "s" : ""} tracked this period{activeCat !== "all" ? " (filtered)" : ""}</span>
        <span>Δ = change vs previous month</span>
      </div>
    </div>
  );
}
