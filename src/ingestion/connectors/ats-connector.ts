import type { ATSSource, NormalizedJob } from "../types";

/**
 * Every ATS connector returns jobs in the shared application format.
 * Provider-specific response types and normalization stay inside the connector.
 */
export interface ATSConnector {
  readonly provider: string;
  fetchJobs(source: ATSSource): Promise<NormalizedJob[]>;
}
