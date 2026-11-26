# Embeddings and Hybrid Search

Status: agreed design, not yet implemented. Decided 2026-11-26.

This document finishes Phase 4 of the roadmap (`05_MATCHING_SEARCH_AND_ROADMAP.md`):
job embeddings, semantic retrieval, and Reciprocal Rank Fusion (RRF) hybrid ranking on top of the existing
keyword search. It resolves open question 1 of the
[expiry-policy handoff](handoffs/26-11-26-01-49-expiry-policy-and-keyword-search.md).

## Goals and constraints

- Semantic and hybrid search over active jobs, behind the same filters as keyword search.
- **$0/month.** Free tiers and self-hosted infrastructure only.
- **Local first.** Everything runs on the development laptop: WSL2 Ubuntu on Windows 11,
  i7-1165G7 (8 threads), about 6 GB RAM available to WSL, Docker Desktop.
- **Ready to move.** A later move to Vercel, with embeddings from Voyage AI or a
  self-hosted Ollama on an Oracle Cloud ARM VM, must not need a schema change or
  changes to calling code.

## What embeddings do

An embedding model turns a piece of text into 1,024 numbers, which are the coordinates of a
point in a 1,024-dimensional space. Texts with similar meaning land close together even
when they share no words. Each job is embedded once and stored. At search time the
query is embedded the same way, and Postgres returns the jobs whose points are
nearest by cosine distance. Keyword search matches words. Semantic search matches meaning.
Hybrid search fuses the two rankings, so exact keyword hits are not lost.

## Design

### Model and runtime

- **Model:** `qwen3-embedding:0.6b` through Ollama. It outputs 1024 dimensions and has a 32k-token context.
- **Fallback model:** `bge-m3`, also 1024 dimensions with an 8k context, if Qwen disappoints in the evaluation.
- **Runtime:** an `ollama` service in `docker-compose.yml`, with a named volume for the model files.
  It starts with `docker compose up -d` alongside Postgres. A one-time `npm run embed:setup`
  pulls the model into the container.
- **`keep_alive`:** Ollama loads the model weights (about 640 MB) into RAM on the first request.
  It keeps them loaded for `keep_alive`, then frees them. The first request after an unload is a
  **cold start** and takes about 2–5 seconds to reload. After that, a query embeds in about 100 ms.
  Search requests use `keep_alive: 30m`. The embed script uses `5m`.

### Embedding module

All embedding calls go through `src/lib/embeddings.ts`. No route, script, or query
helper calls Ollama directly.

```ts
type InputType = 'document' | 'query';
embed(text: string, inputType: InputType): Promise<number[]>;
embedBatch(texts: string[], inputType: InputType): Promise<number[][]>;
```

- `EMBEDDING_PROVIDER` chooses the backend. Only `ollama` is implemented.
- The Ollama provider reads `OLLAMA_BASE_URL` (default `http://localhost:11434`),
  `EMBEDDING_MODEL` (default `qwen3-embedding:0.6b`), an optional auth header, and a request
  timeout. It calls `POST /api/embed`.
- For `inputType === 'query'`, the provider adds Qwen's instruction prefix:
  `Instruct: Given a job search query, retrieve relevant job postings\nQuery: <text>`.
  Documents are embedded as they are. Callers never see the prefix.
- Every vector is checked with `length === 1024` before it is used or stored. A mismatch throws.

### Embedded text

Each job is embedded as a short header plus its description:

```
<title>
<company> · <location> · <workplace type>

<description, capped at EMBED_MAX_DESCRIPTION_CHARS ≈ 12,000>
```

Active descriptions have a median of about 6,200 characters, a 90th percentile of about 9,900,
and a maximum of about 18,600. A 12k cap covers the full text of roughly 95% of jobs. What it
cuts is mostly benefits and equal-opportunity (EEO) boilerplate, and the cap keeps CPU time down.
The cap is a constant in the embed module.

### Schema (migration 004)

`job_embeddings` was created in migration 001 as `vector(1536)` and has no rows, so it can
change without migrating any data.

- Change `embedding` to `vector(1024)`.
- Add `content_hash TEXT NOT NULL`. This is the hash of the job when it was embedded, as doc 03
  requires.
- Keep `job_id` as the primary key and keep `embedding_model`. Every semantic query filters on
  `embedding_model = <active model>`, so vectors from two models are never compared.
- No ANN (approximate nearest-neighbour) index. An exact cosine scan of about 3.5k × 1024 vectors takes milliseconds. Add HNSW
  when the catalog passes about 50k jobs.

### `npm run embed`

A separate script. It is not part of `npm run ingest`, so ingestion keeps working when
Ollama is down.

- It selects active jobs with no `job_embeddings` row for the active model, or whose stored
  `content_hash` differs from the job's current hash.
- It embeds in small batches and commits each batch. Interrupting it (Ctrl-C, shutdown,
  WSL restart) loses at most the batch in progress. The next run picks up where it stopped.
  Stored vectors live in the Postgres volume and survive restarts.
- A thread cap (Ollama `num_thread`) keeps the laptop usable during the backfill.
- **Switching models:** change `EMBEDDING_MODEL` and run `npm run embed`. Search stays correct
  throughout, because it only sees vectors from the active model. Coverage fills in as the
  backfill runs. The same script is the re-embed tool, and no separate script is needed.

**Expected load.** The first backfill is about 5M tokens and keeps the CPU at full load for
hours. Run it overnight on mains power. After that, each ingest changes perhaps tens of jobs,
which embed in seconds to a minute.

### Search

- **Modes:** keyword, semantic, and hybrid, chosen by a mode switch in the URL. Hybrid is the
  default when there is a text query.
- **Semantic:** an exact cosine-distance (`<=>`) scan over active jobs with the active model, using
  the same filters as keyword search.
- **Hybrid:** keyword and semantic each take their top 200 under the same filters. RRF fuses them
  (`score = Σ 1 / (60 + rank)`), and the fused list is paginated 50 per page.
- **No text query:** filters only, sorted newest first. There is nothing to embed.
- **Ollama unreachable:** fall back to keyword results with a visible
  "semantic search unavailable" notice. Never show an error page.

### Evaluation gate

Before the full backfill:

1. Embed a 200-job sample and measure throughput, to get a real time estimate for the backfill.
2. Run about 5 fixed test queries in keyword and hybrid mode and compare the results by eye.
   One is "data engineer" + remote, which put a "Product Engineer" role first in keyword mode.
3. Keep the queries in a committed file. Re-run them after any model change.

## Out of scope

- **Resume and profile embeddings:** Phase 5. This waits on the resume data-handling decision
  (handoff open question 2).
- **The Voyage provider:** not built until a hosted deployment needs it. The `inputType` parameter
  means adding it later changes nothing for callers.
- **Phase 2 hosting** (Vercel, Neon/Supabase, Oracle): only the seams above are built.
  Hosting gets its own design pass.

## Decision log

Each decision records what was chosen, why, and what was rejected.

### D1. Run embeddings locally with Ollama for now

**Why:** $0, no rate limits, and job and resume text stays on the machine.

**Rejected:**
- **OpenAI `text-embedding-3-small`.** It has no permanent free tier, and its 1536 default
  doesn't match the other candidates.
- **Google Gemini embeddings.** Free-tier inputs may be used to improve Google's products,
  which is unacceptable for resume data, and its rate limits are tighter.
- **Anthropic.** It has no embeddings API.
- **Voyage AI.** It is the preferred hosted option if one is ever needed, but nothing needs it yet.

### D2. Fix the vector dimension at 1024

**Why:** the chosen local model, the fallback local model, and Voyage's hosted models can all
produce 1024 dimensions. A provider switch then needs a re-embed but no schema or index change.
Switching models still invalidates every stored vector, and D6 handles that.

**Rejected:** 1536, because it is tied to OpenAI, which D1 rejected.

### D3. Use `qwen3-embedding:0.6b`, with `bge-m3` as fallback

**Why:** job descriptions are long (median about 1,500 tokens). Qwen3 takes 32k tokens, outputs
1024 natively, retrieves well on benchmarks, and supports a query instruction prefix.

**Rejected:**
- **`mxbai-embed-large`** (named in the first draft). Its 512-token context would silently embed
  only the first ~2k characters, which is usually company boilerplate.
- **`nomic-embed-text`.** It outputs 768 dimensions, which breaks D2.

### D4. Run Ollama as a Docker Compose service

**Why:** it starts and stops with Postgres from the one command already in use, and nothing is
installed on the host. WSL runs without systemd here, so a native install would not start on
its own after a reboot. Speed is the same either way, because Docker Desktop runs in the same WSL2 VM.

**Rejected:**
- **A native install in WSL Ubuntu.** It is one more thing to start by hand each session.
- **Ollama for Windows.** The app in WSL would have to reach Windows over the network.

The Oracle box would use a native systemd install. That doesn't matter to the app, which only
sees `OLLAMA_BASE_URL`.

### D5. Implement only the Ollama provider

**Why:** Voyage would be unused code. The `inputType` parameter, the env-based provider choice,
the base URL, the auth header, and the timeout are enough for a later swap.

**Rejected:** building Ollama and Voyage both now, as the first draft proposed.

### D6. Keep one vector per job and filter on the active model

**Why:** a model switch is expected at most once. Filtering on `embedding_model` keeps search
correct during a switch without a composite key.

**Rejected:**
- **A `(job_id, embedding_model)` composite key.** It allows a side-by-side backfill, which isn't
  worth it for one expected switch.
- **One model with no filter and a wipe on switch.** Semantic search would be down or wrong
  during the backfill.

### D7. Embed in a separate script that selects by hash difference

**Why:** ingestion doesn't depend on Ollama. Comparing hashes repairs itself after crashes,
partial runs, and model switches.

**Rejected:**
- **Embedding inside `npm run ingest`.** Ingestion would fail whenever Ollama is down.
- **Driving the script from `job_events`,** as the handoff suggested. Replaying events misses work
  after a crash, and a model switch produces no events.

### D8. Embed the header plus the description, capped at about 12k characters

**Why:** this covers the full text of about 95% of jobs, and it cuts CPU time and trailing boilerplate.

**Rejected:**
- **The full description.** It is slower for little gain.
- **Chunking into several vectors per job.** It adds complexity that isn't justified yet.

### D9. No ANN index yet

**Why:** an exact scan is fast at this size. HNSW applies `WHERE` filters after retrieval and
can return too few rows.

**Rejected:** HNSW or IVFFlat now. Revisit at about 50k jobs.

### D10. Hybrid search uses RRF over the top 200 from each mode, and falls back to keyword

**Why:** RRF needs no score calibration between `ts_rank_cd` and cosine distance. Falling back
keeps the page working when Ollama is off, which will be common locally.

**Rejected:** showing an error page when Ollama is unreachable.

### D11. Out of scope: Phase 2 hosting

The options on record, to be re-checked when hosting is designed:
- Vercel with Neon or Supabase Postgres, and Voyage for embeddings.
- Vercel with self-hosted Ollama on the existing Oracle Cloud Always-Free ARM VM
  (`VM.Standard.A1.Flex`, about 10 GiB free alongside an existing site). It would need a
  reverse proxy with auth and a swap file.

**Rejected for embeddings:**
- **Oracle Always-Free AMD Micro VMs.** 1 GB of RAM cannot hold the OS, Ollama, and the model.
- **A Cloudflare Tunnel to the laptop in production.** Search would be down whenever the laptop sleeps.

On Vercel, every semantic search must embed the query at request time, so the embedding
endpoint must be reachable from Vercel. Ingestion and `npm run embed` cannot run on Vercel
functions and would need another home, such as the Oracle box.

## Corrections to the first draft spec

- The `tsvector` column and its GIN index already exist (migration 001). Only the vector side is new.
- `job_embeddings` currently has `vector(1536)`, not 1024. Migration 004 changes it.
- WSL has about 6 GB of RAM, not the host's 12 GB.
- The re-embed script is `npm run embed`. A separate `scripts/reembed.ts` is not needed.

## Implementation order

1. Add the Compose `ollama` service and `npm run embed:setup`.
2. Write migration 004.
3. Write `src/lib/embeddings.ts` with unit tests for the prefix, the dimension check, and errors.
4. Write `npm run embed` with selection by hash difference and per-batch commits.
5. Run the evaluation gate on a 200-job sample.
6. Add the semantic query and RRF hybrid to `src/lib/jobs/search.ts`, then the mode switch and
   fallback notice in `src/app/page.tsx`.
7. Run the full overnight backfill and re-run the evaluation queries.
