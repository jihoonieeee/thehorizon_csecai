-- 014_decks_pptx_url.sql
-- Add pptx_url column to the decks table so the GitHub Actions generation
-- workflow can record the public Vercel Blob URL of the rendered PPTX file.
-- The frontend downloads directly from this URL — no Vercel function re-render needed.

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS pptx_url text;
