import type { Pool } from "pg";
import type { ATSSource, NormalizedJob } from "../types";
import { getConnector } from "../registry";

export interface IngestionSummary {
    sourceId: string;
    provider: string;
    jobsSeen: number;
    jobsInserted: number;
    jobsUpdated: number;
    jobsUnchanged: number;
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
        }>(
            `SELECT js.job_id, jp.content_hash, jp.application_url
       FROM job_sources js
       JOIN job_postings jp ON jp.id = js.job_id
       WHERE js.ats_source_id = $1 AND js.external_job_id = $2
       FOR UPDATE OF js, jp`,
            [source.id, job.externalJobId],
        );

        const rawPayloadJson = JSON.stringify(job.rawPayload ?? null);

        if (existing.rowCount && existing.rows[0]) {
            const { job_id: jobId, content_hash, application_url } = existing.rows[0];

            // Same content: record that we saw it, but don't rewrite the row
            // or bump updated_at. The URL is checked separately because the
            // content hashes do not include it.
            if (
                content_hash === job.contentHash &&
                application_url === job.applicationUrl
            ) {
                await client.query(
                    `UPDATE job_postings
           SET last_seen_at = NOW(), is_active = TRUE
           WHERE id = $1`,
                    [jobId],
                );
                await client.query(
                    `UPDATE job_sources SET last_seen_at = NOW()
           WHERE ats_source_id = $1 AND external_job_id = $2`,
                    [source.id, job.externalJobId],
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
): Promise<IngestionSummary> {
    const runResult = await pool.query<{ id: string }>(
        `INSERT INTO ingestion_runs (ats_source_id, status)
     VALUES ($1, 'running')
     RETURNING id`,
        [source.id],
    );

    const runId = runResult.rows[0]?.id;
    if (!runId) {
        throw new Error(`Could not create ingestion run for source ${source.id}`);
    }

    let jobsSeen = 0;
    let jobsInserted = 0;
    let jobsUpdated = 0;
    let jobsUnchanged = 0;

    try {
        const connector = getConnector(source.provider);
        const jobs = await connector.fetchJobs(source);

        for (const job of jobs) {
            const outcome = await persistJob(pool, source, job);

            jobsSeen += 1;
            if (outcome === "inserted") jobsInserted += 1;
            else if (outcome === "updated") jobsUpdated += 1;
            else jobsUnchanged += 1;
        }

        await pool.query(
            `UPDATE ats_sources
       SET last_checked_at = NOW(), last_success_at = NOW()
       WHERE id = $1`,
            [source.id],
        );

        await pool.query(
            `UPDATE ingestion_runs
       SET status = 'succeeded',
           finished_at = NOW(),
           jobs_seen = $2,
           jobs_inserted = $3,
           jobs_updated = $4
       WHERE id = $1`,
            [runId, jobsSeen, jobsInserted, jobsUpdated],
        );

        return {
            sourceId: source.id,
            provider: source.provider,
            jobsSeen,
            jobsInserted,
            jobsUpdated,
            jobsUnchanged,
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
