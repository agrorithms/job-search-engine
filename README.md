# Personal Job Search Engine

Local-first starter: Next.js/TypeScript dashboard, PostgreSQL + pgvector, SQL migration runner, and public-board importers for Greenhouse, Lever, and Ashby.

## Requirements
- Node.js 20.9+ (Node 22 LTS recommended)
- npm
- Docker Desktop with WSL2 integration enabled (if developing in WSL2)

## Setup
```bash
cp .env.example .env.local
npm install
docker compose up -d
npm run db:migrate
npm run dev
```
Open http://localhost:3000.

## Add ATS employers
Find the board token in the employer's Greenhouse careers URL (often `boards.greenhouse.io/<token>`), then set these values in `.env.local`:
```dotenv
GREENHOUSE_BOARD_TOKEN=your_board_token
GREENHOUSE_COMPANY_NAME=Company Name
GREENHOUSE_COMPANY_WEBSITE=https://company.example
GREENHOUSE_CAREERS_URL=https://company.example/careers
```
Run `npm run ingest:greenhouse`. Repeat it to confirm that existing postings are updated rather than duplicated.

The initial 20-company registry is supplied by migration `002_seed_validated_sources.sql`.
It contains seven Greenhouse, six Lever, and seven Ashby boards whose public JSON
endpoints were checked before they were added. Run the migration and then:

```bash
npm run ingest
```

For an additional employer, insert an active `ats_sources` row and run `npm run ingest`:

- Lever: `provider='lever'`, `board_identifier` is the site slug in `jobs.lever.co/<slug>`.
- Ashby: `provider='ashby'`, `board_identifier` is the board name in `jobs.ashbyhq.com/<board-name>`.

See [the validated ingestion workflow](docs/06_VALIDATED_INGESTION_WORKFLOW.md) for
the seeded boards, verification queries, repeat-run expectations, and provider caveats.

## Commands
`npm run typecheck` · `npm test` · `npm run db:migrate` · `npm run ingest` · `npm run ingest:greenhouse` · `npm run build`

## Included tables
`companies`, `ats_sources`, `job_postings`, `job_sources`, `job_events`, `ingestion_runs`, `profiles`, `resume_documents`, `job_embeddings`, `job_matches`, `saved_jobs`.

## Search
The home page searches active jobs: keywords (PostgreSQL full-text search over title,
description, and location, with `websearch_to_tsquery` syntax such as `"data engineer" -senior`),
company, location, workplace type, employment type, minimum annual USD salary, and posting date.
Results are paginated and every filter is a URL parameter, so searches can be bookmarked.

## Known limitations
- Greenhouse, Lever, and Ashby connectors exist. `npm run ingest` processes every active source sequentially.
- All connectors share a timeout and retry network, 429, and 5xx failures. A failed run never counts as an empty listing.
- A job is expired only after it is absent from 2 consecutive successful listings of its source; an empty listing from a source that still has active jobs skips the check. Expiry, reactivation, creation, and updates are recorded in `job_events`.
- Workplace type, employment type, and salary come only from structured provider fields (Ashby, Lever). The public Greenhouse API doesn't supply them, so those filters exclude Greenhouse jobs. Only annual salary ranges are stored in the salary columns; hourly/monthly pay stays in `raw_payload`. Seniority is not populated yet.
- Search is keyword-only. No embeddings, semantic or hybrid search, resume parsing, LLM evaluation, or scheduled worker yet.
- Project design docs live in `docs/`.
- HTML stripping is intentionally lightweight; replace with a robust parser and tests before relying on extracted description text.
- The embedding column is `vector(1536)` as a placeholder; change it to match the embedding model selected before writing vectors.
- Add authentication before exposing the app beyond localhost.
- Do not commit `.env.local`; do not send resume data to an external model without deciding on provider/data handling.
