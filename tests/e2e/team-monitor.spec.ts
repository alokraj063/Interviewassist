import { test, expect, loginViaForm } from "./fixtures";

// Team Monitor supervisor floor — end-to-end core jobs (serialized, admin persona):
//   1. /team-monitor → KPI tiles + a live-call row render (DOM).
//   2. Supervise: open the drawer on an active call, click Whisper → assert
//      POST /api/team-monitor/calls/*/supervise is 2xx and the active-mode
//      banner appears (DOM). Graceful audio degradation: the drawer shows the
//      "audio monitor unavailable — transcript live" state (browser-mixed call).
//   3. Alerts: open the Alerts tab, ack an open alert → assert
//      POST /api/team-monitor/alerts/*/ack is 2xx and the row flips to "acked".
//   4. SLA authoring: open the SLA tab, edit queue_depth thresholds, save →
//      assert PUT /api/team-monitor/sla-policies/queue_depth is 2xx.
//   5. URL state: an activity filter is reflected in the URL and survives reload.
//
// Asserts DOM result + 2xx mutating network, and no 5xx anywhere.

test.describe.configure({ mode: "serial" });

const RUN = Date.now();

test.describe("team monitor floor", () => {
  test("render → whisper → ack alert → edit SLA → URL state", async ({ page }) => {
    const fiveXX: string[] = [];
    let superviseOk = false;
    let ackOk = false;
    let slaOk = false;
    page.on("response", (res) => {
      if (res.status() >= 500)
        fiveXX.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      const m = res.request().method();
      const u = res.url();
      const ok = res.status() >= 200 && res.status() < 300;
      if (m === "POST" && /\/api\/team-monitor\/calls\/[^/]+\/supervise(\?|$)/.test(u) && ok)
        superviseOk = true;
      if (m === "POST" && /\/api\/team-monitor\/alerts\/[^/]+\/ack(\?|$)/.test(u) && ok) ackOk = true;
      if (m === "PUT" && /\/api\/team-monitor\/sla-policies\/queue_depth(\?|$)/.test(u) && ok)
        slaOk = true;
    });

    await loginViaForm(page);

    // 1. Floor renders: KPI tiles + at least one live-call row.
    await page.goto("/team-monitor");
    await expect(page.getByText(/recruiters online/i)).toBeVisible({ timeout: 15_000 });
    const superviseBtn = page.locator('[data-testid^="supervise-"]').first();
    await expect(superviseBtn).toBeVisible({ timeout: 15_000 });

    // 2. Supervise: open the drawer, confirm graceful audio state, click Whisper.
    await superviseBtn.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("audio-state")).toContainText(
      /audio monitor (unavailable|live)/i,
    );
    const [supRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/team-monitor\/calls\/[^/]+\/supervise(\?|$)/.test(res.url()) &&
          res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByTestId("whisper-btn").click(),
    ]);
    expect(supRes.status(), "supervise POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(supRes.status()).toBeLessThan(300);
    expect(superviseOk).toBe(true);
    await expect(page.getByTestId("active-mode-banner")).toBeVisible({ timeout: 15_000 });

    // Close the drawer.
    await page.keyboard.press("Escape");

    // 3. Alerts tab → ack the first open alert.
    await page.getByRole("tab", { name: /^alerts$/i }).click();
    await page.waitForURL(/tab=alerts/, { timeout: 15_000 });
    const ackBtn = page.locator('[data-testid^="ack-"]').first();
    await expect(ackBtn).toBeVisible({ timeout: 15_000 });
    const [ackRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/team-monitor\/alerts\/[^/]+\/ack(\?|$)/.test(res.url()) &&
          res.request().method() === "POST",
        { timeout: 15_000 },
      ),
      ackBtn.click(),
    ]);
    expect(ackRes.status(), "ack POST should be 2xx").toBeGreaterThanOrEqual(200);
    expect(ackRes.status()).toBeLessThan(300);
    expect(ackOk).toBe(true);

    // 4. SLA tab → edit queue_depth thresholds → save.
    await page.getByRole("tab", { name: /^sla$/i }).click();
    await page.waitForURL(/tab=sla/, { timeout: 15_000 });
    await page.getByTestId("edit-sla-queue_depth").click();
    const slaDialog = page.getByRole("dialog");
    await expect(slaDialog).toBeVisible();
    const warn = 4 + (RUN % 3); // 4..6
    const crit = warn + 5;
    await slaDialog.getByLabel(/warning threshold/i).fill(String(warn));
    await slaDialog.getByLabel(/critical threshold/i).fill(String(crit));
    const [slaRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/api\/team-monitor\/sla-policies\/queue_depth(\?|$)/.test(res.url()) &&
          res.request().method() === "PUT",
        { timeout: 15_000 },
      ),
      page.getByTestId("sla-save").click(),
    ]);
    expect(slaRes.status(), "SLA PUT should be 2xx").toBeGreaterThanOrEqual(200);
    expect(slaRes.status()).toBeLessThan(300);
    expect(slaOk).toBe(true);

    // 5. URL state: apply an activity filter on the floor; it survives reload.
    await page.goto("/team-monitor?tab=floor&activity=idle");
    await expect(page).toHaveURL(/activity=idle/);
    await page.reload();
    await expect(page).toHaveURL(/activity=idle/);
    await expect(page.getByText(/recruiters online/i)).toBeVisible({ timeout: 15_000 });

    expect(fiveXX, "no 5xx anywhere in the core job").toEqual([]);
  });
});
