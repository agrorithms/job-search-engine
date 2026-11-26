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

/**
 * How a text query ranks jobs. Keyword matches words, semantic matches
 * meaning (embeddings), hybrid fuses both rankings. Hybrid is the default.
 */
export const SEARCH_MODES = ["hybrid", "keyword", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

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
  mode: SearchMode;
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
    mode: oneOf(SEARCH_MODES, first(params.mode)) ?? DEFAULT_SEARCH_MODE,
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
  if (filters.mode !== DEFAULT_SEARCH_MODE) params.set("mode", filters.mode);
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

/** A query plus its bind parameters. */
export interface SqlQuery {
  sql: string;
  params: unknown[];
}

/** How many jobs each mode contributes to hybrid fusion; also the cap on semantic results. */
export const HYBRID_CANDIDATES = 200;

function binder(params: unknown[]) {
  return (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
}

/** The hard filters every mode shares, always limited to active jobs. */
function filterClauses(filters: JobSearchFilters, bind: (value: unknown) => string): string[] {
  const where = ["jp.is_active = TRUE"];
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
  return where;
}

/** Keyword match condition and rank expression for a text query. */
function keywordMatch(q: string, bind: (value: unknown) => string) {
  const tsquery = `websearch_to_tsquery('english', ${bind(q)})`;
  return { where: `jp.search_vector @@ ${tsquery}`, rank: `ts_rank_cd(jp.search_vector, ${tsquery})` };
}

const RESULT_COLUMNS = `
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
    jp.application_url AS "applicationUrl"`;

/**
 * Keyword search over the generated `search_vector` (title > description >
 * location) plus hard filters, always limited to active jobs. Without a text
 * query it lists filtered jobs newest first. User input is only ever passed
 * as bind parameters.
 */
export function buildJobSearchQuery(filters: JobSearchFilters): JobSearchQuery {
  const params: unknown[] = [];
  const bind = binder(params);

  const match = filters.q ? keywordMatch(filters.q, bind) : null;
  const where = filterClauses(filters, bind);
  if (match) where.splice(1, 0, match.where);
  const rank = match?.rank ?? null;

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
  SELECT${RESULT_COLUMNS}
  ${from}
  ORDER BY ${orderBy}
  LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `SELECT COUNT(*)::int AS total ${from}`;

  return { listSql, listParams: params, countSql, countParams };
}

/** Ids of the top keyword matches, best first, for hybrid fusion. Requires `filters.q`. */
export function buildKeywordCandidatesQuery(filters: JobSearchFilters, limit = HYBRID_CANDIDATES): SqlQuery {
  if (!filters.q) throw new Error("keyword candidates need a text query");
  const params: unknown[] = [];
  const bind = binder(params);
  const match = keywordMatch(filters.q, bind);
  const where = [...filterClauses(filters, bind), match.where];
  const sql = `
  SELECT jp.id
  FROM job_postings jp
  WHERE ${where.join("\n    AND ")}
  ORDER BY ${match.rank} DESC, jp.posted_at DESC NULLS LAST, jp.id
  LIMIT ${bind(limit)}`;
  return { sql, params };
}

/**
 * Ids of the jobs whose embeddings are nearest the query embedding by cosine
 * distance (`<=>`), best first. It is an exact scan (no ANN index, D9) and
 * only compares vectors from the active model (D6).
 */
export function buildSemanticCandidatesQuery(
  filters: JobSearchFilters,
  embedding: number[],
  model: string,
  limit = HYBRID_CANDIDATES,
): SqlQuery {
  const params: unknown[] = [];
  const bind = binder(params);
  const join = `INNER JOIN job_embeddings je ON je.job_id = jp.id AND je.embedding_model = ${bind(model)}`;
  const where = filterClauses(filters, bind);
  // pgvector parses the JSON array text form, e.g. "[0.1,0.2]".
  const sql = `
  SELECT jp.id
  FROM job_postings jp
  ${join}
  WHERE ${where.join("\n    AND ")}
  ORDER BY je.embedding <=> ${bind(JSON.stringify(embedding))}::vector, jp.id
  LIMIT ${bind(limit)}`;
  return { sql, params };
}

/** Loads result rows for a page of ids; the caller restores the ranked order. */
export function buildJobsByIdQuery(ids: string[]): SqlQuery {
  const sql = `
  SELECT${RESULT_COLUMNS}
  FROM job_postings jp
  INNER JOIN companies c ON c.id = jp.company_id
  WHERE jp.id = ANY($1::uuid[])`;
  return { sql, params: [ids] };
}

/** Reciprocal Rank Fusion constant from the original RRF paper (decision D10). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: each job scores Σ 1 / (RRF_K + rank) over the
 * rankings it appears in (rank starts at 1). Only ranks are used, so keyword
 * and cosine scores never need to be put on the same scale. Ties keep the
 * order in which jobs were first seen, scanning the rankings in order.
 */
export function fuseRankings(rankings: string[][], k = RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  // Map iteration order is first-seen order, and Array.sort is stable.
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
