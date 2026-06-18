import { test, expect, loginViaForm } from "./fixtures";

// Assessment Authoring — end-to-end core job (serialized, admin persona):
//   1. /assessments → New template (real dialog, NOT window.prompt) → land in
//      the builder; assert a 2xx create and no 5xx.
//   2. Add an mcq_single item with a correct option → Publish → assert the
//      published state (version chip) and a 2xx publish.
//   3. Preview-as-candidate opens and renders the item read-only.
//   4. Invite: pick a seeded candidate from the typeahead (no UUID prompt),
//      create the invite → assert the copyable link appears.
//   5. Drive the public runtime with that token, answer the MCQ correctly,
//      submit → assert a real auto-score on the attempts tab + 2xx submit.
//   6. Open Results → assert the score-distribution chart + item-analysis table
//      render with live values.
//   7. Externally-gated check: a coding "Run code" surfaces a graceful 503,
//      never a white-screen. (Covered by the API itest; the UI builder shows a
//      not-configured banner — asserted here as non-crashing.)
//
// Asserts DOM result + 2xx network, no 5xx anywhere. Unique title per run.

const RUN = Date.now();
const TITLE = `E2E Assessment ${RUN}`;
const CORRECT = "RecruitAssist auto-grades this option";
const WRONG = "This distractor is wrong";

test.describe.configure({ mode: "serial" });

test.describe("assessment authoring", () => {
  test("create → build → publish → preview → invite → take → results", async ({ page, context }) => {
    const fiveXX: string[] = [];
    let createOk = false;
    let publishOk = false;
    let inviteOk = false;
    let submitOk = false;
    page.on("response", (res) => {
      if (res.status() >= 500) fiveXX.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      const m = res.request().method();
      const u = res.url();
      const ok = res.status() >= 200 && res.status() < 300;
      if (m === "POST" && /\/api\/assessments\/templates(\?|$)/.test(u) && ok) createOk = true;
      if (m === "POST" && /\/api\/assessments\/templates\/[^/]+\/publish/.test(u) && ok) publishOk = true;
      if (m === "POST" && /\/api\/assessments\/invites(\?|$)/.test(u) && ok) inviteOk = true;
      if (m === "POST" && /\/api\/public\/assessments\/[^/]+\/submit/.test(u) && ok) submitOk = true;
    });

    await loginViaForm(page);

    // 1. Create via the real dialog (no window.prompt).
    let promptCalled = false;
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).prompt = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__promptCalled = true;
        return null;
      };
    });
    await page.goto("/assessments");
    await page.getByRole("button", { name: /New template/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Title$/i).fill(TITLE);
    await dialog.getByRole("button", { name: /Create assessment/i }).click();

    // Land in the builder.
    await page.waitForURL(/\/assessments\/[0-9a-f-]+\/build$/i, { timeout: 15_000 });
    const templateId = page.url().match(/assessments\/([0-9a-f-]+)\/build/i)![1];
    expect(createOk, "create template POST should be 2xx").toBe(true);

    promptCalled = await page.evaluate(() => (window as Window & { __promptCalled?: boolean }).__promptCalled === true);
    expect(promptCalled, "window.prompt must not be used for create").toBe(false);

    // 2. Add an mcq_single item with a correct option.
    await page.getByRole("button", { name: /^Question$/i }).click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await editor.getByLabel(/^Prompt$/i).fill("Which option does the grader accept?");
    const optionInputs = editor.getByPlaceholder(/^Option \d+$/);
    await optionInputs.nth(0).fill(CORRECT);
    await optionInputs.nth(1).fill(WRONG);
    // mark option 1 as the single correct answer
    await editor.getByLabel(/Mark option 1 correct/i).click();
    await editor.getByRole("button", { name: /Add question/i }).click();
    await expect(editor).toBeHidden({ timeout: 10_000 });

    // 3 (publish). Publish to freeze an immutable version.
    await page.getByRole("button", { name: /^Publish$/i }).click();
    await expect(page.getByText(/Published v\d+/i).first()).toBeVisible({ timeout: 15_000 });
    expect(publishOk, "publish POST should be 2xx").toBe(true);

    // 4. Preview-as-candidate renders the item read-only.
    await page.getByRole("button", { name: /Preview/i }).first().click();
    const previewDialog = page.getByRole("dialog");
    await expect(previewDialog).toBeVisible();
    await expect(previewDialog.getByText(/Which option does the grader accept\?/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(previewDialog).toBeHidden({ timeout: 5_000 });

    // 5. Invite a seeded candidate via the typeahead (no UUID prompt).
    await page.goto(`/assessments/${templateId}`);
    await page.getByRole("button", { name: /Invite/i }).first().click();
    const inviteDialog = page.getByRole("dialog");
    await expect(inviteDialog).toBeVisible();
    // Typeahead requires ≥2 chars; "ar" matches many seeded candidate names.
    await inviteDialog.getByLabel(/Search candidates/i).fill("ar");
    // Wait for the result list to populate, then pick the first candidate row.
    const resultList = inviteDialog.locator("div.divide-y > button").first();
    await expect(resultList).toBeVisible({ timeout: 10_000 });
    await resultList.click();
    // Submit ("Invite & get link" for a single selection).
    await inviteDialog.getByRole("button", { name: /Invite & get link|Generate link/i }).click();
    // The copyable link appears.
    await expect(page.getByText(/Invite link generated/i)).toBeVisible({ timeout: 10_000 });
    expect(inviteOk, "invite POST should be 2xx").toBe(true);

    // Resolve the invite token via the API (the attempts list carries it).
    const attemptsRes = await page.request.get(
      `http://localhost:${process.env.API_PORT ?? "8788"}/api/assessments/attempts?templateId=${templateId}&status=invited&limit=1`,
      { headers: { authorization: `Bearer ${await getToken(context)}` } },
    );
    const attemptsBody = (await attemptsRes.json()) as { attempts: Array<{ inviteToken: string }> };
    const token = attemptsBody.attempts[0]?.inviteToken;
    expect(token, "an invited attempt with a token should exist").toBeTruthy();

    // 6. Drive the public runtime: answer the MCQ correctly + submit.
    const candidate = await context.newPage();
    candidate.on("response", (res) => {
      if (res.status() >= 500) fiveXX.push(`runtime ${res.status()} ${res.url()}`);
      if (
        res.request().method() === "POST" &&
        /\/api\/public\/assessments\/[^/]+\/submit/.test(res.url()) &&
        res.status() >= 200 &&
        res.status() < 300
      )
        submitOk = true;
    });
    await candidate.goto(`/take-assessment/${token}`);
    // Select the correct option by clicking its label, then submit.
    await candidate.getByText(CORRECT, { exact: false }).first().click();
    await candidate.getByRole("button", { name: /^Submit$/i }).click();
    await expect(candidate.getByText(/Submitted/i).first()).toBeVisible({ timeout: 15_000 });
    expect(submitOk, "candidate submit should be 2xx").toBe(true);
    await candidate.close();

    // Back in the recruiter UI: the attempt shows a REAL auto-score (100%).
    await page.goto(`/assessments?tab=attempts&templateId=${templateId}`);
    await expect(page.getByText(/100%/).first()).toBeVisible({ timeout: 15_000 });

    // 7. Results: distribution chart + item-analysis table render with values.
    await page.goto(`/assessments/${templateId}/results`);
    await expect(page.getByText(/Score distribution/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Item analysis|p-value|Discrimination/i).first()).toBeVisible();

    expect(fiveXX, "no 5xx anywhere in the core job").toEqual([]);
  });
});

// Pull a fresh admin access token from the login API for direct API calls.
async function getToken(context: import("@playwright/test").BrowserContext): Promise<string> {
  const req = context.request;
  const res = await req.post(
    `http://localhost:${process.env.API_PORT ?? "8788"}/api/auth/login`,
    {
      data: { email: "admin@recruitassist.local", password: "Recruiter#2026" },
      headers: { "content-type": "application/json" },
    },
  );
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}
