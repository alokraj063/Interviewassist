# E2E smoke harness

Playwright smoke tests for the autonomous build loop's verification gate.

## Run locally

Stack must be reachable. Either:

```bash
# Reuses any running dev stack on the configured ports
pnpm e2e:smoke
```

or set explicit URLs:

```bash
WEB_URL=http://localhost:8084 API_URL=http://localhost:8788 \
  E2E_NO_WEBSERVER=1 pnpm e2e:smoke
```

`E2E_NO_WEBSERVER=1` skips Playwright's auto-start of `pnpm dev`. Set
this when you already have the dev stack up — Playwright's reuse logic
is fine in steady state, but skipping the webserver block makes the
"already running" path explicit.

## Browser binaries

First run on a new machine:

```bash
pnpm exec playwright install chromium
```

The harness only uses Chromium to keep CI minutes down.

## Auth

`fixtures.ts` logs in as `admin@recruitassist.local` / `Recruiter#2026`
(seeded by `pnpm db:seed`). Override via `E2E_ADMIN_EMAIL` and
`E2E_ADMIN_PASSWORD` if running against a non-seeded DB.

## What's covered

`smoke.spec.ts` walks every primary IA route signed in as admin and
asserts:

- HTTP status `< 500` on the page response
- No console errors (dev-noise allowlist applied)
- No 5xx responses on the network

The list is intentionally shallow. As real wiring lands, ticks add
deeper specs alongside (e.g. `prospects.spec.ts`, `calls.spec.ts`).

## When it fails

Failure artifacts in `playwright-report/` and `test-results/`. Both are
gitignored; the loop's tick reads them, surfaces the failure to the
blocker file, then reverts.
