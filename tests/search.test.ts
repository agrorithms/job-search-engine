import assert from "node:assert/strict";
import test from "node:test";
import {
  SEARCH_PAGE_SIZE,
  buildJobSearchQuery,
  fuseRankings,
  HYBRID_CANDIDATES,
  buildKeywordCandidatesQuery,
  buildSemanticCandidatesQuery,
  buildJobsByIdQuery,
  parseJobSearchParams,
  searchHref,
} from "../src/lib/jobs/search";
import { formatPostedDate, formatSalary } from "../src/lib/jobs/format";

const COMPANY = "0f8b7c1e-3a2d-4c5b-9e6f-123456789abc";

test("an empty query defaults to every active job on page 1", () => {
  assert.deepEqual(parseJobSearchParams({}), {
    q: null, companyId: null, location: null, workplaceType: null, employmentType: null,
    minSalary: null, postedWithinDays: null, mode: "hybrid", page: 1,
  });
});

test("valid params are parsed, trimmed, and normalized", () => {
  const filters = parseJobSearchParams({
    q: "  backend python ", company: COMPANY.toUpperCase(), location: " New York ",
    workplace: "remote", type: "full_time", minSalary: "150000.7", posted: "7", mode: "semantic", page: "3",
  });
  assert.deepEqual(filters, {
    q: "backend python", companyId: COMPANY, location: "New York", workplaceType: "remote",
    employmentType: "full_time", minSalary: 150000, postedWithinDays: 7, mode: "semantic", page: 3,
  });
});

test("invalid or hostile params are ignored instead of reaching SQL", () => {
  const filters = parseJobSearchParams({
    q: ["first", "second"], company: "1; DROP TABLE jobs", workplace: "moon", type: "FullTime",
    minSalary: "-5", posted: "3", mode: "vibes", page: "0",
  });
  assert.equal(filters.mode, "hybrid");
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

test("searchHref keeps a non-default search mode and omits the hybrid default", () => {
  assert.equal(searchHref(parseJobSearchParams({ q: "x", mode: "keyword" }), 2), "?q=x&mode=keyword&page=2");
  assert.equal(searchHref(parseJobSearchParams({ q: "x", mode: "hybrid" }), 1), "?q=x");
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

test("RRF ranks jobs found by both searches above jobs found by one", () => {
  // keyword: a, b, c   semantic: c, d, a
  // a: 1/61 + 1/63   c: 1/63 + 1/61   b: 1/62   d: 1/62
  const fused = fuseRankings([["a", "b", "c"], ["c", "d", "a"]]);
  assert.deepEqual(fused.slice(0, 2).sort(), ["a", "c"]);
  assert.deepEqual(fused.slice(2).sort(), ["b", "d"]);
  assert.equal(fused.length, 4);
});

test("RRF scores are 1 / (60 + rank), so a top hit in one list beats a low hit in both", () => {
  const filler = (prefix: string) => Array.from({ length: 69 }, (_, i) => `${prefix}${i}`);
  const keyword = ["x", ...filler("k"), "y"]; // y at rank 71
  const semantic = [...filler("s"), "y"];      // y at rank 70
  // x: 1/61 = 0.016393; y: 1/131 + 1/130 = 0.015326
  const fused = fuseRankings([keyword, semantic]);
  assert.ok(fused.indexOf("x") < fused.indexOf("y"));
});

test("RRF breaks score ties by the order of the first ranking", () => {
  assert.deepEqual(fuseRankings([["a", "b"], ["b", "a"]]), ["a", "b"]);
  assert.deepEqual(fuseRankings([["a"], []]), ["a"]);
  assert.deepEqual(fuseRankings([[], ["z"]]), ["z"]);
});

const EMBEDDING = Array.from({ length: 1024 }, (_, i) => i / 1024);

test("semantic candidates: nearest by cosine distance, active model only, same filters", () => {
  const query = buildSemanticCandidatesQuery(
    parseJobSearchParams({ q: "data engineer", workplace: "remote", company: COMPANY }),
    EMBEDDING,
    "qwen3-embedding:0.6b",
  );
  assert.equal(HYBRID_CANDIDATES, 200);
  assert.match(query.sql, /INNER JOIN job_embeddings je ON je\.job_id = jp\.id AND je\.embedding_model = \$1/);
  assert.match(query.sql, /jp\.is_active = TRUE/);
  assert.match(query.sql, /jp\.company_id = \$2/);
  assert.match(query.sql, /jp\.workplace_type = \$3/);
  // The text query is matched by meaning only; it must not also require a keyword hit.
  assert.doesNotMatch(query.sql, /websearch_to_tsquery/);
  assert.match(query.sql, /ORDER BY je\.embedding <=> \$4::vector, jp\.id\s+LIMIT \$5/);
  assert.deepEqual(query.params, [
    "qwen3-embedding:0.6b", COMPANY, "remote", JSON.stringify(EMBEDDING), HYBRID_CANDIDATES,
  ]);
});

test("keyword candidates: the top keyword matches by rank, same filters", () => {
  const query = buildKeywordCandidatesQuery(parseJobSearchParams({ q: "data engineer", workplace: "remote" }));
  assert.match(query.sql, /SELECT jp\.id\s+FROM job_postings jp/);
  assert.match(query.sql, /jp\.search_vector @@ websearch_to_tsquery\('english', \$1\)/);
  assert.match(query.sql, /jp\.workplace_type = \$2/);
  assert.match(query.sql, /ORDER BY ts_rank_cd\(jp\.search_vector, websearch_to_tsquery\('english', \$1\)\) DESC/);
  assert.deepEqual(query.params, ["data engineer", "remote", HYBRID_CANDIDATES]);
});

test("a page of fused results is loaded by id", () => {
  const query = buildJobsByIdQuery(["id-1", "id-2"]);
  assert.match(query.sql, /WHERE jp\.id = ANY\(\$1::uuid\[\]\)/);
  assert.match(query.sql, /c\.name AS "companyName"/);
  assert.deepEqual(query.params, [["id-1", "id-2"]]);
});
