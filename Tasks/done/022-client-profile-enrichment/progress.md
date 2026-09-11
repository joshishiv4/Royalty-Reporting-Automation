# Progress: P6.1 — pull each client's profile details

## Checklist

- [x] Probe which endpoint carries the primary email; record in WL-API-NOTES
- [x] parseProfile + writeProfile (merge, never clobber; upsert on uid)
- [x] user_profile work type + runProfileSyncPass, in full-sync order
- [x] Tests, mutation-proven
- [x] Live proof against dev

## Last step

Done. 20/20 dev people enriched with a primary email.

## Blockers

None for the mechanism. Coverage is bounded by client enumeration (STATUS
blocker 1) — this enriches whatever person rows exist.

## Log

### 2026-08-24 — done
- Deep live probe of the profile candidates: `/v1/user?uid=` carries the PRIMARY
  email at `s_mail` (plus names, s_phone*, dt_birth, login-type). `/v1/member/info`
  gives only a login-mail URL, `/v1/profile/email` is an email→uid lookup, and
  `/v1/profile/setting` is notification flags. Recorded in WL-API-NOTES.
- src/sync/profiles.ts: parseProfile builds a person PATCH containing only the
  fields WL actually sent (WL's "" read as null and OMITTED), so a PostgREST
  upsert refresh never blanks a value another source set. writeProfile stores the
  raw payload, upserts on uid, raw_links the person. runProfileSyncPass seeds from
  person.uid; a failed call parks via the durable queue without stopping others.
- 7 tests; mutation-proven (dropping the empty→omit guard turns 4 of the 7 red).
- Proven live: 20/20 people enriched (email, phone, DOB); a re-run re-fetches and
  upserts with no duplicate rows (refresh semantics — contact details change).
- Coverage today is 20 (staff + payers/recipients, all self-purchasers on dev);
  the full client base awaits the client-list unblock.

### 2026-08-24 — re-verified after the branch fix
- The 022 work had been stashed onto a `dev` that predated the 021 merge (PR #7),
  so a `stash pop` left conflict markers and 021 wiring without its implementation.
  Resolved by fast-forwarding `dev` to `origin/dev` and re-applying the 022 delta
  on top, leaving 021's code and docs untouched.
- `npm run verify` green: 32 files, 310 tests.
- Mutation re-checked: removing the empty-string guard in `readString` turns 4 of
  the 7 profile tests red; restoring it returns 7/7.
- Live re-run against dev: 12 consecutive passes, 240 claimed / 240 done / 0 dead.
  `person` stayed at 20 rows with 20/20 primary emails while the raw `/v1/user`
  payload count rose 62 → 302 — a refresh every time, never a duplicate row.
