import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { htmlToText } from "../text";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

export interface AshbyConnectorOptions {
  fetchImpl?: FetchFn;
  sleep?: SleepFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedName(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return isRecord(value) ? optionalText(value, "name") : null;
}

/** Normalize a public Ashby posting while retaining its complete raw response. */
export function normalizeAshbyJob(value: unknown): NormalizedJob {
  if (!isRecord(value)) {
    throw new Error("Ashby response contains a job that is not an object");
  }

  const externalJobId =
    typeof value.id === "string" || typeof value.id === "number"
      ? String(value.id).trim()
      : "";
  const title = optionalText(value, "title") ?? "";
  // Ashby's public response supplies applyUrl. jobUrl is retained as a
  // compatibility fallback for boards using an earlier response shape.
  const applicationUrl = optionalText(value, "applyUrl") ?? optionalText(value, "jobUrl");

  if (!externalJobId || !title || !applicationUrl) {
    throw new Error("Ashby job missing required id, title, or application URL");
  }

  const description =
    optionalText(value, "descriptionPlain") ??
    htmlToText(optionalText(value, "descriptionHtml")) ??
    htmlToText(optionalText(value, "description"));
  const location = optionalText(value, "location") ?? nestedName(value, "location");
  const department =
    optionalText(value, "department") ??
    nestedName(value, "department") ??
    optionalText(value, "team") ??
    nestedName(value, "team");
  const publishedAt = optionalText(value, "publishedAt");
  const parsedPostedAt = publishedAt ? new Date(publishedAt) : null;

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
    postedAt:
      parsedPostedAt && !Number.isNaN(parsedPostedAt.getTime()) ? parsedPostedAt : null,
    contentHash,
    rawPayload: value,
  };
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export class AshbyConnector implements ATSConnector {
  readonly provider = "ashby";

  private readonly fetchImpl: FetchFn;
  private readonly sleep: SleepFn;

  constructor(options: AshbyConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
  }

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
        await response.text();
        lastError = new Error(`Ashby HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
      }

      await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Ashby request failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
  }

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const board = encodeURIComponent(source.board_identifier);
    const response = await this.getWithRetry(
      `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
    );

    if (!response.ok) {
      throw new Error(`Ashby HTTP ${response.status}: ${await response.text()}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Ashby response was not valid JSON");
    }

    if (!isRecord(body) || !Array.isArray(body.jobs)) {
      throw new Error("Ashby response missing jobs array");
    }

    return body.jobs.map(normalizeAshbyJob);
  }
}
