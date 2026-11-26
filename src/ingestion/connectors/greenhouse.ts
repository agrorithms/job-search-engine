import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { htmlToText } from "../text";
import { getWithRetry, type HttpOptions } from "../http";

interface GreenhouseJob {
  id: number | string;
  title: string;
  location?: { name?: string } | null;
  content?: string | null;
  absolute_url?: string;
  updated_at?: string;
  /** When the posting first went live; `updated_at` moves on every edit. */
  first_published?: string | null;
  departments?: Array<{ name?: string }>;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

/**
 * Greenhouse returns `content` as entity-escaped HTML (e.g. "&lt;p&gt;Hi&lt;/p&gt;").
 * Decode that one layer first so the tags become real tags, then strip them;
 * doing it the other way round leaves literal <p> text in the description.
 */
export function greenhouseContentToText(
  content: string | null | undefined,
): string | null {
  if (!content) return null;

  const ENTITIES: Record<string, string> = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  const html = content.replace(
    /&(?:lt|gt|amp|quot|apos|#39);/gi,
    (entity) => ENTITIES[entity.toLowerCase()] ?? entity,
  );

  return htmlToText(html);
}

export function normalizeGreenhouseJob(raw: GreenhouseJob): NormalizedJob {
  if (raw.id === undefined || !raw.title?.trim() || !raw.absolute_url) {
    throw new Error("Greenhouse job missing id, title, or URL");
  }

  const description = greenhouseContentToText(raw.content);
  const location = raw.location?.name?.trim() || null;
  const title = raw.title.trim();

  // Keep the existing Greenhouse hash inputs so this refactor does not
  // change the current content-change identity calculation.
  const contentHash = createHash("sha256")
    .update([raw.title, description ?? "", raw.location?.name ?? ""].join("\n"))
    .digest("hex");

  // Not updated_at: that changes on every edit and would make old roles
  // look newly posted.
  const parsedPostedAt = raw.first_published ? new Date(raw.first_published) : null;
  const postedAt =
    parsedPostedAt && !Number.isNaN(parsedPostedAt.getTime())
      ? parsedPostedAt
      : null;

  return {
    externalJobId: String(raw.id),
    title,
    description,
    location,
    department:
      raw.departments
        ?.map((department) => department.name?.trim())
        .filter((name): name is string => Boolean(name))
        .join(", ") || null,
    applicationUrl: raw.absolute_url,
    postedAt,
    contentHash,
    rawPayload: raw,
  };
}

export type GreenhouseConnectorOptions = HttpOptions;

export class GreenhouseConnector implements ATSConnector {
  readonly provider = "greenhouse";

  constructor(private readonly http: GreenhouseConnectorOptions = {}) {}

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const url =
      `https://boards-api.greenhouse.io/v1/boards/` +
      `${encodeURIComponent(source.board_identifier)}/jobs?content=true`;

    const response = await getWithRetry(url, "Greenhouse", this.http);

    if (!response.ok) {
      throw new Error(
        `Greenhouse HTTP ${response.status}: ${response.text}`,
      );
    }

    let body: GreenhouseResponse;
    try {
      body = JSON.parse(response.text) as GreenhouseResponse;
    } catch {
      throw new Error("Greenhouse response was not valid JSON");
    }

    if (!Array.isArray(body.jobs)) {
      throw new Error("Greenhouse response missing jobs array");
    }

    return body.jobs.map(normalizeGreenhouseJob);
  }
}
