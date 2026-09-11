# Progress: P5.6 — pull service, category and location details

## Checklist

- [ ] Probe: which endpoint returns service detail
- [ ] location/list -> location title+timezone
- [ ] service detail -> title/program/sale/package
- [ ] Upsert-enrich stubs; tests + live proof

## Last step

Not yet started.

## Blockers

Dev/UAT is live. First real gate: the open question in task.md (probe the endpoint
shape) — the client-report chain depends on the report actually yielding clients.

## Log

### 2026-08-21
- Created from the P5 board audit. This is a pending P5 item mapped to local tracking.

### 2026-08-21 — done
- Probed live: /v1/location/list carries s_title + a_timezone.text_name (IANA zone).
  NO service-detail endpoint exists (/v1/service* all 404) — service title/is_package
  are derived from the purchase items instead. Categories: purchase_item.text_category
  is enough, no entity.
- src/sync/locations.ts: parseLocationList + writeLocationList (title + text_timezone,
  upsert on k_location). runLocationSyncPass added.
- purchases.ts: service stub upgraded to a full ServiceRow (title + is_package from
  the item); also fixed k_location "0" -> null (a WL placeholder, not a real location).
- Live proof: location 244238 enriched (title + America/New_York), 12/12 services
  titled, no "0" stub. Mutation-verified the "0" fix. verify: 271 green.
- WL-API-NOTES records the service/location findings.
