/**
 * Visual Evidence — grid of visual evidence cards with usefulness ratings
 * and slide suitability classifications.
 */

import { useState } from "react";
import { VisualEvidenceCard } from "../../components/dashboard/VisualEvidenceCard.jsx";
import { VISUAL_EVIDENCE_ITEMS } from "../../mockData/dashboardData.js";

const SUITABILITY_FILTERS = ["all", "embed", "redraw", "cite", "manual_review", "reject"];
const SUITABILITY_LABELS  = { all: "All", embed: "Embed", redraw: "Redraw", cite: "Cite Only", manual_review: "Manual Review", reject: "Rejected" };

export function VisualsPage() {
  const [filter, setFilter] = useState("all");

  const filtered = VISUAL_EVIDENCE_ITEMS.filter((v) =>
    filter === "all" || v.slide_suitability === filter
  );

  function FilterBtn({ value }) {
    const isActive = filter === value;
    return (
      <button
        onClick={() => setFilter(value)}
        style={{
          padding:      "5px 12px",
          borderRadius: "16px",
          border:       isActive ? "1px solid #3b82f6" : "1px solid #1e293b",
          background:   isActive ? "rgba(37,99,235,0.2)" : "transparent",
          color:        isActive ? "#93c5fd" : "#64748b",
          cursor:       "pointer",
          fontSize:     "0.78rem",
          fontWeight:   isActive ? 600 : 400,
        }}
      >
        {SUITABILITY_LABELS[value]}
      </button>
    );
  }

  const embedCount        = VISUAL_EVIDENCE_ITEMS.filter((v) => v.slide_suitability === "embed").length;
  const redrawCount       = VISUAL_EVIDENCE_ITEMS.filter((v) => v.slide_suitability === "redraw").length;
  const manualReviewCount = VISUAL_EVIDENCE_ITEMS.filter((v) => v.slide_suitability === "manual_review").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Summary stats */}
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        {[
          { label: "Auto-embed", count: embedCount, color: "#4ade80" },
          { label: "Redraw",     count: redrawCount, color: "#60a5fa" },
          { label: "Manual review", count: manualReviewCount, color: "#c084fc" },
        ].map(({ label, count, color }) => (
          <div key={label} style={{
            padding:      "10px 16px",
            borderRadius: "8px",
            background:   "rgba(15,23,42,0.6)",
            border:       `1px solid ${color}33`,
            fontSize:     "0.82rem",
            color:        "#cbd5e1",
          }}>
            <span style={{ fontWeight: 700, color, marginRight: "6px" }}>{count}</span>
            {label}
          </div>
        ))}
      </div>

      {/* Filter row */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {SUITABILITY_FILTERS.map((f) => <FilterBtn key={f} value={f} />)}
      </div>

      {/* Slide suitability guide */}
      <details style={{ fontSize: "0.75rem", color: "#475569" }}>
        <summary style={{ cursor: "pointer", color: "#64748b" }}>Slide suitability definitions</summary>
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px", paddingLeft: "12px" }}>
          {[
            { k: "embed",         d: "Clear, analytically useful, readable at slide size — embed directly." },
            { k: "redraw",        d: "Data is valuable but image quality is poor or unreadable — redraw from source data." },
            { k: "cite",          d: "Provides context but not visually usable — cite as reference only." },
            { k: "manual_review", d: "Requires human judgment before use — may be misclassified or ambiguous." },
            { k: "reject",        d: "Decorative, misleading, or no analytical value — do not use." },
          ].map(({ k, d }) => (
            <div key={k} style={{ display: "flex", gap: "10px" }}>
              <code style={{ color: "#60a5fa", minWidth: "110px" }}>{k}</code>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Grid */}
      <div style={{
        display:             "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap:                 "12px",
      }}>
        {filtered.length === 0 && (
          <div style={{ color: "#334155", fontSize: "0.82rem", padding: "20px" }}>
            No visuals match this filter.
          </div>
        )}
        {filtered.map((item) => (
          <VisualEvidenceCard key={item.visual_id} item={item} />
        ))}
      </div>

      <div style={{ fontSize: "0.72rem", color: "#334155", paddingTop: "8px", borderTop: "1px solid #1e293b" }}>
        TODO: Wire to /api/visual-evidence. Images served from Vercel Blob. Screenshots pending web-evidence branch run.
      </div>
    </div>
  );
}
