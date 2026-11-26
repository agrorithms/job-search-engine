import {
  EMPLOYMENT_TYPES,
  WORKPLACE_TYPES,
  type EmploymentType,
  type WorkplaceType,
} from "@/ingestion/structured";

export const SEARCH_PAGE_SIZE = 50;
export const POSTED_WITHIN_DAYS = [1, 7, 30, 90] as const;
/** Salary filtering compares annual ranges in this currency only. */
export const SALARY_FILTER_CURRENCY = "USD";

const MAX_QUERY_LENGTH = 200;
const MAX_PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobSearchFilters {
  q: string | null;
  companyId: string | null;
  location: string | null;
  workplaceType: WorkplaceType | null;
  employmentType: EmploymentType | null;
  /** Annual, in SALARY_FILTER_CURRENCY. Jobs without a listed salary are excluded. */
  minSalary: number | null;
  postedWithinDays: (typeof POSTED_WITHIN_DAYS)[number] | null;
  page: number;
}

export type SearchParams = Record<string, string | string[] | undefined>;

export interface JobSearchResult {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  department: string | null;
  workplaceType: WorkplaceType | null;
  employmentType: EmploymentType | null;
  salaryMin: string | null;
  salaryMax: string | null;
  salaryCurrency: string | null;
  postedAt: Date | null;
  applicationUrl: string;
}

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Parses URL search params; anything invalid is ignored rather than rejected. */
export function parseJobSearchParams(params: SearchParams): JobSearchFilters {
  const q = first(params.q)?.slice(0, MAX_QUERY_LENGTH) ?? null;
  const companyId = first(params.company);
  const minSalary = Number(first(params.minSalary));
  const days = Number(first(params.posted));
  const page = Number(first(params.page));

  return {
    q,
    companyId: companyId && UUID.test(companyId) ? companyId.toLowerCase() : null,
    location: first(params.location)?.slice(0, MAX_QUERY_LENGTH) ?? null,
    workplaceType: oneOf(WORKPLACE_TYPES, first(params.workplace)),
    employmentType: oneOf(EMPLOYMENT_TYPES, first(params.type)),
    minSalary: Number.isFinite(minSalary) && minSalary > 0 ? Math.floor(minSalary) : null,
    postedWithinDays: (POSTED_WITHIN_DAYS as readonly number[]).includes(days)
      ? (days as JobSearchFilters["postedWithinDays"])
      : null,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
  };
}

/** Builds the query string for these filters at another page (page 1 is omitted). */
export function searchHref(filters: JobSearchFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.companyId) params.set("company", filters.companyId);
  if (filters.location) params.set("location", filters.location);
  if (filters.workplaceType) params.set("workplace", filters.workplaceType);
  if (filters.employmentType) params.set("type", filters.employmentType);
  if (filters.minSalary !== null) params.set("minSalary", String(filters.minSalary));
  if (filters.postedWithinDays !== null) params.set("posted", String(filters.postedWithinDays));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "?";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface JobSearchQuery {
  listSql: string;
  listParams: unknown[];
  countSql: string;
  countParams: unknown[];
}

/**
 * Keyword search over the generated `search_vector` (title > description >
 * location) plus hard filters, always limited to active jobs. User input is
 * only ever passed as bind parameters.
 */
export function buildJobSearchQuery(filters: JobSearchFilters): JobSearchQuery {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const where = ["jp.is_active = TRUE"];
  let rank: string | null = null;

  if (filters.q) {
    const tsquery = `websearch_to_tsquery('english', ${bind(filters.q)})`;
    where.push(`jp.search_vector @@ ${tsquery}`);
    rank = `ts_rank_cd(jp.search_vector, ${tsquery})`;
  }
  if (filters.companyId) where.push(`jp.company_id = ${bind(filters.companyId)}`);
  if (filters.location) where.push(`jp.location ILIKE ${bind(`%${escapeLike(filters.location)}%`)}`);
  if (filters.workplaceType) where.push(`jp.workplace_type = ${bind(filters.workplaceType)}`);
  if (filters.employmentType) where.push(`jp.employment_type = ${bind(filters.employmentType)}`);
  if (filters.minSalary !== null) {
    where.push(`jp.salary_currency = ${bind(SALARY_FILTER_CURRENCY)}`);
    where.push(`COALESCE(jp.salary_max, jp.salary_min) >= ${bind(filters.minSalary)}`);
  }
  if (filters.postedWithinDays !== null) {
    where.push(`jp.posted_at >= NOW() - make_interval(days => ${bind(filters.postedWithinDays)})`);
  }

  const from = `FROM job_postings jp
  INNER JOIN companies c ON c.id = jp.company_id
  WHERE ${where.join("\n    AND ")}`;
  const countParams = [...params];

  const orderBy = rank
    ? `${rank} DESC, jp.posted_at DESC NULLS LAST, jp.id`
    : `jp.posted_at DESC NULLS LAST, jp.id`;
  const limit = bind(SEARCH_PAGE_SIZE);
  const offset = bind((filters.page - 1) * SEARCH_PAGE_SIZE);

  const listSql = `
  SELECT
    jp.id,
    jp.title,
    c.name AS "companyName",
    jp.location,
    jp.department,
    jp.workplace_type AS "workplaceType",
    jp.employment_type AS "employmentType",
    jp.salary_min AS "salaryMin",
    jp.salary_max AS "salaryMax",
    jp.salary_currency AS "salaryCurrency",
    jp.posted_at AS "postedAt",
    jp.application_url AS "applicationUrl"
  ${from}
  ORDER BY ${orderBy}
  LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `SELECT COUNT(*)::int AS total ${from}`;

  return { listSql, listParams: params, countSql, countParams };
}
