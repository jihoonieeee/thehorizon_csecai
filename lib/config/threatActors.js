/**
 * threatActors.js — vocabulary for the threats log's three actor columns:
 * Threat Actor Type, Threat Actor, Country-nexus.
 *
 * The values live in threatActorVocabulary.json (the analysts' own wording) so a
 * new type is a data edit, not a code change. Each type has a fixed Threat Actor
 * value (or named groups, for attacker types) so the two columns correspond. Used by
 * lib/pipeline/understand/mapThreatActors.js.
 */

import { readFileSync } from "fs";

const VOCAB = JSON.parse(readFileSync(new URL("./threatActorVocabulary.json", import.meta.url), "utf8"));

export const ACTOR_TYPES        = VOCAB.actor_types;
export const ATTACKER_TYPES     = VOCAB.attacker_types;
export const ACTOR_PLACEHOLDERS = VOCAB.actor_placeholders;
export const MAX_NAMED_ACTORS   = VOCAB.max_named_actors;
export const ACTOR_AI_SYSTEM    = "AI system (no human attacker)";
export const ACTOR_UNATTRIBUTED = "Unattributed";
export const ACTOR_MULTIPLE     = "Multiple";
export const COUNTRY_UNKNOWN    = "Unknown";
export const COUNTRY_NA         = "N/A";

const NO_ATTACKER_PREFIXES = VOCAB.no_attacker_type_prefixes.map(p => p.toLowerCase());
const NEW_TYPE_BASES = ["cybercriminal", "nation-state", "hacktivist", "insider"];

/**
 * True for types with no real-world attacker (AI system, research, vendor work,
 * N/A). Country-nexus is always "N/A" for these. Matched by prefix so a new
 * qualifier such as "N/A (red-team exercise)" follows the same rule.
 */
export function isNoAttackerType(type) {
  const t = String(type || "").trim().toLowerCase();
  return NO_ATTACKER_PREFIXES.some(p => t.startsWith(p));
}

/** True for types whose Threat Actor cell names groups (Nation-state, Cybercriminal, a new attacker type). */
export function isAttackerType(type) {
  return !!String(type || "").trim() && !isNoAttackerType(type) && type !== ACTOR_UNATTRIBUTED;
}

/**
 * The listed type matching `type` (ignoring case and spacing), or null. Two
 * attacker types joined with ";" match too, returned in list order
 * ("cybercriminal; nation-state" → "Nation-state; Cybercriminal").
 */
export function matchActorType(type) {
  const parts = String(type || "").split(";").map(p => p.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  if (parts.length === 1) return ACTOR_TYPES.find(t => t.toLowerCase() === parts[0]) || null;
  if (parts.length !== 2 || parts[0] === parts[1]) return null;
  const matched = ATTACKER_TYPES.filter(t => parts.includes(t.toLowerCase()));
  return matched.length === 2 ? matched.join("; ") : null;
}

/** Threat Actor value for `type` when no group is named. */
export function defaultActorValue(type) {
  return VOCAB.actor_value_by_type[type] ?? (isNoAttackerType(type) ? "N/A" : ACTOR_UNATTRIBUTED);
}

/**
 * A proposed new type must follow the log's pattern: a known base
 * (Cybercriminal, Nation-state, Hacktivist, Insider, two joined with ";", or a
 * no-attacker base) with an optional "(qualifier)".
 */
export function isWellFormedNewType(type) {
  const t = String(type || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([^()]+?)(?: \(([^()]{2,60})\))?$/);
  if (!m) return false;
  const base = m[1].toLowerCase();
  const parts = base.split(";").map(b => b.trim());
  return (parts.length <= 2 && parts.every(b => NEW_TYPE_BASES.includes(b))) || isNoAttackerType(base);
}

// Common alternative spellings → the short English name used in the log.
const COUNTRY_ALIASES = new Map(Object.entries({
  "prc": "China", "people's republic of china": "China", "chinese": "China",
  "dprk": "North Korea", "democratic people's republic of korea": "North Korea", "north korean": "North Korea",
  "russian federation": "Russia", "russian": "Russia",
  "iranian": "Iran", "islamic republic of iran": "Iran", "persian": "Iran",
  "vietnamese": "Vietnam", "pakistani": "Pakistan", "indian": "India", "turkish": "Turkey",
  "belarusian": "Belarus", "ukrainian": "Ukraine", "nigerian": "Nigeria", "brazilian": "Brazil",
  "rok": "South Korea", "republic of korea": "South Korea",
  "usa": "United States", "us": "United States", "u.s.": "United States", "united states of america": "United States",
  "uk": "United Kingdom", "great britain": "United Kingdom",
  "unknown": COUNTRY_UNKNOWN, "unattributed": COUNTRY_UNKNOWN,
  "n/a": COUNTRY_NA, "na": COUNTRY_NA, "not applicable": COUNTRY_NA,
}));

/** Normalise one country name to the log's spelling ("PRC-nexus" → "China", "Chinese-speaking" → "China"). */
export function normaliseCountry(name) {
  const s = String(name || "").trim().replace(/[-\s]+(nexus|linked|affiliated|based|backed|speaking)$/i, "");
  if (!s) return COUNTRY_UNKNOWN;
  return COUNTRY_ALIASES.get(s.toLowerCase()) || s.replace(/\b\w/g, c => c.toUpperCase());
}
