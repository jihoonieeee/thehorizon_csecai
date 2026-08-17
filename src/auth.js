// Derive access level from a live Supabase session.
//
// The role lives in app_metadata.role ("admin" | "guest"), which only the
// service-role admin API can write. It is deliberately NOT read from
// user_metadata: any authenticated user can rewrite their own user_metadata
// via PUT /auth/v1/user, so a user_metadata role is self-assignable.
//
// This is presentation only — it decides which controls to render. Every
// privileged action is authorized server-side in lib/api/requireAuth.js;
// hiding a button is not an access control.
export function getAccessLevel(session) {
  if (!session) return "public";
  return session.user?.app_metadata?.role === "admin" ? "admin" : "guest";
}

// The Supabase JWT — used as Authorization: Bearer for protected API calls.
export function getSessionToken(session) {
  return session?.access_token ?? "";
}
