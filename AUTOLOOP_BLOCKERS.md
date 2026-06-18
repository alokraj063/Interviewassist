# Autoloop Blockers

Created lazily when a tick can't proceed without human action. Loop never
sits idle on a blocker — it logs here, marks the task `blocked` in
`AUTOLOOP_TASKS.md`, moves on.

## Format

```
## <task-id> — <one-line summary>

- **kind:** missing-api-key | external-account | destructive-migration | repeated-verification-fail | external-rate-limit
- **blocker:** <what's needed from the human>
- **fallback:** <mock provider or skip note>
- **first-hit:** <ISO timestamp>
- **last-tick:** <ISO timestamp>
```

## Entries

(empty)
