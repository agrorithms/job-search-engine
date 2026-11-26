/**
 * Maps provider-supplied structured fields onto the canonical vocabulary.
 * Only explicit provider fields are mapped; nothing is inferred from
 * description text. Anything unrecognised becomes null (unknown).
 */

export const WORKPLACE_TYPES = ["remote", "hybrid", "onsite"] as const;
export type WorkplaceType = (typeof WORKPLACE_TYPES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export interface AnnualSalary {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}

export const NO_SALARY: AnnualSalary = { salaryMin: null, salaryMax: null, salaryCurrency: null };

/** Ashby: "Remote" | "Hybrid" | "OnSite". Lever: "remote" | "hybrid" | "onsite" | "unspecified". */
export function normalizeWorkplaceType(value: unknown): WorkplaceType | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z]/g, "");
  if (key === "remote") return "remote";
  if (key === "hybrid") return "hybrid";
  if (key === "onsite" || key === "inoffice" || key === "office") return "onsite";
  return null;
}

/**
 * Ashby sends an enum (FullTime, PartTime, Intern, Contract, Temporary).
 * Lever's `categories.commitment` is free text set by each employer
 * ("Full Time_CLO", "Contract | Hybrid", "Global | LATAM"), so only clear
 * employment-type words are recognised; the rest stay unknown.
 */
export function normalizeEmploymentType(value: unknown): EmploymentType | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (/\bintern(ship)?\b/.test(text)) return "internship";
  if (/\bpart ?time\b/.test(text)) return "part_time";
  if (/\b(full ?time|permanent)\b/.test(text)) return "full_time";
  if (/\bcontract(or)?\b/.test(text)) return "contract";
  if (/\b(temporary|temp)\b/.test(text)) return "temporary";
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Builds an annual salary range. Callers pass only ranges the provider marks
 * as annual; hourly/monthly figures stay in the raw payload so salary filters
 * never compare different pay periods.
 */
export function annualSalary(min: unknown, max: unknown, currency: unknown): AnnualSalary {
  const salaryMin = finiteNumber(min);
  const salaryMax = finiteNumber(max);
  const salaryCurrency =
    typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim())
      ? currency.trim().toUpperCase()
      : null;

  if ((salaryMin === null && salaryMax === null) || salaryCurrency === null) return NO_SALARY;
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) return NO_SALARY;
  return { salaryMin, salaryMax, salaryCurrency };
}
