# Deletions Manifest

Append-only log of files/components removed by the autonomous build loop.
Each row: path, reason, replacement (if any), tick id, commit sha.

Recovery: `git log --diff-filter=D --name-only --pretty=format:%H -- <path>`
gives you the commit; `git revert <sha>` undoes a specific deletion.

## Format

```
- **<path>** (commit `<sha>`, task `<id>`)
  - reason: <one-line>
  - replacement: <path or "—">
```

## Entries

- **apps/web/eslint.config.js** (commit `e04b0a3`, task `T0.1`)
  - reason: subsumed by root `eslint.config.mjs` which scopes React rules to `apps/web/**` via flat-config files override; single workspace-wide lint is the new entry point.
  - replacement: `eslint.config.mjs` at repo root

- **apps/api/src/rag/summary.ts** (commit `e34a5af`, task `T1.1`)
  - reason: in-process call summarization moved to the new BullMQ
    `call_summary` worker so retries and backoff are handled and the API
    request returns fast.
  - replacement: `apps/worker/src/jobs/callSummary.ts`

- **apps/api/src/resume/extract.ts** (and the now-empty `apps/api/src/resume/` directory) (commit `7c9c8d3`, task `T1.7`)
  - reason: resume extract logic promoted to `packages/ingest-shared/src/resume.ts` so the new `resume_parse` worker (and any future worker) can use it without pulling apps/api into its dependency graph.
  - replacement: `@j2w/ingest-shared` exports `extractResumeFields`, `ParsedResume`, etc.
