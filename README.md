# Personal Job Search Engine

Local-first starter: Next.js/TypeScript dashboard, PostgreSQL + pgvector, SQL migration runner, and a working Greenhouse public-board importer.

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

## Add a Greenhouse employer
Find the board token in the employer's Greenhouse careers URL (often `boards.greenhouse.io/<token>`), then set these values in `.env.local`:
```dotenv
GREENHOUSE_BOARD_TOKEN=your_board_token
GREENHOUSE_COMPANY_NAME=Company Name
GREENHOUSE_COMPANY_WEBSITE=https://company.example
GREENHOUSE_CAREERS_URL=https://company.example/careers
```
Run `npm run ingest:greenhouse`. Repeat it to confirm that existing postings are updated rather than duplicated.

## Commands
`npm run typecheck` · `npm run db:migrate` · `npm run ingest:greenhouse` · `npm run build`

## Included tables
`companies`, `ats_sources`, `job_postings`, `job_sources`, `ingestion_runs`, `profiles`, `resume_documents`, `job_embeddings`, `job_matches`, `saved_jobs`.

## Known limitations
- Greenhouse importer only; Lever/Ashby adapters are next.
- No resume parsing, embeddings generation, LLM evaluation, or scheduled worker yet.
- HTML stripping is intentionally lightweight; replace with a robust parser and tests before relying on extracted description text.
- Missing postings are not marked inactive. Only implement expiry after repeated successful complete source fetches.
- The embedding column is `vector(1536)` as a placeholder; change it to match the embedding model selected before writing vectors.
- Add authentication before exposing the app beyond localhost.
- Do not commit `.env.local`; do not send resume data to an external model without deciding on provider/data handling.
