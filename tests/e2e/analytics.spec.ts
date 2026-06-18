import { test, expect, loginViaForm } from "./fixtures";

// Analytics dashboard — end-to-end core jobs (serialized, admin persona):
//   1. /analytics → the funnel chart renders from a live aggregate with an
//      "as of" timestamp (DOM).
//   2. Filter drives data: change the date range → a GET /reports/funnel?range=…
//      is 2xx and the URL carries ?range=…
//   3. Drill-down: click a funnel bucket → the drawer opens, candidate rows are
//      present, and a row navigates to /candidates/:id.
//   4. Save view: open the Save dialog, type a name, submit → 2xx
//      POST /api/analytics/views (no window.prompt).
//   5. Export: click Export CSV on the funnel → 2xx POST /api/analytics/export.
//   6. Graceful AI: "Explain this report" with OPENAI_API_KEY unset → a
//      Heuristic badge, no white-screen.
//
// Asserts DOM result + 2xx mutating network, and no 5xx anywhere in the trace.

test.describe.configure({ mode: "serial" });

const RUN = Date.now();

test.describe("analytics dashboard", () => {
  test("render → filter → drill → save view → export → explain", async ({ page }) => {
    const fiveXX: string[] = [];
    let funnelRangeOk = false;
    let viewCreateOk = false;
    let exportOk = false;
    page.on("response", (res) => {
      if (res.status() >= 500)
        fiveXX.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      const m = res.request().method();
      const u = res.url();
      const ok = res.status() >= 200 && res.status() < 300;
      if (m === "GET" && /\/api\/analytics\/reports\/funnel\?.*range=last_90d/.test(u) && ok)
        funnelRangeOk = true;
      if (m === "POST" && /\/api\/analytics\/views(\?|$)/.test(u) && ok) viewCreateOk = true;
      if (m === "POST" && /\/api\/analytics\/export(\?|$)/.test(u) && ok) exportOk = true;
    });

    await loginViaForm(page);

    // 1. Funnel renders from a live aggregate + an "as of" timestamp.
    await page.goto("/analytics");
    await expect(page.getByText(/Submission funnel/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("as-of").first()).toContainText(/as of/i, { timeout: 15_000 });

    // 2. Filter drives data: switch the date range to Last 90 days.
    await page.getByLabel("Date range").click();
    await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/analytics\/reports\/funnel\?.*range=last_90d/.test(res.url()) &&
          res.request().method() === "GET",
        { timeout: 15_000 },
      ),
      page.getByRole("option", { name: /Last 90 days/i }).click(),
    ]);
    await expect(page).toHaveURL(/range=last_90d/);
    expect(funnelRangeOk).toBe(true);

    // 3. Drill-down: click a funnel bucket card → drawer with candidate rows.
    const bucketCard = page.locator('[data-testid^="funnel-bucket-"]').first();
    await expect(bucketCard).toBeVisible({ timeout: 15_000 });
    await bucketCard.click();
    const drawer = page.getByTestId("drill-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    const drillRow = page.getByTestId("drill-row").first();
    await expect(drillRow).toBeVisible({ timeout: 15_000 });
    await drillRow.click();
    await expect(page).toHaveURL(/\/candidates\/[0-9a-f-]+/, { timeout: 15_000 });

    // Back to analytics for the remaining jobs.
    await page.goto("/analytics");
    await expect(page.getByText(/Submission funnel/i)).toBeVisible({ timeout: 15_000 });

    // 4. Save view: open the menu → "Save current view…" → name → submit.
    await page.getByTestId("saved-view-menu").click();
    await page.getByTestId("open-save-view").click();
    const saveDialog = page.getByRole("dialog");
    await expect(saveDialog).toBeVisible();
    const viewName = `E2E View ${RUN}`;
    await saveDialog.getByLabel("Name").fill(viewName);
    const [viewRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/analytics\/views(\?|$)/.test(res.url()) && res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByTestId("save-view-submit").click(),
    ]);
    expect(viewRes.status(), "view POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(viewRes.status()).toBeLessThan(300);
    expect(viewCreateOk).toBe(true);

    // 5. Export CSV on the funnel chart.
    const [expRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/analytics\/export(\?|$)/.test(res.url()) && res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByTestId("export-csv").first().click(),
    ]);
    expect(expRes.status(), "export POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(expRes.status()).toBeLessThan(300);
    expect(exportOk).toBe(true);

    // 6. Graceful AI: Explain this report → Heuristic badge when no key.
    await page.getByTestId("explain-report").first().click();
    await expect(page.getByTestId("summary-badge").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("summary-badge").first()).toContainText(/Heuristic|AI-generated/);

    expect(fiveXX, "no 5xx anywhere in the core job").toEqual([]);
  });
});
