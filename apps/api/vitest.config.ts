import { defineConfig } from "vitest/config";

// Backend integration-test runner. Node environment (no jsdom — this is
// Fastify + Postgres, not the SPA). `globalSetup` stands up a disposable
// `recruitassist_itest` database (migrated + seeded) once per run and tears
// it down at the end; see src/test/globalSetup.ts.
//
// Page-build agents drop `*.itest.ts` specs under src/** and assert against
// the booted app via the harness in src/test/harness.ts. Run with:
//   pnpm --filter @j2w/api test
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.itest.ts"],
    globalSetup: ["src/test/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Serialize DB access: every spec shares one disposable Postgres DB, so
    // running them in parallel forks would race on the same rows. A single
    // fork keeps the suite deterministic.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
