
import { LeverConnector } from "../src/ingestion/connectors/lever";

async function main() {
    const connector = new LeverConnector();

    const jobs = await connector.fetchJobs({
        id: "test-source",
        company_id: "test-company",
        provider: "lever",
        board_identifier: "applydigital",
    });

    console.log(`Retrieved ${jobs.length} jobs`);

    console.log(
        jobs.slice(0, 3).map((job) => ({
            externalJobId: job.externalJobId,
            title: job.title,
            location: job.location,
            department: job.department,
            descriptionLength: job.description?.length,
            applicationUrl: job.applicationUrl,
            postedAt: job.postedAt,
            contentHash: job.contentHash,
            hasRawPayload: job.rawPayload !== null,
        }))
    );

    // Basic validation
    for (const job of jobs) {
        if (
            !job.externalJobId ||
            !job.title ||
            !job.applicationUrl ||
            !job.contentHash
        ) {
            throw new Error("Invalid normalized job");
        }
    }

    console.log("Lever connector validation passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
