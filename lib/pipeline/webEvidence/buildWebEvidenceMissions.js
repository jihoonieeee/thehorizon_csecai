/**
 * Layer 5C.2 — Build targeted missions from evidence needs.
 *
 * Maps each category's categorical need flags → controlled mission IDs. Missions
 * are gap-driven: a category that already has case studies will not get a
 * case-study mission. Domain-specific missions (MCP abuse, RAG/vector weakness,
 * supply chain) are added by domain.
 */

export const WEB_EVIDENCE_MISSIONS = [
  "major_incident_case_study", "attack_walkthrough", "recent_major_vulnerability",
  "new_attack_surface", "new_actor_adoption", "new_exploit_or_poc",
  "benchmark_or_dataset", "statistics_or_trend_data", "visual_evidence",
  "framework_or_taxonomy_visual", "defensive_bypass", "ai_enabled_operational_use",
  "agentic_tool_or_mcp_abuse", "rag_vector_embedding_weakness", "ai_supply_chain_compromise",
  "evidence_gap_case_study", "evidence_gap_visual", "evidence_gap_quantitative",
  "evidence_gap_operational", "evidence_gap_recent_development",
];
export const VALID_WEB_EVIDENCE_MISSIONS = new Set(WEB_EVIDENCE_MISSIONS);

// Mission metadata: does it seek a visual, and which source classes it favours.
const MISSION_META = {
  major_incident_case_study:   { visual: false, source_classes: ["incident_writeup", "vendor_research", "government_advisory"] },
  attack_walkthrough:          { visual: false, source_classes: ["technical_blog", "vendor_research", "github_poc", "research_paper"] },
  recent_major_vulnerability:  { visual: false, source_classes: ["vulnerability_database", "vendor_research", "government_advisory"] },
  new_attack_surface:          { visual: false, source_classes: ["research_paper", "technical_blog", "vendor_research"] },
  new_actor_adoption:          { visual: false, source_classes: ["vendor_research", "government_advisory", "incident_writeup"] },
  new_exploit_or_poc:          { visual: false, source_classes: ["github_poc", "technical_blog", "vendor_research"] },
  benchmark_or_dataset:        { visual: false, source_classes: ["benchmark_dataset", "research_paper", "conference_paper"] },
  statistics_or_trend_data:    { visual: false, source_classes: ["vendor_research", "government_advisory", "research_paper"] },
  visual_evidence:             { visual: true,  source_classes: ["vendor_research", "research_paper", "technical_blog"] },
  framework_or_taxonomy_visual:{ visual: true,  source_classes: ["standards_or_framework", "research_paper"] },
  defensive_bypass:            { visual: false, source_classes: ["research_paper", "technical_blog", "vendor_research"] },
  ai_enabled_operational_use:  { visual: false, source_classes: ["vendor_research", "government_advisory", "incident_writeup"] },
  agentic_tool_or_mcp_abuse:   { visual: false, source_classes: ["technical_blog", "github_poc", "vendor_research"] },
  rag_vector_embedding_weakness:{ visual: false, source_classes: ["research_paper", "technical_blog"] },
  ai_supply_chain_compromise:  { visual: false, source_classes: ["vendor_research", "research_paper", "vulnerability_database"] },
  evidence_gap_case_study:     { visual: false, source_classes: ["incident_writeup", "vendor_research"] },
  evidence_gap_visual:         { visual: true,  source_classes: ["vendor_research", "research_paper"] },
  evidence_gap_quantitative:   { visual: false, source_classes: ["benchmark_dataset", "research_paper", "vendor_research"] },
  evidence_gap_operational:    { visual: false, source_classes: ["incident_writeup", "vendor_research", "government_advisory"] },
  evidence_gap_recent_development:{ visual: false, source_classes: ["vendor_research", "technical_blog", "research_paper"] },
};

export function missionMeta(mission) { return MISSION_META[mission] || { visual: false, source_classes: ["vendor_research"] }; }

const DOMAIN_MISSIONS = {
  agentic_ai_threats: ["agentic_tool_or_mcp_abuse", "ai_supply_chain_compromise"],
  llm_threats:        ["rag_vector_embedding_weakness", "defensive_bypass", "ai_supply_chain_compromise"],
  traditional_ai_threats: ["ai_supply_chain_compromise"],
  ai_enabled_threats: ["ai_enabled_operational_use"],
};

/**
 * @param {object[]} needsList  output of buildWebEvidenceNeeds
 * @returns {object[]} missions: { mission, category, visual, source_classes, taxonomy_tags, trigger }
 */
export function buildWebEvidenceMissions(needsList = []) {
  const missions = [];
  const add = (mission, category, trigger, taxonomy_tags) => {
    const meta = missionMeta(mission);
    missions.push({ mission, category, visual: meta.visual, source_classes: meta.source_classes, taxonomy_tags: taxonomy_tags || [], trigger });
  };

  for (const n of needsList) {
    if (!n.has_gaps) continue;
    const cat = n.category;
    const tags = n.taxonomy_gaps;

    if (n.needs.case_study)   { add("major_incident_case_study", cat, "no_case_study", tags); add("evidence_gap_case_study", cat, "no_case_study", tags); }
    if (n.needs.walkthrough)  add("attack_walkthrough", cat, "no_walkthrough", tags);
    if (n.needs.quantitative) { add("benchmark_or_dataset", cat, "no_quantitative", tags); add("statistics_or_trend_data", cat, "no_quantitative", tags); add("evidence_gap_quantitative", cat, "no_quantitative", tags); }
    if (n.needs.visual)       { add("visual_evidence", cat, "no_visual", tags); add("framework_or_taxonomy_visual", cat, "no_visual", tags); add("evidence_gap_visual", cat, "no_visual", tags); }
    if (n.needs.operational)  { add("recent_major_vulnerability", cat, "no_operational", tags); add("evidence_gap_operational", cat, "no_operational", tags); }
    if (n.needs.recent)       add("evidence_gap_recent_development", cat, "no_recent", tags);
    if (n.needs.weak_overall) add("new_exploit_or_poc", cat, "weak_overall", tags);
    if (n.needs.early_signal_thin) { add("new_attack_surface", cat, "early_signal_thin", tags); add("new_actor_adoption", cat, "early_signal_thin", tags); }

    // Domain-specific missions whenever the category has any gap.
    for (const m of (DOMAIN_MISSIONS[cat] || [])) add(m, cat, "domain_default", tags);
  }

  // De-dup by (mission, category).
  const seen = new Set();
  return missions.filter((m) => {
    const k = `${m.mission}:${m.category}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
