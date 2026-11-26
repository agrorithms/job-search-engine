# Validated Multi-Source Ingestion Workflow

## Seeded public boards

Migration `002_seed_validated_sources.sql` adds 20 active employer/source pairs.
Each board identifier was verified with a `200 application/json` response from its
provider's public endpoint on 2026-11-26 before inclusion. The migration is
idempotent: it preserves existing non-null company URLs, source endpoint URLs, and
source active-state choices.

| Provider | Employers / board identifiers | Public endpoint pattern |
| --- | --- | --- |
| Greenhouse (7) | Stripe (`stripe`), Figma (`figma`), Anthropic (`anthropic`), Datadog (`datadog`), Cloudflare (`cloudflare`), Asana (`asana`), Coinbase (`coinbase`) | `https://boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true` |
| Lever (6) | Coderio (`coderio`), Reply (`reply`), CLO Virtual Fashion (`clovirtualfashion`), Gauss Labs (`gausslabs`), WalkMe (`walkme`), Trendyol (`trendyol`) | `https://api.lever.co/v0/postings/<board>?mode=json` |
| Ashby (7) | Linear (`linear`), Vanta (`vanta`), Sentry (`sentry`), Mercor (`mercor`), Ramp (`ramp`), Webflow (`webflow`), PostHog (`posthog`) | `https://api.ashbyhq.com/posting-api/job-board/<board>?includeCompensation=true` |

Only public job-board APIs are used. No browser automation or authenticated API is
required. Endpoint URLs are stored in `ats_sources.endpoint_url` as discovery
evidence; connectors construct their request from the provider and board identifier.

## Local validation procedure

Start the repository's PostgreSQL service, then run:

```bash
docker compose up -d
npm run db:migrate
npm run ingest
```

Inspect the first run:

```sql
SELECT status, COUNT(*) AS runs, SUM(jobs_seen) AS seen,
       SUM(jobs_inserted) AS inserted, SUM(jobs_updated) AS updated,
       SUM(jobs_unchanged) AS unchanged
FROM ingestion_runs
GROUP BY status;

SELECT provider, COUNT(*) AS sources, SUM(jobs_seen) AS seen,
       SUM(jobs_inserted) AS inserted
FROM ingestion_runs r
JOIN ats_sources s ON s.id = r.ats_source_id
GROUP BY provider
ORDER BY provider;

SELECT COUNT(*) AS jobs FROM job_postings;
SELECT COUNT(*) AS source_records FROM job_sources;
SELECT COUNT(*) AS duplicate_source_records
FROM (
  SELECT ats_source_id, external_job_id
  FROM job_sources
  GROUP BY ats_source_id, external_job_id
  HAVING COUNT(*) > 1
) duplicates;
```

Run `npm run ingest` a second time. With unchanged live boards, `job_postings` and
`job_sources` counts should stay constant; successful run rows should report their
postings in `jobs_unchanged` and zero inserts. A posting may legitimately be updated
between live runs, so compare the run aggregates rather than assuming every source
will be unchanged.

## Verified local database result (2026-11-26)

The local PostgreSQL database was checked after the migration and the two documented
multi-source ingestion runs. The registry contains **20 companies** and **20 active
sources**: 7 Greenhouse, 6 Lever, and 7 Ashby. Every stored source has the expected
provider endpoint pattern, a non-empty board identifier, and both `last_checked_at`
and `last_success_at` set.

| Provider | Active sources | All recorded succeeded runs | Seen | Inserted | Updated | Unchanged |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ashby | 7 | 14 | 924 | 462 | 0 | 462 |
| Greenhouse | 7 | 18 | 8,780 | 2,913 | 3,037 | 2,830 |
| Lever | 6 | 12 | 424 | 212 | 0 | 212 |

Those all-history totals include earlier Stripe-only Greenhouse refreshes already in
the local database. The two 20-source runs at 2026-11-26 00:33 ET were:

| Run | Sources | Seen | Inserted | Updated | Unchanged | Failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial seeded-board run | 20 | 3,504 | 2,772 | 732 | 0 | 0 |
| Repeat seeded-board run | 20 | 3,504 | 0 | 0 | 3,504 | 0 |

The initial run updated 732 pre-existing Stripe records and inserted 40 newly seen
Stripe records; the other seeded-board observations were inserts. This is normal for
a board that had already been ingested and is not a duplicate condition. The repeat
run was entirely unchanged, so no live-board updates need explanation.

Current persisted totals are **3,587 `job_postings`** and **3,587 `job_sources`**.
The difference from the 3,504 current observations is 83 older Stripe source records
that are still retained because expiration/inactivation is intentionally not
implemented. The uniqueness verification returned **0 duplicate
`(ats_source_id, external_job_id)` groups** and **0 duplicate rows beyond the first**.

No failed `ingestion_runs` were present, so no connector or source-configuration
issue was diagnosed. The 20 source configurations are all active and use the
provider-specific public endpoint forms shown above; this is consistent with the
connectors, which derive their fetch URLs from `provider` and `board_identifier`.

## Fixture-backed persistence coverage

`tests/ingest-source.test.ts` exercises the shared ingestion/persistence boundary
without hitting a live board or requiring a local database service. It covers initial
inserts, unchanged repeat ingestion, changed content/hash updates, and fetch failure
preservation of existing records. Connector tests retain their saved provider fixtures.

## Missing-job policy (migration 003)

Implements the lifecycle in `03_DATA_MODEL_AND_LIFECYCLE.md`:

- `job_sources.missed_runs` counts consecutive successful, complete listings from which
  an active posting was absent. Seeing the posting again resets it to 0.
- A posting is expired (`is_active = FALSE`) when `missed_runs` reaches
  `MISSED_RUNS_BEFORE_EXPIRY` (2) in `src/ingestion/services/ingest-source.ts`.
- A failed fetch never counts as a miss. An empty listing from a source that still has
  active jobs is not trusted as complete: the run succeeds, but missing-job detection is
  skipped and `ingestion_runs.missing_check_skipped` is set. `npm run ingest` prints a
  warning for such sources.
- A job that is listed again after expiry is reactivated.
- `job_events` records `created`, `updated` (with the changed field names in
  `details.fields`), `expired` (with `details.missed_runs`), and `reactivated`, each linked
  to its `ingestion_runs` row. `ingestion_runs` also records `jobs_missing`,
  `jobs_expired`, and `jobs_reactivated`.

Missing-job detection, the run's success status, and `last_success_at` are committed in
one transaction.

## Structured fields

Connectors populate `workplace_type`, `employment_type`, and the salary columns only
from explicit provider fields (`src/ingestion/structured.ts`); nothing is inferred from
description text.

| Provider | Workplace type | Employment type | Salary |
| --- | --- | --- | --- |
| Ashby | `workplaceType` | `employmentType` enum | the single annual `Salary` entry in `compensation.summaryComponents` |
| Lever | `workplaceType` (`unspecified` → null) | recognised words in free-text `categories.commitment` | `salaryRange` when `interval = per-year-salary` |
| Greenhouse | not supplied | not supplied | not supplied |

Hourly and monthly pay, equity, and unrecognised commitments (e.g. `Global | LATAM`)
remain null in the canonical record and are preserved in `raw_payload`. A change to any
of these fields counts as an update even when the content hash is unchanged.

## Verified result after migration 003 (2026-11-26)

Two `npm run ingest` runs after applying migration 003, all 20 sources succeeding:

| Run | Seen | Inserted | Updated | Unchanged | Missing | Expired |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First | 3,504 | 0 | 3,321 | 183 | 83 | 0 |
| Second | 3,504 | 0 | 0 | 3,504 | 83 | 83 |

The first run's updates are one-time backfills: 674 Ashby/Lever postings gained
structured fields, and 2,647 Greenhouse postings picked up the earlier `first_published`
posting-date and entity-decoding fixes. The 83 stale Stripe records were missed once in
the first run and expired in the second, leaving **3,504 active** postings, which equals
the live listings. Field coverage among the 674 active Ashby/Lever postings: 667 have a
workplace type, 646 an employment type, and 361 an annual salary (342 in USD). None of the
2,830 active Greenhouse postings has these fields, as expected.

## Provider caveats

- Greenhouse sends description content as entity-escaped HTML. It is decoded before
  text extraction. Its public board API has no structured workplace, employment-type,
  or salary fields.
- All connectors use the shared `getWithRetry` (per-attempt timeout, retries on
  network/429/5xx errors).
- Lever uses both global and EU API hosts. The connector tries the EU host only after
  a global 404.
- Ashby requires the job-board name, not an individual job ID. Its public response is
  an object with a `jobs` array.
