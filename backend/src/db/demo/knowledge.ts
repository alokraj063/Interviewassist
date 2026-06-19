// KB sources + documents + chunks. Embeddings are unit-norm fakes (cosine
// distances become noise) — fine for demo, since we don't film cold KB
// search ranking.
import { chunks, db, documents, kbSources } from "@j2w/db";
import { DEMO_ORG_ID } from "./constants.js";
import type { DemoContext } from "./context.js";
import { intBetween, daysAgo, type Rng } from "./rng.js";

const KB_SOURCES: Array<{
  name: string;
  type: "URL" | "Upload" | "Confluence" | "SharePoint";
  documents: Array<{ title: string; corpus: "jd" | "company" | "question_bank"; chunks: string[] }>;
}> = [
  {
    name: "Acme GCC engineering culture",
    type: "URL",
    documents: [
      {
        title: "Engineering values + on-call expectations",
        corpus: "company",
        chunks: [
          "Acme GCC India runs a 4-team platform org with ~180 engineers across Bengaluru, Hyderabad, and Pune. Org structure favours small autonomous teams (6-9 ICs each) with one delivery lead.",
          "On-call rotation is 1 week per 6 weeks for L4+ engineers. Pager goal: < 1 page/week per service. Post-incident reviews are blameless and shared on a public Slack channel within 48 hours.",
          "Performance reviews happen twice a year. Promotion bar emphasizes technical depth, scope, and mentoring contributions. Path to staff is 3-4 years from senior.",
          "Remote work is hybrid: minimum 3 days/week in office for L4-L5 engineers. Remote-only allowed for staff and above with team approval.",
        ],
      },
    ],
  },
  {
    name: "Java + Spring Boot interview prep",
    type: "Upload",
    documents: [
      {
        title: "Senior Java backend question pool",
        corpus: "question_bank",
        chunks: [
          "When discussing JVM concurrency, expect coverage of volatile / synchronized / CAS primitives, ConcurrentHashMap internals, and Java 21 virtual threads vs platform threads.",
          "For Spring Boot, focus on auto-configuration internals, transaction propagation (REQUIRED/REQUIRES_NEW/NESTED), bean lifecycle, and reactive vs traditional MVC tradeoffs.",
          "Distributed system design: at-least-once vs exactly-once semantics in Kafka, idempotent producer + transactional commit pattern, idempotency keys at HTTP layer.",
          "PostgreSQL deep-dive: B-tree vs GIN indexes, EXPLAIN ANALYZE interpretation, covering indexes, partial indexes, transaction isolation levels.",
        ],
      },
    ],
  },
  {
    name: "Hiring SOP",
    type: "Confluence",
    documents: [
      {
        title: "End-to-end recruiter playbook",
        corpus: "company",
        chunks: [
          "Step 1: Demand intake. AM creates the demand with JD + must-have skills. AM probes the client for work mode, interview type, acceptable notice period, and feedback ETA. Probing details are stored as JSONB on the demand row.",
          "Step 2: Sourcing. Recruiters source from internal pool first (matches existing prospects to demands), then external channels (Naukri, LinkedIn). Each prospect goes through a 5-min interest gauge call before promotion.",
          "Step 3: Submission. Once aligned on CTC + notice + location, recruiter promotes prospect to submission. Internal review by delivery lead; if green, submission goes to client_submit stage.",
          "Step 4: Interview rounds. L1 + L2 + (optional) L3 + final_select. Each round has its own row in the interviews table with outcome, feedback, and scheduled_at. Reschedules + no-shows are tracked.",
          "Step 5: Offer. selections row created at final_select. Offer status walks: pending_approval → released → accepted → onboarded.",
        ],
      },
    ],
  },
  {
    name: "Client JD library",
    type: "SharePoint",
    documents: [
      {
        title: "Senior Java Backend — Acme GCC India",
        corpus: "jd",
        chunks: [
          "Senior Java Backend Engineer, Acme GCC India, Bengaluru. 5-9 years exp. Salary band ₹22-38 LPA fixed + variable. VIP demand.",
          "Must have: Java, Spring Boot, microservices. Production exposure to Kafka, AWS preferred.",
          "Responsibilities: Build and maintain tier-0 services. Own production reliability for assigned domain. Mentor 2-3 juniors. Participate in 1-of-6 on-call rotation.",
          "Interview process: L1 technical (concurrency + DB), L2 system design, HR. Total 2-3 weeks.",
        ],
      },
      {
        title: "Senior DevOps Engineer — NovaTech GCC",
        corpus: "jd",
        chunks: [
          "Senior DevOps Engineer at NovaTech Bangalore GCC. 5-9 years exp. ₹24-42 LPA fixed.",
          "Must have: AWS, Kubernetes, Terraform, CI/CD pipelines. Linux deep familiarity.",
          "Drive cluster reliability, deploy automation, and observability for 4-team platform org. ~180 engineers consumers.",
        ],
      },
    ],
  },
];

function fakeEmbedding(seed: number): number[] {
  let s = (seed * 0x9e3779b9) >>> 0;
  const v = new Array<number>(1536);
  let normSq = 0;
  for (let i = 0; i < 1536; i += 1) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const x = r * 2 - 1;
    v[i] = x;
    normSq += x * x;
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < 1536; i += 1) v[i] /= norm;
  return v;
}

function storageSafe(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export async function seedDemoKnowledge(_ctx: DemoContext, rng: Rng): Promise<void> {
  let chunkSeed = 1;

  for (const src of KB_SOURCES) {
    const [srcRow] = await db
      .insert(kbSources)
      .values({
        name: src.name,
        type: src.type,
        status: "indexed",
        orgId: DEMO_ORG_ID,
        lastIndexedAt: daysAgo(intBetween(0, 14, rng)),
      })
      .returning({ id: kbSources.id });

    for (const doc of src.documents) {
      const [docRow] = await db
        .insert(documents)
        .values({
          sourceId: srcRow.id,
          title: doc.title,
          uri: src.type === "URL" ? `https://${storageSafe(src.name)}.demo` : null,
          mime: src.type === "Upload" ? "application/pdf" : "text/html",
          bytes: 12_000 + intBetween(0, 50_000, rng),
          // Random sha256 just satisfies the unique constraint without
          // collisions across re-runs (wipe deletes the row first anyway).
          sha256: `${Date.now().toString(16)}-${Math.floor(rng() * 1_000_000_000).toString(16)}-${doc.title.length}`,
          storageKey: `demo-kb/${storageSafe(doc.title)}`,
          status: "indexed",
        })
        .returning({ id: documents.id });

      const chunkRows = doc.chunks.map((text, ord) => {
        chunkSeed += 1;
        return {
          documentId: docRow.id,
          sourceId: srcRow.id,
          ord,
          text,
          tokenCount: Math.ceil(text.length / 4),
          embedding: fakeEmbedding(chunkSeed),
          corpus: doc.corpus,
        };
      });
      if (chunkRows.length) await db.insert(chunks).values(chunkRows);
    }
  }
}

