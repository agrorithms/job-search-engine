export type CatalogJob = {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  department: string | null;
  postedAt: Date | null;
  isActive: boolean;
  applicationUrl: string;
};

export const CATALOG_PAGE_SIZE = 200;

export const ACTIVE_JOB_CATALOG_QUERY = `
  SELECT
    jp.id,
    jp.title,
    c.name AS "companyName",
    jp.location,
    jp.department,
    jp.posted_at AS "postedAt",
    jp.is_active AS "isActive",
    jp.application_url AS "applicationUrl"
  FROM job_postings jp
  INNER JOIN companies c ON c.id = jp.company_id
  WHERE jp.is_active = TRUE
  ORDER BY jp.last_seen_at DESC, jp.id DESC
  LIMIT ${CATALOG_PAGE_SIZE}
`;

/** The list above is capped, so the total has to be counted separately. */
export const ACTIVE_JOB_COUNT_QUERY = `
  SELECT COUNT(*)::int AS "total"
  FROM job_postings jp
  INNER JOIN companies c ON c.id = jp.company_id
  WHERE jp.is_active = TRUE
`;

export function formatPostedDate(postedAt: Date | null): string {
  if (!postedAt) return "Posting date unavailable";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(postedAt);
}
