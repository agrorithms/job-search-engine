# Job Scanner --- System Architecture

## Architectural overview

Job Scanner is one Git repository containing two independently
executable application concerns:

1.  **Web application:** Next.js + TypeScript dashboard, API routes, and
    server-side application functionality.
2.  **Background ingestion worker:** Node.js + TypeScript process that
    polls ATS sources and updates job data.

The worker must not depend on a user opening the dashboard. A dashboard
request should never trigger hundreds of ATS requests.

``` mermaid
flowchart LR
    ATS[Public ATS job boards]
    subgraph Worker[Background ingestion process]
        DISC[Company and source registry]
        CONN[ATS connectors]
        NORM[Validation and normalization]
        DEDUP[Upsert and deduplication]
    end
    subgraph Data[Shared database]
        COMPANY[Companies and ATS sources]
        JOBS[Canonical job postings]
        SOURCES[Source records and raw payloads]
        PROFILE[Profiles and resume documents]
        MATCH[Embeddings and match evaluations]
        OPS[Ingestion runs and job events]
    end
    subgraph App[Next.js web application]
        API[Server-side API]
        UI[Dashboard and job search]
        REVIEW[Job detail and profile management]
    end
    subgraph Eval[Separate evaluation workflow]
        EMBED[Embedding generation]
        RETRIEVE[Hybrid retrieval]
        LLM[Shortlist LLM evaluation]
    end
    ATS --> CONN
    DISC --> CONN
    CONN --> NORM --> DEDUP
    DEDUP --> JOBS
    DEDUP --> SOURCES
    DISC --> COMPANY
    Worker --> OPS
    JOBS --> EMBED --> MATCH
    PROFILE --> EMBED
    JOBS --> RETRIEVE
    PROFILE --> RETRIEVE
    RETRIEVE --> LLM --> MATCH
    UI --> API
    REVIEW --> API
    API <--> Data
```

## Major subsystems

1.  **Company discovery and source management** --- maintains the
    employer registry and ATS configuration.
2.  **Job ingestion and processing** --- fetches, validates, normalizes,
    deduplicates, and updates postings.
3.  **Database and search indexing** --- stores canonical jobs, source
    evidence, profiles, operational history, and search indexes.
4.  **Resume matching and AI evaluation** --- extracts profile
    information, generates embeddings, retrieves relevant jobs, and
    evaluates a shortlist.
5.  **Web dashboard** --- supports discovery, filtering, job review,
    profile management, and eventually application tracking.

Each subsystem should have a clear responsibility and communicate
through explicit interfaces and persisted data.

## Critical separation: ingestion versus evaluation

These are independent workflows.

### Ingestion responsibilities

-   Discover and poll configured ATS sources.
-   Fetch new and updated postings.
-   Validate provider responses.
-   Normalize provider-specific records into the shared job model.
-   Upsert canonical jobs and source records.
-   Detect changed content.
-   Identify missing postings only after a successful, complete source
    listing.
-   Record run history and failures.

### Evaluation responsibilities

-   Extract and maintain structured candidate profiles.
-   Generate embeddings for profile content and job descriptions.
-   Retrieve relevant jobs.
-   Apply hard filters.
-   Evaluate a limited shortlist with an LLM.
-   Persist scores, verdicts, explanations, and gaps.

Changing a resume should not require rerunning ATS ingestion. An ATS
refresh should not force reevaluation of every job. Content hashes and
profile versions should be used to determine what actually needs
reprocessing.

## Technology direction

  -----------------------------------------------------------------------
  Concern                             Direction
  ----------------------------------- -----------------------------------
  Language                            TypeScript

  Web application                     Next.js

  Worker                              Separate Node.js process

  Database                            SQLite is acceptable for a
                                      prototype; PostgreSQL is the
                                      intended established architecture

  Semantic search                     PostgreSQL + pgvector in the
                                      established architecture

  Background queue                    Redis + BullMQ later, if
                                      operational needs justify it

  Model services                      Embedding provider and LLM provider
                                      behind application-level interfaces

  Development environment             Windows + WSL2 Ubuntu; VS Code
                                      connected to WSL

  Local infrastructure                Docker Compose for PostgreSQL when
                                      using that database
  -----------------------------------------------------------------------

Do not run SQLite and PostgreSQL together as competing application
databases in the initial version. Choose one active database
implementation for a given development stage. The original design favors
PostgreSQL + pgvector as the target; SQLite remains a reasonable
prototype option because it is already familiar and can handle the
initial data scale.

## Deployment model

Initially, run the web application, database, and worker locally. The
worker should be started and monitored separately from Next.js. Once the
system is reliable, move the database and worker to a small hosted
environment so scheduled ingestion continues while the development
laptop is off.

## Repository organization

The original proposed structure was:

``` text
job-search-engine/
├── src/
│   ├── app/
│   │   ├── dashboard/
│   │   ├── jobs/
│   │   ├── profile/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   │   ├── db/
│   │   ├── validation/
│   │   └── config/
│   ├── ingestion/
│   │   ├── connectors/
│   │   ├── normalizers/
│   │   └── services/
│   ├── search/
│   └── matching/
├── scripts/
├── migrations/
├── tests/
├── docker-compose.yml
├── package.json
└── .env.example
```

The current scaffold discussed in the implementation chat includes:

``` text
src/ingestion/connectors/ats-connector.ts
src/ingestion/connectors/greenhouse.ts
src/ingestion/types.ts
scripts/ingest-greenhouse.ts
```

Treat the current repository as authoritative for exact paths and
implemented behavior. The broader tree above is a target organization,
not a claim that every directory or module already exists.

## Operational boundaries

-   Keep secrets in environment variables; never expose them to
    client-side code.
-   Use structured logs with company, source, and ingestion-run
    identifiers.
-   Apply timeouts, retries, and provider-specific concurrency limits.
-   Keep database writes controlled and transactional where multiple
    records must change together.
-   Keep raw source data separate from normalized application data.
-   Build the ingestion process so it can be run repeatedly without
    creating duplicates.

## Architectural decision rule

Prefer a simple modular monolith in one repository over premature
microservices or a monorepo. Separate processes where their runtime
responsibilities differ, especially the web server and ingestion worker,
while keeping shared TypeScript contracts explicit.
