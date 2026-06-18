// Sync an agent's selected knowledge sources into ONE Vapi query tool — the
// canonical Vapi pattern is a single `knowledge_query` tool with N
// `knowledgeBases` entries the LLM routes across via a `knowledge_base`
// parameter. On deploy:
//
//   1. For each doc in the selected sources, ensure it's been uploaded to
//      Vapi's /file store (we track the resulting file id on the document row).
//   2. Build one `knowledgeBases` entry per source, each with its own fileIds.
//   3. Upsert a single tool per agent holding all entries. The tool id is
//      stored on the agent row (`vapiKbToolId`) and attached to the assistant
//      via `model.toolIds[]`.
//
// Why one tool per agent instead of one tool per source:
// - Matches the shape Vapi's dashboard generates.
// - Lets the system prompt say "call knowledge_query" once instead of
//   teaching the LLM about N separate tool names.
// - When only one source is selected, the tool has a simpler parameter
//   schema (no `knowledge_base` enum) so the LLM doesn't see needless
//   categorization in the simple case.
//
// We keep the local pgvector store populated in parallel for the live-assist
// co-pilot + QA resolution checks (which need citations + cheap offline
// retrieval). Voice-agent call-time retrieval goes through Vapi/Google.
import { eq, inArray } from "drizzle-orm";
import { db, documents, kbSources } from "@j2w/db";
import { blobStore } from "@j2w/ingest-shared";
import { createTool, deleteTool, uploadFile, updateTool } from "./client.js";

export interface SyncAgentKbResult {
  toolId: string | null;
  knowledgeBaseSlugs: string[];
}

export async function syncAgentKbToVapi(
  sourceIds: string[],
  existingToolId: string | null,
): Promise<SyncAgentKbResult> {
  // No sources selected — tear down any previous tool so the assistant stops
  // advertising KB retrieval the caller can't satisfy.
  if (sourceIds.length === 0) {
    if (existingToolId) {
      try {
        await deleteTool(existingToolId);
      } catch {
        // swallow — next deploy will re-attempt if still present
      }
    }
    return { toolId: null, knowledgeBaseSlugs: [] };
  }

  const sources = await db
    .select()
    .from(kbSources)
    .where(inArray(kbSources.id, sourceIds));
  if (sources.length === 0) return { toolId: null, knowledgeBaseSlugs: [] };

  const docs = await db
    .select()
    .from(documents)
    .where(inArray(documents.sourceId, sourceIds));

  // Upload any doc that doesn't yet have a Vapi file id. Only upload docs
  // that have finished local ingestion — pending/parsing docs aren't ready
  // to be served back by retrieval yet.
  for (const doc of docs) {
    if (doc.vapiFileId) continue;
    if (doc.status !== "indexed") continue;
    try {
      const buf = await blobStore.get(doc.storageKey);
      const uploaded = await uploadFile(
        buf,
        doc.title ?? doc.id,
        doc.mime ?? "application/octet-stream",
      );
      await db
        .update(documents)
        .set({ vapiFileId: uploaded.id })
        .where(eq(documents.id, doc.id));
      doc.vapiFileId = uploaded.id;
    } catch (err) {
       
      console.warn(`vapi file upload failed for doc ${doc.id}: ${(err as Error).message}`);
    }
  }

  // One `knowledgeBases` entry per source. Empty sources (no indexed+uploaded
  // docs) are skipped so we don't ship dead routes to the LLM.
  interface KnowledgeBaseEntry {
    provider: "google";
    model: string;
    name: string;
    description: string;
    fileIds: string[];
  }
  const knowledgeBases: KnowledgeBaseEntry[] = [];
  for (const source of sources) {
    const fileIds = docs
      .filter((d) => d.sourceId === source.id && d.vapiFileId)
      .map((d) => d.vapiFileId!);
    if (fileIds.length === 0) continue;
    const name = kbSlug(source.name, source.id);
    knowledgeBases.push({
      provider: "google",
      // Gemini 2.0 Flash is Vapi's current default for query-tool retrieval.
      model: "gemini-2.0-flash",
      name,
      description: `Knowledge base "${source.name}". Use this when the caller's question is about ${source.name}.`,
      fileIds,
    });
  }

  if (knowledgeBases.length === 0) {
    if (existingToolId) {
      try {
        await deleteTool(existingToolId);
      } catch {
        // ignore
      }
    }
    return { toolId: null, knowledgeBaseSlugs: [] };
  }

  // Collapse to a simple `{ query }` schema when there's only one KB — the
  // LLM doesn't need a routing param it can't meaningfully choose between.
  const singular = knowledgeBases.length === 1;
  const parameters = singular
    ? {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The question or keywords to search for.",
          },
        },
        required: ["query"],
      }
    : {
        type: "object",
        properties: {
          knowledge_base: {
            type: "string",
            enum: knowledgeBases.map((kb) => kb.name),
            description: "Which knowledge base best matches the caller's question.",
          },
          query: {
            type: "string",
            description: "The question or keywords to search for.",
          },
        },
        required: ["knowledge_base", "query"],
      };

  const toolPayload: Record<string, unknown> = {
    type: "query",
    function: {
      name: "knowledge_query",
      description: singular
        ? "Search the knowledge base. Call this before answering factual or troubleshooting questions to ground your answer in the documents."
        : `Search across ${knowledgeBases.length} knowledge bases. Pick the one that best matches the caller's question, then pass the query. Always call this before answering factual or troubleshooting questions.`,
      parameters,
    },
    knowledgeBases,
    // Short "I'll check that" line while retrieval runs — matches how Vapi's
    // dashboard-generated tools are configured.
    messages: [
      { type: "request-start", blocking: false, content: "Let me check that for you..." },
    ],
  };

  try {
    let toolId = existingToolId;
    if (toolId) {
      await updateTool(toolId, toolPayload);
    } else {
      const tool = await createTool(toolPayload);
      toolId = tool.id;
    }
    return { toolId, knowledgeBaseSlugs: knowledgeBases.map((kb) => kb.name) };
  } catch (err) {
     
    console.warn(`vapi tool upsert failed: ${(err as Error).message}`);
    return { toolId: existingToolId, knowledgeBaseSlugs: knowledgeBases.map((kb) => kb.name) };
  }
}

// Slugify so Vapi (and the LLM) see stable tool-name-safe identifiers.
function kbSlug(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || `kb_${id.slice(0, 8)}`;
}

// Best-effort cleanup when a source is deleted locally. Call when a KB source
// is removed so orphaned Vapi files don't accumulate. Tool cleanup is handled
// by the per-agent sync on next deploy.
export async function deleteVapiFilesForSource(sourceId: string): Promise<void> {
  const docs = await db
    .select({ id: documents.id, vapiFileId: documents.vapiFileId })
    .from(documents)
    .where(eq(documents.sourceId, sourceId));
  const { deleteFile } = await import("./client.js");
  for (const d of docs) {
    if (!d.vapiFileId) continue;
    try {
      await deleteFile(d.vapiFileId);
    } catch {
      // local delete wins
    }
  }
}
