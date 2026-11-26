import { pool } from "@/lib/db/pool";
import {
  ACTIVE_JOB_CATALOG_QUERY,
  ACTIVE_JOB_COUNT_QUERY,
  type CatalogJob,
} from "./catalog";

export async function getActiveJobs(): Promise<{ jobs: CatalogJob[]; total: number }> {
  const [list, count] = await Promise.all([
    pool.query<CatalogJob>(ACTIVE_JOB_CATALOG_QUERY),
    pool.query<{ total: number }>(ACTIVE_JOB_COUNT_QUERY),
  ]);
  return { jobs: list.rows, total: count.rows[0]?.total ?? list.rows.length };
}
