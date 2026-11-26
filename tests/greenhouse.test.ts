import { test } from "node:test";
import assert from "node:assert/strict";
import { GreenhouseConnector, normalizeGreenhouseJob } from "../src/ingestion/connectors/greenhouse";

const raw = {
  id: 42,
  title: "Backend Engineer",
  absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
  location: { name: "Remote" },
  content: "&lt;h2&gt;Who we are&lt;/h2&gt;&lt;p&gt;We build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;",
};

test("decodes Greenhouse's escaped HTML and leaves no markup in the description", () => {
  const job = normalizeGreenhouseJob(raw);
  assert.doesNotMatch(job.description!, /<|>|&[a-z]+;/);
  assert.match(job.description!, /Who we are/);
  assert.match(job.description!, /We build & ship\./);
  assert.match(job.description!, /Python\nSQL/);
});

test("null content stays null; missing id/title/url throws", () => {
  assert.equal(normalizeGreenhouseJob({ ...raw, content: null }).description, null);
  assert.throws(() => normalizeGreenhouseJob({ ...raw, absolute_url: undefined }), /missing/);
});

test("postedAt is first_published, not the last-edit updated_at", () => {
  const job = normalizeGreenhouseJob({
    ...raw,
    first_published: "2025-03-01T12:00:00Z",
    updated_at: "2026-11-25T09:00:00Z",
  });
  assert.equal(job.postedAt?.toISOString(), "2025-03-01T12:00:00.000Z");
  assert.equal(normalizeGreenhouseJob({ ...raw, updated_at: "2026-11-25T09:00:00Z" }).postedAt, null);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const source = { id: "s", company_id: "c", provider: "greenhouse", board_identifier: "acme" };

test("fetch uses a timeout and retries transient failures with backoff", async () => {
  const sleeps: number[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  let calls = 0;
  const connector = new GreenhouseConnector({
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (_url, init) => {
      calls += 1;
      signals.push(init?.signal);
      if (calls === 1) return json({}, 503);
      if (calls === 2) throw new Error("socket hang up");
      return json({ jobs: [raw] });
    },
  });
  assert.equal((await connector.fetchJobs(source)).length, 1);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});

test("gives up after max attempts and does not retry a 404", async () => {
  let calls = 0;
  const failing = new GreenhouseConnector({ sleep: async () => {}, fetchImpl: async () => { calls += 1; return json({}, 500); } });
  await assert.rejects(failing.fetchJobs(source), /Greenhouse HTTP 500/);
  assert.equal(calls, 3);

  calls = 0;
  const missing = new GreenhouseConnector({ fetchImpl: async () => { calls += 1; return json({}, 404); } });
  await assert.rejects(missing.fetchJobs(source), /Greenhouse HTTP 404/);
  assert.equal(calls, 1);
});

test("a timeout while the body is still downloading is retried, not reported as bad JSON", async () => {
  let calls = 0;
  const connector = new GreenhouseConnector({
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const stalled = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jobs": ['));
            controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
          },
        });
        return new Response(stalled, { status: 200 });
      }
      return json({ jobs: [raw] });
    },
  });
  assert.equal((await connector.fetchJobs(source)).length, 1);
  assert.equal(calls, 2);
});
