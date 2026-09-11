# Progress: P5.3 — save clients into person without duplicates

## Checklist

- [ ] Parse report client row -> person
- [ ] Upsert on uid (dedup) + raw_link
- [ ] Verify purchase sync can then seed from new clients
- [ ] Parser tests + live proof

## Last step

Not yet started.

## Blockers

Dev/UAT is live. First real gate: the open question in task.md (probe the endpoint
shape) — the client-report chain depends on the report actually yielding clients.

## Log

### 2026-08-21
- Created from the P5 board audit. This is a pending P5 item mapped to local tracking.
