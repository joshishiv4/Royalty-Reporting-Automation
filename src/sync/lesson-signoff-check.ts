import type { AppConfig, SignoffConfig } from '../config/schema.js';
import type { JotformClient, JotformSubmission } from '../jotform/client.js';
import type { SupabaseClient } from '../supabase/client.js';
import { formatLessonDate, JOTFORM_FIELDS } from './lesson-signoff.js';

/**
 * Lesson sign-off, phase 2: notice when a lesson's form comes back signed.
 *
 * HOW A SUBMISSION FINDS ITS LESSON. Every link carries the lesson_signoff row's
 * `id` in the form's HIDDEN `lessonId` field, and Jotform returns it with the
 * submission. Nothing else can do the job: the form shows no time, so two
 * lessons on one day with the same student, teacher, class and FI produce
 * identical visible forms (measured: one SDC student, 30 Oct 2026, 5:30 and
 * 7:30 PM). Matching on the visible fields would sign the wrong one of the two.
 *
 * WHY THE VISIBLE FIELDS ARE STILL CHECKED. The fields are read-only on screen,
 * but the link is a URL and anyone holding it can edit the query. A submission
 * is accepted only if student, date, teacher, course code and FI equal what was
 * sent; otherwise it is recorded as 'mismatch' and the lesson stays unsigned.
 *
 * POLLED, NOT PUSHED. Phase 1's trigger is the hourly sync, and so is this: one
 * GET per hour, newest first, stopping at the first page holding a submission
 * already stored. Jotform's webhook can be added later without changing the
 * matching - it would only deliver the same submission sooner.
 */

/** Rows per page when reading submissions. One page an hour is the normal case. */
const PAGE_SIZE = 100;
/** A backlog guard: 50 pages is 5,000 submissions, ten months of this studio. */
const MAX_PAGES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The visible fields a submission must repeat exactly, by form unique name. */
const VISIBLE_FIELDS = [
  JOTFORM_FIELDS.student,
  JOTFORM_FIELDS.date,
  JOTFORM_FIELDS.teacher,
  JOTFORM_FIELDS.courseCode,
  JOTFORM_FIELDS.fi,
] as const;

export type SubmissionOutcome =
  'signed' | 'mismatch' | 'unknown-lesson' | 'no-signature' | 'duplicate';

/** The settings signature detection needs, named when missing. */
export function missingSignoffCheckSettings(config: Pick<AppConfig, 'signoff'>): string[] {
  const s = config.signoff;
  const missing: string[] = [];
  if (s.apiHost === null) missing.push('JOTFORM_API_HOST');
  if (s.apiKey === null) missing.push('JOTFORM_API_KEY');
  if (s.formId === null) missing.push('JOTFORM_FORM_ID');
  return missing;
}

export interface ParsedSubmission {
  readonly submissionId: string;
  readonly formId: string;
  readonly status: string;
  readonly jotformCreatedAt: string | null;
  /** The hidden lessonId as received - anything at all, until checked. */
  readonly lessonId: string | null;
  /** Visible text fields by unique name. */
  readonly answers: Readonly<Record<string, string>>;
  readonly hasSignature: boolean;
}

/**
 * The text of one answer. Text boxes answer a string; a few Jotform field types
 * answer an object with a `prettyFormat`. Anything else is treated as blank.
 */
function answerText(a: { answer?: unknown; prettyFormat?: unknown }): string {
  if (typeof a.answer === 'string') return a.answer;
  if (typeof a.prettyFormat === 'string') return a.prettyFormat;
  return '';
}

/**
 * The parts of a Jotform submission matching needs. The signature's answer is a
 * URL on Jotform's host - it is reduced to "present or not" here, so the URL
 * never reaches a stored record.
 */
export function parseSubmission(sub: JotformSubmission, formId: string): ParsedSubmission {
  const answers: Record<string, string> = {};
  let lessonId: string | null = null;
  let hasSignature = false;
  for (const a of Object.values(sub.answers ?? {})) {
    const name = a.name ?? '';
    if (a.type === 'control_signature') {
      hasSignature = hasSignature || answerText(a).trim().length > 0;
      continue;
    }
    if (name === JOTFORM_FIELDS.lessonId) {
      const v = answerText(a).trim();
      lessonId = v.length > 0 ? v : null;
      continue;
    }
    if ((VISIBLE_FIELDS as readonly string[]).includes(name)) answers[name] = answerText(a);
  }
  return {
    submissionId: sub.id,
    formId: sub.form_id ?? formId,
    status: sub.status ?? 'ACTIVE',
    jotformCreatedAt: sub.created_at ?? null,
    lessonId,
    answers,
    hasSignature,
  };
}

/** The lesson_signoff columns a submission is checked against. */
export interface SignoffForCheck {
  readonly id: string;
  readonly status: 'pending' | 'sent' | 'skipped' | 'signed';
  readonly student_name: string | null;
  readonly teacher_name: string | null;
  readonly course_code: string;
  readonly fi_title: string | null;
  readonly dtl_start_local: string;
  readonly jotform_submission_id: string | null;
}

/** What the form should have said for this lesson, by unique name. */
export function expectedAnswers(row: SignoffForCheck): Record<string, string> {
  return {
    [JOTFORM_FIELDS.student]: row.student_name ?? '',
    [JOTFORM_FIELDS.date]: formatLessonDate(row.dtl_start_local) ?? '',
    [JOTFORM_FIELDS.teacher]: row.teacher_name ?? '',
    [JOTFORM_FIELDS.courseCode]: row.course_code,
    [JOTFORM_FIELDS.fi]: row.fi_title ?? '',
  };
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The verdict for one submission against the lesson its lessonId names (or null
 * when it names none). Pure, so every rule is tested without a database.
 */
export function judgeSubmission(
  sub: Pick<ParsedSubmission, 'submissionId' | 'answers' | 'hasSignature'>,
  row: SignoffForCheck | null,
): { outcome: SubmissionOutcome; detail: string | null } {
  if (row === null) {
    return { outcome: 'unknown-lesson', detail: 'lessonId names no sign-off' };
  }
  if (row.status === 'signed') {
    return row.jotform_submission_id === sub.submissionId
      ? { outcome: 'signed', detail: null }
      : { outcome: 'duplicate', detail: `already signed by ${row.jotform_submission_id ?? '?'}` };
  }
  if (!sub.hasSignature) return { outcome: 'no-signature', detail: null };
  if (row.status === 'skipped') {
    return { outcome: 'mismatch', detail: 'the lesson was skipped - no link was sent for it' };
  }
  const expected = expectedAnswers(row);
  const wrong = VISIBLE_FIELDS.filter(
    (f) => norm(sub.answers[f] ?? '') !== norm(expected[f] ?? ''),
  );
  if (wrong.length > 0) {
    return {
      outcome: 'mismatch',
      detail: wrong
        .map((f) => `${f}: sent "${expected[f] ?? ''}", got "${sub.answers[f] ?? ''}"`)
        .join('; '),
    };
  }
  return { outcome: 'signed', detail: null };
}

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

/**
 * Reads new submissions from Jotform and stores them unchecked (outcome null).
 * Newest first; stops at the first page that holds one already stored.
 * Deleted submissions are not stored. Returns how many were new.
 */
export async function storeNewSubmissions(
  db: SupabaseClient,
  jotform: Pick<JotformClient, 'listSubmissions'>,
  signoff: Pick<SignoffConfig, 'formId'>,
  kBusiness: string,
): Promise<number> {
  const formId = signoff.formId;
  if (formId === null) return 0;
  let stored = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const subs = await jotform.listSubmissions(formId, {
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    if (subs.length === 0) break;

    const ids = subs.map((s) => s.id);
    const known = await db.select<{ submission_id: string }>(
      'jotform_submission',
      `submission_id=in.(${ids.join(',')})&select=submission_id&limit=${String(PAGE_SIZE)}`,
    );
    const seen = new Set(known.map((k) => k.submission_id));
    const fresh = subs
      .filter((s) => !seen.has(s.id))
      .map((s) => parseSubmission(s, formId))
      .filter((p) => p.status !== 'DELETED');
    if (fresh.length > 0) {
      await db.upsert(
        'jotform_submission',
        fresh.map((p) => ({
          submission_id: p.submissionId,
          k_business: kBusiness,
          form_id: p.formId,
          jotform_created_at: p.jotformCreatedAt,
          lesson_id_received: p.lessonId,
          answers: p.answers,
          has_signature: p.hasSignature,
        })),
        { onConflict: 'submission_id' },
      );
      stored += fresh.length;
    }
    if (seen.size > 0 || subs.length < PAGE_SIZE) break;
  }
  return stored;
}

/** Stored submissions not yet checked - the queue seed. */
export async function uncheckedSubmissions(
  db: SupabaseClient,
  kBusiness: string,
): Promise<string[]> {
  const rows = await db.selectAll<{ submission_id: string }>(
    'jotform_submission',
    `k_business=eq.${kBusiness}&outcome=is.null&select=submission_id&order=submission_id.asc`,
  );
  return rows.map((r) => r.submission_id);
}

/** A stored jotform_submission, as processSubmission reads it. */
type StoredSubmission = {
  submission_id: string;
  lesson_id_received: string | null;
  answers: Record<string, string> | null;
  has_signature: boolean;
  outcome: SubmissionOutcome | null;
};

const SIGNOFF_CHECK_COLUMNS =
  'id,status,student_name,teacher_name,course_code,fi_title,dtl_start_local,jotform_submission_id';

/**
 * Checks one stored submission and records the verdict. A 'signed' verdict
 * flips the lesson to signed - only from pending or sent, so a race with a
 * second submission for the same lesson leaves one winner and one 'duplicate'.
 */
export async function processSubmission(
  db: SupabaseClient,
  submissionId: string,
  nowIso: string,
): Promise<SubmissionOutcome | 'already-checked' | 'gone'> {
  const stored = await db.select<StoredSubmission>(
    'jotform_submission',
    `submission_id=eq.${submissionId}` +
      `&select=submission_id,lesson_id_received,answers,has_signature,outcome&limit=1`,
  );
  const s = stored[0];
  if (s === undefined) return 'gone';
  if (s.outcome !== null) return 'already-checked';

  // A non-uuid would make PostgREST reject the id filter: it names no lesson.
  const lessonId = s.lesson_id_received;
  const rows =
    lessonId !== null && UUID.test(lessonId)
      ? await db.select<SignoffForCheck>(
          'lesson_signoff',
          `id=eq.${lessonId}&select=${SIGNOFF_CHECK_COLUMNS}&limit=1`,
        )
      : [];
  const row = rows[0] ?? null;

  let verdict = judgeSubmission(
    { submissionId, answers: s.answers ?? {}, hasSignature: s.has_signature },
    row,
  );

  if (verdict.outcome === 'signed' && row !== null && row.status !== 'signed') {
    const flipped = await db.update(
      'lesson_signoff',
      { status: 'signed', signed_at: nowIso, jotform_submission_id: submissionId },
      `id=eq.${row.id}&status=in.(pending,sent)`,
    );
    if (flipped.length === 0) {
      // Lost a race: another submission signed it between the read and the write.
      verdict = { outcome: 'duplicate', detail: 'signed by another submission meanwhile' };
    }
  }

  await db.update(
    'jotform_submission',
    {
      outcome: verdict.outcome,
      detail: verdict.detail,
      lesson_signoff_id: row?.id ?? null,
      checked_at: nowIso,
    },
    `submission_id=eq.${submissionId}&outcome=is.null`,
  );
  return verdict.outcome;
}
