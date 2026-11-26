import { pool } from "@/lib/db/pool";
import { buildJobSearchQuery, type JobSearchFilters, type JobSearchResult } from "./search";

export interface CompanyOption {
  id: string;
  name: string;
  activeJobs: number;
}

export async function searchJobs(
  filters: JobSearchFilters,
): Promise<{ jobs: JobSearchResult[]; total: number }> {
  const query = buildJobSearchQuery(filters);
  const [list, count] = await Promise.all([
    pool.query<JobSearchResult>(query.listSql, query.listParams),
    pool.query<{ total: number }>(query.countSql, query.countParams),
  ]);
  return { jobs: list.rows, total: count.rows[0]?.total ?? 0 };
}

/** Companies that currently have active jobs, for the company filter. */
export async function getCompanyOptions(): Promise<CompanyOption[]> {
  const result = await pool.query<CompanyOption>(
    `SELECT c.id, c.name, COUNT(jp.id)::int AS "activeJobs"
     FROM companies c
     INNER JOIN job_postings jp ON jp.company_id = c.id AND jp.is_active = TRUE
     GROUP BY c.id, c.name
     ORDER BY c.name`,
  );
  return result.rows;
}
