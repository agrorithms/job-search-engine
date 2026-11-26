import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { htmlToText } from "../text";
import { getWithRetry, type HttpOptions } from "../http";

export type AshbyConnectorOptions = HttpOptions;

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

export class AshbyConnector implements ATSConnector {
  readonly provider = "ashby";

  constructor(private readonly http: AshbyConnectorOptions = {}) {}

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const board = encodeURIComponent(source.board_identifier);
    const response = await getWithRetry(
      `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
      "Ashby",
      this.http,
    );

    if (!response.ok) {
      throw new Error(`Ashby HTTP ${response.status}: ${response.text}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw new Error("Ashby response was not valid JSON");
    }

    if (!isRecord(body) || !Array.isArray(body.jobs)) {
      throw new Error("Ashby response missing jobs array");
    }

    return body.jobs.map(normalizeAshbyJob);
  }
}
