# Job Scanner --- Matching, Search, Dashboard, and Roadmap

## Matching objective

The matching system should rank and explain how well a job aligns with a
candidate's actual professional background and preferences. It should
not simply reward keyword overlap or overstate fit based on adjacent
experience.

The match score is a prioritization aid, not a probability of receiving
an interview.

## Profile extraction

Parse resume documents into structured profile information, potentially
including:

-   Target roles.
-   Skills and evidence of proficiency.
-   Work experience, responsibilities, and projects.
-   Education.
-   Years of experience where supported.
-   Desired seniority.
-   Preferred locations and work arrangements.
-   Minimum compensation.
-   Hard requirements and preferences.

The extracted profile must be reviewed and approved by the user before
being used for matching. Preserve multiple resume versions and profile
versions so that changes can be compared.

Do not treat an illustrative profile or a model-inferred skill as an
established fact. Distinguish skills explicitly demonstrated in source
material from related or inferred experience.

## Embeddings

Generate embeddings for relevant profile components and job
descriptions, such as:

-   Professional summary.
-   Technical skills.
-   Work experience.
-   Individual projects.
-   Target role descriptions.
-   Job descriptions.

Track the embedding model and the content hash used to generate each
vector. Regenerate only when relevant content or the embedding model
changes.

Multiple profiles are preferable to one broad profile when the user is
pursuing distinct role families. The original design used these as
examples:

-   **Backend engineering:** Python, TypeScript, APIs, databases, data
    structures.
-   **Data engineering:** SQL, ETL, pipelines, data modeling, Python.
-   **Technical operations:** automation, platform ownership, analytics,
    technical program management.

These are examples of profile segmentation, not fixed requirements.

## Hybrid retrieval

Combine keyword search and semantic search.

-   Keyword retrieval finds explicit terms and technologies.
-   Semantic retrieval finds conceptually similar responsibilities even
    when the exact wording differs.
-   Combine rankings using Reciprocal Rank Fusion (RRF), rather than
    naively adding scores that may have incompatible scales.

Apply hard filters before expensive AI evaluation: - Active status. -
Location. - Employment type. - Seniority. - Other reliably extracted
required qualifications.

Allow users to switch between keyword, semantic, and hybrid search
modes.

## LLM evaluation

Use retrieval to create a shortlist, then evaluate only the most
relevant candidates. The original planning target was the top 20--50
jobs, with the initial configuration specifying the top 30.

Require structured output. A conceptual result:

``` json
{
  "verdict": "strong_match",
  "fit_score": 82,
  "strengths": [
    "Relevant workflow automation experience",
    "Experience with technical platform ownership"
  ],
  "gaps": [
    "Limited demonstrated production backend experience"
  ],
  "qualification_assessment": {
    "technical_skills": "partial",
    "experience": "strong",
    "seniority": "appropriate",
    "education": "meets"
  },
  "recommendation": "Worth applying"
}
```

The evaluator must distinguish: - Explicit job requirements. - Preferred
qualifications. - Skills demonstrated in the resume. - Skills inferred
from related experience. - Requirements that cannot be assessed from
available information.

Do not let the model silently convert an unknown into a positive or
negative assessment. Retain reasoning and missing requirements so the
user can inspect the basis for a verdict.

## Dashboard screens

### 1. Job discovery dashboard

The home screen should show: - New jobs since last visit. - Strong
matches. - Jobs awaiting AI evaluation. - Saved jobs. - Recently expired
jobs.

Each job summary should include title, employer, location, posting date,
match score, and evaluation status where available.

### 2. Search and filtering

Support: - Job title and keywords. - Company. - Location. - Remote,
hybrid, or onsite. - Seniority. - Salary. - Employment type. - Posting
date. - Minimum match score. - Keyword, semantic, or hybrid search mode.

### 3. Job detail and AI assessment

Show: 1. Original job description. 2. Company and application link. 3.
Overall match assessment. 4. Qualifications the candidate satisfies. 5.
Qualifications partially satisfied. 6. Missing qualifications. 7.
Recommendation. 8. User notes.

The original posting and source evidence should remain accessible; the
AI summary must not replace the job description.

### 4. Resume and profile management

Allow resume upload, extraction review, profile editing, multiple resume
versions, and job preference management.

### 5. Application tracker

Build after ingestion and matching are reliable. Intended statuses: -
Interested. - Saved. - Applied. - Interviewing. - Rejected. - Offer. -
Withdrawn.

Track application date, notes, and follow-ups as the feature matures.

## Cost and performance controls

The two primary variable model costs are embedding generation and LLM
evaluation.

-   Embed only new or changed job descriptions.
-   Re-evaluate only when job content or the relevant profile version
    changes.
-   Use keyword/vector retrieval and hard filters before LLM evaluation.
-   Evaluate a shortlist rather than the entire job catalog.
-   Cache results using job content and profile version identifiers.
-   Defer Redis + BullMQ until scheduling, retries, or concurrency needs
    justify it.

## Development roadmap

The original planning estimate was approximately 31--51 hours for the
MVP, excluding extensive employer discovery, Workday integration,
deployment hardening, and large-scale data cleanup. This is an estimate,
not a deadline.

  -----------------------------------------------------------------------
  Phase                   Work                    Deliverable
  ----------------------- ----------------------- -----------------------
  1\. Foundation          Next.js, TypeScript,    Running application and
                          database, migrations,   database
                          basic layout,           
                          environment config,     
                          logging                 

  2\. First ATS           Greenhouse connector,   Real jobs persisted
                          test employers,         
                          validation,             
                          normalization, upserts, 
                          errors/retries          

  3\. Multi-source        Lever, Ashby, source    Consolidated job
  ingestion               registry,               catalog
                          deduplication,          
                          ingestion history,      
                          expiration              

  4\. Search              Keyword search,         Searchable catalog
                          filters, embeddings,    
                          semantic retrieval,     
                          ranking fusion          

  5\. Resume and matching Resume parsing,         Jobs ranked against
                          approved profile, AI    profile
                          evaluation,             
                          explanations, caching   

  6\. Dashboard and       Search UI, job detail,  Usable personal
  automation              saved jobs, scheduled   application
                          ingestion,              
                          notifications,          
                          monitoring              
  -----------------------------------------------------------------------

## Immediate implementation priority

Build a small vertical slice before scaling the employer list:

1.  Maintain the working Greenhouse connector.
2.  Confirm the shared types and connector contract.
3.  Refactor toward a provider registry and shared ingestion entry
    point.
4.  Register a small test set of employers, initially around 20 across
    providers.
5.  Fetch, validate, normalize, store, and deduplicate real Greenhouse
    jobs.
6.  Add fixtures and tests for repeat ingestion and failure cases.
7.  Display approximately 100--200 real postings in a basic Next.js
    table.

Do not prioritize a polished dashboard before dependable data is flowing
into the database.

## Engineering and learning priorities

The project should develop practical skills through implementation:

  Concept                         Where it is used
  ------------------------------- ---------------------------------------
  REST APIs                       ATS integrations
  TypeScript interfaces           Connector and normalization contracts
  Async/await                     Ingestion and concurrency
  SQL and relational modeling     Persistence
  Indexing                        Job search
  Hashing                         Change detection
  Queues and concurrency          Background processing
  Vector search                   Semantic retrieval
  Structured LLM output           Job evaluation
  Authentication/access control   Private dashboard
  Testing                         Connector and pipeline reliability

## Deferred decisions

Do not prematurely commit to: - Workday integration. - Cloud
deployment. - Redis/BullMQ. - Notifications. - Application tracking. -
Advanced employer discovery. - Sophisticated salary prediction.

Introduce these when the working system demonstrates a concrete need.
