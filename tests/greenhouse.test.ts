import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGreenhouseJob } from "../src/ingestion/connectors/greenhouse";

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
