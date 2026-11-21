import { createHash } from "node:crypto";
import type { ATSConnector } from "./ats-connector";
import type { ATSSource, NormalizedJob } from "../types";

interface LeverPosting {
  id?: unknown;
  text?: unknown;
  categories?: unknown;
  descriptionPlain?: unknown;
  description?: unknown;
  applyUrl?: unknown;
  hostedUrl?: unknown;
  createdAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<\\/(p|div|li|h[1-6]|br)>/gi, "\\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \\t]+/g, " ")
    .trim();
}

function normalizeLeverPosting(value: unknown): NormalizedJob {
  if (!isRecord(value)) {
    throw new Error("Lever response contains a job that is not an object");
  }

  const raw = value as LeverPosting;
  const externalJobId =
    typeof raw.id === "string" || typeof raw.id === "number"
      ? String(raw.id).trim()
      : "";
  const title = typeof raw.text === "string" ? raw.text.trim() : "";
  const applicationUrl =
    optionalText(value, "applyUrl") ?? optionalText(value, "hostedUrl");

  if (!externalJobId || !title || !applicationUrl) {
    throw new Error("Lever job missing required id, title, or application URL");
  }

  const categories = isRecord(raw.categories) ? raw.categories : {};
  const location =
    optionalText(categories, "location") ??
    (Array.isArray(categories.allLocations)
      ? categories.allLocations
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim())
          .join(", ") || null
      : null);
  const department =
    optionalText(categories, "department") ?? optionalText(categories, "team");

  const plainDescription = optionalText(value, "descriptionPlain");
  const htmlDescription = optionalText(value, "description");
  const description =
    plainDescription ?? (htmlDescription ? htmlToText(htmlDescription) || null : null);

  const parsedCreatedAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? new Date(raw.createdAt)
      : null;
  const postedAt =
    parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime())
      ? parsedCreatedAt
      : null;

  // Include the normalized fields that describe the posting. The same source
  // content therefore produces the same hash across ingestion runs.
  const contentHash = createHash("sha256")
    .update(
      [
        title,
        description ?? "",
        location ?? "",
        department ?? "",
        applicationUrl,
      ].join("\\n"),
    )
    .digest("hex");

  return {
    externalJobId,
    title,
    description,
    location,
    department,
    applicationUrl,
    postedAt,
    contentHash,
    rawPayload: value,
  };
}

export class LeverConnector implements ATSConnector {
  readonly provider = "lever";

  async fetchJobs(source: ATSSource): Promise<NormalizedJob[]> {
    const site = encodeURIComponent(source.board_identifier);
    const hosts = ["https://api.lever.co", "https://api.eu.lever.co"];
    let response: Response | null = null;

    for (let index = 0; index < hosts.length; index += 1) {
      const url = `${hosts[index]}/v0/postings/${site}?mode=json`;

      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });

      // Lever has separate global and EU API hosts. Try the EU host only when
      // the global host says the site does not exist there.
      if (response.status === 404 && index < hosts.length - 1) {
        await response.text();
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Lever HTTP ${response.status}: ${await response.text()}`,
        );
      }

      break;
    }

    if (!response || !response.ok) {
      throw new Error(
        `Lever site "${source.board_identifier}" was not found on the global or EU API host`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Lever response was not valid JSON");
    }

    if (!Array.isArray(body)) {
      throw new Error("Lever response must be a JSON array of job postings");
    }

    return body.map(normalizeLeverPosting);
  }
}
