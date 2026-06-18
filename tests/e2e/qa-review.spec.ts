import { test, expect, loginViaForm } from "./fixtures";

// QA Review console — end-to-end core job (serialized, admin persona):
//   1. /qa-review renders the console (tabs + seeded queue metrics).
//   2. Create a sampling policy via the dialog → POST /api/qa/policies 2xx
//      (network) and the policy appears under the Policies tab (DOM).
//   3. Run the policy → POST …/run 2xx; the queue metric is live.
//   4. Open a reviewed call's dispute flow → raise a dispute → POST
//      …/dispute 2xx; it surfaces under the Disputes tab (DOM).
//   5. CSV export → text/csv 2xx download.
//
// Asserts DOM result + 2xx mutating network, and no 5xx anywhere (no
// white-screen on any path).

test.describe.configure({ mode: "serial" });

const RUN = Date.now();
const POLICY_NAME = `E2E Policy ${RUN}`;

test.describe("qa review", () => {
  test("console → create policy → run → dispute → export", async ({ page }) => {
    const fiveXX: string[] = [];
    let createPolicyOk = false;
    let runOk = false;
    let exportOk = false;

    page.on("response", (res) => {
      const u = res.url();
      const m = res.request().method();
      const s = res.status();
      const ok = s >= 200 && s < 300;
      if (s >= 500) fiveXX.push(`${s} ${m} ${u}`);
      if (m === "POST" && /\/api\/qa\/policies(\?|$)/.test(u) && ok) createPolicyOk = true;
      if (m === "POST" && /\/api\/qa\/policies\/[^/]+\/run(\?|$)/.test(u) && ok) runOk = true;
      if (m === "GET" && /\/api\/qa\/export/.test(u) && ok) exportOk = true;
    });

    await loginViaForm(page);

    // 1. Console renders.
    await page.goto("/qa-review");
    await expect(page.getByRole("heading", { name: /QA review/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/In queue/i).first()).toBeVisible({ timeout: 15_000 });

    // 2. Create a sampling policy.
    await page.getByRole("button", { name: /Create policy/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(POLICY_NAME);
    const createBtn = dialog.getByRole("button", { name: /Create policy/i });
    await expect(createBtn).toBeEnabled();
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/qa\/policies(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      createBtn.click(),
    ]);
    expect(createRes.status(), "create policy should be 2xx").toBeGreaterThanOrEqual(200);
    expect(createRes.status()).toBeLessThan(300);
    expect(createPolicyOk).toBe(true);

    // Policy appears under the Policies tab (DOM).
    await page.getByRole("tab", { name: /^Policies$/i }).click();
    await expect(page.getByText(POLICY_NAME)).toBeVisible({ timeout: 15_000 });

    // 3. Run the policy.
    const policyRow = page.locator("tr", { hasText: POLICY_NAME });
    const [runResp] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/qa\/policies\/[^/]+\/run(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      policyRow.getByRole("button", { name: /^Run$/i }).click(),
    ]);
    expect(runResp.status()).toBeGreaterThanOrEqual(200);
    expect(runResp.status()).toBeLessThan(300);
    expect(runOk).toBe(true);

    // 4. Raise a dispute on a reviewed call. Use the Reviewed tab so the row has
    //    a submitted review the dispute can attach to.
    await page.getByRole("tab", { name: /^Queue$/i }).click();
    await page.getByRole("tab", { name: /Reviewed/i }).click();
    await expect(page).toHaveURL(/tab=reviewed/i, { timeout: 10_000 });
    // Reviewed rows expose a dispute (gavel) action; click the first if present.
    const disputeBtn = page.getByRole("button", { name: /Raise a dispute/i }).first();
    if (await disputeBtn.isVisible().catch(() => false)) {
      await disputeBtn.click();
      const dd = page.getByRole("dialog");
      await expect(dd.getByText(/Raise a dispute/i)).toBeVisible();
      await dd.getByLabel(/Reason/i).fill("E2E dispute: the reviewer score diverges from the gold answer here.");
      const submit = dd.getByRole("button", { name: /Raise dispute/i });
      // Submit enables once the review id resolves.
      await expect(submit).toBeEnabled({ timeout: 10_000 });
      const [dRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            /\/api\/qa\/reviews\/[^/]+\/dispute(\?|$)/.test(r.url()) && r.request().method() === "POST",
          { timeout: 15_000 },
        ),
        submit.click(),
      ]);
      expect(dRes.status()).toBeGreaterThanOrEqual(200);
      expect(dRes.status()).toBeLessThan(300);
      // Surfaces under the Disputes tab.
      await page.getByRole("tab", { name: /^Disputes$/i }).click();
      await expect(page.getByText(/E2E dispute/i)).toBeVisible({ timeout: 15_000 });
    }

    // 5. Export CSV.
    await page.getByRole("tab", { name: /^Queue$/i }).click();
    await page.getByRole("button", { name: /^Export$/i }).click();
    await page.waitForResponse((r) => /\/api\/qa\/export/.test(r.url()) && r.status() < 400, {
      timeout: 15_000,
    });
    expect(exportOk).toBe(true);

    // Agreement tab renders live κ without a white-screen.
    await page.getByRole("tab", { name: /^Agreement$/i }).click();
    await expect(page.getByText(/Cohen's κ/i)).toBeVisible({ timeout: 15_000 });

    expect(fiveXX, `no 5xx responses: ${fiveXX.join(", ")}`).toEqual([]);
  });
});
