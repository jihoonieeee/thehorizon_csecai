-- Migration 028: user activity log
-- Answers "is anyone actually using this, and what are they looking at".
-- Written directly from the browser with the anon key, the same way
-- user_bookmarks (027) is — no serverless function needed, which matters
-- because /api is at the Vercel Hobby 12-function cap.

CREATE TABLE IF NOT EXISTS user_activity_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  text NOT NULL,                       -- 'page_view' | 'source_open' | 'chat_query'
  target_id   text,                                -- page key, source id, deck id
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_activity_log ENABLE ROW LEVEL SECURITY;

-- INSERT only, and only rows stamped with the caller's own id.
-- There is deliberately NO select/update/delete policy: the anon key cannot
-- read anyone's history back. Reads go through the service role (SQL editor
-- or scripts/activitySummary.js).
CREATE POLICY "Users can insert their own activity"
  ON user_activity_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS user_activity_log_user_time_idx
  ON user_activity_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_log_type_time_idx
  ON user_activity_log (event_type, occurred_at DESC);
