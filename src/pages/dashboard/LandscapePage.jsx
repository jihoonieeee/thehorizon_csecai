/**
 * Landscape Explorer — explorable threat landscape.
 *
 * Category tabs:  All | LLM Threats | Agentic AI | Traditional AI | AI-Enabled
 *   → filters viewpoints, trends, attack vector list, taxonomy matrix
 * Period tabs:    Week | Month | Quarter | Year
 *   → slices the monthly timeline chart to the relevant window
 */

import { useState }             from "react";
import { DashboardChart }       from "../../components/dashboard/DashboardChart.jsx";
import { StatusBadge }          from "../../components/dashboard/StatusBadge.jsx";
import { TaxonomyExplorer }     from "../../components/dashboard/TaxonomyExplorer.jsx";
import { AttackVectorExplorer } from "../../components/dashboard/AttackVectorExplorer.jsx";

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "all",                    label: "All",            color: "#6366f1" },
  { id: "llm_threats",            label: "LLM Threats",    color: "#6366f1" },
  { id: "agentic_ai_threats",     label: "Agentic AI",     color: "#0ea5e9" },
  { id: "traditional_ai_threats", label: "Traditional AI", color: "#f59e0b" },
  { id: "ai_enabled_threats",     label: "AI-Enabled",     color: "#ef4444" },
];

const PERIODS = [
  { id: "month",   label: "1 Month",  months: 1 },
  { id: "quarter", label: "3 Months", months: 3 },
  { id: "biannual",label: "6 Months", months: 6 },
];

const PERIOD_LABELS = {
  month:   "Current month only",
  quarter: "Last 3 months",
  biannual:"Last 6 months",
};

const PATTERN_COLORS = {
  trend: "#10b981", recurring_pattern: "#6366f1", early_signal: "#f59e0b", insufficient_data: "#334155",
};
const PATTERN_LABELS = {
  trend: "Validated Trend", recurring_pattern: "Recurring Pattern", early_signal: "Early Signal",
};

// ── Period-slice helper ───────────────────────────────────────────────────────
// Trim a timeline spec's chart_data to only show the last N months.

function sliceTimelineSpec(spec, periodId) {
  if (!spec) return spec;
  const monthCount = PERIODS.find((p) => p.id === periodId)?.months ?? 6;

  const data = spec.chart_data || {};
  const allMonths = data.months || [];
  if (monthCount >= allMonths.length) return spec; // already within range

  const keep = allMonths.slice(-monthCount);

  const sliceStacks = (stacks) =>
    (stacks || []).map((s) => ({ ...s, values: s.values.slice(-monthCount) }));

  return {
    ...spec,
    chart_data: {
      ...data,
      months: keep,
      stacks: sliceStacks(data.stacks),
      items:  data.items
        ? data.items.map((item) => ({
            ...item,
            values: item.values ? item.values.slice(-monthCount) : item.values,
          }))
        : data.items,
    },
  };
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({ tabs, active, onSelect, size = "sm" }) {
  return (
    <div style={{ display: "flex", gap: "2px", padding: "3px", borderRadius: "10px", background: "rgba(8,12,20,0.6)", border: "1px solid #0f1827", flexWrap: "wrap" }}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button key={tab.id} onClick={() => onSelect(tab.id)} style={{
            padding:      size === "lg" ? "7px 16px" : "5px 13px",
            borderRadius: "7px",
            border:       "none",
            background:   isActive ? (tab.color ? `${tab.color}22` : "rgba(99,102,241,0.18)") : "transparent",
            color:        isActive ? (tab.color || "#a5b4fc") : "#475569",
            cursor:       "pointer",
            fontSize:     size === "lg" ? "0.84rem" : "0.78rem",
            fontWeight:   isActive ? 700 : 400,
            transition:   "all 0.12s",
            whiteSpace:   "nowrap",
            display:      "flex", alignItems: "center", gap: "5px",
          }}>
            {isActive && tab.color && <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: tab.color, flexShrink: 0 }} />}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHead({ title, subtitle }) {
  return (
    <div style={{ marginBottom: "12px" }}>
      <h2 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 700, color: "#e2e8f0" }}>{title}</h2>
      {subtitle && <p style={{ margin: "3px 0 0", fontSize: "0.72rem", color: "#475569" }}>{subtitle}</p>}
    </div>
  );
}

// ── Chart card ────────────────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }) {
  return (
    <div style={{ padding: "14px 16px", borderRadius: "10px", background: "rgba(8,12,20,0.5)", border: "1px solid #0f1827", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: "10px" }}>
        <div style={{ fontSize: "0.84rem", fontWeight: 700, color: "#e2e8f0" }}>{title}</div>
        {subtitle && <div style={{ fontSize: "0.7rem", color: "#475569", marginTop: "2px" }}>{subtitle}</div>}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Viewpoint card ────────────────────────────────────────────────────────────

function ViewpointCard({ vp, onDrilldown }) {
  const color = CATEGORIES.find((c) => c.id === vp.category)?.color || "#6366f1";
  return (
    <button
      onClick={() => onDrilldown?.({ type: "viewpoint", title: vp.viewpoint_id, description: vp.statement, confidence: vp.confidence, evidence_ids: vp.supporting_evidence_ids || [], source_ids: [], claim_ids: vp.supporting_claim_ids || [], analytics_evidence_ids: [] })}
      style={{ padding: "12px 14px", borderRadius: "8px", background: "rgba(15,23,42,0.5)", border: `1px solid ${color}33`, cursor: "pointer", textAlign: "left", width: "100%" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", marginBottom: "6px" }}>
        <span style={{ fontSize: "0.64rem", fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {CATEGORIES.find((c) => c.id === vp.category)?.label || vp.category} · {vp.viewpoint_type?.replace(/_/g, " ")}
        </span>
        <StatusBadge status={vp.confidence} />
      </div>
      <div style={{ fontSize: "0.84rem", color: "#e2e8f0", lineHeight: 1.6 }}>{vp.statement}</div>
      <div style={{ fontSize: "0.68rem", color: "#334155", marginTop: "5px" }}>
        {(vp.supporting_claim_ids || []).length} claims · {(vp.supporting_evidence_ids || []).length} evidence items
      </div>
    </button>
  );
}

// ── Trend row ─────────────────────────────────────────────────────────────────

function TrendRow({ pattern, onDrilldown }) {
  const color = PATTERN_COLORS[pattern.pattern_type] || "#334155";
  const d = pattern.delta || 0;
  return (
    <button
      onClick={() => onDrilldown?.({ type: "trend", title: pattern.label, description: `${pattern.label} — ${pattern.pattern_type?.replace(/_/g, " ")}. ${pattern.current_count} sources vs ${pattern.compare_count} prior.`, confidence: pattern.confidence, caveat_if_any: pattern.caveat, evidence_ids: pattern.evidence_ids || [], source_ids: [], claim_ids: pattern.claim_ids || [], analytics_evidence_ids: [] })}
      style={{ display: "flex", gap: "12px", padding: "10px 13px", borderRadius: "7px", background: "rgba(15,23,42,0.5)", border: `1px solid ${color}22`, borderLeft: `3px solid ${color}`, cursor: "pointer", textAlign: "left", width: "100%", alignItems: "center" }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.82rem", color: "#e2e8f0", fontWeight: 500 }}>{pattern.label}</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "3px" }}>
          <span style={{ fontSize: "0.64rem", padding: "1px 6px", borderRadius: "8px", background: `${color}18`, color, fontWeight: 700 }}>{PATTERN_LABELS[pattern.pattern_type] || pattern.pattern_type}</span>
          <span style={{ fontSize: "0.7rem", color: "#475569" }}>{CATEGORIES.find((c) => c.id === pattern.category)?.label || pattern.category}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px", flexShrink: 0 }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: d > 0 ? "#f87171" : d < 0 ? "#34d399" : "#64748b" }}>
          {d > 0 ? "+" : ""}{d}
        </span>
        <span style={{ fontSize: "0.66rem", color: "#334155" }}>{pattern.current_count} vs {pattern.compare_count}</span>
      </div>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function LandscapePage({ data, onDrilldown }) {
  const [cat,    setCat]    = useState("all");
  const [period, setPeriod] = useState("month");

  if (!data) return null;

  const {
    viewpoints = [], trends_or_patterns = [],
    visualization_specs = [],
    attack_vector_details = {},
    source_index = {},
  } = data;

  // ── Category filter ──────────────────────────────────────────────────────
  const filteredViewpoints = cat === "all" ? viewpoints : viewpoints.filter((vp) => vp.category === cat);
  const filteredTrends     = cat === "all" ? trends_or_patterns : trends_or_patterns.filter((t) => t.category === cat);

  // ── Spec lookup ──────────────────────────────────────────────────────────
  const rawTimeline    = visualization_specs.find((s) => s.visualization_id === "vs_monthly_timeline");
  const attackVecSpec  = visualization_specs.find((s) => s.visualization_id === "vs_attack_vector_freq");
  const sourceTypeSpec = visualization_specs.find((s) => s.visualization_id === "vs_source_type_dist");
  const aiOverlaySpec  = visualization_specs.find((s) => s.visualization_id === "vs_ai_enabled_overlay");
  const taxonomySpec   = visualization_specs.find((s) => s.visualization_id === "vs_taxonomy_heatmap");

  // Slice timeline by period
  const timelineSpec = sliceTimelineSpec(rawTimeline, period);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>

      {/* ── Navigation tabs ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <TabBar tabs={CATEGORIES} active={cat}    onSelect={setCat}    size="lg" />
        <TabBar tabs={PERIODS}    active={period} onSelect={setPeriod} />
        <div style={{ fontSize: "0.68rem", color: "#334155", marginLeft: "auto", flexShrink: 0 }}>
          <span style={{ color: "#475569" }}>{PERIOD_LABELS[period]}</span>
          {cat !== "all" && <span style={{ color: CATEGORIES.find((c) => c.id === cat)?.color || "#6366f1", marginLeft: "8px" }}>
            · {CATEGORIES.find((c) => c.id === cat)?.label}
          </span>}
          <span style={{ color: "#334155", marginLeft: "8px" }}>{filteredViewpoints.length} viewpoints · {filteredTrends.length} patterns</span>
        </div>
      </div>

      {/* ── Timeline + source-type breakdown ─────────────────────────────── */}
      <div className="landscape-chart-grid">
        {timelineSpec && (
          <ChartCard
            title="Source Activity Over Time"
            subtitle={`${PERIOD_LABELS[period]} — click segments to explore.`}
          >
            <DashboardChart spec={timelineSpec} height={220} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
        {sourceTypeSpec && (
          <ChartCard
            title="What We Collected"
            subtitle="Source types in the current corpus. Click a bar to explore sources."
          >
            <DashboardChart spec={sourceTypeSpec} height={220} onDrilldown={onDrilldown} />
          </ChartCard>
        )}
      </div>

      {/* ── Attack vector explorer — full width, category-filtered ────────── */}
      {attackVecSpec && (
        <AttackVectorExplorer
          spec={attackVecSpec}
          attackVectorDetails={attack_vector_details}
          sourceIndex={source_index}
          activeCat={cat}
          onDrilldown={onDrilldown}
        />
      )}

      {/* ── Viewpoints ───────────────────────────────────────────────────── */}
      {filteredViewpoints.length > 0 && (
        <section>
          <SectionHead
            title="Analytical Viewpoints"
            subtitle="Synthesised findings from L6 analysis. Click to see supporting evidence."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filteredViewpoints.map((vp) => <ViewpointCard key={vp.viewpoint_id} vp={vp} onDrilldown={onDrilldown} />)}
          </div>
        </section>
      )}

      {/* ── Trends ───────────────────────────────────────────────────────── */}
      {filteredTrends.length > 0 && (
        <section>
          <SectionHead
            title="Trends and Patterns"
            subtitle="Trend = validated ≥3 months + ≥2 source types. Recurring = consistent pattern."
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {filteredTrends.map((t) => <TrendRow key={t.pattern_id} pattern={t} onDrilldown={onDrilldown} />)}
          </div>
        </section>
      )}

      {/* ── AI-enabled overlay ───────────────────────────────────────────── */}
      {aiOverlaySpec && (
        <ChartCard title="AI-Enabled Overlay by Category" subtitle="AI role across all categories — not just the AI-enabled category.">
          <DashboardChart spec={aiOverlaySpec} height={220} onDrilldown={onDrilldown} />
        </ChartCard>
      )}

      {/* ── Taxonomy matrix — full width, category pre-filtered ──────────── */}
      {taxonomySpec && (
        <TaxonomyExplorer
          spec={taxonomySpec}
          activeCat={cat}
          onDrilldown={onDrilldown}
        />
      )}

    </div>
  );
}
