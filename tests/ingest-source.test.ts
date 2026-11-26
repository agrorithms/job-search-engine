import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { ATSConnector } from "../src/ingestion/connectors/ats-connector";
import { changedFields, ingestSource } from "../src/ingestion/services/ingest-source";
import type { ATSSource, NormalizedJob } from "../src/ingestion/types";

type StoredJob = Pick<
  NormalizedJob,
  | "title" | "description" | "location" | "department" | "applicationUrl" | "postedAt"
  | "workplaceType" | "employmentType" | "salaryMin" | "salaryMax" | "salaryCurrency" | "contentHash"
> & { id: string; isActive: boolean };

type StoredRun = {
  id: string;
  status: "running" | "succeeded" | "failed";
  jobsSeen: number;
  jobsInserted: number;
  jobsUpdated: number;
  jobsUnchanged: number;
  jobsReactivated: number;
  jobsMissing: number;
  jobsExpired: number;
  missingCheckSkipped: boolean;
  errorMessage: string | null;
};

type StoredEvent = { jobId: string; runId: string; type: string; details: unknown };

/**
 * Fixture-backed PostgreSQL boundary. It models the schema's source identity
 * constraint and the exact persistence queries used by ingestSource, while
 * keeping tests independent of a running Docker/database service.
 */
class FixtureDatabase {
  readonly jobs = new Map<string, StoredJob>();
  readonly sourceJobs = new Map<string, string>();
  readonly runs = new Map<string, StoredRun>();
  readonly events: StoredEvent[] = [];
  /** externalJobId -> logical time job_sources.last_seen_at was last set. */
  readonly sourceSeenAt = new Map<string, number>();
  /** externalJobId -> job_sources.missed_runs. */
  readonly missedRuns = new Map<string, number>();
  readonly rawPayloads = new Map<string, unknown>();
  private nextJob = 1;
  private nextRun = 1;
  /** Monotonic stand-in for the database's NOW(). */
  private clock = 0;
  /** Every statement executed, whitespace-normalized, in order. */
  readonly log: string[] = [];
  /** Statements starting with this prefix throw, simulating a DB error. */
  failOn: string | null = null;

  async connect(): Promise<this> {
    return this;
  }

  release(): void {}

  /** Active postings not seen since `startedAt` (all fixture jobs share one source). */
  private *absentActive(startedAt: Date): Generator<[string, StoredJob]> {
    for (const [externalJobId, jobId] of this.sourceJobs) {
      const job = this.jobs.get(jobId)!;
      if (job.isActive && (this.sourceSeenAt.get(externalJobId) ?? 0) < startedAt.getTime()) {
        yield [externalJobId, job];
      }
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const now = ++this.clock;
    this.log.push(normalized);
    const result = (rows: unknown[], rowCount = rows.length) => ({ rows: rows as T[], rowCount });
    if (this.failOn && normalized.startsWith(this.failOn)) {
      throw new Error(`column "jobs_unchanged" does not exist`);
    }

    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return result([]);
    }

    if (normalized.startsWith("INSERT INTO ingestion_runs")) {
      const id = `run-${this.nextRun++}`;
      this.runs.set(id, {
        id, status: "running", jobsSeen: 0, jobsInserted: 0, jobsUpdated: 0, jobsUnchanged: 0,
        jobsReactivated: 0, jobsMissing: 0, jobsExpired: 0, missingCheckSkipped: false, errorMessage: null,
      });
      return result([{ id, started_at: new Date(now) }]);
    }

    if (normalized.startsWith("SELECT js.job_id")) {
      const [, externalJobId] = params as [string, string];
      const jobId = this.sourceJobs.get(externalJobId);
      const job = jobId ? this.jobs.get(jobId) : undefined;
      if (!job) return result([]);
      // NUMERIC columns come back from node-postgres as strings.
      return result([{
        job_id: job.id, is_active: job.isActive, content_hash: job.contentHash,
        application_url: job.applicationUrl, department: job.department, posted_at: job.postedAt,
        workplace_type: job.workplaceType, employment_type: job.employmentType,
        salary_min: job.salaryMin === null ? null : String(job.salaryMin),
        salary_max: job.salaryMax === null ? null : String(job.salaryMax),
        salary_currency: job.salaryCurrency,
      }]);
    }

    if (normalized.startsWith("INSERT INTO job_postings")) {
      const [, title, description, location, department, applicationUrl, postedAt,
        workplaceType, employmentType, salaryMin, salaryMax, salaryCurrency, contentHash] = params as [
        string, string, string | null, string | null, string | null, string, Date | null,
        StoredJob["workplaceType"], StoredJob["employmentType"], number | null, number | null, string | null, string,
      ];
      const id = `job-${this.nextJob++}`;
      this.jobs.set(id, {
        id, title, description, location, department, applicationUrl, postedAt, workplaceType,
        employmentType, salaryMin, salaryMax, salaryCurrency, contentHash, isActive: true,
      });
      return result([{ id }]);
    }

    if (normalized.startsWith("INSERT INTO job_sources")) {
      const [jobId, , externalJobId, , rawPayload] = params as [string, string, string, string, string];
      this.sourceJobs.set(externalJobId, jobId);
      this.sourceSeenAt.set(externalJobId, now);
      this.missedRuns.set(externalJobId, 0);
      this.rawPayloads.set(externalJobId, JSON.parse(rawPayload));
      return result([], 1);
    }

    if (normalized.startsWith("INSERT INTO job_events")) {
      const [jobId, runId, type, details] = params as [string, string, string, string | null];
      this.events.push({ jobId, runId, type, details: details === null ? null : JSON.parse(details) });
      return result([], 1);
    }

    if (normalized.startsWith("UPDATE job_postings SET title")) {
      const [jobId, title, description, location, department, applicationUrl, postedAt,
        workplaceType, employmentType, salaryMin, salaryMax, salaryCurrency, contentHash] = params as [
        string, string, string | null, string | null, string | null, string, Date | null,
        StoredJob["workplaceType"], StoredJob["employmentType"], number | null, number | null, string | null, string,
      ];
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      Object.assign(job, {
        title, description, location, department, applicationUrl, postedAt, workplaceType,
        employmentType, salaryMin, salaryMax, salaryCurrency, contentHash, isActive: true,
      });
      return result([], 1);
    }

    if (normalized.startsWith("UPDATE job_postings SET last_seen_at")) {
      const [jobId] = params as [string];
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      job.isActive = true;
      return result([], 1);
    }

    if (normalized.startsWith("UPDATE job_sources SET raw_payload")) {
      const [, externalJobId, rawPayload] = params as [string, string, string];
      this.sourceSeenAt.set(externalJobId, now);
      this.missedRuns.set(externalJobId, 0);
      this.rawPayloads.set(externalJobId, JSON.parse(rawPayload));
      return result([], 1);
    }

    if (normalized.startsWith("SELECT COUNT(*)::int AS active")) {
      const active = [...this.jobs.values()].filter((job) => job.isActive).length;
      return result([{ active }]);
    }

    if (normalized.startsWith("UPDATE job_sources js SET missed_runs")) {
      const [, startedAt] = params as [string, Date];
      let rowCount = 0;
      for (const [externalJobId] of this.absentActive(startedAt)) {
        this.missedRuns.set(externalJobId, (this.missedRuns.get(externalJobId) ?? 0) + 1);
        rowCount += 1;
      }
      return result([], rowCount);
    }

    if (normalized.startsWith("WITH expired AS")) {
      const [, startedAt, threshold, runId] = params as [string, Date, number, string];
      let rowCount = 0;
      for (const [externalJobId, job] of [...this.absentActive(startedAt)]) {
        const missed = this.missedRuns.get(externalJobId) ?? 0;
        if (missed < threshold) continue;
        job.isActive = false;
        this.events.push({ jobId: job.id, runId, type: "expired", details: { missed_runs: missed } });
        rowCount += 1;
      }
      return result([], rowCount);
    }

    if (normalized.startsWith("UPDATE ats_sources SET")) {
      return result([], 1);
    }

    if (normalized.startsWith("UPDATE ingestion_runs SET status = 'succeeded'")) {
      const [runId, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged, jobsReactivated,
        jobsMissing, jobsExpired, missingCheckSkipped] = params as [
        string, number, number, number, number, number, number, number, boolean,
      ];
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, {
        status: "succeeded" as const, jobsSeen, jobsInserted, jobsUpdated, jobsUnchanged,
        jobsReactivated, jobsMissing, jobsExpired, missingCheckSkipped,
      });
      return result([], 1);
    }

    if (normalized.startsWith("UPDATE ingestion_runs SET status = 'failed'")) {
      const [runId, errorMessage] = params as [string, string];
      const run = this.runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, { status: "failed" as const, errorMessage });
      return result([], 1);
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
  workplaceType: "remote",
  employmentType: "full_time",
  salaryMin: 150000,
  salaryMax: 180000,
  salaryCurrency: "USD",
  contentHash: `hash-${description}`,
  rawPayload: { id, description },
});

const asPool = (database: FixtureDatabase) => database as unknown as Pool;
const run = (database: FixtureDatabase, jobs: NormalizedJob[] | Error) =>
  ingestSource(asPool(database), source, { connector: new FixtureConnector(jobs) });
const storedJob = (database: FixtureDatabase, externalJobId: string) =>
  database.jobs.get(database.sourceJobs.get(externalJobId)!)!;
const eventTypes = (database: FixtureDatabase, externalJobId: string) => {
  const jobId = database.sourceJobs.get(externalJobId);
  return database.events.filter((event) => event.jobId === jobId).map((event) => event.type);
};

test("persists fixture jobs on the initial ingestion", async () => {
  const database = new FixtureDatabase();
  const summary = await run(database, [makeJob("job-a"), makeJob("job-b")]);

  assert.deepEqual(summary, {
    sourceId: "source-1", provider: "lever", jobsSeen: 2, jobsInserted: 2, jobsUpdated: 0,
    jobsUnchanged: 0, jobsReactivated: 0, jobsMissing: 0, jobsDeactivated: 0, missingCheckSkipped: false,
  });
  assert.equal(database.jobs.size, 2);
  assert.equal(database.sourceJobs.size, 2);
  assert.deepEqual([...database.runs.values()][0], {
    id: "run-1", status: "succeeded", jobsSeen: 2, jobsInserted: 2, jobsUpdated: 0, jobsUnchanged: 0,
    jobsReactivated: 0, jobsMissing: 0, jobsExpired: 0, missingCheckSkipped: false, errorMessage: null,
  });
  assert.deepEqual(eventTypes(database, "job-a"), ["created"]);
  assert.equal(storedJob(database, "job-a").workplaceType, "remote");
  assert.equal(storedJob(database, "job-a").salaryMin, 150000);
});

test("a repeat fixture ingestion is unchanged and creates no duplicate rows or events", async () => {
  const database = new FixtureDatabase();
  const jobs = [makeJob("job-a"), makeJob("job-b")];
  await run(database, jobs);
  const repeated = await run(database, jobs);

  assert.equal(database.jobs.size, 2);
  assert.equal(database.sourceJobs.size, 2);
  assert.equal(repeated.jobsUnchanged, 2);
  assert.equal(database.events.length, 2, "only the two 'created' events");
  const second = [...database.runs.values()][1];
  assert.equal(second?.status, "succeeded");
  assert.equal(second?.jobsInserted, 0);
  assert.equal(second?.jobsUnchanged, 2);
});

test("changed fixture content updates the canonical record and hash, with an event", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);
  const summary = await run(database, [makeJob("job-a", "Revised description.")]);

  const stored = storedJob(database, "job-a");
  assert.equal(summary.jobsUpdated, 1);
  assert.equal(stored.description, "Revised description.");
  assert.equal(stored.contentHash, "hash-Revised description.");
  assert.deepEqual(database.events.at(-1), {
    jobId: stored.id, runId: "run-2", type: "updated", details: { fields: ["content"] },
  });
});

test("a department, posting-date, or structured-field change is an update even when the hash matches", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);

  const moved = { ...makeJob("job-a"), department: "Platform" };
  assert.equal((await run(database, [moved])).jobsUpdated, 1);
  assert.equal(storedJob(database, "job-a").department, "Platform");

  const redated = { ...moved, postedAt: new Date("2026-02-01T00:00:00.000Z") };
  assert.equal((await run(database, [redated])).jobsUpdated, 1);
  assert.equal(storedJob(database, "job-a").postedAt?.toISOString(), "2026-02-01T00:00:00.000Z");

  const hybrid = { ...redated, workplaceType: "hybrid" as const, salaryMax: 190000 };
  assert.equal((await run(database, [hybrid])).jobsUpdated, 1);
  assert.equal(storedJob(database, "job-a").workplaceType, "hybrid");
  assert.deepEqual(database.events.at(-1)?.details, { fields: ["workplace_type", "salary"] });

  // NUMERIC salary read back as a string still compares equal.
  assert.equal((await run(database, [hybrid])).jobsUnchanged, 1);
});

test("changedFields treats NUMERIC strings and numbers as equal", () => {
  const job = makeJob("job-a");
  const stored = {
    job_id: "job-1", is_active: true, content_hash: job.contentHash, application_url: job.applicationUrl,
    department: job.department, posted_at: job.postedAt, workplace_type: job.workplaceType,
    employment_type: job.employmentType, salary_min: "150000.00", salary_max: "180000", salary_currency: "USD",
  };
  assert.deepEqual(changedFields(stored, job), []);
  assert.deepEqual(changedFields({ ...stored, salary_min: null }, job), ["salary"]);
});

test("a failed source fetch preserves previously persisted jobs", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);
  await assert.rejects(run(database, new Error("fixture fetch failed")), /fixture fetch failed/);

  assert.equal(database.jobs.size, 1);
  assert.equal(database.sourceJobs.size, 1);
  const failed = [...database.runs.values()][1];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorMessage, "fixture fetch failed");
});

test("an unchanged job still refreshes its raw payload", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);
  const sameContent = { ...makeJob("job-a"), rawPayload: { id: "job-a", extra: "new provider field" } };
  const summary = await run(database, [sameContent]);

  assert.equal(summary.jobsUnchanged, 1);
  assert.deepEqual(database.rawPayloads.get("job-a"), { id: "job-a", extra: "new provider field" });
});

test("a job missing from one listing is not expired yet", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a"), makeJob("job-b")]);

  const summary = await run(database, [makeJob("job-a")]);
  assert.equal(summary.jobsMissing, 1);
  assert.equal(summary.jobsDeactivated, 0);
  assert.equal(storedJob(database, "job-b").isActive, true);
  assert.equal(database.missedRuns.get("job-b"), 1);
});

test("a job expires after consecutive misses, with an event, and is reactivated if relisted", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a"), makeJob("job-b")]);
  await run(database, [makeJob("job-a")]);

  const expired = await run(database, [makeJob("job-a")]);
  assert.equal(expired.jobsMissing, 1);
  assert.equal(expired.jobsDeactivated, 1);
  assert.equal(storedJob(database, "job-a").isActive, true);
  assert.equal(storedJob(database, "job-b").isActive, false);
  assert.deepEqual(database.events.at(-1)?.details, { missed_runs: 2 });

  // Already-expired jobs are not counted as missing again.
  const quiet = await run(database, [makeJob("job-a")]);
  assert.equal(quiet.jobsMissing, 0);

  const relisted = await run(database, [makeJob("job-a"), makeJob("job-b")]);
  assert.equal(relisted.jobsReactivated, 1);
  assert.equal(relisted.jobsUnchanged, 2);
  assert.equal(storedJob(database, "job-b").isActive, true);
  assert.equal(database.missedRuns.get("job-b"), 0);
  assert.deepEqual(eventTypes(database, "job-b"), ["created", "expired", "reactivated"]);
});

test("misses must be consecutive: reappearing resets the counter", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a"), makeJob("job-b")]);
  await run(database, [makeJob("job-a")]);
  await run(database, [makeJob("job-a"), makeJob("job-b")]);
  const summary = await run(database, [makeJob("job-a")]);

  assert.equal(summary.jobsDeactivated, 0);
  assert.equal(storedJob(database, "job-b").isActive, true);
  assert.equal(database.missedRuns.get("job-b"), 1);
});

test("an empty listing for a source with active jobs skips missing-job detection", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);

  for (let i = 0; i < 3; i += 1) {
    const summary = await run(database, []);
    assert.equal(summary.missingCheckSkipped, true);
    assert.equal(summary.jobsMissing, 0);
  }
  assert.equal(storedJob(database, "job-a").isActive, true);
  assert.equal(database.missedRuns.get("job-a"), 0);
  assert.equal([...database.runs.values()].at(-1)?.missingCheckSkipped, true);
});

test("an empty listing for a source with no active jobs is a normal success", async () => {
  const database = new FixtureDatabase();
  const summary = await run(database, []);
  assert.equal(summary.missingCheckSkipped, false);
  assert.equal([...database.runs.values()][0]?.status, "succeeded");
});

test("a failed fetch does not count as a miss", async () => {
  const database = new FixtureDatabase();
  await run(database, [makeJob("job-a")]);
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(run(database, new Error("boom")));
  }
  assert.equal(storedJob(database, "job-a").isActive, true);
  assert.equal(database.missedRuns.get("job-a"), 0);
});

test("if recording the run fails, the source is not marked successful", async () => {
  const database = new FixtureDatabase();
  database.failOn = "UPDATE ingestion_runs SET status = 'succeeded'";

  await assert.rejects(run(database, [makeJob("job-a")]), /jobs_unchanged/);

  const finalize = database.log.slice(database.log.lastIndexOf("BEGIN"));
  assert.ok(finalize.includes("ROLLBACK"), "finalize transaction must roll back");
  assert.ok(!finalize.includes("COMMIT"));
  assert.ok(!database.log.some((q) => q.includes("last_success_at")), "last_success_at must not be set");
  assert.equal([...database.runs.values()][0]?.status, "failed");
});
