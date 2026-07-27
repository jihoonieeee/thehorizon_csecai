// Derive access level from a live Supabase session.
// role is stored in session.user.user_metadata.role ("admin" | "guest").
// Any authenticated user is at minimum "guest".
export function getAccessLevel(session) {
  if (!session) return "public";
  return session.user?.user_metadata?.role ?? "guest";
}

// The Supabase JWT — used as Authorization: Bearer for protected API calls.
export function getSessionToken(session) {
  return session?.access_token ?? "";
}