import assert from "node:assert/strict";
import test from "node:test";
import {
  SEARCH_PAGE_SIZE,
  buildJobSearchQuery,
  parseJobSearchParams,
  searchHref,
} from "../src/lib/jobs/search";
import { formatPostedDate, formatSalary } from "../src/lib/jobs/format";

const COMPANY = "0f8b7c1e-3a2d-4c5b-9e6f-123456789abc";

test("an empty query defaults to every active job on page 1", () => {
  assert.deepEqual(parseJobSearchParams({}), {
    q: null, companyId: null, location: null, workplaceType: null, employmentType: null,
    minSalary: null, postedWithinDays: null, page: 1,
  });
});

test("valid params are parsed, trimmed, and normalized", () => {
  const filters = parseJobSearchParams({
    q: "  backend python ", company: COMPANY.toUpperCase(), location: " New York ",
    workplace: "remote", type: "full_time", minSalary: "150000.7", posted: "7", page: "3",
  });
  assert.deepEqual(filters, {
    q: "backend python", companyId: COMPANY, location: "New York", workplaceType: "remote",
    employmentType: "full_time", minSalary: 150000, postedWithinDays: 7, page: 3,
  });
});

test("invalid or hostile params are ignored instead of reaching SQL", () => {
  const filters = parseJobSearchParams({
    q: ["first", "second"], company: "1; DROP TABLE jobs", workplace: "moon", type: "FullTime",
    minSalary: "-5", posted: "3", page: "0",
  });
  assert.equal(filters.q, "first");
  assert.equal(filters.companyId, null);
  assert.equal(filters.workplaceType, null);
  assert.equal(filters.employmentType, null);
  assert.equal(filters.minSalary, null);
  assert.equal(filters.postedWithinDays, null);
  assert.equal(filters.page, 1);
  assert.equal(parseJobSearchParams({ page: "2.5" }).page, 1);
  assert.equal(parseJobSearchParams({ page: "999999" }).page, 1000);
  assert.equal(parseJobSearchParams({ q: "x".repeat(500) }).q?.length, 200);
});

test("without keywords, results are active jobs ordered by posting date", () => {
  const query = buildJobSearchQuery(parseJobSearchParams({}));
  assert.match(query.listSql, /WHERE jp\.is_active = TRUE\s+ORDER BY jp\.posted_at DESC NULLS LAST, jp\.id/);
  assert.deepEqual(query.listParams, [SEARCH_PAGE_SIZE, 0]);
  assert.deepEqual(query.countParams, []);
  assert.doesNotMatch(query.countSql, /LIMIT|ORDER BY/);
});

test("keywords use websearch_to_tsquery and rank by relevance", () => {
  const query = buildJobSearchQuery(parseJobSearchParams({ q: "data engineer", page: "2" }));
  assert.match(query.listSql, /jp\.search_vector @@ websearch_to_tsquery\('english', \$1\)/);
  assert.match(query.listSql, /ORDER BY ts_rank_cd\(jp\.search_vector, websearch_to_tsquery\('english', \$1\)\) DESC/);
  assert.match(query.listSql, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(query.listParams, ["data engineer", SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE]);
  assert.deepEqual(query.countParams, ["data engineer"]);
});

test("every filter is bound as a parameter, in order", () => {
  const query = buildJobSearchQuery(parseJobSearchParams({
    company: COMPANY, location: "50%_off\\", workplace: "hybrid", type: "contract", minSalary: "120000", posted: "30",
  }));
  assert.match(query.countSql, /jp\.company_id = \$1/);
  assert.match(query.countSql, /jp\.location ILIKE \$2/);
  assert.match(query.countSql, /jp\.workplace_type = \$3/);
  assert.match(query.countSql, /jp\.employment_type = \$4/);
  assert.match(query.countSql, /jp\.salary_currency = \$5/);
  assert.match(query.countSql, /COALESCE\(jp\.salary_max, jp\.salary_min\) >= \$6/);
  assert.match(query.countSql, /make_interval\(days => \$7\)/);
  // LIKE wildcards in user input are escaped so they match literally.
  assert.deepEqual(query.countParams, [COMPANY, "%50\\%\\_off\\\\%", "hybrid", "contract", "USD", 120000, 30]);
});

test("searchHref preserves filters across pages and drops page 1", () => {
  const filters = parseJobSearchParams({ q: "a&b", workplace: "remote", page: "4" });
  assert.equal(searchHref(filters, 5), "?q=a%26b&workplace=remote&page=5");
  assert.equal(searchHref(filters, 1), "?q=a%26b&workplace=remote");
  assert.equal(searchHref(parseJobSearchParams({}), 1), "?");
});

test("formatPostedDate labels missing dates and renders known dates consistently", () => {
  assert.equal(formatPostedDate(null), "Posting date unavailable");
  assert.equal(formatPostedDate(new Date("2026-11-26T00:00:00.000Z")), "Nov 26, 2026");
});

test("formatSalary handles ranges, single values, open ends, and unknowns", () => {
  assert.equal(formatSalary("195000", "229000", "USD"), "$195K – $229K");
  assert.equal(formatSalary(110000, 110000, "USD"), "$110K");
  assert.equal(formatSalary(null, "90000", "EUR"), "Up to €90K");
  assert.equal(formatSalary("90000", null, "GBP"), "From £90K");
  assert.equal(formatSalary(null, null, "USD"), null);
  assert.equal(formatSalary("1", "2", null), null);
});
