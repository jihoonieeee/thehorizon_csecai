/**
 * Rawfact quality-axis persistence — verifies the missing-column retry logic so a
 * partially-migrated rawfacts table (without the newer quality columns) still
 * persists every column it DOES have, instead of dropping the whole batch.
 *
 * Run with: node tests/rawfactPersistence.test.js
 */

import assert from "node:assert/strict";
import { isMissingColumnError, missingColumnFrom, dropColumns } from "../lib/storage/taxonomyStore.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

console.log("\nMissing-column error detection");

test("detects Postgres 42703 / PostgREST PGRST204", () => {
  assert.ok(isMissingColumnError({ code: "42703" }));
  assert.ok(isMissingColumnError({ code: "PGRST204" }));
  assert.ok(isMissingColumnError({ message: `column "materiality" does not exist` }));
  assert.ok(isMissingColumnError({ message: `Could not find the 'uniqueness' column of 'rawfacts' in the schema cache` }));
  assert.ok(!isMissingColumnError({ code: "42P01", message: "relation does not exist" }));
});

test("extracts the offending column name from both error styles", () => {
  assert.equal(missingColumnFrom({ message: `column "materiality" does not exist` }), "materiality");
  assert.equal(missingColumnFrom({ message: `Could not find the 'uniqueness' column of 'rawfacts'` }), "uniqueness");
});

console.log("\nColumn stripping");

test("dropColumns removes only the named columns and preserves the rest", () => {
  const rows = [
    { rawfact_id: "a", claim: "x", materiality: "novel", uniqueness: "sole_support", evidence_strength: "strong" },
    { rawfact_id: "b", claim: "y", materiality: "confirming", uniqueness: "corroborated", evidence_strength: "usable" },
  ];
  const out = dropColumns(rows, new Set(["materiality", "uniqueness"]));
  assert.deepEqual(Object.keys(out[0]).sort(), ["claim", "evidence_strength", "rawfact_id"]);
  assert.equal(out[1].evidence_strength, "usable");
  // Original rows untouched (non-mutating).
  assert.equal(rows[0].materiality, "novel");
});

test("dropColumns with empty set is a no-op", () => {
  const rows = [{ rawfact_id: "a", claim: "x" }];
  assert.equal(dropColumns(rows, new Set()), rows);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
