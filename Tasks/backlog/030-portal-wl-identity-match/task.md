---
id: 030
title: Portal-to-WL identity match — one human, still one row
status: backlog
priority: medium
depends_on: [025, 028]
created: 2026-09-17
---

# Matching a portal student to a WellnessLiving person

## Goal

A student signs up in the portal and gets an `identity` with `uid IS NULL`. Later the
WellnessLiving sync brings in the same human as a `person`, and task 025's trigger
creates a **second** identity for them.

One human, two rows. That is exactly the double-count failure the whole hub design
exists to prevent, arriving through the back door.

## Scope

- Detecting the collision
- Linking the two identities into one
- Parking the cases a human must settle

## Reuse the matcher that already works — do not invent a second one

This problem is solved once in this codebase already:
[`src/ghl/matcher.ts`](../../../src/ghl/matcher.ts). Its rule is **phone first, email
second, names never**, and `ambiguous` is **never auto-resolved**.

That rule is measured, not assumed. DATA-MODEL.md records that on 2 Sep 2026 letting
a crowded phone fall through to the email took **25 ambiguous rows down to 4**, and
the four that remain are ones a human genuinely has to settle: two siblings sharing an
address and a handset, an organisation rather than a person, and a client whose
contact record carries a different address from the one WL holds.

Names are excluded deliberately. DATA-MODEL.md: choosing between candidates *"would
put one person's royalties on another person's record."*

## There is no exact-match path, and that was decided knowingly

An earlier version of this task opened with one: task 025 would keep the nulled
`uid` in `identity.uid_detached`, and a returning human would re-link by exact key
with the fuzzy matcher never running.

**That column does not exist.** `ON DELETE SET NULL` nulls the uid and a foreign key
cannot copy it first, so `uid_detached` could never have been populated; closing
that needed a `BEFORE DELETE` trigger on `person`, which the 17 Sep 2026 rule
forbids. Dropped by user decision the same day — see the delete-behaviour section of
[task 025](../../active/025-identity-hub/task.md).

**So every WL re-link here is the fuzzy match**, and some of them will park as
`ambiguous` where an exact key would have settled them. This is the accepted cost,
not a gap to route around: do not invent a substitute exact key out of `text_member`
or a name, which is how a royalty lands on the wrong person.

It is affordable only because nothing in this system deletes a `person` — the sync
is upsert-only and `0027` settled that deactivated clients stay. **If a real delete
path ever appears, reopen this.**

## Out of scope

- Merging two identities that both carry portal-authored content. Flag it, park it,
  and let a human decide — silently merging two students' progress and feedback is
  worse than leaving a duplicate visible.
- Creating anything in WellnessLiving. Nothing is ever written back.

## Acceptance criteria

- [ ] A phone match links; a single email match links when the phone does not
- [ ] A name match **never** links — proven by a test
- [ ] Two candidates park as `ambiguous` and are never auto-resolved
- [ ] A linked identity keeps its portal-authored data intact
- [ ] Ambiguous rows are countable and surface in `data_health_issue`
- [ ] The count of unresolved matches cannot read as fresh just because a retry ran —
      the `ghl_unresolved_since` lesson applies here unchanged
- [ ] Re-running the match changes nothing already settled
- [ ] DATA-MODEL.md records the rule and whatever this task measures

## Constraints & notes

- `ghl_contact_id` is deliberately **not unique**: a family on one phone number
  resolves several people to the same contact, and that is a correct result, not a
  collision. Do not "tidy" this with a unique index here either.
- `unmatched` is not an error. The person simply is not in the other system.

## Resources

- `resources/` — empty. Read `src/ghl/matcher.ts` and the GoHighLevel section of
  `docs/DATA-MODEL.md` before designing anything here.
