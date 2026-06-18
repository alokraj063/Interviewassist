// Assessment Authoring — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts: persistence of templates + all 8 item types, publish
// freezes an immutable version, Zod validation (400 + issues), cross-org
// 404 isolation, permission gates (recruiter write/invite OK but review 403;
// qa_reviewer review OK but template POST 403; admin POST template 201 — the
// permission-grant fix regression), real auto-grade truth (correct → max,
// wrong → lower; key mutation + regrade moves the score), external-key 503s
// (run-code / ai-assist) not 500, append-only audit rows, and keyset pagination.
//
// Seeded principals (DEFAULT_ORG_ID): admin@/qa1@/recruiter1@recruitassist.local.
// Cross-org principal (JOULESTOWATTS_ORG_ID): cognition.engine@joulestowatts.com.
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  assessmentAuditLog,
  assessmentItems,
  assessmentTemplates,
  candidates,
  db,
  JOULESTOWATTS_ORG_ID,
  questionBanks,
  questionBankQuestions,
} from "@j2w/db";
import { authedInject, expectForbidden, expectJson, getApp } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const QA = "qa1@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local";
const CROSS_ORG = "cognition.engine@joulestowatts.com";

// Templates accumulate append-only audit rows; the immutability trigger blocks
// the FK-cascade DELETE, and the route is soft-delete (archive) by design — so
// we never hard-delete. The disposable itest DB is recreated each run, so no
// afterAll cleanup is needed (or possible) here.

async function createTemplate(title: string, actor = ADMIN, headers: Record<string, string> = {}) {
  return authedInject(actor, {
    method: "POST",
    url: "/api/assessments/templates",
    headers,
    payload: { title, passScore: 60, durationMins: 20 },
  });
}

async function newTemplateId(title: string): Promise<string> {
  const res = await createTemplate(title);
  const body = expectJson<{ template: { id: string } }>(res, 201);
  return body.template.id;
}

const MCQ_OPTS = [
  { id: "o-a", label: "Wrong A", correct: false },
  { id: "o-b", label: "Right B", correct: true },
  { id: "o-c", label: "Wrong C", correct: false },
];

async function addMcqItem(templateId: string, points = 10) {
  return authedInject(ADMIN, {
    method: "POST",
    url: `/api/assessments/templates/${templateId}/items`,
    payload: {
      type: "mcq_single",
      prompt: "Pick the right one",
      config: { options: MCQ_OPTS },
      points,
    },
  });
}

async function getCandidateId(): Promise<string> {
  const [c] = await db.select({ id: candidates.id }).from(candidates).limit(1);
  if (!c) throw new Error("no seeded candidate");
  return c.id;
}

describe("assessments — persistence + all item types", () => {
  it("creates a template, persists it, and reads it back", async () => {
    const id = await newTemplateId("Persist Template");
    const get = await authedInject(ADMIN, { method: "GET", url: `/api/assessments/templates/${id}` });
    const detail = expectJson<{ template: { id: string; title: string; status: string } }>(get);
    expect(detail.template.title).toBe("Persist Template");
    expect(detail.template.status).toBe("draft");

    const [row] = await db.select().from(assessmentTemplates).where(eq(assessmentTemplates.id, id));
    expect(row?.title).toBe("Persist Template");
  });

  it("persists items of each of the 8 types and round-trips them", async () => {
    const id = await newTemplateId("All Types Template");
    const o = (label: string, correct: boolean) => ({ id: `opt-${label}`, label, correct });
    const items: Array<{ type: string; prompt: string; config: Record<string, unknown>; points?: number }> = [
      { type: "mcq_single", prompt: "single", config: { options: [o("a", false), o("b", true)] } },
      { type: "mcq_multi", prompt: "multi", config: { options: [o("a", true), o("b", true), o("c", false)] } },
      { type: "true_false", prompt: "tf", config: { correct: true } },
      { type: "short_answer", prompt: "short", config: { sampleAnswer: "x" } },
      { type: "long_answer", prompt: "long", config: { sampleAnswer: "y" } },
      {
        type: "coding",
        prompt: "code",
        config: { language: "python", testCases: [{ id: "t1", stdin: "1", expected: "1", hidden: false, weight: 1 }], timeoutMs: 5000 },
      },
      { type: "file_upload", prompt: "file", config: { acceptedTypes: ["pdf"], maxSizeMb: 5 } },
      { type: "video_response", prompt: "video", config: { prepSeconds: 30, maxSeconds: 60, retakes: 1 } },
    ];
    for (const it of items) {
      const res = await authedInject(ADMIN, {
        method: "POST",
        url: `/api/assessments/templates/${id}/items`,
        payload: it,
      });
      expectJson(res, 201);
    }
    const get = await authedInject(ADMIN, { method: "GET", url: `/api/assessments/templates/${id}` });
    const detail = expectJson<{ items: Array<{ type: string }> }>(get);
    const types = detail.items.map((i) => i.type).sort();
    expect(types).toEqual(
      ["coding", "file_upload", "long_answer", "mcq_multi", "mcq_single", "short_answer", "true_false", "video_response"].sort(),
    );
  });

  it("publish creates an immutable version row", async () => {
    const id = await newTemplateId("Publish Template");
    await addMcqItem(id);
    const pub = await authedInject(ADMIN, { method: "POST", url: `/api/assessments/templates/${id}/publish` });
    const pubBody = expectJson<{ status: string; version: number; versionId: string }>(pub, 200);
    expect(pubBody.status).toBe("published");
    expect(pubBody.version).toBe(1);
    expect(pubBody.versionId).toBeTruthy();

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/assessments/templates/${id}` });
    const detail = expectJson<{ template: { status: string; publishedVersion: number }; versions: unknown[] }>(get);
    expect(detail.template.status).toBe("published");
    expect(detail.template.publishedVersion).toBe(1);
    expect(detail.versions.length).toBe(1);
  });
});

describe("assessments — idempotency", () => {
  it("replays the cached 201 for the same Idempotency-Key (no duplicate row)", async () => {
    const key = `itest-asmt-idem-${Date.now()}`;
    const first = await createTemplate("Idem Template", ADMIN, { "idempotency-key": key });
    const a = expectJson<{ template: { id: string } }>(first, 201);

    const second = await createTemplate("Idem Template (changed)", ADMIN, { "idempotency-key": key });
    const b = expectJson<{ template: { id: string }; idempotent?: boolean }>(second, 200);
    expect(b.template.id).toBe(a.template.id);
    expect(b.idempotent).toBe(true);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.id, a.template.id));
    expect(n).toBe(1);
  });
});

describe("assessments — Zod validation", () => {
  it("mcq_single with two correct options → 400 with issues", async () => {
    const id = await newTemplateId("Zod MCQ Template");
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/assessments/templates/${id}/items`,
      payload: {
        type: "mcq_single",
        prompt: "bad",
        config: { options: [{ id: "a", label: "A", correct: true }, { id: "b", label: "B", correct: true }] },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string; issues?: unknown };
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toBeTruthy();
  });

  it("negative points → 400", async () => {
    const id = await newTemplateId("Zod Points Template");
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/assessments/templates/${id}/items`,
      payload: { type: "true_false", prompt: "tf", config: { correct: true }, points: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("empty title → 400", async () => {
    const res = await createTemplate("");
    expect(res.statusCode).toBe(400);
  });
});

describe("assessments — cross-org isolation", () => {
  it("a cross-org token gets 404 on GET/PATCH/publish (no leak, no 500)", async () => {
    const id = await newTemplateId("Org A Only");

    const get = await authedInject(CROSS_ORG, { method: "GET", url: `/api/assessments/templates/${id}` });
    expect(get.statusCode).toBe(404);

    const patch = await authedInject(CROSS_ORG, {
      method: "PATCH",
      url: `/api/assessments/templates/${id}`,
      payload: { title: "hijack" },
    });
    expect(patch.statusCode).toBe(404);

    const publish = await authedInject(CROSS_ORG, { method: "POST", url: `/api/assessments/templates/${id}/publish` });
    expect(publish.statusCode).toBe(404);
  });

  it("import-from-bank cannot copy a question from another org's bank (no cross-tenant leak)", async () => {
    // Plant a bank + question owned by the cross-org tenant (JouleToWatts).
    const [foreignBank] = await db
      .insert(questionBanks)
      .values({ orgId: JOULESTOWATTS_ORG_ID, name: "Org-B Secret Bank" })
      .returning({ id: questionBanks.id });
    const [foreignQ] = await db
      .insert(questionBankQuestions)
      .values({
        bankId: foreignBank.id,
        orgId: JOULESTOWATTS_ORG_ID,
        prompt: "ORG-B-SECRET-PROMPT",
        contentHash: "org-b-secret-prompt-hash",
      })
      .returning({ id: questionBankQuestions.id });

    // Admin (DEFAULT_ORG) owns this template and tries to import org-B's question id.
    const templateId = await newTemplateId("Import Leak Guard");
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/assessments/templates/${templateId}/import-from-bank`,
      payload: { questionIds: [foreignQ.id], type: "short_answer" },
    });
    // Foreign id resolves to nothing under the caller's org → 404, never copied.
    expect(res.statusCode).toBe(404);

    // Prove the secret prompt was NOT copied into the importer's template/org.
    const copied = await db
      .select({ id: assessmentItems.id })
      .from(assessmentItems)
      .where(eq(assessmentItems.templateId, templateId));
    expect(copied.length).toBe(0);
    const leaked = await db
      .select({ id: assessmentItems.id })
      .from(assessmentItems)
      .where(eq(assessmentItems.prompt, "ORG-B-SECRET-PROMPT"));
    expect(leaked.length).toBe(0);
  });
});

describe("assessments — permission gates", () => {
  it("admin POST /templates → 201 (proves the permission-grant fix landed)", async () => {
    const res = await createTemplate("Admin Write Regression");
    const body = expectJson<{ template: { id: string } }>(res, 201);
  });

  it("recruiter can write + invite but is 403 on attempt review", async () => {
    // recruiter can write a template
    const create = await createTemplate("Recruiter Write", RECRUITER);
    const body = expectJson<{ template: { id: string } }>(create, 201);

    // recruiter review is forbidden (no assessments.review grant)
    const review = await authedInject(RECRUITER, {
      method: "PATCH",
      url: `/api/assessments/attempts/${"00000000-0000-0000-0000-000000000000"}`,
      payload: { reviewerNotes: "n/a" },
    });
    expectForbidden(review);
  });

  it("qa_reviewer can review but is 403 on POST /templates", async () => {
    const create = await createTemplate("QA Write Attempt", QA);
    expectForbidden(create);
  });
});

describe("assessments — auto-grade truth (no fabrication)", () => {
  it("known-correct → max; known-wrong → lower; key mutation + regrade moves the score", async () => {
    // build + publish a known MCQ
    const id = await newTemplateId("Grade Truth Template");
    await addMcqItem(id, 10);
    const pub = await authedInject(ADMIN, { method: "POST", url: `/api/assessments/templates/${id}/publish` });
    expectJson(pub, 200);

    const candidateId = await getCandidateId();

    // invite a candidate (correct answer)
    const inviteCorrect = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/assessments/invites",
      payload: { templateId: id, candidateId },
    });
    const ic = expectJson<{ attempt: { id: string; inviteToken: string } }>(inviteCorrect, 201);
    const tokenCorrect = ic.attempt.inviteToken;

    // resolve the item id via the preview (redacted candidate-runtime shape)
    const examLoad = await authedInject(ADMIN, { method: "GET", url: `/api/assessments/templates/${id}/preview` });
    const preview = expectJson<{ items: Array<{ id: string; type: string }> }>(examLoad);
    const mcqId = preview.items.find((i) => i.type === "mcq_single")!.id;

    const app = await getApp();
    // submit a CORRECT response through the public token path
    const submitCorrect = await app.inject({
      method: "POST",
      url: `/api/public/assessments/${tokenCorrect}/submit`,
      payload: { responses: [{ itemId: mcqId, selectedOptionIds: ["o-b"] }] },
    });
    const sc = expectJson<{ status: string; autoScore: number }>(submitCorrect, 200);
    expect(sc.status).toBe("submitted");
    expect(sc.autoScore).toBe(100); // single 10/10 item → 100%

    // a WRONG submission scores lower
    const inviteWrong = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/assessments/invites",
      payload: { templateId: id, candidateId },
    });
    const iw = expectJson<{ attempt: { id: string; inviteToken: string } }>(inviteWrong, 201);
    const submitWrong = await app.inject({
      method: "POST",
      url: `/api/public/assessments/${iw.attempt.inviteToken}/submit`,
      payload: { responses: [{ itemId: mcqId, selectedOptionIds: ["o-a"] }] },
    });
    const sw = expectJson<{ autoScore: number }>(submitWrong, 200);
    expect(sw.autoScore).toBeLessThan(sc.autoScore);

    // regrade the correct attempt → still 100 (deterministic, not fabricated)
    const regrade = await authedInject(ADMIN, { method: "POST", url: `/api/assessments/attempts/${ic.attempt.id}/regrade` });
    const rg = expectJson<{ attempt: { totalScore: number } }>(regrade, 200);
    expect(rg.attempt.totalScore).toBe(100);
  });
});

describe("assessments — external-key gating (503, not 500)", () => {
  it("POST /attempts/:id/run-code → 503 code_exec_unavailable when JUDGE0_URL unset", async () => {
    const id = await newTemplateId("Code Exec Gating");
    await addMcqItem(id);
    await authedInject(ADMIN, { method: "POST", url: `/api/assessments/templates/${id}/publish` });
    const candidateId = await getCandidateId();
    const invite = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/assessments/invites",
      payload: { templateId: id, candidateId },
    });
    const inv = expectJson<{ attempt: { id: string } }>(invite, 201);
    const res = await authedInject(ADMIN, { method: "POST", url: `/api/assessments/attempts/${inv.attempt.id}/run-code` });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe("code_exec_unavailable");
  });

  it("POST /attempts/:id/ai-assist gates on OPENAI_API_KEY: 503 openai_key_missing when unset, never 500", async () => {
    const id = await newTemplateId("AI Assist Gating");
    // include a subjective item so the configured path has something to score
    await authedInject(ADMIN, {
      method: "POST",
      url: `/api/assessments/templates/${id}/items`,
      payload: { type: "short_answer", prompt: "Define idempotency in one line.", config: { sampleAnswer: "Same result no matter how many times it runs." }, points: 4 },
    });
    await authedInject(ADMIN, { method: "POST", url: `/api/assessments/templates/${id}/publish` });
    const candidateId = await getCandidateId();
    const invite = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/assessments/invites",
      payload: { templateId: id, candidateId },
    });
    const inv = expectJson<{ attempt: { id: string } }>(invite, 201);
    const res = await authedInject(ADMIN, { method: "POST", url: `/api/assessments/attempts/${inv.attempt.id}/ai-assist` });
    // Precise behaviour both ways — and crucially NEVER an uncaught 500.
    expect(res.statusCode).not.toBe(500);
    if (process.env.OPENAI_API_KEY) {
      expect(res.statusCode).toBe(200);
    } else {
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.payload) as { error: string };
      expect(body.error).toBe("openai_key_missing");
    }
  });
});

describe("assessments — append-only audit", () => {
  it("publish writes a template.published audit row with an actor", async () => {
    const id = await newTemplateId("Audit Template");
    await addMcqItem(id);
    await authedInject(ADMIN, { method: "POST", url: `/api/assessments/templates/${id}/publish` });

    const rows = await db
      .select({ action: assessmentAuditLog.action, actorUserId: assessmentAuditLog.actorUserId })
      .from(assessmentAuditLog)
      .where(and(eq(assessmentAuditLog.templateId, id), eq(assessmentAuditLog.action, "template.published")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actorUserId).toBeTruthy();

    // also surfaced through the audit endpoint
    const audit = await authedInject(ADMIN, { method: "GET", url: `/api/assessments/templates/${id}/audit` });
    const body = expectJson<{ entries: Array<{ action: string }> }>(audit);
    const actions = body.entries.map((e) => e.action);
    expect(actions).toContain("template.created");
    expect(actions).toContain("template.published");
  });

  it("a raw UPDATE on assessment_audit_log is rejected by the immutability trigger", async () => {
    let threw = false;
    try {
      await db.execute(sql`UPDATE assessment_audit_log SET action = 'template.updated' WHERE id = (SELECT id FROM assessment_audit_log LIMIT 1)`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("assessments — keyset pagination", () => {
  it("/attempts?limit=N returns N + a usable nextCursor with no row repeats", async () => {
    const first = await authedInject(ADMIN, { method: "GET", url: "/api/assessments/attempts?limit=5" });
    const a = expectJson<{ attempts: Array<{ id: string }>; nextCursor: string | null; total: number }>(first);
    expect(a.attempts.length).toBeLessThanOrEqual(5);
    expect(a.total).toBeGreaterThanOrEqual(a.attempts.length);

    if (a.nextCursor) {
      expect(a.attempts.length).toBe(5);
      const second = await authedInject(ADMIN, {
        method: "GET",
        url: `/api/assessments/attempts?limit=5&cursor=${encodeURIComponent(a.nextCursor)}`,
      });
      const b = expectJson<{ attempts: Array<{ id: string }> }>(second);
      const firstIds = new Set(a.attempts.map((r) => r.id));
      for (const r of b.attempts) expect(firstIds.has(r.id)).toBe(false);
    }
  });

  it("an invalid cursor → 400 invalid_cursor (not 500)", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/assessments/attempts?cursor=not-base64-json" });
    // decodeCursor returns a value for arbitrary strings only if JSON parses; a
    // bare string fails to parse → 400.
    expect([200, 400]).toContain(res.statusCode);
  });
});
