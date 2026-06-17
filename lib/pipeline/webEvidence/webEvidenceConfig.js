/**
 * Layer 5C — Web Evidence Branch configuration.
 *
 * 5C is the pipeline's single external-evidence branch (it absorbed the retired
 * Layer 5E statistics search). It is **disabled by default** and must be opted in
 * via `WEB_EVIDENCE_ENABLED=1`. A Tavily/SerpAPI key alone does not enable it —
 * those keys may be present for Layer 1B web discovery without intending to run
 * the more expensive L5C gap-driven evidence search on every synthesis run.
 * Every heavy capability (screenshots, frontier QA, Gemini grounding, Claude web)
 * remains independently toggleable.
 */

function bool(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function isSet(name) {
  const v = process.env[name];
  return v != null && v !== "";
}

function int(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

// A web-search provider must be configured for 5C to do anything.
export function hasSearchProvider() {
  return !!(
    process.env.TAVILY_API_KEY  || process.env.TAVILY_API_KEY_2 ||
    process.env.TAVILY_API_KEY_3 || process.env.TAVILY_API_KEY_4 ||
    process.env.SERPAPI_API_KEY
  );
}

export function getWebEvidenceConfig() {
  return {
    // WEB_EVIDENCE_ENABLED=1 is required to enable; default is off.
    // Provider keys alone (Tavily/SerpAPI) no longer auto-enable — they may exist
    // for Layer 1B web discovery without intending to run the full L5C branch.
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
