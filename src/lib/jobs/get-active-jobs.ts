import { pool } from "@/lib/db/pool";
import { ACTIVE_JOB_CATALOG_QUERY, type CatalogJob } from "./catalog";

export async function getActiveJobs(): Promise<CatalogJob[]> {
  const result = await pool.query<CatalogJob>(ACTIVE_JOB_CATALOG_QUERY);
  return result.rows;
}
