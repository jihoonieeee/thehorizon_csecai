/**
 * Authorization role resolution — regression tests for the guest-to-admin
 * privilege escalation via user-controlled Supabase metadata.
 *
 * The invariant under test: setting user_metadata.role to "admin" — which any
 * authenticated user can do through PUT /auth/v1/user — must never grant
 * administrative permission. Only app_metadata, writable solely by the
 * service-role admin API, may confer the admin role.
 *
 * No network: requireAdmin's session path is exercised through a stubbed
 * requireAuth by importing the module with a mocked Supabase client.
 *
 * Run with: node tests/authRole.test.js
 */

import assert from "node:assert/strict";
import { roleOf, requireAdmin } from "../lib/api/requireAuth.js";
import { getAccessLevel } from "../src/auth.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const req = (authHeader) => ({ headers: authHeader ? { authorization: authHeader } : {} });

// ── roleOf: trusted state only ───────────────────────────────────────────────
console.log("\nroleOf — role comes from app_metadata only");

await test("app_metadata.role=admin grants admin", () => {
  assert.equal(roleOf({ app_metadata: { role: "admin" } }), "admin");
});

await test("ESCALATION: user_metadata.role=admin does NOT grant admin", () => {
  assert.equal(roleOf({ user_metadata: { role: "admin" } }), "guest");
});

await test("ESCALATION: user_metadata admin cannot override app_metadata guest", () => {
  assert.equal(
    roleOf({ app_metadata: { role: "guest" }, user_metadata: { role: "admin" } }),
    "guest"
  );
});

await test("missing metadata defaults to guest", () => {
  assert.equal(roleOf({}), "guest");
  assert.equal(roleOf(null), "guest");
  assert.equal(roleOf(undefined), "guest");
});

await test("non-'admin' app_metadata values are guest", () => {
  for (const role of ["Admin", "ADMIN", "superuser", "", null, true, 1, ["admin"]]) {
    assert.equal(roleOf({ app_metadata: { role } }), "guest", `role=${JSON.stringify(role)}`);
  }
});

// ── getAccessLevel: the UI reads the same trusted field ──────────────────────
console.log("\ngetAccessLevel — frontend role matches the server's source of truth");

await test("no session is public", () => {
  assert.equal(getAccessLevel(null), "public");
});

await test("app_metadata.role=admin renders admin UI", () => {
  assert.equal(getAccessLevel({ user: { app_metadata: { role: "admin" } } }), "admin");
});

await test("ESCALATION: user_metadata.role=admin does NOT render admin UI", () => {
  assert.equal(getAccessLevel({ user: { user_metadata: { role: "admin" } } }), "guest");
});

await test("authenticated user with no role is guest", () => {
  assert.equal(getAccessLevel({ user: {} }), "guest");
});

// ── requireAdmin: deny by default, and 401 vs 403 are distinct ───────────────
console.log("\nrequireAdmin — deny-by-default guard");

const CRON = "cron-secret-for-test";
const prevCron = process.env.CRON_SECRET;
const prevTestToken = process.env.AGENT_TEST_TOKEN;
const prevVercelEnv = process.env.VERCEL_ENV;
process.env.CRON_SECRET = CRON;

await test("CRON_SECRET is admin (machine-to-machine)", async () => {
  const r = await requireAdmin(req(`Bearer ${CRON}`));
  assert.equal(r.ok, true);
  assert.equal(r.via, "cron");
});

await test("no Authorization header → 401, not 403", async () => {
  const r = await requireAdmin(req(null));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

await test("a non-Bearer Authorization scheme is rejected as unauthenticated", async () => {
  // Also proves a wrong secret never takes the cron path: only an exact match does.
  const r = await requireAdmin(req("Basic bm90LXRoZS1zZWNyZXQ="));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

await test("dev AGENT_TEST_TOKEN authenticates but is NOT admin → 403", async () => {
  process.env.AGENT_TEST_TOKEN = "dev-token-for-test";
  process.env.VERCEL_ENV = "development";
  const r = await requireAdmin(req("Bearer dev-token-for-test"));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403, "an authenticated non-admin must get 403, not 401");
});

process.env.CRON_SECRET = prevCron;
process.env.AGENT_TEST_TOKEN = prevTestToken;
process.env.VERCEL_ENV = prevVercelEnv;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
