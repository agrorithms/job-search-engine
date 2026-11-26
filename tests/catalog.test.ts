import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_JOB_CATALOG_QUERY, ACTIVE_JOB_COUNT_QUERY, formatPostedDate } from "../src/lib/jobs/catalog";

test("catalog query reads active jobs joined to their companies in stable recency order", () => {
  assert.match(ACTIVE_JOB_CATALOG_QUERY, /INNER JOIN companies c ON c\.id = jp\.company_id/);
  assert.match(ACTIVE_JOB_CATALOG_QUERY, /WHERE jp\.is_active = TRUE/);
  assert.match(ACTIVE_JOB_CATALOG_QUERY, /ORDER BY jp\.last_seen_at DESC, jp\.id DESC/);
  assert.match(ACTIVE_JOB_CATALOG_QUERY, /LIMIT 200/);
});

test("the active-job count is uncapped and matches the list's filter", () => {
  assert.match(ACTIVE_JOB_COUNT_QUERY, /COUNT\(\*\)/);
  assert.match(ACTIVE_JOB_COUNT_QUERY, /INNER JOIN companies c ON c\.id = jp\.company_id/);
  assert.match(ACTIVE_JOB_COUNT_QUERY, /WHERE jp\.is_active = TRUE/);
  assert.doesNotMatch(ACTIVE_JOB_COUNT_QUERY, /LIMIT/);
});

test("formatPostedDate labels missing dates and renders known dates consistently", () => {
  assert.equal(formatPostedDate(null), "Posting date unavailable");
  assert.equal(formatPostedDate(new Date("2026-11-26T00:00:00.000Z")), "Nov 26, 2026");
});
