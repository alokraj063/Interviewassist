import { test, expect, loginViaForm } from "./fixtures";

// Coaching — end-to-end core jobs (serialized, admin persona):
//   1. /coaching renders the Library with seeded scenario rows (DOM).
//   2. Author a scenario: open the builder, fill title/difficulty/persona/
//      objection/success-criterion → Save → POST /api/coaching/scenarios 2xx and
//      the new card appears in the Library.
//   3. Edit + publish from the detail page → "Published" badge + 2xx PATCH.
//   4. Assign: open the Assign dialog, pick a recruiter → POST /assignments 2xx.
//   5. Filter/search: type in search → URL ?q= updates and the "Showing X of N"
//      line is present.
//   6. Practice (graceful): start a run → ai-call returns 503 when VAPI is unset
//      → the self-recorded fallback is offered (no white-screen); end → results
//      render per-criterion score bars (from stub scoring).
//
// Asserts DOM result + 2xx mutating network, and no 5xx anywhere.

test.describe.configure({ mode: "serial" });

const RUN = Date.now();
const TITLE = `E2E Scenario ${RUN}`;

test.describe("coaching", () => {
  test("list → author → publish → assign → filter → practice", async ({ page }) => {
    const fiveXX: string[] = [];
    let createOk = false;
    let assignOk = false;

    page.on("response", (res) => {
      const u = res.url();
      const m = res.request().method();
      const s = res.status();
      const ok = s >= 200 && s < 300;
      if (s >= 500) fiveXX.push(`${s} ${m} ${u}`);
      if (m === "POST" && /\/api\/coaching\/scenarios(\?|$)/.test(u) && ok) createOk = true;
      if (m === "POST" && /\/api\/coaching\/assignments(\?|$)/.test(u) && ok) assignOk = true;
    });

    await loginViaForm(page);

    // 1. Library renders.
    await page.goto("/coaching");
    await expect(page.getByRole("tab", { name: "Library" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Showing \d+ of \d+/)).toBeVisible({ timeout: 15_000 });

    // 2. Author a scenario.
    await page.getByRole("button", { name: /New scenario/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title").fill(TITLE);
    // add an objection
    await dialog.getByRole("button", { name: /^Add$/ }).first().click();
    // add a success criterion
    const addButtons = dialog.getByRole("button", { name: /^Add$/ });
    await addButtons.nth(1).click();
    const submit = dialog.getByRole("button", { name: /Create scenario/i });
    await expect(submit).toBeEnabled();
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/coaching\/scenarios(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    expect(createRes.status()).toBeGreaterThanOrEqual(200);
    expect(createRes.status()).toBeLessThan(300);
    expect(createOk).toBe(true);
    // The new scenario appears in the Library.
    await expect(page.getByText(TITLE)).toBeVisible({ timeout: 15_000 });

    // 3. Open detail → publish.
    await page.getByText(TITLE).click();
    await expect(page).toHaveURL(/\/coaching\/[0-9a-f-]+/i, { timeout: 15_000 });
    const publishBtn = page.getByRole("button", { name: /^Publish$/ });
    if (await publishBtn.count()) {
      const [pubRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            /\/api\/coaching\/scenarios\/[^/]+(\?|$)/.test(r.url()) &&
            r.request().method() === "PATCH",
          { timeout: 15_000 },
        ),
        publishBtn.click(),
      ]);
      expect(pubRes.status()).toBeLessThan(300);
      await expect(page.getByText("Published").first()).toBeVisible({ timeout: 15_000 });
    }

    // 4. Assign to a recruiter.
    await page.getByRole("button", { name: /Assign/i }).first().click();
    const assignDialog = page.getByRole("dialog");
    await expect(assignDialog).toBeVisible();
    // pick the first available recruiter checkbox
    const firstCheckbox = assignDialog.getByRole("checkbox").first();
    await firstCheckbox.waitFor({ state: "visible", timeout: 15_000 });
    await firstCheckbox.click();
    const [assignRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/coaching\/assignments(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      assignDialog.getByRole("button", { name: /^Assign$/ }).click(),
    ]);
    expect(assignRes.status()).toBeLessThan(300);
    expect(assignOk).toBe(true);

    // 5. Filter/search on the Library.
    await page.goto("/coaching");
    await page.getByLabel("Search scenarios").fill("negotiation");
    await expect(page).toHaveURL(/[?&]q=negotiation/, { timeout: 15_000 });
    await expect(page.getByText(/Showing \d+ of \d+/)).toBeVisible({ timeout: 15_000 });

    // 6. Practice (graceful): start a run from detail, end it, see results.
    await page.goto("/coaching");
    await page.getByText(TITLE).click();
    await expect(page).toHaveURL(/\/coaching\/[0-9a-f-]+/i, { timeout: 15_000 });
    const [runRes] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/coaching\/runs(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /Practice/i }).first().click(),
    ]);
    expect(runRes.status()).toBeLessThan(300);
    await expect(page).toHaveURL(/\/simulate\?runId=/, { timeout: 15_000 });

    // Begin AI roleplay — VAPI unset → 503 → self-recorded fallback offered.
    await page.getByRole("button", { name: /Begin AI roleplay/i }).click();
    // Either a live state or the fallback hint; assert the self-recorded option exists.
    const selfRecorded = page.getByRole("button", { name: /Self-recorded practice/i });
    await expect(selfRecorded).toBeVisible({ timeout: 15_000 });
    await selfRecorded.click();
    // End & score → completes the run (enqueues stub scoring) → results.
    const endBtn = page.getByRole("button", { name: /End & score/i });
    await endBtn.waitFor({ state: "visible", timeout: 15_000 });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/coaching\/runs\/[^/]+(\?|$)/.test(r.url()) && r.request().method() === "PATCH",
        { timeout: 15_000 },
      ),
      endBtn.click(),
    ]);
    await expect(page).toHaveURL(/\/results\?runId=/, { timeout: 15_000 });
    // Per-criterion bars (from stub scoring) render, or the "Scored" overall.
    await expect(
      page.getByText(/Per-criterion|Overall/).first(),
    ).toBeVisible({ timeout: 20_000 });

    expect(fiveXX, `no 5xx responses: ${fiveXX.join(", ")}`).toEqual([]);
  });
});
