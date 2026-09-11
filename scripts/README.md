# Operator scripts

Four tools for the person on call. They answer the questions a 2am page raises,
in the order it raises them.

| Run this | To answer |
|---|---|
| `node scripts/queue-status.mjs` | Is it finished? What is left? Has anything been given up on? |
| `node scripts/dead-items.mjs` | What exactly failed, and what did WellnessLiving say? |
| `node scripts/requeue.mjs` | Put given-up items back on the queue |
| `node scripts/window.mjs` | Read, set or clear a job's date range — the manual backfill lever |

Full procedures, with the SQL equivalents for when you have a database console
but not a clone, are in [docs/RUNBOOK.md](../docs/RUNBOOK.md) sections 7–9.

## Before the first run

```bash
npm ci
npm run build      # the scripts import from dist/
```

They read `.env` from the repository root. A missing `.env` or a missing
`dist/` stops the script with a one-line explanation rather than a stack trace —
the failure mode being avoided is a script that silently reads the ambient
environment and points at the wrong database.

Every script prints the environment and business id before it does anything:

```
queue status  ·  env=dev  ·  business=334942
```

Check that line before acting on what follows. To target the other environment,
set it ahead of the command — the ambient value wins over `.env`:

```bash
APP_ENV=prod node scripts/queue-status.mjs
```

## Writing is opt-in

`queue-status` and `dead-items` are read-only and safe to run against
production at any time.

`requeue` and `window` **write**, and both are dry-run by default: they print
what they would change and exit. Add `--apply` to make it happen. This is not
politeness — the natural mistake is re-queueing a whole work type when only one
cause within it is worth retrying, and that mistake is invisible until the same
items die again the following night.

## Why these and not the others

The repository has accumulated a large number of one-off diagnostic scripts.
They are deliberately not here: each was written against one question on one
day, most hardcode a single `work_type`, and promoting them would enshrine
those assumptions as if they were the interface. These four are general, take
arguments, and are the ones a recovery actually needs.
