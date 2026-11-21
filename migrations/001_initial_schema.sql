CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE companies (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, website_url TEXT, careers_url TEXT,
 industry TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE ats_sources (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('greenhouse','lever','ashby')), board_identifier TEXT NOT NULL,
 endpoint_url TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, last_checked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(provider,board_identifier)
);
CREATE TABLE job_postings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id),
 title TEXT NOT NULL, description TEXT, location TEXT, country_code CHAR(2),
 workplace_type TEXT CHECK(workplace_type IN ('remote','hybrid','onsite','unknown')), employment_type TEXT,
 seniority TEXT, department TEXT, salary_min NUMERIC, salary_max NUMERIC, salary_currency CHAR(3),
 application_url TEXT NOT NULL, posted_at TIMESTAMPTZ, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), is_active BOOLEAN NOT NULL DEFAULT TRUE, content_hash TEXT,
 search_vector TSVECTOR GENERATED ALWAYS AS (
  setweight(to_tsvector('english',coalesce(title,'')),'A') ||
  setweight(to_tsvector('english',coalesce(description,'')),'B') ||
  setweight(to_tsvector('english',coalesce(location,'')),'C')
 ) STORED, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE job_sources (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
 ats_source_id UUID NOT NULL REFERENCES ats_sources(id) ON DELETE CASCADE, external_job_id TEXT NOT NULL,
 external_url TEXT, raw_payload JSONB NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(ats_source_id,external_job_id)
);
CREATE TABLE ingestion_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ats_source_id UUID NOT NULL REFERENCES ats_sources(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 finished_at TIMESTAMPTZ, jobs_seen INTEGER NOT NULL DEFAULT 0, jobs_inserted INTEGER NOT NULL DEFAULT 0,
 jobs_updated INTEGER NOT NULL DEFAULT 0, error_message TEXT
);
CREATE TABLE profiles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, role_track TEXT NOT NULL, summary TEXT,
 skills JSONB NOT NULL DEFAULT '[]', preferences JSONB NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
 is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE resume_documents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 filename TEXT NOT NULL, mime_type TEXT NOT NULL, extracted_text TEXT, storage_key TEXT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE job_embeddings (
 job_id UUID PRIMARY KEY REFERENCES job_postings(id) ON DELETE CASCADE, embedding_model TEXT NOT NULL,
 embedding vector(1536) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE job_matches (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 job_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE, profile_version INTEGER NOT NULL,
 match_score NUMERIC(5,2), verdict TEXT, strengths JSONB NOT NULL DEFAULT '[]', gaps JSONB NOT NULL DEFAULT '[]',
 unknowns JSONB NOT NULL DEFAULT '[]', explanation TEXT, model_name TEXT, evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(profile_id,job_id,profile_version)
);
CREATE TABLE saved_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 job_id UUID NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'saved'
 CHECK(status IN ('saved','interested','applied','interviewing','rejected','offer','withdrawn')),
 notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(profile_id,job_id)
);
CREATE INDEX idx_jobs_active_seen ON job_postings(is_active,first_seen_at DESC);
CREATE INDEX idx_jobs_company ON job_postings(company_id);
CREATE INDEX idx_jobs_search ON job_postings USING GIN(search_vector);
CREATE INDEX idx_sources_job ON job_sources(job_id);
CREATE INDEX idx_runs_source ON ingestion_runs(ats_source_id,started_at DESC);
CREATE INDEX idx_matches_profile_score ON job_matches(profile_id,match_score DESC);
CREATE INDEX idx_saved_profile_status ON saved_jobs(profile_id,status);
