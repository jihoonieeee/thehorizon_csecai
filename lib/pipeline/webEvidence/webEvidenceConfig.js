/**
 * Layer 5C — Web Evidence Branch configuration.
 *
 * All env flags + budgets in one place. The branch is OFF by default
 * (WEB_EVIDENCE_ENABLED=false) and every heavy capability (screenshots, frontier
 * QA, Gemini grounding, Claude web) is independently toggleable, so the branch is
 * fully disable-able and degrades gracefully when libraries/keys are absent.
 */

function bool(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

export function getWebEvidenceConfig() {
  return {
    enabled: bool("WEB_EVIDENCE_ENABLED", false),

    // ── Provider rotation ────────────────────────────────────────────────────
    provider_order: (process.env.WEB_EVIDENCE_SEARCH_PROVIDER_ORDER ||
      "tavily,serpapi,specialized,gemini_grounding,claude_web")
      .split(",").map((s) => s.trim()).filter(Boolean),
    tavily_enabled:          bool("WEB_EVIDENCE_TAVILY_ENABLED", true),
    serpapi_enabled:         bool("WEB_EVIDENCE_SERPAPI_ENABLED", true),
    gemini_grounding_enabled: bool("WEB_EVIDENCE_GEMINI_GROUNDING_ENABLED", false),
    claude_web_enabled:      bool("WEB_EVIDENCE_CLAUDE_WEB_ENABLED", false),

    // ── Crawl / opening budgets ──────────────────────────────────────────────
    max_trace_depth:              int("WEB_EVIDENCE_MAX_TRACE_DEPTH", 2),
    max_queries_per_category:     int("WEB_EVIDENCE_MAX_QUERIES_PER_CATEGORY", 8),
    max_opened_urls:              int("WEB_EVIDENCE_MAX_OPENED_URLS", 60),
    max_opened_urls_per_mission:  int("WEB_EVIDENCE_MAX_OPENED_URLS_PER_MISSION", 6),
    max_visuals_per_category:     int("WEB_EVIDENCE_MAX_VISUALS_PER_CATEGORY", 8),
    max_visuals_per_source:       int("WEB_EVIDENCE_MAX_VISUALS_PER_SOURCE", 4),
    max_pdf_screenshots:          int("WEB_EVIDENCE_MAX_PDF_SCREENSHOTS", 6),
    max_screenshots_per_source:   int("WEB_EVIDENCE_MAX_SCREENSHOTS_PER_SOURCE", 3),
    max_final_evidence_per_category: int("WEB_EVIDENCE_MAX_FINAL_EVIDENCE_PER_CATEGORY", 5),
    max_final_visuals_per_category:  int("WEB_EVIDENCE_MAX_FINAL_VISUALS_PER_CATEGORY", 3),
    max_hero_visuals_per_category:   int("WEB_EVIDENCE_MAX_HERO_VISUALS_PER_CATEGORY", 1),
    max_frontier_qa_visuals:      int("WEB_EVIDENCE_MAX_FRONTIER_QA_VISUALS", 6),

    // ── Capability toggles ───────────────────────────────────────────────────
    screenshot_enabled:  bool("WEB_EVIDENCE_SCREENSHOT_ENABLED", true),
    frontier_qa_enabled: bool("WEB_EVIDENCE_FRONTIER_QA_ENABLED", true),

    // ── Cache dir ────────────────────────────────────────────────────────────
    cache_dir: process.env.WEB_EVIDENCE_CACHE_DIR ||
      `${process.cwd()}/.cache/web_evidence`,
  };
}

// Opening priority: lower number = open first.
export const OPENING_PRIORITY = {
  government_advisory:    1,
  primary_vendor_report:  1,
  standards_or_framework: 1,
  research_paper:         2,
  conference_paper:       2,
  incident_writeup:       3,
  vendor_research:        3,
  github_poc:             4,
  benchmark_dataset:      4,
  vulnerability_database: 4,
  technical_blog:         5,
  visual_or_pdf_candidate:6,
  news_report:            7,
  unknown:                8,
};

export function openingPriorityOf(sourceClass) {
  return OPENING_PRIORITY[sourceClass] ?? OPENING_PRIORITY.unknown;
}
