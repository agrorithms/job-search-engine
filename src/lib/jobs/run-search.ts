import { EmbeddingError } from "@/lib/embeddings";
import {
  SEARCH_PAGE_SIZE,
  buildJobSearchQuery,
  buildJobsByIdQuery,
  buildKeywordCandidatesQuery,
  buildSemanticCandidatesQuery,
  fuseRankings,
  type JobSearchFilters,
  type JobSearchResult,
  type SearchMode,
} from "./search";

export interface SearchDeps {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  /** Embeds the search text as a query; throws EmbeddingError when the model is unavailable. */
  embedQuery: (text: string) => Promise<number[]>;
  /** The active embedding model; only its vectors are compared. */
  model: string;
}

export interface JobSearchOutcome {
  jobs: JobSearchResult[];
  total: number;
  /** The ranking actually used. "recent" means no text query: filters only, newest first. */
  mode: SearchMode | "recent";
  /** True when semantic or hybrid was asked for but the embedding model could not be reached. */
  semanticUnavailable: boolean;
}

async function keywordSearch(filters: JobSearchFilters, deps: SearchDeps) {
  const query = buildJobSearchQuery(filters);
  const [list, count] = await Promise.all([
    deps.query(query.listSql, query.listParams),
    deps.query(query.countSql, query.countParams),
  ]);
  return { jobs: list.rows as JobSearchResult[], total: (count.rows[0] as { total: number } | undefined)?.total ?? 0 };
}

const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id);

/**
 * Runs a search in the requested mode. Semantic and hybrid return a ranked
 * list of at most HYBRID_CANDIDATES (per mode) that is paginated here. If the
 * query can't be embedded, the search falls back to keyword (decision D10).
 */
export async function runJobSearch(filters: JobSearchFilters, deps: SearchDeps): Promise<JobSearchOutcome> {
  if (!filters.q) return { ...(await keywordSearch(filters, deps)), mode: "recent", semanticUnavailable: false };
  if (filters.mode === "keyword") {
    return { ...(await keywordSearch(filters, deps)), mode: "keyword", semanticUnavailable: false };
  }

  let embedding: number[];
  try {
    embedding = await deps.embedQuery(filters.q);
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error;
    console.warn(`Semantic search unavailable, falling back to keyword: ${error.message}`);
    return { ...(await keywordSearch(filters, deps)), mode: "keyword", semanticUnavailable: true };
  }

  const semanticQuery = buildSemanticCandidatesQuery(filters, embedding, deps.model);
  let ranking: string[];
  if (filters.mode === "semantic") {
    ranking = ids((await deps.query(semanticQuery.sql, semanticQuery.params)).rows);
  } else {
    const keywordQuery = buildKeywordCandidatesQuery(filters);
    const [keyword, semantic] = await Promise.all([
      deps.query(keywordQuery.sql, keywordQuery.params),
      deps.query(semanticQuery.sql, semanticQuery.params),
    ]);
    ranking = fuseRankings([ids(keyword.rows), ids(semantic.rows)]);
  }

  const start = (filters.page - 1) * SEARCH_PAGE_SIZE;
  const pageIds = ranking.slice(start, start + SEARCH_PAGE_SIZE);
  let jobs: JobSearchResult[] = [];
  if (pageIds.length > 0) {
    const byId = buildJobsByIdQuery(pageIds);
    const rows = new Map(
      ((await deps.query(byId.sql, byId.params)).rows as JobSearchResult[]).map((job) => [job.id, job]),
    );
    jobs = pageIds.flatMap((id) => rows.get(id) ?? []);
  }
  return { jobs, total: ranking.length, mode: filters.mode, semanticUnavailable: false };
}
