import { test } from "node:test";
import assert from "node:assert/strict";
import { validateActorMapping, nameInText } from "../lib/pipeline/understand/mapThreatActors.js";
import { normaliseForMatch } from "../lib/pipeline/understand/mapFrameworks.js";
import {
  ACTOR_TYPES, isNoAttackerType, matchActorType, isWellFormedNewType, normaliseCountry,
} from "../lib/config/threatActors.js";

const TEXT = `Google's threat intelligence group said the activity was carried out by a China-nexus
group it tracks as UNC2814. Separately, Forest Blizzard used the model for reconnaissance.`;

// ── Vocabulary ────────────────────────────────────────────────────────────────

test("vocabulary has the analysts' 7 types, matched ignoring case and spacing", () => {
  assert.equal(ACTOR_TYPES.length, 7);
  assert.equal(matchActorType("nation-state"), "Nation-state");
  assert.equal(matchActorType("vendor  research/evaluation"), "Vendor research/evaluation");
  assert.equal(matchActorType("Hacktivist"), null);
});

test("only Nation-state and Cybercriminal combine, in list order", () => {
  assert.equal(matchActorType("cybercriminal; nation-state"), "Nation-state; Cybercriminal");
  assert.equal(matchActorType("Nation-state; Cybercriminal"), "Nation-state; Cybercriminal");
  assert.equal(matchActorType("Researcher; Cybercriminal"), null);
  assert.equal(matchActorType("Nation-state; Nation-state"), null);
});

test("no-attacker types are matched by prefix, so new qualifiers follow the rule", () => {
  for (const t of ["AI system (no human attacker)", "Researcher", "Vendor research/evaluation", "N/A",
                   "N/A (red-team exercise)"]) assert.ok(isNoAttackerType(t), t);
  for (const t of ["Nation-state", "Cybercriminal", "Unattributed", "Nation-state; Cybercriminal"]) assert.ok(!isNoAttackerType(t), t);
});

test("a new type must follow the log's Base (qualifier) pattern", () => {
  assert.ok(isWellFormedNewType("Hacktivist"));
  assert.ok(isWellFormedNewType("Cybercriminal (extortion)"));
  assert.ok(isWellFormedNewType("Nation-state; hacktivist"));
  assert.ok(!isWellFormedNewType("Nation-state; hacktivist; insider"));
  assert.ok(!isWellFormedNewType("Some random thing"));
  assert.ok(!isWellFormedNewType("Cybercriminal (a) (b)"));
});

test("country names are normalised to the log's spelling", () => {
  assert.equal(normaliseCountry("PRC-nexus"), "China");
  assert.equal(normaliseCountry("DPRK"), "North Korea");
  assert.equal(normaliseCountry("russian"), "Russia");
  assert.equal(normaliseCountry("iran"), "Iran");
  assert.equal(normaliseCountry("Chinese-speaking"), "China");
  assert.equal(normaliseCountry("Russian speaking"), "Russia");
  assert.equal(normaliseCountry(""), "Unknown");
});

test("actor names are found in the text, including '/' aliases and before a bracket", () => {
  const t = normaliseForMatch(TEXT);
  assert.ok(nameInText("UNC2814", t));
  assert.ok(nameInText("UNC2814 (PRC-nexus)", t));
  assert.ok(nameInText("APT28 / Forest Blizzard", t));
  assert.ok(!nameInText("APT41", t));
});

// ── Validation ────────────────────────────────────────────────────────────────

test("a listed type with a quoted country is kept", () => {
  const a = validateActorMapping({
    threat_actor_type: "Nation-state", threat_actor: "UNC2814",
    named_actors: [{ name: "UNC2814", quote: "group it tracks as UNC2814" }],
    countries: [{ country: "China", basis: "article", quote: "carried out by a China-nexus group" }],
    confidence: "high",
  }, TEXT);
  assert.equal(a.type_status, "listed");
  assert.equal(a.threat_actor, "UNC2814");
  assert.equal(a.country_nexus, "China");
  assert.deepEqual(a.dropped, []);
});

test("a country whose quote is not in the article is removed → Unknown", () => {
  const a = validateActorMapping({
    threat_actor_type: "Nation-state", threat_actor: "UNC2814",
    named_actors: [{ name: "UNC2814" }],
    countries: [{ country: "Iran", basis: "article", quote: "an Iranian group was behind it all" }],
  }, TEXT);
  assert.equal(a.country_nexus, "Unknown");
  assert.match(a.dropped[0].reason, /quote not found/);
});

test("known attribution needs a named actor that survived the checks", () => {
  const kept = validateActorMapping({
    threat_actor_type: "Nation-state", threat_actor: "Forest Blizzard",
    named_actors: [{ name: "Forest Blizzard" }],
    countries: [{ country: "Russia", basis: "known_attribution" }],
  }, TEXT);
  assert.equal(kept.country_nexus, "Russia");
  assert.equal(kept.countries[0].quote, null);

  const gone = validateActorMapping({
    threat_actor_type: "Nation-state", threat_actor: "APT41",
    named_actors: [{ name: "APT41" }],
    countries: [{ country: "China", basis: "known_attribution" }],
  }, TEXT);
  assert.equal(gone.threat_actor, "Unattributed");
  assert.equal(gone.country_nexus, "Unknown");
  assert.equal(gone.named_actors.length, 0);
});

test("no-attacker types always get Country-nexus N/A", () => {
  for (const type of ["Researcher", "Vendor research/evaluation", "N/A"]) {
    const a = validateActorMapping({
      threat_actor_type: type,
      countries: [{ country: "China", basis: "article", quote: "carried out by a China-nexus group" }],
    }, TEXT);
    assert.equal(a.country_nexus, "N/A", type);
    assert.equal(a.countries.length, 0, type);
  }
});

test("Threat Actor follows the type when there is no description", () => {
  const cell = type => validateActorMapping({ threat_actor_type: type, threat_actor: "" }, TEXT).threat_actor;
  assert.equal(cell("Nation-state"), "Unattributed");
  assert.equal(cell("Cybercriminal"), "Unattributed");
  assert.equal(cell("Nation-state; Cybercriminal"), "Unattributed");
  assert.equal(cell("Unattributed"), "Unattributed");
  assert.equal(cell("Researcher"), "N/A (research)");
  assert.equal(cell("Vendor research/evaluation"), "N/A (vendor research)");
  assert.equal(cell("N/A"), "N/A");
});

test("a description is used only for AI system and Vendor AI tools, never for attackers", () => {
  const cell = (type, d) => validateActorMapping({ threat_actor_type: type, threat_actor: d }, TEXT).threat_actor;
  assert.equal(cell("Nation-state", "Russia-linked influence operation"), "Unattributed");
  assert.equal(cell("Cybercriminal", "lone actor using AI-assisted workflows"), "Unattributed");
  assert.equal(cell("Vendor research/evaluation", "NOVA (autonomous discovery system)"), "NOVA (autonomous discovery system)");
  assert.equal(cell("Researcher", "some paper"), "N/A (research)");
  assert.equal(cell("Unattributed", "someone"), "Unattributed");
  assert.equal(cell("N/A", "something"), "N/A");
});

test("a named group wins over the description; aliases stay out of the cell", () => {
  const a = validateActorMapping({
    threat_actor_type: "Nation-state", threat_actor: "China-linked operator",
    named_actors: [{ name: "UNC2814", aliases: ["Some Panda"] }],
  }, TEXT);
  assert.equal(a.threat_actor, "UNC2814");
  assert.deepEqual(a.named_actors[0].aliases, ["Some Panda"]);
});

test("a quote that copies the prompt's field label still matches the article", () => {
  const a = validateActorMapping({
    threat_actor_type: "Cybercriminal",
    countries: [{ country: "Russia", basis: "article", quote: "Title: Russian Hacker Turns Jailbroken Claude Into Pentest Platform" }],
  }, "Russian Hacker Turns Jailbroken Claude Into Pentest Platform\nThe actor sells access.");
  assert.equal(a.country_nexus, "Russia");
  assert.equal(a.countries[0].quote, "Russian Hacker Turns Jailbroken Claude Into Pentest Platform");
});

test("a language is not a country", () => {
  const a = validateActorMapping({
    threat_actor_type: "Cybercriminal",
    countries: [{ country: "Chinese-speaking", basis: "article", quote: "carried out by a China-nexus group" }],
  }, TEXT);
  assert.equal(a.country_nexus, "Unknown");
  assert.match(a.dropped[0].reason, /language/);
});

test("a country on an Unattributed row is flagged", () => {
  const a = validateActorMapping({
    threat_actor_type: "Unattributed",
    countries: [{ country: "China", basis: "article", quote: "carried out by a China-nexus group" }],
  }, TEXT);
  assert.equal(a.country_nexus, "China");
  assert.match(a.flags[0], /country/);
});

test("AI system keeps the model's description, and is flagged without one", () => {
  const a = validateActorMapping({
    threat_actor_type: "AI system (no human attacker)", threat_actor: "Frontier models (cryptanalysis benchmark)",
  }, TEXT);
  assert.equal(a.threat_actor, "Frontier models (cryptanalysis benchmark)");
  assert.equal(a.country_nexus, "N/A");
  assert.deepEqual(a.flags, []);

  const none = validateActorMapping({ threat_actor_type: "AI system (no human attacker)", threat_actor: "N/A" }, TEXT);
  assert.equal(none.threat_actor, "");
  assert.equal(none.flags.length, 1);
});

test("a named group on a no-attacker type is flagged, not removed", () => {
  const a = validateActorMapping({
    threat_actor_type: "Researcher", named_actors: [{ name: "UNC2814" }],
  }, TEXT);
  assert.equal(a.threat_actor, "N/A (research)");
  assert.equal(a.named_actors.length, 1);
  assert.match(a.flags[0], /UNC2814/);
});

test("an unlisted type is kept as new when well-formed, otherwise marked invalid", () => {
  const n = validateActorMapping({ threat_actor_type: "Hacktivist", type_is_new: true, threat_actor: "Unattributed" }, TEXT);
  assert.equal(n.type_status, "new");
  assert.equal(n.threat_actor_type, "Hacktivist");

  const bad = validateActorMapping({ threat_actor_type: "Bad guys", threat_actor: "Unattributed" }, TEXT);
  assert.equal(bad.type_status, "invalid");
});

test("placeholders are not treated as named actors; up to 10 names are listed, more → Multiple", () => {
  const p = validateActorMapping({
    threat_actor_type: "Cybercriminal", threat_actor: "", named_actors: [{ name: "Unattributed" }],
  }, TEXT);
  assert.equal(p.threat_actor, "Unattributed");
  assert.equal(p.named_actors.length, 0);

  const groups = Array.from({ length: 11 }, (_, i) => `APT${i + 1}0`);
  const text = `${groups.join(", ")} all used the model.`;
  const map = n => validateActorMapping({
    threat_actor_type: "Nation-state", named_actors: groups.slice(0, n).map(name => ({ name })),
  }, text);
  assert.equal(map(10).threat_actor, groups.slice(0, 10).join("; "));
  assert.equal(map(11).threat_actor, "Multiple");
});
