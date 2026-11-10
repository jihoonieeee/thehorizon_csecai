import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceActors, rowToActors } from "../lib/storage/threatActorStore.js";

const ROW = {
  source_id: "s1",
  threat_actor_type: "Cybercriminal", type_status: "listed",
  threat_actor: "Unattributed", country_nexus: "Unknown",
  named_actors: [], countries: [], confidence: "medium", rationale: "A real ransomware attack.",
  flags: [], dropped: [{ item: "actor \"X\"", reason: "name not found in the article" }],
  prompt_version: "v5.2", model: "gpt-5.4", tagged_at: "2026-11-10T00:00:00Z",
  reviewed_type: null, reviewed_actor: null, reviewed_country: null, reviewed_by: null, reviewed_at: null,
};

test("an untagged source is absent; a tagged one shows the model's values as model-suggested", () => {
  const out = buildSourceActors([ROW]);
  assert.deepEqual(Object.keys(out), ["s1"]);
  assert.equal(out.s1.type, "Cybercriminal");
  assert.equal(out.s1.actor, "Unattributed");
  assert.equal(out.s1.country, "Unknown");
  assert.equal(out.s1.reviewed, false);
  assert.equal(out.s1.prompt_version, "v5.2");
});

test("an analyst override wins column by column, and marks the source reviewed", () => {
  const out = buildSourceActors([{ ...ROW, reviewed_actor: "JadePuffer", reviewed_by: "analyst@example.com" }]);
  assert.equal(out.s1.type, "Cybercriminal");       // not overridden → model's
  assert.equal(out.s1.actor, "JadePuffer");         // overridden
  assert.equal(out.s1.country, "Unknown");
  assert.equal(out.s1.reviewed, true);
  assert.equal(out.s1.reviewed_by, "analyst@example.com");
});

test("an override to an empty string still counts (only null means not reviewed)", () => {
  const out = buildSourceActors([{ ...ROW, reviewed_actor: "" }]);
  assert.equal(out.s1.actor, "");
  assert.equal(out.s1.reviewed, true);
});

test("a stored row converts back to the validateActorMapping shape for the review sheet", () => {
  const a = rowToActors(ROW);
  assert.equal(a.threat_actor_type, "Cybercriminal");
  assert.equal(a.country_nexus, "Unknown");
  assert.deepEqual(a.dropped, ROW.dropped);
  assert.deepEqual(a.flags, []);
});
