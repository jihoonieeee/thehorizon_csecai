/**
 * Evidence Explorer — filterable list of evidence items with source quotes,
 * validation badges, and taxonomy tags.
 */

import { useState } from "react";
import { EvidenceCard } from "../../components/dashboard/EvidenceCard.jsx";
import { StatusBadge }  from "../../components/dashboard/StatusBadge.jsx";
import { EVIDENCE_ITEMS } from "../../mockData/dashboardData.js";

const STRENGTH_ORDER = { strong: 0, usable: 1, context: 2, archive: 3 };
const CATEGORIES = ["all", "llm_threats", "agentic_ai_threats", "traditional_ai_threats", "ai_enabled_threats"];
const STRENGTHS  = ["all", "strong", "usable", "context"];

export function EvidencePage() {
  const [catFilter,    setCatFilter]    = useState("all");
  const [strFilter,    setStrFilter]    = useState("all");
  const [searchQuery,  setSearchQuery]  = useState("");

  const filtered = EVIDENCE_ITEMS
    .filter((e) => catFilter    === "all" || e.category === catFilter)
    .filter((e) => strFilter    === "all" || e.evidence_strength === strFilter)
    .filter((e) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        e.title?.toLowerCase().includes(q) ||
        e.fact?.toLowerCase().includes(q)  ||
        e.publisher?.toLowerCase().includes(q) ||
        (e.entities || []).some((en) => en.toLowerCase().includes(q))
      );
    })
    .sort((a, b) =>
      (STRENGTH_ORDER[a.evidence_strength] ?? 3) - (STRENGTH_ORDER[b.evidence_strength] ?? 3)
    );

  function FilterButton({ value, current, onSelect, label }) {
    return (
      <button
        onClick={() => onSelect(value)}
        style={{
          padding:      "5px 12px",
          borderRadius: "16px",
          border:       current === value ? "1px solid #3b82f6" : "1px solid #1e293b",
          background:   current === value ? "rgba(37,99,235,0.2)" : "transparent",
          color:        current === value ? "#93c5fd" : "#64748b",
          cursor:       "pointer",
          fontSize:     "0.78rem",
          fontWeight:   current === value ? 600 : 400,
          transition:   "all 0.15s",
        }}
      >
        {label || value}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Filter row */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search evidence by keyword, publisher, or entity…"
          style={{
            padding:      "9px 14px",
            borderRadius: "8px",
            border:       "1px solid #334155",
            background:   "#0f172a",
            color:        "#e2e8f0",
            fontSize:     "0.85rem",
            outline:      "none",
          }}
        />
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: "#475569", alignSelf: "center" }}>Category:</span>
          {CATEGORIES.map((c) => (
            <FilterButton key={c} value={c} current={catFilter} onSelect={setCatFilter}
              label={c === "all" ? "All" : c.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())} />
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: "#475569", alignSelf: "center" }}>Strength:</span>
          {STRENGTHS.map((s) => (
            <FilterButton key={s} value={s} current={strFilter} onSelect={setStrFilter}
              label={s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)} />
          ))}
        </div>
      </div>

      {/* Results count */}
      <div style={{ fontSize: "0.78rem", color: "#475569" }}>
        {filtered.length} evidence item{filtered.length !== 1 ? "s" : ""} shown
        <span style={{ marginLeft: "8px", color: "#334155" }}>(mock data — wire to /api/evidence for real results)</span>
      </div>

      {/* Evidence cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {filtered.length === 0 && (
          <div style={{ color: "#334155", fontSize: "0.82rem", textAlign: "center", padding: "30px" }}>
            No evidence items match your filters.
          </div>
        )}
        {filtered.map((item) => (
          <EvidenceCard key={item.evidence_id} item={item} />
        ))}
      </div>

      <div style={{ fontSize: "0.72rem", color: "#334155", paddingTop: "8px", borderTop: "1px solid #1e293b" }}>
        TODO: Wire to GET /api/evidence with category/strength/search query params.
        Pagination needed for large corpora.
      </div>
    </div>
  );
}
