-- Missing-job policy, job lifecycle events, and constraints for the structured
-- fields that connectors now populate from provider data.

-- Consecutive successful, complete listings from this source in which the
-- posting was absent. Reset to 0 whenever the posting is seen again.
ALTER TABLE job_sources
  ADD COLUMN IF NOT EXISTS missed_runs INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS jobs_missing INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jobs_expired INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jobs_reactivated INTEGER NOT NULL DEFAULT 0,
  -- TRUE when the listing could not support missing-job detection (an empty
  -- response for a source that still has active jobs).
  ADD COLUMN IF NOT EXISTS missing_check_skipped BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'expired', 'reactivated')),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_type_time ON job_events(event_type, created_at DESC);

-- Controlled vocabulary for employment type. All existing rows are NULL.
ALTER TABLE job_postings
  ADD CONSTRAINT job_postings_employment_type_check
  CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'temporary', 'internship'));

-- Supports the default "most recently posted" ordering of the search page.
CREATE INDEX IF NOT EXISTS idx_jobs_active_posted ON job_postings(is_active, posted_at DESC NULLS LAST);
