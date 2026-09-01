# Runbook — environment configuration and credential rotation

Project `HRRAFEBAV`. Covers the sync service foundation layer: what secrets exist, where
they live, how the app reads them, and how to rotate each one.

Reference: `2026-08-06_HRRAFEBAV_Sync-Architecture_v1.md` §2a · PRD module M01.

---

## 1. The secret inventory

Ten keys per environment. `dev` and `prod` values are **all** different — assume nothing
carries over.

| Key                         | Kind                   | Rotatable | Owner / source                                 |
| --------------------------- | ---------------------- | --------- | ---------------------------------------------- |
| `WL_API_HOST`               | environment coordinate | no        | WellnessLiving (data host)                     |
| `WL_AUTH_HOST`              | environment coordinate | no        | WellnessLiving (token host — NOT the data host) |
| `WL_ID_REGION`              | environment coordinate | no        | WellnessLiving (docs use 2, production uses 1) |
| `WL_K_BUSINESS`             | environment coordinate | no        | WellnessLiving business record                 |
| `WL_CLIENT_ID`              | credential             | yes       | WL Integrations team                           |
| `WL_CLIENT_SECRET`          | credential             | yes       | WL Integrations team                           |
| `SUPABASE_URL`              | environment coordinate | no        | Supabase project settings → API                |
| `SUPABASE_SERVICE_ROLE_KEY` | credential             | yes       | Supabase project settings → API keys           |
| `GHL_API_TOKEN`             | credential             | yes       | GoHighLevel private integration                |
| `GHL_LOCATION_ID`           | environment coordinate | no        | GoHighLevel location                           |

### Route tokens (separate from the ten above)

The deployed HTTP routes are guarded by their own bearer tokens, read straight from the
process environment rather than the secrets bundle - they protect *our* endpoints and are not
credentials for anyone else's API.

| Variable             | Accepted on                              | Notes                                                        |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `HEALTHCHECK_TOKEN`  | the read-only routes only                | `/api/health`, `/api/sync-status`. Cannot start a sync.      |
| `SYNC_TRIGGER_TOKEN` | every route                              | The manual trigger.                                          |
| `CRON_SECRET`        | every route                              | Vercel Cron sends this as the bearer automatically.          |

Each route accepts **any** of the tokens listed for it, compared in constant time and with
every candidate compared even after a match, so the timing does not reveal which one matched
([`src/http/bearer.ts`](../src/http/bearer.ts)). The split is deliberate: a token handed out
so somebody can poll a status page must not also be able to start a backfill.

An unset variable never opens anything - it is skipped as a candidate, and a route whose
every candidate is unset answers 401 to everyone. There is no "no token configured, so allow
it" path.

Rotate by generating a new random string, setting it in Vercel's environment variables, and
redeploying. There is no third party to coordinate with, so rotation is immediate and safe to
do at any time.

### SMTP (separate again, and optional)

The dead-letter notifier reads its own variables straight from the process environment, not
from the secrets bundle. All six are optional. `SMTP_HOST` is the switch: leave it unset and
the digest still builds and is returned in the sync response, but no mail is sent.

| Variable        | Kind       | Rotatable | Owner / source                                  |
| --------------- | ---------- | --------- | ----------------------------------------------- |
| `SMTP_HOST`     | coordinate | no        | the mail provider (`smtp.gmail.com` today)      |
| `SMTP_PORT`     | coordinate | no        | 587 for STARTTLS, 465 for implicit TLS          |
| `SMTP_USER`     | coordinate | no        | the mailbox that authenticates                  |
| `SMTP_PASSWORD` | credential | yes       | Google App Password — see §4e                   |
| `SMTP_FROM`     | coordinate | no        | must equal `SMTP_USER` on Gmail; it rewrites any other sender |
| `SMTP_TO`       | coordinate | no        | recipient; defaults in `schema.ts`, no env needed |

> `SMTP_PASSWORD` is a credential but is **not** in `CREDENTIAL_KEYS`, because that list is
> typed against the secrets bundle and this value does not come from there. It is not
> redacted by key name — the protection is that
> [`src/notify/smtp.ts`](../src/notify/smtp.ts) reports `error.name` and never the message,
> so a failed login cannot carry the password into a log. Anything that formats an SMTP error
> in full would break that, which is why nothing does.

The four marked **credential** are also the four in `CREDENTIAL_KEYS` — they are redacted
from every log line and are the ones the rotation procedures below apply to.

> `WL_AUTH_HOST` and `WL_API_HOST` are **different hosts**. WellnessLiving serves
> `/oauth2/token` from the auth host only — sending the token request to the data host
> returns an HTTP 403 challenge page, not a token (verified 18 Aug 2026). Both values come
> from the WL Integrations team; the Postman collection they ship carries them as `auth_url`
> and `proxy_url` respectively.

> `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. Sync workers only. It must never
> reach the portal, a browser bundle, or any client-side code.

---

## 2. Where they live

| Environment       | Storage                                     | How the app reads it                   |
| ----------------- | ------------------------------------------- | -------------------------------------- |
| Local development | `config/settings.<env>.json` (git-ignored)  | `SECRETS_PROVIDER=file`                |
| Local (alt)       | `.env` in the repo root (git-ignored)       | `SECRETS_PROVIDER=env`                 |
| CI                | nothing — CI makes no live calls            | n/a                                    |
| Vercel            | Project Settings → Environment Variables    | `SECRETS_PROVIDER=env`                 |
| Deployed dev      | secrets manager, `royalty-sync/dev/config`  | `SECRETS_PROVIDER=aws-secrets-manager` |
| Deployed prod     | secrets manager, `royalty-sync/prod/config` | `SECRETS_PROVIDER=aws-secrets-manager` |

One JSON object per environment, in the same shape everywhere — the local settings file and
the stored secret are byte-identical documents:

```json
{
  "environment": "prod",
  "wellnessliving": {
    "host": "...",
    "authHost": "...",
    "idRegion": 1,
    "kBusiness": "...",
    "clientId": "...",
    "clientSecret": "..."
  },
  "supabase": { "url": "https://...", "serviceRoleKey": "..." },
  "gohighlevel": { "apiToken": "...", "locationId": "..." }
}
```

A flat object keyed by the §1 names is also accepted, so an already-stored flat secret keeps
working.

### Creating the bundles

Every provider reads the **same** JSON shape, so the settings file you already filled in
uploads verbatim — no conversion, and therefore no chance of a hand-conversion dropping a key:

```bash
aws secretsmanager create-secret \
  --name royalty-sync/dev/config \
  --description "royalty-sync dev configuration" \
  --secret-string file://config/settings.dev.json

aws secretsmanager create-secret \
  --name royalty-sync/prod/config \
  --description "royalty-sync prod configuration" \
  --secret-string file://config/settings.prod.json
```

Updating later is the same command with `put-secret-value --secret-id`.

The settings files are git-ignored, so they are safe where they sit; there is no temporary
copy to shred. The IAM policy for the sync service needs `secretsmanager:GetSecretValue` on
`royalty-sync/<env>/config` and nothing else.

### If you are not using AWS

The application does not care which manager holds the values — it only needs one of the three
providers to resolve them. Pick whichever you already operate:

| Manager                      | Store the values as                                                       | App reads them via                                          |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| AWS Secrets Manager          | one secret per env, `royalty-sync/<env>/config`, body = the settings JSON | `SECRETS_PROVIDER=aws-secrets-manager`                      |
| GitHub Actions secrets       | one repository secret per key (`WL_CLIENT_SECRET`, …)                     | `SECRETS_PROVIDER=env`, injected into the job               |
| Vercel environment variables | one variable per key, per environment                                     | `SECRETS_PROVIDER=env`                                      |
| Doppler / Vault / GCP        | one bundle per env                                                        | add a provider class — one `case` in `src/secrets/index.ts` |

GitHub and Vercel are the two you already have, and both satisfy "credentials live outside the
repository and are injected at runtime". Neither gives you central rotation across
environments, which is the reason to prefer a real manager once the project has one.

---

## 3. Verifying a configuration

```bash
# no network calls; proves every key is present and well-formed
APP_ENV=dev npm start -- config:check

# what the app resolved, with credentials fingerprinted
APP_ENV=dev npm start -- config:show

# proves the Supabase project answers and accepts the service role key
APP_ENV=dev npm start -- healthcheck
```

`config:show` prints credentials as `abc...yz (len 219)`. Use the length and the first three
characters to confirm a rotation took effect without ever printing the value.

`config:show` also reports `smtpHost` as `set`/`missing` and `smtpPassword` as a fingerprint,
so "are failure emails switched on in this environment, and is it the password I just
rotated" is answerable without opening the dashboard.

Exit codes: `0` all good · `1` a check failed or startup failed · `2` bad CLI usage.

---

## 4. Rotation procedures

General rules, in order of importance:

1. **Rotate `prod` and `dev` separately.** Never reuse a value across environments.
2. **Write the new value to the secrets manager first, then restart the service.** The app
   reads secrets once at startup, so a running process keeps the old value until restarted.
3. **Verify with `healthcheck` before deleting the old credential.**
4. **Record the rotation** (date, key, who) in the operations log.

### 4a. `SUPABASE_SERVICE_ROLE_KEY`

Supabase does not support two simultaneous service role keys, so this one has a brief
window where the old key stops working.

1. Supabase dashboard → the project → Settings → API keys.
2. Roll the `service_role` key. Copy the new value immediately.
3. Update `royalty-sync/<env>/config`:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id royalty-sync/prod/config \
     --secret-string file://config/settings.prod.json
   ```
4. Restart the sync service.
5. `APP_ENV=prod npm start -- healthcheck` → expect `"ok": true`.
6. If it reports _"reachable, but the service role key was rejected"_, the new key was not
   copied correctly. Re-copy from the dashboard; do not roll again.

Schedule: every 90 days, and immediately on any suspected exposure.

### 4b. `GHL_API_TOKEN`

1. GoHighLevel → Settings → Private Integrations.
2. Create a **new** integration with the same scopes rather than editing the existing one —
   this gives an overlap window with no downtime.
3. Update the secret bundle, restart, verify.
4. Delete the old integration once traffic is confirmed on the new token.

Schedule: every 90 days, and immediately if a token appeared in a log, a ticket or a screen
share.

### 4c. `WL_CLIENT_ID` / `WL_CLIENT_SECRET`

WellnessLiving issues these; they cannot be self-rotated.

1. Email the WL Integrations team requesting new OAuth2 credentials for the affected
   environment, stating the reason (routine rotation or suspected exposure).
2. On receipt: update the secret bundle, restart, verify with `healthcheck`.
3. Ask WL to revoke the previous pair once the new pair is confirmed working.

Schedule: annually, or immediately on suspected exposure. Because rotation depends on a
third party, treat exposure as an incident — see §5.

### 4d. Environment coordinates (`WL_API_HOST`, `WL_AUTH_HOST`, `WL_ID_REGION`, `WL_K_BUSINESS`, `SUPABASE_URL`, `GHL_LOCATION_ID`)

Not rotatable, but they do change — a new WL region, a rebuilt Supabase project, a moved GHL
location. Update the bundle and restart. No code change is required or permitted; the
environment-switch test in `tests/config.test.ts` exists to keep it that way.

### 4e. `SMTP_PASSWORD`

A Google App Password, not the account password — the account password will not authenticate
against `smtp.gmail.com` at all once 2-Step Verification is on, and 2-Step Verification is a
precondition for App Passwords existing.

1. https://myaccount.google.com/apppasswords — the page is reachable only by direct URL; no
   link to it appears in the account settings tree.
2. Create a new password (name it for the service, e.g. `royalty-sync`). Copy it out of the
   dialog immediately — it is shown once and cannot be retrieved afterwards.
3. Set it in **both** places, stripped of the spaces the dialog inserts: Vercel
   (`vercel env add SMTP_PASSWORD production,preview`) and any local `.env`.
4. Verify before deleting the old one — `transporter.verify()` authenticates without sending
   mail, so the check costs nobody an inbox item.
5. Revoke the previous entry on the same page.

An App Password grants **full access to the Google account**, not merely SMTP. Treat an
exposed one exactly as §5 describes, and note that revoking is instant and free — when in
doubt, revoke and re-issue rather than reasoning about whether the exposure mattered.

Schedule: every 90 days, and immediately if it appeared in a log, a ticket, a screen share
or a screenshot.

---

## 5. If a credential leaks

1. **Rotate first, investigate second.** Follow the procedure above for that key.
2. **Determine the blast radius.** A leaked `service_role` key means full read/write on the
   Supabase project with RLS bypassed — assume the data was readable.
3. **If it was committed to git**, rotating is mandatory and not optional: the value stays
   in the history of every clone and fork. After rotating, purge it with
   `git filter-repo --replace-text` (or BFG) and force-push, then tell every clone holder to
   re-clone. CI runs gitleaks over full history on every push, so a leak should be caught
   before it spreads.
4. **Record it** in the operations log with the date, the key, how it leaked and what changed
   to stop a recurrence.

---

## 6. Pre-commit check (recommended)

CI scans on push, but catching a secret before it enters history is much cheaper:

```bash
# install gitleaks once: https://github.com/gitleaks/gitleaks/releases
gitleaks protect --staged --config .gitleaks.toml --redact
```

Wire it into `.git/hooks/pre-commit` if you want it automatic. The hook is local and
intentionally not committed — CI is the enforcement point.

---

## 7. The scheduled jobs

Two schedules, both in [`vercel.json`](../vercel.json). Nothing else is scheduled.

| Cron | Route | Fires | What it does |
| ---- | ----- | ----- | ------------ |
| `0 3 * * *` | `/api/wellness-sync-all` | 03:00 UTC daily | Every pass, in dependency order |
| `0 4 1 * *` | `/api/wellness-sync-historical` | 04:00 UTC on the 1st | Re-reads the last `SYNC_MONTHLY_LOOKBACK_MONTHS` calendar months, or an explicitly requested range |

Vercel Cron sends `CRON_SECRET` as the bearer automatically. Neither route can be
reached without a token.

### What each pass does, and how long it takes

Measured over 26,516 `sync_run` rows, 31 Aug – 1 Sep 2026. These are steady-state
durations against an already-populated database — a first backfill is very much
longer, and the `max` column is where those show up.

| # | Pass | Reads | median | p90 | observed max |
|---|---|---|---|---|---|
| 1 | `login_type_sync` | membership/login types | 2.5s | 2.9s | 8.7s |
| 2 | `client_list_sync` | every activated client | 2.5s | 2.8s | 41.2s |
| 3 | `staff_sync` | staff → `person` | 2.5s | 2.8s | 7.8s |
| 4 | `location_sync` | locations | 2.5s | 2.8s | 7.3s |
| 5 | `shop_category_sync` | shop categories | 2.5s | 2.9s | 6.9s |
| 6 | `promotion_sync` | promotions, per location | 2.8s | 3.1s | 16.9s |
| 7 | `service_category_sync` | bookable service categories | 2.8s | 3.1s | 8.7s |
| 8 | `purchase_sync` | purchases, per person | 3.4s | 3.8s | 7.3m |
| 9 | `receipt_sync` | the money on each purchase | 2.0s | 2.4s | **90.4m** |
| 10 | `purchase_element_sync` | item detail, recipient, membership state | **17.3s** | 18.9s | 17.4m |
| 11 | `profile_sync` | contact detail, per person | 3.4s | 3.8s | 6.0m |
| 12 | `schedule_sync` | class schedule, −7 / +30 days | 2.8s | 3.1s | 8.3s |
| 13 | `client_session_sync` | appointments | 3.4s | 3.8s | **80.3m** |
| 14 | `attendance_sync` | attendance, **every** session | **31.1s** | 33.6s | 58.7m |
| 15 | `ghl_match_sync` | GoHighLevel contact matching | 2.0s | 2.2s | 7.3m |
| 16 | `service_sync` | bookable service catalogue | 2.8s | 3.1s | 8.3s |

`historical_schedule_sync` is not in that order — it has its own cron. One month
chunk measured at 9.3s.

> **The medians sum to roughly 85 seconds, and the function budget is 50.**
> `FUNCTION_BUDGET_MS` stops the run *starting* new passes at 50s, under Vercel's
> 60s ceiling, so a nightly invocation reports `partial` with the trailing passes
> marked `ran: false`. That is safe — the queue is the cursor and the next
> invocation resumes — but with **one cron per day** the trailing passes
> (`ghl_match_sync`, `service_sync`) fall a day behind each time the run is full.
> Raising the cron frequency is the fix, and it needs a Vercel plan that permits
> sub-daily crons. **Open — see section 9.**

`attendance_sync` is the expensive one and will stay that way: it re-seeds from
**every** session row rather than a recent window, so its cost grows with the
schedule's history, not with what changed.

### Is it healthy right now

```bash
node scripts/queue-status.mjs
```

or, with only a browser and the database:

```sql
select * from sync_queue_progress where k_business = '<k_business>' order by work_type;
select job_name, state, last_seen_at, last_clean_completion_at
  from sync_job_state where k_business = '<k_business>' order by job_name;
```

`pct_done = 100` on every row with `pending = 0` and `in_progress = 0` means the
queue has drained. `last_clean_completion_at` moves **only** on a clean drain, so
a stale value there with a recent `last_seen_at` means the job is running but has
not finished cleanly in a while.

---

## 8. Recovery procedures

Read section 7 first: most of what looks like a failure is a budgeted run doing
exactly what it was built to do.

### 8a. A run reported `partial`, or the queue has items outstanding

**Usually: do nothing.** `partial` is the normal way a long run ends. The queue is
durable, the next invocation resumes from exactly what was left, and no work is
lost. Act only if `pending` has not fallen across several consecutive runs.

To push it along without waiting for the schedule:

```bash
curl -X POST https://<deployment>/api/wellness-sync-all -H "Authorization: Bearer $SYNC_TRIGGER_TOKEN"
```

Repeat until `/api/sync-status` reports `"complete": true`. Each call does one
budget's worth. For a large backfill, run it locally instead — there is no
50-second ceiling outside the platform:

```bash
APP_ENV=prod npm start -- sync:full-parallel
```

### 8b. Triggering the historical load

The monthly route re-reads the last two months on its own. To load a **specific**
range — a year of history, or one month that needs re-checking — ask for it, and
that request takes priority over the routine re-read.

```bash
curl -X POST https://<deployment>/api/wellness-sync-historical -H "Authorization: Bearer $SYNC_TRIGGER_TOKEN" -H "Content-Type: application/json" -d '{"start":"2024-01-01","end":"2024-12-31"}'
```

or set the window and let the next run pick it up:

```bash
node scripts/window.mjs --job=historical_schedule_sync --start=2024-01-01 --end=2024-12-31 --apply
```

The range is cut into calendar months, one queue item each, so an interrupted run
resumes at the month it reached rather than restarting. The request clears itself
once the job drains cleanly — it is an instruction, not a setting.

To do the same for **appointments** rather than classes, point at
`client_session_sync`. A start with no end means "from there to now":

```bash
node scripts/window.mjs --job=client_session_sync --start=2024-01-01 --apply
```

### 8c. Reading the parked queue

An item that exhausted its three attempts (1, 5 and 25 minutes apart) is parked in
state `dead` and will not be retried by anything.

```bash
node scripts/dead-items.mjs
```

Add `--work-type=purchase_receipt` to narrow it, or `--verbose` for the full error
text. Without a clone:

```sql
select work_type, last_error_sid, last_http_status, count(*)
  from sync_queue
 where k_business = '<k_business>' and state = 'dead'
 group by 1, 2, 3 order by 4 desc;
```

Read `last_error_sid` before deciding anything. `id-nx` means WellnessLiving says
the record does not exist — almost always an upstream deletion, and re-queueing it
just burns three more attempts every run.

### 8d. Re-queueing

```bash
node scripts/requeue.mjs --work-type=user_profile
```

That is a dry run: it prints what it would change and exits. Add `--apply` to make
it happen. `--sid=id-nx --invert` re-queues everything except the deletions.

Without a clone:

```sql
update sync_queue
   set state = 'pending', attempt_count = 0, next_attempt_at = now()
 where k_business = '<k_business>'
   and state = 'dead'
   and work_type = 'user_profile'
   and coalesce(last_error_sid, '') <> 'id-nx';
```

The error columns are deliberately left in place: if the item dies again, the old
error still on the row is what shows it is the same failure and not a new one.

### 8e. A run died and left its items claimed

A process killed mid-item leaves rows in `in_progress` holding a lease. This
recovers on its own — `sync_run.heartbeat_at` and the `abandoned` state (migration
`0033`) retire a run whose process died, and the lease expires. Wait one run cycle
before intervening.

If it is genuinely stuck, release the claims:

```sql
update sync_queue
   set state = 'pending', next_attempt_at = now()
 where k_business = '<k_business>'
   and state = 'in_progress'
   and updated_at < now() - interval '1 hour';
```

Do this only when no run is active — check `sync_job_state.state` first. Releasing
a lease a live run still holds means two workers on the same item; the writes are
upserts so the data survives, but the work is done twice.

### 8f. Forcing a full re-read from the beginning

The appointment pass decides between "full history" and "last three days" by
whether it has ever drained cleanly. Clearing the watermark sends it back to a
full backfill:

```sql
update sync_job_state
   set last_clean_completion_at = null
 where k_business = '<k_business>' and job_name = 'client_session_sync';
```

Expect hours, not minutes — the observed first backfill was 80 minutes. Run it
locally rather than through the deployed route.

### 8g. Nothing works and the credentials are suspect

```bash
APP_ENV=prod npm start -- config:check
```

That makes no network calls and proves every key is present and well-formed. Then
`config:show` for what actually resolved, credentials fingerprinted, and
`healthcheck` for whether every dependency answers.

A 401 or 403 in `last_http_status` across many items at once is a credential
problem, not a data problem. Go to section 4.

---

## 9. Data traps and open questions

What is unresolved, and which numbers are provisional. Anyone inheriting this
needs this section more than any other.

### Traps that will bite

| Trap | What happens | Where |
|---|---|---|
| WL answers **HTTP 200 for errors** | The failure is inside the body. Every call must assert `status === "ok"` — a structural test fails the build if any module outside the client calls `fetch` | [WL-API-NOTES.md](WL-API-NOTES.md) |
| `dt_date` needs a time component | `2026-08-19` is rejected; `2026-08-19 00:00:00` works. Silent | [WL-API-NOTES.md](WL-API-NOTES.md) |
| …except where it must **not** have one | The class-schedule endpoint wants bare dates. The two are not interchangeable | `src/sync/pass.ts` |
| WL keys are **text**, never integers | A leading zero is lost as an integer, and the record is then unfindable | [DATA-MODEL.md](DATA-MODEL.md) |
| Money is `numeric(12,2)`, never float | WL sends `"280.00"` as a string. Float drift in a royalty figure is not recoverable | [DATA-MODEL.md](DATA-MODEL.md) |
| List endpoints return **keyed objects**, not arrays | Iterate with `Object.values()`. Two endpoints — promotions and shop categories — return real arrays instead | [WL-API-NOTES.md](WL-API-NOTES.md) |
| Hosts never appear in source, logs or records | Enforced by `tests/no-hardcoded-config.test.ts` | [CLAUDE.md](../CLAUDE.md) |

### Open with WellnessLiving

| Question | Status | What it blocks |
|---|---|---|
| A way to enumerate **all clients** | **Open.** No list endpoint; search requires a term. People are discovered through staff records, purchases and attendance | Coverage is everyone who has transacted, **not** the full client base. Any client count is a floor, not a total |
| **Staff pay amounts** | **Open.** WL returns which pay rate applies, never the amount, and no documented endpoint resolves it | Revenue per class is available. **Profit per class is not.** Any margin figure is unavailable, not zero |

Before recording a new WL blocker, check the parameter names first. Two of the
four originally recorded turned out to be our own mistakes — `dt_date` versus
`dt_date_local`, and `k_class_period` versus `k_appointment`.

### Open with the client

| Question | Status |
|---|---|
| Which GoHighLevel custom fields may be reported | **Open.** `ghl_custom_field.is_reported` defaults to false, so nothing reaches a client record until somebody says it should. Confirming the list is an `UPDATE`, not a migration |
| Raw payload retention | **Open.** Every response is kept indefinitely. No retention period has been agreed |

### Open on our side

| Question | Status |
|---|---|
| One cron per day against an ~85s pass | **Open.** See the note in section 7. The trailing passes fall a day behind whenever a run is full. Needs either a more frequent cron or a longer `maxDuration` — both are plan-dependent, and `FUNCTION_BUDGET_MS` must move with `maxDuration` |
| `sync_job_state` page cursor | Built, unused. Waits on a paginated WL endpoint |
| Royalty calculation itself | Not started. The inputs are being collected; the calculation is the next piece of work |

### Numbers that are provisional

Say so when reporting these:

- **Any client count** — bounded by who we can enumerate, not by who exists
- **Any margin or profit figure** — staff pay amounts are unavailable
- **Service names** — 9 services are in the bookable catalogue against ~200 referenced by transactions. The rest are stubs named from the purchase that referenced them, and are countable via the `unresolved_service` view
- **Anything older than the loaded history** — the daily run covers a recent window; older periods exist only if they were deliberately loaded
