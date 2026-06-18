// Tenant-config tables: question banks (with questions and demand links),
// and tenant_integrations rows that flip the Settings → Integrations card to
// "Connected" for the demo without exposing real credentials.
import { createHash } from "node:crypto";
import {
  db,
  questionBankDemandLinks,
  questionBankQuestions,
  questionBanks,
  tenantIntegrations,
  type TenantIntegrationProvider,
} from "@j2w/db";
import { encryptSecret, type TenantIntegrationSecret } from "../../integrations/encryption.js";
import { env } from "../../env.js";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import { pickN, type Rng } from "./rng.js";

interface BankSpec {
  name: string;
  description: string;
  skill: string;
  questions: Array<{
    level: "junior" | "mid" | "senior" | "staff";
    difficulty: number;
    prompt: string;
    expectedAnswerHints: string;
    rubric: string[];
  }>;
}

const BANK_SPECS: BankSpec[] = [
  {
    name: "Java + Spring Boot — Senior",
    description: "Standard Java + Spring Boot screening questions, junior to staff.",
    skill: "Java",
    questions: [
      { level: "mid", difficulty: 3, prompt: "What's the difference between @Component, @Service, and @Repository?", expectedAnswerHints: "All are stereotype annotations; @Repository adds exception translation; @Service is semantic.", rubric: ["Mentions all three are bean annotations", "Mentions exception translation for @Repository"] },
      { level: "mid", difficulty: 3, prompt: "How does Spring Boot's auto-configuration work?", expectedAnswerHints: "META-INF/spring.factories, conditional annotations, classpath detection.", rubric: ["Mentions @ConditionalOnClass", "Mentions classpath scanning"] },
      { level: "senior", difficulty: 4, prompt: "Design a service to handle 10K concurrent webhook deliveries with retry.", expectedAnswerHints: "Async queue (Kafka/SQS), idempotency keys, exponential backoff, DLQ.", rubric: ["Mentions queue", "Mentions idempotency", "Mentions backoff + DLQ"] },
      { level: "senior", difficulty: 4, prompt: "Diagnose a sudden Java GC pause causing latency spikes.", expectedAnswerHints: "GC logs, jstat, heap dumps, allocation rate, ZGC/Shenandoah.", rubric: ["Mentions GC logs", "Mentions allocation rate", "Mentions tuning options"] },
      { level: "staff", difficulty: 5, prompt: "Compare optimistic vs pessimistic locking in JPA.", expectedAnswerHints: "Optimistic uses @Version; pessimistic uses select-for-update.", rubric: ["Mentions @Version", "Mentions FOR UPDATE", "Discusses contention"] },
      { level: "junior", difficulty: 2, prompt: "Difference between == and equals() in Java?", expectedAnswerHints: "Reference vs value equality.", rubric: ["Mentions reference vs value", "Mentions Object.equals default"] },
    ],
  },
  {
    name: "React + TypeScript — Frontend",
    description: "React + TypeScript + state management screening questions.",
    skill: "React",
    questions: [
      { level: "junior", difficulty: 2, prompt: "Difference between useState and useReducer?", expectedAnswerHints: "useState for simple values; useReducer for complex state.", rubric: ["Mentions reducer pattern", "Mentions when to choose each"] },
      { level: "mid", difficulty: 3, prompt: "Difference between useEffect and useLayoutEffect?", expectedAnswerHints: "useEffect after paint; useLayoutEffect synchronously before paint.", rubric: ["Mentions paint timing", "Mentions DOM measurement use case"] },
      { level: "senior", difficulty: 4, prompt: "When would you reach for React Server Components, and what tradeoffs?", expectedAnswerHints: "Reduces JS shipped, runs on server with DB access; no useState.", rubric: ["Mentions reduced bundle", "Mentions hook limitations"] },
      { level: "senior", difficulty: 4, prompt: "Structure a large form with cross-field validation.", expectedAnswerHints: "react-hook-form with Zod resolver; controlled vs uncontrolled.", rubric: ["Mentions form library", "Mentions schema validation"] },
      { level: "staff", difficulty: 5, prompt: "Diagnose a memory leak in a long-running React SPA.", expectedAnswerHints: "Heap snapshots, detached DOM, unsubscribed effects.", rubric: ["Mentions devtools", "Mentions cleanup", "Mentions detached nodes"] },
      { level: "mid", difficulty: 3, prompt: "Avoid prop drilling in a deep component tree?", expectedAnswerHints: "Context, state managers, composition.", rubric: ["Mentions Context", "Mentions state library"] },
    ],
  },
  {
    name: "Data Engineering — Mid+",
    description: "SQL + Python + Kafka data engineering questions.",
    skill: "SQL",
    questions: [
      { level: "mid", difficulty: 3, prompt: "Window functions vs GROUP BY — when to use each?", expectedAnswerHints: "Window keeps row granularity; GROUP BY collapses.", rubric: ["Mentions partition", "Mentions row preservation"] },
      { level: "senior", difficulty: 4, prompt: "Design a daily aggregation pipeline for 5B events.", expectedAnswerHints: "Partitioned tables, batch + incremental, idempotent re-runs.", rubric: ["Mentions partitioning", "Mentions idempotency"] },
      { level: "mid", difficulty: 3, prompt: "Kafka consumer rebalance — what triggers it?", expectedAnswerHints: "Member join/leave, partition change, session timeout.", rubric: ["Mentions group membership", "Mentions partition assignment"] },
      { level: "senior", difficulty: 4, prompt: "Backfill a transformation across 6 months of historical data — approach?", expectedAnswerHints: "Idempotent runs, partition replay, validation checks.", rubric: ["Mentions idempotency", "Mentions partitioned replay"] },
      { level: "senior", difficulty: 4, prompt: "Slow-running aggregate query in PostgreSQL — debug steps?", expectedAnswerHints: "EXPLAIN ANALYZE, indexes, partial indexes.", rubric: ["Mentions EXPLAIN ANALYZE", "Mentions index strategy"] },
      { level: "junior", difficulty: 2, prompt: "Why use a materialized view?", expectedAnswerHints: "Cached query result; refresh tradeoff.", rubric: ["Mentions caching", "Mentions refresh"] },
    ],
  },
  {
    name: "DevOps + AWS — Mid+",
    description: "Kubernetes + Terraform + AWS scenario questions.",
    skill: "AWS",
    questions: [
      { level: "mid", difficulty: 3, prompt: "Blue-green vs canary deploys on EKS — tradeoffs?", expectedAnswerHints: "Blue-green: instant cutover, double infra. Canary: gradual, more complex.", rubric: ["Mentions blast radius", "Mentions rollback speed"] },
      { level: "senior", difficulty: 4, prompt: "Cluster-wide CPU spike on EKS — investigation steps?", expectedAnswerHints: "Node-level top, pod metrics, HPA, NoisyNeighbour, kernel-level perf.", rubric: ["Mentions pod metrics", "Mentions node-level investigation"] },
      { level: "mid", difficulty: 3, prompt: "Terraform state file lost — recovery?", expectedAnswerHints: "Re-import resources, regenerate state, then back up to S3 with locking.", rubric: ["Mentions terraform import", "Mentions remote state"] },
      { level: "senior", difficulty: 4, prompt: "Zero-downtime DB migration — approach?", expectedAnswerHints: "Backwards-compatible schema, dual-write, then read switch, then column drop.", rubric: ["Mentions backwards compatibility", "Mentions dual-write"] },
      { level: "senior", difficulty: 4, prompt: "Production incident comms — what's your protocol?", expectedAnswerHints: "Status page first, comms cadence, blameless postmortem.", rubric: ["Mentions status page", "Mentions postmortem"] },
      { level: "staff", difficulty: 5, prompt: "Multi-region active-active for a stateful service?", expectedAnswerHints: "Conflict resolution, region affinity, eventual consistency.", rubric: ["Mentions consistency tradeoffs", "Mentions region affinity"] },
    ],
  },
];

const PROVIDER_STUBS: Record<TenantIntegrationProvider, TenantIntegrationSecret> = {
  vapi: { provider: "vapi", apiKey: "demo-stub-not-real-do-not-call", publicKey: "demo-stub-public", webhookSecret: "demo-stub-webhook" },
  deepgram: { provider: "deepgram", apiKey: "demo-stub-not-real-do-not-call" },
  sarvam: { provider: "sarvam", apiSubscriptionKey: "demo-stub-not-real-do-not-call" },
  shunya: { provider: "shunya", apiKey: "demo-stub-not-real-do-not-call" },
  rekognition: { provider: "rekognition", accessKeyId: "demo-stub-not-real-do-not-call", secretAccessKey: "demo-stub-not-real-do-not-call", region: "ap-south-1" },
};

export async function seedDemoConfig(ctx: DemoContext, rng: Rng): Promise<void> {
  // Question banks.
  const bankRows = await db
    .insert(questionBanks)
    .values(
      BANK_SPECS.slice(0, VOLUMES.questionBanks).map((b) => ({
        orgId: DEMO_ORG_ID,
        name: b.name,
        description: b.description,
        createdByUserId: ctx.adminUserId,
      })),
    )
    .returning({ id: questionBanks.id, name: questionBanks.name });
  for (const r of bankRows) ctx.questionBankIdByName.set(r.name, r.id);

  const questionRows = [] as Array<typeof questionBankQuestions.$inferInsert>;
  for (const bank of BANK_SPECS.slice(0, VOLUMES.questionBanks)) {
    const bankId = ctx.questionBankIdByName.get(bank.name);
    if (!bankId) continue;
    const skillId = ctx.skillIdByName.get(bank.skill.toLowerCase()) ?? null;
    for (const q of bank.questions) {
      questionRows.push({
        bankId,
        orgId: DEMO_ORG_ID,
        contentHash: createHash("sha256").update(q.prompt.trim().toLowerCase()).digest("hex"),
        skillId,
        level: q.level,
        difficulty: q.difficulty,
        prompt: q.prompt,
        expectedAnswerHints: q.expectedAnswerHints,
        evaluationRubric: q.rubric,
        followUpQuestions: [],
        commonMistakes: [],
      });
    }
  }
  if (questionRows.length) await db.insert(questionBankQuestions).values(questionRows);

  // Question-bank → demand links: link each bank to ~2 demands.
  const linkRows: Array<{ bankId: string; demandId: string }> = [];
  for (const r of bankRows) {
    const linkedDemands = pickN(ctx.demandIds, 2, rng);
    for (const d of linkedDemands) linkRows.push({ bankId: r.id, demandId: d });
  }
  if (linkRows.length) await db.insert(questionBankDemandLinks).values(linkRows).onConflictDoNothing();

  // tenant_integrations: insert all 4 providers as "connected". If
  // INTEGRATIONS_KEK isn't set, fall back to enabled=false rows with a
  // sentinel ciphertext — the resolver short-circuits and the UI still
  // renders the row, just without claiming the provider is active.
  const kekPresent = Boolean(env.INTEGRATIONS_KEK);
  const integrationRows = (Object.keys(PROVIDER_STUBS) as TenantIntegrationProvider[]).map((provider) => {
    if (kekPresent) {
      return {
        orgId: DEMO_ORG_ID,
        provider,
        ciphertext: encryptSecret(PROVIDER_STUBS[provider]),
        enabled: true,
        createdBy: ctx.adminUserId,
      };
    }
    return {
      orgId: DEMO_ORG_ID,
      provider,
      ciphertext: Buffer.from("demo-stub-no-kek-set"),
      enabled: false,
      createdBy: ctx.adminUserId,
    };
  });
  await db.insert(tenantIntegrations).values(integrationRows).onConflictDoNothing();
}
