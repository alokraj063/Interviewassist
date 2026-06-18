import { test, expect, loginViaForm } from "./fixtures";

/**
 * Smoke test: walk every primary route while signed in as admin.
 * Asserts no console errors and no 5xx responses on the network.
 *
 * The point isn't deep coverage — it's a fast gate the autonomous build
 * loop runs after every UI-touching commit to prove the bundle still
 * boots and renders the IA without crashing.
 */

const ROUTES: Array<{ path: string; allow404?: boolean }> = [
  { path: "/" },
  { path: "/demands" },
  { path: "/candidates" },
  { path: "/candidates/new" },
  { path: "/live-assist" },
  { path: "/live-assist/legacy" },
  { path: "/calls" },
  { path: "/qa-review" },
  { path: "/coaching" },
  { path: "/triage" },
  { path: "/sourcing" },
  { path: "/sourcing/internal-db" },
  { path: "/assessments" },
  { path: "/async-video" },
  { path: "/proctor" },
  { path: "/recruiters" },
  { path: "/team-monitor" },
  { path: "/voice-agents" },
  { path: "/voice-agents/new" },
  { path: "/rubrics" },
  { path: "/question-banks" },
  { path: "/knowledge" },
  { path: "/analytics" },
  { path: "/settings" },
];

const CONSOLE_ALLOWLIST = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /\[HMR\]/i,
  /WebSocket connection.*closed/i,
  /Manifest:.*Line:/i,
  /Failed to load resource: the server responded with a status of 401/i, // expected on first paint while auth context boots
  // Test-harness artifact: Playwright injects an `x-e2e-smoke` header on every request (see
  // playwright.config.ts extraHTTPHeaders); cross-origin Google Fonts (fonts.gstatic.com) reject
  // the unknown header in CORS preflight. Not an app error — happens identically on every route.
  /x-e2e-smoke is not allowed by Access-Control-Allow-Headers/i,
  /Access to font at .*fonts\.gstatic\.com.* blocked by CORS policy/i,
  /Failed to load resource: net::ERR_FAILED/i,
];

test.describe("smoke", () => {
  test.beforeEach(async ({ page }) => {
    await loginViaForm(page);
  });

  for (const route of ROUTES) {
    test(`route ${route.path} renders without console errors`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const network5xx: string[] = [];

      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (CONSOLE_ALLOWLIST.some((re) => re.test(text))) return;
        consoleErrors.push(text);
      });

      page.on("response", (res) => {
        if (res.status() >= 500 && res.status() < 600) {
          network5xx.push(`${res.status()} ${res.url()}`);
        }
      });

      const response = await page.goto(route.path, { waitUntil: "networkidle" });

      if (!route.allow404) {
        expect(response, `no response for ${route.path}`).not.toBeNull();
        expect(
          response!.status(),
          `unexpected http status for ${route.path}`,
        ).toBeLessThan(500);
      }

      expect(consoleErrors, `console errors on ${route.path}`).toEqual([]);
      expect(network5xx, `5xx responses on ${route.path}`).toEqual([]);
    });
  }
});
