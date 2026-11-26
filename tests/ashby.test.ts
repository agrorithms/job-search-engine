import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AshbyConnector, normalizeAshbyJob } from "../src/ingestion/connectors/ashby";
import { getConnector } from "../src/ingestion/registry";
import type { ATSSource } from "../src/ingestion/types";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ashby-postings.json", import.meta.url), "utf8"),
) as { jobs: unknown[] };
const source: ATSSource = { id: "s1", company_id: "c1", provider: "ashby", board_identifier: "acme board" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

test("normalizes public Ashby fields and strips description markup", () => {
  const job = normalizeAshbyJob(fixture.jobs[0]);
  assert.equal(job.externalJobId, "018f0ca0-0000-7000-8000-000000000001");
  assert.equal(job.title, "Platform Engineer");
  assert.equal(job.location, "Remote (US)");
  assert.equal(job.department, "Engineering");
  assert.equal(job.postedAt?.toISOString(), "2024-06-01T12:00:00.000Z");
  assert.match(job.description!, /Build reliable platforms\s*\./);
  assert.match(job.description!, /TypeScript\nPostgreSQL/);
  assert.doesNotMatch(job.description!, /<|>|ignore/);
  assert.equal(job.rawPayload, fixture.jobs[0]);
});

test("supports structured location/team, job URL fallback, and invalid dates", () => {
  const job = normalizeAshbyJob(fixture.jobs[1]);
  assert.equal(job.location, "New York, NY");
  assert.equal(job.department, "Data");
  assert.equal(job.description, "Build data pipelines.");
  assert.equal(job.postedAt, null);
  assert.match(job.applicationUrl, /ashbyhq/);
});

test("rejects malformed postings", () => {
  assert.throws(() => normalizeAshbyJob({ title: "x", applyUrl: "url" }), /missing required/);
  assert.throws(() => normalizeAshbyJob({ id: "1", applyUrl: "url" }), /missing required/);
  assert.throws(() => normalizeAshbyJob("not a job"), /not an object/);
});

test("fetches, validates the response, and encodes the board identifier", async () => {
  const urls: string[] = [];
  const connector = new AshbyConnector({
    sleep: noSleep,
    fetchImpl: async (url) => { urls.push(String(url)); return json(fixture); },
  });
  assert.equal((await connector.fetchJobs(source)).length, 2);
  assert.deepEqual(urls, ["https://api.ashbyhq.com/posting-api/job-board/acme%20board?includeCompensation=true"]);
  await assert.rejects(
    new AshbyConnector({ fetchImpl: async () => json({}) }).fetchJobs(source),
    /missing jobs array/,
  );
});

test("accepts an empty complete listing and retries transient failures", async () => {
  assert.deepEqual(await new AshbyConnector({ fetchImpl: async () => json({ jobs: [] }) }).fetchJobs(source), []);
  const sleeps: number[] = [];
  let calls = 0;
  const connector = new AshbyConnector({
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => { calls += 1; return calls < 3 ? json({}, 503) : json(fixture); },
  });
  assert.equal((await connector.fetchJobs(source)).length, 2);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("registry resolves Ashby", () => {
  assert.equal(getConnector("ashby").provider, "ashby");
});
