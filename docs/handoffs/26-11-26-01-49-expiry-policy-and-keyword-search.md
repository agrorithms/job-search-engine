# Job Search Engine — Handoff: Expiry Policy & Keyword Search

Nov 26, 2026 · @Louis

## Summary

Phases 1–3 of the roadmap are complete and Phase 4 (search) is partly done: keyword search and filters work, while semantic and hybrid search are blocked on choosing an embedding model. The work is in [PR #4](https://github.com/agrorithms/job-search-engine/pull/4) on branch `feat/expiry-policy-and-keyword-search`, not yet merged.

The catalog holds 3,504 active jobs from 20 employers across Greenhouse (7), Lever (6), and Ashby (7). That count matches the live boards exactly after the new expiry policy retired 83 stale Stripe postings.

## What was built

Three pieces of work, all in PR #4: a safer job-expiry policy, structured job fields, and a keyword search page.

### 1. Missing-job expiry policy (migration 003)

The previous code expired a job after a single missed poll and treated an empty response as a complete listing. Docs 03 and 04 warn against both.

- A job expires only after it is absent from **2 consecutive successful listings** of its source. The counter is `job_sources.missed_runs`, and the threshold is `MISSED_RUNS_BEFORE_EXPIRY` in `src/ingestion/services/ingest-source.ts`.
- Seeing a job again resets its counter. An expired job that reappears is reactivated.
- A failed fetch never counts as a miss. An empty listing from a source that still has active jobs skips the check and sets `ingestion_runs.missing_check_skipped`.
- New `job_events` table records `created`, `updated` (with the changed field names), `expired`, and `reactivated`, each linked to its ingestion run.
- Missing-job detection, the run's success status, and `last_success_at` commit in one transaction.

### 2. Structured job fields

Workplace type, employment type, and salary were empty for every job, though Ashby and Lever supply them.

| Provider | Workplace type | Employment type | Salary |
| --- | --- | --- | --- |
| Ashby | `workplaceType` | `employmentType` enum | annual `Salary` entry in `compensation` |
| Lever | `workplaceType` | keywords in free-text `categories.commitment` | `salaryRange` when per-year |
| Greenhouse | not supplied | not supplied | not supplied |

Mapping lives in `src/ingestion/structured.ts`. Nothing is inferred from description text. Only annual salaries are stored; hourly and monthly pay stays in `raw_payload`. A change to any of these fields counts as an update even when the content hash matches.

### 3. Keyword search and filters

The home page replaced the capped 200-row list with search over all active jobs.

- Keywords use PostgreSQL `websearch_to_tsquery` over the existing `search_vector`, ranked by `ts_rank_cd`. Quoted phrases and `-exclusions` work.
- Filters: company, location, workplace type, employment type, minimum annual USD salary, and posted within 1/7/30/90 days.
- 50 results per page. Filters live in the URL, so searches can be bookmarked.
- `src/lib/jobs/search.ts` is a pure, unit-tested query builder. All user input is bound as parameters; invalid values are ignored.

## Verification

Typecheck, 56 unit tests, and the production build all pass. The new policy behaved as designed against the 20 live boards.

| Run (after migration 003) | Seen | Inserted | Updated | Unchanged | Missing | Expired |
| --- | --: | --: | --: | --: | --: | --: |
| First | 3,504 | 0 | 3,321 | 183 | 83 | 0 |
| Second | 3,504 | 0 | 0 | 3,504 | 83 | 83 |

- First-run updates were one-time backfills: 674 Ashby/Lever postings gained structured fields, and 2,647 Greenhouse postings picked up the posting-date and entity-decoding fixes from PR #3, which had never been run against the database.
- The 83 stale Stripe postings were missed in run 1 and expired in run 2.
- Coverage among the 674 active Ashby/Lever jobs: 667 have a workplace type, 646 an employment type, and 361 an annual salary (342 in USD).
- Every search filter combination was run against the local database. The page was rendered from a production build, including pagination, an empty result, and junk URL parameters.

## Known limitations

The biggest gap is that structured filters cover only 674 of 3,504 jobs, because Greenhouse publishes none of those fields.

- **Filters exclude Greenhouse.** Turning on workplace, employment-type, or salary drops all 2,830 Greenhouse jobs. The page says so under the form.
- **Salary filter is USD-only and annual-only.** It never compares across currencies or pay periods; other pay stays in `raw_payload`.
- **Seniority is empty.** No connector populates it, so there is no seniority filter.
- **Keyword ranking is basic.** For "data engineer" + remote, the top hit was a "Product Engineer" role whose description mentions data. Semantic search is meant to fix this.
- **Stop-word-only queries return nothing.** A search for "the" yields zero results instead of all jobs.
- **An employer that closes every role never expires.** Its empty listing is distrusted, so those jobs stay active until the board lists something again.
- **Lever employment type is keyword-matched.** Free-text values like "Global | LATAM" or "Working Student" stay null by design.
- **No cross-source deduplication.** Each company has one source today, so identity is by `(ats_source_id, external_job_id)` only.
- **No scheduler, no authentication.** Ingestion runs by hand with `npm run ingest`, and the app is for localhost only.

## Next steps

Merge PR #4, then finish Phase 4 with semantic and hybrid search. Steps 2–5 depend on the embedding-model decision below.

1. **Review and merge PR #4.** Run `npm run db:migrate` on any other database first.
2. **Choose an embedding model** (open question 1), then write a migration that sets `job_embeddings.embedding` to its dimension. Also add `content_hash` to `job_embeddings`, which doc 03 requires but the current table lacks.
3. **Generate job embeddings.** Write an `npm run embed` script that embeds only jobs whose `content_hash` or model changed, as doc 05 requires. Start it from `job_events` of type `created` or `updated` with `content` in its fields.
4. **Semantic retrieval.** Add an HNSW or IVFFlat index and a nearest-neighbour query behind the same filters as keyword search.
5. **Hybrid ranking.** Combine keyword and semantic rankings with Reciprocal Rank Fusion, and add the keyword / semantic / hybrid mode switch to the page.
6. **Seniority.** Decide on a source (open question 3), then add a seniority filter.
7. **Phase 5: resume and matching.** Resume upload and parsing, a reviewed profile, LLM evaluation of a shortlist of about 30 jobs, and cached results. This needs the data-handling decision in open question 2.
8. **Phase 6: automation.** Scheduled ingestion, a "new since last visit" and "recently expired" view built on `job_events`, and monitoring of `missing_check_skipped` runs.

## Open questions

Question 1 blocks the next step. The others can wait until their phase.

- [ ] **1. Which embedding model?** Anthropic has no embeddings API. The options are Voyage AI or OpenAI (hosted, so job text is sent to an outside service) or a local model through Ollama (private, no per-call cost, needs local compute). The choice also sets the vector dimension.
- [ ] **2. Where can resume data go?** The README says not to send resume data to an outside model until a provider and data-handling policy is chosen. Phase 5 needs this answer.
- [ ] **3. How should seniority be filled?** No provider sends it. Options: parse job titles ("Senior", "Staff", "Intern"), let the Phase 5 LLM step extract it, or leave it unknown. Title parsing bends the "don't infer" rule in doc 01.
- [ ] **4. Should salary filtering go beyond USD?** 19 jobs list annual salaries in CAD, EUR, or GBP. Options: a currency picker, conversion at fixed rates, or USD only.
- [ ] **5. Is 2 the right number of misses before expiry?** It suits daily ingestion. With hourly runs, 2 misses is only 2 hours, so the threshold may need to be time-based instead.
- [ ] **6. How should a fully closed board be handled?** An employer that removes every role keeps its jobs active forever. One option is to accept an empty listing after N consecutive empty runs.
- [ ] **7. Should Greenhouse get structured fields from its metadata?** Greenhouse is 81% of the catalog. Its `metadata` and `offices` fields vary by employer and might hold usable data, but that needs per-employer mapping.

## How to pick up

Start Postgres, migrate, ingest, then open the app at http://localhost:3000.

```bash
git checkout feat/expiry-policy-and-keyword-search   # or main once PR #4 merges
docker compose up -d
npm run db:migrate
npm run ingest      # run twice to see the steady state
npm run dev
npm run typecheck && npm test
```

| To understand | Look at |
| --- | --- |
| Roadmap and progress | `docs/05_MATCHING_SEARCH_AND_ROADMAP.md` (Progress section) |
| Expiry policy, field mapping, verified run results | `docs/06_VALIDATED_INGESTION_WORKFLOW.md` |
| Ingestion and expiry logic | `src/ingestion/services/ingest-source.ts` |
| Provider field mapping | `src/ingestion/structured.ts` and `src/ingestion/connectors/` |
| Search query builder | `src/lib/jobs/search.ts` |
| Search page | `src/app/page.tsx` |
| Schema changes | `migrations/003_missing_job_policy_and_events.sql` |

To see why a job changed or expired, query `job_events` for its `job_id`. Each event links to its `ingestion_runs` row.
