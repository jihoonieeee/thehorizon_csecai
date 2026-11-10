/**
 * mapThreatActors.js — L4g enrich: fill the threats log's three actor columns
 * for one source — Threat Actor Type, Threat Actor, Country-nexus.
 *
 * Vocabulary: lib/config/threatActorVocabulary.json (the analysts' wording). The
 * model may propose a type that is not listed when none fits; it is kept but
 * flagged (type_status "new") so the analysts approve or correct it on review.
 *
 * One LLM call (task "actor_attribution", prompt understand/map-threat-actors.md),
 * then validation in code:
 *   - type: listed (or "Nation-state; Cybercriminal") → "listed"; unlisted but
 *     flagged new and in the log's "Base (qualifier)" pattern → "new"; anything
 *     else → "invalid"
 *   - a named actor is dropped when its name does not appear in the article
 *   - Threat Actor follows the type: attacker types list the named groups (more
 *     than 10 → "Multiple"), else "Unattributed"; AI system takes the model's
 *     description (required);
 *     Vendor research takes a description of the AI tool studied, else
 *     "N/A (vendor research)"; other types get their fixed value. Named groups
 *     on a type that should have none are flagged for review, not removed.
 *   - a country given only as a language ("Chinese-speaking") is dropped
 *   - a country with basis "article" needs a verbatim quote; basis
 *     "known_attribution" needs a surviving named actor
 *   - no-attacker types (AI system, Researcher, Vendor research/evaluation, N/A)
 *     → Country-nexus "N/A"; no surviving country → "Unknown"
 *
 * Nothing here writes to the database.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { normaliseForMatch, quoteInText, promptTextFor } from "./mapFrameworks.js";
import {
  ACTOR_TYPES, ACTOR_PLACEHOLDERS, MAX_NAMED_ACTORS, ACTOR_AI_SYSTEM, ACTOR_MULTIPLE, ACTOR_UNATTRIBUTED,
  COUNTRY_UNKNOWN, COUNTRY_NA,
  isNoAttackerType, isAttackerType, matchActorType, defaultActorValue, isWellFormedNewType, normaliseCountry,
} from "../../config/threatActors.js";

const CONFIDENCE = new Set(["high", "medium", "low"]);
const COUNTRY_BASIS = new Set(["article", "known_attribution"]);
// No-attacker types whose Threat Actor may be a description of the AI tool or model studied.
const DESCRIBED_NO_ATTACKER_TYPES = new Set(["Vendor research/evaluation"]);

/** True when the actor's name (or a "/"-separated alias, or the part before "(") is in the text. */
export function nameInText(name, normalisedText) {
  const raw = String(name || "");
  const variants = [raw, raw.split("(")[0], ...raw.split(/\s*\/\s*/)]
    .map(v => normaliseForMatch(v).replace(/^["'\s]+|["'\s]+$/g, ""))
    .filter(v => v.length >= 3);
  return variants.some(v => normalisedText.includes(v));
}

/** A quote without a prompt field label the model sometimes copies in ("Title: Russian Hacker…"). */
export function stripFieldLabel(quote) {
  return String(quote || "").trim().replace(/^(title|summary|full text)\s*:\s*/i, "");
}

/**
 * Turn the raw model output into the three column values.
 * → { threat_actor_type, type_status: "listed"|"new"|"invalid", threat_actor,
 *     named_actors: [{name, aliases, quote}], countries: [{country, basis, quote}],
 *     country_nexus, confidence, rationale, dropped: [{item, reason}], flags: [string] }
 */
export function validateActorMapping(raw, sourceText) {
  const text = normaliseForMatch(sourceText);
  const dropped = [];
  const flags = [];

  // Type
  const rawType = String(raw?.threat_actor_type || "").replace(/\s+/g, " ").trim();
  const listed = matchActorType(rawType);
  let typeStatus = listed ? "listed" : "invalid";
  if (!listed && rawType && isWellFormedNewType(rawType)) typeStatus = "new";
  if (typeStatus === "invalid") dropped.push({ item: `type "${rawType}"`, reason: "not a listed type and not in the log's \"Base (qualifier)\" pattern" });
  const type = listed || rawType;
  const noAttacker = isNoAttackerType(type);

  // Named actors: one entry per group; other names for the same group go in aliases.
  const named = [];
  const droppedNames = new Set();
  for (const a of Array.isArray(raw?.named_actors) ? raw.named_actors : []) {
    const name = String(a?.name || "").trim();
    if (!name || ACTOR_PLACEHOLDERS.some(p => p.toLowerCase() === name.toLowerCase())) continue;
    if (!nameInText(name, text)) { dropped.push({ item: `actor "${name}"`, reason: "name not found in the article" }); droppedNames.add(name.toLowerCase()); continue; }
    if (!named.some(n => n.name.toLowerCase() === name.toLowerCase())) {
      const aliases = (Array.isArray(a.aliases) ? a.aliases : []).map(x => String(x || "").trim()).filter(Boolean).slice(0, 8);
      const quote = stripFieldLabel(a.quote);
      named.push({ name, aliases, quote: quoteInText(quote, text) ? quote.slice(0, 300) : null });
    }
  }

  // The model's short description: used for AI system (required) and Vendor
  // research about an AI tool or model. Never for attackers — unnamed → "Unattributed".
  let description = String(raw?.threat_actor || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (ACTOR_PLACEHOLDERS.some(p => p.toLowerCase() === description.toLowerCase())) description = "";
  const descNames = description.split(";").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (descNames.length && descNames.every(n => droppedNames.has(n))) {
    dropped.push({ item: `threat actor "${description}"`, reason: "only names actors not found in the article" });
    description = "";
  }

  // Threat Actor cell: follows the type, so the two columns always correspond.
  let actor;
  if (type === ACTOR_AI_SYSTEM) {
    actor = description;
    if (!actor) flags.push(`"${type}" needs a short description of the model(s) as the Threat Actor`);
  } else if (isAttackerType(type)) {
    actor = named.length > MAX_NAMED_ACTORS ? ACTOR_MULTIPLE : named.map(n => n.name).join("; ") || defaultActorValue(type);
  } else {
    actor = (DESCRIBED_NO_ATTACKER_TYPES.has(type) && description) || defaultActorValue(type);
    if (named.length) flags.push(`"${type}" has no named attacker, but the model named ${named.map(n => n.name).join("; ")} — check the type`);
  }

  // Country-nexus
  const countries = [];
  for (const c of Array.isArray(raw?.countries) ? raw.countries : []) {
    const country = normaliseCountry(c?.country);
    const basis = COUNTRY_BASIS.has(c?.basis) ? c.basis : "article";
    const quote = stripFieldLabel(c?.quote);
    if (country === COUNTRY_UNKNOWN || country === COUNTRY_NA) continue;
    if (/speaking\s*$/i.test(String(c?.country || "").trim())) { dropped.push({ item: `country "${c.country}"`, reason: "a language is not a country attribution" }); continue; }
    if (noAttacker)                               { dropped.push({ item: `country "${country}"`, reason: `"${type}" has no real-world attacker → N/A` }); continue; }
    if (basis === "article" && !quoteInText(quote, text)) { dropped.push({ item: `country "${country}"`, reason: `quote not found in the article: "${quote.slice(0, 120)}"` }); continue; }
    if (basis === "known_attribution" && !named.length)     { dropped.push({ item: `country "${country}"`, reason: "known attribution but no named actor survived the checks" }); continue; }
    if (countries.some(x => x.country === country)) continue;
    countries.push({ country, basis, quote: basis === "article" ? quote.slice(0, 300) : null });
  }
  const countryNexus = noAttacker ? COUNTRY_NA : countries.map(c => c.country).join("; ") || COUNTRY_UNKNOWN;
  if (type === ACTOR_UNATTRIBUTED && countries.length) {
    flags.push(`"${type}" means nothing is known about the attacker, but the model found a country (${countryNexus}) — check the type`);
  }

  return {
    threat_actor_type: type,
    type_status:       typeStatus,
    threat_actor:      actor,
    named_actors:      named,
    countries:         noAttacker ? [] : countries,
    country_nexus:     countryNexus,
    confidence:        CONFIDENCE.has(raw?.confidence) ? raw.confidence : "medium",
    rationale:         String(raw?.rationale || "").trim().slice(0, 400) || null,
    dropped,
    flags,
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

// Stored on every row (source_threat_actors.prompt_version). Bump it with each
// history entry in the prompt file, so older tags can be found and re-tagged.
export const ACTOR_PROMPT_VERSION = "v5.2";

const PROMPT = loadPrompt("understand/map-threat-actors");
const SYSTEM = `${PROMPT.system}\n\nTYPE LIST\n${ACTOR_TYPES.join("\n")}`;

/**
 * Map one source. Never throws for LLM failure — returns { ok: false, error }.
 * @returns {Promise<{ ok, actors?, model?, error? }>}
 */
export async function mapSourceToThreatActors(source) {
  const { text, truncated } = promptTextFor(source);
  const summary = source.short_summary || source.summary || "";

  const user = interpolate(PROMPT.user, {
    title:           source.title || "",
    publisher:       source.publisher || "unknown",
    date:            String(source.date_published || "").slice(0, 10) || "unknown",
    source_type:     source.source_type || "unknown",
    main_category:   source.main_category || "unknown",
    summary,
    truncation_note: truncated ? " (truncated)" : "",
    text:            text || "(no full text — use the summary)",
  });

  const { result, llm_metadata } = await routedLLM(SYSTEM, user, {
    task: "actor_attribution",
    requires_json: true,
    logLabel: `map-actors ${String(source.id || "").slice(0, 8)}`,
  });
  if (!result || typeof result !== "object") {
    return { ok: false, error: llm_metadata?.error || "no JSON result from model" };
  }

  const groundText = [source.title, summary, text].filter(Boolean).join("\n");
  return { ok: true, model: llm_metadata?.model_used || null, actors: validateActorMapping(result, groundText) };
}
