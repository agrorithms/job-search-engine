import "dotenv/config";
import { pool } from "../src/lib/db/pool";
import { ingestSource } from "../src/ingestion/services/ingest-source";
import type { ATSSource } from "../src/ingestion/types";

async function main(): Promise<void> {
    const result = await pool.query(
        `SELECT id, company_id, provider, board_identifier
     FROM ats_sources
     WHERE is_active = TRUE
     ORDER BY created_at ASC, id ASC`,
    );

    const sources = result.rows as ATSSource[];

    if (sources.length === 0) {
        console.log("No active ATS sources found.");
        return;
    }

    console.log(`Found ${sources.length} active ATS source(s).`);

    let succeeded = 0;
    let failed = 0;

    // Process sequentially initially. This keeps database/API load predictable;
    // bounded concurrency can be introduced when multiple providers are active.
    for (const source of sources) {
        console.log(
            `Starting ${source.provider} ingestion for source ${source.id} ` +
            `(board: ${source.board_identifier})`,
        );

        try {
            const summary = await ingestSource(pool, source);
            succeeded += 1;

            console.log(
                `Completed ${summary.provider}: ${summary.jobsSeen} seen, ` +
                `${summary.jobsInserted} inserted, ${summary.jobsUpdated} updated, ` +
                `${summary.jobsUnchanged} unchanged, ${summary.jobsDeactivated} closed.`,
            );
        } catch (error) {
            failed += 1;
            console.error(
                `Failed ${source.provider} source ${source.id}:`,
                error instanceof Error ? error.message : error,
            );
            // Continue to the next source; each source has its own run record.
        }
    }

    console.log(
        `Ingestion finished: ${succeeded} source(s) succeeded, ${failed} failed.`,
    );

    if (failed > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error("Ingestion command failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
