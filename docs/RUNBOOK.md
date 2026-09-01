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
