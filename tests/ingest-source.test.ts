import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { ATSConnector } from "../src/ingestion/connectors/ats-connector";
import { ingestSource } from "../src/ingestion/services/ingest-source";
import type { ATSSource, NormalizedJob } from "../src/ingestion/types";

type StoredJob = Pick<
  NormalizedJob,
  "title" | "description" | "location" | "department" | "applicationUrl" | "postedAt" | "contentHash"
> & { id: string };

type StoredRun = {
  id: string;
  status: "running" | "succeeded" | "failed";
  jobsSeen: number;
  jobsInserted: number;
  jobsUpdated: number;
  jobsUnchanged: number;
  errorMessage: string | null;
};

/**
 * Fixture-backed PostgreSQL boundary. It models the schema's source identity
 * constraint and the exact persistence queries used by ingestSource, while
 * keeping tests independent of a running Docker/database service.
 */
class FixtureDatabase {
  readonly jobs = new Map<string, StoredJob>();
  readonly sourceJobs = new Map<string, string>();
  readonly runs = new Map<string, StoredRun>();
  private nextJob = 1;
  private nextRun = 1;

  async connect(): Promise<this> {
    return this;
  }

  release(): void {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("INSERT INTO ingestion_runs")) {
      const id = `run-${this.nextRun++}`;
      this.runs.set(id, {
        id, status: "running", jobsSeen: 0, jobsInserted: 0, jobsUpdated: 0,
        jobsUnchanged: 0, errorMessage: null,
      });
      return { rows: [{ id }] as unknown as T[], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT js.job_id")) {
      const [, externalJobId] = params as [string, string];
      const jobId = this.sourceJobs.get(externalJobId);
      const job = jobId ? this.jobs.get(jobId) : undefined;
      return job
        ? { rows: [{ job_id: job.id, content_hash: job.contentHash, application_url: job.applicationUrl }] as unknown as T[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("INSERT INTO job_postings")) {
      const [, title, description, location, department, applicationUrl, postedAt, contentHash] = params as [
        string, string, string | null, string | null, string | null, string, Date | null, string,
      ];
      const id = `job-${this.nextJob++}`;
      this.jobs.set(id, { id, title, description, location, department, applicationUrl, postedAt, contentHash });
      return { rows: [{ id }] as unknown as T[], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO job_sources")) {
      const [jobId, , externalJobId] = params as [string, string, string];
      this.sourceJobs.set(externalJobId, jobId);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE job_postings SET title")) {
      const [jobId, title, description, location, department, applicationUrl, postedAt, contentHash] = params as [
        string, string, string | null, string | null, string | null, string, Date | null, string,
      ];
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      Object.assign(job, { title, description, location, department, applicationUrl, postedAt, contentHash });
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized.startsWith("UPDATE job_postings SET last_seen_at") ||
      normalized.startsWith("UPDATE job_sources SET") ||
      normalized.startsWith("UPDATE ats_sources SET")
    ) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE ingestion_runs SET status = 'succeeded'")) {
      const [runId, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged] = params as [string, number, number, number, number];
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, { status: "succeeded" as const, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE ingestion_runs SET status = 'failed'")) {
      const [runId, errorMessage] = params as [string, string];
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, { status: "failed" as const, errorMessage });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected database query: ${normalized}`);
  }
}

class FixtureConnector implements ATSConnector {
  readonly provider = "lever";
  constructor(private readonly result: NormalizedJob[] | Error) {}
  async fetchJobs(): Promise<NormalizedJob[]> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const source: ATSSource = { id: "source-1", company_id: "company-1", provider: "lever", board_identifier: "fixture" };
const makeJob = (id: string, description = "Original description."): NormalizedJob => ({
  externalJobId: id,
  title: "Platform Engineer",
  description,
  location: "Remote",
  department: "Engineering",
  applicationUrl: `https://jobs.example.test/${id}`,
  postedAt: new Date("2026-01-01T00:00:00.000Z"),
  contentHash: `hash-${description}`,
  rawPayload: { id, description },
});

const asPool = (database: FixtureDatabase) => database as unknown as Pool;

test("persists fixture jobs on the initial ingestion", async () => {
  const database = new FixtureDatabase();
  const summary = await ingestSource(asPool(database), source, {
    connector: new FixtureConnector([makeJob("job-a"), makeJob("job-b")]),
  });

  assert.deepEqual(summary, {
    sourceId: "source-1", provider: "lever", jobsSeen: 2,
    jobsInserted: 2, jobsUpdated: 0, jobsUnchanged: 0,
  });
  assert.equal(database.jobs.size, 2);
  assert.equal(database.sourceJobs.size, 2);
  assert.deepEqual([...database.runs.values()][0], {
    id: "run-1", status: "succeeded", jobsSeen: 2, jobsInserted: 2,
    jobsUpdated: 0, jobsUnchanged: 0, errorMessage: null,
  });
});

test("a repeat fixture ingestion is unchanged and creates no duplicate rows", async () => {
  const database = new FixtureDatabase();
  const connector = new FixtureConnector([makeJob("job-a"), makeJob("job-b")]);
  await ingestSource(asPool(database), source, { connector });
  const repeated = await ingestSource(asPool(database), source, { connector });

  assert.equal(database.jobs.size, 2);
  assert.equal(database.sourceJobs.size, 2);
  assert.equal(repeated.jobsUnchanged, 2);
  assert.deepEqual([...database.runs.values()][1], {
    id: "run-2", status: "succeeded", jobsSeen: 2, jobsInserted: 0,
    jobsUpdated: 0, jobsUnchanged: 2, errorMessage: null,
  });
});

test("changed fixture content updates the canonical record and hash", async () => {
  const database = new FixtureDatabase();
  await ingestSource(asPool(database), source, { connector: new FixtureConnector([makeJob("job-a")]) });
  const changed = makeJob("job-a", "Revised description.");
  const summary = await ingestSource(asPool(database), source, { connector: new FixtureConnector([changed]) });

  const stored = database.jobs.get(database.sourceJobs.get("job-a")!);
  assert.equal(summary.jobsUpdated, 1);
  assert.equal(stored?.description, "Revised description.");
  assert.equal(stored?.contentHash, "hash-Revised description.");
});

test("a failed source fetch preserves previously persisted jobs", async () => {
  const database = new FixtureDatabase();
  await ingestSource(asPool(database), source, { connector: new FixtureConnector([makeJob("job-a")]) });
  await assert.rejects(
    ingestSource(asPool(database), source, { connector: new FixtureConnector(new Error("fixture fetch failed")) }),
    /fixture fetch failed/,
  );

  assert.equal(database.jobs.size, 1);
  assert.equal(database.sourceJobs.size, 1);
  const failed = [...database.runs.values()][1];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorMessage, "fixture fetch failed");
});
