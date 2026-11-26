import "dotenv/config";
import { pool } from "../src/lib/db/pool";
import { buildEmbeddingText, createEmbedder, getEmbeddingConfig } from "../src/lib/embeddings";

/**
 * Embeds active jobs that have no vector for the active model, or whose
 * content changed since they were embedded (doc 07, decision D7). Each batch
 * is committed on its own, so an interrupted run loses at most one batch and
 * the next run continues where it stopped. Switching EMBEDDING_MODEL and
 * re-running this script is also how a re-embed is done.
 *
 * Usage: npm run embed [-- --limit 200] [-- --batch-size 8]
 * EMBED_NUM_THREADS caps Ollama's CPU threads (default 4 of the laptop's 8).
 */

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_THREADS = 4;

function numberArg(name: string, fallback: number | null): number | null {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = Number(process.argv[index + 1]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} needs a positive integer`);
    return value;
}

// Jobs needing work: no vector, a vector from another model, or a stale hash.
const NEEDS_EMBEDDING = `
    jp.is_active = TRUE
    AND (je.job_id IS NULL
         OR je.embedding_model <> $1
         OR je.content_hash IS DISTINCT FROM COALESCE(jp.content_hash, ''))`;

interface PendingJob {
    id: string;
    title: string;
    companyName: string;
    location: string | null;
    workplaceType: string | null;
    description: string | null;
    contentHash: string;
}

function formatDuration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function main(): Promise<void> {
    const limit = numberArg("limit", null);
    const batchSize = numberArg("batch-size", DEFAULT_BATCH_SIZE)!;
    const threads = Number(process.env.EMBED_NUM_THREADS) || DEFAULT_THREADS;

    // keep_alive 5m: the model is freed from RAM five minutes after the run ends.
    // A long timeout covers the cold start plus a full batch of long documents.
    const embedder = createEmbedder({
        ...getEmbeddingConfig(),
        keepAlive: "5m",
        numThread: threads,
        timeoutMs: 600_000,
    });
    const model = embedder.model;

    const pending = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM job_postings jp LEFT JOIN job_embeddings je ON je.job_id = jp.id
         WHERE ${NEEDS_EMBEDDING}`,
        [model],
    );
    const total = Math.min(pending.rows[0].count, limit ?? Infinity);
    console.log(
        `${pending.rows[0].count} active job(s) need embedding with ${model}; ` +
        `this run will do ${total} in batches of ${batchSize} using ${threads} thread(s).`,
    );
    if (total === 0) return;

    let stopping = false;
    process.on("SIGINT", () => {
        if (stopping) process.exit(130);
        stopping = true;
        console.log("\nStopping after the current batch (Ctrl-C again to quit now)...");
    });

    const started = Date.now();
    let done = 0;
    let characters = 0;

    while (!stopping && done < total) {
        // Keyset pagination is unnecessary: embedded jobs drop out of NEEDS_EMBEDDING.
        const { rows } = await pool.query<PendingJob>(
            `SELECT jp.id, jp.title, c.name AS "companyName", jp.location,
                    jp.workplace_type AS "workplaceType", jp.description,
                    COALESCE(jp.content_hash, '') AS "contentHash"
             FROM job_postings jp
             INNER JOIN companies c ON c.id = jp.company_id
             LEFT JOIN job_embeddings je ON je.job_id = jp.id
             WHERE ${NEEDS_EMBEDDING}
             ORDER BY jp.id
             LIMIT $2`,
            [model, Math.min(batchSize, total - done)],
        );
        if (rows.length === 0) break;

        const texts = rows.map(buildEmbeddingText);
        const vectors = await embedder.embedBatch(texts, "document");

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            for (const [i, job] of rows.entries()) {
                await client.query(
                    `INSERT INTO job_embeddings (job_id, embedding_model, embedding, content_hash)
                     VALUES ($1, $2, $3::vector, $4)
                     ON CONFLICT (job_id) DO UPDATE SET
                       embedding_model = EXCLUDED.embedding_model,
                       embedding = EXCLUDED.embedding,
                       content_hash = EXCLUDED.content_hash,
                       created_at = NOW()`,
                    [job.id, model, JSON.stringify(vectors[i]), job.contentHash],
                );
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        done += rows.length;
        characters += texts.reduce((sum, text) => sum + text.length, 0);
        const elapsed = Date.now() - started;
        const remaining = (elapsed / done) * (total - done);
        console.log(
            `${done}/${total} embedded · ${(done / (elapsed / 1000)).toFixed(2)} jobs/s · ` +
            `about ${formatDuration(remaining)} left`,
        );
    }

    const seconds = (Date.now() - started) / 1000;
    console.log(
        `Embedded ${done} job(s) in ${seconds.toFixed(0)} s ` +
        `(${(done / seconds).toFixed(2)} jobs/s, ${Math.round(characters / Math.max(done, 1))} chars/job on average).`,
    );
}

main()
    .catch((error) => {
        console.error("embed failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
