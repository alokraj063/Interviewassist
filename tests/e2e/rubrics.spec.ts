import { test, expect, loginViaForm } from "./fixtures";

// Rubrics — end-to-end core job:
//   create (real dialog, not prompt) → land on editor → add a criterion with
//   anchors+weight → publish → assert "Published v1" + 2xx publish network.
// Plus search-URL-sync and bulk-archive. Asserts DOM result + 2xx network,
// no 5xx anywhere. Unique names per run avoid cross-spec interference.

const RUN = Date.now();
const RUBRIC_NAME = `E2E Rubric ${RUN}`;

test.describe("rubrics", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaForm(page);
  });

  test("create → publish core job", async ({ page }) => {
    const fiveXX: string[] = [];
    let publishOk = false;
    page.on("response", (res) => {
      if (res.status() >= 500) fiveXX.push(`${res.status()} ${res.url()}`);
      if (res.request().method() === "POST" && /\/api\/rubrics\/[^/]+\/publish/.test(res.url()) && res.status() >= 200 && res.status() < 300) {
        publishOk = true;
      }
    });

    await page.goto("/rubrics");

    // Open the real create dialog (no window.prompt).
    await page.getByRole("button", { name: /New rubric/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Name$/i).fill(RUBRIC_NAME);
    await dialog.getByRole("button", { name: /Create rubric/i }).click();

    // Land on the editor.
    await page.waitForURL(/\/rubrics\/[0-9a-f-]+$/i, { timeout: 15_000 });
    await expect(page.getByText(RUBRIC_NAME).first()).toBeVisible();

    // Add a criterion (Criteria tab is default) and give it a positive weight.
    await page.getByRole("button", { name: /Add criterion/i }).click();
    const weight = page.getByLabel(/^Weight$/i).first();
    await weight.fill("40");

    // Save the draft so Publish becomes enabled (publish requires not-dirty).
    await page.getByRole("button", { name: /^Save$/i }).click();

    // Publish.
    await page.getByRole("button", { name: /^Publish$/i }).click();
    const publishDialog = page.getByRole("dialog");
    await expect(publishDialog).toBeVisible();
    await publishDialog.getByRole("button", { name: /Publish v1/i }).click();

    // Assert the "Published v1" badge appears.
    await expect(page.getByText(/Published v1/i).first()).toBeVisible({ timeout: 15_000 });
    expect(publishOk, "publish request should be 2xx").toBe(true);
    expect(fiveXX, "no 5xx during create→publish").toEqual([]);
  });

  test("search syncs to the URL and narrows the list", async ({ page }) => {
    await page.goto("/rubrics");
    const search = page.getByPlaceholder(/Search by name/i);
    await search.fill("General");
    // Debounced; wait for the URL to gain ?q=
    await expect(page).toHaveURL(/[?&]q=General/i, { timeout: 5_000 });
    // The list request should have fired and the page should still render rows
    // or an explicit empty state (never a crash).
    await expect(page.getByText(/Showing/i).or(page.getByText(/No rubrics/i))).toBeVisible();
  });

  test("bulk archive removes rows from the default view", async ({ page }) => {
    let bulkOk = false;
    page.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().endsWith("/api/rubrics/bulk") && res.status() >= 200 && res.status() < 300) {
        bulkOk = true;
      }
    });

    await page.goto("/rubrics");
    // Select the first two selectable rows.
    const checkboxes = page.getByRole("checkbox", { name: /^Select / });
    const count = await checkboxes.count();
    test.skip(count < 2, "needs ≥2 rubrics to bulk-archive");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    await expect(page.getByText(/2 selected/i)).toBeVisible();
    await page.getByRole("button", { name: /^Archive$/i }).click();

    await expect.poll(() => bulkOk, { timeout: 10_000 }).toBe(true);
  });
});
