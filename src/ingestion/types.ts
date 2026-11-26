import type { EmploymentType, WorkplaceType } from "./structured";

export interface ATSSource {
    id: string;
    company_id: string;
    provider: string;
    board_identifier: string;
}

/**
 * Provider-independent representation of a job posting.
 * Provider-specific response data is retained in rawPayload.
 * Structured fields are null when the provider does not supply them.
 */
export interface NormalizedJob {
    externalJobId: string;
    title: string;
    description: string | null;
    location: string | null;
    department: string | null;
    applicationUrl: string;
    postedAt: Date | null;
    workplaceType: WorkplaceType | null;
    employmentType: EmploymentType | null;
    /** Annual salary range only; other pay periods remain in rawPayload. */
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    contentHash: string;
    rawPayload: unknown;
}
