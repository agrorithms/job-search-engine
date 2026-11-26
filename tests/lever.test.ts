import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LeverConnector, normalizeLeverPosting } from "../src/ingestion/connectors/lever";
import { getConnector } from "../src/ingestion/registry";
import type { ATSSource } from "../src/ingestion/types";

const fixture: unknown[] = JSON.parse(
  readFileSync(new URL("./fixtures/lever-postings.json", import.meta.url), "utf8"),
);
const source: ATSSource = { id: "s1", company_id: "c1", provider: "lever", board_identifier: "acme" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

test("normalizes a full posting, including lists and additional text", () => {
  const job = normalizeLeverPosting(fixture[0]);
  assert.equal(job.externalJobId, "5f2c0a1e-1111-4a1b-9c1d-000000000001");
  assert.equal(job.title, "Senior Backend Engineer");
  assert.equal(job.location, "Remote - US");
  assert.equal(job.department, "Engineering");
  assert.ok(job.applicationUrl.endsWith("/apply"));
  assert.equal(job.postedAt?.getTime(), 1700000000000);
  assert.match(job.description!, /We build & run the platform\./);
  assert.match(job.description!, /Requirements\n\nPython & SQL\n5\+ years/);
  assert.match(job.description!, /Equal opportunity employer\./);
  assert.doesNotMatch(job.description!, /[<>]|\\n/);
  assert.equal(job.rawPayload, fixture[0]);
});

test("handles sparse posting: trimmed title, fallback location/dept/url, stripped script, null date", () => {
  const job = normalizeLeverPosting(fixture[1]);
  assert.equal(job.title, "Data Analyst");
  assert.equal(job.location, "London, Berlin");
  assert.equal(job.department, "Analytics");
  assert.ok(job.applicationUrl.startsWith("https://jobs.lever.co/"));
  assert.equal(job.postedAt, null);
  assert.equal(job.description, "Analyse data.");
});

test("maps workplace type, commitment, and annual salary; leaves the rest unknown", () => {
  const full = normalizeLeverPosting(fixture[0]);
  assert.equal(full.workplaceType, "remote");
  assert.equal(full.employmentType, "full_time");
  assert.deepEqual([full.salaryMin, full.salaryMax, full.salaryCurrency], [160000, 200000, "USD"]);

  // "unspecified" workplace, a commitment that names no employment type, and
  // a monthly range all stay null.
  const sparse = normalizeLeverPosting(fixture[1]);
  assert.equal(sparse.workplaceType, null);
  assert.equal(sparse.employmentType, null);
  assert.deepEqual([sparse.salaryMin, sparse.salaryMax, sparse.salaryCurrency], [null, null, null]);
});

test("rejects postings missing id, title, or URL, and non-objects", () => {
  assert.throws(() => normalizeLeverPosting({ text: "x", hostedUrl: "u" }), /missing required/);
  assert.throws(() => normalizeLeverPosting({ id: "1", hostedUrl: "u" }), /missing required/);
  assert.throws(() => normalizeLeverPosting({ id: "1", text: "x" }), /missing required/);
  assert.throws(() => normalizeLeverPosting("nope"), /not an object/);
});

test("content hash is stable, and changes when the description changes", () => {
  const a = normalizeLeverPosting(fixture[0]);
  const b = normalizeLeverPosting(structuredClone(fixture[0]));
  const changed = normalizeLeverPosting({ ...(fixture[0] as object), descriptionPlain: "Different." });
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.contentHash, changed.contentHash);
});

test("fetchJobs returns normalized jobs and hits the global host first", async () => {
  const urls: string[] = [];
  const c = new LeverConnector({ sleep: noSleep, fetchImpl: async (u) => { urls.push(String(u)); return json(fixture); } });
  const jobs = await c.fetchJobs(source);
  assert.equal(jobs.length, 2);
  assert.deepEqual(urls, ["https://api.lever.co/v0/postings/acme?mode=json"]);
});

test("empty array is a valid, complete listing", async () => {
  const c = new LeverConnector({ sleep: noSleep, fetchImpl: async () => json([]) });
  assert.deepEqual(await c.fetchJobs(source), []);
});

test("falls back to the EU host on 404, and errors clearly if both 404", async () => {
  const urls: string[] = [];
  const eu = new LeverConnector({ sleep: noSleep, fetchImpl: async (u) => {
    urls.push(String(u));
    return String(u).includes("api.eu.") ? json(fixture) : json({ ok: false }, 404);
  } });
  assert.equal((await eu.fetchJobs(source)).length, 2);
  assert.equal(urls.length, 2);

  const none = new LeverConnector({ sleep: noSleep, fetchImpl: async () => json({}, 404) });
  await assert.rejects(none.fetchJobs(source), /not found on the global or EU/);
});

test("rejects non-array and non-JSON bodies, and non-retryable HTTP errors", async () => {
  await assert.rejects(new LeverConnector({ fetchImpl: async () => json({ jobs: [] }) }).fetchJobs(source), /JSON array/);
  await assert.rejects(new LeverConnector({ fetchImpl: async () => new Response("<html>") }).fetchJobs(source), /not valid JSON/);
  let calls = 0;
  const c = new LeverConnector({ sleep: noSleep, fetchImpl: async () => { calls++; return json({}, 403); } });
  await assert.rejects(c.fetchJobs(source), /Lever HTTP 403/);
  assert.equal(calls, 1, "403 must not be retried");
});

test("retries 5xx/429 and network errors with exponential backoff, then succeeds", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const c = new LeverConnector({
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return json({}, 503);
      if (calls === 2) throw new Error("socket hang up");
      return json(fixture);
    },
  });
  assert.equal((await c.fetchJobs(source)).length, 2);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("gives up after max attempts so the run is recorded as failed (never an empty list)", async () => {
  let calls = 0;
  const c = new LeverConnector({ sleep: noSleep, fetchImpl: async () => { calls++; return json({}, 500); } });
  await assert.rejects(c.fetchJobs(source), /HTTP 500|after 3 attempts/);
  assert.equal(calls, 3);
});

test("one malformed posting fails the whole fetch (no partial listing)", async () => {
  const c = new LeverConnector({ fetchImpl: async () => json([fixture[0], { id: "x" }]) });
  await assert.rejects(c.fetchJobs(source), /missing required/);
});

test("registry resolves lever and rejects unknown providers", () => {
  assert.equal(getConnector("lever").provider, "lever");
  assert.throws(() => getConnector("workday"), /Unsupported ATS provider/);
});
