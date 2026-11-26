import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "@/ingestion/structured";
import {
  EMPLOYMENT_LABELS,
  WORKPLACE_LABELS,
  formatPostedDate,
  formatSalary,
} from "@/lib/jobs/format";
import {
  POSTED_WITHIN_DAYS,
  SALARY_FILTER_CURRENCY,
  SEARCH_MODES,
  SEARCH_PAGE_SIZE,
  type SearchMode,
  parseJobSearchParams,
  searchHref,
  type SearchParams,
} from "@/lib/jobs/search";
import { getCompanyOptions, searchJobs } from "@/lib/jobs/search-jobs";

export const dynamic = "force-dynamic";

const POSTED_LABELS: Record<(typeof POSTED_WITHIN_DAYS)[number], string> = {
  1: "Past 24 hours",
  7: "Past week",
  30: "Past 30 days",
  90: "Past 90 days",
};

const MODE_LABELS: Record<SearchMode, string> = {
  hybrid: "Hybrid (keywords + meaning)",
  keyword: "Keywords only",
  semantic: "Meaning only",
};

const SORT_LABELS: Record<SearchMode | "recent", string> = {
  recent: "Most recently posted first",
  keyword: "Sorted by keyword relevance",
  semantic: "Sorted by closest meaning",
  hybrid: "Sorted by keyword and meaning (hybrid)",
};

export default async function Home({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = parseJobSearchParams(await searchParams);
  const [{ jobs, total, mode, semanticUnavailable }, companies] = await Promise.all([
    searchJobs(filters),
    getCompanyOptions(),
  ]);
  // Semantic and hybrid rank a capped candidate list rather than counting every match.
  const ranked = mode === "hybrid" || mode === "semantic";

  const pageCount = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (filters.page - 1) * SEARCH_PAGE_SIZE + 1;
  const lastShown = Math.min(total, filters.page * SEARCH_PAGE_SIZE);
  const catalogEmpty = companies.length === 0;

  return <main className="shell">
    <header><div><small>PERSONAL WORKSPACE</small><h1>Job Search Engine</h1></div><span>Search</span></header>

    <form className="search" method="get" role="search" aria-label="Search active jobs">
      <div className="search-row">
        <label className="grow"><span>Search</span>
          <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder="Title, skill, or what you want to work on — e.g. backend python -manager" />
        </label>
        <label><span>Mode</span>
          <select name="mode" defaultValue={filters.mode}>
            {SEARCH_MODES.map((option) => <option key={option} value={option}>{MODE_LABELS[option]}</option>)}
          </select>
        </label>
        <button type="submit">Search</button>
      </div>
      <div className="filters">
        <label><span>Company</span>
          <select name="company" defaultValue={filters.companyId ?? ""}>
            <option value="">All companies</option>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name} ({company.activeJobs})</option>)}
          </select>
        </label>
        <label><span>Location</span>
          <input name="location" defaultValue={filters.location ?? ""} placeholder="e.g. New York" />
        </label>
        <label><span>Workplace</span>
          <select name="workplace" defaultValue={filters.workplaceType ?? ""}>
            <option value="">Any</option>
            {WORKPLACE_TYPES.map((type) => <option key={type} value={type}>{WORKPLACE_LABELS[type]}</option>)}
          </select>
        </label>
        <label><span>Employment</span>
          <select name="type" defaultValue={filters.employmentType ?? ""}>
            <option value="">Any</option>
            {EMPLOYMENT_TYPES.map((type) => <option key={type} value={type}>{EMPLOYMENT_LABELS[type]}</option>)}
          </select>
        </label>
        <label><span>Min salary ({SALARY_FILTER_CURRENCY}/yr)</span>
          <input name="minSalary" type="number" min="0" step="5000" defaultValue={filters.minSalary ?? ""} placeholder="e.g. 150000" />
        </label>
        <label><span>Posted</span>
          <select name="posted" defaultValue={filters.postedWithinDays ?? ""}>
            <option value="">Any time</option>
            {POSTED_WITHIN_DAYS.map((days) => <option key={days} value={days}>{POSTED_LABELS[days]}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">
        Workplace, employment type, and salary come only from structured ATS fields (Ashby and Lever).
        Greenhouse doesn&apos;t publish them, so those filters exclude Greenhouse jobs. Salary filtering
        uses listed annual {SALARY_FILTER_CURRENCY} ranges. <a href="?">Clear filters</a>
      </p>
    </form>

    {semanticUnavailable && <p className="notice" role="status">
      Semantic search unavailable: the embedding model could not be reached, so these are keyword results.
      Start it with <code>docker compose up -d</code>.
    </p>}

    {catalogEmpty ? <section className="panel"><h2>No active jobs yet</h2><p>Run the ingestion worker to populate the catalog.</p></section> :
      <section className="catalog" aria-label="Matching job postings">
        <div className="catalog-heading">
          <span>{total === 0 ? "No matching active jobs" : `${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} ${ranked ? "top-ranked" : "matching"} active jobs`}</span>
          <span>{SORT_LABELS[mode]}</span>
        </div>
        {jobs.length > 0 && <div className="table-wrap"><table><thead><tr><th>Role</th><th>Location</th><th>Type</th><th>Salary</th><th>Posted</th><th><span className="sr-only">Application</span></th></tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id}>
            <td><strong>{job.title}</strong><span className="company">{job.companyName}{job.department ? ` · ${job.department}` : ""}</span></td>
            <td>{job.location ?? "Location unavailable"}{job.workplaceType && <span className="chip">{WORKPLACE_LABELS[job.workplaceType]}</span>}</td>
            <td>{job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : <span className="muted">—</span>}</td>
            <td>{formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency) ?? <span className="muted">Not listed</span>}</td>
            <td>{formatPostedDate(job.postedAt)}</td>
            <td><a href={job.applicationUrl} target="_blank" rel="noreferrer">Apply<span className="sr-only"> for {job.title} at {job.companyName}</span> ↗</a></td>
          </tr>)}</tbody>
        </table></div>}
        {pageCount > 1 && <nav className="pager" aria-label="Pagination">
          {filters.page > 1 ? <a href={searchHref(filters, filters.page - 1)}>← Previous</a> : <span />}
          <span>Page {filters.page} of {pageCount}</span>
          {filters.page < pageCount ? <a href={searchHref(filters, filters.page + 1)}>Next →</a> : <span />}
        </nav>}
      </section>}
    <footer>Personal job-search project · Local development</footer>
  </main>;
}
