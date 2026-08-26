/**
 * activityLog — fire-and-forget user interaction logging to Supabase.
 *
 * Writes straight from the browser under the RLS insert policy in
 * docs/migrations/028_user_activity_log.sql. Never throws, never blocks:
 * a logging failure must never break the interaction it is measuring.
 *
 * Usage:
 *   import { logEvent, EVENTS } from "../lib/activityLog.js";
 *   logEvent(session, EVENTS.SOURCE_OPEN, source.id);
 */

import { supabase } from "./supabase.js";

/** Controlled vocabulary. Keep this small — a tight set stays queryable. */
export const EVENTS = Object.freeze({
  PAGE_VIEW:   "page_view",
  SOURCE_OPEN: "source_open",
  CHAT_QUERY:  "chat_query",
  REPORT_GEN:  "report_generate",
});

// Guards against React StrictMode double-invoking effects in dev, and against
// a rapid repeat of the identical event (e.g. double-click on a source card).
let _last = { key: null, at: 0 };
const DEDUPE_MS = 1000;

/**
 * @param {object} session   Supabase session from useAuth()
 * @param {string} eventType One of EVENTS
 * @param {string} [targetId] Page key, source id, deck id — whatever identifies the object
 */
export function logEvent(session, eventType, targetId = null) {
  const userId = session?.user?.id;
  if (!userId) return;

  const key = `${eventType}:${targetId}`;
  const now = Date.now();
  if (_last.key === key && now - _last.at < DEDUPE_MS) return;
  _last = { key, at: now };

  supabase
    .from("user_activity_log")
    .insert({ user_id: userId, event_type: eventType, target_id: targetId })
    .then(() => {}, () => {});   // swallow both outcomes — logging is never load-bearing
}
