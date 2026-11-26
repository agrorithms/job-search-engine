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

## Provider caveats

- Greenhouse sends description content as entity-escaped HTML. It is decoded before
  text extraction. The current connector makes one request and has no retry/timeout;
  a failed response produces a failed source run.
- Lever uses both global and EU API hosts. The connector retries network/429/5xx
  errors and tries the EU host only after a global 404.
- Ashby requires the job-board name, not an individual job ID. Its public response is
  an object with a `jobs` array; the connector retries network/429/5xx errors.
- Failed or incomplete fetches never mark jobs inactive. Expiration is intentionally
  deferred until a separate missing-job policy is implemented.
