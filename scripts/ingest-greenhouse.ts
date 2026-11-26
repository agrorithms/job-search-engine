import "dotenv/config";
import { pool } from "../src/lib/db/pool";
import { ingestSource } from "../src/ingestion/services/ingest-source";
import type { ATSSource } from "../src/ingestion/types";

/**
 * Compatibility/regression entry point.
 * Retains the original environment-variable-driven source setup, but uses
 * the same normalized connector and shared persistence runner as ingest.ts.
 */
async function main(): Promise<void> {
  const token = process.env.GREENHOUSE_BOARD_TOKEN?.trim();
  const name = process.env.GREENHOUSE_COMPANY_NAME?.trim();

  if (!token || !name) {
    throw new Error(
      "Set GREENHOUSE_BOARD_TOKEN and GREENHOUSE_COMPANY_NAME in .env.local",
    );
  }

  const companyResult = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, website_url, careers_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE
       SET website_url = COALESCE(EXCLUDED.website_url, companies.website_url),
           careers_url = COALESCE(EXCLUDED.careers_url, companies.careers_url)
     RETURNING id`,
    [
      name,
      process.env.GREENHOUSE_COMPANY_WEBSITE || null,
      process.env.GREENHOUSE_CAREERS_URL || null,
    ],
  );

  const companyId = companyResult.rows[0]?.id;
  if (!companyId) throw new Error("Could not create or retrieve company");

  const sourceResult = await pool.query<ATSSource>(
    `INSERT INTO ats_sources (company_id, provider, board_identifier)
     VALUES ($1, 'greenhouse', $2)
     ON CONFLICT (provider, board_identifier) DO UPDATE
       SET company_id = EXCLUDED.company_id, is_active = TRUE
     RETURNING id, company_id, provider, board_identifier`,
    [companyId, token],
  );

  const source = sourceResult.rows[0];
  if (!source) throw new Error("Could not create or retrieve ATS source");

  const summary = await ingestSource(pool, source);

  console.log(
    `Greenhouse ingestion complete: ${summary.jobsSeen} seen, ` +
    `${summary.jobsInserted} inserted, ${summary.jobsUpdated} updated, ` +
    `${summary.jobsUnchanged} unchanged.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
