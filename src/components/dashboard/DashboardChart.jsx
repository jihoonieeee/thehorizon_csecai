/**
 * DashboardChart — ECharts renderer for visualization_spec objects.
 *
 * Reads a visualization_spec (from L5B or mockData) and renders the appropriate
 * ECharts chart type. Supports: bar, stacked_bar, line, timeline, heatmap_table,
 * matrix_table, funnel, evidence_gap_table.
 *
 * Every chart supports:
 *   - hover tooltip with details
 *   - click callback → passes drilldown IDs to parent
 *   - caveat display below chart
 *   - insufficient_data placeholder
 *   - confidence badge
 */

import ReactECharts from "echarts-for-react";

const CATEGORY_COLORS = {
  llm_threats:            "#6366f1",
  agentic_ai_threats:     "#0ea5e9",
  traditional_ai_threats: "#f59e0b",
  ai_enabled_threats:     "#ef4444",
};

const STACK_COLORS = [
  "#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4",
];

const STRENGTH_COLORS = {
  strong:  "#10b981",
  usable:  "#6366f1",
  context: "#f59e0b",
  archive: "#475569",
};

function confidenceColor(conf) {
  if (conf === "high")   return "#10b981";
  if (conf === "medium") return "#f59e0b";
  return "#64748b";
}

// ── Base ECharts config ────────────────────────────────────────────────────────

function baseConfig(title) {
  return {
    backgroundColor: "transparent",
    textStyle:       { color: "#94a3b8", fontSize: 11 },
    title:           title ? { text: title, textStyle: { color: "#e2e8f0", fontSize: 13, fontWeight: 600 }, top: 4, left: 6 } : undefined,
    tooltip:         { trigger: "item", backgroundColor: "#1e293b", borderColor: "#334155", textStyle: { color: "#e2e8f0" }, confine: true },
    grid:            { top: 36, bottom: 28, left: 14, right: 14, containLabel: true },
  };
}

// ── Chart builders ─────────────────────────────────────────────────────────────

function buildBar(spec) {
  const items = spec.chart_data?.items || [];
  const useColor = items.some((i) => CATEGORY_COLORS[i.key]);
  return {
    ...baseConfig(null),
    tooltip: { trigger: "axis", backgroundColor: "#1e293b", borderColor: "#334155", textStyle: { color: "#e2e8f0" } },
    xAxis:   {
      type: "category",
      data: items.map((i) => i.label || i.key),
      axisLabel: { color: "#64748b", fontSize: 10, rotate: items.length > 5 ? 30 : 0 },
      axisTick:  { show: false },
      axisLine:  { lineStyle: { color: "#1e293b" } },
    },
    yAxis: {
      type:      "value",
      axisLabel: { color: "#64748b", fontSize: 10 },
      splitLine: { lineStyle: { color: "#1e293b" } },
    },
    series: [{
      type:      "bar",
      barMaxWidth: 40,
      data:      items.map((item) => ({
        value:     item.count,
        itemStyle: { color: useColor ? (CATEGORY_COLORS[item.key] || "#6366f1") : "#6366f1", borderRadius: [3, 3, 0, 0] },
        _raw:      item,
      })),
      emphasis:  { itemStyle: { opacity: 0.8 } },
    }],
  };
}

function buildStackedBar(spec) {
  const data = spec.chart_data || {};
  const months  = data.months  || data.categories || [];
  const stacks  = data.stacks  || [];
  return {
    ...baseConfig(null),
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: "#1e293b", borderColor: "#334155", textStyle: { color: "#e2e8f0" } },
    legend: {
      data:      stacks.map((s) => s.label || s.key),
      textStyle: { color: "#64748b", fontSize: 10 },
      bottom:    0,
      icon:      "circle",
      itemWidth: 8,
    },
    xAxis: {
      type:      "category",
      data:      months,
      axisLabel: { color: "#64748b", fontSize: 10, rotate: months.length > 6 ? 30 : 0 },
      axisTick:  { show: false },
      axisLine:  { lineStyle: { color: "#1e293b" } },
    },
    yAxis: {
      type:      "value",
      axisLabel: { color: "#64748b", fontSize: 10 },
      splitLine: { lineStyle: { color: "#1e293b" } },
    },
    series: stacks.map((s, i) => ({
      name:      s.label || s.key,
      type:      "bar",
      stack:     "total",
      data:      (s.values || []).map((v) => ({ value: v, _key: s.key })),
      itemStyle: { color: CATEGORY_COLORS[s.key] || STACK_COLORS[i % STACK_COLORS.length] },
      emphasis:  { focus: "series" },
    })),
  };
}

function buildFunnel(spec) {
  const items = spec.chart_data?.items || [];
  const total = items[0]?.count || 1;
  return {
    ...baseConfig(null),
    tooltip: { trigger: "item", backgroundColor: "#1e293b", borderColor: "#334155", textStyle: { color: "#e2e8f0" } },
    series: [{
      type:        "funnel",
      left:        "10%",
      width:       "80%",
      top:         10,
      bottom:      10,
      sort:        "none",
      gap:         4,
      label:       { show: true, position: "inside", color: "#fff", fontSize: 11 },
      labelLine:   { show: false },
      data: items.map((item, i) => ({
        name:      item.label || item.key,
        value:     Math.round(item.count / total * 100),
        label:     { formatter: `{b}: ${item.count}` },
        itemStyle: { color: STACK_COLORS[i % STACK_COLORS.length] },
        _raw:      item,
      })),
    }],
  };
}

function buildHeatmap(spec) {
  const data   = spec.chart_data || {};
  const cols   = data.columns || [];
  const rows   = data.rows    || [];
  const allVals = rows.flatMap((r) => r.values || []);
  const maxVal  = Math.max(...allVals, 1);
  const cells   = [];
  rows.forEach((row, ri) =>
    (row.values || []).forEach((val, ci) => cells.push([ci, ri, val]))
  );
  return {
    ...baseConfig(null),
    tooltip: {
      position: "top",
      backgroundColor: "#1e293b",
      borderColor: "#334155",
      textStyle: { color: "#e2e8f0" },
      formatter: (p) => `${rows[p.data[1]]?.label || ""} × ${cols[p.data[0]]?.label || ""}: <b>${p.data[2]}</b>`,
    },
    grid:   { top: 16, bottom: 10, left: 10, right: 10, containLabel: true },
    xAxis:  { type: "category", data: cols.map((c) => c.label || c.key), axisLabel: { color: "#64748b", fontSize: 10 }, splitArea: { show: true, areaStyle: { color: ["rgba(15,23,42,0.3)","rgba(15,23,42,0.1)"] } } },
    yAxis:  { type: "category", data: rows.map((r) => r.label || r.key), axisLabel: { color: "#64748b", fontSize: 10 }, splitArea: { show: true, areaStyle: { color: ["rgba(15,23,42,0.3)","rgba(15,23,42,0.1)"] } } },
    visualMap: { min: 0, max: maxVal, calculable: true, orient: "horizontal", left: "center", bottom: -4, textStyle: { color: "#475569", fontSize: 9 }, inRange: { color: ["#1e293b","#4338ca","#6366f1"] } },
    series: [{ type: "heatmap", data: cells, label: { show: maxVal < 20, formatter: (p) => p.data[2] || "", color: "#e2e8f0", fontSize: 10 }, emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(99,102,241,0.5)" } } }],
  };
}

function buildMatrixTable(spec) {
  const data = spec.chart_data || {};
  const cols = data.columns || [];
  const rows = data.rows    || [];
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem", color: "#94a3b8" }}>
        <thead>
          <tr>
            <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid #1e293b", color: "#475569", fontWeight: 600 }}>Category</th>
            {cols.map((c) => (
              <th key={c.key} style={{ padding: "6px 10px", textAlign: "center", borderBottom: "1px solid #1e293b", color: "#475569", fontWeight: 600, minWidth: "70px" }}>
                {c.label || c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.key} style={{ background: ri % 2 === 0 ? "rgba(15,23,42,0.3)" : "transparent" }}>
              <td style={{ padding: "6px 10px", fontWeight: 600, color: "#cbd5e1" }}>{row.label || row.key}</td>
              {(row.values || []).map((val, ci) => {
                const colKey = cols[ci]?.key || "";
                const cellColor = STRENGTH_COLORS[colKey] || "#475569";
                return (
                  <td key={ci} style={{ padding: "6px 10px", textAlign: "center" }}>
                    {val > 0 ? (
                      <span style={{
                        display: "inline-block",
                        padding: "1px 8px",
                        borderRadius: "10px",
                        background: `${cellColor}22`,
                        color: cellColor,
                        fontWeight: 600,
                        fontSize: "0.78rem",
                      }}>{val}</span>
                    ) : (
                      <span style={{ color: "#334155" }}>—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildEvidenceGapTable(spec) {
  const rows = spec.chart_data?.rows || [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {rows.map((row, i) => (
        <div key={i} style={{
          padding:    "8px 12px",
          borderRadius:"6px",
          background: "rgba(239,68,68,0.07)",
          border:     "1px solid rgba(239,68,68,0.2)",
          fontSize:   "0.78rem",
          color:      "#fca5a5",
        }}>
          <span style={{ fontWeight: 600, color: "#f87171" }}>{row.label || row.key}: </span>
          {Array.isArray(row.values) ? row.values.join(" · ") : row.values}
        </div>
      ))}
      {rows.length === 0 && <div style={{ color: "#334155", fontSize: "0.78rem" }}>No evidence gaps found.</div>}
    </div>
  );
}

// ── Placeholder for unsupported types ──────────────────────────────────────────

function ChartPlaceholder({ chartType }) {
  return (
    <div style={{
      display:        "flex",
      alignItems:     "center",
      justifyContent: "center",
      height:         "100%",
      minHeight:      "120px",
      borderRadius:   "6px",
      border:         "1px dashed #1e293b",
      color:          "#334155",
      fontSize:       "0.75rem",
    }}>
      Chart type "{chartType}" not yet implemented
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────────

/**
 * @param {object}   spec         - visualization_spec object
 * @param {number}   [height=220] - chart height in px
 * @param {function} [onDrilldown]- callback(drilldownData) when user clicks chart element
 */
export function DashboardChart({ spec, height = 220, onDrilldown }) {
  if (!spec) return null;

  const { chart_type, visualization_type, title, caveat_if_any, confidence,
          insufficient_data, low_n, data_note } = spec;
  const type = chart_type || visualization_type || "bar";

  const handleEvents = {
    click: (params) => {
      if (!onDrilldown) return;
      const item = params.data?._raw || {};
      onDrilldown({
        type:        "chart_click",
        chart_id:    spec.visualization_id,
        clicked_key: params.name || params.data?._key || item.key || "",
        label:       params.name || "",
        source_ids:  item.source_ids || spec.interactive_drilldown?.linked_source_ids || [],
        evidence_ids:spec.interactive_drilldown?.linked_evidence_ids || [],
        analytics_evidence_ids: spec.supports_analytics_evidence_ids || [],
        chart_title: title || spec.visualization_id,
      });
    },
  };

  // ── Insufficient data guard ──────────────────────────────────────────────
  if (insufficient_data) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: "#475569", fontSize: "0.78rem" }}>
          <div style={{ fontSize: "1.2rem", marginBottom: "6px" }}>—</div>
          <div>{data_note || "Insufficient data for this period"}</div>
          {caveat_if_any && <div style={{ marginTop: "4px", color: "#334155", fontSize: "0.7rem" }}>{caveat_if_any}</div>}
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  let chart = null;

  if (type === "matrix_table") {
    chart = buildMatrixTable(spec);
  } else if (type === "evidence_gap_table" || type === "evidence_gap") {
    chart = buildEvidenceGapTable(spec);
  } else {
    let option = null;
    if      (type === "bar")          option = buildBar(spec);
    else if (type === "stacked_bar")  option = buildStackedBar(spec);
    else if (type === "funnel")       option = buildFunnel(spec);
    else if (type === "heatmap_table" || type === "heatmap") option = buildHeatmap(spec);
    else if (type === "line") {
      // Treat as bar for now
      option = buildStackedBar({ ...spec, chart_data: { ...spec.chart_data, stacks: [{ key: "value", label: title, values: spec.chart_data?.items?.map((i) => i.count) || [] }], months: spec.chart_data?.items?.map((i) => i.label) || [] } });
    }

    if (option) {
      chart = (
        <ReactECharts
          option={option}
          style={{ height: `${height - (caveat_if_any ? 28 : 0)}px`, width: "100%" }}
          onEvents={handleEvents}
          opts={{ renderer: "canvas" }}
        />
      );
    } else {
      chart = <ChartPlaceholder chartType={type} />;
    }
  }

  return (
    <div style={{ width: "100%", height: height + "px", display: "flex", flexDirection: "column" }}>
      {/* Confidence + low_n badges */}
      {(confidence || low_n) && (
        <div style={{ display: "flex", gap: "6px", marginBottom: "4px", alignItems: "center" }}>
          {confidence && (
            <span style={{
              fontSize: "0.65rem", padding: "1px 6px", borderRadius: "8px",
              background: `${confidenceColor(confidence)}22`, color: confidenceColor(confidence), fontWeight: 600,
            }}>
              {confidence} confidence
            </span>
          )}
          {low_n && (
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", padding: "1px 6px", borderRadius: "8px", background: "rgba(245,158,11,0.12)" }}>
              small sample
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {chart}
      </div>

      {/* Caveat */}
      {caveat_if_any && (
        <div style={{
          fontSize:   "0.68rem",
          color:      "#475569",
          marginTop:  "4px",
          fontStyle:  "italic",
          lineHeight: 1.4,
        }}>
          ⚠ {caveat_if_any}
        </div>
      )}
    </div>
  );
}
