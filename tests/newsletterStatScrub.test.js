import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubIntro } from "../lib/newsletter/index.js";

// scrubIntro drops any sentence whose statistic is not present in the grounding
// text the intro model was given, guarding against fabricated success rates.

test("strips a sentence with an ungrounded percentage", () => {
  const { text, stripped } = scrubIntro(
    "Attackers plant payloads in logs. Success rate hit 83.4% in tests.",
    "Attackers plant prompt-injection payloads into logs analysts query.",
  );
  assert.equal(stripped, 1);
  assert.equal(text, "Attackers plant payloads in logs.");
});

test("keeps a percentage grounded within ±1 (rounding)", () => {
  const { text, stripped } = scrubIntro(
    "Evasion works ~83% of the time now.",
    "The technique succeeded in 82% of trials across model families.",
  );
  assert.equal(stripped, 0);
  assert.equal(text, "Evasion works ~83% of the time now.");
});

test("keeps an exactly grounded percentage", () => {
  const { stripped } = scrubIntro("Bypass rate reached 90%.", "Guardrail bypass reached 90% on production endpoints.");
  assert.equal(stripped, 0);
});

test("does not split on a decimal point", () => {
  // A naive [.!?] splitter would leave a "hit 83." fragment; this must not happen.
  const { text } = scrubIntro("Success rate hit 83.4% here.", "no numbers");
  assert.ok(!text.includes("83"));
});

test("leaves number-free prose untouched", () => {
  const intro = "Prompt injection is now an operational capability.";
  const { text, stripped } = scrubIntro(intro, "grounding");
  assert.equal(stripped, 0);
  assert.equal(text, intro);
});

test("strips an ungrounded multiplier", () => {
  const { text, stripped } = scrubIntro(
    "Attacks are 10x more effective. This shifts the threat model.",
    "Attacks became far more effective, shifting the threat model.",
  );
  assert.equal(stripped, 1);
  assert.equal(text, "This shifts the threat model.");
});

test("empties an intro whose only sentence is an ungrounded stat", () => {
  const { text, stripped } = scrubIntro("Success rate was 99.9%.", "no numbers here");
  assert.equal(stripped, 1);
  assert.equal(text, "");
});
