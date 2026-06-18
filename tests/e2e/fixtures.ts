import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@recruitassist.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "Recruiter#2026";

const API_PORT = process.env.API_PORT ?? "8788";
const API_URL = process.env.API_URL ?? `http://localhost:${API_PORT}`;

type AuthFixtures = {
  signedInPage: Page;
  apiToken: string;
};

/**
 * Authenticated page fixture. Logs in via the form to ensure the refresh
 * cookie + access token are both set the way the running app expects.
 */
export const test = base.extend<AuthFixtures>({
  apiToken: async ({ request }, use) => {
    const token = await loginViaApi(request);
    await use(token);
  },
  signedInPage: async ({ page, context }, use) => {
    await loginViaForm(page);
    await use(page);
    await context.clearCookies().catch(() => {});
  },
});

export { expect };

export async function loginViaApi(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { "content-type": "application/json" },
  });
  if (!res.ok()) {
    throw new Error(
      `[e2e] login failed: ${res.status()} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error("[e2e] login response missing accessToken");
  }
  return body.accessToken;
}

export async function loginViaForm(page: Page): Promise<void> {
  // The app's sign-in route is /sign-in (leads with SSO buttons + an
  // email/password form). /login is not a registered route.
  await page.goto("/sign-in");
  // Fail fast on environment contamination: playwright's webServer health-gate
  // only checks for a bare HTTP 200, so reuseExistingServer can silently attach
  // to a foreign build squatting on :8084. That build rejects the seeded .local
  // admin and masks the real cause as a generic login timeout. Assert we're on
  // the RecruitAssist build before touching the form so the failure is legible.
  const title = await page.title().catch(() => "");
  if (title && !/recruitassist/i.test(title)) {
    throw new Error(
      `[e2e] sign-in page is not the RecruitAssist build (document title=${JSON.stringify(
        title,
      )}). A stale/foreign dev server is likely squatting on the web port — ` +
        `stop it before running e2e (reuseExistingServer attaches to whatever answers).`,
    );
  }
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(
      (url) => !url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/login"),
      { timeout: 15_000 },
    ),
    page.locator("button[type=submit]").click(),
  ]);
}
