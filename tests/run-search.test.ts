import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddingError } from "../src/lib/embeddings";
import { SEARCH_PAGE_SIZE, parseJobSearchParams } from "../src/lib/jobs/search";
import { runJobSearch, type SearchDeps } from "../src/lib/jobs/run-search";

const row = (id: string) => ({
  id, title: `Job ${id}`, companyName: "Acme", location: null, department: null, workplaceType: null,
  employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
  applicationUrl: `https://jobs.example/${id}`,
});

/**
 * A stand-in database that answers each kind of search query from fixed
 * rankings: the keyword list, the semantic (embedding) list, or the
 * keyword-only page used when there is no text query or semantic is unavailable.
 */
function fakeDb(rankings: { keyword?: string[]; semantic?: string[]; page?: string[]; total?: number }) {
  const query: SearchDeps["query"] = async (text, params) => {
    if (text.includes("COUNT(*)")) return { rows: [{ total: rankings.total ?? 0 }] };
    // Rows come back unordered, like Postgres with no ORDER BY.
    if (text.includes("= ANY(")) return { rows: [...(params[0] as string[])].reverse().map(row) };
    if (text.includes("job_embeddings")) return { rows: (rankings.semantic ?? []).map((id) => ({ id })) };
    if (/SELECT jp\.id\s+FROM/.test(text)) return { rows: (rankings.keyword ?? []).map((id) => ({ id })) };
    return { rows: (rankings.page ?? []).map(row) };
  };
  return { query };
}

const workingEmbedder = async () => [0.1, 0.2];

test("hybrid fuses keyword and semantic rankings, jobs in both first", async () => {
  const db = fakeDb({ keyword: ["a", "b"], semantic: ["b", "c"] });
  const result = await runJobSearch(parseJobSearchParams({ q: "data engineer" }), {
    query: db.query, embedQuery: workingEmbedder, model: "m",
  });
  assert.equal(result.mode, "hybrid");
  assert.equal(result.semanticUnavailable, false);
  assert.deepEqual(result.jobs.map((job) => job.id), ["b", "a", "c"]);
  assert.equal(result.total, 3);
});

test("when Ollama is unreachable, hybrid falls back to keyword results and says so", async () => {
  const db = fakeDb({ page: ["k1", "k2"], total: 2, semantic: ["never"] });
  const result = await runJobSearch(parseJobSearchParams({ q: "data engineer" }), {
    query: db.query,
    embedQuery: async () => { throw new EmbeddingError("Ollama is unreachable"); },
    model: "m",
  });
  assert.equal(result.mode, "keyword");
  assert.equal(result.semanticUnavailable, true);
  assert.deepEqual(result.jobs.map((job) => job.id), ["k1", "k2"]);
  assert.equal(result.total, 2);
});

test("semantic mode also falls back to keyword when embedding fails", async () => {
  const db = fakeDb({ page: ["k1"], total: 1 });
  const result = await runJobSearch(parseJobSearchParams({ q: "x", mode: "semantic" }), {
    query: db.query,
    embedQuery: async () => { throw new EmbeddingError("timed out"); },
    model: "m",
  });
  assert.equal(result.mode, "keyword");
  assert.equal(result.semanticUnavailable, true);
});

test("errors other than embedding failures are not hidden", async () => {
  const db = fakeDb({});
  await assert.rejects(
    runJobSearch(parseJobSearchParams({ q: "x" }), {
      query: db.query, embedQuery: async () => { throw new Error("bug"); }, model: "m",
    }),
    /bug/,
  );
});

test("without a text query nothing is embedded and jobs are listed newest first", async () => {
  const db = fakeDb({ page: ["new", "old"], total: 2 });
  let embedded = false;
  const result = await runJobSearch(parseJobSearchParams({ workplace: "remote" }), {
    query: db.query, embedQuery: async () => { embedded = true; return []; }, model: "m",
  });
  assert.equal(embedded, false);
  assert.equal(result.mode, "recent");
  assert.equal(result.semanticUnavailable, false);
  assert.deepEqual(result.jobs.map((job) => job.id), ["new", "old"]);
});

test("keyword mode never calls the embedder", async () => {
  const db = fakeDb({ page: ["k"], total: 1 });
  let embedded = false;
  const result = await runJobSearch(parseJobSearchParams({ q: "x", mode: "keyword" }), {
    query: db.query, embedQuery: async () => { embedded = true; return []; }, model: "m",
  });
  assert.equal(embedded, false);
  assert.equal(result.mode, "keyword");
});

test("semantic mode pages through the nearest jobs in order", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`);
  const db = fakeDb({ semantic: ids });
  const result = await runJobSearch(parseJobSearchParams({ q: "x", mode: "semantic", page: "2" }), {
    query: db.query, embedQuery: workingEmbedder, model: "m",
  });
  assert.equal(result.mode, "semantic");
  assert.equal(result.total, 60);
  assert.deepEqual(result.jobs.map((job) => job.id), ids.slice(SEARCH_PAGE_SIZE));
});
