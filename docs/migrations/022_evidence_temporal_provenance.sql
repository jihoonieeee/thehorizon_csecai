-- Migration 022: explicit temporal provenance on evidence items
--
-- Separates three distinct timestamps that were previously conflated:
--   event_date       (already exists, migration 019) — when the event OCCURRED
--   publication_date (new) — when the source article/report was published
--   extraction_date  — when Horizon ingested this evidence; mapped to created_at
--
-- News sources often report retrospectively. Storing publication_date separately
-- from event_date lets trend analysis, dashboard windows, and forecasting reason
-- about adversary activity timelines rather than media coverage timelines.
--
-- extraction_date is NOT a new column: created_at (added in migration 011)
-- already records when the row was inserted. The column is documented here for
-- clarity but no ALTER TABLE is needed.
--
-- Updates the time_basis comment to match the valid values used in code
-- ("event_date" not "incident_date" as the original 019 comment stated).

-- ── publication_date ──────────────────────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS publication_date TEXT;

COMMENT ON COLUMN evidence.publication_date IS
  'ISO date (YYYY-MM-DD or YYYY-MM) when the source article or report was published. '
  'Copied from sources.date_published at extraction time. '
  'Separate from event_date (when the described event occurred) and '
  'created_at / extraction_date (when Horizon ingested the evidence row).';

-- ── Correct the time_basis comment (019 said "incident_date", code uses "event_date") ─

COMMENT ON COLUMN evidence.time_basis IS
  'event_date | publication_date | unknown — '
  'event_date: event_date was extracted from source text describing when the event occurred; '
  'publication_date: no event date found, article publication date used as fallback proxy; '
  'unknown: the timing of the underlying event is genuinely unclear.';

-- ── event_date comment clarification ─────────────────────────────────────────

COMMENT ON COLUMN evidence.event_date IS
  'When the described event occurred (ISO date: YYYY-MM-DD or YYYY-MM). '
  'For incidents: date of compromise or exploitation. '
  'For vulnerabilities: CVE disclosure or discovery date. '
  'For research: study/experiment period. '
  'For measurements: the measurement period. '
  'For policy: effective date. '
  'NOT the article publication date — that is stored in publication_date.';

-- ── created_at serves as extraction_date (no new column needed) ───────────────

COMMENT ON COLUMN evidence.created_at IS
  'Extraction date — when this evidence row was written to the database by Horizon. '
  'Serves as extraction_date in the event_date / publication_date / extraction_date triad.';

-- ── Index for publication_date queries ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS evidence_publication_date_idx ON evidence (publication_date)
  WHERE publication_date IS NOT NULL;
