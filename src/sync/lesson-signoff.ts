import type { AppConfig, SignoffConfig } from '../config/schema.js';
import type { SmtpClient } from '../notify/smtp.js';
import type { SupabaseClient } from '../supabase/client.js';

/**
 * Lesson sign-off (task 038, phase 1): an attended SDC lesson -> one
 * lesson_signoff row -> one email to the admin with a prefilled Jotform link.
 *
 * THE MANUAL PROCESS THIS REPLACES. After every lesson the studio admin built a
 * Jotform "Student Lesson Confirmation Form" by hand (Student, Date, Teacher
 * Name, Course Code, FI, Signature) and sent it for signature. One master form
 * plus a prefilled link per lesson removes the building; the hourly sync removes
 * the noticing.
 *
 * WHO. Members of the WL client group SIGNOFF_GROUP ("SDC Clients"). Their FI is
 * the one OTHER group they belong to - "Self Pay" included, because the studio's
 * merged files are named "... - SELF PAY" too. No other group: skipped
 * 'no-fi'. Two: skipped 'multiple-fi' - the studio decides, this never guesses.
 * A skipped lesson is re-evaluated every run, so tagging the FI in WL lets it
 * through without anyone touching this database.
 *
 * WHICH LESSONS. Attended only (`id_visit = 3`), on or after SIGNOFF_START_DATE
 * (local lesson date), and only classes whose WL title starts with one of
 * SIGNOFF_CLASSES. Measured 25 Nov 2026 on SDC lessons since 1 Aug: 1,685 of
 * 1,809 match; Media / Podcasting / A Joyful Noise / DJ Private do not.
 *
 * NEVER TWICE. lesson_signoff is unique on k_visit, a sent or signed row is
 * never touched again, and the email is sent only from status 'pending'. If the
 * mail goes out and the status write then fails, the next run sends it again -
 * a duplicate is the chosen failure, because a lost form costs a signature and a
 * repeated one costs a delete.
 */

/** Attended - WlVisitSid ATTEND. See visit-outcome.ts. */
export const ID_VISIT_ATTENDED = '3';

/**
 * The master form's field unique names, read from the form via the Jotform API
 * on 25 Nov 2026. The go-live form must use the same names (docs/RUNBOOK.md).
 */
export const JOTFORM_FIELDS = {
  student: 'student',
  date: 'date',
  teacher: 'teacherName',
  courseCode: 'courseCode',
  fi: 'fi',
  lessonId: 'lessonId',
} as const;

export type SkipReason = 'no-fi' | 'multiple-fi' | 'missing-detail';

/** The settings that must all be present before anything is created or sent. */
export function missingSignoffSettings(config: Pick<AppConfig, 'signoff' | 'smtp'>): string[] {
  const s = config.signoff;
  const missing: string[] = [];
  if (s.to === null) missing.push('SIGNOFF_TO');
  if (s.startDate === null) missing.push('SIGNOFF_START_DATE');
  if (s.formHost === null) missing.push('JOTFORM_FORM_HOST');
  if (s.formId === null) missing.push('JOTFORM_FORM_ID');
  if (s.classes.length === 0) missing.push('SIGNOFF_CLASSES');
  if (config.smtp.host === null) missing.push('SMTP_HOST');
  return missing;
}

/** The part of a WL class title before the first "|", e.g. "Music For Everyone". */
export function classFamily(title: string): string {
  return (title.split('|')[0] ?? '').trim();
}

/** Whether a lesson's class is one the studio collects sign-offs for. Case-insensitive. */
export function isSignoffClass(title: string, classes: readonly string[]): boolean {
  const family = classFamily(title).toLowerCase();
  return family.length > 0 && classes.some((c) => c.trim().toLowerCase() === family);
}

/**
 * The studio's Course Code: the WL title upper-cased with each " | " as " - ".
 * "Music For Everyone | Live Performance Instruction | 60 Minutes" ->
 * "MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 60 MINUTES", exactly as
 * on the studio's signed sample.
 */
export function courseCode(title: string): string {
  return title
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' - ')
    .toUpperCase();
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Reads a WL/Postgres local timestamp ("2026-10-30T17:30:00" or with a space). */
function localParts(dtlLocal: string): LocalParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(dtlLocal);
  if (m === null) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

/** `YYYY-MM-DD` of a local timestamp, or null when it does not parse. */
export function localDate(dtlLocal: string): string | null {
  const p = localParts(dtlLocal);
  if (p === null) return null;
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * "Friday, October 30, 2026" - the Date line on the studio's form.
 *
 * The timestamp is already LOCAL (session.dtl_start_local), so it is formatted
 * as a calendar value pinned to UTC: no timezone conversion may move the date.
 */
export function formatLessonDate(dtlLocal: string): string | null {
  const p = localParts(dtlLocal);
  if (p === null) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(p.year, p.month - 1, p.day)));
}

/** "5:30 PM". For the email and, later, the file name - the form has no time. */
export function formatLessonTime(dtlLocal: string): string | null {
  const p = localParts(dtlLocal);
  if (p === null) return null;
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${String(hour12)}:${pad(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export interface SignoffFields {
  readonly studentName: string;
  readonly lessonDate: string;
  readonly teacherName: string;
  readonly courseCode: string;
  readonly fiTitle: string;
  /** lesson_signoff.id - goes in the form's HIDDEN lessonId field. */
  readonly lessonId: string;
}

/**
 * The prefilled link to the master form. Host and id are configuration; the
 * field names are the form's own unique names (JOTFORM_FIELDS). Encoded with
 * %20 rather than "+": Jotform's prefill was verified live with %20.
 *
 * WHY lessonId. The form shows no time, so two lessons on one day with the same
 * student, teacher, class and FI produce IDENTICAL visible forms (measured: one
 * SDC student had two 120-minute lessons with one teacher on 30 Oct 2026, 5:30
 * and 7:30 PM). The hidden lessonId is the only thing that tells the two
 * submissions apart. It is lesson_signoff.id (a random UUID), not k_visit: the
 * link sits in an email and its query can be edited, and a sequential WL key is
 * one digit away from another student's lesson.
 */
export function buildPrefillUrl(
  signoff: Pick<SignoffConfig, 'formHost' | 'formId'>,
  fields: SignoffFields,
): string {
  if (signoff.formHost === null || signoff.formId === null) {
    throw new Error('buildPrefillUrl: JOTFORM_FORM_HOST and JOTFORM_FORM_ID must be set');
  }
  if (fields.lessonId.trim().length === 0) {
    throw new Error(
      'buildPrefillUrl: lessonId is required - without it a submission cannot be matched',
    );
  }
  const params: ReadonlyArray<readonly [string, string]> = [
    [JOTFORM_FIELDS.student, fields.studentName],
    [JOTFORM_FIELDS.date, fields.lessonDate],
    [JOTFORM_FIELDS.teacher, fields.teacherName],
    [JOTFORM_FIELDS.courseCode, fields.courseCode],
    [JOTFORM_FIELDS.fi, fields.fiTitle],
    [JOTFORM_FIELDS.lessonId, fields.lessonId],
  ];
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://${signoff.formHost}/${encodeURIComponent(signoff.formId)}?${query}`;
}

/**
 * The student's FI: their one group other than the eligible group.
 * Titles compare case-insensitively; the eligible group itself is never an FI.
 */
export function chooseFi(
  groups: ReadonlyArray<{ readonly k_member_group: string; readonly title: string }>,
  eligibleGroup: string,
): { fi: { k_member_group: string; title: string } } | { skip: 'no-fi' | 'multiple-fi' } {
  const eligible = eligibleGroup.trim().toLowerCase();
  const others = groups.filter((g) => g.title.trim().toLowerCase() !== eligible);
  if (others.length === 0) return { skip: 'no-fi' };
  if (others.length > 1) return { skip: 'multiple-fi' };
  const only = others[0] as { k_member_group: string; title: string };
  return { fi: { k_member_group: only.k_member_group, title: only.title } };
}

export interface SignoffEmailInput extends SignoffFields {
  readonly lessonTime: string;
  readonly kVisit: string;
  readonly url: string;
}

/** One email per lesson, to the admin address. Plain text; smtp.ts adds the HTML part. */
export function signoffEmail(input: SignoffEmailInput): { subject: string; text: string } {
  return {
    subject: `Lesson sign-off: ${input.studentName} - ${input.lessonDate}, ${input.lessonTime}`,
    text: [
      'A lesson needs a signature on the Student Lesson Confirmation Form.',
      '',
      `Student: ${input.studentName}`,
      `Date: ${input.lessonDate}`,
      `Time: ${input.lessonTime}`,
      `Teacher: ${input.teacherName}`,
      `Course Code: ${input.courseCode}`,
      `FI: ${input.fiTitle}`,
      '',
      'Sign-off form, with these details already filled in:',
      input.url,
      '',
      `Sent automatically by the lesson sign-off sync. WellnessLiving visit ${input.kVisit}.`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

interface AttendanceRef {
  readonly k_visit: string;
  readonly uid: string;
  readonly k_period: string;
  readonly dt_start_utc: string;
}

interface SessionRow {
  readonly k_period: string;
  readonly dt_start_utc: string;
  readonly text_title: string | null;
  readonly dtl_start_local: string | null;
}

/** WL session keys arrive as text; PostgREST returns the timestamp in its own format. */
function sessionKey(kPeriod: string, dtStartUtc: string): string {
  return `${kPeriod}|${new Date(dtStartUtc).toISOString()}`;
}

/** The day before the start date, in UTC: a safe lower bound for a LOCAL date filter. */
function utcFloor(startDate: string): string {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

/**
 * The k_visits that need (re)processing: attended, on or after the start date,
 * an eligible-group member's, a sign-off class, and not already sent or signed.
 * Skipped and pending rows ARE returned - a skip may have been fixed in WL, and
 * a pending row is a send that failed.
 */
export async function lessonSignoffCandidates(
  db: SupabaseClient,
  kBusiness: string,
  signoff: SignoffConfig,
): Promise<string[]> {
  if (signoff.startDate === null) return [];
  const groupRows = await db.select<{ k_member_group: string }>(
    'member_group',
    `k_business=eq.${kBusiness}&title=eq.${encodeURIComponent(signoff.eligibleGroup)}` +
      `&select=k_member_group&limit=1`,
  );
  const groupKey = groupRows[0]?.k_member_group;
  if (groupKey === undefined) return [];

  const members = await db.selectAll<{ uid: string }>(
    'member_group_member',
    `k_member_group=eq.${groupKey}&select=uid&order=uid.asc`,
  );
  const eligible = new Set(members.map((m) => m.uid));
  if (eligible.size === 0) return [];

  const attended = await db.selectAll<AttendanceRef>(
    'attendance',
    `k_business=eq.${kBusiness}&id_visit=eq.${ID_VISIT_ATTENDED}&k_visit=not.is.null` +
      `&dt_start_utc=gte.${encodeURIComponent(utcFloor(signoff.startDate))}` +
      `&select=k_visit,uid,k_period,dt_start_utc&order=k_period.asc,dt_start_utc.asc,uid.asc`,
  );
  const mine = attended.filter((a) => eligible.has(a.uid));
  if (mine.length === 0) return [];

  const sessions = new Map<string, SessionRow>();
  const periods = [...new Set(mine.map((a) => a.k_period))];
  for (let i = 0; i < periods.length; i += 100) {
    const chunk = periods.slice(i, i + 100);
    const rows = await db.selectAll<SessionRow>(
      'session',
      `k_period=in.(${chunk.join(',')})&select=k_period,dt_start_utc,text_title,dtl_start_local` +
        `&order=k_period.asc,dt_start_utc.asc`,
    );
    for (const s of rows) sessions.set(sessionKey(s.k_period, s.dt_start_utc), s);
  }

  const finished = await db.selectAll<{ k_visit: string }>(
    'lesson_signoff',
    `k_business=eq.${kBusiness}&status=in.(sent,signed)&select=k_visit&order=k_visit.asc`,
  );
  const done = new Set(finished.map((f) => f.k_visit));

  const out = new Set<string>();
  for (const a of mine) {
    if (done.has(a.k_visit)) continue;
    const s = sessions.get(sessionKey(a.k_period, a.dt_start_utc));
    if (s === undefined || s.text_title === null || s.dtl_start_local === null) continue;
    const date = localDate(s.dtl_start_local);
    if (date === null || date < signoff.startDate) continue;
    if (!isSignoffClass(s.text_title, signoff.classes)) continue;
    out.add(a.k_visit);
  }
  return [...out];
}

export type SignoffResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'already-done' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'send-failed'; readonly detail: string };

interface ExistingSignoff {
  readonly status: 'pending' | 'sent' | 'skipped' | 'signed';
}

/**
 * Processes one attended visit: snapshot the form fields, decide skip or send,
 * write lesson_signoff, email the admin, mark it sent.
 */
export async function processLessonSignoff(
  db: SupabaseClient,
  smtp: SmtpClient,
  signoff: SignoffConfig,
  kBusiness: string,
  kVisit: string,
  nowIso: string,
): Promise<SignoffResult> {
  const existing = await db.select<ExistingSignoff>(
    'lesson_signoff',
    `k_visit=eq.${kVisit}&select=status&limit=1`,
  );
  const status = existing[0]?.status;
  if (status === 'sent' || status === 'signed') return { kind: 'already-done' };

  const attendance = await db.select<AttendanceRef & { id_visit: string | null }>(
    'attendance',
    `k_visit=eq.${kVisit}&select=k_visit,uid,k_period,dt_start_utc,id_visit&limit=1`,
  );
  const a = attendance[0];
  // No longer attended (WL changed the outcome) or no longer there: nothing to send.
  if (a === undefined || a.id_visit !== ID_VISIT_ATTENDED) return { kind: 'gone' };

  const startFilter = `k_period=eq.${a.k_period}&dt_start_utc=eq.${encodeURIComponent(a.dt_start_utc)}`;
  const sessions = await db.select<SessionRow>(
    'session',
    `${startFilter}&select=k_period,dt_start_utc,text_title,dtl_start_local&limit=1`,
  );
  const s = sessions[0];
  if (s === undefined || s.text_title === null || s.dtl_start_local === null)
    return { kind: 'gone' };

  const student = await personName(db, `uid=eq.${a.uid}`);
  const staff = await db.select<{
    k_staff: string;
    uid: string | null;
    is_substitute: boolean;
  }>(
    'session_staff',
    `${startFilter}&select=k_staff,uid,is_substitute&order=is_substitute.asc&limit=5`,
  );
  const teacher = await teacherName(db, staff[0]);

  const memberships = await db.select<{ k_member_group: string }>(
    'member_group_member',
    `uid=eq.${a.uid}&select=k_member_group&limit=50`,
  );
  const groupKeys = memberships.map((m) => m.k_member_group);
  const groups =
    groupKeys.length === 0
      ? []
      : await db.select<{ k_member_group: string; title: string }>(
          'member_group',
          `k_member_group=in.(${groupKeys.join(',')})&select=k_member_group,title&limit=50`,
        );
  const fiChoice = chooseFi(groups, signoff.eligibleGroup);

  const lessonDate = formatLessonDate(s.dtl_start_local);
  const lessonTime = formatLessonTime(s.dtl_start_local);
  const code = courseCode(s.text_title);
  const fi = 'fi' in fiChoice ? fiChoice.fi : null;

  let skip: SkipReason | null = 'skip' in fiChoice ? fiChoice.skip : null;
  if (skip === null && (student === null || teacher === null || lessonDate === null)) {
    skip = 'missing-detail';
  }

  // `id` is not in the payload, so on conflict the row keeps the UUID it was
  // created with: a pending lesson re-sent next hour carries the SAME lessonId.
  const written = await db.upsert<{ id?: string }>(
    'lesson_signoff',
    [
      {
        k_business: kBusiness,
        k_visit: kVisit,
        uid: a.uid,
        k_period: a.k_period,
        dt_start_utc: a.dt_start_utc,
        dtl_start_local: s.dtl_start_local,
        class_title: s.text_title,
        student_name: student,
        teacher_name: teacher,
        course_code: code,
        fi_k_member_group: fi?.k_member_group ?? null,
        fi_title: fi?.title ?? null,
        status: skip === null ? 'pending' : 'skipped',
        skip_reason: skip,
      },
    ],
    { onConflict: 'k_visit' },
  );
  if (skip !== null) return { kind: 'skipped', reason: skip };

  // No id back means no way to match the signature later: do not send a form
  // that can never be reconciled. The row stays pending and is retried.
  const lessonId = written[0]?.id;
  if (lessonId === undefined || lessonId.length === 0) {
    return { kind: 'send-failed', detail: 'lesson_signoff id was not returned by the write' };
  }

  // Narrowed by the missing-detail check above.
  const fields: SignoffFields = {
    studentName: student as string,
    lessonDate: lessonDate as string,
    teacherName: teacher as string,
    courseCode: code,
    fiTitle: (fi as { title: string }).title,
    lessonId,
  };
  const mail = signoffEmail({
    ...fields,
    lessonTime: lessonTime ?? '',
    kVisit,
    url: buildPrefillUrl(signoff, fields),
  });
  const result = await smtp.send({ to: signoff.to ?? '', subject: mail.subject, text: mail.text });
  if (!result.ok) return { kind: 'send-failed', detail: result.detail ?? 'unknown error' };

  await db.update(
    'lesson_signoff',
    { status: 'sent', sent_at: nowIso },
    `k_visit=eq.${kVisit}&status=eq.pending`,
  );
  return { kind: 'sent' };
}

/**
 * The lesson's teacher, by uid when the staff row has one, else by k_staff.
 *
 * WHY THE FALLBACK. Appointments - nearly every SDC lesson - arrive with
 * `session_staff.uid` NULL and only `k_staff` set; the staff person row carries
 * the same `k_staff`. Measured 25 Nov 2026: all 6 qualifying lessons of 24 Nov
 * had a null uid and a k_staff that resolved. Reading uid alone skipped every one
 * as 'missing-detail' and would have sent nothing at all.
 */
async function teacherName(
  db: SupabaseClient,
  row: { k_staff: string; uid: string | null } | undefined,
): Promise<string | null> {
  if (row === undefined) return null;
  if (row.uid !== null) {
    const byUid = await personName(db, `uid=eq.${row.uid}`);
    if (byUid !== null) return byUid;
  }
  return personName(db, `k_staff=eq.${row.k_staff}`);
}

async function personName(db: SupabaseClient, filter: string): Promise<string | null> {
  const rows = await db.select<{ first_name: string | null; last_name: string | null }>(
    'person',
    `${filter}&select=first_name,last_name&limit=1`,
  );
  const p = rows[0];
  if (p === undefined) return null;
  const name = [p.first_name, p.last_name]
    .map((n) => (n ?? '').trim())
    .filter((n) => n.length > 0)
    .join(' ');
  return name.length > 0 ? name : null;
}
