import { getActiveJobs } from "@/lib/jobs/get-active-jobs";
import { CATALOG_PAGE_SIZE, formatPostedDate } from "@/lib/jobs/catalog";
export const dynamic = "force-dynamic";

export default async function Home() {
  const { jobs, total } = await getActiveJobs();

  return <main className="shell">
    <header><div><small>PERSONAL WORKSPACE</small><h1>Job Search Engine</h1></div><span>Catalog</span></header>
    <section className="intro"><small>ACTIVE JOBS</small><h2>Recently observed opportunities.</h2>
      <p>Showing up to the {CATALOG_PAGE_SIZE} most recently seen active postings from your local catalog.</p></section>
    {jobs.length === 0 ? <section className="panel"><h2>No active jobs yet</h2><p>Run the ingestion worker to populate the catalog.</p></section> :
      <section className="catalog" aria-label="Active job postings">
        <div className="catalog-heading"><span>{total > jobs.length ? `Showing ${jobs.length} of ${total} active jobs` : `${total} active jobs`}</span><span>Most recently seen first</span></div>
        <div className="table-wrap"><table><thead><tr><th>Role</th><th>Location</th><th>Department</th><th>Posted</th><th>Status</th><th><span className="sr-only">Application</span></th></tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id}>
            <td><strong>{job.title}</strong><span className="company">{job.companyName}</span></td>
            <td>{job.location ?? "Location unavailable"}</td>
            <td>{job.department ?? "—"}</td>
            <td>{formatPostedDate(job.postedAt)}</td>
            <td><span className={job.isActive ? "status active" : "status"}>{job.isActive ? "Active" : "Inactive"}</span></td>
            <td><a href={job.applicationUrl} target="_blank" rel="noreferrer">Apply<span className="sr-only"> for {job.title} at {job.companyName}</span> ↗</a></td>
          </tr>)}</tbody>
        </table></div>
      </section>}
    <footer>Personal job-search project · Local development</footer>
  </main>;
}
