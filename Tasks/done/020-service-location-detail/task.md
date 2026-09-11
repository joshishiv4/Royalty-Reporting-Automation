---
id: 020
title: P5.6 — pull service, category and location details
status: done
priority: medium
depends_on: []
created: 2026-08-21
---

# P5.6 — pull service, category and location details

Board item 5.6 (HRRAFEBAV-63). Today `service` and `location` exist only as FK STUBS
(key + k_business) written by the purchase writer; this fills in their real detail.

## Goal

Enrich the stub `service` and `location` rows with their actual attributes, and
capture service categories, so reports read a name rather than a bare key.

## Scope

- `location`: pull `/v1/location/list` -> `location.title`, `text_timezone`.
- `service`: pull the service detail (endpoint TBD) -> `service.title`, `id_program`,
  `id_sale`, `is_package`.
- Categories: `purchase_item.text_category` is already captured from the receipt;
  confirm whether a separate category entity is needed or the text is enough.
- Upsert on the natural key so stubs are enriched in place, not duplicated.

## Out of scope

- The stub-writing itself (done in task 014's purchase writer).

## Open question

**Which endpoint returns service detail?** The list/receipt give `k_service` and
`text_title` per item but not the service catalogue. Probe live and record in
WL-API-NOTES before building.

## Acceptance criteria

- [x] `location` rows carry title + timezone from `/v1/location/list`
- [x] `service` rows carry title/program/sale/package from the confirmed endpoint
- [x] Upserts enrich existing stubs without duplicating or clobbering
- [x] Parser tests + a live proof; WL-API-NOTES records the service endpoint

## Constraints & notes

- A PostgREST upsert writes only the columns sent, so enriching a stub keeps the key
  intact. Independent of the client-report chain (017–019).
