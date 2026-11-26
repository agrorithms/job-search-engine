import type { Pool, PoolClient } from "pg";
import type { ATSConnector } from "../connectors/ats-connector";
import type { ATSSource, NormalizedJob } from "../types";
import { getConnector } from "../registry";

/**
 * A posting is expired only after it is absent from this many consecutive
 * successful, complete listings, so one anomalous poll cannot close it.
 */
export const MISSED_RUNS_BEFORE_EXPIRY = 2;

export interface IngestionSummary {
    sourceId: string;
    provider: string;
    jobsSeen: number;
    jobsInserted: number;
    jobsUpdated: number;
    jobsUnchanged: number;
    /** Previously inactive jobs that the source lists again. */
    jobsReactivated: number;
    /** Active jobs absent from this listing (including those now expired). */
    jobsMissing: number;
    /** Jobs marked inactive by this run under the missing-job policy. */
    jobsDeactivated: number;
    /** True when the listing could not support missing-job detection. */
    missingCheckSkipped: boolean;
}

export interface IngestSourceOptions {
    /** Allows fixture-backed persistence tests to avoid live ATS requests. */
    connector?: ATSConnector;
    missedRunsBeforeExpiry?: number;
}

interface StoredJob {
    job_id: string;
    is_active: boolean;
    content_hash: string | null;
    application_url: string;
    department: string | null;
    posted_at: Date | null;
    workplace_type: string | null;
    employment_type: string | null;
    // node-postgres returns NUMERIC columns as strings.
    salary_min: string | number | null;
    salary_max: string | number | null;
    salary_currency: string | null;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
    return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function sameNumber(stored: string | number | null, next: number | null): boolean {
    return (stored === null ? null : Number(stored)) === next;
}

/**
 * Names the stored fields that differ from the incoming job. Title,
 * description, and location are covered by the connector's content hash;
 * the other fields are compared directly because the hashes don't include
 * them (and differ per connector).
 */
export function changedFields(stored: StoredJob, job: NormalizedJob): string[] {
    const changed: string[] = [];
    if (stored.content_hash !== job.contentHash) changed.push("content");
    if (stored.application_url !== job.applicationUrl) changed.push("application_url");
    if (stored.department !== job.department) changed.push("department");
    if (!sameInstant(stored.posted_at, job.postedAt)) changed.push("posted_at");
    if (stored.workplace_type !== job.workplaceType) changed.push("workplace_type");
    if (stored.employment_type !== job.employmentType) changed.push("employment_type");
    if (
        !sameNumber(stored.salary_min, job.salaryMin) ||
        !sameNumber(stored.salary_max, job.salaryMax) ||
        stored.salary_currency !== job.salaryCurrency
    ) {
        changed.push("salary");
    }
    return changed;
}

async function recordEvent(
    client: PoolClient,
    jobId: string,
    runId: string,
    eventType: "created" | "updated" | "reactivated",
    details: Record<string, unknown> | null = null,
): Promise<void> {
    await client.query(
        `INSERT INTO job_events (job_id, ingestion_run_id, event_type, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
        [jobId, runId, eventType, details === null ? null : JSON.stringify(details)],
    );
}

type PersistOutcome = {
    outcome: "inserted" | "updated" | "unchanged";
    reactivated: boolean;
};

async function persistJob(
    pool: Pool,
    source: ATSSource,
    job: NormalizedJob,
    runId: string,
): Promise<PersistOutcome> {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await client.query<StoredJob>(
            `SELECT js.job_id, jp.is_active, jp.content_hash, jp.application_url,
              jp.department, jp.posted_at, jp.workplace_type, jp.employment_type,
              jp.salary_min, jp.salary_max, jp.salary_currency
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
            const reactivated = !stored.is_active;
            const changed = changedFields(stored, job);

            if (changed.length === 0) {
                // Same content: record that we saw it, but don't rewrite the
                // row or bump updated_at (unless it is being reactivated).
                await client.query(
                    `UPDATE job_postings
           SET last_seen_at = NOW(), is_active = TRUE,
               updated_at = CASE WHEN is_active THEN updated_at ELSE NOW() END
           WHERE id = $1`,
                    [jobId],
                );
            } else {
                await client.query(
                    `UPDATE job_postings
           SET title = $2,
               description = $3,
               location = $4,
               department = $5,
               application_url = $6,
               posted_at = $7,
               workplace_type = $8,
               employment_type = $9,
               salary_min = $10,
               salary_max = $11,
               salary_currency = $12,
               last_seen_at = NOW(),
               is_active = TRUE,
               content_hash = $13,
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
                        job.workplaceType,
                        job.employmentType,
                        job.salaryMin,
                        job.salaryMax,
                        job.salaryCurrency,
                        job.contentHash,
                    ],
                );
                await recordEvent(client, jobId, runId, "updated", { fields: changed });
            }

            // raw_payload is the provider's latest response, so keep it
            // current even when nothing we display has changed. Being listed
            // again resets the missing-job counter.
            await client.query(
                `UPDATE job_sources
         SET raw_payload = $3::jsonb,
             external_url = $4,
             missed_runs = 0,
             last_seen_at = NOW()
         WHERE ats_source_id = $1 AND external_job_id = $2`,
                [source.id, job.externalJobId, rawPayloadJson, job.applicationUrl],
            );

            if (reactivated) await recordEvent(client, jobId, runId, "reactivated");

            await client.query("COMMIT");
            return { outcome: changed.length === 0 ? "unchanged" : "updated", reactivated };
        }

        const insertedJob = await client.query<{ id: string }>(
            `INSERT INTO job_postings (
         company_id, title, description, location, department,
         application_url, posted_at, workplace_type, employment_type,
         salary_min, salary_max, salary_currency, content_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
            [
                source.company_id,
                job.title,
                job.description,
                job.location,
                job.department,
                job.applicationUrl,
                job.postedAt,
                job.workplaceType,
                job.employmentType,
                job.salaryMin,
                job.salaryMax,
                job.salaryCurrency,
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
        await recordEvent(client, jobId, runId, "created");

        await client.query("COMMIT");
        return { outcome: "inserted", reactivated: false };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Applies the missing-job policy for one successful listing: every active
 * posting of this source not seen since the run started gains a miss, and
 * postings that reach the threshold are expired with an event.
 */
async function applyMissingJobPolicy(
    client: PoolClient,
    sourceId: string,
    runId: string,
    runStartedAt: Date,
    threshold: number,
): Promise<{ jobsMissing: number; jobsExpired: number }> {
    const missing = await client.query(
        `UPDATE job_sources js
     SET missed_runs = js.missed_runs + 1
     FROM job_postings jp
     WHERE jp.id = js.job_id
       AND jp.is_active = TRUE
       AND js.ats_source_id = $1
       AND js.last_seen_at < $2`,
        [sourceId, runStartedAt],
    );

    const expired = await client.query(
        `WITH expired AS (
       UPDATE job_postings jp
       SET is_active = FALSE, updated_at = NOW()
       FROM job_sources js
       WHERE js.job_id = jp.id
         AND jp.is_active = TRUE
         AND js.ats_source_id = $1
         AND js.last_seen_at < $2
         AND js.missed_runs >= $3
       RETURNING jp.id, js.missed_runs
     )
     INSERT INTO job_events (job_id, ingestion_run_id, event_type, details)
     SELECT id, $4, 'expired', jsonb_build_object('missed_runs', missed_runs)
     FROM expired`,
        [sourceId, runStartedAt, threshold, runId],
    );

    return { jobsMissing: missing.rowCount ?? 0, jobsExpired: expired.rowCount ?? 0 };
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
    const threshold = options.missedRunsBeforeExpiry ?? MISSED_RUNS_BEFORE_EXPIRY;
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
    let jobsReactivated = 0;

    try {
        const connector = options.connector ?? getConnector(source.provider);
        const jobs = await connector.fetchJobs(source);

        for (const job of jobs) {
            const { outcome, reactivated } = await persistJob(pool, source, job, runId);

            jobsSeen += 1;
            if (outcome === "inserted") jobsInserted += 1;
            else if (outcome === "updated") jobsUpdated += 1;
            else jobsUnchanged += 1;
            if (reactivated) jobsReactivated += 1;
        }

        // Missing-job detection, recording the run as succeeded and setting
        // last_success_at commit together, so a source is never marked
        // successful while its run says failed.
        let jobsMissing = 0;
        let jobsDeactivated = 0;
        let missingCheckSkipped = false;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // A provider can answer 200 with an empty list during an outage
            // or board migration. An empty listing for a source that still
            // has active jobs is not trusted as complete.
            if (jobs.length === 0) {
                const active = await client.query<{ active: number }>(
                    `SELECT COUNT(*)::int AS active
           FROM job_sources js
           JOIN job_postings jp ON jp.id = js.job_id
           WHERE js.ats_source_id = $1 AND jp.is_active = TRUE`,
                    [source.id],
                );
                missingCheckSkipped = (active.rows[0]?.active ?? 0) > 0;
            }

            if (!missingCheckSkipped) {
                const result = await applyMissingJobPolicy(
                    client, source.id, runId, runStartedAt, threshold,
                );
                jobsMissing = result.jobsMissing;
                jobsDeactivated = result.jobsExpired;
            }

            await client.query(
                `UPDATE ingestion_runs
       SET status = 'succeeded',
           finished_at = NOW(),
           jobs_seen = $2,
           jobs_inserted = $3,
           jobs_updated = $4,
           jobs_unchanged = $5,
           jobs_reactivated = $6,
           jobs_missing = $7,
           jobs_expired = $8,
           missing_check_skipped = $9
       WHERE id = $1`,
                [
                    runId, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged,
                    jobsReactivated, jobsMissing, jobsDeactivated, missingCheckSkipped,
                ],
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
            jobsReactivated,
            jobsMissing,
            jobsDeactivated,
            missingCheckSkipped,
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
