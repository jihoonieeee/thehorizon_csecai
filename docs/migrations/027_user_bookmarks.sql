-- Migration 027: per-user bookmarks
-- Replaces the shared `sources.starred` column as the source of truth for
-- "starred" state. Each user manages their own bookmark set; RLS enforces
-- that users can only read and write their own rows.

CREATE TABLE IF NOT EXISTS user_bookmarks (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_id)
);

ALTER TABLE user_bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own bookmarks"
  ON user_bookmarks
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast per-user lookups (the primary key already covers (user_id, source_id)
-- but this makes the common "give me all bookmarks for user X" query fast).
CREATE INDEX IF NOT EXISTS user_bookmarks_user_id_idx ON user_bookmarks (user_id);
