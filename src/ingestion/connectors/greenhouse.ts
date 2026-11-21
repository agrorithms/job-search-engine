import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";

interface GreenhouseJob {
  id: number | string;
  title: string;
  location?: { name?: string } | null;
  content?: string | null;
  absolute_url?: string;
  updated_at?: string;
  departments?: Array<{ name?: string }>;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

function toText(html: string | null | undefined): string | null {
  if (!html) return null;

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeGreenhouseJob(raw: GreenhouseJob): NormalizedJob {
  if (raw.id === undefined || !raw.title?.trim() || !raw.absolute_url) {
    throw new Error("Greenhouse job missing id, title, or URL");
  }

  const description = toText(raw.content);
  const location = raw.location?.name?.trim() || null;
  const title = raw.title.trim();

  // Keep the existing Greenhouse hash inputs so this refactor does not
  // change the current content-change identity calculation.
  const contentHash = createHash("sha256")
    .update([raw.title, description ?? "", raw.location?.name ?? ""].join("\n"))
    .digest("hex");

  const parsedPostedAt = raw.updated_at ? new Date(raw.updated_at) : null;
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

export class GreenhouseConnector implements ATSConnector {
  readonly provider = "greenhouse";

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const url =
      `https://boards-api.greenhouse.io/v1/boards/` +
      `${encodeURIComponent(source.board_identifier)}/jobs?content=true`;

    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `Greenhouse HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as GreenhouseResponse;

    if (!Array.isArray(body.jobs)) {
      throw new Error("Greenhouse response missing jobs array");
    }

    return body.jobs.map(normalizeGreenhouseJob);
  }
}
