import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBED_MAX_DESCRIPTION_CHARS,
  EmbeddingError,
  buildEmbeddingText,
  createEmbedder,
  getEmbeddingConfig,
  type EmbeddingConfig,
} from "../src/lib/embeddings";

const CONFIG: EmbeddingConfig = {
  provider: "ollama",
  baseUrl: "http://ollama.test",
  model: "qwen3-embedding:0.6b",
  authHeader: {},
  timeoutMs: 1000,
  keepAlive: "30m",
  numThread: null,
};

const vector = (seed: number) => Array.from({ length: 1024 }, (_, i) => (seed + i) / 1024);

interface Call { url: string; init: RequestInit; body: Record<string, unknown> }

/** A stand-in for Ollama's HTTP API that records requests and returns one vector per input. */
function fakeOllama(respond?: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    if (respond) return respond(body);
    const inputs = body.input as string[];
    return Response.json({ embeddings: inputs.map((_, i) => vector(i)) });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("queries get Qwen's retrieval instruction; documents are embedded as-is", async () => {
  const ollama = fakeOllama();
  const embedder = createEmbedder(CONFIG, ollama.fetchImpl);

  await embedder.embed("data engineer", "query");
  await embedder.embedBatch(["Job one", "Job two"], "document");

  assert.equal(ollama.calls[0].url, "http://ollama.test/api/embed");
  assert.deepEqual(ollama.calls[0].body.input, [
    "Instruct: Given a job search query, retrieve relevant job postings\nQuery:data engineer",
  ]);
  assert.deepEqual(ollama.calls[1].body.input, ["Job one", "Job two"]);
});

test("a vector that is not 1024 numbers long is rejected, never returned", async () => {
  const ollama = fakeOllama(() => Response.json({ embeddings: [vector(0).slice(0, 768)] }));
  const embedder = createEmbedder(CONFIG, ollama.fetchImpl);

  await assert.rejects(embedder.embed("x", "document"), EmbeddingError);
  await assert.rejects(embedder.embed("x", "document"), /expected 1024 dimensions, got 768/);
});

test("a response with the wrong number of vectors is rejected", async () => {
  const ollama = fakeOllama(() => Response.json({ embeddings: [vector(0)] }));
  const embedder = createEmbedder(CONFIG, ollama.fetchImpl);

  await assert.rejects(embedder.embedBatch(["a", "b"], "document"), /expected 2 embeddings, got 1/);
});

test("an HTTP error from Ollama becomes an EmbeddingError that names the status", async () => {
  const ollama = fakeOllama(() => new Response('{"error":"model not found"}', { status: 404 }));
  const embedder = createEmbedder(CONFIG, ollama.fetchImpl);

  await assert.rejects(embedder.embed("x", "query"), (error: unknown) =>
    error instanceof EmbeddingError && /HTTP 404/.test(error.message) && /model not found/.test(error.message));
});

test("an unreachable Ollama becomes an EmbeddingError", async () => {
  const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const embedder = createEmbedder(CONFIG, refused);

  await assert.rejects(embedder.embed("x", "query"), (error: unknown) =>
    error instanceof EmbeddingError && /unreachable/.test(error.message));
});

test("a request that outlives the timeout is aborted", async () => {
  // Holds the event loop open the way a pending socket would, until aborted.
  const hang = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    const socket = setTimeout(() => {}, 10_000);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(socket);
      reject(init.signal?.reason);
    });
  })) as typeof fetch;
  const embedder = createEmbedder({ ...CONFIG, timeoutMs: 20 }, hang);

  await assert.rejects(embedder.embed("x", "query"), (error: unknown) =>
    error instanceof EmbeddingError && /timed out after 20 ms/.test(error.message));
});

test("keep_alive, the thread cap, and the auth header are sent to Ollama", async () => {
  const ollama = fakeOllama();
  const embedder = createEmbedder(
    { ...CONFIG, keepAlive: "5m", numThread: 4, authHeader: { Authorization: "Bearer t" } },
    ollama.fetchImpl,
  );

  await embedder.embed("x", "document");

  assert.equal(ollama.calls[0].body.keep_alive, "5m");
  assert.deepEqual(ollama.calls[0].body.options, { num_thread: 4 });
  assert.equal((ollama.calls[0].init.headers as Record<string, string>).Authorization, "Bearer t");
});

test("a job is embedded as a title/company/location header plus its description", () => {
  const text = buildEmbeddingText({
    title: "Data Engineer",
    companyName: "Acme",
    location: "New York, NY",
    workplaceType: "hybrid",
    description: "Build pipelines.",
  });
  assert.equal(text, "Data Engineer\nAcme · New York, NY · Hybrid\n\nBuild pipelines.");
});

test("missing header fields are skipped and unknown workplace is not mentioned", () => {
  const text = buildEmbeddingText({
    title: "Engineer", companyName: "Acme", location: null, workplaceType: "unknown", description: null,
  });
  assert.equal(text, "Engineer\nAcme");
});

test("descriptions are capped at about 12,000 characters", () => {
  assert.equal(EMBED_MAX_DESCRIPTION_CHARS, 12_000);
  const text = buildEmbeddingText({
    title: "T", companyName: "C", location: null, workplaceType: null, description: "a".repeat(18_600),
  });
  assert.equal(text, `T\nC\n\n${"a".repeat(12_000)}`);
});

test("config defaults to local Ollama with qwen3-embedding:0.6b", () => {
  assert.deepEqual(getEmbeddingConfig({}), {
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen3-embedding:0.6b",
    authHeader: {},
    timeoutMs: 15_000,
    keepAlive: "30m",
    numThread: null,
  });
});

test("config reads the provider, URL, model, auth header, and timeout from env", () => {
  const config = getEmbeddingConfig({
    EMBEDDING_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "https://embed.example/",
    EMBEDDING_MODEL: "bge-m3",
    OLLAMA_AUTH_HEADER: "Authorization: Bearer secret",
    EMBEDDING_TIMEOUT_MS: "5000",
  });
  assert.equal(config.baseUrl, "https://embed.example");
  assert.equal(config.model, "bge-m3");
  assert.deepEqual(config.authHeader, { Authorization: "Bearer secret" });
  assert.equal(config.timeoutMs, 5000);
});

test("an unimplemented provider is rejected", () => {
  assert.throws(() => getEmbeddingConfig({ EMBEDDING_PROVIDER: "voyage" }), /EMBEDDING_PROVIDER "voyage" is not supported/);
});
