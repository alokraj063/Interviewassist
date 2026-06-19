// One-shot import: pull the 3 HP knowledge-base PDFs out of the Vapi-owned
// file store and register them as local kb_sources + documents, then wire
// the HP Support - Anika agent in each org to reference them.
//
// Run with: pnpm --filter @j2w/api db:import-hp-kb
//
// Why: the original Anika assistant in Vapi was configured with three
// knowledgeBases (hp_computers / hp_printers / hp_software) sitting in a
// single `knowledge_query` query-tool. We want those files living under our
// own KB UI so (a) the co-pilot and QA paths can retrieve them locally,
// (b) new agents can re-use them, and (c) when Anika deploys, our kbSync
// uploader sees they already have vapi_file_id set and skips re-uploading.
import "../env.js";
import { and, eq } from "drizzle-orm";
import { DEFAULT_ORG_ID, db, documents, kbSources, organizations, voiceAgents } from "@j2w/db";
import { blobStore, getIngestQueue, type IngestJob } from "@j2w/ingest-shared";

interface HpKbMapping {
  sourceName: string;           // displayed in the KB UI
  docTitle: string;             // displayed under the source
  vapiFileId: string;           // existing id on Vapi's side — we reuse it
}

// These match the three `knowledgeBases[]` entries on the Anika tool in Vapi.
// The fourth file in the org (HP_Product_Troubleshooting_Guide.pdf) isn't
// referenced by any knowledge base there, so we skip it.
const MAPPINGS: HpKbMapping[] = [
  {
    sourceName: "HP Computers",
    docTitle: "HP Computer & Laptop Guide",
    vapiFileId: "d03f9238-1cd8-4751-b950-b7d3ed3602a2",
  },
  {
    sourceName: "HP Printers",
    docTitle: "HP Printer Troubleshooting Guide",
    vapiFileId: "27a92f95-9c55-40de-8f15-ce138f989bcf",
  },
  {
    sourceName: "HP Software",
    docTitle: "HP Software & Drivers Guide",
    vapiFileId: "42edf8e3-bc6c-43f0-86fb-056c347fe882",
  },
];

function vapiKey(): string {
  const k = process.env.VAPI_API_KEY;
  if (!k) throw new Error("VAPI_API_KEY is not set");
  return k;
}
function vapiBase(): string {
  return process.env.VAPI_API_BASE ?? "https://api.vapi.ai";
}

interface VapiFileRecord {
  id: string;
  name: string;
  mimetype?: string;
  url: string;
  bytes?: number;
}

async function fetchVapiFileMeta(fileId: string): Promise<VapiFileRecord> {
  const r = await fetch(`${vapiBase()}/file/${fileId}`, {
    headers: { Authorization: `Bearer ${vapiKey()}` },
  });
  if (!r.ok) throw new Error(`GET /file/${fileId} failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as VapiFileRecord;
}

async function downloadFile(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

interface ImportedForOrg {
  orgId: string;
  sourceIds: string[]; // parallel to MAPPINGS
  enqueuedDocs: Array<{ documentId: string; sourceId: string; filename: string; mime: string; storageKey: string }>;
}

async function importForOrg(
  orgId: string,
  downloads: Array<{ meta: VapiFileRecord; buf: Buffer; storageKey: string }>,
): Promise<ImportedForOrg> {
  const out: ImportedForOrg = { orgId, sourceIds: [], enqueuedDocs: [] };

  for (let i = 0; i < MAPPINGS.length; i++) {
    const m = MAPPINGS[i];
    const dl = downloads[i];

    // Upsert kb_source by (orgId, name). We don't have a unique index on
    // (orgId, name) so check-then-insert.
    const [existingSource] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.orgId, orgId), eq(kbSources.name, m.sourceName)));
    let sourceId: string;
    if (existingSource) {
      sourceId = existingSource.id;
    } else {
      const [created] = await db
        .insert(kbSources)
        .values({
          orgId,
          name: m.sourceName,
          type: "Upload",
          status: "indexing",
        })
        .returning({ id: kbSources.id });
      sourceId = created.id;
    }
    out.sourceIds.push(sourceId);

    // Upsert the document under the source — keyed by (sourceId, vapiFileId)
    // so re-running the import doesn't duplicate.
    const [existingDoc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.sourceId, sourceId), eq(documents.vapiFileId, m.vapiFileId)));

    if (existingDoc) {
      console.log(`[import] doc already present for source=${m.sourceName} in org=${orgId}, skipping`);
      continue;
    }

    // Insert document with sha256=NULL. The column has a UNIQUE constraint
    // across the whole table (not scoped by org/source), so imports into a
    // second org would otherwise collide. NULLs are exempt from the unique
    // check in Postgres, which is the right escape hatch here.
    const mime = dl.meta.mimetype ?? "application/pdf";
    const [inserted] = await db
      .insert(documents)
      .values({
        sourceId,
        title: m.docTitle,
        uri: dl.meta.url,
        mime,
        bytes: dl.buf.byteLength,
        sha256: null,
        storageKey: dl.storageKey,
        status: "pending",
        vapiFileId: m.vapiFileId,
      })
      .returning({ id: documents.id });

    out.enqueuedDocs.push({
      documentId: inserted.id,
      sourceId,
      filename: m.docTitle,
      mime,
      storageKey: dl.storageKey,
    });
    console.log(`[import] inserted doc ${inserted.id} "${m.docTitle}" under ${m.sourceName} in org=${orgId}`);
  }

  return out;
}

async function wireAnika(orgId: string, sourceIds: string[]): Promise<void> {
  const [anika] = await db
    .select()
    .from(voiceAgents)
    .where(and(eq(voiceAgents.orgId, orgId), eq(voiceAgents.name, "HP Support - Anika")));
  if (!anika) {
    console.log(`[import] no Anika agent in org=${orgId} (run db:seed-agents first) — skipping wire`);
    return;
  }
  await db
    .update(voiceAgents)
    .set({ knowledgeSourceIds: sourceIds, updatedAt: new Date() })
    .where(eq(voiceAgents.id, anika.id));
  console.log(`[import] wired Anika in org=${orgId} -> ${sourceIds.length} sources`);
}

async function main() {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const orgIds = orgs.length ? orgs.map((o) => o.id) : [DEFAULT_ORG_ID];

  // Download each file once, upfront, and put into the blob store. The blob
  // store is content-addressed (sha256), so all org-scoped documents end up
  // pointing at the same single physical blob.
  console.log(`[import] fetching ${MAPPINGS.length} files from Vapi...`);
  const downloads: Array<{ meta: VapiFileRecord; buf: Buffer; storageKey: string }> = [];
  for (const m of MAPPINGS) {
    const meta = await fetchVapiFileMeta(m.vapiFileId);
    const buf = await downloadFile(meta.url);
    const put = await blobStore.put(buf);
    downloads.push({ meta, buf, storageKey: put.key });
    console.log(`[import]   ✓ ${meta.name} (${buf.byteLength}B) -> ${put.key}`);
  }

  // For each org: create sources, register docs, enqueue ingest, wire Anika.
  const queue = getIngestQueue();
  for (const orgId of orgIds) {
    const result = await importForOrg(orgId, downloads);
    for (const d of result.enqueuedDocs) {
      const job: IngestJob = {
        documentId: d.documentId,
        sourceId: d.sourceId,
        mime: d.mime,
        filename: d.filename,
        storageKey: d.storageKey,
        // No user email context — this is a one-shot server-side import.
        userEmail: "system@j2w.internal",
      };
      await queue.add("ingest", job, { jobId: d.documentId });
    }
    await wireAnika(orgId, result.sourceIds);
  }

  console.log("[import] done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
