export interface ATSSource {
    id: string;
    company_id: string;
    provider: string;
    board_identifier: string;
}

/**
 * Provider-independent representation of a job posting.
 * Provider-specific response data is retained in rawPayload.
 */
export interface NormalizedJob {
    externalJobId: string;
    title: string;
    description: string | null;
    location: string | null;
    department: string | null;
    applicationUrl: string;
    postedAt: Date | null;
    contentHash: string;
    rawPayload: unknown;
}
