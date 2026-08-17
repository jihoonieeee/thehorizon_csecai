/**
 * requireAuth / requireAdmin — session validation and authorization for API routes.
 *
 * requireAuth  — returns the authenticated user object if the bearer token is
 *                valid, or null if missing / invalid. Callers reject with 401.
 *                Any authenticated user (guest or admin) passes — use it for read
 *                endpoints open to all logged-in users but not to anonymous callers.
 *
 * requireAdmin — the single deny-by-default guard for every administrative
 *                operation. Callers reject with the returned status.
 *
 * SECURITY — the application role is read from `app_metadata`, never from
 * `user_metadata`. Supabase lets any authenticated user rewrite their own
 * `user_metadata` via PUT /auth/v1/user and will then mint a validly signed JWT
 * carrying whatever they put there, so a `user_metadata.role` check is a
 * guest-to-admin privilege escalation. `app_metadata` is writable only through
 * the service-role admin API. See scripts/migrateUserRoles.js.
 *
 * The role is resolved from `supabase.auth.getUser(token)`, which is a
 * server-side lookup against the auth database — not a decode of the caller's
 * token. A stale or tampered token therefore cannot carry a stale role.
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

/**
 * The application role for a Supabase user object, from trusted state only.
 * Anything that isn't an explicit app_metadata admin grant is a guest.
 */
export function roleOf(user) {
  return user?.app_metadata?.role === "admin" ? "admin" : "guest";
}

export async function requireAuth(req) {
  const auth  = req.headers?.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  // Dev-only bypass: set AGENT_TEST_TOKEN in .env.local (never in production env).
  // Vercel sets VERCEL_ENV=production on deployed functions, so this is never reachable there.
  // Deliberately carries no admin grant — it authenticates, it does not authorize.
  if (
    process.env.AGENT_TEST_TOKEN &&
    process.env.VERCEL_ENV !== "production" &&
    token === process.env.AGENT_TEST_TOKEN
  ) {
    return { id: "dev-test", email: "dev@test.local", app_metadata: {} };
  }

  const { data: { user }, error } = await sb().auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * Deny-by-default admin guard. Accepts either the machine-to-machine
 * CRON_SECRET or a session belonging to a user with app_metadata.role=admin.
 *
 * Returns { ok: true, via, user } on success, or { ok: false, status, error }
 * where status distinguishes "not authenticated" (401) from "authenticated but
 * not permitted" (403).
 */
export async function requireAdmin(req) {
  const secret = process.env.CRON_SECRET;
  const auth   = req.headers?.authorization || "";

  if (secret && auth === `Bearer ${secret}`) {
    return { ok: true, via: "cron", user: null };
  }

  const user = await requireAuth(req);
  if (!user) return { ok: false, status: 401, error: "Unauthorized" };
  if (roleOf(user) !== "admin") return { ok: false, status: 403, error: "Forbidden" };

  return { ok: true, via: "session", user };
}
