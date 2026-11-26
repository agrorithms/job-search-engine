import type { Pool } from "pg";
import type { ATSConnector } from "../connectors/ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { getConnector } from "../registry";

export interface IngestionSummary {
    sourceId: string;
    provider: string;
    jobsSeen: number;
    jobsInserted: number;
    jobsUpdated: number;
    jobsUnchanged: number;
    /** Jobs previously listed by this source that it no longer returns. */
    jobsDeactivated: number;
}

export interface IngestSourceOptions {
    /** Allows fixture-backed persistence tests to avoid live ATS requests. */
    connector?: ATSConnector;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
    return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

async function persistJob(
    pool: Pool,
    source: ATSSource,
    job: NormalizedJob,
): Promise<"inserted" | "updated" | "unchanged"> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await client.query<{
            job_id: string;
            content_hash: string | null;
            application_url: string;
            department: string | null;
            posted_at: Date | null;
        }>(
            `SELECT js.job_id, jp.content_hash, jp.application_url,
              jp.department, jp.posted_at
       FROM job_sources js
       JOIN job_postings jp ON jp.id = js.job_id
       WHERE js.ats_source_id = $1 AND js.external_job_id = $2
       FOR UPDATE OF js, jp`,
            [source.id, job.externalJobId],
        );

        const rawPayloadJson = JSON.stringify(job.rawPayload ?? null);

        if (existing.rowCount && existing.rows[0]) {
            const stored = existing.rows[0];
            const jobId = stored.job_id;

            // Same content: record that we saw it, but don't rewrite the row
            // or bump updated_at. Fields the connectors' hashes don't cover
            // (URL, posting date, and department for Greenhouse) are compared
            // directly so a change to any of them still counts as an update.
            if (
                stored.content_hash === job.contentHash &&
                stored.application_url === job.applicationUrl &&
                stored.department === job.department &&
                sameInstant(stored.posted_at, job.postedAt)
            ) {
                await client.query(
                    `UPDATE job_postings
           SET last_seen_at = NOW(), is_active = TRUE
           WHERE id = $1`,
                    [jobId],
                );
                // raw_payload is the provider's latest response, so keep it
                // current even when nothing we display has changed.
                await client.query(
                    `UPDATE job_sources SET raw_payload = $3::jsonb, last_seen_at = NOW()
           WHERE ats_source_id = $1 AND external_job_id = $2`,
                    [source.id, job.externalJobId, rawPayloadJson],
                );
                await client.query("COMMIT");
                return "unchanged";
            }

            await client.query(
                `UPDATE job_postings
         SET title = $2,
             description = $3,
             location = $4,
             department = $5,
             application_url = $6,
             posted_at = $7,
             last_seen_at = NOW(),
             is_active = TRUE,
             content_hash = $8,
             updated_at = NOW()
         WHERE id = $1`,
                [
                    jobId,
                    job.title,
                    job.description,
                    job.location,
                    job.department,
                    job.applicationUrl,
                    job.postedAt,
                    job.contentHash,
                ],
            );

            await client.query(
                `UPDATE job_sources
         SET raw_payload = $3::jsonb,
             external_url = $4,
             last_seen_at = NOW()
         WHERE ats_source_id = $1 AND external_job_id = $2`,
                [source.id, job.externalJobId, rawPayloadJson, job.applicationUrl],
            );

            await client.query("COMMIT");
            return "updated";
        }

        const insertedJob = await client.query<{ id: string }>(
            `INSERT INTO job_postings (
         company_id, title, description, location, department,
         application_url, posted_at, content_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
            [
                source.company_id,
                job.title,
                job.description,
                job.location,
                job.department,
                job.applicationUrl,
                job.postedAt,
                job.contentHash,
            ],
        );

        const jobId = insertedJob.rows[0]?.id;
        if (!jobId) {
            throw new Error("Database did not return an ID for the inserted job");
        }

        await client.query(
            `INSERT INTO job_sources (
         job_id, ats_source_id, external_job_id, external_url, raw_payload
       )
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [jobId, source.id, job.externalJobId, job.applicationUrl, rawPayloadJson],
        );

        await client.query("COMMIT");
        return "inserted";
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Runs one configured ATS source. The connector is resolved after the run
 * record is created so unsupported providers are also recorded as failures.
 */
export async function ingestSource(
    pool: Pool,
    source: ATSSource,
    options: IngestSourceOptions = {},
): Promise<IngestionSummary> {
    const runResult = await pool.query<{ id: string; started_at: Date }>(
        `INSERT INTO ingestion_runs (ats_source_id, status)
     VALUES ($1, 'running')
     RETURNING id, started_at`,
        [source.id],
    );

    const runId = runResult.rows[0]?.id;
    const runStartedAt = runResult.rows[0]?.started_at;
    if (!runId || !runStartedAt) {
        throw new Error(`Could not create ingestion run for source ${source.id}`);
    }

    let jobsSeen = 0;
    let jobsInserted = 0;
    let jobsUpdated = 0;
    let jobsUnchanged = 0;

    try {
        const connector = options.connector ?? getConnector(source.provider);
        const jobs = await connector.fetchJobs(source);

        for (const job of jobs) {
            const outcome = await persistJob(pool, source, job);

            jobsSeen += 1;
            if (outcome === "inserted") jobsInserted += 1;
            else if (outcome === "updated") jobsUpdated += 1;
            else jobsUnchanged += 1;
        }

        // Deactivating closed jobs, recording the run as succeeded and setting
        // last_success_at commit together, so a source is never marked
        // successful while its run says failed (e.g. if a migration such as
        // 002's jobs_unchanged column hasn't been applied yet).
        let jobsDeactivated = 0;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // The fetch succeeded and returned the board's complete listing,
            // so any job of this source not seen during this run has been
            // closed. Both timestamps come from the database clock.
            const deactivated = await client.query(
                `UPDATE job_postings
       SET is_active = FALSE, updated_at = NOW()
       WHERE is_active = TRUE
         AND id IN (
           SELECT job_id FROM job_sources
           WHERE ats_source_id = $1 AND last_seen_at < $2
         )`,
                [source.id, runStartedAt],
            );
            jobsDeactivated = deactivated.rowCount ?? 0;

            await client.query(
                `UPDATE ingestion_runs
       SET status = 'succeeded',
           finished_at = NOW(),
           jobs_seen = $2,
           jobs_inserted = $3,
           jobs_updated = $4,
           jobs_unchanged = $5
       WHERE id = $1`,
                [runId, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged],
            );

            await client.query(
                `UPDATE ats_sources
       SET last_checked_at = NOW(), last_success_at = NOW()
       WHERE id = $1`,
                [source.id],
            );

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        return {
            sourceId: source.id,
            provider: source.provider,
            jobsSeen,
            jobsInserted,
            jobsUpdated,
            jobsUnchanged,
            jobsDeactivated,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await pool.query(
            `UPDATE ingestion_runs
       SET status = 'failed', finished_at = NOW(), error_message = $2
       WHERE id = $1`,
            [runId, message],
        );

        await pool.query(
            `UPDATE ats_sources SET last_checked_at = NOW() WHERE id = $1`,
            [source.id],
        );

        throw error;
    }
}
