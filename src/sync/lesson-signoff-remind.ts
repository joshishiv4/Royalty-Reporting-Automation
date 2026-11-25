import type { AppConfig, SignoffConfig } from '../config/schema.js';
import type { SmtpClient } from '../notify/smtp.js';
import type { SupabaseClient } from '../supabase/client.js';
import { missingSignoffCheckSettings } from './lesson-signoff-check.js';
import {
  buildPrefillUrl,
  formatLessonDate,
  formatLessonTime,
  localDate,
  missingSignoffSettings,
  signoffEmail,
  type SignoffFields,
} from './lesson-signoff.js';

/**
 * Lesson sign-off, phase 2: reminders until a lesson is signed, and one list of
 * what is still unsigned the day before month end.
 *
 * THE SCHEDULE (agreed with the user 25 Nov 2026). The same link is sent again
 * +3 days and +7 days after the first email, and 3 days before the lesson's
 * month end (the deadline). The day before month end the admin gets one list of
 * everything that month still unsigned.
 *
 * STEPS TOO CLOSE TOGETHER ARE DROPPED. A lesson emailed on the 26th would get
 * "3 days before month end" the next morning and "+3 days" a day later - two
 * reminders inside two days. A step closer than REMINDER_MIN_GAP_MS to the one
 * before it (or to the first email) is dropped.
 *
 * OVERDUE STEPS ARE SENT AS ONE. If the sync stops for a week, the next run sends
 * one reminder and counts every step that fell due, rather than a burst.
 *
 * NEVER WITHOUT DETECTION. Reminders need to know what is signed, so this pass
 * runs only when the Jotform API is configured too; and a lesson with a submission
 * not yet checked waits for the check rather than being reminded.
 *
 * STUDIO TIME. Every date here is the studio's wall clock (SIGNOFF_TIMEZONE), not
 * the runner's UTC one: "month end" is the studio's month end.
 */

const DAY_MS = 86_400_000;
/** Month-end steps fall at 09:00 studio time, not at midnight. */
const SEND_HOUR = 9;
/** Two reminders are never closer than this. */
export const REMINDER_MIN_GAP_MS = 2 * DAY_MS;
/** The most steps a lesson can have: +3 days, +7 days, month end - 3. */
export const MAX_REMINDERS = 3;

/** Both phase 1's settings and the Jotform API's: no reminders without detection. */
export function missingSignoffRemindSettings(
  config: Pick<AppConfig, 'signoff' | 'smtp'>,
): string[] {
  return [...new Set([...missingSignoffSettings(config), ...missingSignoffCheckSettings(config)])];
}

/**
 * An instant as the studio's wall clock, encoded as a UTC epoch (so ordinary
 * Date.UTC arithmetic works on it). Not an instant - only compare it with others
 * made the same way.
 */
export function wallClockMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

/** Wall-clock ms of the last day of a month (1-based), at midnight. */
function lastDayOfMonth(year: number, month: number): number {
  return Date.UTC(year, month, 0);
}

/**
 * When a lesson's reminders fall due, as wall-clock ms, in order.
 *
 * @param sentWall  the first email, as studio wall clock
 * @param year      the lesson's year
 * @param month     the lesson's month, 1-12
 */
export function reminderSchedule(sentWall: number, year: number, month: number): number[] {
  const monthEndStep = lastDayOfMonth(year, month) - 3 * DAY_MS + SEND_HOUR * 3_600_000;
  const steps = [sentWall + 3 * DAY_MS, sentWall + 7 * DAY_MS, monthEndStep]
    .filter((t) => t > sentWall)
    .sort((a, b) => a - b);
  const kept: number[] = [];
  for (const t of steps) {
    const previous = kept.length === 0 ? sentWall : (kept[kept.length - 1] as number);
    if (t - previous >= REMINDER_MIN_GAP_MS) kept.push(t);
  }
  return kept;
}

/** How many of a lesson's reminder steps are due at `nowMs`, and how many it has in all. */
export function remindersDue(
  row: { readonly sent_at: string; readonly dtl_start_local: string },
  timeZone: string,
  nowMs: number,
): { due: number; total: number } {
  const date = localDate(row.dtl_start_local);
  if (date === null) return { due: 0, total: 0 };
  const [year, month] = date.split('-').map(Number) as [number, number];
  const schedule = reminderSchedule(wallClockMs(Date.parse(row.sent_at), timeZone), year, month);
  const now = wallClockMs(nowMs, timeZone);
  return { due: schedule.filter((t) => t <= now).length, total: schedule.length };
}

/** `YYYY-MM-01` of a wall-clock month. */
function monthKey(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-01`;
}

/**
 * The months whose unsigned list is due: the current one from 09:00 on the day
 * before its last day, and always the previous one (so a list missed while the
 * sync was down still goes out). Never a month before SIGNOFF_START_DATE's.
 * The caller skips months already reported.
 */
export function reportMonthsDue(nowWall: number, startDate: string): string[] {
  const d = new Date(nowWall);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const previous = month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1);
  const due = [previous];
  const currentDueAt = lastDayOfMonth(year, month) - DAY_MS + SEND_HOUR * 3_600_000;
  if (nowWall >= currentDueAt) due.push(monthKey(year, month));
  const first = `${startDate.slice(0, 7)}-01`;
  return due.filter((m) => m >= first);
}

/** `2026-11-01` -> `2026-12-01`. */
function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
}

/** `2026-11-01` -> "November 2026". */
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

// ---------------------------------------------------------------------------
// Reminders, one lesson at a time
// ---------------------------------------------------------------------------

interface ReminderRow {
  readonly id: string;
  readonly k_visit: string;
  readonly status: 'pending' | 'sent' | 'skipped' | 'signed';
  readonly sent_at: string | null;
  readonly reminder_count: number;
  readonly dtl_start_local: string;
  readonly student_name: string | null;
  readonly teacher_name: string | null;
  readonly course_code: string;
  readonly fi_title: string | null;
}

const REMINDER_COLUMNS =
  'id,k_visit,status,sent_at,reminder_count,dtl_start_local,student_name,teacher_name,course_code,fi_title';

type DueRow = { id: string; sent_at: string; dtl_start_local: string; reminder_count: number };

/** The lessons with a reminder due now - the queue seed. */
export async function remindersDueNow(
  db: SupabaseClient,
  kBusiness: string,
  timeZone: string,
  nowMs: number,
): Promise<string[]> {
  const rows = await db.selectAll<DueRow>(
    'lesson_signoff',
    `k_business=eq.${kBusiness}&status=eq.sent&sent_at=not.is.null` +
      `&reminder_count=lt.${String(MAX_REMINDERS)}` +
      `&select=id,sent_at,dtl_start_local,reminder_count&order=id.asc`,
  );
  return rows
    .filter((r) => remindersDue(r, timeZone, nowMs).due > r.reminder_count)
    .map((r) => r.id);
}

export type ReminderResult =
  | { readonly kind: 'sent'; readonly step: number }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'wait-for-check' }
  | { readonly kind: 'send-failed'; readonly detail: string };

/** The form fields of a sent lesson, or null if any is missing. */
function fieldsOf(row: ReminderRow): SignoffFields | null {
  const lessonDate = formatLessonDate(row.dtl_start_local);
  if (
    row.student_name === null ||
    row.teacher_name === null ||
    row.fi_title === null ||
    lessonDate === null
  ) {
    return null;
  }
  return {
    studentName: row.student_name,
    lessonDate,
    teacherName: row.teacher_name,
    courseCode: row.course_code,
    fiTitle: row.fi_title,
    lessonId: row.id,
  };
}

/** Sends one lesson's due reminder, with the SAME link (same lessonId) as the first email. */
export async function processReminder(
  db: SupabaseClient,
  smtp: SmtpClient,
  signoff: SignoffConfig,
  lessonId: string,
  nowMs: number,
): Promise<ReminderResult> {
  const rows = await db.select<ReminderRow>(
    'lesson_signoff',
    `id=eq.${lessonId}&select=${REMINDER_COLUMNS}&limit=1`,
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'sent' || row.sent_at === null) {
    return { kind: 'not-needed' };
  }
  const { due, total } = remindersDue(
    { sent_at: row.sent_at, dtl_start_local: row.dtl_start_local },
    signoff.timeZone,
    nowMs,
  );
  if (due <= row.reminder_count) return { kind: 'not-needed' };

  // A submission for this lesson is waiting to be checked: it may be the
  // signature. Reminding now would ask a parent who has already signed.
  const unchecked = await db.select<{ submission_id: string }>(
    'jotform_submission',
    `lesson_id_received=eq.${lessonId}&outcome=is.null&select=submission_id&limit=1`,
  );
  if (unchecked.length > 0) return { kind: 'wait-for-check' };

  const fields = fieldsOf(row);
  if (fields === null) return { kind: 'not-needed' };
  const first = signoffEmail({
    ...fields,
    lessonTime: formatLessonTime(row.dtl_start_local) ?? '',
    kVisit: row.k_visit,
    url: buildPrefillUrl(signoff, fields),
  });
  const result = await smtp.send({
    to: signoff.to ?? '',
    subject: `Reminder ${String(due)} of ${String(total)}: ${first.subject}`,
    text: `REMINDER - this lesson is still waiting for a signature.\n\n${first.text}`,
  });
  if (!result.ok) return { kind: 'send-failed', detail: result.detail ?? 'unknown error' };

  // Counts every step now due, so overdue steps are not sent one after another.
  await db.update(
    'lesson_signoff',
    { reminder_count: due, last_reminded_at: new Date(nowMs).toISOString() },
    `id=eq.${lessonId}&status=eq.sent&reminder_count=eq.${String(row.reminder_count)}`,
  );
  return { kind: 'sent', step: due };
}

// ---------------------------------------------------------------------------
// The month-end list
// ---------------------------------------------------------------------------

const SKIP_TEXT: Readonly<Record<string, string>> = {
  'no-fi': 'no FI group in WellnessLiving',
  'multiple-fi': 'two FI groups in WellnessLiving',
  'missing-detail': 'student or teacher name missing',
};

interface ReportLesson extends ReminderRow {
  readonly skip_reason: string | null;
}

/** The unsigned-list email for one month. Pure. */
export function monthReportEmail(
  signoff: Pick<SignoffConfig, 'formHost' | 'formId'>,
  month: string,
  lessons: readonly ReportLesson[],
  unmatched: ReadonlyArray<{ submission_id: string; outcome: string; detail: string | null }>,
): { subject: string; text: string; unsigned: number; skipped: number } {
  const label = monthLabel(month);
  const when = (r: ReminderRow): string =>
    `${formatLessonDate(r.dtl_start_local) ?? r.dtl_start_local}, ${formatLessonTime(r.dtl_start_local) ?? ''}`;
  const unsigned = lessons.filter((l) => l.status === 'pending' || l.status === 'sent');
  const skipped = lessons.filter((l) => l.status === 'skipped');

  const lines = [`Lesson sign-offs for ${label}. Every lesson must be signed by month end.`, ''];
  lines.push(`Still unsigned (${String(unsigned.length)}):`);
  if (unsigned.length === 0) lines.push('- none');
  for (const l of unsigned) {
    lines.push(
      `- ${when(l)} - ${l.student_name ?? '?'} - ${l.teacher_name ?? '?'} - ${l.fi_title ?? '?'}`,
    );
    const fields = fieldsOf(l);
    if (fields !== null) lines.push(`  ${buildPrefillUrl(signoff, fields)}`);
  }
  lines.push('', `Not sent - fix in WellnessLiving (${String(skipped.length)}):`);
  if (skipped.length === 0) lines.push('- none');
  for (const l of skipped) {
    const reason = SKIP_TEXT[l.skip_reason ?? ''] ?? l.skip_reason ?? 'unknown';
    lines.push(`- ${when(l)} - ${l.student_name ?? '?'} - ${reason}`);
  }
  if (unmatched.length > 0) {
    lines.push('', `Submissions that did not sign a lesson (${String(unmatched.length)}):`);
    for (const u of unmatched) {
      lines.push(
        `- Jotform submission ${u.submission_id}: ${u.outcome}${u.detail === null ? '' : ` - ${u.detail}`}`,
      );
    }
  }
  lines.push('', 'Sent automatically by the lesson sign-off sync.');
  return {
    subject: `Unsigned lessons - ${label}: ${String(unsigned.length)} unsigned, ${String(skipped.length)} not sent`,
    text: lines.join('\n'),
    unsigned: unsigned.length,
    skipped: skipped.length,
  };
}

/**
 * Sends each due month's unsigned list once. A month is recorded in
 * lesson_signoff_report only after its email went out, so a failed send is
 * retried next hour. Returns the months sent and the months that failed.
 */
export async function sendDueMonthReports(
  db: SupabaseClient,
  smtp: SmtpClient,
  signoff: SignoffConfig,
  kBusiness: string,
  nowMs: number,
): Promise<{ sent: string[]; failed: string[] }> {
  const out = { sent: [] as string[], failed: [] as string[] };
  if (signoff.startDate === null) return out;
  for (const month of reportMonthsDue(wallClockMs(nowMs, signoff.timeZone), signoff.startDate)) {
    const done = await db.select<{ month: string }>(
      'lesson_signoff_report',
      `k_business=eq.${kBusiness}&month=eq.${month}&select=month&limit=1`,
    );
    if (done.length > 0) continue;

    const next = nextMonthKey(month);
    const lessons = await db.selectAll<ReportLesson>(
      'lesson_signoff',
      `k_business=eq.${kBusiness}` +
        `&dtl_start_local=gte.${month}T00:00:00&dtl_start_local=lt.${next}T00:00:00` +
        `&select=${REMINDER_COLUMNS},skip_reason&order=dtl_start_local.asc,id.asc`,
    );
    const unmatched = await db.selectAll<{
      submission_id: string;
      outcome: string;
      detail: string | null;
    }>(
      'jotform_submission',
      `k_business=eq.${kBusiness}&outcome=in.(mismatch,unknown-lesson,no-signature)` +
        `&first_seen_at=gte.${month}&first_seen_at=lt.${next}` +
        `&select=submission_id,outcome,detail&order=submission_id.asc`,
    );
    const mail = monthReportEmail(signoff, month, lessons, unmatched);
    const result = await smtp.send({
      to: signoff.to ?? '',
      subject: mail.subject,
      text: mail.text,
    });
    if (!result.ok) {
      out.failed.push(month);
      continue;
    }
    await db.upsert(
      'lesson_signoff_report',
      [
        {
          k_business: kBusiness,
          month,
          sent_at: new Date(nowMs).toISOString(),
          unsigned_count: mail.unsigned,
          skipped_count: mail.skipped,
        },
      ],
      { onConflict: 'k_business,month' },
    );
    out.sent.push(month);
  }
  return out;
}
