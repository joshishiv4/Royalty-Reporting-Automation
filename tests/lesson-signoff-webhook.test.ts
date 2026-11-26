import { describe, expect, it } from 'vitest';
import type { JotformSubmission } from '../src/jotform/client.js';
import { storeOneSubmission } from '../src/sync/lesson-signoff-check.js';
import {
  type FileLock,
  missingWebhookSettings,
  processWebhookSubmission,
  WEBHOOK_BUDGET_MS,
  WEBHOOK_POLL_MS,
  type WebhookDeps,
} from '../src/sync/lesson-signoff-webhook.js';
import { fakeDrive, type FakeFile } from './helpers/fake-drive.js';
import { fakePostgrest, type Row } from './helpers/fake-postgrest.js';

/**
 * Task 039: one submission, stored, checked and filed the moment Jotform's
 * webhook names it. The rules themselves (matching, filing) are tested with
 * phases 2 and 3; what is tested HERE is what the webhook path adds - that it
 * reuses them, that it waits for a late PDF within a budget and then gives way to
 * the hourly pass, and that it never files without the filing job's lock.
 */

const K_BUSINESS = '111111';
const FORM_ID = '42';
const INBOX = 'inbox-folder';
const ROOT = 'root-folder';
const LESSON = 'bbbbbbbb-0000-4000-8000-000000000730';
const SUB = '9001';
const START = Date.parse('2026-11-26T15:00:00.000Z');

const VISIBLE = {
  student: 'Test Student',
  date: 'Friday, October 30, 2026',
  teacherName: 'Test Teacher',
  courseCode: 'MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 120 MINUTES',
  fi: 'ISS',
};

function jotSub(
  id: string,
  lessonId: string,
  over: { visible?: Partial<typeof VISIBLE>; formId?: string; status?: string } = {},
): JotformSubmission {
  const v = { ...VISIBLE, ...over.visible };
  return {
    id,
    form_id: over.formId ?? FORM_ID,
    status: over.status ?? 'ACTIVE',
    created_at: '2026-11-26 10:00:00',
    answers: {
      '5': { name: 'signature', type: 'control_signature', answer: 'https://x.test/s.png' },
      '10': { name: 'courseCode', type: 'control_textbox', answer: v.courseCode },
      '12': { name: 'fi', type: 'control_textbox', answer: v.fi },
      '13': { name: 'student', type: 'control_textbox', answer: v.student },
      '14': { name: 'date', type: 'control_textbox', answer: v.date },
      '15': { name: 'teacherName', type: 'control_textbox', answer: v.teacherName },
      '16': { name: 'lessonId', type: 'control_textbox', answer: lessonId },
    },
  };
}

function lesson(over: Partial<Row> = {}): Row {
  return {
    id: LESSON,
    k_business: K_BUSINESS,
    status: 'sent',
    student_name: 'Test Student',
    teacher_name: 'Test Teacher',
    course_code: VISIBLE.courseCode,
    fi_title: 'ISS',
    dtl_start_local: '2026-10-30T19:30:00',
    jotform_submission_id: null,
    signed_at: null,
    filed_at: null,
    drive_file_id: null,
    ...over,
  };
}

const pdf = (submissionId = SUB): FakeFile => ({
  id: `pdf-${submissionId}`,
  name: `${submissionId}.pdf`,
  parents: [INBOX],
});

/** A lock that records use, and can be held by "someone else". */
function fakeLock(opts: { busy?: boolean } = {}) {
  const state = { held: false, acquired: 0, released: 0, busy: opts.busy ?? false };
  const lock: FileLock = {
    acquire: () => {
      if (state.busy || state.held) return Promise.resolve(false);
      state.held = true;
      state.acquired += 1;
      return Promise.resolve(true);
    },
    release: () => {
      state.held = false;
      state.released += 1;
      return Promise.resolve();
    },
  };
  return { lock, state };
}

/**
 * Everything the webhook needs, in memory, on a fake clock: `sleep` advances the
 * clock and may run a hook (e.g. the PDF arriving after the second wait).
 */
function setup(
  opts: {
    sub?: JotformSubmission;
    lessons?: Row[];
    submissions?: Row[];
    files?: FakeFile[];
    busy?: boolean;
    onSleep?: (n: number, drive: ReturnType<typeof fakeDrive>) => void;
  } = {},
) {
  const f = fakePostgrest(
    {
      lesson_signoff: opts.lessons ?? [lesson()],
      jotform_submission: opts.submissions ?? [],
    },
    // The column default the real table has: a stored submission is unchecked.
    { onUpsert: (t, row) => (t === 'jotform_submission' ? { outcome: null, ...row } : row) },
  );
  const drive = fakeDrive(opts.files ?? [pdf()]);
  const { lock, state } = fakeLock({ busy: opts.busy ?? false });
  let clock = START;
  const sleeps: number[] = [];
  const reads: string[] = [];
  const deps: WebhookDeps = {
    db: f.db,
    jotform: {
      getSubmission: (id: string) => {
        reads.push(id);
        return Promise.resolve(opts.sub ?? jotSub(id, LESSON));
      },
    },
    drive,
    signoff: { formId: FORM_ID, drive: { inboxFolderId: INBOX, rootFolderId: ROOT } },
    kBusiness: K_BUSINESS,
    lock,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      opts.onSleep?.(sleeps.length, drive);
      return Promise.resolve();
    },
  };
  return { f, drive, lockState: state, sleeps, reads, deps };
}

const signoffRow = (f: ReturnType<typeof fakePostgrest>) =>
  (f.tables.lesson_signoff ?? []).find((r) => r.id === LESSON);

describe('processWebhookSubmission', () => {
  it('signed, PDF already in Drive: stored, signed and filed in one go, no wait', async () => {
    const s = setup();
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toEqual({
      kind: 'filing',
      filing: { kind: 'filed', name: 'Test-Student-10-30-2026-0730PM.pdf' },
    });
    expect(s.sleeps).toEqual([]);
    expect(signoffRow(s.f)).toMatchObject({ status: 'signed', jotform_submission_id: SUB });
    expect(signoffRow(s.f)?.filed_at).not.toBeNull();
    expect(s.f.tables.jotform_submission?.[0]).toMatchObject({
      submission_id: SUB,
      outcome: 'signed',
    });
    const moved = s.drive.files.find((x) => x.id === `pdf-${SUB}`);
    expect(moved?.parents).not.toContain(INBOX);
    expect(s.lockState).toMatchObject({ acquired: 1, released: 1, held: false });
  });

  // The usual case on the live form: the webhook beats Jotform's Drive upload.
  it('waits for a PDF that lands a little later, then files it', async () => {
    const s = setup({
      files: [],
      onSleep: (n, drive) => {
        if (n === 2) drive.files.push(pdf());
      },
    });
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toMatchObject({ kind: 'filing', filing: { kind: 'filed' } });
    expect(s.sleeps).toEqual([WEBHOOK_POLL_MS, WEBHOOK_POLL_MS]);
    expect(s.lockState).toMatchObject({ acquired: 3, released: 3, held: false });
  });

  // Past the budget the hourly lesson_signoff_file pass files it - nothing lost.
  it('a PDF that never comes: gives up inside the budget, lesson signed and unfiled', async () => {
    const s = setup({ files: [] });
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toEqual({ kind: 'left-for-hourly', reason: 'pdf-not-in-drive' });
    const waited = s.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeLessThanOrEqual(WEBHOOK_BUDGET_MS);
    expect(waited + WEBHOOK_POLL_MS).toBeGreaterThan(WEBHOOK_BUDGET_MS);
    expect(signoffRow(s.f)).toMatchObject({ status: 'signed', filed_at: null });
    expect(s.lockState.held).toBe(false);
  });

  // The lock is what stops a webhook and the hourly pass (or two webhooks)
  // each creating "ISS - …" or both moving one PDF.
  it('never files without the filing job lock', async () => {
    const s = setup({ busy: true });
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toEqual({ kind: 'left-for-hourly', reason: 'lock-busy' });
    expect(s.drive.calls.move).toEqual([]);
    expect(s.drive.calls.list).toBe(0);
    expect(signoffRow(s.f)).toMatchObject({ status: 'signed', filed_at: null });
  });

  it('releases the lock when filing throws', async () => {
    const s = setup();
    s.deps = {
      ...s.deps,
      drive: { ...s.drive, listFiles: () => Promise.reject(new Error('drive down')) },
    };
    await expect(processWebhookSubmission(s.deps, SUB)).rejects.toThrow('drive down');
    expect(s.lockState).toMatchObject({ acquired: 1, released: 1, held: false });
  });

  // A link whose visible fields were edited is phase 2's 'mismatch' - here too.
  it('an edited form is a mismatch: nothing signed, Drive untouched', async () => {
    const s = setup({ sub: jotSub(SUB, LESSON, { visible: { student: 'Someone Else' } }) });
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toEqual({ kind: 'checked', outcome: 'mismatch' });
    expect(signoffRow(s.f)).toMatchObject({ status: 'sent', signed_at: null });
    expect(s.drive.calls.list).toBe(0);
    expect(s.lockState.acquired).toBe(0);
  });

  it('a lessonId naming no lesson is unknown-lesson and files nothing', async () => {
    const s = setup({ sub: jotSub(SUB, 'cccccccc-0000-4000-8000-000000000000') });
    expect(await processWebhookSubmission(s.deps, SUB)).toEqual({
      kind: 'checked',
      outcome: 'unknown-lesson',
    });
    expect(s.drive.calls.move).toEqual([]);
  });

  it('a submission to another form is ignored and not stored', async () => {
    const s = setup({ sub: jotSub(SUB, LESSON, { formId: '77' }) });
    expect(await processWebhookSubmission(s.deps, SUB)).toEqual({
      kind: 'ignored',
      reason: 'other-form',
    });
    expect(s.f.tables.jotform_submission).toEqual([]);
    expect(signoffRow(s.f)).toMatchObject({ status: 'sent' });
  });

  // Jotform may deliver twice; the second must be a no-op, not a second move.
  it('the same submission delivered twice: one signature, one move', async () => {
    const s = setup();
    await processWebhookSubmission(s.deps, SUB);
    const second = await processWebhookSubmission(s.deps, SUB);

    expect(second).toEqual({ kind: 'checked', outcome: 'already-checked' });
    expect(s.drive.calls.move).toEqual([`pdf-${SUB}`]);
    expect(s.f.tables.jotform_submission).toHaveLength(1);
  });

  // The hourly check got there first but its filing pass has not run: still filed now.
  it('already checked by the hourly pass but unfiled: files it', async () => {
    const s = setup({
      lessons: [lesson({ status: 'signed', jotform_submission_id: SUB, signed_at: 'x' })],
      submissions: [{ submission_id: SUB, k_business: K_BUSINESS, outcome: 'signed' }],
    });
    const result = await processWebhookSubmission(s.deps, SUB);

    expect(result).toMatchObject({ kind: 'filing', filing: { kind: 'filed' } });
    // Its stored verdict is left as the hourly pass wrote it.
    expect(s.f.writes.filter((w) => w.table === 'jotform_submission')).toEqual([]);
  });

  // Only the id is taken from the webhook; everything judged comes from Jotform.
  it('reads the submission back from Jotform by the id it was given', async () => {
    const s = setup();
    await processWebhookSubmission(s.deps, SUB);
    expect(s.reads).toEqual([SUB]);
  });
});

describe('storeOneSubmission', () => {
  it('stores the same unchecked row the hourly pass stores', async () => {
    const f = fakePostgrest({ jotform_submission: [] });
    expect(await storeOneSubmission(f.db, jotSub(SUB, LESSON), FORM_ID, K_BUSINESS)).toBe('stored');
    expect(f.tables.jotform_submission?.[0]).toMatchObject({
      submission_id: SUB,
      k_business: K_BUSINESS,
      form_id: FORM_ID,
      lesson_id_received: LESSON,
      has_signature: true,
    });
    expect(f.tables.jotform_submission?.[0]?.outcome).toBeUndefined();
  });

  it('leaves a known submission alone, and refuses deleted ones', async () => {
    const f = fakePostgrest({ jotform_submission: [{ submission_id: SUB, outcome: 'signed' }] });
    expect(await storeOneSubmission(f.db, jotSub(SUB, LESSON), FORM_ID, K_BUSINESS)).toBe('known');
    expect(f.writes).toEqual([]);
    expect(
      await storeOneSubmission(
        f.db,
        jotSub('9002', LESSON, { status: 'DELETED' }),
        FORM_ID,
        K_BUSINESS,
      ),
    ).toBe('deleted');
  });
});

describe('missingWebhookSettings', () => {
  it('names each missing setting once, detection and filing together', () => {
    const missing = missingWebhookSettings({
      signoff: {
        to: null,
        startDate: null,
        classes: [],
        formHost: null,
        formId: null,
        apiHost: null,
        apiKey: null,
        drive: {
          oauthHost: null,
          apiHost: null,
          clientId: null,
          clientSecret: null,
          refreshToken: null,
          inboxFolderId: null,
          rootFolderId: null,
        },
      },
      smtp: { host: null },
    } as never);
    expect(missing).toContain('JOTFORM_API_KEY');
    expect(missing).toContain('GOOGLE_REFRESH_TOKEN');
    expect(missing.filter((m) => m === 'JOTFORM_FORM_ID')).toHaveLength(1);
  });
});
