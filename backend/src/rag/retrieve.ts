import { sql } from "drizzle-orm";
import { db, CHUNK_CORPORA } from "@j2w/db";
import type { Citation } from "@j2w/shared-types";
import { embedQuery } from "./embed.js";

export type ChunkCorpus = (typeof CHUNK_CORPORA)[number];

export interface RetrievalOptions {
  sourceIds?: string[];
  // Corpus filter — defaults to general retrieval (jd + company).
  // The question_bank corpus is excluded from default retrieval because
  // those chunks are specifically for technical probes; pass them
  // explicitly when scoring a technical question.
  corpora?: ChunkCorpus[];
  limit?: number;
}

export interface RetrievedChunk extends Citation {
  tokenCount: number | null;
  corpus: ChunkCorpus;
}

const DEFAULT_CORPORA: ChunkCorpus[] = ["jd", "company"];

// Execute a pgvector cosine-distance ANN search via HNSW. We lower ef_search
// from the default 64 to 40 per the plan — >=95% recall at k=6 and ~20% faster.
export async function retrieve(
  query: string,
  opts: RetrievalOptions = {},
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 6;
  const corpora = opts.corpora ?? DEFAULT_CORPORA;
  const vec = await embedQuery(query);
  const vecLiteral = `[${vec.join(",")}]`;

  await db.execute(sql`SET LOCAL hnsw.ef_search = 40`);

  // Build a proper uuid[] literal. Embedding a JS array directly in a `sql`
  // template expands it to a comma-separated record list (→ "cannot cast type
  // record to uuid[]"), so construct the ARRAY[...] explicitly like corpusFilter.
  const sourceFilter =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND c.source_id = ANY(ARRAY[${sql.join(
          opts.sourceIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[])`
      : sql``;

  // Always filter by corpus. Default excludes question_bank to keep
  // general suggestions free of probe-style content.
  const corpusFilter = sql`AND c.corpus = ANY(ARRAY[${sql.join(
    corpora.map((c) => sql`${c}`),
    sql`, `,
  )}]::text[])`;

  const rows = await db.execute<{
    id: number;
    source_id: string;
    source_name: string | null;
    document_id: string;
    document_title: string | null;
    corpus: ChunkCorpus;
    text: string;
    token_count: number | null;
    distance: number;
  }>(sql`
    SELECT
      c.id,
      c.source_id,
      s.name AS source_name,
      c.document_id,
      d.title AS document_title,
      c.corpus,
      c.text,
      c.token_count,
      (c.embedding <=> ${vecLiteral}::vector) AS distance
    FROM chunks c
    JOIN kb_sources s ON s.id = c.source_id
    JOIN documents d ON d.id = c.document_id
    WHERE 1=1 ${corpusFilter} ${sourceFilter}
    ORDER BY c.embedding <=> ${vecLiteral}::vector
    LIMIT ${limit}
  `);

  const data = rows.rows ?? [];
  return data.map((r) => ({
    chunkId: Number(r.id),
    sourceId: r.source_id,
    sourceName: r.source_name ?? undefined,
    documentId: r.document_id,
    documentTitle: r.document_title ?? null,
    corpus: r.corpus,
    snippet: r.text.length > 800 ? r.text.slice(0, 800) + "…" : r.text,
    score: Math.max(0, 1 - r.distance),
    tokenCount: r.token_count,
  }));
}
