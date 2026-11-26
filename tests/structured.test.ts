import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annualSalary,
  normalizeEmploymentType,
  normalizeWorkplaceType,
} from "../src/ingestion/structured";

test("workplace types from Ashby and Lever map to the canonical vocabulary", () => {
  assert.equal(normalizeWorkplaceType("Remote"), "remote");
  assert.equal(normalizeWorkplaceType("hybrid"), "hybrid");
  assert.equal(normalizeWorkplaceType("OnSite"), "onsite");
  assert.equal(normalizeWorkplaceType("on-site"), "onsite");
  assert.equal(normalizeWorkplaceType("unspecified"), null);
  assert.equal(normalizeWorkplaceType(undefined), null);
  assert.equal(normalizeWorkplaceType(true), null);
});

test("employment types are recognised from enums and observed Lever commitments", () => {
  const cases: Array<[string, string | null]> = [
    ["FullTime", "full_time"],
    ["PartTime", "part_time"],
    ["Intern", "internship"],
    ["Contract", "contract"],
    ["Temporary", "temporary"],
    ["Full-time", "full_time"],
    ["Full Time_CLO", "full_time"],
    ["Permanent (Full Time)", "full_time"],
    ["Full-Time | Hybrid", "full_time"],
    ["Contract | Remote", "contract"],
    ["Contractor", "contract"],
    ["Internship", "internship"],
    ["Global | LATAM", null],
    ["Hourly W2", null],
    ["RDD | Argentina", null],
    ["Working Student", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeEmploymentType(input), expected, input);
  }
  assert.equal(normalizeEmploymentType(null), null);
});

test("annual salary requires a currency and a sane numeric range", () => {
  assert.deepEqual(annualSalary(100000, 150000, "usd"), {
    salaryMin: 100000, salaryMax: 150000, salaryCurrency: "USD",
  });
  assert.deepEqual(annualSalary(null, 150000, "EUR"), {
    salaryMin: null, salaryMax: 150000, salaryCurrency: "EUR",
  });
  const none = { salaryMin: null, salaryMax: null, salaryCurrency: null };
  assert.deepEqual(annualSalary(100000, 150000, null), none);
  assert.deepEqual(annualSalary(100000, 150000, "dollars"), none);
  assert.deepEqual(annualSalary(null, null, "USD"), none);
  assert.deepEqual(annualSalary(200000, 100000, "USD"), none);
  assert.deepEqual(annualSalary("100000", 150000, "USD").salaryMin, null);
  assert.deepEqual(annualSalary(-1, 150000, "USD").salaryMin, null);
});
