/**
 * URL reachability tests — the hardened HEAD→GET liveness probe used by Layer 3.5
 * to gate dead links at ingest. `fetch` is stubbed, so no real network I/O.
 * Run with: node tests/urlReachability.test.js
 */

import assert from "node:assert/strict";
import { isUrlReachable } from "../lib/pipeline/validation/urlSafety.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const realFetch = globalThis.fetch;
// Install a fetch stub. `plan` maps method → status number | "timeout" | "dns".
function stubFetch(plan) {
  globalThis.fetch = async (url, opts = {}) => {
    const outcome = plan[opts.method] ?? plan.default;
    if (outcome === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    if (outcome === "dns")     { const e = new Error("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; }
    return { status: outcome, ok: outcome >= 200 && outcome < 300 };
  };
}
const restore = () => { globalThis.fetch = realFetch; };

console.log("\nisUrlReachable — hardened liveness probe");

await test("HEAD 200 → live (no GET needed)", async () => {
  let getCalled = false;
  globalThis.fetch = async (u, o) => { if (o.method === "GET") getCalled = true; return { status: 200, ok: true }; };
  assert.equal(await isUrlReachable("https://x.test/a"), true);
  assert.equal(getCalled, false, "GET should not run when HEAD is conclusive");
  restore();
});

await test("HEAD 404 → confirmed dead", async () => {
  stubFetch({ HEAD: 404 });
  assert.equal(await isUrlReachable("https://x.test/a"), false);
  restore();
});

await test("HEAD 410 → confirmed dead", async () => {
  stubFetch({ HEAD: 410 });
  assert.equal(await isUrlReachable("https://x.test/a"), false);
  restore();
});

await test("HEAD 403 → live (restricted, not dead)", async () => {
  stubFetch({ HEAD: 403 });
  assert.equal(await isUrlReachable("https://x.test/a"), true);
  restore();
});

await test("HEAD 405 → live (method not allowed, server up)", async () => {
  stubFetch({ HEAD: 405 });
  assert.equal(await isUrlReachable("https://x.test/a"), true);
  restore();
});

await test("HEAD 500 ambiguous → GET 200 → live", async () => {
  stubFetch({ HEAD: 500, GET: 200 });
  assert.equal(await isUrlReachable("https://x.test/a"), true);
  restore();
});

await test("HEAD-hostile: HEAD 405-block but page 404 on GET → dead", async () => {
  // The real-world case that HEAD-only missed: server 404s the actual page but
  // answers HEAD oddly. GET confirms the 404.
  stubFetch({ HEAD: 500, GET: 404 });
  assert.equal(await isUrlReachable("https://x.test/a"), false);
  restore();
});

await test("HEAD timeout → GET 200 → live (slow host not purged)", async () => {
  stubFetch({ HEAD: "timeout", GET: 200 });
  assert.equal(await isUrlReachable("https://x.test/a"), true);
  restore();
});

await test("HEAD timeout → GET timeout → null (indeterminate, never purge)", async () => {
  stubFetch({ HEAD: "timeout", GET: "timeout" });
  assert.equal(await isUrlReachable("https://x.test/a"), null);
  restore();
});

await test("DNS failure on HEAD (err.cause.code=ENOTFOUND) → dead", async () => {
  stubFetch({ HEAD: "dns" });
  assert.equal(await isUrlReachable("https://gone.test/a"), false);
  restore();
});

await test("HEAD 500 → GET 503 → null (transient server error, not dead)", async () => {
  stubFetch({ HEAD: 500, GET: 503 });
  assert.equal(await isUrlReachable("https://x.test/a"), null);
  restore();
});

await test("empty url → null", async () => {
  assert.equal(await isUrlReachable(""), null);
  assert.equal(await isUrlReachable(null), null);
});

restore();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
