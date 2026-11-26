import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { htmlToText } from "../text";

const HOSTS = ["https://api.lever.co", "https://api.eu.lever.co"] as const;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

export interface LeverConnectorOptions {
  fetchImpl?: FetchFn;
  sleep?: SleepFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Lever splits a posting across several fields: `description` is only the
 * intro; requirements/responsibilities live in `lists[]` and closing text in
 * `additional`. Rebuild the full body so downstream search/matching sees it.
 */
function buildDescription(raw: Record<string, unknown>): string | null {
  const parts: string[] = [];

  const intro =
    optionalText(raw, "descriptionPlain") ??
    htmlToText(optionalText(raw, "description"));
  if (intro) parts.push(intro);

  if (Array.isArray(raw.lists)) {
    for (const list of raw.lists) {
      if (!isRecord(list)) continue;
      const heading = optionalText(list, "text");
      const body = htmlToText(optionalText(list, "content"));
      if (heading) parts.push(heading);
      if (body) parts.push(body);
    }
  }

  const closing =
    optionalText(raw, "additionalPlain") ??
    htmlToText(optionalText(raw, "additional"));
  if (closing) parts.push(closing);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function buildLocation(categories: Record<string, unknown>): string | null {
  const primary = optionalText(categories, "location");
  if (primary) return primary;

  if (Array.isArray(categories.allLocations)) {
    const all = categories.allLocations
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return all.length > 0 ? all.join(", ") : null;
  }

  return null;
}

export function normalizeLeverPosting(value: unknown): NormalizedJob {
  if (!isRecord(value)) {
    throw new Error("Lever response contains a job that is not an object");
  }

  const externalJobId =
    typeof value.id === "string" || typeof value.id === "number"
      ? String(value.id).trim()
      : "";
  const title = optionalText(value, "text") ?? "";
  const applicationUrl =
    optionalText(value, "applyUrl") ?? optionalText(value, "hostedUrl");

  if (!externalJobId || !title || !applicationUrl) {
    throw new Error("Lever job missing required id, title, or application URL");
  }

  const categories = isRecord(value.categories) ? value.categories : {};
  const location = buildLocation(categories);
  const department =
    optionalText(categories, "department") ?? optionalText(categories, "team");
  const description = buildDescription(value);

  // Lever's createdAt is epoch milliseconds.
  const postedAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? new Date(value.createdAt)
      : null;

  // Same inputs -> same hash across runs. Application URL is excluded: a
  // tracking-param change alone shouldn't count as a content change.
  const contentHash = createHash("sha256")
    .update([title, description ?? "", location ?? "", department ?? ""].join("\n"))
    .digest("hex");

  return {
    externalJobId,
    title,
    description,
    location,
    department,
    applicationUrl,
    postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    contentHash,
    rawPayload: value,
  };
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export class LeverConnector implements ATSConnector {
  readonly provider = "lever";

  private readonly fetchImpl: FetchFn;
  private readonly sleep: SleepFn;

  constructor(options: LeverConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * GET with timeout and exponential backoff on network errors, 429, and 5xx.
   * Returns the final response (which may be a non-OK, non-transient status).
   */
  private async getWithRetry(url: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!isTransient(response.status) || attempt === MAX_ATTEMPTS) {
          return response;
        }
        await response.text(); // release the connection before retrying
        lastError = new Error(`Lever HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
      }

      await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Lever request failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
  }

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const site = encodeURIComponent(source.board_identifier);
    let response: Response | null = null;

    // Lever has separate global and EU hosts. A site lives on exactly one, so
    // fall through to EU only when the global host says 404.
    for (const host of HOSTS) {
      response = await this.getWithRetry(`${host}/v0/postings/${site}?mode=json`);
      if (response.status !== 404) break;
      await response.text();
    }

    if (!response || response.status === 404) {
      throw new Error(
        `Lever site "${source.board_identifier}" was not found on the global or EU API host`,
      );
    }

    if (!response.ok) {
      throw new Error(`Lever HTTP ${response.status}: ${await response.text()}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Lever response was not valid JSON");
    }

    // An empty array is a valid, complete listing (company has no openings).
    if (!Array.isArray(body)) {
      throw new Error("Lever response must be a JSON array of job postings");
    }

    return body.map(normalizeLeverPosting);
  }
}
