# Progress: Jotform webhook — check and file a signed sign-off within a minute of submission

## Checklist

- [x] 1. Check Jotform's webhook from the docs. The 5 s timeout is documented; payload, `?key=` and retry are not. Recorded in WL-API-NOTES. A live capture is still due at step 9.
- [x] 2. `JotformClient.getSubmission(id)` + tests.
- [x] 3. Extract the single-submission store (`storeOneSubmission`, shared `submissionRow`); the hourly pass is unchanged.
- [x] 4. `processWebhookSubmission`: store → `processSubmission` → `processFiling` with a bounded PDF wait under the `lesson_signoff_file` job lock, plus tests.
- [x] 5. `api/jotform-webhook.ts`: constant-time key, multipart/urlencoded/JSON body, 200 at once + `waitUntil`, redacted logging, plus route tests.
- [x] 6. `.env.example` (`JOTFORM_WEBHOOK_KEY`), `vercel.json` entry, `@vercel/functions` 3.11.1 pinned.
- [x] 7. Docs: ARCHITECTURE, RUNBOOK (setup + §4i rotation), STATUS, WL-API-NOTES.
- [x] 8. `npm run verify` green (1,035 tests); 11 mutations red.
- [x] 9. End to end: deploy, set Vercel env + webhook URL on the test form, sign one lesson, time it to the Drive folder; record the real payload in `resources/webhook-sample.txt` (personal fields removed). Done 26 Nov: filed 2 s after signing; payload sample not captured (no personal data kept).

## Last step

Live and tested end to end on 26 Nov 2026. Ready to close once the user confirms.

## Blockers

None in code. Step 9 needs Vercel access and the Jotform form settings.

## Log

### 2026-11-26

- Task created from the user's question on 26 Nov: can a Jotform webhook file the
  form on submission, instead of waiting for the hourly sync?
- Design reuses phase 2/3 per-item functions (`processSubmission`, `processFiling`);
  no migration expected. The hourly passes stay as the backstop.
- Assumed, not yet measured: the webhook payload is multipart with `submissionID`;
  Jotform keeps the URL's query string. Step 1 checks both before any code.
- PRD approved; started.
- Step 1 (docs only): Jotform documents a **5-second webhook timeout**, which rules out
  waiting ~40 s inside the request. The user chose to answer at once and keep working
  under Vercel's `waitUntil` (new dependency `@vercel/functions`) over working only
  inside 5 s. Note: it brings ~18 transitive packages (`@vercel/oidc` and its deps).
- Decided: filing takes the `lesson_signoff_file` job lock per attempt, never across the
  wait, because `FolderResolver` only dedupes folders within one process. A webhook and
  the hourly pass, or two webhooks, could otherwise both create a new `<FI> - <MONTH>`
  folder.
- Decided: the route is a Web-standard `POST(request)` handler, because Vercel's
  `(req, res)` helpers do not parse multipart bodies.
- Deviation from the PRD: an unset `JOTFORM_WEBHOOK_KEY` answers **401**, not 503. That
  is the same answer as a wrong key, as every other route here does, so the route reveals
  nothing about its setup. 503 is kept for missing sign-off settings. The success log goes
  through the project's logger, not `console.info`, which lint forbids.
- End-to-end test on Vercel production: a real lesson link from the hourly sync was
  signed; judged `signed` at 13:39:16.82 UTC, PDF filed at 13:39:18.92 UTC (2 s), no sync
  run. Confirms `submissionID` in the body, `?key=` kept on the URL, and
  `GET /submission/{id}` on the Free plan.
