/**
 * Landscape Explorer — main monthly threat landscape page.
 *
 * Filter bar: period, category, source_type, evidence_strength, AI-overlay.
 * Sections: category cards, insights/viewpoints, monthly timeline, taxonomy heatmap,
 * AI-enabled overlay, attack surface, operational maturity funnel.
 * All chart segments click to drilldown panel.
 */

import { useState }           from "react";
import { DashboardChart }     from "../../components/dashboard/DashboardChart.jsx";
import { StatusBadge }        from "../../components/dashboard/StatusBadge.jsx";

const CATEGORY_LABELS = {
  all:                    "All Categories",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI",
  traditional_ai_threats: "Traditional AI",
  ai_enabled_threats:     "AI-Enabled",
};

const CATEGORY_COLORS = {
  llm_threats:            "#6366f1",
  agentic_ai_threats:     "#0ea5e9",
  traditional_ai_threats: "#f59e0b",
  ai_enabled_threats:     "#ef4444",
};

const PATTERN_LABELS = {
  trend:             "Validated Trend",
  recurring_pattern: "Recurring Pattern",
  early_signal:      "Early Signal",
  insufficient_data: "Insufficient Data",
};

const PATTERN_COLORS = {
  trend:             "#10b981",
  recurring_pattern: "#6366f1",
  early_signal:      "#f59e0b",
  insufficient_data: "#334155",
};

// ── Filter bar ─────────────────────────────────────────────────────────────────

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style={{ fontSize: "0.65rem", color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background:   "#0f172a",
          border:       "1px solid #1e293b",
          borderRadius: "6px",
          color:        "#94a3b8",
          fontSize:     "0.76rem",
          padding:      "4px 8px",
          cursor:       "pointer",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Viewpoint card ─────────────────────────────────────────────────────────────

function ViewpointCard({ vp, onDrilldown }) {
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "viewpoint",
        title:       vp.viewpoint_id,
        description: vp.statement,
        confidence:  vp.confidence,
        evidence_ids:vp.supporting_evidence_ids || [],
        source_ids:  [],
        claim_ids:   vp.supporting_claim_ids    || [],
        analytics_evidence_ids: [],
      })}
      style={{
        padding:      "12px 14px",
        borderRadius: "8px",
        background:   "rgba(15,23,42,0.5)",
        border:       `1px solid ${CATEGORY_COLORS[vp.category] || "#1e293b"}33`,
        cursor:       "pointer",
        textAlign:    "left",
        width:        "100%",
        transition:   "background 0.12s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", marginBottom: "6px" }}>
        <span style={{
          fontSize:  "0.62rem", fontWeight: 700, color: CATEGORY_COLORS[vp.category] || "#64748b",
          textTransform: "uppercase", letterSpacing: "0.06em",
        }}>
          {CATEGORY_LABELS[vp.category] || vp.category} · {vp.viewpoint_type?.replace(/_/g, " ")}
        </span>
        <StatusBadge status={vp.confidence} />
      </div>
      <div style={{ fontSize: "0.8rem", color: "#e2e8f0", lineHeight: 1.6 }}>{vp.statement}</div>
      <div style={{ fontSize: "0.65rem", color: "#334155", marginTop: "6px" }}>
        {(vp.supporting_claim_ids || []).length} linked claims · {(vp.supporting_evidence_ids || []).length} evidence items
      </div>
    </button>
  );
}

// ── Trend/pattern row ──────────────────────────────────────────────────────────

function TrendRow({ pattern, onDrilldown }) {
  const color = PATTERN_COLORS[pattern.pattern_type] || "#334155";
  const delta = pattern.delta || 0;
  return (
    <button
      onClick={() => onDrilldown?.({
        type:        "trend",
        title:       pattern.label,
        description: `${pattern.label} — ${pattern.pattern_type?.replace(/_/g, " ")}. ${pattern.current_count} sources this period vs ${pattern.compare_count} previous.`,
        confidence:  pattern.confidence,
        caveat_if_any: pattern.caveat,
        evidence_ids:pattern.evidence_ids || [],
        source_ids:  [],
        claim_ids:   pattern.claim_ids    || [],
        analytics_evidence_ids: [],
      })}
      style={{
        display:     "flex",
        gap:         "12px",
        padding:     "9px 12px",
        borderRadius:"7px",
        background:  "rgba(15,23,42,0.5)",
        border:      `1px solid ${color}22`,
        borderLeft:  `3px solid ${color}`,
        cursor:      "pointer",
        textAlign:   "left",
        width:       "100%",
        alignItems:  "center",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.78rem", color: "#e2e8f0", fontWeight: 600 }}>{pattern.label}</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "3px" }}>
          <span style={{
            fontSize: "0.62rem", padding: "1px 6px", borderRadius: "8px",
            background: `${color}18`, color, fontWeight: 700,
          }}>
            {PATTERN_LABELS[pattern.pattern_type] || pattern.pattern_type}
          </span>
          <span style={{ fontSize: "0.68rem", color: "#475569" }}>
            {CATEGORY_LABELS[pattern.category] || pattern.category}
          </span>
        </div>
        {pattern.caveat && (
          <div style={{ fontSize: "0.65rem", color: "#475569", marginTop: "3px", fontStyle: "italic" }}>
            ⚠ {pattern.caveat.slice(0, 80)}{pattern.caveat.length > 80 ? "…" : ""}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px", flexShrink: 0 }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 700, color: delta > 0 ? "#10b981" : delta < 0 ? "#ef4444" : "#64748b" }}>
          {delta > 0 ? "+" : ""}{delta}
        </div>
        <div style={{ fontSize: "0.65rem", color: "#334155" }}>{pattern.current_count} vs {pattern.compare_count}</div>
      </div>
    </button>
  );
}

// ── SectionHeader ──────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <h2 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 700, color: "#e2e8f0" }}>{title}</h2>
      {subtitle && <p style={{ margin: "4px 0 0", fontSize: "0.73rem", color: "#475569" }}>{subtitle}</p>}
    </div>
  );
}

function ChartCard({ title, subtitle, children, height = "auto" }) {
  return (
    <div style={{
      padding:      "14px 16px",
      borderRadius: "10px",
      background:   "rgba(8,12,20,0.5)",
      border:       "1px solid #0f1827",
      height,
      display:      "flex",
      flexDirection:"column",
    }}>
      <div style={{ marginBottom: "10px" }}>
        <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "#e2e8f0" }}>{title}</div>
        {subtitle && <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: "2px" }}>{subtitle}</div>}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function LandscapePage({ data, onDrilldown }) {
  const [catFilter,      setCatFilter]      = useState("all");
  const [aiOverlay,      setAiOverlay]      = useState("all");
  const [strengthFilter, setStrengthFilter] = useState("all");

  if (!data) return null;

  const { categories, viewpoints = [], trends_or_patterns = [], visualization_specs = [] } = data;

  // Filtered viewpoints
  const filteredViewpoints = catFilter === "all"
    ? viewpoints
    : viewpoints.filter((vp) => vp.category === catFilter);

  const filteredTrends = catFilter === "all"
    ? trends_or_patterns
    : trends_or_patterns.filter((t) => t.category === catFilter);

  // Chart specs
  const timelineSpec     = visualization_specs.find((s) => s.visualization_id === "vs_monthly_timeline");
  const attackVecSpec    = visualization_specs.find((s) => s.visualization_id === "vs_attack_vector_freq");
  const maturitySpec     = visualization_specs.find((s) => s.visualization_id === "vs_maturity_funnel");
  const aiOverlaySpec    = visualization_specs.find((s) => s.visualization_id === "vs_ai_enabled_overlay");
  const taxonomySpec     = visualization_specs.find((s) => s.visualization_id === "vs_taxonomy_heatmap");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>

      {/* Sticky filter bar */}
      <div style={{
        position:    "sticky",
        top:         0,
        zIndex:      10,
        padding:     "10px 14px",
        borderRadius:"8px",
        background:  "rgba(8,12,20,0.97)",
        border:      "1px solid #0f1827",
        display:     "flex",
        gap:         "16px",
        flexWrap:    "wrap",
        alignItems:  "center",
      }}>
        <FilterSelect
          label="Category"
          value={catFilter}
          onChange={setCatFilter}
          options={[
            { value: "all",                    label: "All Categories" },
            { value: "llm_threats",            label: "LLM Threats" },
            { value: "agentic_ai_threats",     label: "Agentic AI" },
            { value: "traditional_ai_threats", label: "Traditional AI" },
            { value: "ai_enabled_threats",     label: "AI-Enabled" },
          ]}
        />
        <FilterSelect
          label="AI Overlay"
          value={aiOverlay}
          onChange={setAiOverlay}
          options={[
            { value: "all",           label: "All Roles" },
            { value: "attack_tool",   label: "AI as Attack Tool" },
            { value: "attack_target", label: "AI as Attack Target" },
            { value: "infra_dep",     label: "AI as Infrastructure" },
            { value: "defense_control",label:"AI as Defense Control" },
          ]}
        />
        <FilterSelect
          label="Evidence"
          value={strengthFilter}
          onChange={setStrengthFilter}
          options={[
            { value: "all",    label: "All Strength" },
            { value: "strong", label: "Strong" },
            { value: "usable", label: "Usable" },
            { value: "context",label: "Context" },
          ]}
        />
        <div style={{ fontSize: "0.65rem", color: "#334155", marginLeft: "auto" }}>
          {filteredViewpoints.length} viewpoints · {filteredTrends.length} patterns
        </div>
      </div>

      {/* Monthly timeline + Attack surface side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        {timelineSpec && (
          <ChartCard title="Monthly Source Activity" subtitle="Click segments to explore sources by category.">
            <DashboardChart spec={timelineSpec} height={240} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
        {attackVecSpec && (
          <ChartCard title="Top Attack Vectors" subtitle="Within collected corpus — not real-world prevalence.">
            <DashboardChart spec={attackVecSpec} height={240} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
      </div>

      {/* Insights / Viewpoints */}
      <section>
        <SectionHeader
          title="Analytical Viewpoints"
          subtitle="Synthesized findings from L6 analysis. Click to see supporting evidence and sources."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filteredViewpoints.map((vp) => (
            <ViewpointCard key={vp.viewpoint_id} vp={vp} onDrilldown={onDrilldown} />
          ))}
          {filteredViewpoints.length === 0 && (
            <div style={{ color: "#334155", fontSize: "0.78rem", padding: "12px" }}>No viewpoints for this filter.</div>
          )}
        </div>
      </section>

      {/* Trends & Patterns */}
      <section>
        <SectionHeader
          title="Trends and Patterns"
          subtitle="Trend = validated ≥3 months + ≥2 source types. Recurring = pattern without validation. Early signal = preliminary."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {filteredTrends.map((t) => (
            <TrendRow key={t.pattern_id} pattern={t} onDrilldown={onDrilldown} />
          ))}
          {filteredTrends.length === 0 && (
            <div style={{ color: "#334155", fontSize: "0.78rem", padding: "12px" }}>No patterns for this filter.</div>
          )}
        </div>
      </section>

      {/* AI-enabled overlay + Taxonomy heatmap */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        {aiOverlaySpec && (
          <ChartCard title="AI-Enabled Overlay by Category" subtitle="AI role across all categories — not just AI-enabled category.">
            <DashboardChart spec={aiOverlaySpec} height={240} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
        {taxonomySpec && (
          <ChartCard title="Taxonomy Tag Distribution" subtitle="Primary threat tags across categories. Click cells to see sources.">
            <DashboardChart spec={taxonomySpec} height={240} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
      </div>

      {/* Operational maturity funnel */}
      {maturitySpec && (
        <ChartCard title="Operational Maturity Pipeline" subtitle="Where threats sit in the research → operational progression. Click stage to explore sources.">
          <DashboardChart spec={maturitySpec} height={260} onDrilldown={onDrilldown} />
        </ChartCard>
      )}

    </div>
  );
}
