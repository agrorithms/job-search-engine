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
