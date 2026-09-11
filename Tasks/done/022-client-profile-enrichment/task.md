---
id: 022
title: P6.1 — pull each client's profile details
status: done
priority: high
depends_on: [010]
created: 2026-08-24
---

# P6.1 — pull each client's profile details

Board item 6.1. Staff arrive from `/v1/staff/list` with names but no contact
detail; this is the enrichment the staff writer deferred ("email and phone stay
null until enrichment lands").

## Context

The profile call is the first step of enrichment and the only place the client's
PRIMARY email appears — the client report exposes a secondary email only. This is
why GoHighLevel matching (M04) waits until after enrichment rather than running
alongside it.

## Goal

Pull `/v1/user` per person and merge the profile — primary email, names, phones,
date of birth — onto the existing `person` row, so the GHL matcher has a primary
email to match on.

## Scope

- A `user_profile` queue work type, seeded from `person.uid` (every person we hold).
- Fetch `/v1/user` per uid; parse into a person patch and UPSERT on uid.
- `s_mail` → `email` (the primary email); names, `s_phone*` → phones, `dt_birth`
  → `date_of_birth`, login-type label.
- MERGE, never clobber: WL sends `""` for an unset field; read as null and omit it
  so a refresh cannot blank a value another source set.
- `raw_link` each person to the `/v1/user` payload (`field_group: profile`).
- `runProfileSyncPass`, in the full-sync order after the person-creating passes.

## Out of scope

- Gender and postal address — no `person` columns; adding them is a migration.
- The GHL matcher itself (M04).
- The wider client base — enumerating all clients is blocked (STATUS blocker 1);
  this enriches whatever `person` rows exist.

## Acceptance criteria

- [x] Profile pulled per client and merged onto the existing client row
- [x] Primary email stored and available to the GoHighLevel matcher (`person.email`)
- [x] A client whose profile call fails is parked without stopping the others
      (the durable queue dead-letters per item, like every pass)
- [x] Re-running enrichment for the same client updates rather than duplicates
      (upsert on uid)

## Constraints & notes

- `/v1/user` confirmed live as the primary-email source (WL-API-NOTES); the
  alternatives carry only a login-mail URL, a lookup, or notification flags.
- Coverage is bounded by client enumeration — see the out-of-scope note.
