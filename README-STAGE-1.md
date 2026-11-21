# Job Scanner — Stage 1 ingestion refactor

## Files

Copy the files in this archive into the matching paths in your repository.
`package.json` is a complete replacement based on the version supplied for
this refactor; it adds the `ingest` script and retains `ingest:greenhouse`.

## What changed

- `ATSConnector.fetchJobs` now returns `NormalizedJob[]`.
- Greenhouse response types and normalization are private to the Greenhouse
  connector.
- `rawPayload` remains `unknown` in the shared model.
- `ingestSource` owns ingestion-run logging and shared PostgreSQL persistence.
- `registry.ts` resolves providers; Greenhouse is registered today.
- `scripts/ingest.ts` loads all active ATS sources and processes them
  sequentially, continuing after a source-level failure.
- `scripts/ingest-greenhouse.ts` remains as a compatibility/regression command
  and retains the original environment-variable-driven company/source setup.

## Commands

Run the legacy Greenhouse path first:

```bash
npm run ingest:greenhouse
```

Then run the database-driven command:

```bash
npm run ingest
```

Both commands use the same Greenhouse connector and shared ingestion runner.

## Important behavior and limitations

- No migration is included. The existing `board_identifier` column is retained.
- Jobs are not expired or marked missing by this refactor.
- A failed source fetch does not update job records or expire existing jobs.
- Writes remain transactional per job, matching the existing transaction
  boundary.
- Sources are processed sequentially to avoid introducing concurrency before
  it is needed.
- The runner updates `job_postings.updated_at` when an existing job is refreshed.
- The current database schema constrains providers to `greenhouse`, `lever`,
  and `ashby`; the registry currently implements only `greenhouse`.
- This archive is generated from the source pasted into the conversation.
  It has not been run against your local repository or database. Run
  `npm run typecheck` and the commands above in your working copy before
  treating the refactor as verified.

## Next validation

1. Apply the files.
2. Run `npm run typecheck`.
3. Run `npm run ingest:greenhouse` and compare its inserted/updated counts with
   the previous importer behavior.
4. Run `npm run ingest` and confirm it discovers the same active source.
5. Inspect `ingestion_runs`, `job_postings`, and `job_sources` for expected
   records.
