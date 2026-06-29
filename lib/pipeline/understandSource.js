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
 * Model: cheap (Gemini Flash / GPT-4o-mini). One call ≈ 500-1000 tokens.
 */

import { routedLLM }              from "../llm/llmRouter.js";
import { callLLM }                from "../llm/callLLM.js";
import {
  DOMAINS, SOURCE_TYPES, TRUST_TIERS, DEFENSIVE_FOCUS_AREAS,
  buildTaxonomyPromptBlock, isValidTag, isValidSubTech, domainOfTag,
} from "./taxonomy.js";

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
  const isTrusted = ["primary", "high", "curated"].includes(trust);

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
    rejection_reason: { type: "string" },
    category: { type: "string", enum: DOMAINS },
    primary_tags: { type: "array", items: { type: "string" } },
    sub_techniques: { type: "array", items: { type: "string" } },
    ai_enabled_overlay: { type: "boolean" },
    source_type: { type: "string", enum: SOURCE_TYPES },
    trust_tier: { type: "string", enum: TRUST_TIERS },
    key_entities: { type: "array", items: { type: "string" } },
    main_claims: { type: "array", items: { type: "string" } },
    key_numbers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          context: { type: "string" },
        },
        required: ["value", "context"],
      },
    },
    short_summary: { type: "string" },
    is_defensive: { type: "boolean" },
    defended_category: { type: "string", enum: [...DOMAINS, "unclear_or_adjacent"] },
    defensive_techniques: { type: "array", items: { type: "string", enum: DEFENSIVE_FOCUS_AREAS } },
  },
  required: ["relevant", "category", "source_type", "trust_tier", "short_summary", "is_defensive"],
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are an AI threat intelligence analyst. Your job is to classify cybersecurity sources and extract structured intelligence.

${buildTaxonomyPromptBlock()}

TRUST TIER RULES:
  primary — Government agencies (CISA, NCSC, NSA, CSA, NIST), major AI labs (Anthropic, OpenAI, Google DeepMind)
  high    — Established security vendors, peer-reviewed academic papers, major research institutions
  medium  — Security blogs, news outlets, independent researchers with track record
  low     — Unknown authors, speculative content, obvious marketing
  unknown — Cannot determine

RELEVANCE RULE:
relevant=true if the source describes ANY of: a specific AI/ML attack technique, a vulnerability in AI systems, an incident involving AI-enabled attacks, a research paper demonstrating attacks on or using AI, a threat actor using AI offensively, a jailbreak/adversarial exploit, OR a defensive measure/mitigation against a specific AI threat category.
relevant=false ONLY if: content with zero AI security angle, pure marketing, completely off-topic (sports, finance, non-security news), or governance/policy content that never references a specific threat.

DEFENSIVE CONTENT RULE:
Set is_defensive=true if the source's PRIMARY contribution is describing mitigations, defenses, detection methods, guardrails, countermeasures, or hardening techniques against AI threats. Even if is_defensive=true, assign category to the OFFENSIVE domain being defended against (e.g., a paper on defending against prompt injection → category="llm_threats"). This lets defensive sources enrich the threat landscape without polluting offensive signal counts.
Set is_defensive=false for sources that describe attacks even if they mention defenses in passing.
When is_defensive=true, set defended_category to the same value as category, and list up to 3 defensive_techniques from the allowed vocabulary.
When is_defensive=false, leave defended_category and defensive_techniques as empty/null.

AI_ENABLED_THREATS RULE:
Before assigning ai_enabled_threats, apply this STRICT decision test:
  "Does the source contain direct, first-hand evidence that an AI system (a generative model, deepfake engine, LLM, voice cloner, etc.) was actively used as the mechanism to carry out the attack — not merely mentioned, not speculated, not implied?"
  If the answer is not a clear YES, assign unclear_or_adjacent instead.

Qualifying examples (PASS):
  ✓ A threat actor uses GPT-4 to write targeted phishing emails — documented with samples
  ✓ A deepfake video of a CEO is used to authorise a wire transfer — incident reported
  ✓ AI-generated fake ID documents used to bypass KYC — documented fraud case
  ✓ LLM used to auto-generate malware variants at scale — verified by researchers

Disqualifying examples (FAIL → use unclear_or_adjacent):
  ✗ An APT group conducts a C2/ransomware/phishing attack — no mention of AI use
  ✗ Article speculates "nation-states will use AI for cyberattacks" — future speculation
  ✗ A news roundup covers multiple security events, one of which involves AI tangentially
  ✗ A CVE in an AI-adjacent product (GitLab AI feature, VS Code Copilot extension) — that's llm_threats or agentic_ai_threats
  ✗ A researcher asks "could AI be used for X?" without demonstrating it was
  ✗ A conventional malware article labelled "AI-era" by a journalist without evidence

Assign at least one AE01–AE10 primary_tag that matches the specific AI mechanism used. If two analysts reading the source could reasonably disagree whether AI was documented, choose unclear_or_adjacent.

ASI02_TOOL_MISUSE_EXPLOITATION RULE:
ASI02 applies when an agent's tool-calling mechanism is specifically exploited — e.g. injecting malicious tool responses, exploiting MCP server vulnerabilities, abusing function-calling APIs. Do NOT assign ASI02 to general agentic AI papers just because they involve tool use. Use ASI01 (goal hijack), ASI06 (memory poisoning), or ASI05 (code execution) when those are the primary risks.

SOURCE TYPE — pick the best fit (use these exact values):
  research_paper           — peer-reviewed paper or preprint
  vulnerability_advisory   — CVE advisory, NVD entry, flaw-specific advisory
  threat_intelligence_report — threat actor TTPs, IOCs, attribution
  incident_report          — documented real-world attack or breach
  news_article             — news outlet covering a security event
  security_blog            — researcher blog, writeup, or analysis post
  government_advisory      — CISA, NCSC, FBI, NSA, or similar agency advisory
  vendor_report            — vendor whitepaper, product release, or vendor blog
  conference_talk          — conference presentation or abstract
  exploit_poc              — proof-of-concept exploit or attack demo
  standards_document       — NIST, ISO, OWASP, or similar standard
  dataset_or_benchmark     — evaluation dataset, benchmark, or measurement study
  unknown                  — cannot determine

Return ONLY valid JSON matching the schema. No markdown.`;
}

// ── Per-source prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const text = (source.full_text || source.clean_text || source.summary || "").slice(0, 6000);
  return `Classify this source:

TITLE: ${source.title || "untitled"}
PUBLISHER: ${source.publisher || "unknown"}
URL: ${source.url || "none"}
DATE: ${source.date_published || "unknown"}

TEXT:
${text || "(no text available — classify from title/URL only)"}

Return JSON. If relevant=false, set category="unclear_or_adjacent" and explain in rejection_reason.
If relevant=true, assign the best-fitting category, 1-3 primary_tags from that category, relevant sub_techniques, and extract up to 8 key_entities, up to 5 main_claims, key_numbers mentioned.`;
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
 * Resolve the model's category field to a valid DOMAIN string.
 *
 * The model sometimes puts a primary tag ID (e.g. "AE02_ai_social_engineering")
 * in the category field instead of the domain. This resolves that via taxonomy
 * lookup, then falls back to inferring from the primary_tags list.
 */
function resolveCategory(rawCategory, rawPrimaryTags) {
  // 1. Already a valid domain → use it
  if (DOMAINS.includes(rawCategory)) return rawCategory;

  // 2. It's a tag ID (e.g. "AE02_ai_social_engineering") → look up its domain
  if (rawCategory && isValidTag(rawCategory)) {
    const domain = domainOfTag(rawCategory);
    if (domain) return domain;
  }

  // 3. Infer from the first valid primary_tag
  const tags = Array.isArray(rawPrimaryTags) ? rawPrimaryTags : [];
  for (const tag of tags) {
    if (isValidTag(tag)) {
      const domain = domainOfTag(tag);
      if (domain) return domain;
    }
  }

  return "unclear_or_adjacent";
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
    rejection_reason:     deepGet(raw, "rejection_reason", "reason", "irrelevance_reason"),
    category:             deepGet(raw, "category", "threat_category", "domain", "primary_category"),
    primary_tags:         deepGet(raw, "primary_tags", "tags", "threat_tags", "primary_threat_tags"),
    sub_techniques:       deepGet(raw, "sub_techniques", "subtechniques", "sub_technique_ids", "sub_technique_list"),
    ai_enabled_overlay:   deepGet(raw, "ai_enabled_overlay", "ai_enabled", "ai_enabled_as_weapon"),
    source_type:          deepGet(raw, "source_type", "type", "content_type", "source_category"),
    trust_tier:           deepGet(raw, "trust_tier", "trust", "publisher_tier", "credibility_tier"),
    key_entities:         deepGet(raw, "key_entities", "entities", "named_entities", "actors", "entity_list"),
    main_claims:          deepGet(raw, "main_claims", "claims", "key_findings", "findings", "key_claims"),
    key_numbers:          deepGet(raw, "key_numbers", "numbers", "statistics", "metrics", "quantitative_findings"),
    short_summary:        deepGet(raw, "short_summary", "summary", "description", "analysis_summary", "technical_summary"),
    is_defensive:         deepGet(raw, "is_defensive", "defensive", "is_primarily_defensive"),
    defended_category:    deepGet(raw, "defended_category", "defended_domain", "defensive_category"),
    defensive_techniques: deepGet(raw, "defensive_techniques", "defense_techniques", "mitigation_types"),
  };
}

function normalise(raw, source, opts = {}) {
  if (!raw || typeof raw !== "object") {
    return { relevant: false, rejection_reason: "LLM returned non-object", _understand_version: UNDERSTAND_VERSION };
  }

  const flat = flattenRaw(raw);

  // Validate tags and sub-techniques against taxonomy; guard non-array returns
  const rawTags = Array.isArray(flat.primary_tags) ? flat.primary_tags : [];
  const rawSubs = Array.isArray(flat.sub_techniques) ? flat.sub_techniques : [];
  const validatedTags = rawTags.filter(t => isValidTag(t));
  const validatedSubs = rawSubs.filter(s => isValidSubTech(s));

  // Resolve category: handles tag-IDs-as-category, infers from tags, falls back
  const resolvedCategory = resolveCategory(flat.category, rawTags);

  // Determine relevance: trust the field if present, but also infer from category
  // (Haiku sometimes contradicts itself: says relevant=false yet assigns a real domain)
  const isRelevant = Boolean(flat.relevant) ||
    (resolvedCategory !== "unclear_or_adjacent" && !flat.rejection_reason);

  // ai_enabled_threats gate: the category requires AI to be documented as the attack
  // tool, evidenced by at least one AE01–AE10 primary_tag. Sources about conventional
  // threat campaigns that don't document AI usage get discarded as unclear_or_adjacent.
  // Bypassed in skipLlm (dry-run) mode where tags are not assigned.
  const aeTags = validatedTags.filter(t => t.startsWith("AE"));
  const failsAeGate = !opts.skipLlm && resolvedCategory === "ai_enabled_threats" && aeTags.length === 0;
  const finalCategory       = failsAeGate ? "unclear_or_adjacent" : resolvedCategory;
  const finalRelevant       = failsAeGate ? false : isRelevant;
  const finalRejection      = failsAeGate
    ? "ai_enabled_threats requires an AE01–AE10 tag confirming AI use as attack tool; no such tag found — conventional threat activity without documented AI involvement"
    : (flat.rejection_reason || null);

  const isDefensive = Boolean(flat.is_defensive);
  const defendedCat = isDefensive && DOMAINS.includes(flat.defended_category)
    ? flat.defended_category : null;
  const defensiveTechs = isDefensive && Array.isArray(flat.defensive_techniques)
    ? flat.defensive_techniques.filter(t => DEFENSIVE_FOCUS_AREAS.includes(t)).slice(0, 3)
    : [];

  // Append "defensive" to primary_tags so it's persisted in the tags column
  const finalTags = isDefensive
    ? [...new Set([...validatedTags, "defensive"])]
    : validatedTags;

  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published:source.date_published,
    full_text:     source.full_text || source.clean_text || "",

    relevant:         finalRelevant,
    rejection_reason: finalRejection,
    category:         finalCategory,
    primary_tags:     finalTags,
    sub_techniques:   validatedSubs,
    ai_enabled_overlay: Boolean(flat.ai_enabled_overlay),
    source_type:      SOURCE_TYPES.includes(flat.source_type) ? flat.source_type : "unknown",
    trust_tier:       TRUST_TIERS.includes(flat.trust_tier) ? flat.trust_tier : "unknown",
    key_entities:     (Array.isArray(flat.key_entities) ? flat.key_entities : []).slice(0, 10),
    main_claims:      (Array.isArray(flat.main_claims)  ? flat.main_claims  : []).slice(0, 6),
    key_numbers:      (Array.isArray(flat.key_numbers)  ? flat.key_numbers  : []).slice(0, 8),
    short_summary:    (String(flat.short_summary || "")).slice(0, 400),
    is_defensive:     isDefensive,
    defended_category: defendedCat,
    defensive_techniques: defensiveTechs,
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
export async function understandSource(source, opts = {}) {
  // H1: Deterministic pre-screen before spending an LLM call.
  // skipLlm bypasses this — dry-run mode should accept everything.
  if (!opts.skipLlm) {
    const screen = deterministicPreScreen(source);
    if (!screen.pass) {
      return normalise({
        relevant: false,
        rejection_reason: screen.reason,
        category: "unclear_or_adjacent",
        source_type: source.source_type || "unknown",
        trust_tier: source.trust_tier || "unknown",
        primary_tags: [], sub_techniques: [], key_entities: [],
        main_claims: [], key_numbers: [], short_summary: "",
      }, source);
    }
  }

  if (opts.skipLlm) {
    // Deterministic stub: accept everything, assign unclear.
    // skipLlm=true bypasses the AE gate — tags are not assigned in dry-run mode.
    return normalise({
      relevant: true,
      category: source.main_category || "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      primary_tags: [],
      sub_techniques: [],
      key_entities: [],
      main_claims: [],
      key_numbers: [],
      short_summary: (source.summary || source.title || "").slice(0, 200),
    }, source, { skipLlm: true });
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
    return normalise(raw, source);
  } catch (err) {
    return normalise({
      relevant: false,
      rejection_reason: `LLM error: ${err.message}`,
      category: "unclear_or_adjacent",
      source_type: source.source_type || "unknown",
      trust_tier: source.trust_tier || "unknown",
      short_summary: "",
    }, source);
  }
}

const VALID_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

/**
 * Reconstitute a previously-understood source from its DB row.
 * Avoids re-running the LLM when the source was already classified.
 */
function fromDbRow(source) {
  return {
    id:            source.id,
    title:         source.title,
    url:           source.url,
    publisher:     source.publisher,
    date_published: source.date_published,
    full_text:     source.full_text || source.clean_text || "",
    relevant:      true,
    rejection_reason: null,
    category:      source.main_category,
    primary_tags:  source.tags || [],
    sub_techniques: [],
    ai_enabled_overlay: false,
    source_type:   source.source_type || "unknown",
    trust_tier:    source.trust_tier  || "unknown",
    key_entities:  source.intelligence?.key_entities || [],
    main_claims:   source.intelligence?.main_claims  || [],
    key_numbers:   source.intelligence?.key_numbers  || [],
    short_summary: source.short_summary || source.summary || "",
    // Restore defensive state so cached sources route through the defensive
    // sub-pipeline on re-run (was dropped before — defensive sources misrouted
    // as offensive and never re-enriched).
    is_defensive:         source.intelligence?.is_defensive || false,
    defended_category:    source.intelligence?.defended_category || null,
    defensive_techniques: source.intelligence?.defensive_techniques || [],
    _understand_version: UNDERSTAND_VERSION,
    _from_cache: true,
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
  // A source that already has main_category + validation_status=pass in the DB
  // was understood in a previous run — restore from DB row, skip LLM call.
  const toProcess = [];
  for (const source of sources) {
    if (
      !opts.skipLlm &&
      VALID_CATEGORIES.has(source.main_category) &&
      source.validation_status === "pass"
    ) {
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
      const writebacks = batchResults
        .filter(r => r.relevant && r.category && !r._from_cache)
        .map(r => ({
          id:               r.id,
          main_category:    r.category,
          tags:             r.primary_tags || [],
          source_type:      r.source_type,
          trust_tier:       r.trust_tier,
          short_summary:    r.short_summary || null,
          validation_status: "pass",
          layer3_status:    "pass",
          intelligence: {
            is_defensive:         r.is_defensive || false,
            defended_category:    r.defended_category || null,
            defensive_techniques: r.defensive_techniques || [],
          },
        }));

      const discardWrites = batchResults
        .filter(r => !r.relevant && !r._from_cache)
        .map(r => ({
          id:               r.id,
          main_category:    "unclear_or_adjacent",
          validation_status: "reject",
          layer3_status:    "reject",
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

  const relevant   = results.filter(r => r.relevant);
  const discarded  = results.filter(r => !r.relevant);
  const byCat      = {};
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
