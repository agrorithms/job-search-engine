# Job Scanner --- Project Charter

## Purpose

Job Scanner is a private, personal job-search application focused on
technology roles. It continuously collects public job postings, compares
them with the user's professional profile, and presents relevant
opportunities in a searchable web dashboard.

The product's primary job is to improve the discovery and prioritization
of good, current opportunities. It is not intended to automate job
applications or act as an autonomous job-search agent.

## Product goals

-   Aggregate technology job postings from multiple employers and
    supported applicant-tracking systems (ATSs).
-   Keep postings current by refreshing sources, detecting changes, and
    identifying expired listings.
-   Provide keyword, filtered, and semantic search.
-   Compare jobs with one or more user-managed professional profiles and
    resume versions.
-   Explain why a role appears relevant, including strengths, gaps, and
    uncertain requirements.
-   Provide a private dashboard for discovery, review, and saving jobs.

## Initial scope and planning targets

These are planning targets, not guarantees of source coverage or
throughput.

  -----------------------------------------------------------------------
  Area                                Initial target
  ----------------------------------- -----------------------------------
  Users                               One private user; no public
                                      registration

  Employers                           500--1,000 registered companies as
                                      a longer-term target

  Initial test set                    Approximately 20 employers

  Initial ATS providers               Greenhouse, Lever, Ashby

  Potential job volume                5,000--20,000 active postings,
                                      dependent on coverage

  Refresh cadence                     Every 6--12 hours; initial
                                      configuration discussed as 12 hours

  Search                              Keyword, filters, semantic; hybrid
                                      retrieval

  Matching                            Resume/profile-based AI evaluation

  Interface                           Next.js web dashboard

  Cost                                Minimize recurring API, model, and
                                      hosting costs
  -----------------------------------------------------------------------

## Explicit version-one exclusions

Do not treat the following as requirements for the initial version:

-   LinkedIn or Indeed scraping.
-   Automated job applications.
-   Multiple-user support or public registration.
-   Complex salary prediction.
-   Browser automation.
-   An autonomous agent that applies to jobs.

The first product milestone is reliable job discovery and presentation,
not application automation.

## Product principles

1.  **Current data beats a large but stale catalog.** Reliability and
    freshness are more important than claiming a large employer count.
2.  **Preserve source evidence.** Retain raw ATS payloads so
    normalization can be corrected and historical data reprocessed.
3.  **Do not invent missing facts.** Missing salary, location,
    seniority, or other source fields should remain unknown/null rather
    than being guessed.
4.  **Separate collection from interpretation.** Ingestion and
    profile-based evaluation are independent processes.
5.  **Make AI assessments explainable.** Show supporting qualifications,
    gaps, and uncertainty; do not present a fit score as an interview
    probability.
6.  **Keep the system economical.** Reprocess only changed content and
    send only shortlisted jobs to more expensive model evaluation.
7.  **Build a working vertical slice first.** Prove that one ATS can be
    fetched, normalized, stored, refreshed, and displayed before scaling
    employer coverage.

## Intended user workflow

1.  Register or discover an employer and its public ATS source.
2.  Ingest its current postings.
3.  Normalize and deduplicate postings into canonical job records.
4.  Search and filter the consolidated catalog.
5.  Compare promising jobs against an approved candidate profile.
6.  Review the explanation and original job description.
7.  Save jobs and, in a later phase, track application progress.

## Success criteria for the first useful version

-   A supported ATS source can be configured and polled reliably.
-   Valid postings are normalized and persisted without repeated-run
    duplication.
-   A successful complete poll can identify postings no longer present.
-   A failed or incomplete poll cannot incorrectly expire postings.
-   A basic dashboard can display real stored jobs.
-   Ingestion can run independently of a user opening the dashboard.

## Learning and portfolio value

The project is also intended as a practical backend and data-engineering
learning project. It should create opportunities to work with REST APIs,
TypeScript interfaces, asynchronous processing, SQL and relational
modeling, indexing, hashing, concurrency, background workers, vector
search, structured LLM output, and automated testing.

## Scope discipline

When deciding whether to add a feature, ask whether it improves reliable
discovery, freshness, search, or explainable prioritization. Defer
features that add operational complexity without materially improving
those core outcomes.
