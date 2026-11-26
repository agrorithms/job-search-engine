/**
 * The only place that talks to an embedding model (doc 07). An embedding is a
 * list of EMBEDDING_DIMENSIONS numbers that places a text in a "meaning space":
 * texts about similar things land close together even with no words in common.
 */

export const EMBEDDING_DIMENSIONS = 1024;

/** Documents are job postings; queries are what someone types into search. */
export type InputType = "document" | "query";

export interface EmbeddingConfig {
  provider: "ollama";
  baseUrl: string;
  model: string;
  /** Extra header for an authenticating reverse proxy, e.g. `{ Authorization: "Bearer …" }`. */
  authHeader: Record<string, string>;
  timeoutMs: number;
  /** How long Ollama keeps the model in RAM after a request (e.g. "30m"). */
  keepAlive: string;
  /** Caps the CPU threads Ollama uses; null leaves Ollama's default. */
  numThread: number | null;
}

/**
 * Descriptions are cut here before embedding (decision D8). It keeps the full
 * text of ~95% of jobs; what it drops is mostly benefits and EEO boilerplate.
 */
export const EMBED_MAX_DESCRIPTION_CHARS = 12_000;

const WORKPLACE_WORDS: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

export interface EmbeddableJob {
  title: string;
  companyName: string;
  location: string | null;
  workplaceType: string | null;
  description: string | null;
}

/** The text a job is embedded as: a short header, then the capped description. */
export function buildEmbeddingText(job: EmbeddableJob): string {
  const workplace = job.workplaceType ? WORKPLACE_WORDS[job.workplaceType] : undefined;
  const details = [job.companyName, job.location, workplace].filter(Boolean).join(" · ");
  const header = `${job.title}\n${details}`;
  const description = job.description?.trim().slice(0, EMBED_MAX_DESCRIPTION_CHARS);
  return description ? `${header}\n\n${description}` : header;
}

export interface Embedder {
  readonly model: string;
  embed(text: string, inputType: InputType): Promise<number[]>;
  embedBatch(texts: string[], inputType: InputType): Promise<number[][]>;
}

/** Any failure to get a usable embedding: unreachable, timed out, HTTP error, or malformed vector. */
export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

const QWEN_QUERY_INSTRUCTION = "Given a job search query, retrieve relevant job postings";

function prepare(model: string, text: string, inputType: InputType): string {
  // Qwen3-Embedding is trained with an instruction on the query side only.
  // The format (no space after "Query:") follows the Qwen model card.
  if (inputType === "query" && model.startsWith("qwen3-embedding")) {
    return `Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery:${text}`;
  }
  return text;
}

export function createEmbedder(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch): Embedder {
  async function embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
    const url = `${config.baseUrl}/api/embed`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.authHeader },
        body: JSON.stringify({
          model: config.model,
          input: texts.map((text) => prepare(config.model, text, inputType)),
          keep_alive: config.keepAlive,
          ...(config.numThread ? { options: { num_thread: config.numThread } } : {}),
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new EmbeddingError(
        timedOut
          ? `Ollama request timed out after ${config.timeoutMs} ms (${url})`
          : `Ollama is unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new EmbeddingError(`Ollama returned HTTP ${response.status} for ${config.model}: ${detail}`);
    }
    const body = (await response.json().catch(() => ({}))) as { embeddings?: unknown };
    const vectors = Array.isArray(body.embeddings) ? (body.embeddings as unknown[]) : [];
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(`expected ${texts.length} embeddings, got ${vectors.length}`);
    }
    for (const vector of vectors) {
      const length = Array.isArray(vector) ? vector.length : 0;
      if (length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingError(`expected ${EMBEDDING_DIMENSIONS} dimensions, got ${length}`);
      }
    }
    return vectors as number[][];
  }

  return {
    model: config.model,
    embedBatch,
    async embed(text, inputType) {
      const [vector] = await embedBatch([text], inputType);
      return vector;
    },
  };
}

type Env = Record<string, string | undefined>;

/** Parses "Header-Name: value" into a header object; empty when unset. */
function parseAuthHeader(raw: string | undefined): Record<string, string> {
  const separator = raw?.indexOf(":") ?? -1;
  if (!raw || separator <= 0) return {};
  return { [raw.slice(0, separator).trim()]: raw.slice(separator + 1).trim() };
}

/**
 * Reads the embedding backend from the environment. Only Ollama exists today
 * (decision D5); a hosted provider would be another `provider` value here,
 * with no change to callers.
 */
export function getEmbeddingConfig(env: Env = process.env): EmbeddingConfig {
  const provider = env.EMBEDDING_PROVIDER?.trim() || "ollama";
  if (provider !== "ollama") {
    throw new EmbeddingError(`EMBEDDING_PROVIDER "${provider}" is not supported; only "ollama" is implemented`);
  }
  const timeoutMs = Number(env.EMBEDDING_TIMEOUT_MS);
  return {
    provider,
    baseUrl: (env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434").replace(/\/+$/, ""),
    model: env.EMBEDDING_MODEL?.trim() || "qwen3-embedding:0.6b",
    authHeader: parseAuthHeader(env.OLLAMA_AUTH_HEADER),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
    keepAlive: "30m",
    numThread: null,
  };
}

/**
 * Asks Ollama to download the configured model into its volume (used by
 * `npm run embed:setup`). Safe to repeat: Ollama skips layers it already has.
 */
export async function pullModel(config: EmbeddingConfig = getEmbeddingConfig()): Promise<void> {
  const url = `${config.baseUrl}/api/pull`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.authHeader },
      body: JSON.stringify({ model: config.model, stream: false }),
    });
  } catch (error) {
    throw new EmbeddingError(`Ollama is unreachable at ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new EmbeddingError(`Ollama pull of ${config.model} failed (HTTP ${response.status}): ${await response.text()}`);
  }
}

let defaultEmbedder: Embedder | null = null;

function getDefaultEmbedder(): Embedder {
  defaultEmbedder ??= createEmbedder(getEmbeddingConfig());
  return defaultEmbedder;
}

/**
 * Embeds one text with the configured backend (keep_alive 30m, for search).
 * Async so that a config error also arrives as a rejected EmbeddingError.
 */
export async function embed(text: string, inputType: InputType): Promise<number[]> {
  return getDefaultEmbedder().embed(text, inputType);
}

export async function embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
  return getDefaultEmbedder().embedBatch(texts, inputType);
}
