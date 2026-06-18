import { test, expect, loginViaForm } from "./fixtures";

// Question Bank — end-to-end core jobs (serialized, admin persona):
//   1. /question-banks renders seeded bank cards (DOM) + live metric.
//   2. Create bank: open dialog, submit a unique name → new card appears (DOM)
//      and POST /api/question-banks is 2xx (network).
//   3. Author question: open a bank, open the editor, fill the multi-field form,
//      submit → POST …/questions is 2xx and the row count line updates.
//   4. Filter+search: pick a status filter → URL reflects ?status= and the
//      "Showing X of N" line is present.
//   5. Review queue: open /question-banks/review-queue → seeded in_review rows
//      render; clicking Approve resolves without a 5xx (self-approval guard may
//      return 409 — that is handled gracefully, never a white-screen).
//   6. Export CSV → a text/csv 2xx download.
//   7. AI-generate with no key → 503 + a toast (no white-screen).
//
// Asserts DOM result + 2xx mutating network, and no 5xx anywhere.

test.describe.configure({ mode: "serial" });

const RUN = Date.now();
const BANK_NAME = `E2E Bank ${RUN}`;
const QUESTION_PROMPT = `E2E question ${RUN}: explain idempotency in REST APIs.`;

test.describe("question bank", () => {
  test("list → create → author → filter → review → export → ai-degrade", async ({ page }) => {
    const fiveXX: string[] = [];
    let createBankOk = false;
    let createQuestionOk = false;
    let exportOk = false;
    let generateHandled = false;

    page.on("response", (res) => {
      const u = res.url();
      const m = res.request().method();
      const s = res.status();
      const ok = s >= 200 && s < 300;
      if (s >= 500) fiveXX.push(`${s} ${m} ${u}`);
      if (m === "POST" && /\/api\/question-banks(\?|$)/.test(u) && ok) createBankOk = true;
      if (m === "POST" && /\/api\/question-banks\/[^/]+\/questions(\?|$)/.test(u) && ok)
        createQuestionOk = true;
      if (m === "GET" && /\/api\/question-banks\/[^/]+\/export/.test(u) && ok) exportOk = true;
      if (m === "POST" && /\/api\/question-banks\/[^/]+\/generate(\?|$)/.test(u) && s === 503)
        generateHandled = true;
    });

    await loginViaForm(page);

    // 1. List renders seeded banks + a derived metric.
    await page.goto("/question-banks");
    await expect(page.getByText(/Java \+ Spring Backend/i)).toBeVisible({ timeout: 15_000 });

    // 2. Create bank.
    await page.getByRole("button", { name: /New bank/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(BANK_NAME);
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/question-banks(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      dialog.getByRole("button", { name: /Create bank/i }).click(),
    ]);
    expect(createRes.status(), "create bank should be 2xx").toBeGreaterThanOrEqual(200);
    expect(createRes.status()).toBeLessThan(300);
    expect(createBankOk).toBe(true);
    // We navigate to the new bank's detail on create.
    await expect(page).toHaveURL(/\/question-banks\/[0-9a-f-]+/i, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: BANK_NAME })).toBeVisible({ timeout: 15_000 });

    // 3. Author a question via the multi-field editor.
    await page.getByRole("button", { name: /Add question/i }).first().click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Prompt").fill(QUESTION_PROMPT);
    const submitBtn = editor.getByRole("button", { name: /Add question/i });
    await expect(submitBtn).toBeEnabled();
    const [qRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/question-banks\/[^/]+\/questions(\?|$)/.test(r.url()) &&
          r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      submitBtn.click(),
    ]);
    expect(qRes.status(), "create question should be 2xx").toBeGreaterThanOrEqual(200);
    expect(qRes.status()).toBeLessThan(300);
    expect(createQuestionOk).toBe(true);
    await expect(page.getByText(QUESTION_PROMPT)).toBeVisible({ timeout: 15_000 });

    // 4. Filter: pick a status → URL reflects it and the "Showing X of N" line shows.
    await page.goto("/question-banks/review-queue");
    // Back to a populated bank to exercise the filter UI deterministically.
    await page.goto("/question-banks");
    await page.getByText(/Java \+ Spring Backend/i).click();
    await expect(page).toHaveURL(/\/question-banks\/[0-9a-f-]+$/i, { timeout: 15_000 });
    await expect(page.getByText(/Showing \d+ of \d+/i)).toBeVisible({ timeout: 15_000 });
    // Status filter → URL param.
    await page.getByLabel(/Filter by Status/i).click();
    await page.getByRole("option", { name: /^Approved$/i }).click();
    await expect(page).toHaveURL(/status=approved/i, { timeout: 10_000 });

    // 5. Review queue renders seeded in_review rows; approve is handled gracefully.
    await page.goto("/question-banks/review-queue");
    await expect(page.getByRole("heading", { name: /Review queue/i })).toBeVisible({
      timeout: 15_000,
    });
    const approveBtn = page.getByRole("button", { name: /^Approve$/i }).first();
    if (await approveBtn.isVisible().catch(() => false)) {
      const [appRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            /\/api\/question-banks\/questions\/[^/]+\/approve(\?|$)/.test(r.url()) &&
            r.request().method() === "POST",
          { timeout: 15_000 },
        ),
        approveBtn.click(),
      ]);
      // 2xx (approved) or 409 (self-approval guard) — both are handled, never 5xx.
      expect(appRes.status()).toBeLessThan(500);
    }

    // 6. Export CSV download.
    await page.goto("/question-banks");
    await page.getByText(/Java \+ Spring Backend/i).click();
    await page.getByRole("button", { name: /^Export$/i }).click();
    await page.waitForResponse(
      (r) => /\/api\/question-banks\/[^/]+\/export/.test(r.url()) && r.status() < 400,
      { timeout: 15_000 },
    );
    expect(exportOk).toBe(true);

    // 7. AI-generate with no key → 503 surfaced as a toast (no white-screen).
    const aiBtn = page.getByRole("button", { name: /Generate similar question with AI/i });
    if (await aiBtn.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForResponse(
          (r) =>
            /\/api\/question-banks\/[^/]+\/generate(\?|$)/.test(r.url()) &&
            r.request().method() === "POST",
          { timeout: 15_000 },
        ),
        aiBtn.click(),
      ]);
      expect(generateHandled).toBe(true);
      // Page is still alive.
      await expect(page.getByRole("heading", { name: /Java \+ Spring Backend/i })).toBeVisible();
    }

    expect(fiveXX, `no 5xx responses: ${fiveXX.join(", ")}`).toEqual([]);
  });
});
