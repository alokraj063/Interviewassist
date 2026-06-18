import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = process.env.WEB_PORT ?? "8084";
const API_PORT = process.env.API_PORT ?? "8788";

const WEB_URL = process.env.WEB_URL ?? `http://localhost:${WEB_PORT}`;
const API_URL = process.env.API_URL ?? `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: {
      "x-e2e-smoke": "1",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : [
        {
          command: "pnpm dev",
          cwd: "../..",
          url: WEB_URL,
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: "ignore",
          stderr: "pipe",
          env: {
            WEB_PORT,
            API_PORT,
            VITE_API_BASE_URL: API_URL,
            VITE_WS_BASE_URL: API_URL.replace(/^http/, "ws"),
            // Force the AI-draft "BLOCKED-on-credential" stub path so the
            // recruiters e2e exercises the graceful 503 nudge-draft UI even on
            // dev machines that have a real OPENAI_API_KEY in .env. dotenv does
            // not override an already-present env var, so an empty string here
            // wins over the .env value.
            OPENAI_API_KEY: "",
          },
        },
      ],
  metadata: {
    apiUrl: API_URL,
    webUrl: WEB_URL,
  },
});
