import { test, expect, loginViaForm } from "./fixtures";

// Recruiters manager leaderboard — end-to-end core job (serialized, admin persona):
//   1. /recruiters → the leaderboard renders ≥1 row with live KPI cells.
//   2. Sort by "Subs" via the column header → URL gains sort=submissions and the
//      list request is 2xx.
//   3. Open a recruiter's detail → Set goal via the real dialog (no prompt) →
//      save → assert POST /api/recruiters/*/goals is 2xx and the goal + a new
//      activity-timeline entry appear.
//   4. Nudge with AI-draft (OPENAI_API_KEY unset) → assert the graceful 503 UI
//      ("AI drafting unavailable", no white-screen) and that a plain manual
//      nudge still succeeds 2xx.
//   5. Export CSV → assert the /api/recruiters/export request is 2xx text/csv.
//
// Asserts DOM result + 2xx mutating network, no 5xx anywhere. Unique note per run.

const API_PORT = process.env.API_PORT ?? "8788";
const API_URL = `http://localhost:${API_PORT}`;
const RUN = Date.now();

test.describe.configure({ mode: "serial" });

test.describe("recruiters leaderboard", () => {
  test("rank → sort → set goal → nudge(AI-503 + manual) → export", async ({ page }) => {
    const fiveXX: string[] = [];
    let goalOk = false;
    let nudgeOk = false;
    page.on("response", (res) => {
      // The AI nudge-draft endpoint intentionally answers 503 openai_key_missing
      // when OPENAI_API_KEY is unset (the spec's BLOCKED-on-credential path,
      // asserted positively in step 4). That graceful, expected 503 is not a
      // server fault — exclude it from the "no 5xx anywhere" guard.
      const isExpectedDraft503 =
        res.status() === 503 &&
        res.request().method() === "POST" &&
        /\/api\/recruiters\/[^/]+\/nudge\/draft(\?|$)/.test(res.url());
      if (res.status() >= 500 && !isExpectedDraft503)
        fiveXX.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      const m = res.request().method();
      const u = res.url();
      const ok = res.status() >= 200 && res.status() < 300;
      if (m === "POST" && /\/api\/recruiters\/[^/]+\/goals/.test(u) && ok) goalOk = true;
      if (m === "POST" && /\/api\/recruiters\/[^/]+\/nudge(\?|$)/.test(u) && ok) nudgeOk = true;
    });

    await page.addInitScript(() => {
      (window as unknown as { prompt: () => null; __promptCalled?: boolean }).prompt = () => {
        (window as unknown as { __promptCalled?: boolean }).__promptCalled = true;
        return null;
      };
    });

    await loginViaForm(page);

    // 1. Leaderboard renders with at least one row + live KPI cells.
    await page.goto("/recruiters");
    const firstRowName = page.locator("table.data-table tbody tr").first().locator("button").first();
    await expect(firstRowName).toBeVisible({ timeout: 15_000 });

    // 2. Sort by Subs via the header → URL gains sort + list refetches 2xx.
    const [sortRes] = await Promise.all([
      page.waitForResponse(
        (res) => /\/api\/recruiters(\?|$)/.test(res.url()) && res.request().method() === "GET",
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /^Subs$/i }).click(),
    ]);
    expect(sortRes.status()).toBeGreaterThanOrEqual(200);
    expect(sortRes.status()).toBeLessThan(300);
    await expect(page).toHaveURL(/sort=submissions/);

    // 3. Drill into a recruiter detail → Set goal.
    await firstRowName.click();
    await page.waitForURL(/\/recruiters\/[0-9a-f-]+$/i, { timeout: 15_000 });
    await page.getByRole("button", { name: /^Set goal$/i }).first().click();
    const goalDialog = page.getByRole("dialog");
    await expect(goalDialog).toBeVisible();
    // Use the "offers" metric to avoid colliding with a seeded submissions goal.
    await goalDialog.getByLabel("Metric").click();
    await page.getByRole("option", { name: /^Offers$/i }).click();
    await goalDialog.getByLabel(/target value/i).fill(String(7 + (RUN % 90)));
    const [goalRes] = await Promise.all([
      page.waitForResponse(
        (res) => /\/api\/recruiters\/[^/]+\/goals/.test(res.url()) && res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      goalDialog.getByRole("button", { name: /^Set goal$/i }).click(),
    ]);
    expect(goalRes.status(), "goal POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(goalRes.status()).toBeLessThan(300);
    expect(goalOk).toBe(true);

    // The goal appears in the Goals tab.
    await page.getByRole("tab", { name: /goals/i }).click();
    await expect(page.getByText("Offers").first()).toBeVisible({ timeout: 15_000 });

    // A new activity-timeline entry appears.
    await page.getByRole("tab", { name: /activity/i }).click();
    await expect(page.getByText(/set a goal/i).first()).toBeVisible({ timeout: 15_000 });

    // 4. Nudge: AI-draft 503 surfaces gracefully, then a manual nudge succeeds.
    await page.getByRole("button", { name: /^Nudge$/i }).click();
    const nudgeDialog = page.getByRole("dialog");
    await expect(nudgeDialog).toBeVisible();
    await nudgeDialog.getByRole("button", { name: /draft with ai/i }).click();
    await expect(
      nudgeDialog.getByText(/AI drafting unavailable|OPENAI_API_KEY/i),
    ).toBeVisible({ timeout: 15_000 });
    // Page still alive (no white-screen): the dialog is still here. Type manually.
    await nudgeDialog.getByLabel(/^Message$/i).fill(`Great work this sprint — keep the momentum. (${RUN})`);
    const [nudgeRes] = await Promise.all([
      page.waitForResponse(
        (res) => /\/api\/recruiters\/[^/]+\/nudge(\?|$)/.test(res.url()) && res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      nudgeDialog.getByRole("button", { name: /send nudge/i }).click(),
    ]);
    expect(nudgeRes.status(), "nudge POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(nudgeRes.status()).toBeLessThan(300);
    expect(nudgeOk).toBe(true);

    // 5. Export CSV → request to /api/recruiters/export is 2xx text/csv.
    await page.goto("/recruiters");
    await expect(firstRowName).toBeVisible({ timeout: 15_000 });
    const [exportRes] = await Promise.all([
      page.waitForResponse(
        (res) => /\/api\/recruiters\/export/.test(res.url()),
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /export csv/i }).click(),
    ]);
    expect(exportRes.status(), "export should be 2xx").toBeGreaterThanOrEqual(200);
    expect(exportRes.status()).toBeLessThan(300);
    expect(exportRes.headers()["content-type"] ?? "").toContain("csv");

    // No window.prompt anywhere; no 5xx anywhere.
    const promptCalled = await page.evaluate(
      () => (window as Window & { __promptCalled?: boolean }).__promptCalled === true,
    );
    expect(promptCalled, "window.prompt must not be used").toBe(false);
    expect(fiveXX, "no 5xx anywhere in the core job").toEqual([]);
  });
});
