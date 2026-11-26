---
id: 039
title: Jotform webhook — check and file a signed sign-off within a minute of submission
status: active
priority: medium
depends_on: [038]
created: 2026-11-26
---

# Jotform webhook — check and file a signed sign-off within a minute of submission

## Goal

A parent's signed sign-off reaches its Drive folder
(`<MONTH> / <MONTH> - UNMERGED / <FI> - <MONTH> / First-Last-MM-DD-YYYY-HHMMAM.pdf`)
within about a minute of submission, not at the next hourly sync (today: up to
~1–2 hours, plus GitHub's schedule delay). The hourly sync stays the backstop, so
a missed or failed webhook delays a filing but never loses it.

Why: the studio sees the sign-off land almost as soon as it is signed. Task 038
already planned for this: `lesson-signoff-check.ts` says the webhook "would only
deliver the same submission sooner" without changing the matching.

## Scope

- **One new Vercel route, `api/jotform-webhook.ts`.** Jotform's form webhook
  (Settings → Integrations → Webhooks) POSTs here on each submission.
  - Reads `submissionID` from the body, which is `multipart/form-data`. Vercel does
    not parse that format, so the route reads it with the platform's
    `Request.formData()`; no new package.
  - Uses nothing else in the body. The route **re-fetches the submission from the
    Jotform API by id**, so a forged POST can at most cause a re-check of a real
    submission. It can never sign a lesson.
- **`JotformClient.getSubmission(id)`**: `GET /submission/{id}`, using the same
  envelope rules as `listSubmissions`.
- **One shared per-submission path**, built from the functions that already exist,
  with no second copy of the logic:
  1. Store the submission (`parseSubmission` + the same `jotform_submission` upsert
     `storeNewSubmissions` does, extracted so both callers share it).
  2. Run `processSubmission`, which matches it on `lessonId` and gives the
     `signed` / `mismatch` / `unknown-lesson` / … verdict.
  3. If the verdict is `signed`, run `processFiling` for that lesson.
- **Waiting for the PDF.** The webhook and Jotform's Google Drive integration fire
  together, so `processFiling` can return `waiting-for-pdf`. The route retries
  within a bounded budget (well under Vercel's 60 s cap, e.g. every 5 s for up to
  ~40 s) and then answers 200 anyway. A later PDF is filed by the hourly
  `lesson_signoff_file` pass, as today.
- **Auth: a shared secret in the URL**, `?key=<JOTFORM_WEBHOOK_KEY>`, compared in
  constant time. A Jotform webhook cannot send an `Authorization` header, so the
  bearer check used by `api/sync-job.ts` cannot work here.
- **New setting `JOTFORM_WEBHOOK_KEY`** in config, `.env.example`, Vercel env and
  RUNBOOK. If it is unset, the route answers 503 and does nothing, the same way
  each pass reports `skipped`.
- **Vercel needs the phase-2/3 settings too.** `JOTFORM_*`, `GOOGLE_*` and `SIGNOFF_*`
  must be set as Vercel environment variables, not only GitHub secrets. Today the
  sign-off runs only in GitHub Actions.
- `vercel.json`: `maxDuration: 60` for the new route.
- Docs in the same commit: ARCHITECTURE (route table, sync flow: "pushed, polled
  as backstop"), RUNBOOK (webhook URL setup, key rotation, Vercel env list),
  STATUS, WL-API-NOTES (what Jotform's webhook actually sends, as measured).

## Out of scope

- Fetching the PDF from Jotform ourselves to replace the Drive integration and its
  drop folder. Worth doing only if step 1 shows the PDF often arrives after the
  retry budget, and then as its own task.
- The WellnessLiving attendance webhook (phase 1 trigger). That is a separate
  integration with WL's team; see WL-API-NOTES "Webhooks exist".
- Reminders, the month-end list, the month-end merge (phase 4): unchanged.
- Any change to matching rules or to `jotform_submission` / `lesson_signoff` columns.
  No migration is expected. If one turns out to be needed, it is raised before it
  is written.

## Acceptance criteria

- [ ] A real signed submission on the test form is filed in its Drive folder, with
      the same name and tag the hourly pass would give, within 60 s of submitting,
      with no sync run. Measured and recorded in STATUS.
- [ ] A POST with a wrong or missing `key` gets 401 and touches nothing (no Jotform
      call, no DB write).
- [ ] A POST naming a submission that does not exist, or one whose fields were
      edited, signs nothing: the verdict is `unknown-lesson` / `mismatch`, as in
      phase 2.
- [ ] The same submission delivered twice, or the webhook and the hourly pass
      running together, gives one `signed` lesson, one filed PDF and no duplicate
      folder. The existing guards (`status in (pending,sent)`, `filed_at is null`,
      the Drive tag) are proven by tests to cover the webhook path too.
- [ ] If the PDF has not arrived within the retry budget, the route still answers
      200 and the next hourly run files the PDF.
- [ ] With `JOTFORM_WEBHOOK_KEY` unset, the route is inert (503), and the hourly
      flow is unchanged.
- [ ] The key never appears in a log line or a stored record. A test proves the
      route's logging redacts it.
- [ ] `npm run verify` is green. Each new guarantee is mutation-checked: break it,
      see red, restore.

## Constraints & notes

- **Verify before building (step 1 of the checklist):**
  - the webhook's real payload: field names, content type, and whether
    `submissionID` arrives before or with the PDF;
  - whether Jotform keeps a `?key=` query string on the webhook URL;
  - Jotform's timeout and retry behaviour for webhooks;
  - that `GET /submission/{id}` works with the existing key on the Free plan.

  Record the findings in WL-API-NOTES. Do not assume them.

- **The key in the URL.** It may show in Vercel's request logs, which the
  "credentials never in logs" rule is about. Accepted because the key carries almost
  no power: anyone holding it can only make the route re-check a submission against
  Jotform's own copy. Record this reasoning in RUNBOOK, and rotate the key like any
  other secret.
- Hosts stay configuration (`tests/no-hardcoded-config`). The new route must be
  listed in ARCHITECTURE (`tests/docs-current`).
- Vercel is on the Hobby plan, so functions have a 60 s cap. Jotform submissions
  arrive one at a time, so no queue is needed. A burst only runs several routes in
  parallel, and the guards above make that safe.
- Go-live of the webhook follows the same order as 038: test form and the
  developer's Drive first, then the studio's form and folder once they are confirmed.

## Resources

- None yet. Step 1 adds a captured webhook payload (with personal fields removed)
  as `resources/webhook-sample.txt`.
