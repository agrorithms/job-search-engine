# Job Scanner --- Ingestion Pipeline and ATS Connectors

## Purpose

The ingestion subsystem retrieves public job postings from supported ATS
providers and converts provider-specific responses into a stable
application-level representation.

It is a background process, separate from the Next.js dashboard. Its
operation must not depend on a user page load.

## Initial providers

-   Greenhouse
-   Lever
-   Ashby

Workday and other providers may be considered later. LinkedIn and Indeed
scraping are explicitly outside the initial scope.

## Connector contract

Every provider connector should implement a common contract.
Provider-specific HTTP details and response shapes should remain inside
the provider implementation.

The earlier design discussed a connector with `fetchJobs` and
`normalizeJob` methods. The November 18 implementation discussion
identified a simpler normalized boundary as the preferred refactor:

``` ts
interface ATSConnector {
  readonly provider: string;
  fetchJobs(source: ATSSource): Promise<NormalizedJob[]>;
}
```

Under this proposed contract, each connector is responsible for fetching
provider data and normalizing it before returning jobs to the shared
ingestion service. This keeps the ingestion service independent of
provider-specific raw types.

The exact contract and current repository code should be checked before
changing implementation. The refactor is a design direction from the
implementation discussion; do not assume it has already been completed.

## Shared types

`src/ingestion/types.ts` is the shared home for cross-provider types
such as `ATSSource` and `NormalizedJob`.

The source configuration needs, at minimum, enough information to
identify: - The provider. - The provider-specific board identifier. -
The company/source association. - Any endpoint or configuration required
by that provider.

Keep the identifier generic. `board_identifier` may be a Greenhouse
board token, Lever site identifier, or Ashby board name. Avoid naming
the generic field after one provider.

The normalized job type should represent the fields the application
needs across providers, while allowing source fields that are genuinely
unavailable to remain absent/null. Preserve the raw provider response as
`rawPayload: unknown` (or an equivalent source-record field) rather than
pretending every provider has the same raw schema.

## Current implementation context

The implementation chat identified this scaffold:

``` text
src/
└── ingestion/
    ├── connectors/
    │   ├── ats-connector.ts
    │   └── greenhouse.ts
    └── types.ts

scripts/
└── ingest-greenhouse.ts
```

At the time of that discussion: - The Greenhouse connector was
working. - The current connector/type definitions were being reviewed. -
The proposed next architectural step was to generalize the interface and
ingestion entry point.

Treat this as a point-in-time project status, not a guarantee about the
repository's present state. Inspect the code before assuming that a
planned refactor or file exists.

## Intended connector organization

As provider support grows, a provider-oriented organization is
appropriate:

``` text
src/ingestion/
├── connectors/
│   ├── ats-connector.ts
│   ├── greenhouse.ts
│   ├── lever.ts
│   └── ashby.ts
├── types.ts
├── registry.ts
└── services/
    └── ingest-source.ts

scripts/
├── ingest-greenhouse.ts
└── ingest.ts
```

This is a proposed organization. Keep the current repository structure
if it is already organized differently and the separation of
responsibilities remains clear.

## Provider registry

A shared registry should resolve a configured provider to its connector
implementation. The shared ingestion entry point should not contain
provider-specific branching throughout the pipeline.

Conceptually:

``` ts
const connector = connectorRegistry.get(source.provider);
const jobs = await connector.fetchJobs(source);

for (const job of jobs) {
  await upsertJob(job, source);
}
```

The actual registry API, error behavior, and database service should
follow the existing codebase conventions.

The intended progression from the current Greenhouse-specific script
is: 1. Keep the working Greenhouse path operational. 2. Establish the
normalized connector interface. 3. Add a provider registry. 4. Introduce
a shared ingestion script/service that accepts configured sources. 5.
Add Lever and Ashby implementations against the same contract.

## Ingestion workflow

A robust source ingestion run should:

1.  Create an ingestion-run record.
2.  Load and validate the ATS source configuration.
3.  Resolve the connector from the provider registry.
4.  Fetch the source's complete job listing.
5.  Validate and normalize each returned job.
6.  Upsert canonical jobs and source records.
7.  Preserve the raw provider payload.
8.  Detect meaningful content changes using a content hash.
9.  Update source and job last-seen timestamps.
10. Identify missing jobs only after a successful, complete listing.
11. Record counts, failures, and run status.

The process must be idempotent: running it twice against unchanged
source data should not create duplicate jobs or source records.

## Failure handling and safety

-   Use request timeouts.
-   Retry transient errors with exponential backoff.
-   Respect provider rate limits and configure per-provider concurrency.
-   Validate response status and response shape.
-   Record failures per source/company so one failure does not hide
    other results.
-   Use database transactions for related writes.
-   Do not mark jobs inactive after a failed or incomplete fetch.
-   Do not treat an empty response as a valid complete listing unless
    the provider response has been validated as successful and complete.
-   Log company ID, source ID, provider, and ingestion-run ID.
-   Keep raw payloads for debugging and future re-normalization.

## Deduplication

Use source identity first:

``` text
UNIQUE (ats_source_id, external_job_id)
```

Then use normalized application URLs as a stronger cross-source signal.
Similarity-based deduplication should be conservative and should not
merge jobs on title similarity alone.

## Testing

Use saved provider response fixtures so tests do not depend on live
external job boards.

Recommended test coverage: - Valid Greenhouse response normalization. -
Missing or malformed optional fields. - Invalid provider response and
non-success HTTP status. - Empty but valid complete listing. - Timeout
and retry behavior. - Repeated ingestion produces no duplicates. -
Changed description updates the canonical record and content hash. -
Failed/incomplete run does not expire jobs. - Successful complete run
can identify missing jobs. - Registry returns the correct connector for
each provider. - Unsupported provider fails clearly.

## Provider API examples from the original design

These are implementation starting points, not production-ready clients.
Verify current provider documentation and response contracts before
relying on them.

**Greenhouse public board endpoint:**

``` ts
const url =
  `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
```

**Lever postings endpoint:**

``` ts
const url =
  `https://api.lever.co/v0/postings/${site}?mode=json`;
```

**Ashby public job board endpoint:**

``` ts
const url =
  `https://api.ashbyhq.com/posting-api/job-board/${boardName}?includeCompensation=true`;
```

Production implementations still need validation, timeouts, retries,
pagination where applicable, logging, and rate-limit handling.
