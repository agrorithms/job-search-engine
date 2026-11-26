export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 500;

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface HttpOptions {
  fetchImpl?: FetchFn;
  sleep?: SleepFn;
}

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** The complete response body, already downloaded. */
  text: string;
}

/**
 * GET with a per-attempt timeout and exponential backoff on network errors,
 * 429, and 5xx. The body is read inside the attempt, so a timeout while it is
 * still downloading is retried like any other network error rather than
 * surfacing later as a JSON parse failure. Returns the final result, which may
 * be a non-OK, non-transient status (e.g. 404) for the caller to interpret.
 */
export async function getWithRetry(
  url: string,
  label: string,
  { fetchImpl = (...args) => fetch(...args), sleep = defaultSleep }: HttpOptions = {},
): Promise<HttpResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const text = await response.text();

      if (!isTransient(response.status) || attempt === MAX_ATTEMPTS) {
        return { status: response.status, ok: response.ok, text };
      }
      lastError = new Error(`${label} HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
    }

    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} request failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
}
