/**
 * v2 — understandSource()
 *
 * Replaces the combined L3 (13-file validation) + L4 (49K understandSource)
 * with a single structured LLM call per source.
 *
 * One call does everything:
 *   - AI-threat relevance gate (replaces aiRelevance.js 22K)
 *   - Source typing (replaces sourceTyping.js 13K)
 *   - Trust tier (replaces trustAssessment.js 12K)
 *   - Taxonomy assignment — category + primary_tags + sub_techniques
 *   - Entity / claim / number extraction
 *   - Short summary
 *
 * Irrelevant sources are returned with { relevant: false } and discarded
 * by the caller. No further processing.
 *
 * Model: Anthropic Haiku (primary), Gemini Flash (fallback). One call ≈ 500-1000 tokens.
 */

import { routedLLM }              from "../../llm/llmRouter.js";
import { callLLM }                from "../../llm/callLLM.js";
import {
  DOMAINS, SOURCE_TYPES, TRUST_TIERS, DEFENSIVE_FOCUS_AREAS,
  isValidTag, domainOfTag,
} from "./taxonomy.js";
import { deterministicMaturity } from "../scoring/maturityLevel.js";
import { detectDigest }          from "../ingest/detectDigest.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { classifySourceFamily }  from "./classifySourceFamily.js";

const UNDERSTAND_VERSION = "v2.0";

// ── Deterministic pre-screen (H1) ─────────────────────────────────────────────
// Applied before the LLM call to mirror the hard-reject gates that v1 Layer 3
// (sourceValidity.js + finalGate.js) would apply. Saves LLM tokens and prevents
// PR-wire noise, private-host URLs, stale content, and non-English sources from
// reaching synthesis unchallenged.

const PR_DENY_DOMAINS = new Set([
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  "accesswire.com", "einpresswire.com", "prlog.org",
  "pitchengine.com", "prweb.com", "newswire.com", "cision.com",
]);

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const STALE_YEARS     = 6;

const EN_STOPWORDS = new Set([
  "the","and","is","in","of","to","a","that","it","with","as","for","on",
  "are","by","this","be","was","from","but","not","or","an","have","they",
]);
const NON_EN_STOPWORDS = {
  es: ["el","la","los","las","un","una","de","en","y","que","es","por","con"],
  fr: ["le","la","les","un","une","de","du","des","en","et","que","qui","est"],
  de: ["der","die","das","ein","eine","und","ist","in","von","mit","zu","den"],
};

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function deterministicPreScreen(source) {
  const url   = source.url || "";
  const text  = source.full_text || source.clean_text || source.summary || "";
  const trust = source.trust_tier || "unknown";
  const isTrusted = ["primary", "high"].includes(trust);

  // Short text
  if (text.length < 50) return { pass: false, reason: "text_too_short" };

  // HTTPS-only (allow missing URL — it will be flagged by other validators)
  if (url && !url.startsWith("https://")) return { pass: false, reason: "url_not_https" };

  // Private / localhost hosts
  const domain = domainOf(url);
  if (domain && PRIVATE_HOST_RE.test(domain)) return { pass: false, reason: "private_host" };

  // PR-wire deny list (skip for trusted sources — they might syndicate via PR wires)
  if (!isTrusted && domain && PR_DENY_DOMAINS.has(domain)) {
    return { pass: false, reason: "pr_wire_deny_list" };
  }

  // Stale date for non-trusted sources
  if (!isTrusted && source.date_published) {
    const pubYear = parseInt(source.date_published.slice(0, 4), 10);
    if (!isNaN(pubYear) && new Date().getFullYear() - pubYear > STALE_YEARS) {
      return { pass: false, reason: `stale_date_${pubYear}` };
    }
  }

  // Non-English detection via stopword frequency (skip trusted sources)
  if (!isTrusted) {
    const sample = text.slice(0, 500).toLowerCase();
    const words  = sample.match(/\b[a-zA-ZÀ-ÿ]{2,}\b/g) || [];
    if (words.length >= 30) {
      const enRatio = words.filter(w => EN_STOPWORDS.has(w)).length / words.length;
      for (const [lang, stops] of Object.entries(NON_EN_STOPWORDS)) {
        const ratio = words.filter(w => stops.includes(w)).length / words.length;
        if (ratio > 0.08 && enRatio < 0.05) {
          return { pass: false, reason: `non_english_${lang}` };
        }
      }
    }
  }

  return { pass: true };
}

// ── JSON schema for structured output ─────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    // Scope verdict from the LLM — determines keep/discard:
    //   offensive_finding — a concrete attack/vuln/incident in an offensive domain → KEEP
    //   adjacent_context  — governance/standards/context — out of scope → DISCARD
    //   off_topic         — not AI cyber-security, or marketing/thin/physical-world → DISCARD
    scope: { type: "string", enum: ["offensive_finding", "adjacent_context", "off_topic"] },
    rejection_reason: { type: "string" },
    // ── Taxonomy assignment (the LLM's judgment; validated against the registry) ─
    // The LLM assigns the category + tag DIRECTLY using the definitions and
    // boundary rules in classify.md. normalise() then validates: main_category
    // must be a known domain, and primary_tag must exist AND belong to it.
    main_category:      { type: "string", enum: DOMAINS },
    primary_tag:        { type: "string" },
    secondary_tags:     { type: "array", items: { type: "string" } },
    boundary_rationale: { type: "string" },
    // ── Extraction ───────────────────────────────────────────────────────────
    ai_enabled_overlay: { type: "boolean" },
    source_type: { type: "string", enum: SOURCE_TYPES },
    trust_tier: { type: "string", enum: TRUST_TIERS },
    key_entities: { type: "array", items: { type: "string" } },
    short_summary: { type: "string" },
    event_date: { type: "string" },
    event_date_confidence: { type: "string", enum: ["exact", "approximate", "unknown"] },
    is_defensive: { type: "boolean" },
    defended_category: { type: "string", enum: [...DOMAINS, "unclear_or_adjacent"] },
    defensive_techniques: { type: "array", items: { type: "string", enum: DEFENSIVE_FOCUS_AREAS } },
  },
  required: ["relevant", "scope", "main_category", "primary_tag", "source_type", "trust_tier", "short_summary", "is_defensive"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  // The full, self-contained taxonomy + boundary prompt lives in
  // lib/prompts/understand/classify.md — no runtime interpolation needed.
  return loadPrompt("understand/classify").system;
}

// ── Per-source prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const { user } = loadPrompt("understand/classify");
  const text = (source.full_text || source.clean_text || source.summary || "").slice(0, 6000);
  const { is_digest } = detectDigest(source);
  const digestNote = is_digest
    ? "\n\nNOTE: This source has been identified as a multi-topic digest or landscape report. It covers multiple distinct AI-security findings across potentially different threat categories. Use secondary_tags to capture all distinct threat domains covered. Do NOT collapse all findings into a single primary_tag if they span multiple categories — pick the most significant as primary and record the rest as secondary."
    : "";
  return interpolate(user, {
    title:     source.title         || "untitled",
    publisher: source.publisher     || "unknown",
    url:       source.url           || "none",
    date:      source.date_published || "unknown",
    text:      text                 || "(no text available — classify from title/URL only)",
  }) + digestNote;
}

// ── Post-call validation and normalisation ────────────────────────────────────

/**
 * Recursively search an object for the first value matching any of the given keys.
 * Breadth-first by key at each level, then depth-first into values.
 * Stops at the first match so shallow fields win over deep ones.
 * Skips arrays to avoid matching items inside array elements accidentally.
 */
function deepGet(obj, ...names) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  for (const name of names) {
    if (name in obj) return obj[name];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = deepGet(v, ...names);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Flatten an arbitrarily nested LLM response into the expected flat shape.
 *
 * Anthropic models routinely invent creative nesting structures depending on
 * the system prompt and model version. Rather than enumerating every pattern,
 * we use deepGet() to find each field wherever it lives in the object tree.
 */
function flattenRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    relevant:             deepGet(raw, "relevant", "is_relevant", "isRelevant"),
    scope:                deepGet(raw, "scope", "scope_disposition", "relevance_scope"),
    rejection_reason:     deepGet(raw, "rejection_reason", "reason", "irrelevance_reason"),
    category:             deepGet(raw, "category", "threat_category", "domain", "primary_category"),  // skipLlm stub / back-compat only
    // ── Taxonomy assignment (LLM-assigned; validated in normalise) ─────────────
    main_category:      deepGet(raw, "main_category", "category", "threat_category", "domain", "primary_category"),
    primary_tag:        deepGet(raw, "primary_tag", "taxonomy_tag", "tag", "primary_taxonomy"),
    secondary_tags:     deepGet(raw, "secondary_tags", "secondary_taxonomy_suggestions", "additional_tags"),
    boundary_rationale: deepGet(raw, "boundary_rationale", "category_rationale", "rationale"),
    // ── Extraction ────────────────────────────────────────────────────────────
    ai_enabled_overlay:   deepGet(raw, "ai_enabled_overlay", "ai_enabled", "ai_enabled_as_weapon"),
    source_type:          deepGet(raw, "source_type", "type", "content_type", "source_category"),
    trust_tier:           deepGet(raw, "trust_tier", "trust", "publisher_tier", "credibility_tier"),
    key_entities:         deepGet(raw, "key_entities", "entities", "named_entities", "actors", "entity_list"),
    short_summary:        deepGet(raw, "short_summary", "summary", "description", "analysis_summary", "technical_summary"),
    event_date:           deepGet(raw, "event_date", "incident_date", "occurrence_date"),
    event_date_confidence:deepGet(raw, "event_date_confidence", "date_confidence"),
    is_defensive:         deepGet(raw, "is_defensive", "defensive", "is_primarily_defensive"),
    defended_category:    deepGet(raw, "defended_category", "defended_domain", "defensive_category"),
    defensive_techniques: deepGet(raw, "defensive_techniques", "defense_techniques", "mitigation_types"),
  };
}

const VALID_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

export function normalise(raw, source, opts = {}) {
  if (!raw || typeof raw !== "object") {
    return { relevant: false, rejection_reason: "LLM returned non-object", _understand_version: UNDERSTAND_VERSION };
  }

  const flat = flattenRaw(raw);

  // ── LLM-assigned taxonomy (validated against the registry) ──────────────────
  // The LLM now assigns main_category + primary_tag DIRECTLY, using the taxonomy
  // definitions + boundary rules in classify.md. We validate rather than derive:
  //   • main_category must be a known domain (else → unclear_or_adjacent),
  //   • primary_tag must EXIST and BELONG to main_category (else it is dropped and
  //     a guardrail_flag is recorded so qaClassification can catch the mismatch).
  // No mechanism-first indirection, no deterministic mapper.
  let resolvedCategory, primaryTag, validatedTags, guardrailFlag = null;
  if (opts.skipLlm) {
    // Dry-run stub: preserve the source's existing category, assign no tags.
    resolvedCategory = DOMAINS.includes(flat.category) ? flat.category : "unclear_or_adjacent";
    primaryTag = null;
    validatedTags = [];
  } else {
    resolvedCategory = DOMAINS.includes(flat.main_category) ? flat.main_category : "unclear_or_adjacent";

    const rawPrimary = typeof flat.primary_tag === "string" ? flat.primary_tag.trim() : null;
    if (rawPrimary && isValidTag(rawPrimary) && domainOfTag(rawPrimary) === resolvedCategory) {
      primaryTag = rawPrimary;
    } else {
      primaryTag = null;
      if (rawPrimary && resolvedCategory !== "unclear_or_adjacent") {
        guardrailFlag = isValidTag(rawPrimary)
          ? `tag_domain_mismatch:${rawPrimary}(${domainOfTag(rawPrimary)})!=${resolvedCategory}`
          : `unknown_tag:${rawPrimary}`;
      }
    }

    // Keep only valid secondary tags; a secondary that belongs to a different
    // domain is allowed (a source can touch a neighbouring technique).
    const secondary = (Array.isArray(flat.secondary_tags) ? flat.secondary_tags : [])
      .map(t => String(t || "").trim())
      .filter(t => t && isValidTag(t) && t !== primaryTag);
    validatedTags = primaryTag ? [primaryTag, ...secondary] : secondary;
  }

  // ── Disposition (keep/discard) ───────────────────────────────────────────────
  // A source is kept only if the LLM placed it in a real offensive domain with
  // scope=offensive_finding. Everything else — off_topic, defensive, adjacent
  // context, unclear_or_adjacent — is discarded.
  const landedReal = VALID_CATEGORIES.has(resolvedCategory);
  const llmScope   = ["offensive_finding", "adjacent_context", "off_topic"].includes(flat.scope) ? flat.scope : null;

  let disposition;
  if (opts.skipLlm) {
    disposition = Boolean(flat.relevant) ? "offensive" : "off_topic";
  } else if (landedReal && llmScope !== "off_topic" && llmScope !== "adjacent_context" && flat.relevant !== false) {
    disposition = "offensive";
  } else if (landedReal && llmScope === null && flat.relevant !== false) {
    // Back-compat: model placed it in an offensive domain but omitted `scope`.
    disposition = "offensive";
  } else {
    disposition = "off_topic";
  }

  // ── Defensive invariant ──────────────────────────────────────────────────────
  // is_defensive, the "defensive" tag, and source_type="defensive_capability" are
  // three views of the SAME fact. Derive it from ANY signal (LLM flag or type).
  const isDefensive = Boolean(flat.is_defensive)
    || flat.source_type === "defensive_capability";
  const llmDefended = DOMAINS.includes(flat.defended_category) ? flat.defended_category : null;

  // Defensive sources are out of scope for an offensive threat intelligence corpus.
  if (isDefensive) {
    disposition = "off_topic";
  }

  // Category resolution: offensive sources keep their domain; everything else discarded.
  const finalCategory  = disposition === "offensive" ? resolvedCategory : "unclear_or_adjacent";
  const finalRelevant  = disposition === "offensive";
  const finalKeep      = disposition === "offensive";
  const finalRejection = finalKeep ? null : (flat.rejection_reason || null);

  const defendedCat = isDefensive
    ? (llmDefended || (DOMAINS.includes(finalCategory) ? finalCategory : null))
    : null;
  const defensiveTechs = isDefensive && Array.isArray(flat.defensive_techniques)
    ? flat.defensive_techniques.filter(t => DEFENSIVE_FOCUS_AREAS.includes(t)).slice(0, 3)
    : [];

  // Append "defensive" to tags so it's persisted in the tags column.
  const finalTags = isDefensive
    ? [...new Set([...validatedTags, "defensive"])]
    : validatedTags;

  // Taxonomy-classification record (stored in intelligence jsonb; drives the
  // debug report + qaClassification cross-check). Kept under the legacy
  // `mechanism_classification` key so existing readers (importance.js reads
  // .is_defensive; api/sources.js) keep working without changes.
  const mechanism_classification = {
    schema:             "taxonomy-v2",
    assigned_by:        "llm",
    main_category:      resolvedCategory,
    primary_tag:        primaryTag,
    secondary_tags:     validatedTags.filter(t => t !== primaryTag),
    boundary_rationale: typeof flat.boundary_rationale === "string" ? flat.boundary_rationale.trim().slice(0, 300) : null,
    is_defensive:       isDefensive,
    guardrail_flag:     guardrailFlag,     // set when the LLM's tag was invalid or off-domain
  };

  // Guard short_summary against stringified-object leaks.
  let safeSummary = typeof flat.short_summary === "string" ? flat.short_summary : "";
  if (safeSummary === "[object Object]") safeSummary = "";

  // event_date: only accept YYYY-MM-DD strings; reject anything else silently.
  const rawEventDate = typeof flat.event_date === "string" ? flat.event_date.trim() : null;
  const safeEventDate = rawEventDate && /^\d{4}-\d{2}-\d{2}$/.test(rawEventDate) ? rawEventDate : null;
  const EVENT_DATE_CONFIDENCES = ["exact", "approximate", "unknown"];
  const safeEventDateConf = EVENT_DATE_CONFIDENCES.includes(flat.event_date_confidence) ? flat.event_date_confidence : null;

  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published:source.date_published,
    full_text:     source.full_text || source.clean_text || "",

    relevant:         finalRelevant,
    disposition:      disposition,   // "offensive" | "off_topic"
    keep:             finalKeep,      // offensive + adjacent are retained; off_topic discarded
    rejection_reason: finalRejection,
    category:         finalCategory,
    primary_tags:     finalTags,
    sub_techniques:   [],
    ai_enabled_overlay: Boolean(flat.ai_enabled_overlay),
    source_type:      SOURCE_TYPES.includes(flat.source_type) ? flat.source_type : "unknown",
    trust_tier:       TRUST_TIERS.includes(flat.trust_tier) ? flat.trust_tier : "unknown",
    key_entities:     (Array.isArray(flat.key_entities) ? flat.key_entities : []).slice(0, 10),
    short_summary:    safeSummary.slice(0, 600),
    event_date:       safeEventDate,
    event_date_confidence: safeEventDateConf,
    is_defensive:     isDefensive,
    defended_category: defendedCat,
    defensive_techniques: defensiveTechs,
    mechanism_classification: mechanism_classification,
    _understand_version: UNDERSTAND_VERSION,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Understand a single source. Returns a normalised understanding object.
 * Returns { relevant: false } for irrelevant sources — caller should discard.
 *
 * @param {object} source   - Raw source from DB or connector
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm=false]  - Return deterministic stub
 * @returns {Promise<object>}
 */
// ── Date recovery helpers ─────────────────────────────────────────────────────
// Used when a source arrives with no date_published. Attempts lightweight HTTP
// scrape before the LLM call; stores the recovered date on the source object so
// downstream write-back persists it to the DB.

const _MONTH_NAMES  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const _MONTH_MAP    = Object.fromEntries(_MONTH_NAMES.map((m,i)=>[m, String(i+1).padStart(2,"0")]));
const _MONTH_RE     = new RegExp(`(${_MONTH_NAMES.join("|")})\\s+(\\d{1,2}),?\\s+(20\\d\\d)`);
const _META_DATE_REs = [
  /<meta[^>]+property=["'](?:article:published_time|og:article:published_time)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:article:published_time|og:article:published_time)["']/i,
  /"datePublished"\s*:\s*"(202[0-9][^"]+)"/,
  /<meta[^>]+name=["'](?:DC\.date|date)["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  /itemprop=["']datePublished["'][^>]*(?:datetime|content)=["']([^"']+)["']/i,
];

async function recoverDateFromPage(url) {
  if (!url || !url.startsWith("https://")) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res   = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HorizonScanner/2.0)", Accept: "text/html" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // Read only first 40KB — dates are always in the <head> or early body
    const reader = res.body?.getReader();
    if (!reader) return null;
    let html = "";
    while (html.length < 40000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});

    // 1. Structured meta/JSON-LD
    const today = new Date().toISOString().slice(0,10);
    for (const re of _META_DATE_REs) {
      const m = re.exec(html);
      if (m?.[1]) {
        const d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          const iso = d.toISOString().slice(0,10);
          if (iso >= "2010-01-01" && iso <= today) return iso;
        }
      }
    }
    // 2. First month-spelled date in visible text
    const m2 = _MONTH_RE.exec(html);
    if (m2) {
      const iso = `${m2[3]}-${_MONTH_MAP[m2[1]]}-${m2[2].padStart(2,"0")}`;
      if (iso >= "2010-01-01" && iso <= today) return iso;
    }
  } catch { /* timeout or network error — silently skip */ }
  return null;
}

export async function understandSource(source, opts = {}) {
  // H0: Date recovery — if source has no date, attempt a lightweight page scrape
  // before anything else. Recovered date is attached to the source object so the
  // write-back in understandAllSources persists it to the DB.
  if (!opts.skipLlm && !source.date_published && source.url) {
    const recovered = await recoverDateFromPage(source.url);
    if (recovered) {
      source = { ...source, date_published: recovered, date_confidence: "exact" };
    }
  }

  // H1: Deterministic pre-screen before spending an LLM call.
  // skipLlm bypasses this — dry-run mode should accept everything.
  if (!opts.skipLlm) {
    const screen = deterministicPreScreen(source);
    if (!screen.pass) {
      const failResult = normalise({
        relevant: false,
        rejection_reason: screen.reason,
        category: "unclear_or_adjacent",
        source_type: source.source_type || "unknown",
        trust_tier: source.trust_tier || "unknown",
        primary_tags: [], sub_techniques: [], key_entities: [],
        short_summary: "",
      }, source);
      failResult.source_family = classifySourceFamily({ ...source, ...failResult });
      return failResult;
    }
  }

  if (opts.skipLlm) {
    // Deterministic stub: accept everything, assign unclear.
    // skipLlm=true bypasses the AE gate — tags are not assigned in dry-run mode.
    const understood = normalise({
      relevant: true,
      category: source.main_category || "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      primary_tags: [],
      sub_techniques: [],
      key_entities: [],
      short_summary: (source.summary || source.title || "").slice(0, 200),
    }, source, { skipLlm: true });
    understood.source_family = classifySourceFamily({ ...source, ...understood });
    return understood;
  }

  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(source);

  try {
    // Try routedLLM first (task-aware model selection)
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "source_understanding",
        requires_json: true,
        schema: OUTPUT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      // Fallback to legacy callLLM
      const text = await callLLM(sys, usr, { schema: OUTPUT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    const understood = normalise(raw, source);
    understood.source_family = classifySourceFamily({ ...source, ...understood });
    return understood;
  } catch (err) {
    const understood = normalise({
      relevant: false,
      rejection_reason: `LLM error: ${err.message}`,
      category: "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      short_summary: "",
    }, source);
    understood.source_family = classifySourceFamily({ ...source, ...understood });
    return understood;
  }
}

/**
 * Reconstitute a previously-understood source from its DB row.
 * Avoids re-running the LLM when the source was already classified.
 */
function fromDbRow(source) {
  // Restore defensive state from ANY of the three signals (flag / tag / type) so a
  // cached row whose intelligence.is_defensive was lost (older classifier versions,
  // overwritten jsonb) is still recognised as defensive and re-synced on re-run.
  const tags = source.tags || [];
  const isDef = source.intelligence?.is_defensive === true
    || tags.map(t => String(t).toLowerCase()).includes("defensive")
    || source.source_type === "defensive_capability";
  const isOffensive = !isDef && VALID_CATEGORIES.has(source.main_category);
  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published: source.date_published,
    full_text:     source.full_text || source.clean_text || "",
    relevant:      isOffensive,
    disposition:   isOffensive ? "offensive" : "off_topic",
    keep:          isOffensive,
    rejection_reason: null,
    category:      source.main_category,
    primary_tags:  isDef ? [...new Set([...tags, "defensive"])] : tags,
    sub_techniques: [],
    ai_enabled_overlay: false,
    source_type:   source.source_type || "unknown",
    trust_tier:    source.trust_tier  || "unknown",
    key_entities:  source.intelligence?.key_entities || [],
    short_summary: source.short_summary || source.summary || "",
    // Restore defensive state so cached sources route through the defensive
    // sub-pipeline on re-run (was dropped before — defensive sources misrouted
    // as offensive and never re-enriched).
    is_defensive:         isDef,
    defended_category:    source.intelligence?.defended_category || (isDef && offensive ? source.main_category : null),
    defensive_techniques: source.intelligence?.defensive_techniques || [],
    _understand_version: UNDERSTAND_VERSION,
    _from_cache: true,
    source_family: source.intelligence?.source_family
      || classifySourceFamily(source),
  };
}

/**
 * Understand a batch of sources with bounded concurrency.
 *
 * Pass opts.supabase to enable:
 *   - Skip-if-classified: sources with a valid main_category + validation_status="pass"
 *     are restored from the DB row without an LLM call (~$0 for already-processed sources)
 *   - Write-back: newly understood sources are written back to the sources table so
 *     subsequent runs can skip them too.
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]
 * @param {number}   [opts.concurrency=5]
 * @param {Function} [opts.onProgress]
 * @param {object}   [opts.supabase]   Supabase client — enables caching
 * @returns {Promise<{ relevant: object[], discarded: object[], counts: object }>}
 */
export async function understandAllSources(sources, opts = {}) {
  const { concurrency = 5, onProgress, supabase = null } = opts;
  const results = [];
  let cacheHits = 0;

  // ── Skip already-classified sources ──────────────────────────────────────────
  // Gate on layer3_status, NOT validation_status. validation_status is also set
  // by curated ingest scripts on initial save — using it as the skip signal caused
  // those sources to bypass Layer 3/4 entirely. layer3_status is only ever written
  // by this pipeline, so it is the authoritative "already processed" indicator.
  const toProcess = [];
  for (const source of sources) {
    if (
      !opts.skipLlm &&
      source.layer3_status === "pass"
    ) {
      // fromDbRow derives relevant/keep/disposition from main_category + is_defensive.
      // Defensive and unclear_or_adjacent cached sources already have relevant=false.
      results.push(fromDbRow(source));
      cacheHits++;
    } else {
      toProcess.push(source);
    }
  }
  if (cacheHits > 0) {
    process.stdout.write(`  [L3] ${cacheHits} sources restored from DB (already classified), ${toProcess.length} to process\n`);
  }

  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(s => understandSource(s, opts)));

    // ── Write-back: persist newly understood sources to Supabase ─────────────
    // This makes future runs cheaper: the source skips the LLM on re-run.
    if (supabase && !opts.skipLlm) {
      // Match results back to original source objects to get any recovered date
      const srcById = Object.fromEntries(batch.map(s => [s.id, s]));
      const now = new Date().toISOString();
      // Only offensive sources are persisted as pass. Adjacent, defensive, and
      // off_topic sources are written as reject so the pipeline gate stays clean.

      const writebacks = batchResults
        .filter(r => r.relevant && r.category && !r._from_cache)
        .map(r => {
          const orig = srcById[r.id] || {};
          const row = {
            id:               r.id,
            main_category:    r.category,
            tags:             r.primary_tags || [],
            source_type:      r.source_type,
            trust_tier:       r.trust_tier,
            short_summary:    r.short_summary || null,
            validation_status: "pass",
            layer3_status:    "pass",
            relevance_tier:   "core",
            ai_specificity_score: 80,
            source_family:    r.source_family || null,
            intelligence: {
              // Preserve any fields already stored (e.g. report_finding, derived_from_digest
              // from digest fanout). New understand fields override; provenance fields survive.
              ...(orig.intelligence || {}),
              is_defensive:         r.is_defensive || false,
              defended_category:    r.defended_category || null,
              defensive_techniques: r.defensive_techniques || [],
              mechanism_classification: r.mechanism_classification || null,
              key_entities:         r.key_entities || [],
              // Unified maturity level — deterministic fallback at ingest; labelMaturityLevels.js upgrades to LLM.
              ...(() => { const m = deterministicMaturity(r); return { maturity_level: m.level, maturity_confidence: m.confidence, maturity_reason: m.reason, maturity_method: m.method, maturity_at: now }; })(),
            },
          };
          // Persist recovered date if the original had none and we recovered one
          if (!orig.date_published && r.date_published) {
            row.date_published  = r.date_published;
            row.date_confidence = "exact";
          }
          return row;
        });

      const discardWrites = batchResults
        .filter(r => !r.relevant && !r._from_cache)
        .map(r => ({
          id:               r.id,
          main_category:    "unclear_or_adjacent",
          validation_status: "reject",
          layer3_status:    "reject",
          relevance_tier:   "off_topic",
          ai_specificity_score: 0,
        }));

      const allWrites = [...writebacks, ...discardWrites];
      if (allWrites.length > 0) {
        supabase.from("sources").upsert(allWrites, { onConflict: "id", ignoreDuplicates: false })
          .then(({ error }) => { if (error) console.warn(`  [L3 write-back] ${error.message}`); })
          .catch(() => {});
      }
    }

    results.push(...batchResults);
    onProgress?.(Math.min(i + concurrency, toProcess.length), toProcess.length);
  }

  const relevant  = results.filter(r => r.relevant);
  const discarded = results.filter(r => !r.relevant);
  const byCat     = {};
  for (const r of relevant) {
    byCat[r.category] = (byCat[r.category] || 0) + 1;
  }

  return {
    relevant,
    discarded,
    counts: {
      total:       results.length,
      relevant:    relevant.length,
      discarded:   discarded.length,
      by_category: byCat,
    },
  };
}
