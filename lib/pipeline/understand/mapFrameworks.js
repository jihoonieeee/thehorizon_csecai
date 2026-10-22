/**
 * mapFrameworks.js — L4g enrich: tag a source with MITRE ATT&CK Enterprise and
 * MITRE ATLAS techniques, or apply each framework's N/A rule.
 *
 * Rules (agreed with the analysts 2026-10-12, matching their threats log; see
 * docs/threat-intel-enrichment-plan.md §4.2):
 *   - every technique involved, at sub-technique level where the text supports it
 *   - ATT&CK tried for every source; N/A only for attacks on the model itself
 *   - ATLAS N/A when no technique fits because it is adversary use of AI
 *   - otherwise, nothing fits → blank (status "none")
 *
 * Per source:
 *   1. Hints (no LLM): nearest techniques by embedding (RPC
 *      match_techniques_for_source), widened to each candidate's parent and
 *      sibling sub-techniques, plus the IDs referenced by the source's taxonomy
 *      tags. These are shown WITH descriptions. The model may still pick any
 *      technique: the full live ID+name lists for both frameworks are appended to
 *      the system prompt (~9k tokens, identical every call so it caches). The
 *      Sept-2026 trial showed embedding search alone missed obvious answers
 *      (e.g. AML.T0024.002 for a model-distillation campaign).
 *   1b. Examples (no LLM, optional): the analysts' reviewed answers for the most
 *      similar already-reviewed sources (RPC match_review_examples, migration 031).
 *      Teaches the log's conventions by example, and lets an article about an
 *      already-reviewed incident carry that incident's analyst-recorded techniques
 *      (the log tags per incident, not per article — Aug 2026 review).
 *   2. One LLM call (task "framework_mapping", prompt understand/map-frameworks.md).
 *   3. Validation in code: catalogue check; each technique is grounded EITHER by a
 *      verbatim quote from this article OR by an example's analyst answer
 *      (basis "example": the ID must be in that example's recorded answer); parent
 *      dropped when its own sub-technique is tagged.
 *
 * ATT&CK covers Enterprise, Mobile and ICS (one "attack" framework, rows carry a
 * `domain`); see lib/frameworks/mitreCatalogue.js CATALOGUES.
 *
 * Nothing here writes to the database — see lib/storage/frameworkStore.js.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { PRIMARY_TAGS, SUB_TECHNIQUES } from "./taxonomy.js";
import { parseFrameworkRef, CATALOGUES, CATALOGUE_KEYS, catalogueKey } from "../../frameworks/mitreCatalogue.js";
import { fetchReviewExamples } from "../../storage/frameworkStore.js";
import { NA_TEXT, domainSuffix } from "../../frameworks/sourceTags.js";

// Shared with the Sources page read path (lib/frameworks/sourceTags.js).
export { NA_TEXT, domainSuffix };

export const FRAMEWORKS = ["attack", "atlas"];

const K = { atlas: 25, attack: 15 };     // nearest-neighbour candidates before widening
const MAX_TEXT_CHARS = 15000;
const CONFIDENCE = new Set(["high", "medium", "low"]);
const STATUS = new Set(["tagged", "not_applicable", "none"]);

// ── Catalogue ─────────────────────────────────────────────────────────────────

/**
 * Load every live technique + tactic names once per run.
 * → { byId: Map, children: Map<parentId, id[]>, tacticName: Map,
 *     versions: { atlas, attack } (attack lists every ATT&CK domain's version),
 *     versionsByKey: { atlas, attack, attack_mobile, attack_ics } }
 */
export async function loadTechniqueCatalogue(supabase) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("framework_techniques")
      .select("technique_id,framework,domain,name,description,parent_id,tactic_ids,framework_version")
      .eq("deprecated", false)
      .order("technique_id")
      .range(from, from + 999);
    if (error) throw new Error(`framework_techniques: ${error.message} (have migrations 029 + 031 been applied and the sync run?)`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  if (!rows.length) throw new Error("framework_techniques is empty — run scripts/syncFrameworkReference.js first");

  const { data: tactics, error: tErr } = await supabase.from("framework_tactics").select("tactic_id,name");
  if (tErr) throw new Error(`framework_tactics: ${tErr.message}`);

  const byId = new Map(rows.map(r => [r.technique_id, r]));
  const children = new Map();
  for (const r of rows) {
    if (!r.parent_id) continue;
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r.technique_id);
  }
  const versionsByKey = {};
  for (const r of rows) versionsByKey[catalogueKey(r.framework, r.domain)] ??= r.framework_version;
  const versions = {
    atlas:  versionsByKey.atlas || null,
    attack: CATALOGUE_KEYS.filter(k => CATALOGUES[k].framework === "attack" && versionsByKey[k]).map(k => versionsByKey[k]).join(", ") || null,
  };

  return { byId, children, tacticName: new Map(tactics.map(t => [t.tactic_id, t.name])), versions, versionsByKey };
}

// ── Candidates ────────────────────────────────────────────────────────────────

const TAXONOMY_ENTRIES = new Map([...PRIMARY_TAGS, ...SUB_TECHNIQUES].map(e => [e.id, e]));

/** MITRE IDs referenced by a source's taxonomy tags (framework_refs). */
export function tagRefIds(tags) {
  const out = { atlas: new Set(), attack: new Set() };
  for (const tag of tags || []) {
    for (const ref of TAXONOMY_ENTRIES.get(tag)?.framework_refs || []) {
      const p = parseFrameworkRef(ref);
      if (p) out[p.framework].add(p.technique_id);
    }
  }
  return out;
}

/** Add each ID's parent and all of that parent's sub-techniques, so the model can go one level deeper. */
export function widenFamilies(ids, catalogue) {
  const out = new Set();
  for (const id of ids) {
    const t = catalogue.byId.get(id);
    if (!t) continue;
    const root = t.parent_id || id;
    if (catalogue.byId.has(root)) out.add(root);
    for (const child of catalogue.children.get(root) || []) out.add(child);
    out.add(id);
  }
  return out;
}

async function nearestTechniques(supabase, source, framework, k, queryEmbedding) {
  if (!queryEmbedding && source.id) {
    const { data, error } = await supabase.rpc("match_techniques_for_source", {
      p_source_id: source.id, framework_filter: framework, match_count: k,
    });
    // PGRST202 = function not found: migration 030 not applied yet (allowed for
    // --dry-run trials) — fall through to embedding the text instead.
    if (error && error.code !== "PGRST202") throw new Error(`match_techniques_for_source: ${error.message}`);
    if (data?.length) return data.map(r => r.technique_id);
  }
  if (!queryEmbedding) return null;   // caller embeds the text and retries
  const { data, error } = await supabase.rpc("match_framework_techniques", {
    query_embedding: queryEmbedding, framework_filter: framework, match_count: k,
  });
  if (error) throw new Error(`match_framework_techniques: ${error.message}`);
  return (data || []).map(r => r.technique_id);
}

/**
 * → { attack: string[], atlas: string[], retrieval: "stored_embedding"|"embedded_now"|"tags_only" }
 */
export async function retrieveCandidates(supabase, source, catalogue) {
  const refs = tagRefIds(source.tags);
  const nearest = {};
  let retrieval = "stored_embedding";

  for (const fw of FRAMEWORKS) nearest[fw] = await nearestTechniques(supabase, source, fw, K[fw], null);

  if (FRAMEWORKS.some(fw => !nearest[fw])) {
    // No stored embedding (e.g. eval inputs) — embed the text now.
    const { embedText, sourceEmbedInput } = await import("../../agent/embeddings.js");
    const input = sourceEmbedInput(source) || `${source.title || ""}. ${(source.full_text || "").slice(0, 2000)}`;
    const vec = await embedText(input);
    retrieval = vec ? "embedded_now" : "tags_only";
    for (const fw of FRAMEWORKS) {
      if (!nearest[fw]) nearest[fw] = vec ? await nearestTechniques(supabase, source, fw, K[fw], vec) : [];
    }
  }

  const out = { retrieval };
  for (const fw of FRAMEWORKS) {
    const ids = widenFamilies([...nearest[fw], ...refs[fw]], catalogue);
    out[fw] = [...ids]
      .filter(id => catalogue.byId.get(id)?.framework === fw)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }
  return out;
}

function firstSentence(text, max = 180) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const cut = s.search(/(?<=[.!?])\s/);
  const one = cut > 0 ? s.slice(0, cut) : s;
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/**
 * Full ID + name list for every catalogue (ATLAS, ATT&CK Enterprise / Mobile / ICS),
 * sub-techniques indented under their parent, tactics on parent lines. Appended
 * to the system prompt.
 */
export function formatTechniqueLists(catalogue) {
  const blocks = CATALOGUE_KEYS.map(key => {
    const { framework, domain, label } = CATALOGUES[key];
    const ts = [...catalogue.byId.values()]
      .filter(t => t.framework === framework && (t.domain || null) === domain)
      .sort((a, b) => a.technique_id.localeCompare(b.technique_id, "en", { numeric: true }));
    if (!ts.length) return null;
    const lines = ts.map(t => t.parent_id
      ? `  ${t.technique_id} ${t.name}`
      : `${t.technique_id} ${t.name} [${(t.tactic_ids || []).map(x => catalogue.tacticName.get(x) || x).join(", ")}]`);
    const version = catalogue.versionsByKey?.[key] || "";
    return `${label.toUpperCase()} TECHNIQUES (${version})\n${lines.join("\n")}`;
  }).filter(Boolean);
  return `TECHNIQUE LISTS — choose IDs only from these. In the "attack" answer, Enterprise, Mobile and ICS IDs may be mixed.\n\n${blocks.join("\n\n")}`;
}

export function formatCandidates(ids, catalogue) {
  return ids.map(id => {
    const t = catalogue.byId.get(id);
    const parent = t.parent_id ? catalogue.byId.get(t.parent_id) : null;
    const tactics = (t.tactic_ids || []).map(x => catalogue.tacticName.get(x) || x).join(", ");
    const name = parent ? `${parent.name}: ${t.name}` : t.name;
    return `${id} | ${name}${domainSuffix(t)} | ${tactics} | ${firstSentence(t.description)}`;
  }).join("\n") || "(none)";
}

// ── Analyst examples ──────────────────────────────────────────────────────────

/** Display one recorded analyst answer: technique list, the N/A text, or "(blank)". */
function answerText(fw, answer, catalogue) {
  if (!answer) return "(not reviewed)";
  if (answer.outcome === "not_applicable") return NA_TEXT[fw];
  if (answer.outcome === "none" || !answer.technique_ids?.length) return "(blank)";
  return answer.technique_ids.map(id => {
    const t = catalogue.byId.get(id);
    return t ? `${id} ${t.name}${domainSuffix(t)}` : id;
  }).join("; ");
}

/** Examples labelled E1..En for the prompt. */
export function formatExamples(examples, catalogue) {
  if (!examples?.length) return "(none available)";
  return examples.map((e, i) => [
    `[E${i + 1}] similarity ${Number(e.similarity).toFixed(2)} — "${e.title}"`,
    `     Summary: ${String(e.summary || "").replace(/\s+/g, " ").slice(0, 300)}`,
    `     Analysts' ATT&CK: ${answerText("attack", e.answers.attack, catalogue)}`,
    `     Analysts' ATLAS:  ${answerText("atlas", e.answers.atlas, catalogue)}`,
  ].join("\n")).join("\n\n");
}

// ── Quote grounding ───────────────────────────────────────────────────────────

function normaliseForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote (≥15 chars) appears in the text, ignoring case, whitespace and quote-mark style. */
export function quoteInText(quote, normalisedText) {
  const q = normaliseForMatch(quote).replace(/^["'…\s]+|["'…\s]+$/g, "");
  if (q.length < 15) return false;
  if (normalisedText.includes(q)) return true;
  // Tolerate a model that trims or adds a few characters at the end of a long quote.
  return q.length >= 60 && normalisedText.includes(q.slice(0, 60));
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Turn the raw model output into the stored outcome for each framework.
 * → { attack: Outcome, atlas: Outcome }
 *   Outcome { status, na_reason, techniques: [{technique_id, confidence, quote, rationale,
 *             framework_version, basis, example_source_id}], dropped: [{id, reason}] }
 *
 * A technique is grounded by a verbatim quote from this article (basis "article"),
 * or — when the model says this article reports the same incident as example En —
 * by that example's analyst-recorded answer (basis "example"; quote is null).
 */
export function validateMapping(raw, catalogue, sourceText, examples = []) {
  const text = normaliseForMatch(sourceText);
  const out = {};

  for (const fw of FRAMEWORKS) {
    const block = raw?.[fw] || {};
    const modelStatus = STATUS.has(block.status) ? block.status : null;
    const kept = new Map();
    const dropped = [];

    for (const item of Array.isArray(block.techniques) ? block.techniques : []) {
      const id = String(item?.id || "").trim().toUpperCase();
      const t = catalogue.byId.get(id);
      if (!t || t.framework !== fw)          { dropped.push({ id, reason: "not a live technique in this framework" }); continue; }
      if (kept.has(id)) continue;
      const base = {
        technique_id:      id,
        confidence:        CONFIDENCE.has(item.confidence) ? item.confidence : "medium",
        rationale:         String(item.rationale || "").trim().slice(0, 300) || null,
        framework_version: t.framework_version || null,
      };

      if (item.basis === "example") {
        const n = parseInt(String(item.example || "").replace(/\D/g, ""), 10);
        const ex = examples[n - 1];
        const recorded = ex?.answers?.[fw];
        if (!ex)                                              { dropped.push({ id, reason: `example "${item.example}" not provided` }); continue; }
        if (!recorded?.technique_ids?.includes(id))           { dropped.push({ id, reason: `not in the analysts' answer for example ${item.example}` }); continue; }
        kept.set(id, {
          ...base, quote: null, basis: "example", example_source_id: ex.source_id,
          rationale: `Same incident as analyst-reviewed source "${String(ex.title).slice(0, 120)}"${base.rationale ? ` — ${base.rationale}` : ""}`.slice(0, 300),
        });
        continue;
      }

      if (!quoteInText(item.quote, text))    { dropped.push({ id, reason: "quote not found in the source text", quote: String(item.quote || "").slice(0, 200) }); continue; }
      kept.set(id, { ...base, quote: String(item.quote).trim().slice(0, 500), basis: "article", example_source_id: null });
    }

    // A parent and its own sub-technique for the same source: keep the specific one.
    for (const id of [...kept.keys()]) {
      const parent = catalogue.byId.get(id).parent_id;
      if (parent && kept.has(parent)) {
        kept.delete(parent);
        dropped.push({ id: parent, reason: `parent of tagged sub-technique ${id}` });
      }
    }

    const techniques = [...kept.values()];
    let status;
    if (modelStatus === "not_applicable" || modelStatus === "none") {
      status = modelStatus;
      for (const t of techniques) dropped.push({ id: t.technique_id, reason: `listed under status "${modelStatus}"` });
    } else {
      status = techniques.length ? "tagged" : "none";
    }

    out[fw] = {
      status,
      na_reason:  status === "not_applicable" ? NA_TEXT[fw] : null,
      techniques: status === "tagged" ? techniques : [],
      dropped,
      model_status: modelStatus,
    };
  }
  return out;
}

// ── Main entry ────────────────────────────────────────────────────────────────

const PROMPT = loadPrompt("understand/map-frameworks");

export function promptTextFor(source) {
  const full = String(source.full_text || source.clean_text || "");
  const text = full.slice(0, MAX_TEXT_CHARS);
  return { text, truncated: full.length > MAX_TEXT_CHARS };
}

/**
 * Map one source. Never throws for LLM failure — returns { ok: false, error }.
 * @param {object} [opts.examples]  { k, batches } — show the analysts' answers for the
 *        k most similar reviewed sources (batches limits which reviews; null = all).
 *        Omit or k = 0 for no examples.
 * @returns {Promise<{ ok, mapping?, candidates?, examples?, model?, error? }>}
 */
export async function mapSourceToFrameworks(source, { supabase, catalogue, examples: exampleOpts = null }) {
  const candidates = await retrieveCandidates(supabase, source, catalogue);
  const examples = exampleOpts?.k > 0 && source.id
    ? await fetchReviewExamples(supabase, source.id, exampleOpts.k, exampleOpts.batches || null)
    : [];
  const { text, truncated } = promptTextFor(source);
  const summary = source.short_summary || source.summary || "";

  const user = interpolate(PROMPT.user, {
    title:             source.title || "",
    publisher:         source.publisher || "unknown",
    date:              String(source.date_published || "").slice(0, 10) || "unknown",
    source_type:       source.source_type || "unknown",
    main_category:     source.main_category || "unknown",
    tags:              (source.tags || []).join(", ") || "none",
    summary,
    truncation_note:   truncated ? ` (first ${MAX_TEXT_CHARS} characters)` : "",
    text:              text || "(no full text — use the summary)",
    attack_candidates: formatCandidates(candidates.attack, catalogue),
    atlas_candidates:  formatCandidates(candidates.atlas, catalogue),
    examples:          formatExamples(examples, catalogue),
  });

  catalogue.systemPrompt ??= `${PROMPT.system}\n\n${formatTechniqueLists(catalogue)}`;
  const { result, llm_metadata } = await routedLLM(catalogue.systemPrompt, user, {
    task: "framework_mapping",
    requires_json: true,
    logLabel: `map-frameworks ${String(source.id || "").slice(0, 8)}`,
  });
  if (!result || typeof result !== "object") {
    return { ok: false, candidates, examples, error: llm_metadata?.error || "no JSON result from model" };
  }

  // Quotes are checked against everything the model was shown.
  const groundText = [source.title, summary, text].filter(Boolean).join("\n");
  return {
    ok: true,
    candidates,
    examples,
    model: llm_metadata?.model_used || null,
    mapping: validateMapping(result, catalogue, groundText, examples),
  };
}
