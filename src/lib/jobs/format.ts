import type { EmploymentType, WorkplaceType } from "@/ingestion/structured";

export const WORKPLACE_LABELS: Record<WorkplaceType, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
};

export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  internship: "Internship",
};

export function formatPostedDate(postedAt: Date | null): string {
  if (!postedAt) return "Posting date unavailable";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(postedAt);
}

/** Formats an annual salary range; NUMERIC values may arrive as strings. */
export function formatSalary(
  min: string | number | null,
  max: string | number | null,
  currency: string | null,
): string | null {
  if (!currency || (min === null && max === null)) return null;

  let format: (value: string | number) => string;
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 0,
    });
    format = (value) => formatter.format(Number(value));
  } catch {
    format = (value) => `${currency} ${Number(value).toLocaleString("en-US")}`;
  }

  if (min !== null && max !== null) {
    return Number(min) === Number(max) ? format(min) : `${format(min)} – ${format(max)}`;
  }
  return min !== null ? `From ${format(min)}` : `Up to ${format(max!)}`;
}
