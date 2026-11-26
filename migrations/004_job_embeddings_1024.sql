-- Job embeddings for semantic and hybrid search (doc 07).
--
-- The table was created in 001 as vector(1536) and has never held rows, so the
-- column is recreated at 1024 dimensions (decision D2) instead of converted.
-- The guard makes the migration fail loudly rather than drop real vectors.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_embeddings) THEN
    RAISE EXCEPTION 'job_embeddings is not empty; migration 004 would discard stored vectors';
  END IF;
END $$;

ALTER TABLE job_embeddings DROP COLUMN embedding;
ALTER TABLE job_embeddings ADD COLUMN embedding vector(1024) NOT NULL;

-- job_postings.content_hash at the time the job was embedded. `npm run embed`
-- re-embeds a job when this differs from the job's current hash (decision D7).
ALTER TABLE job_embeddings ADD COLUMN content_hash TEXT NOT NULL;

-- No ANN index yet: an exact cosine scan is fast at this catalog size (D9).
