# Student Dashboard — Delivery Plan

Date: 17 September 2026
Status: Draft, for approval

---

## What we are doing

The student dashboard is built and looks finished, but every number and name on it
is hard-coded sample data. Nothing on the screen belongs to a real student.

The plan is to put a real database behind it, and then connect the dashboard to
that database one student at a time.

We are doing this in two milestones. The first one touches only the database. The
second one touches only the dashboard. They are kept apart on purpose — if the
database is wrong, we want to find out before any screen depends on it.

---

## The one thing that shapes the whole plan

The dashboard shows twelve sections. Only four of them have any source of data
today. The other eight — the pathway, the current project, interests, progress
notes, coach feedback, creations, opportunities and the journey stepper — do not
exist anywhere in the studio booking system, and never will. That system has no
idea what a "project" or a "pathway" is.

So those eight cannot be synced from anywhere. They will always be our own data,
entered by us. For now they stay as sample data, and we say so honestly rather
than making the dashboard look more finished than it is.

The four that can go live in this plan are:

- Who the student is
- Which programme, organisation and class they belong to
- Their next session
- Their full schedule

---

## MILESTONE 1 — Get the database right

Goal: a database that can describe a student, a teacher, a class and an attendance
record on its own terms, without borrowing the booking system's shape.

Nothing on any screen changes in this milestone. Nothing a student can see is
touched.

### Task 1. Central person record

Right now the only "person" in our database is a copy of a booking-system record,
and it cannot exist without a booking-system ID. That means a student who signs up
through the portal — and has never been entered into the booking system — simply
cannot be stored.

This task creates a central person record that stands on its own. A student and a
teacher then hang off that record as roles, not as separate people.

Important: one human stays one record. If someone is both a student and a teacher,
they are still one person, counted once. This has already caused a costly mistake
in this project once and must not be repeated.

Teacher rule, as confirmed: a person is a teacher if the booking system marks them
with the staff profile type. Everyone else is a student. This is a business rule
held as data, so changing who counts as a teacher later is a small data change, not
a rebuild.

Done when:

- A student who exists only in the portal can be stored
- A student who exists only in the booking system can be stored
- A person who is both is stored once, not twice
- Adding or changing a person in the booking system updates our record
  automatically, with no manual step
- Changing the teacher rule re-sorts everyone automatically

### Task 2. Organisation, programme and class group

The dashboard shows three labels at the top — the programme, the organisation, and
the class group. None of these exist in the booking system. They are ours.

This task creates them and connects a student to them.

Built for one organisation today, but structured so adding a second one later is a
small change and not a redesign.

Open point for you: who enters this information? Either we set it once as part of
the build, or we build a small screen so the studio can maintain it themselves. The
first option is assumed unless you say otherwise.

Done when:

- A student resolves to their programme, organisation and class group
- A second organisation can be added later without redesigning anything
- A student can only see their own information, never anyone else's

### Task 3. Class sessions and attendance

The booking system stores a class and its date together, and has no separate record
for "the class as a series". The dashboard needs both. This task creates our own
session and attendance records, shaped the way the dashboard needs them.

Your requirement, taken as the headline test: if the booking system shows a student
their next session, the portal shows it too.

Two rules you set, both carried through:

First, our session and attendance records carry no booking-system fields at all.
The mapping between their records and ours lives in separate connecting records,
and nowhere else.

Second, those connecting records also answer a question we will need later: was
this attendance taken in the portal, or did it come from the booking system? The
presence of a connection is the answer. Nothing extra is stored, so nothing can
disagree with it.

Done when:

- A session in the booking system appears for that student in our data
- Attendance appears the same way
- We can always tell whether an attendance came from the portal or the booking
  system
- If attendance is taken in the portal and the booking system later sends the same
  attendance, that is flagged rather than silently overwritten
- A portal-only student sees an empty schedule, not an invented one

### Task 4. Automatic health check

Everything above updates automatically. That is the right design, but it has one
bad failure: if it quietly stops working, nothing breaks and nobody is told.
Records simply stop appearing.

This task adds a check that notices, and reports it alongside the health checks
already running.

Done when:

- Deliberately breaking each automatic update is caught by the check
- The result appears with the existing health reporting
- The on-call notes say what to do when it is not clean

---

## MILESTONE 2 — Put one real student on the dashboard

Goal: a student logs in and sees their own real information in the four sections
that have a source. The other eight stay as sample data.

### Task 5. Student login

A student signs in and the system knows which person they are — including a student
who has never been entered into the booking system.

Read-only. Nothing in this milestone lets a student change anything, because the
sections that would be edited are not being built in this round.

Done when:

- A student can sign up and sign in
- A portal-only student signs in correctly and sees an empty schedule rather than
  an invented one
- One student cannot see another student's information, proven by test and not by
  inspection
- No ability to write anything has been opened

### Task 6. Student data service

Build the four pieces of data the dashboard needs — the student, their programme
and class, their next session, and their schedule — plus one combined call so the
whole screen loads in one go.

The response format is already written down and matches the sample data exactly, so
no part of the dashboard design has to change.

Done when:

- The four pieces return the agreed format
- The combined call returns only the live sections, and does not return empty
  placeholders that look like missing data
- A student cannot request another student's data by changing anything

### Task 7. Connect the dashboard

Replace the sample data with the real service for those four sections. The other
eight keep their sample data and keep working.

Done when:

- A real student's name, programme, next session and schedule appear on screen
- No part of the visual design changed
- The remaining eight sections still display correctly
- A short note records which sections are live and which are still samples, so
  nobody has to guess later

---

## AFTER GO-LIVE — one thing that will need attention

### Task 8. Matching a portal student to the booking system

A student signs up in the portal. Later, the studio also enters them into the
booking system. Now the same human exists twice, and the whole point of the central
record is undone.

This is solvable and we have already solved the same problem once in this project
for a different system. The proven rule is reused rather than reinvented: match on
phone number first, then email, and never on name. Anything uncertain is parked for
a human to decide, never guessed.

The reason we do not guess is simple. Guessing puts one person's record onto
another person's account.

This is listed separately because it only starts to matter once students are
actually signing up. It should not delay the two milestones above, but it should
not be forgotten either.

---

## What is deliberately not in this plan

- The eight dashboard sections with no data source. They need their own tables
  built from scratch and that is a separate piece of work.
- Anything that lets a student change data. Every edit on the dashboard points at
  one of those eight sections.
- Replacing the booking system. It stays as a source. We are putting our own model
  on top of it, not removing it.
- An admin screen, unless Task 2 shows we need one.

---

## Where each milestone is built

Decided 17 September 2026.

Milestone 1 — the database and everything that keeps it in step with the booking
system — is built in the royalty reporting project. That is where the sync already
lives and where the schema is owned.

Milestone 2 — the student-facing data service and the dashboard itself — is built
in the dashboard project. It reads the same database directly.

One consequence is worth saying out loud now rather than finding it later: two
projects will read one database, and neither owns the boundary between them. A
change to the database in the first project can break the second with nothing in
either build noticing. Milestone 2 should carry something that fails loudly when
that happens — otherwise the first sign of it will be a student seeing a blank
screen.

## Sequence and dependencies

Task 1 comes first. Nothing else can start without it.

Task 2 needs Task 1.
Task 3 needs Tasks 1 and 2.
Task 4 needs Task 1, and can run alongside Tasks 2 and 3.
Task 5 needs Task 1.
Task 6 needs Tasks 2, 3 and 5.
Task 7 needs Task 6.
Task 8 needs Tasks 1 and 5, and comes after go-live.

---

## Decisions needed from you

1. For Task 2 — do we set the organisation and programme information once as part
   of the build, or do you want a screen to maintain it? Assumed: set once.

2. For Task 3 — when the booking system sends a class we have never seen, we will
   create a placeholder class group automatically so the student's session still
   shows. The alternative is that the session does not appear until somebody maps
   it by hand, which would break your headline requirement. Assumed: create the
   placeholder.

3. Timing — Milestone 1 has no visible output. Are you comfortable with a stretch
   where nothing on screen changes, or do you want the dashboard connected to
   partial data earlier?
