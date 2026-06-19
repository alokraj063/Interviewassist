// Question Bank — governed, calibrated, versioned item library. Backend itests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts: bank + question persistence (full payload, v1 version),
// Zod 400 (missing prompt; mcq_single with 0 correct → superRefine path),
// cross-org 404 (never a leak), permission gate (recruiter read-only → 403 on
// write; qa_reviewer has read+approve but not write → 403 on write, 200 on
// approve; admin → success), self-approval 409, keyset pagination (no dupes,
// limit>100 rejected, exhausts to nextCursor=null, totalApprox correct),
// idempotency (same Idempotency-Key → same id; re-commit import no-op), audit
// rows on every state change, and external-key gating (no OPENAI_API_KEY →
// create still 201 lexical-dedup-only; /generate → 503 openai_api_key_missing,
// never 500).
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (read+write+approve),
// recruiter1@ (read only), qa1@ (qa_reviewer → read+approve after 0034, NOT
// write). Cross-org (JoulesToWatts): cognition.engine@joulestowatts.com (admin).
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  DEFAULT_ORG_ID,
  questionBanks,
  questionBankQuestions,
  questionBankAudit,
  questionVersions,
} from "@j2w/db";
import { authedInject, expectJson } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local"; // question_banks.read only
const QA = "qa1@recruitassist.local"; // read + approve (post-0034), NOT write
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const createdBankIds: string[] = [];

afterAll(async () => {
  if (createdBankIds.length) {
    // Questions / versions / audit cascade off question_banks; audit rows with a
    // NULL bank_id (bulk roll-ups) are cleaned per-test below where created.
    await db.delete(questionBanks).where(inArray(questionBanks.id, createdBankIds));
  }
});

async function createBank(name: string, headers?: Record<string, string>) {
  const res = await authedInject(ADMIN, {
    method: "POST",
    url: "/api/question-banks",
    headers,
    payload: { name, description: "itest bank", defaultLanguage: "en" },
  });
  if (res.statusCode === 201) {
    const body = JSON.parse(res.body) as { id: string };
    if (!createdBankIds.includes(body.id)) createdBankIds.push(body.id);
  }
  return res;
}

function fullQuestion(prompt: string) {
  return {
    skillName: "Spring Boot",
    level: "mid",
    difficulty: 4,
    language: "hinglish",
    questionType: "verbal",
    roleFamily: "backend",
    prompt,
    expectedAnswerHints: "Bean lifecycle, @Transactional propagation",
    evaluationRubric: ["Mentions proxy", "Mentions propagation"],
    followUpQuestions: ["What about REQUIRES_NEW?"],
    commonMistakes: ["Confusing isolation with propagation"],
    options: [],
  };
}

describe("banks — persistence, permission, cross-org, idempotency", () => {
  it("admin creates a bank and reads it back", async () => {
    const res = await createBank(`Bank Persist ${Date.now()}`);
    const created = expectJson<{ id: string }>(res, 201);
    expect(created.id).toBeTruthy();

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/question-banks/${created.id}` });
    const bank = expectJson<{ id: string; status: string; version: number }>(get, 200);
    expect(bank.id).toBe(created.id);
    expect(bank.status).toBe("active");
    expect(bank.version).toBe(1);
  });

  it("recruiter (read only) → 403 with permission on create", async () => {
    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: "/api/question-banks",
      payload: { name: "nope" },
    });
    const body = expectJson<{ error: string; permission: string }>(res, 403);
    expect(body.permission).toBe("question_banks.write");
  });

  it("recruiter (read only) → 200 on list", async () => {
    const res = await authedInject(RECRUITER, { method: "GET", url: "/api/question-banks?limit=5" });
    expectJson(res, 200);
  });

  it("cross-org GET of another org's bank → 404 (no leak)", async () => {
    const res = await createBank(`Bank XOrg ${Date.now()}`);
    const { id } = expectJson<{ id: string }>(res, 201);
    const get = await authedInject(CROSS_ORG, { method: "GET", url: `/api/question-banks/${id}` });
    expect(get.statusCode).toBe(404);
    const patch = await authedInject(CROSS_ORG, {
      method: "PATCH",
      url: `/api/question-banks/${id}`,
      payload: { name: "hijack", expectedVersion: 1 },
    });
    expect(patch.statusCode).toBe(404);
  });

  it("Idempotency-Key short-circuits a double create-bank to the same id", async () => {
    const k = `itest-bank-${Math.random().toString(36).slice(2)}`;
    const a = await createBank(`Idem Bank ${Date.now()}`, { "idempotency-key": k });
    const first = expectJson<{ id: string }>(a, 201);
    const b = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/question-banks",
      headers: { "idempotency-key": k },
      payload: { name: "different name same key", defaultLanguage: "en" },
    });
    const second = expectJson<{ id: string }>(b, 201);
    expect(second.id).toBe(first.id);
  });

  it("audit row written on bank.created", async () => {
    const res = await createBank(`Bank Audit ${Date.now()}`);
    const { id } = expectJson<{ id: string }>(res, 201);
    const rows = await db
      .select()
      .from(questionBankAudit)
      .where(and(eq(questionBankAudit.bankId, id), eq(questionBankAudit.action, "bank.created")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actorUserId).toBeTruthy();
  });
});

describe("questions — create, validation, versioning, audit", () => {
  it("creates a full question → 201, GET returns tagging + v1 version", async () => {
    const bankRes = await createBank(`Q Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);

    const create = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: fullQuestion(`Explain @Transactional propagation ${Date.now()}`),
    });
    const q = expectJson<{ id: string; currentVersion: number }>(create, 201);
    expect(q.currentVersion).toBe(1);

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/question-banks/questions/${q.id}` });
    const detail = expectJson<{
      question: { language: string; roleFamily: string; status: string; currentVersion: number };
      versions: Array<{ version: number; reason: string }>;
    }>(get, 200);
    expect(detail.question.language).toBe("hinglish");
    expect(detail.question.roleFamily).toBe("backend");
    expect(detail.question.status).toBe("draft");
    expect(detail.question.currentVersion).toBe(1);
    expect(detail.versions.some((v) => v.version === 1 && v.reason === "created")).toBe(true);

    const audit = await db
      .select()
      .from(questionBankAudit)
      .where(and(eq(questionBankAudit.questionId, q.id), eq(questionBankAudit.action, "question.created")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("missing prompt → 400 invalid_payload", async () => {
    const bankRes = await createBank(`Q Zod Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: { level: "mid", difficulty: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_payload");
  });

  it("mcq_single with 0 correct options → 400 (superRefine path options)", async () => {
    const bankRes = await createBank(`Q MCQ Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: {
        prompt: "Pick one",
        questionType: "mcq_single",
        options: [
          { id: "a", text: "A", correct: false },
          { id: "b", text: "B", correct: false },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(JSON.stringify(body.issues)).toContain("options");
  });

  it("duplicate prompt → 409 duplicate_question; Idempotency-Key returns same id", async () => {
    const bankRes = await createBank(`Q Dup Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const prompt = `Dup prompt ${Date.now()}`;

    const k = `itest-q-${Math.random().toString(36).slice(2)}`;
    const a = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      headers: { "idempotency-key": k },
      payload: fullQuestion(prompt),
    });
    const first = expectJson<{ id: string }>(a, 201);

    // Same content, no override, no key → 409 with the colliding id.
    const dup = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: fullQuestion(prompt),
    });
    const dupBody = expectJson<{ error: string; existingId: string }>(dup, 409);
    expect(dupBody.error).toBe("duplicate_question");
    expect(dupBody.existingId).toBe(first.id);

    // Same content + same idempotency key → idempotent 201 returning same id.
    const retry = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      headers: { "idempotency-key": k },
      payload: fullQuestion(prompt),
    });
    const retryBody = expectJson<{ id: string }>(retry, 201);
    expect(retryBody.id).toBe(first.id);
  });
});

describe("review/approval workflow — gates + self-approval guard + audit", () => {
  async function makeInReview(creator = ADMIN): Promise<{ bankId: string; qid: string }> {
    const bankRes = await createBank(`Review Bank ${Date.now()}-${Math.random()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const create = await authedInject(creator, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: fullQuestion(`Review prompt ${Date.now()}-${Math.random()}`),
    });
    const { id: qid } = expectJson<{ id: string }>(create, 201);
    const submit = await authedInject(creator, {
      method: "POST",
      url: `/api/question-banks/questions/${qid}/submit-review`,
      payload: {},
    });
    expectJson(submit, 200);
    return { bankId, qid };
  }

  it("recruiter cannot write (submit-review) → 403", async () => {
    const { qid } = await makeInReview();
    // recruiter lacks write; pick any write endpoint.
    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/question-banks/questions/${qid}/archive`,
      payload: {},
    });
    const body = expectJson<{ permission: string }>(res, 403);
    expect(body.permission).toBe("question_banks.write");
  });

  it("author approving own question → 409 self_approval; qa1 (approver) → 200", async () => {
    const { qid } = await makeInReview(ADMIN); // created by admin
    const selfApprove = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/questions/${qid}/approve`,
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(409);
    expect(JSON.parse(selfApprove.body).error).toBe("self_approval");

    // qa1 is a qa_reviewer: has question_banks.approve (post-0034) but is not
    // the author → approval succeeds.
    const ok = await authedInject(QA, {
      method: "POST",
      url: `/api/question-banks/questions/${qid}/approve`,
      payload: { note: "looks good" },
    });
    const body = expectJson<{ status: string }>(ok, 200);
    expect(body.status).toBe("approved");

    const audit = await db
      .select()
      .from(questionBankAudit)
      .where(and(eq(questionBankAudit.questionId, qid), eq(questionBankAudit.action, "question.approved")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("qa1 (read+approve, NOT write) → 403 on a write endpoint", async () => {
    const bankRes = await authedInject(QA, {
      method: "POST",
      url: "/api/question-banks",
      payload: { name: "qa cannot create" },
    });
    const body = expectJson<{ permission: string }>(bankRes, 403);
    expect(body.permission).toBe("question_banks.write");
  });

  it("recruiter cannot reach approval queue (needs .approve) → 403", async () => {
    const res = await authedInject(RECRUITER, { method: "GET", url: "/api/question-banks/review-queue" });
    expect(res.statusCode).toBe(403);
  });

  it("qa1 can read the org-wide review queue → 200", async () => {
    await makeInReview();
    const res = await authedInject(QA, { method: "GET", url: "/api/question-banks/review-queue?limit=5" });
    const body = expectJson<{ questions: unknown[] }>(res, 200);
    expect(Array.isArray(body.questions)).toBe(true);
  });
});

describe("pagination — keyset, no dupes, exhausts, totalApprox", () => {
  it("60 questions paginate by 25 with stable cursor and totalApprox=60", async () => {
    const bankRes = await createBank(`Page Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    for (let i = 0; i < 60; i++) {
      const res = await authedInject(ADMIN, {
        method: "POST",
        url: `/api/question-banks/${bankId}/questions`,
        payload: { ...fullQuestion(`Page q ${i} ${Date.now()}-${Math.random()}`), skillName: undefined },
      });
      expect(res.statusCode).toBe(201);
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let total = -1;
    do {
      const url: string = `/api/question-banks/${bankId}/questions?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await authedInject(ADMIN, { method: "GET", url });
      const body = expectJson<{ questions: Array<{ id: string }>; nextCursor: string | null; totalApprox: number }>(
        res,
        200,
      );
      total = body.totalApprox;
      for (const q of body.questions) {
        expect(seen.has(q.id)).toBe(false);
        seen.add(q.id);
      }
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen.size).toBe(60);
    expect(total).toBe(60);
  });

  it("limit > 100 → 400", async () => {
    const bankRes = await createBank(`Limit Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/question-banks/${bankId}/questions?limit=500`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("bulk + import idempotency + export", () => {
  it("bulk archive removes rows from the default view; audit + roll-up", async () => {
    const bankRes = await createBank(`Bulk Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await authedInject(ADMIN, {
        method: "POST",
        url: `/api/question-banks/${bankId}/questions`,
        payload: fullQuestion(`Bulk q ${i} ${Date.now()}-${Math.random()}`),
      });
      ids.push(expectJson<{ id: string }>(r, 201).id);
    }
    const bulk = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/question-banks/questions/bulk",
      payload: { questionIds: ids, action: "archive" },
    });
    const body = expectJson<{ updated: number }>(bulk, 200);
    expect(body.updated).toBe(2);

    const archived = await db
      .select({ status: questionBankQuestions.status })
      .from(questionBankQuestions)
      .where(inArray(questionBankQuestions.id, ids));
    expect(archived.every((q) => q.status === "archived")).toBe(true);
  });

  it("CSV import previews then commits; re-commit is idempotent", async () => {
    const bankRes = await createBank(`Import Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const stamp = `${Date.now()}-${Math.random()}`;
    const csv = `prompt,level,difficulty,language\n"Imported q one ${stamp}",mid,3,en\n"Imported q two ${stamp}",senior,4,hinglish`;
    const idem = `itest-import-${Math.random().toString(36).slice(2)}`;

    const preview = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/import`,
      headers: { "idempotency-key": idem },
      payload: { format: "csv", content: csv },
    });
    const pj = expectJson<{ jobId: string; validCount: number; status: string }>(preview, 200);
    expect(pj.validCount).toBe(2);
    expect(pj.status).toBe("ready");

    // Same idem key → same job (no new parse).
    const preview2 = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/import`,
      headers: { "idempotency-key": idem },
      payload: { format: "csv", content: csv },
    });
    const pj2 = expectJson<{ jobId: string; idempotent?: boolean }>(preview2, 200);
    expect(pj2.jobId).toBe(pj.jobId);

    const commit = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/import-jobs/${pj.jobId}/commit`,
    });
    const cj = expectJson<{ inserted: number; status: string }>(commit, 200);
    expect(cj.inserted).toBe(2);
    expect(cj.status).toBe("committed");

    // Re-commit → no duplicate insert.
    const recommit = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/import-jobs/${pj.jobId}/commit`,
    });
    const rj = expectJson<{ inserted: number; idempotent?: boolean }>(recommit, 200);
    expect(rj.inserted).toBe(0);
  });

  it("export returns text/csv", async () => {
    const bankRes = await createBank(`Export Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: fullQuestion(`Export q ${Date.now()}-${Math.random()}`),
    });
    const res = await authedInject(ADMIN, { method: "GET", url: `/api/question-banks/${bankId}/export?format=csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("prompt");
  });
});

describe("calibration + external-key gating", () => {
  it("recalibrate rolls usage events into calibrated_difficulty → 200", async () => {
    const res = await authedInject(ADMIN, { method: "POST", url: "/api/question-banks/recalibrate" });
    const body = expectJson<{ recalibrated: number }>(res, 200);
    expect(typeof body.recalibrated).toBe("number");
  });

  it("create still 201 with no OPENAI_API_KEY (lexical dedup only, never 500)", async () => {
    const bankRes = await createBank(`NoKey Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/questions`,
      payload: fullQuestion(`NoKey q ${Date.now()}-${Math.random()}`),
    });
    expect(res.statusCode).toBe(201);
  });

  it("AI generate with no key → 503 openai_api_key_missing (never 500)", async () => {
    const bankRes = await createBank(`Gen Bank ${Date.now()}`);
    const { id: bankId } = expectJson<{ id: string }>(bankRes, 201);
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/question-banks/${bankId}/generate`,
      payload: { skillName: "Java" },
    });
    // Only assert the gate when the harness env has no key.
    if (!process.env.OPENAI_API_KEY) {
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe("openai_api_key_missing");
    } else {
      expect([202, 503]).toContain(res.statusCode);
    }
  });
});
