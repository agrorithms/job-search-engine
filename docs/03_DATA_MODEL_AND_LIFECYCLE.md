# Job Scanner --- Data Model and Job Lifecycle

## Core modeling principle

A single real-world job should have one canonical job record, even if it
is observed through multiple sources. Provider-specific information
belongs in source records linked to that canonical job.

For example, if the same role is discovered through two sources, the
system should avoid creating two unrelated canonical jobs merely because
the source records differ.

## Main entities

### `companies`

Employer registry.

  Field            Purpose
  ---------------- -----------------------------
  `id`             Primary key
  `name`           Employer name
  `website_url`    Company website
  `careers_url`    Careers page
  `industry`       Optional industry
  `company_size`   Optional size category
  `is_active`      Whether to collect postings
  `created_at`     Creation timestamp

### `ats_sources`

Configuration for a company's job source.

  Field                Purpose
  -------------------- -----------------------------------------
  `id`                 Primary key
  `company_id`         Employer foreign key
  `provider`           `greenhouse`, `lever`, `ashby`, etc.
  `board_identifier`   Provider-specific board/site identifier
  `endpoint_url`       Discovered public endpoint, when useful
  `is_active`          Whether source is polled
  `last_checked_at`    Most recent poll attempt
  `last_success_at`    Most recent successful poll

A company may eventually have multiple sources. Keep `board_identifier`
generic: it represents a Greenhouse board token, Lever site identifier,
Ashby board name, or the corresponding identifier for a future provider.

### `job_postings`

The canonical job record and center of the application.

  Field                        Purpose
  ---------------------------- -------------------------------------------------
  `id`                         Canonical job ID
  `company_id`                 Employer
  `title`                      Job title
  `description`                Normalized description
  `location`                   Display location
  `country_code`               Country code, if known
  `workplace_type`             Remote, hybrid, onsite, if known
  `employment_type`            Full-time, contract, etc., if known
  `seniority`                  Normalized seniority, if known
  `department`                 Department, if known
  `salary_min`, `salary_max`   Salary bounds, if supplied
  `salary_currency`            Currency, if supplied
  `application_url`            Application destination
  `posted_at`                  Original posting date, if supplied
  `first_seen_at`              First discovery
  `last_seen_at`               Latest successful observation
  `is_active`                  Whether currently considered active
  `content_hash`               Detects meaningful content changes
  `search_vector`              Full-text search representation where supported

Not every ATS supplies every field. Unknown values should remain null.
Do not infer or fabricate missing salary, location, or qualification
data.

### `job_sources`

Source-specific record associated with a canonical job.

  Field               Purpose
  ------------------- -------------------------------
  `id`                Primary key
  `job_id`            Canonical job foreign key
  `ats_source_id`     ATS configuration foreign key
  `external_job_id`   Provider's posting identifier
  `external_url`      Source-specific URL
  `raw_payload`       Original provider response
  `first_seen_at`     Initial observation
  `last_seen_at`      Latest observation

Enforce:

``` sql
UNIQUE (ats_source_id, external_job_id)
```

This makes repeated ingestion of the same source posting idempotent.

### `job_embeddings`

Stores vector representations of job content.

  Field            Purpose
  ---------------- ----------------------------
  `id`             Primary key
  `job_id`         Associated canonical job
  `model`          Embedding model identifier
  `content_hash`   Content version embedded
  `embedding`      Vector
  `created_at`     Generation timestamp

Regenerate an embedding only when the relevant job content changes or
the embedding model changes.

### `profiles` and `resume_documents`

Keep the candidate profile separate from the source resume documents.

A profile may contain: - Target roles and desired seniority. - Preferred
locations and remote/hybrid preferences. - Minimum compensation. -
Skills and years of experience. - Hard requirements and preferences. - A
profile version.

Resume documents may contain: - Document name and storage location. -
Extracted text. - Document type. - Upload date. - Active-version
indicator.

Support multiple resume versions so a revised resume can be evaluated
without losing the previous version. Extracted profile information
should be reviewed and approved before being used for matching.

### `job_matches`

Stores evaluations of a job against a particular profile version.

  Field                    Purpose
  ------------------------ --------------------------------------------------------
  `id`                     Primary key
  `profile_id`             Candidate profile
  `job_id`                 Evaluated job
  `semantic_score`         Similarity measure
  `fit_score`              Overall evaluation score
  `qualification_score`    Requirements match
  `seniority_score`        Level compatibility
  `verdict`                Strong, possible, poor, or equivalent controlled value
  `reasoning`              Explanation
  `missing_requirements`   Structured gaps
  `model`                  Evaluation model
  `evaluated_at`           Evaluation timestamp
  `profile_version`        Profile version used

A useful uniqueness rule is `(profile_id, job_id, profile_version)` when
retaining one evaluation per job per profile version. Preserve
historical evaluations if comparisons over time are useful.

## Supporting entities

Add these as their features are implemented:

-   `saved_jobs` --- bookmarked jobs.
-   `ingestion_runs` --- each ingestion execution, its scope, result,
    and errors.
-   `job_events` --- posting changes, expiration, and reactivation.
-   `application_tracking` --- status, application date, notes, and
    follow-ups.

## Job lifecycle

``` mermaid
flowchart TD
    A[Configured ATS source] --> B[Fetch provider response]
    B --> C{Fetch and listing complete?}
    C -- No --> X[Record failure; do not expire missing jobs]
    C -- Yes --> D[Validate and normalize records]
    D --> E[Upsert source records and canonical jobs]
    E --> F[Compare content hashes]
    F --> G[Update last-seen timestamps]
    G --> H[Identify previously known jobs absent from complete listing]
    H --> I[Apply missing-job policy]
    I --> J[Record run and job events]
    F --> K{Relevant content changed?}
    K -- Yes --> L[Queue embedding refresh]
    K -- No --> M[Keep existing embedding]
```

A source failure must not be interpreted as evidence that every job from
that source has disappeared. Only a successful, complete listing can
support missing-job detection. Consider multiple successful missing
checks before marking a job inactive, rather than expiring a posting
after one potentially anomalous poll.

## Deduplication strategy

Use progressively less certain signals:

1.  **Exact source identity:** same ATS source and external posting ID.
2.  **Normalized application URL:** matching application URL after safe
    normalization.
3.  **Probabilistic similarity:** same employer plus similar title,
    location, and overlapping description.

Do not automatically merge jobs based only on similar titles. One
employer can have multiple distinct openings with the same title across
teams or locations. Ambiguous candidates should be reviewed or handled
conservatively.

## Data integrity and reprocessing

-   Preserve raw provider payloads. Normalized records must not be the
    only copy.
-   Use content hashes to detect meaningful changes and avoid
    unnecessary embedding/model costs.
-   Keep source timestamps distinct from local first-seen and last-seen
    timestamps.
-   Record enough ingestion history to explain why a job was inserted,
    updated, or expired.
-   Use transactions for related database writes.
-   Make missing and unknown data explicit rather than filling it with
    assumptions.
