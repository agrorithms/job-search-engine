import "dotenv/config";
import { getEmbeddingConfig, pullModel } from "../src/lib/embeddings";

/**
 * One-time setup: downloads the embedding model into the Ollama service
 * started by `docker compose up -d`. Safe to re-run.
 */
async function main(): Promise<void> {
    const config = getEmbeddingConfig();
    console.log(`Pulling ${config.model} into Ollama at ${config.baseUrl} (about 640 MB the first time)...`);
    await pullModel(config);
    console.log("Done.");
}

main().catch((error) => {
    console.error(
        "embed:setup failed:",
        error instanceof Error ? error.message : error,
        "\nIs the ollama service running? Try `docker compose up -d`.",
    );
    process.exitCode = 1;
});
