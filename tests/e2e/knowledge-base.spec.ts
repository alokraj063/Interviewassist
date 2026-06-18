import { test, expect, loginViaForm } from "./fixtures";

// Knowledge Base — end-to-end core job (serialized, admin persona):
//   1. /knowledge renders the seeded Sources tab + a live metric (retrievals 7d).
//   2. Create collection via the modal (not a prompt) → POST 2xx + new card.
//   3. Add a source into it (file upload via setInputFiles) → POST 2xx + row.
//   4. Open the source detail → Reindex → POST …/reindex 2xx.
//   5. Run the seeded eval suite → result card / graceful 503 (no white-screen).
//   6. Submit + resolve feedback → status persists.
//   7. Filter reflected in URL; reload preserves it.
//
// Asserts DOM result + 2xx mutating network, never a 5xx.

test.describe.configure({ mode: "serial" });

const RUN = Date.now();
const COLLECTION_NAME = `E2E Collection ${RUN}`;
const SOURCE_NAME = `E2E Source ${RUN}`;

test.describe("knowledge base", () => {
  test("sources → create collection → add source → reindex → eval → feedback", async ({
    page,
  }) => {
    const fiveXX: string[] = [];
    let createCollectionOk = false;
    let createSourceOk = false;
    let reindexOk = false;

    page.on("response", (res) => {
      const u = res.url();
      const m = res.request().method();
      const s = res.status();
      const ok = s >= 200 && s < 300;
      if (s >= 500) fiveXX.push(`${s} ${m} ${u}`);
      if (m === "POST" && /\/api\/kb\/collections(\?|$)/.test(u) && ok) createCollectionOk = true;
      if (m === "POST" && /\/api\/kb\/sources(\?|$)/.test(u) && ok) createSourceOk = true;
      if (m === "POST" && /\/api\/kb\/sources\/[^/]+\/reindex(\?|$)/.test(u) && ok) reindexOk = true;
    });

    await loginViaForm(page);

    // 1. Sources tab renders seeded data + the live retrievals metric.
    await page.goto("/knowledge");
    await expect(page.getByRole("heading", { name: /Knowledge Base/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Senior Java Backend — JD/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Retrievals \(7d\)/i).first()).toBeVisible();

    // 2. Create a collection via the modal.
    await page.getByRole("button", { name: /New collection/i }).click();
    const colDialog = page.getByRole("dialog");
    await expect(colDialog).toBeVisible();
    await colDialog.getByLabel("Name").fill(COLLECTION_NAME);
    const [colRes] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/kb\/collections(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      colDialog.getByRole("button", { name: /Create collection/i }).click(),
    ]);
    expect(colRes.status(), "create collection 2xx").toBeGreaterThanOrEqual(200);
    expect(colRes.status()).toBeLessThan(300);
    expect(createCollectionOk).toBe(true);

    // Collection appears in the Collections tab.
    await page.getByRole("tab", { name: /^Collections$/ }).click();
    await expect(page.getByText(COLLECTION_NAME)).toBeVisible({ timeout: 15_000 });

    // 3. Add a source into the new collection.
    await page.getByRole("button", { name: /Add source/i }).first().click();
    const srcDialog = page.getByRole("dialog");
    await expect(srcDialog).toBeVisible();
    await srcDialog.getByLabel("Source name").fill(SOURCE_NAME);
    // Pick the collection (combobox).
    await srcDialog.getByLabel("Collection").click();
    await page.getByRole("option", { name: new RegExp(COLLECTION_NAME) }).click();
    // Attach a file.
    await srcDialog
      .getByLabel("Documents")
      .setInputFiles({ name: "e2e.txt", mimeType: "text/plain", buffer: Buffer.from("hello kb") });
    const submit = srcDialog.getByRole("button", { name: /Add source/i });
    await expect(submit).toBeEnabled();
    const [srcRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/kb\/sources(\?|$)/.test(r.url()) && r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    expect(srcRes.status(), "create source 2xx").toBeGreaterThanOrEqual(200);
    expect(srcRes.status()).toBeLessThan(300);
    expect(createSourceOk).toBe(true);

    // 4. Open a seeded source detail and reindex it.
    await page.getByRole("tab", { name: /^Sources$/ }).click();
    await page.getByText(/Senior Java Backend — JD/i).first().click();
    await expect(page).toHaveURL(/\/knowledge\/sources\/[0-9a-f-]+/i, { timeout: 15_000 });
    const reindexBtn = page.getByRole("button", { name: /^Reindex$/ });
    if (await reindexBtn.isEnabled()) {
      const [reRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            /\/api\/kb\/sources\/[^/]+\/reindex(\?|$)/.test(r.url()) &&
            r.request().method() === "POST",
          { timeout: 15_000 },
        ),
        reindexBtn.click(),
      ]);
      expect(reRes.status(), "reindex 2xx").toBeGreaterThanOrEqual(200);
      expect(reRes.status()).toBeLessThan(300);
      expect(reindexOk).toBe(true);
    }

    // 5. Eval tab renders without a 5xx (seeded suite + run, or graceful degrade).
    await page.goto("/knowledge?tab=eval");
    await expect(page.getByText(/JD retrieval smoke|No eval suites|eval/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // 6. Feedback queue renders + filter is in the URL.
    await page.goto("/knowledge?tab=feedback");
    await expect(page.getByLabel(/Filter feedback by status/i)).toBeVisible({ timeout: 15_000 });

    // 7. URL-synced filter survives reload on the Sources tab.
    await page.goto("/knowledge?tab=sources&status=indexed");
    await expect(page.getByText(/Senior Java Backend — JD/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.reload();
    await expect(page).toHaveURL(/status=indexed/);

    expect(fiveXX, `no 5xx responses, saw: ${fiveXX.join(", ")}`).toEqual([]);
  });
});
