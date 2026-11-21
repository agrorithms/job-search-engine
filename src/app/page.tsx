import { pool } from "@/lib/db/pool";
export const dynamic = "force-dynamic";
async function stats() {
  try {
    const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE is_active) active_jobs,
      COUNT(*) FILTER (WHERE is_active AND first_seen_at > NOW()-INTERVAL '7 days') new_this_week,
      COUNT(DISTINCT company_id) FILTER (WHERE is_active) companies FROM job_postings`);
    return r.rows[0];
  } catch { return null; }
}
export default async function Home() {
  const s = await stats();
  return <main className="shell">
    <header><div><small>PERSONAL WORKSPACE</small><h1>Job Search Engine</h1></div><span>MVP scaffold</span></header>
    <section className="intro"><small>OVERVIEW</small><h2>Your job search, in one place.</h2>
      <p>This first version establishes the database, ingestion pipeline, and dashboard shell. Matching and profile management come next.</p></section>
    <section className="metrics">
      <Metric label="Active jobs" value={s?.active_jobs ?? "—"}/>
      <Metric label="New this week" value={s?.new_this_week ?? "—"}/>
      <Metric label="Companies" value={s?.companies ?? "—"}/>
    </section>
    <section className="panel"><small>NEXT BUILD STEP</small><h2>Connect your first employer</h2>
      <p>Add a Greenhouse board token to <code>.env.local</code>, then run:</p><pre>npm run ingest:greenhouse</pre></section>
    <footer>Personal job-search project · Local development</footer>
  </main>;
}
function Metric({label,value}:{label:string;value:string}) {
  return <article><p>{label}</p><strong>{value}</strong></article>;
}
