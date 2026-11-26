import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/lib/db/pool";
import { getEmbeddingConfig } from "../src/lib/embeddings";
import { SEARCH_MODES, parseJobSearchParams } from "../src/lib/jobs/search";
import { searchJobs } from "../src/lib/jobs/search-jobs";

/**
 * The evaluation gate from doc 07: runs the fixed queries in
 * eval/search-queries.json in each mode and prints the top results side by
 * side for comparison by eye. Re-run after any embedding model change.
 *
 * Usage: npm run eval:search [-- --top 10]
 */

async function main(): Promise<void> {
    const topIndex = process.argv.indexOf("--top");
    const top = topIndex === -1 ? 10 : Number(process.argv[topIndex + 1]) || 10;
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../eval/search-queries.json");
    const queries = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, string>>;

    const coverage = await pool.query<{ embedded: number; active: number }>(
        `SELECT COUNT(je.job_id)::int AS embedded, COUNT(*)::int AS active
         FROM job_postings jp
         LEFT JOIN job_embeddings je ON je.job_id = jp.id AND je.embedding_model = $1
         WHERE jp.is_active = TRUE`,
        [getEmbeddingConfig().model],
    );
    const { embedded, active } = coverage.rows[0];
    console.log(`Embedding coverage: ${embedded}/${active} active jobs.\n`);

    for (const { why, ...params } of queries) {
        console.log(`=== ${JSON.stringify(params)}${why ? `  (${why})` : ""}`);
        for (const mode of SEARCH_MODES) {
            const started = Date.now();
            const result = await searchJobs(parseJobSearchParams({ ...params, mode }));
            const label = result.mode === mode ? mode : `${mode} → fell back to ${result.mode}`;
            console.log(`--- ${label} (${result.total} results, ${Date.now() - started} ms)`);
            result.jobs.slice(0, top).forEach((job, i) => {
                console.log(`${String(i + 1).padStart(3)}. ${job.title} · ${job.companyName}`);
            });
        }
        console.log();
    }
}

main()
    .catch((error) => {
        console.error("eval:search failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
