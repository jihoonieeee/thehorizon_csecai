/**
 * requireAuth — validate a Supabase session JWT on incoming API requests.
 *
 * Returns the authenticated user object if the bearer token is valid,
 * or null if missing / invalid. Callers reject with 401 on null.
 *
 * Any authenticated user (guest or admin) passes — use this for read
 * endpoints that should be accessible to all logged-in users but not
 * to unauthenticated callers.
 */

import { createClient } from "@supabase/supabase-js";

let _sb = null;
function sb() {
  if (!_sb) _sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return _sb;
}

export async function requireAuth(req) {
  const auth  = req.headers?.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  // Dev-only bypass: set AGENT_TEST_TOKEN in .env.local (never in production env).
  // Vercel sets VERCEL_ENV=production on deployed functions, so this is never reachable there.
  if (
    process.env.AGENT_TEST_TOKEN &&
    process.env.VERCEL_ENV !== "production" &&
    token === process.env.AGENT_TEST_TOKEN
  ) {
    return { id: "dev-test", email: "dev@test.local" };
  }

  const { data: { user }, error } = await sb().auth.getUser(token);
  if (error || !user) return null;
  return user;
}
