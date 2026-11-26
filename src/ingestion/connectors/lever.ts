import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { htmlToText } from "../text";
import { getWithRetry, type HttpOptions, type HttpResult } from "../http";
import {
  annualSalary,
  NO_SALARY,
  normalizeEmploymentType,
  normalizeWorkplaceType,
  type AnnualSalary,
} from "../structured";

/** Lever's salaryRange carries its own pay period; keep only annual ranges. */
function leverAnnualSalary(salaryRange: unknown): AnnualSalary {
  if (!isRecord(salaryRange) || salaryRange.interval !== "per-year-salary") return NO_SALARY;
  return annualSalary(salaryRange.min, salaryRange.max, salaryRange.currency);
}

const HOSTS = ["https://api.lever.co", "https://api.eu.lever.co"] as const;

export type LeverConnectorOptions = HttpOptions;

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
    workplaceType: normalizeWorkplaceType(value.workplaceType),
    employmentType: normalizeEmploymentType(categories.commitment),
    ...leverAnnualSalary(value.salaryRange),
    contentHash,
    rawPayload: value,
  };
}

export class LeverConnector implements ATSConnector {
  readonly provider = "lever";

  constructor(private readonly http: LeverConnectorOptions = {}) {}

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const site = encodeURIComponent(source.board_identifier);
    let response: HttpResult | null = null;

    // Lever has separate global and EU hosts. A site lives on exactly one, so
    // fall through to EU only when the global host says 404.
    for (const host of HOSTS) {
      response = await getWithRetry(`${host}/v0/postings/${site}?mode=json`, "Lever", this.http);
      if (response.status !== 404) break;
    }

    if (!response || response.status === 404) {
      throw new Error(
        `Lever site "${source.board_identifier}" was not found on the global or EU API host`,
      );
    }

    if (!response.ok) {
      throw new Error(`Lever HTTP ${response.status}: ${response.text}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(response.text);
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
