import { pool } from "@/lib/db/pool";
import { EmbeddingError, embed, getEmbeddingConfig } from "@/lib/embeddings";
import { runJobSearch, type JobSearchOutcome } from "./run-search";
import type { JobSearchFilters } from "./search";

export interface CompanyOption {
  id: string;
  name: string;
  activeJobs: number;
}

/** Searches with the real database and embedding model; see runJobSearch. */
export async function searchJobs(filters: JobSearchFilters): Promise<JobSearchOutcome> {
  let model = "";
  try {
    model = getEmbeddingConfig().model;
  } catch (error) {
    // A bad EMBEDDING_PROVIDER degrades to keyword search: embed() rejects with
    // the same EmbeddingError, which runJobSearch turns into the fallback.
    if (!(error instanceof EmbeddingError)) throw error;
  }
  return runJobSearch(filters, {
    query: (sql, params) => pool.query(sql, params),
    embedQuery: (text) => embed(text, "query"),
    model,
  });
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
