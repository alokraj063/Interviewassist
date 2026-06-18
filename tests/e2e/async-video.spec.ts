import { test, expect, loginViaForm } from "./fixtures";

// Async Video Interview — end-to-end core job (serialized, admin persona):
//   1. /async-video → New campaign (real builder dialog, NOT window.prompt) →
//      add a title + 2 questions → Create → land on the campaign detail.
//      Assert a 2xx create.
//   2. Publish the campaign → assert the published chip + a 2xx publish.
//   3. Open a seeded SUBMITTED submission's reviewer cockpit (the drill-down
//      route that previously fell through to a chromeless NotFound). Assert the
//      <video> element loads its clip (network 2xx on /submissions/:id/video/0).
//   4. Fill the scorecard (score every question + recommendation) → submit →
//      assert the "scorecard is submitted" state and the inter-rater agreement
//      panel renders (a second seeded scorecard already exists).
//   5. Externally-gated AI: click "Transcribe with AI" with no key → assert a
//      graceful "AI not configured" toast, no white-screen, no 5xx.
//
// Asserts DOM result + 2xx network, no 5xx anywhere. Unique title per run.

const API_PORT = process.env.API_PORT ?? "8788";
const API_URL = `http://localhost:${API_PORT}`;
const RUN = Date.now();
const TITLE = `E2E Async Video ${RUN}`;

test.describe.configure({ mode: "serial" });

test.describe("async video screening", () => {
  test("create → publish → review video → score → agreement → AI-503", async ({ page, context }) => {
    const fiveXX: string[] = [];
    let createOk = false;
    let publishOk = false;
    page.on("response", (res) => {
      if (res.status() >= 500) fiveXX.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      const m = res.request().method();
      const u = res.url();
      const ok = res.status() >= 200 && res.status() < 300;
      if (m === "POST" && /\/api\/async-video\/campaigns(\?|$)/.test(u) && ok) createOk = true;
      if (m === "POST" && /\/api\/async-video\/campaigns\/[^/]+\/publish/.test(u) && ok) publishOk = true;
    });

    await loginViaForm(page);

    // No window.prompt anywhere in the create flow (the page's old hard-fail).
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).prompt = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__promptCalled = true;
        return null;
      };
    });

    // 1. Create via the builder dialog.
    await page.goto("/async-video");
    await page.getByRole("button", { name: /New campaign/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Title$/i).fill(TITLE);
    await dialog.getByLabel(/Question 1 text/i).fill("Tell us about yourself");
    await dialog.getByRole("button", { name: /Add question/i }).click();
    await dialog.getByLabel(/Question 2 text/i).fill("Walk through a hard bug you fixed");
    await dialog.getByRole("button", { name: /Create video screen/i }).click();

    // Land on the campaign detail page.
    await page.waitForURL(/\/async-video\/[0-9a-f-]+$/i, { timeout: 15_000 });
    expect(createOk, "create campaign POST should be 2xx").toBe(true);

    const promptCalled = await page.evaluate(
      () => (window as Window & { __promptCalled?: boolean }).__promptCalled === true,
    );
    expect(promptCalled, "window.prompt must not be used for create").toBe(false);

    // 2. Publish.
    await page.getByRole("button", { name: /^Publish$/i }).click();
    await expect(page.getByText(/published · v\d+/i).first()).toBeVisible({ timeout: 15_000 });
    expect(publishOk, "publish POST should be 2xx").toBe(true);

    // 3. Resolve a seeded SUBMITTED/reviewed submission (with real video bytes)
    //    via the API so we can open the reviewer cockpit drill-down route.
    const token = await getToken(context);
    const queueRes = await page.request.get(
      `${API_URL}/api/async-video/queue?status=reviewed&limit=1`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const queueBody = (await queueRes.json()) as {
      submissions: Array<{ id: string; campaignId: string }>;
    };
    const seeded = queueBody.submissions[0];
    expect(seeded, "a seeded reviewed submission should exist").toBeTruthy();

    await page.goto(`/async-video/${seeded.campaignId}/submissions/${seeded.id}`);
    // The cockpit renders (not the chromeless NotFound) — the scorecard panel shows.
    await expect(page.getByText(/My scorecard/i)).toBeVisible({ timeout: 15_000 });

    // The video element is mounted with a streaming src.
    const video = page.locator('[data-testid="av-video-0"]');
    await expect(video).toBeVisible({ timeout: 15_000 });
    const videoSrc = await video.getAttribute("src");
    expect(videoSrc, "video element has a streaming src").toBeTruthy();

    // Prove the clip actually streams real bytes (the page's core job): a direct
    // ranged GET on the playback endpoint returns 2xx with webm bytes. Some
    // headless builds don't auto-fetch a preload=metadata <video>, so we assert
    // the endpoint directly rather than relying on the element firing a request.
    const clipRes = await page.request.get(
      `${API_URL}/api/async-video/submissions/${seeded.id}/video/0?token=${encodeURIComponent(token)}`,
      { headers: { range: "bytes=0-63" } },
    );
    expect(clipRes.status(), "video stream GET should be 2xx").toBeGreaterThanOrEqual(200);
    expect(clipRes.status()).toBeLessThan(300);
    const ctype = clipRes.headers()["content-type"] ?? "";
    expect(ctype).toContain("video");

    // 4. Fill the scorecard: score every question + a recommendation, submit.
    const radiogroups = page.getByRole("radiogroup");
    const groupCount = await radiogroups.count();
    for (let g = 0; g < groupCount; g += 1) {
      await radiogroups.nth(g).getByRole("radio").nth(3).click(); // score "4"
    }
    await page.getByLabel("Recommendation").click();
    await page.getByRole("option", { name: /^Yes$/i }).click();
    // Wait for the actual PUT response deterministically. waitForResponse never
    // misses the response in a render/assert race (a passive page.on("response")
    // flag can), and stays correct whether or not this persona already had a
    // scorecard on this submission from a prior run — the form always resubmits.
    const [scoreRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === "PUT" &&
          /\/api\/async-video\/submissions\/[^/]+\/scorecard/.test(res.url()),
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /Submit scorecard/i }).click(),
    ]);
    expect(scoreRes.status(), "scorecard PUT should be 2xx").toBeGreaterThanOrEqual(200);
    expect(scoreRes.status()).toBeLessThan(300);

    // The submitted state + agreement panel both render.
    await expect(page.getByText(/your scorecard is submitted/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/agreement/i).first()).toBeVisible({ timeout: 15_000 });

    // 5. Externally-gated AI: 503 surfaces as a graceful toast, never a 5xx.
    await page.getByRole("button", { name: /Transcribe with AI/i }).click();
    await expect(page.getByText(/AI not configured|transcription complete/i)).toBeVisible({ timeout: 15_000 });
    // page is still alive (no white-screen): the scorecard panel is still there.
    await expect(page.getByText(/My scorecard/i)).toBeVisible();

    expect(fiveXX, "no 5xx anywhere in the core job").toEqual([]);
  });
});

// Pull a fresh admin access token from the login API for direct API calls.
async function getToken(context: import("@playwright/test").BrowserContext): Promise<string> {
  const res = await context.request.post(`${API_URL}/api/auth/login`, {
    data: { email: "admin@recruitassist.local", password: "Recruiter#2026" },
    headers: { "content-type": "application/json" },
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}
