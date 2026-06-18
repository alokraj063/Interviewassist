import { eq, sql } from "drizzle-orm";
import { db, documents, chunks as chunksTable, kbSources } from "@j2w/db";
import { blobStore, publishIngestEvent, type IngestJob } from "@j2w/ingest-shared";
import { parseDocument } from "./parse.js";
import { chunkText, estimateTokens } from "./chunk.js";
import { embedBatch, EMBEDDING_DIMS } from "./embed.js";

export async function processIngestJob(job: IngestJob): Promise<{ chunkCount: number }> {
  const { documentId, sourceId, mime, filename, storageKey, userEmail } = job;

  await db.update(documents).set({ status: "parsing" }).where(eq(documents.id, documentId));
  await publishIngestEvent({
    sourceId,
    documentId,
    kind: "document.started",
    at: new Date().toISOString(),
  });

  const content = await blobStore.get(storageKey);
  const parsed = await parseDocument(content, mime, filename);
  if (!parsed.text || parsed.text.length < 20) {
    await markError(documentId, sourceId, "document has no extractable text");
    return { chunkCount: 0 };
  }

  await db.update(documents).set({ status: "embedding" }).where(eq(documents.id, documentId));
  const rawChunks = await chunkText(parsed.text);
  if (rawChunks.length === 0) {
    await markError(documentId, sourceId, "chunker produced no chunks");
    return { chunkCount: 0 };
  }

  // Embed in batches, insert in the same batches to keep the transaction short.
  const BATCH = 64;
  let total = 0;
  for (let i = 0; i < rawChunks.length; i += BATCH) {
    const slice = rawChunks.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((c) => c.text));
    if (vectors.length !== slice.length) {
      throw new Error(`embed count mismatch: ${vectors.length} vs ${slice.length}`);
    }
    if (vectors.some((v) => v.length !== EMBEDDING_DIMS)) {
      throw new Error(`embedding dim mismatch; expected ${EMBEDDING_DIMS}`);
    }
    await db.insert(chunksTable).values(
      slice.map((c, j) => ({
        documentId,
        sourceId,
        ord: c.ord,
        text: c.text,
        tokenCount: estimateTokens(c.text),
        embedding: vectors[j],
      })),
    );
    total += slice.length;
    await publishIngestEvent({
      sourceId,
      documentId,
      kind: "document.progress",
      chunkCount: total,
      totalChunks: rawChunks.length,
      at: new Date().toISOString(),
    });
  }

  await db
    .update(documents)
    .set({ status: "indexed" })
    .where(eq(documents.id, documentId));

  // If every doc in the source is indexed, bump the source status too.
  const pendingResult = await db.execute<{ pending: number }>(sql`
    SELECT COUNT(*)::int AS pending
    FROM documents
    WHERE source_id = ${sourceId} AND status NOT IN ('indexed', 'error')
  `);
  const pending = pendingResult.rows?.[0]?.pending ?? 0;
  if (pending === 0) {
    await db
      .update(kbSources)
      .set({ status: "indexed", lastIndexedAt: new Date() })
      .where(eq(kbSources.id, sourceId));
    await publishIngestEvent({
      sourceId,
      kind: "source.status",
      status: "indexed",
      at: new Date().toISOString(),
    });
  }

  await publishIngestEvent({
    sourceId,
    documentId,
    kind: "document.indexed",
    chunkCount: total,
    at: new Date().toISOString(),
  });

  void userEmail; // reserved for per-user telemetry in a later phase
  return { chunkCount: total };
}

async function markError(documentId: string, sourceId: string, message: string): Promise<void> {
  await db
    .update(documents)
    .set({ status: "error", errorMessage: message })
    .where(eq(documents.id, documentId));
  await publishIngestEvent({
    sourceId,
    documentId,
    kind: "document.error",
    message,
    at: new Date().toISOString(),
  });
}
