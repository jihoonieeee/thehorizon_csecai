/**
 * Tool definitions and implementations for the agent chatbot.
 *
 * Tools let Claude decide what data to fetch rather than hardcoded routing.
 * Each tool queries Supabase (live data) or the latest deck blob (pipeline analysis).
 *
 * In-process blob cache avoids repeat fetches within a serverless invocation.
 */

import { supabase } from "../storage/supabaseClient.js";
import { loadLatestDeck } from "../storage/deckStore.js";
import { sourceSignalScore } from "../pipeline/scoring/sourceSignal.js";
import { embedText } from "./embeddings.js";

// ── Blob cache ────────────────────────────────────────────────────────────────

let _blobCache = null;
let _blobCacheAt = 0;
const BLOB_TTL_MS = 10 * 60 * 1000;

async function getDeckData() {
  const now = Date.now();
  if (_blobCache && now - _blobCacheAt < BLOB_TTL_MS) return _blobCache;

  try {
    const deck = await loadLatestDeck();
    if (!deck?.blob_path) return null;
    const res = await fetch(deck.blob_path);
    if (!res.ok) return null;
    const payload = await res.json();
    // Support both old synthesis blob and v2 run-result format
    const synth = payload?.synthesis || payload;
    _blobCache   = synth;
    _blobCacheAt = now;
    return synth;
  } catch {
    return null;
  }
}

export function resetBlobCache() {
  _blobCache   = null;
  _blobCacheAt = 0;
}

// ── Evidence index ─────────────────────────────────────────────────────────────

export function buildEvidenceIndexFromDeck(synth) {
  if (!synth) return {};
  const index = {};
  const add = (item) => {
    if (!item?.evidence_id || index[item.evidence_id]) return;
    index[item.evidence_id] = {
      evidence_id:   item.evidence_id,
      fact:          item.fact || item.display_label || "",
      quote:         item.quote || "",
      quote_grounded: item.quote_grounded ?? false,
      source_url:    item.source_url || item.url || null,
      source_title:  item.source_title || item.title || "",
      publisher:     item.publisher || "",
      trust_tier:    item.trust_tier || "",
      evidence_type: item.evidence_type || "",
      numbers:       item.numbers || [],
      category:      item.category || "",
    };
  };

  for (const item of (synth?.evidence_items || [])) add(item);
  for (const item of (synth?.evidence_inventory || [])) add(item);
  for (const dossier of (synth?.fused_dossiers || [])) {
    const rf = dossier.rawfact || {};
    for (const item of [
      ...(rf.strong_evidence || []), ...(rf.usable_evidence || []),
      ...(dossier.rawfact_evidence || []), ...(dossier.external_evidence || []),
    ]) add(item);
  }
  return index;
}

// ── ISO week helper ────────────────────────────────────────────────────────────

function isoWeek(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getDay() || 7;
  const thu = new Date(d);
  thu.setDate(d.getDate() + 4 - day);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const week = Math.ceil(((thu - jan1) / 86400000 + 1) / 7);
  return `${thu.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Tool: search_corpus ────────────────────────────────────────────────────────

// Robust free-text → search terms. Extracts alphanumeric tokens ≥3 chars and
// drops stopwords. Critically, the [a-z0-9] regex strips commas/parens/quotes/
// colons that otherwise break PostgREST's comma-delimited .or() filter — the
// source of the intermittent search_corpus errors. Word-level (not whole-phrase)
// also fixes recall: an exact-substring ilike of a full question never matches.
const SEARCH_STOPWORDS = new Set([
  "the","and","for","are","with","that","this","from","into","what","how","why",
  "does","is","of","to","a","in","on","an","about","which","were","was","has",
  "have","can","could","would","should","their","they","there","these","those",
  "latest","recent","new","tell","show","give","any","all","most","more",
]);
export function extractSearchTerms(query, max = 6) {
  const words = String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const kept = words.filter(w => !SEARCH_STOPWORDS.has(w));
  return [...new Set(kept.length ? kept : words)].slice(0, max);
}

const TRUST_BONUS = { curated: 1.5, primary: 1.5, high: 1, medium: 0.5, low: 0, unknown: 0 };

// Score a candidate source against the query terms. Title matches weigh more than
// summary matches; each DISTINCT term matched adds to the score (so a source that
// hits many query terms outranks one that hits a single term many times). A small
// trust-tier bonus breaks near-ties toward authoritative sources.
//
// Keyword relevance stays PRIMARY (this is a search — never surface an unrelated
// source just because it's consequential), but a normalised SIGNAL bonus
// (importance reality + research significance + trust, via sourceSignalScore, ~0-470
// scaled to ~0-4.7) lifts consequential matches — a realized incident or a landmark
// paper — above a noise-tier keyword match, and pushes noise down among ties. This
// makes the chatbot cite the most-contributing sources and resist noise, using the
// SAME ranking the dashboard insight pipeline uses.
function relevanceScore(source, terms) {
  const signalBonus = sourceSignalScore(source) / 100;
  if (!terms.length) return (TRUST_BONUS[source.trust_tier] || 0) + signalBonus;
  const title   = String(source.title || "").toLowerCase();
  const brief    = (typeof source.short_summary === "string" ? source.short_summary : "");
  const body    = `${source.summary || ""} ${brief} ${(source.primary_tags || []).join(" ")}`.toLowerCase();
  let score = 0, hits = 0;
  for (const t of terms) {
    const inTitle = title.includes(t);
    const inBody  = body.includes(t);
    if (inTitle) score += 3;
    if (inBody)  score += 1;
    if (inTitle || inBody) hits += 1;
  }
  // Reward breadth of coverage: matching 4 of 5 terms should clearly beat 1 of 5.
  score += hits * 2;
  score += TRUST_BONUS[source.trust_tier] || 0;
  score += signalBonus;                    // consequence lift, subordinate to keyword match
  return score;
}

async function searchCorpus({ categories, query, tags, date_from, date_to, trust_tiers, limit = 15 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const want = Math.min(limit, 50);

  // Over-fetch a candidate pool, then rank by relevance in JS. The DB can only
  // order by a column (date_published), so applying LIMIT at the DB level would
  // return the most RECENT keyword matches, not the most RELEVANT. We instead
  // pull a larger recent pool and re-rank so the model cites the sources that
  // actually match the question, not merely the newest ones.
  const CANDIDATE_CAP = Math.min(Math.max(want * 5, 60), 200);

  let q = supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,primary_tags,source_type,intelligence,reading_value")
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .not("is_digest", "is", true)   // exclude digest parents — children carry the content
    // Exclude sources with an unconfirmed publish date — the agent reasons about
    // and cites dates, so an estimated/inferred date could mislead. Confirm the
    // date on the Sources page (→ date_confidence="exact") to surface it here.
    .eq("date_confidence", "exact")
    .order("date_published", { ascending: false })
    .limit(CANDIDATE_CAP);

  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
  q = q.in("main_category", cats);

  const terms = query ? extractSearchTerms(query) : [];
  if (terms.length) {
    // title + summary only — the DB filter just narrows the candidate pool.
    const ors = [];
    for (const w of terms) ors.push(`title.ilike.%${w}%`, `summary.ilike.%${w}%`);
    q = q.or(ors.join(","));
  }
  if (Array.isArray(tags) && tags.length) {
    q = q.contains("tags", tags);
  }
  if (date_from) {
    q = q.gte("date_published", date_from);
  }
  if (date_to) {
    q = q.lte("date_published", date_to);
  }
  if (Array.isArray(trust_tiers) && trust_tiers.length) {
    q = q.in("trust_tier", trust_tiers);
  }

  const { data, error } = await q;
  if (error) throw new Error(`search_corpus: ${error.message}`);

  // Rank by relevance, then recency as tie-breaker; take the top `want`.
  const ranked = (data || [])
    .map(s => ({ s, score: relevanceScore(s, terms) }))
    .sort((a, b) =>
      b.score - a.score ||
      (b.s.date_published || "").localeCompare(a.s.date_published || ""))
    .slice(0, want)
    .map(({ s }) => s);

  return {
    count: ranked.length,
    sources: ranked.map((s, i) => ({
      ref:         `src-${i + 1}`,
      id:          s.id,
      title:       s.title,
      url:         s.url,
      publisher:   s.publisher,
      date:        s.date_published?.slice(0, 10),
      category:    s.main_category,
      trust_tier:  s.trust_tier,
      tags:        s.tags || [],
      summary:     (s.short_summary || s.summary || "").slice(0, 700),
    })),
  };
}

// ── Retrieval-first search + quality gate ────────────────────────────────────
//
// Used by the chatbot's planner→retrieve→synthesize flow (api/agent.js). Unlike
// the model-driven search_corpus tool, this takes an already-expanded plan
// (canonical terms + taxonomy tags + entities from queryPlanner) so a question
// phrased differently from the source text still matches. It returns a QUALITY
// VERDICT so the caller can decide whether to answer from the corpus or fall
// back to a clearly-labelled general answer:
//   "good" — ≥3 sources actually matched a term/tag
//   "thin" — 1-2 matched (answer, but flag limited coverage)
//   "none" — 0 matched (no usable corpus sources → general fallback)
const RETRIEVE_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];

// Source types that represent academic / research output. When the user asks for
// papers/studies, these get a scoring boost so arXiv findings surface above
// vendor blog posts that happen to share the same keywords.
const ACADEMIC_SOURCE_TYPES = new Set([
  "research_finding", "benchmark_evaluation", "capability_demonstration",
]);

function fmtSource(s, i) {
  const intel = s.intelligence || {};
  const obj = {
    ref:              `src-${i + 1}`,
    id:               s.id,
    // For child sources (digest fanout), cite the parent report title.
    // parent_title is null for standalone sources, so the fallback is safe.
    title:            s.parent_title || s.title,
    url:              s.url,
    publisher:        s.publisher,
    date:             s.date_published?.slice(0, 10),
    category:         s.main_category,
    trust_tier:       s.trust_tier,
    source_type:      s.source_type || null,
    tags:             s.tags || [],
    summary:          (s.short_summary || s.summary || "").slice(0, 1000),
    reading_value:    s.reading_value || intel.reading_value || "background",
    maturity:         intel.maturity_level || null,
    retrieval_lanes:  s._retrieval_lanes || [],
  };
  if (intel.source_coverage_type) {
    obj.coverage = intel.source_coverage_type;
    if (intel.covered_period_start) obj.covered_period_start = intel.covered_period_start;
    if (intel.covered_period_end)   obj.covered_period_end   = intel.covered_period_end;
  }
  if (intel.event_date) obj.event_date = intel.event_date;
  return obj;
}

const READING_RANK = { essential: 4, recommended: 3, analyst: 2, background: 1 };
const MATURITY_RANK = { operational: 5, observed: 4, disclosed: 3, demonstrated: 2, research: 1 };
const TRUST_RANK   = { primary: 5, high: 2, medium: 1, low: 0, unknown: 0 };

async function vectorSearchSources(plan, limit) {
  const queryText = (plan.search_terms || []).join(" ");
  const embedding = await embedText(queryText);
  if (!embedding) return { rows: [], similarityMap: new Map() };
  const cats = plan.category ? [plan.category] : RETRIEVE_CATS;
  const tf   = plan.temporal || {};

  // For event_date queries, extend the date_to window by 90 days so reports
  // published shortly after an event (e.g. August write-ups of July incidents)
  // still surface. The selector enforces the strict event_date constraint.
  let dateTo = (!tf.all_time && tf.date_to) ? tf.date_to : null;
  if (dateTo && tf.time_field === "event_date") {
    const d = new Date(dateTo + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 90);
    dateTo = d.toISOString().slice(0, 10);
  }

  const { data } = await supabase.rpc("match_sources", {
    query_embedding:  embedding,
    match_threshold:  0.40,
    match_count:      limit,
    category_filter:  cats,
    date_from_filter: (!tf.all_time && tf.date_from) ? tf.date_from : null,
    date_to_filter:   dateTo,
  });
  if (!data?.length) return { rows: [], similarityMap: new Map() };

  // Capture similarity scores before hydration — the RPC result has id+similarity.
  const similarityMap = new Map(data.map(r => [r.id, r.similarity || 0]));

  // Fetch full rows for the matched IDs. SELECT must exactly match the
  // retrieveRelevant() query so fmtSource() receives all required fields.
  const { data: rows } = await supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
    .in("id", data.map(r => r.id))
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .not("is_digest", "is", true)
    .eq("date_confidence", "exact");
  return { rows: rows || [], similarityMap };
}

export async function retrieveRelevant(plan, { limit } = {}) {
  // exhaustiveness + query_type drive the retrieval pool size. Raised from previous
  // values to give the selector LLM a broader, relevance-diverse pool to choose from.
  const baseLimit = plan.exhaustiveness === "all_matching"   ? 60  // was 50
                  : plan.exhaustiveness === "representative" ? 20  // was 15
                  : plan.query_type === "trend_analysis"     ? 50  // was 40
                  : 50;                                            // was 35
  const want = Math.min(limit ?? baseLimit, 60);  // cap raised from 50

  // Planner returns multi-word phrases; split to individual tokens for ilike.
  const STOP = new Set(["the","and","for","are","with","that","this","from","into",
    "what","how","why","does","of","to","a","in","on","an","about","which","were",
    "was","has","have","can","could","should","their","they","there","these","those"]);
  // Calendar words and bare noise terms — useful in temporal metadata but not as
  // ilike search tokens where they'd match almost everything.
  const NOISE = new Set([
    "event","events","occurred","happened","incident","incidents","activity",
    "january","february","march","april","may","june","july","august",
    "september","october","november","december",
    "jan","feb","mar","apr","jun","jul","aug","sep","oct","nov","dec",
    "2023","2024","2025","2026","2027","2028",
  ]);

  // Tokenise a single search-term string.
  // Strategy: keep 2–4 word phrases (≤40 chars) as INTACT substrings so named
  // entities like "Hugging Face" stay as a phrase rather than splitting into the
  // noise tokens "hugging" and "face". Also generate individual word tokens for
  // fallback recall so one-off term hits still work.
  function termToTokens(raw) {
    const clean = String(raw || "").replace(/[,{}()%]/g, " ").toLowerCase().trim();
    const words  = clean.split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w) && !NOISE.has(w));
    const meaningfulCount = words.length;
    const out = [...words];
    // Preserve the phrase when it looks like a named entity or technique name
    // (2–4 meaningful words, short enough to be a real phrase not a sentence).
    if (meaningfulCount >= 2 && meaningfulCount <= 4 && clean.length <= 40) {
      // Only keep phrase if it contains no pure noise words — strips trailing noise.
      const phraseWords = clean.split(/\s+/).filter(w => w.length >= 2);
      const phrase = phraseWords.join(" ");
      if (phrase.length >= 5) out.push(phrase);
    }
    return out;
  }

  // Merge must_include entity/technique terms into the token list — they are
  // explicit user constraints that must influence the DB candidate pool.
  const mustTokens = (plan.must_include || [])
    .flatMap(t => termToTokens(t))
    .filter(w => !NOISE.has(w));

  const tokens = [...new Set([
    ...(plan.search_terms || []).flatMap(t => termToTokens(t)),
    ...mustTokens,
  ])].slice(0, 30);

  // Fetch a broad candidate pool — date + category + text filters only.
  // No recency ordering: we re-rank by importance label + trust tier + keyword
  // hits so a landmark older source beats a noise-tier recent one.
  let q = supabase
    .from("sources")
    .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .not("is_digest", "is", true)   // exclude digest parents — children carry the content
    .eq("date_confidence", "exact")   // authoritative publish date only (see above)
    .in("main_category", plan.category ? [plan.category] : RETRIEVE_CATS)
    .limit(want * 6);  // over-fetch; ranking will cut to `want`

  const tf = plan.temporal || {};
  // For event_date queries, extend the publication-date upper bound by 90 days.
  // Incident reports are often published after the events they cover — a July
  // breach may not be reported until August or September. The selector then
  // uses the per-source event_date field to enforce the strict event window.
  const isEventDateQuery = tf.time_field === "event_date";
  function extendedDateTo(rawDateTo) {
    if (!rawDateTo || !isEventDateQuery) return rawDateTo;
    const d = new Date(rawDateTo + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 90);
    return d.toISOString().slice(0, 10);
  }

  if (!tf.all_time && tf.date_from) q = q.gte("date_published", tf.date_from);
  if (!tf.all_time && tf.date_to) {
    const upperDate = extendedDateTo(tf.date_to);
    const upper = /^\d{4}-\d{2}-\d{2}$/.test(upperDate) ? `${upperDate}T23:59:59` : upperDate;
    q = q.lte("date_published", upper);
  }

  if (tokens.length) {
    const ors = [];
    for (const w of tokens) ors.push(`title.ilike.%${w}%`, `summary.ilike.%${w}%`);
    q = q.or(ors.join(","));
  }

  // When the planner identified specific taxonomy tags, use them to widen the
  // candidate pool with a second query — tag-matched sources may not contain
  // the search term tokens in title/summary, so we union the two result sets.
  // Build tq outside the if block so it can join the Promise.all below.
  let tq = null;
  if (Array.isArray(plan.taxonomy_tags) && plan.taxonomy_tags.length) {
    tq = supabase
      .from("sources")
      .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,tags,summary,short_summary,source_type,intelligence,reading_value")
      .eq("validation_status", "pass")
      .not("needs_review", "is", true)
      .not("is_digest", "is", true)
      .eq("date_confidence", "exact")
      .in("main_category", plan.category ? [plan.category] : RETRIEVE_CATS)
      .contains("tags", plan.taxonomy_tags)
      .limit(want * 3);
    if (!tf.all_time && tf.date_from) tq = tq.gte("date_published", tf.date_from);
    if (!tf.all_time && tf.date_to) {
      const upperDate = extendedDateTo(tf.date_to);
      tq = tq.lte("date_published", `${upperDate}T23:59:59`);
    }
  }

  // All three retrieval lanes run concurrently.
  const [
    { data, error },
    { data: td },
    { rows: vectorRows, similarityMap: vectorSimilarityMap },
  ] = await Promise.all([
    q,
    tq ?? Promise.resolve({ data: null }),
    vectorSearchSources(plan, want * 2).catch(() => ({ rows: [], similarityMap: new Map() })),
  ]);
  let tagData = td || [];
  if (error) throw new Error(`retrieveRelevant: ${error.message}`);

  // Track which retrieval lane(s) found each source so the selector can see
  // whether a source was retrieved by keyword match, taxonomy tag, or semantic
  // vector similarity — vector-only sources may lack keyword overlap but be
  // highly relevant and should not be silently deprioritised.
  const laneMap = new Map();
  for (const s of (data || [])) {
    if (!laneMap.has(s.id)) laneMap.set(s.id, new Set());
    laneMap.get(s.id).add("keyword");
  }
  for (const s of tagData) {
    if (!laneMap.has(s.id)) laneMap.set(s.id, new Set());
    laneMap.get(s.id).add("tag");
  }
  for (const s of (vectorRows || [])) {
    if (!laneMap.has(s.id)) laneMap.set(s.id, new Set());
    laneMap.get(s.id).add("vector");
  }

  // Merge keyword-matched, tag-matched, and vector-matched candidates, deduplicating by id.
  // Annotate each source with the set of lanes that retrieved it.
  const seenIds = new Set();
  let allCandidates = [];
  for (const s of [...(data || []), ...tagData, ...(vectorRows || [])]) {
    if (seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    const lanes = laneMap.get(s.id);
    allCandidates.push({ ...s, _retrieval_lanes: lanes ? [...lanes] : [] });
  }

  // must_exclude: drop sources whose taxonomy tags contain any explicitly excluded tag.
  // Only taxonomy tag strings (matching the coded-ID pattern) are enforced here; free-text
  // exclusions (e.g. "research papers") are passed through to the selector and synthesiser.
  const excludeTags = (plan.must_exclude || []).filter(t => /^[A-Z]{2,4}\d{2}_/.test(t));
  if (excludeTags.length) {
    allCandidates = allCandidates.filter(s =>
      !excludeTags.some(tag => (s.tags || []).includes(tag))
    );
  }

  // Relevance-primary ranking: keyword hits and vector similarity are the primary
  // signals; quality (reading_value, maturity, trust) is a secondary lift.
  // This ensures directly relevant sources reach the selector pool even when they
  // lack the pipeline's importance classification (e.g. newly-ingested sources).
  const title_tokens_match = (text) => {
    const t = (text || "").toLowerCase();
    return tokens.filter(w => t.includes(w)).length;
  };
  const summary_tokens_match = (text) => {
    const t = String(text || "").slice(0, 2000).toLowerCase();
    return tokens.filter(w => t.includes(w)).length;
  };

  // Precompute recency anchor once for event_date queries with a bounded window.
  // Sources published closer to the end of the event window score higher — a July
  // incident report outranks a July background article that shares the same keywords.
  const recencyDateTo = (!tf.all_time && tf.date_to && isEventDateQuery)
    ? new Date(tf.date_to + "T23:59:59Z")
    : null;

  const ranked = allCandidates
    .map(s => {
      const rv      = s.reading_value ?? s.intelligence?.reading_value ?? "analyst";  // raised from "background"
      const reading = READING_RANK[rv] ?? 0;
      const maturity = MATURITY_RANK[s.intelligence?.maturity_level] ?? 1;            // floor raised from 0
      const trust   = TRUST_RANK[s.trust_tier] ?? 0;

      const hits    = title_tokens_match(s.title);
      const sumHits = Math.min(summary_tokens_match(s.short_summary || s.summary || ""), 4);
      const vecSim  = (vectorSimilarityMap.get(s.id) ?? 0) * 5;  // raised from × 3

      // Recency bonus: up to +3 pts for event_date queries, decaying to 0 at 60 days
      // before date_to. Only applies within the event window (daysFromEnd >= 0).
      let dateBonus = 0;
      if (recencyDateTo && s.date_published) {
        const daysFromEnd = (recencyDateTo - new Date(s.date_published)) / 86400000;
        if (daysFromEnd >= 0 && daysFromEnd <= 60) {
          dateBonus = Math.max(0, 3 - daysFromEnd / 20);
        }
      }

      const relevance = hits * 3 + sumHits * 1.5 + vecSim;
      const quality   = reading * 1.5 + maturity * 0.75 + trust * 0.75;  // multipliers reduced
      return { s, score: relevance + quality + dateBonus };
    })
    .sort((a, b) => b.score - a.score || (b.s.date_published || "").localeCompare(a.s.date_published || ""));

  // Deduplicate by URL and take top `want`.
  const seen = new Set();
  const top = [];
  for (const { s } of ranked) {
    if (top.length >= want) break;
    const key = (s.url || s.id || "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(s);
  }

  return {
    count:   top.length,
    sources: top.map((s, i) => fmtSource(s, i)),
  };
}

// ── Tool: get_judgments ────────────────────────────────────────────────────────

async function getJudgments({ categories }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;

  const synth = await getDeckData();
  if (!synth) {
    return { available: false, message: "No pipeline analysis available. Use search_corpus for source-level data." };
  }

  const cas = synth?.category_analyses || [];
  const judgments = [];

  for (const ca of cas) {
    if (!cats.includes(ca.category)) continue;

    // v2 format — use exclusively when present; do not also read legacy fields
    // (avoids duplicate judgments when both formats coexist during migration)
    if (Array.isArray(ca.judgments)) {
      for (const j of ca.judgments.filter(j => !j.blocked)) {
        judgments.push({
          category:          ca.category,
          judgment:          j.judgment,
          evidence_ids:      j.evidence_for || [],
          monitoring_signals: j.monitoring_signals || [],
          short_takeaway:    j.short_takeaway || "",
          recommended_action: j.recommended_action || "",
          landscape_summary: ca.landscape_summary || "",
        });
      }
    } else {
      // Legacy format — only used when v2 judgments are absent for this category
      for (const ins of (ca.top_insights || [])) {
        if (ins.insight) judgments.push({
          category:          ca.category,
          judgment:          ins.insight,
          evidence_ids:      ins.supporting_evidence_ids || [],
          monitoring_signals: [],
          short_takeaway:    ins.explanation || ins.why_this_matters || "",
          landscape_summary: ca.landscape_summary || "",
        });
      }
      for (const h of (ca.biggest_happenings || [])) {
        if (h.happening) judgments.push({
          category:     ca.category,
          judgment:     h.happening,
          evidence_ids: h.supporting_evidence_ids || [],
          monitoring_signals: [],
          short_takeaway: h.why_it_matters || "",
        });
      }
    }
  }

  return {
    available:      true,
    judgment_count: judgments.length,
    judgments,
  };
}

// ── Tool: get_evidence ─────────────────────────────────────────────────────────

async function vectorSearchEvidence(queryText, categories, limit, validSourceIds = null) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const embedding = await embedText(queryText);
  if (!embedding) return [];

  // Over-fetch when we'll post-filter by source date window.
  // 4× compensates for the fraction of vector results outside the window.
  const fetchCount = validSourceIds ? Math.min(limit * 4, 200) : limit;

  const { data } = await supabase.rpc("match_evidence", {
    query_embedding: embedding,
    match_threshold: 0.40,
    match_count:     fetchCount,
    category_filter: Array.isArray(categories) && categories.length ? categories : ALL_CATS,
  });
  if (!data?.length) return [];

  if (!validSourceIds) return data.map(r => r.evidence_id);

  // Date-bounded: fetch source_id for each matched evidence_id in one query,
  // then keep only items whose source is within the pre-fetched validSourceIds set.
  const validSet = new Set(validSourceIds);
  const { data: rows } = await supabase
    .from("evidence")
    .select("evidence_id, source_id")
    .in("evidence_id", data.map(r => r.evidence_id));
  return (rows || [])
    .filter(r => validSet.has(r.source_id))
    .map(r => r.evidence_id)
    .slice(0, limit);
}

async function getEvidence({ evidence_ids, categories, query, tags, grounded_only, limit = 25, date_from, date_to }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  // Resolve once at the top — used by the keyword builder, vector search, and validSourceIds pre-fetch.
  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;

  // Over-fetch so we can apply a per-source diversity cap after retrieval.
  // Without this, a single broad threat report (e.g. an annual GTR) can supply
  // 6+ of the top 12 evidence items and crowd out all other sources.
  const fetchLimit = Math.min(Math.max(limit * 3, 40), 120);

  // When a temporal window is set and we're not fetching by specific evidence IDs,
  // pre-fetch the source IDs that fall within the window so evidence stays
  // temporally consistent with the sources the chatbot retrieved. The evidence
  // table has no date column of its own, so we gate via source_id.
  let validSourceIds = null;
  if (!Array.isArray(evidence_ids) || !evidence_ids.length) {
    if (date_from || date_to) {
      let srcQ = supabase
        .from("sources")
        .select("id")
        .in("main_category", cats)
        .eq("validation_status", "pass")
        .not("needs_review", "is", true)
        .eq("date_confidence", "exact")   // date-bounded query → authoritative dates only
        .limit(400);
      if (date_from) srcQ = srcQ.gte("date_published", date_from);
      if (date_to)   srcQ = srcQ.lte("date_published", date_to);
      const { data: srcData } = await srcQ;
      validSourceIds = (srcData || []).map(s => s.id);

      if (validSourceIds.length === 0) {
        return { available: true, source: "live_corpus", item_count: 0, evidence_items: [] };
      }
    }
  }

  // Primary path: the live `evidence` table (grounded facts + verbatim quotes +
  // source URLs for ~98% of the corpus). This is the authoritative evidence base;
  // the deck blob is only a fallback for specific deck-scoped evidence IDs.
  let q = supabase
    .from("evidence")
    .select("evidence_id,source_id,fact,quote,quote_grounded,source_url,source_title,publisher,trust_tier,source_type,evidence_type,specificity,numbers,technique_tags,category")
    .order("quote_grounded", { ascending: false })   // grounded evidence first
    .limit(fetchLimit);

  if (Array.isArray(evidence_ids) && evidence_ids.length) {
    q = q.in("evidence_id", evidence_ids);
  } else {
    q = q.in("category", cats);
    if (validSourceIds !== null) q = q.in("source_id", validSourceIds);
    if (query) {
      // Word-level matching, not whole-phrase (see extractSearchTerms): an
      // exact-substring ilike of a full question never matches; the regex also
      // strips chars that break PostgREST's .or() filter.
      const terms = extractSearchTerms(query, 8);
      if (terms.length) {
        const ors = [];
        for (const w of terms) ors.push(`fact.ilike.%${w}%`, `quote.ilike.%${w}%`);
        q = q.or(ors.join(","));
      }
    }
    if (Array.isArray(tags) && tags.length) {
      q = q.overlaps("technique_tags", tags);
    }
    if (grounded_only) q = q.eq("quote_grounded", true);
  }

  const [{ data: kwData, error }, vectorEvidenceIds] = await Promise.all([
    q,
    // Skip vector search for specific evidence_id lookups — those are exact fetches.
    (!Array.isArray(evidence_ids) || !evidence_ids.length)
      ? vectorSearchEvidence(query || "", cats, fetchLimit, validSourceIds).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Fetch full rows for vector-only IDs not already in the keyword results.
  // Never mutate the Supabase response — build a new merged array.
  const kwEvidenceIds  = new Set((kwData || []).map(e => e.evidence_id));
  const newVectorEvIds = vectorEvidenceIds.filter(id => !kwEvidenceIds.has(id));
  let vectorEvRows = [];
  if (newVectorEvIds.length) {
    const { data: vd } = await supabase
      .from("evidence")
      .select("evidence_id,source_id,fact,quote,quote_grounded,source_url,source_title,publisher,trust_tier,source_type,evidence_type,specificity,numbers,technique_tags,category")
      .in("evidence_id", newVectorEvIds);
    const rawVectorRows = vd || [];
    // Filter out evidence whose parent source is flagged for review — the vector
    // search path has no date bound so it can surface needs_review sources that
    // the keyword path already excludes.
    if (rawVectorRows.length) {
      const srcIds = [...new Set(rawVectorRows.map(r => r.source_id).filter(Boolean))];
      const { data: okSrcs } = await supabase
        .from("sources")
        .select("id")
        .in("id", srcIds)
        .not("needs_review", "is", true);
      const okSet = new Set((okSrcs || []).map(r => r.id));
      vectorEvRows = rawVectorRows.filter(r => okSet.has(r.source_id));
    }
  }

  // Vector results first so grounded keyword evidence (quote_grounded DESC) stays at top.
  const data = [...vectorEvRows, ...(kwData || [])];

  // AI-relevance filter — defence-in-depth against contaminated evidence rows that
  // slipped past the extraction-time filter. Evidence items with no AI/ML/agent
  // signal in their fact or quote AND no taxonomy tag are not surfaced to the chatbot.
  const AI_EV_KEYWORDS = [
    "ai ", " ai,", " ai.", "a.i.", "artificial intelligence",
    "machine learning", " ml ", "neural", "model", "llm", "language model",
    "gpt", "claude", "gemini", "openai", "anthropic", "agent", "mcp",
    "copilot", "agentic", "autonomous", "chatbot", "generative", "rag ",
    "embedding", "fine-tun", "prompt", "jailbreak", "deepfake", "adversarial",
    "hallucin", "inference", "training", "diffusion", "transformer",
    "vector database", "hugging face", "langchain", "ollama",
    "synthetic", "voice clon", "voice synthesis", "disinformation",
    "bot network", "influence operation", "generated image", "generated video",
    "generated audio", "fabricated", "automated phishing", "automated malware",
  ];
  function isEvidenceAiRelevant(ev) {
    if (ev.technique_tags?.length) return true;
    const text = `${ev.fact||""} ${ev.quote||""}`.toLowerCase();
    return AI_EV_KEYWORDS.some(kw => text.includes(kw));
  }

  // Apply a per-source diversity cap: at most 2 evidence items from any single
  // source URL (or publisher as fallback). Prevents one broad annual threat report
  // from supplying the majority of evidence items and causing its statistics to
  // appear repeatedly across answers for unrelated questions.
  function applyDiversityCap(items, cap = 2) {
    const seen = {};
    return items.filter(ev => {
      const key = ev.source_url || (ev.publisher || "unknown").toLowerCase().trim();
      seen[key] = (seen[key] || 0) + 1;
      return seen[key] <= cap;
    });
  }

  // Fallback to the deck blob if the table is unavailable or returns nothing for
  // specific deck evidence IDs (e.g. ev IDs that only exist in the latest deck).
  if ((error || !data?.length) && Array.isArray(evidence_ids) && evidence_ids.length) {
    const synth = await getDeckData();
    if (synth) {
      const index = buildEvidenceIndexFromDeck(synth);
      const items = evidence_ids.map(id => index[id]).filter(Boolean);
      if (items.length) {
        return {
          available: true, source: "deck", item_count: items.length,
          evidence_items: items.slice(0, 40).map(ev => ({
            evidence_id: ev.evidence_id, fact: ev.fact, quote: ev.quote?.slice(0, 300) || null,
            quote_grounded: ev.quote_grounded, source_url: ev.source_url, source_title: ev.source_title,
            publisher: ev.publisher, trust_tier: ev.trust_tier, evidence_type: ev.evidence_type,
            numbers: ev.numbers, category: ev.category,
          })),
        };
      }
    }
  }

  if (error) return { available: false, message: `get_evidence: ${error.message}` };

  const relevantItems = (data || []).filter(isEvidenceAiRelevant);
  const diverseItems  = applyDiversityCap(relevantItems).slice(0, Math.min(limit, 40));

  return {
    available:      true,
    source:         "live_corpus",
    item_count:     diverseItems.length,
    evidence_items: diverseItems.map(ev => ({
      evidence_id:   ev.evidence_id,
      fact:          ev.fact,
      quote:         ev.quote?.slice(0, 300) || null,
      quote_grounded: ev.quote_grounded,
      specificity:   ev.specificity,
      source_url:    ev.source_url,
      source_title:  ev.source_title,
      publisher:     ev.publisher,
      trust_tier:    ev.trust_tier,
      evidence_type: ev.evidence_type,
      numbers:       ev.numbers || [],
      technique_tags: ev.technique_tags || [],
      category:      ev.category,
    })),
  };
}

// ── Tool: search_temporal_insights ────────────────────────────────────────────

async function searchTemporalInsights({ query, categories, win = "month", date_from, date_to, limit = 20 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const embedding = await embedText(query);
  if (!embedding) return { available: false, message: "Embedding unavailable." };

  const { data, error } = await supabase.rpc("match_insights", {
    query_embedding:  embedding,
    match_threshold:  0.35,
    match_count:      limit,
    category_filter:  Array.isArray(categories) && categories.length ? categories : ALL_CATS,
    win_filter:       win || "month",
    date_from_filter: date_from ? new Date(date_from).toISOString() : null,
    date_to_filter:   date_to   ? new Date(date_to).toISOString()   : null,
  });
  if (error) return { available: false, message: error.message };
  if (!data?.length) return { available: true, windows: [], message: "No matching historical insights." };

  // Fetch all matched rows in one batch query keyed by window_key.
  const matchedWindowKeys = [...new Set(data.map(r => r.window_key))];
  const { data: rows } = await supabase
    .from("dashboard_insights")
    .select("window_key, category, points")
    .in("window_key", matchedWindowKeys)
    .neq("category", "_period_meta");

  // Lookup by "window_key::category" — no surrogate id exists.
  const rowMap = new Map(
    (rows || []).map(r => [`${r.window_key}::${r.category}`, r.points])
  );

  // RPC already ordered by created_at ASC — preserve chronological order.
  const windows = data.map(r => {
    const points = rowMap.get(`${r.window_key}::${r.category}`) || {};
    return {
      window_key:   r.window_key,
      window_label: r.window_label,
      win:          r.win,
      category:     r.category,
      similarity:   Math.round(r.similarity * 100) / 100,
      assessment:   points.assessment || "",
      insights:     (points.insights || []).slice(0, 3).map(i => ({
        insight:    i.insight    || "",
        confidence: i.confidence || "",
      })),
    };
  });

  return { available: true, window_count: windows.length, windows };
}

// ── Tool: trend_analysis ───────────────────────────────────────────────────────

async function trendAnalysis({ categories, weeks = 12 }) {
  const ALL_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
  const cats = Array.isArray(categories) && categories.length ? categories : ALL_CATS;
  const lookback = Math.min(Math.max(weeks, 4), 52);
  const since = new Date(Date.now() - lookback * 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("date_published,main_category,trust_tier,publisher")
    .in("main_category", cats)
    .eq("date_confidence", "exact")   // trend buckets sources BY DATE → authoritative dates only
    .gte("date_published", since)
    .not("validation_status", "eq", "reject")
    .not("needs_review", "is", true);

  if (error) throw new Error(`trend_analysis: ${error.message}`);

  // Count unique publishers per week rather than raw source count.
  // A single outlet publishing 5 articles in one week would otherwise
  // look like a spike but is really a publication cluster.
  const byCategory    = {};   // { cat: { week: count } }
  const pubsByWeek    = {};   // { cat: { week: Set<publisher> } }  — for cluster detection

  for (const s of (data || [])) {
    if (!s.date_published) continue;
    const week = isoWeek(s.date_published);
    if (!week) continue;
    const cat = s.main_category;
    const pub = (s.publisher || "unknown").toLowerCase().trim();

    if (!byCategory[cat]) byCategory[cat] = {};
    if (!pubsByWeek[cat])  pubsByWeek[cat]  = {};
    if (!pubsByWeek[cat][week]) pubsByWeek[cat][week] = new Set();

    // Each source still counted separately, but we track publisher diversity
    byCategory[cat][week] = (byCategory[cat][week] || 0) + 1;
    pubsByWeek[cat][week].add(pub);
  }

  const CATEGORY_LABELS = {
    traditional_ai_threats: "Traditional AI Threats",
    llm_threats:            "LLM Threats",
    agentic_ai_threats:     "Agentic AI Threats",
    ai_enabled_threats:     "AI-Enabled Threats",
  };

  const results = [];
  for (const [cat, weeks_data] of Object.entries(byCategory)) {
    const sorted = Object.entries(weeks_data).sort(([a],[b]) => a.localeCompare(b));
    const counts = sorted.map(([,c]) => c);
    const recent2  = counts.slice(-2).reduce((s,c) => s+c, 0) / 2;
    const baseline = counts.slice(0,-2).reduce((s,c) => s+c, 0) / Math.max(1, counts.length-2);
    const spike_detected = baseline > 0 && recent2 > baseline * 1.8;
    const trend_direction = counts.length >= 3
      ? (counts.slice(-3).reduce((s,c)=>s+c,0)/3 > counts.slice(0,3).reduce((s,c)=>s+c,0)/3 ? "increasing" : "decreasing")
      : "insufficient_data";

    // Detect single-publisher dominance in the spike window (last 2 weeks)
    const recentWeeks = sorted.slice(-2).map(([w]) => w);
    const recentPubCounts = recentWeeks.map(w => pubsByWeek[cat]?.[w]?.size || 0);
    const recentUniquePubs = new Set(recentWeeks.flatMap(w => [...(pubsByWeek[cat]?.[w] || [])])).size;
    const cluster_warning = spike_detected && recentUniquePubs === 1
      ? "Spike may be a single-publisher publication cluster — verify publisher diversity before treating as a trend signal"
      : null;

    results.push({
      category:        cat,
      label:           CATEGORY_LABELS[cat] || cat,
      total_sources:   counts.reduce((s,c)=>s+c,0),
      weekly_counts:   Object.fromEntries(sorted),
      spike_detected,
      recent_avg_per_week: Math.round(recent2 * 10) / 10,
      baseline_avg_per_week: Math.round(baseline * 10) / 10,
      trend_direction,
      recent_unique_publishers: recentUniquePubs,
      cluster_warning,
    });
  }

  return { weeks_analysed: lookback, categories: results };
}

// ── Tool: search_taxonomy ──────────────────────────────────────────────────────

async function searchTaxonomy({ tag, category, show_top_tags = false }) {
  const CATEGORY_LABELS = {
    traditional_ai_threats: "Traditional AI Threats",
    llm_threats:            "LLM Threats",
    agentic_ai_threats:     "Agentic AI Threats",
    ai_enabled_threats:     "AI-Enabled Threats",
  };

  if (show_top_tags || (!tag && !category)) {
    // Return category breakdown + top tags across corpus
    const { data, error } = await supabase
      .from("sources")
      .select("main_category,tags,trust_tier")
      .not("validation_status", "eq", "reject")
      .not("needs_review", "is", true)
      .not("main_category", "is", null);

    if (error) throw new Error(`search_taxonomy: ${error.message}`);

    const catCounts = {};
    const tagCounts = {};
    const tagByCat  = {};

    for (const s of (data || [])) {
      const cat = s.main_category;
      catCounts[cat] = (catCounts[cat] || 0) + 1;
      for (const t of (s.tags || [])) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
        if (!tagByCat[cat]) tagByCat[cat] = {};
        tagByCat[cat][t] = (tagByCat[cat][t] || 0) + 1;
      }
    }

    const categories = Object.entries(catCounts)
      .sort(([,a],[,b]) => b-a)
      .map(([c,n]) => ({ category: c, label: CATEGORY_LABELS[c]||c, source_count: n,
        top_tags: Object.entries(tagByCat[c]||{}).sort(([,a],[,b])=>b-a).slice(0,5).map(([t,n])=>({tag:t,count:n})) }));

    const top_tags = Object.entries(tagCounts)
      .sort(([,a],[,b]) => b-a)
      .slice(0, 25)
      .map(([tag, count]) => ({ tag, count }));

    return { total_sources: data.length, categories, top_tags };
  }

  if (tag) {
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,parent_title,url,publisher,date_published,main_category,trust_tier,summary,short_summary")
      .contains("tags", [tag])
      .not("validation_status", "eq", "reject")
      .not("needs_review", "is", true)
      .order("date_published", { ascending: false })
      .limit(20);

    if (error) throw new Error(`search_taxonomy tag: ${error.message}`);
    return {
      tag,
      source_count: data?.length || 0,
      sources: (data || []).map((s,i) => ({
        ref: `src-${i+1}`, title: s.parent_title || s.title, url: s.url,
        publisher: s.publisher, date: s.date_published?.slice(0,10),
        category: CATEGORY_LABELS[s.main_category]||s.main_category,
        trust_tier: s.trust_tier,
        summary: (s.short_summary||s.summary||"").slice(0,300),
      })),
    };
  }

  if (category) {
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,parent_title,url,publisher,date_published,tags,trust_tier,summary,short_summary")
      .eq("main_category", category)
      .not("validation_status", "eq", "reject")
      .not("needs_review", "is", true)
      .order("date_published", { ascending: false })
      .limit(30);

    if (error) throw new Error(`search_taxonomy category: ${error.message}`);

    const tagCounts = {};
    for (const s of (data||[])) {
      for (const t of (s.tags||[])) tagCounts[t] = (tagCounts[t]||0)+1;
    }

    return {
      category,
      label:        CATEGORY_LABELS[category] || category,
      source_count: data?.length || 0,
      top_tags:     Object.entries(tagCounts).sort(([,a],[,b])=>b-a).slice(0,15).map(([t,c])=>({tag:t,count:c})),
      recent_sources: (data||[]).slice(0,10).map((s,i)=>({
        ref: `src-${i+1}`, title: s.parent_title || s.title, url: s.url,
        publisher: s.publisher, date: s.date_published?.slice(0,10),
        trust_tier: s.trust_tier, tags: (s.tags||[]).slice(0,5),
        summary: (s.short_summary||s.summary||"").slice(0,250),
      })),
    };
  }

  return { error: "Provide tag, category, or set show_top_tags=true" };
}

// ── Tool: lookup_cve ───────────────────────────────────────────────────────────

async function lookupCve({ cve_ids }) {
  if (!Array.isArray(cve_ids) || cve_ids.length === 0) {
    return { error: "Provide an array of CVE IDs, e.g. [\"CVE-2024-12345\"]" };
  }

  const valid = cve_ids
    .filter(id => /^CVE-\d{4}-\d{4,}$/i.test((id || "").trim()))
    .slice(0, 5); // NVD free tier: 5 req / 30s

  if (valid.length === 0) {
    return { error: "No valid CVE IDs (expected format: CVE-YYYY-NNNNN)" };
  }

  const results = [];
  for (let i = 0; i < valid.length; i++) {
    const cveId = valid[i].toUpperCase();
    try {
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`;
      const nvdHeaders = { "User-Agent": "TheHorizon-ThreatIntel/1.0" };
      if (process.env.NVD_API_KEY) nvdHeaders["apiKey"] = process.env.NVD_API_KEY;
      const res = await fetch(url, {
        headers: nvdHeaders,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        results.push({ cve_id: cveId, error: `NVD HTTP ${res.status}` });
        continue;
      }

      const data = await res.json();
      const vuln = data.vulnerabilities?.[0]?.cve;

      if (!vuln) {
        const year = parseInt(cveId.split("-")[1], 10);
        const isRecent = year >= new Date().getFullYear();
        results.push({
          cve_id: cveId,
          found: false,
          note: isRecent
            ? "CVE not yet indexed in NVD — recently assigned IDs can take days to weeks to appear"
            : "CVE not found in NVD",
        });
        continue;
      }

      // Prefer CVSS v3.1 → 3.0 → 2.0
      const m31  = vuln.metrics?.cvssMetricV31?.[0];
      const m30  = vuln.metrics?.cvssMetricV30?.[0];
      const m2   = vuln.metrics?.cvssMetricV2?.[0];
      const best = m31 || m30;

      results.push({
        cve_id:         cveId,
        found:          true,
        description:    vuln.descriptions?.find(d => d.lang === "en")?.value?.slice(0, 400) || "",
        cvss_score:     best?.cvssData?.baseScore     ?? m2?.cvssData?.baseScore  ?? null,
        severity:       best?.cvssData?.baseSeverity  ?? (m2 ? cvssV2Severity(m2.cvssData?.baseScore) : null),
        cvss_version:   best ? (m31 ? "3.1" : "3.0") : (m2 ? "2.0" : null),
        vector_string:  best?.cvssData?.vectorString  ?? m2?.cvssData?.vectorString ?? null,
        exploitability: best?.cvssData?.exploitabilityScore ?? null,
        impact_score:   best?.impactScore ?? null,
        published:      vuln.published?.slice(0, 10)  ?? null,
        last_modified:  vuln.lastModified?.slice(0, 10) ?? null,
        nvd_url:        `https://nvd.nist.gov/vuln/detail/${cveId}`,
      });
    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.message?.includes("timeout");
      results.push({
        cve_id: cveId,
        error: isTimeout
          ? "NVD lookup timed out — the API is slow or the CVE is not yet indexed. Try again or check nvd.nist.gov directly."
          : err.message,
      });
    }

    // Small delay between requests to respect NVD rate limit
    if (i < valid.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  return {
    cve_count: results.length,
    results,
    note: "CVSS scores from NVD. Scores ≥9.0 = Critical, 7.0–8.9 = High, 4.0–6.9 = Medium, <4.0 = Low.",
  };
}

function cvssV2Severity(score) {
  if (score == null) return null;
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  return "LOW";
}

// ── Tool dispatch ──────────────────────────────────────────────────────────────

// Not currently wired for model-driven tool calling — api/agent.js uses the
// retrieval-first flow (retrieveRelevant + executeTool directly). These
// definitions are retained as a reference if tool-calling mode is added.
export const TOOLS = [
  {
    name:        "search_corpus",
    description: "Search ingested sources in the corpus. Returns title, URL, publisher, date, category, trust tier, tags, and summary for each source. Use for finding specific sources, filtering by category/tag/date, or checking coverage.",
    input_schema: {
      type: "object",
      properties: {
        categories:  { type: "array", items: { type: "string" }, description: "Filter by threat categories: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats. Empty = all." },
        query:       { type: "string", description: "Text search across title and summary" },
        tags:        { type: "array", items: { type: "string" }, description: "Filter by exact taxonomy tags, e.g. [\"LLM01_prompt_injection\"]" },
        date_from:   { type: "string", description: "ISO date lower bound YYYY-MM-DD, e.g. 2026-05-01. Always pair with date_to when asking about a specific month." },
        date_to:     { type: "string", description: "ISO date upper bound YYYY-MM-DD, e.g. 2026-05-31. Required when asking about a specific month or closed time window to avoid including newer sources." },
        trust_tiers: { type: "array", items: { type: "string" }, description: "Filter by trust: primary, high, medium, curated, low" },
        limit:       { type: "integer", description: "Max results (1-50)", default: 15 },
      },
    },
  },
  {
    name:        "get_judgments",
    description: "Get analytical judgments from the latest pipeline run (L6 analysis). Each judgment is a validated analytical conclusion with supporting evidence IDs, monitoring signals, and recommended actions. More reliable than raw sources for strategic claims.",
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Categories to fetch judgments for. Empty = all." },
      },
    },
  },
  {
    name:        "get_evidence",
    description: "Get grounded evidence items from the live corpus evidence base (~5,900 extracted facts spanning ~98% of sources). Each item has a verified fact, a verbatim quote from the source (when quote_grounded=true), specificity, source URL, publisher, and technique tags. Use this to back specific claims with quotable evidence and source links. Filter by category, free-text query (matches fact + quote), or technique tags. Prefer grounded_only=true when you need quotable proof.",
    input_schema: {
      type: "object",
      properties: {
        categories:   { type: "array", items: { type: "string" }, description: "Get evidence for these categories: traditional_ai_threats, llm_threats, agentic_ai_threats, ai_enabled_threats. Empty = all." },
        query:        { type: "string", description: "Free-text search across the fact and quote text, e.g. \"prompt injection\"" },
        tags:         { type: "array", items: { type: "string" }, description: "Filter by technique tags, e.g. [\"LLM01_prompt_injection\"]" },
        grounded_only:{ type: "boolean", description: "Only return evidence with a verbatim grounded quote (quote_grounded=true)" },
        evidence_ids: { type: "array", items: { type: "string" }, description: "Fetch these specific evidence IDs (e.g. ev-1a2b3c4d-1)" },
        limit:        { type: "integer", description: "Max items (1-40)", default: 25 },
      },
    },
  },
  {
    name:        "trend_analysis",
    description: "Analyse weekly source volume to detect trends and spikes. Returns per-category weekly counts, recent vs baseline averages, spike flags, and trend direction. Use for any question about increasing/decreasing activity or temporal patterns.",
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Categories to analyse. Empty = all." },
        weeks:      { type: "integer", description: "Look-back window in weeks (4-52)", default: 12 },
      },
    },
  },
  {
    name:        "search_taxonomy",
    description: "Explore taxonomy structure: browse by main category, find sources with a specific attack tag, or get a full tag distribution. Use to answer questions about what attack techniques are covered, which tags appear most, or what falls under a specific category.",
    input_schema: {
      type: "object",
      properties: {
        tag:           { type: "string", description: "Find all sources with this tag, e.g. LLM01_prompt_injection, AE01_deepfake_content, TAI01_adversarial_examples" },
        category:      { type: "string", description: "Explore this category: get top tags and recent sources" },
        show_top_tags: { type: "boolean", description: "Return top 25 tags + category breakdown for the whole corpus" },
      },
    },
  },
  {
    name:        "search_temporal_insights",
    description: "Search the historical record of per-category intelligence assessments to answer questions about how a threat has evolved over time. Returns chronologically ordered snapshots. Use for: 'how has X evolved', 'when did Y emerge', 'is Z escalating', 'compare Q1 vs Q3'.",
    input_schema: {
      type: "object",
      required: ["query"],
      properties: {
        query:      { type: "string",  description: "What aspect of threat evolution to search for." },
        categories: { type: "array",   items: { type: "string" }, description: "Limit to specific threat categories. Empty = all." },
        win:        { type: "string",  description: "'month' (default) | 'week' | 'quarter'" },
        date_from:  { type: "string",  description: "ISO date YYYY-MM-DD — insights generated after this date." },
        date_to:    { type: "string",  description: "ISO date YYYY-MM-DD — insights generated before this date." },
      },
    },
  },
  {
    name:        "lookup_cve",
    description: "Look up real-time CVE severity data from NVD (National Vulnerability Database). Returns CVSS v3 base score (0–10), severity rating (Critical/High/Medium/Low), exploitability score, attack vector string, and a link to the NVD page. Use whenever the user asks about CVE severity, CVSS scores, exploitability ranking, or when corpus sources mention specific CVE IDs and severity context is needed.",
    input_schema: {
      type: "object",
      required: ["cve_ids"],
      properties: {
        cve_ids: {
          type: "array",
          items: { type: "string" },
          description: "CVE IDs to look up, e.g. [\"CVE-2024-12345\", \"CVE-2025-67890\"]. Max 5 per call.",
        },
      },
    },
  },
];

export async function executeTool(name, input) {
  switch (name) {
    case "search_corpus":           return await searchCorpus(input || {});
    case "get_judgments":           return await getJudgments(input || {});
    case "get_evidence":            return await getEvidence(input || {});
    case "trend_analysis":          return await trendAnalysis(input || {});
    case "search_taxonomy":         return await searchTaxonomy(input || {});
    case "lookup_cve":              return await lookupCve(input || {});
    case "search_temporal_insights": return await searchTemporalInsights(input || {});
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── Evidence items for cited sources ──────────────────────────────────────────
// Fetch all extracted evidence items whose source_id matches one of the cited
// sources. These are verbatim-grounded atomic facts produced by the pipeline's
// Layer 5 extraction — far more specific than a truncated summary window.
// Used by the verifier so it can confirm claims like "144 packages" or "88-minute
// campaign" that live in the source body past a 1600-char summary truncation.
export async function fetchEvidenceForSources(sourceIds) {
  if (!sourceIds?.length) return [];
  const { data } = await supabase
    .from("evidence")
    .select("evidence_id,source_id,fact,quote,quote_grounded,source_url,source_title,publisher,trust_tier,evidence_type,numbers,technique_tags")
    .in("source_id", sourceIds)
    .order("quote_grounded", { ascending: false })
    .limit(60);
  return data || [];
}

// ── Evidence facts for candidate sources (selector enrichment) ────────────────
// Fetch up to 3 grounded evidence facts per candidate source so the selector LLM
// can see atomic facts extracted from the source body — beyond the 1000-char
// summary truncation. Ordered quote_grounded DESC globally; JS caller caps per source.
// Sources without completed L5 extraction return no rows (graceful degradation).
export async function fetchEvidenceForCandidates(sourceIds) {
  if (!sourceIds?.length) return [];
  const { data } = await supabase
    .from("evidence")
    .select("evidence_id,source_id,fact,quote_grounded")
    .in("source_id", sourceIds)
    .order("quote_grounded", { ascending: false })
    .limit(Math.min(sourceIds.length * 10, 400));
  return data || [];
}

// ── Full-text enrichment for selected sources ─────────────────────────────────
// After the selector picks 5-10 sources, fetch their full_text so the synthesis
// LLM gets the real article body (up to 2000 chars) instead of the 400-char
// summary stored at retrieval time. Digest children also pull parent text.
// Falls back to the existing summary if full_text is unavailable.
export async function enrichSourcesWithFullText(sourceRefs) {
  if (!sourceRefs?.length) return sourceRefs;
  const ids = sourceRefs.map(s => s.id).filter(Boolean);
  if (!ids.length) return sourceRefs;

  const { data: rows } = await supabase
    .from("sources")
    .select("id, full_text, parent_source_id")
    .in("id", ids);
  if (!rows?.length) return sourceRefs;

  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  // Fetch parent texts for thin children in one batch
  const parentIds = [...new Set(rows.map(r => r.parent_source_id).filter(Boolean))];
  const parentTexts = {};
  if (parentIds.length) {
    const { data: prows } = await supabase
      .from("sources")
      .select("id, full_text")
      .in("id", parentIds);
    for (const p of prows || []) parentTexts[p.id] = p.full_text || "";
  }

  return sourceRefs.map(s => {
    const row = byId[s.id];
    if (!row) return s;
    let text = row.full_text || "";
    // Supplement thin child text with parent body
    if (row.parent_source_id && text.length < 1000) {
      const parentText = parentTexts[row.parent_source_id] || "";
      if (parentText) text = text + "\n\n" + parentText;
    }
    if (!text || text.length <= (s.summary || "").length) return s;
    // Cap at 1000 chars (same as retrieval-time summary cap). Full-text enrichment
    // adds real article body vs. curated summary, but 2000 chars × 10+ sources
    // pushes synthesis input beyond the GovTech platform's effective context window,
    // causing silent empty responses. 1000 chars is still significantly richer than
    // the 400-char fmtSource summaries.
    return { ...s, summary: text.slice(0, 1000) };
  });
}
