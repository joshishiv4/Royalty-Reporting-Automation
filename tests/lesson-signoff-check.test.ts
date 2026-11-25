import { describe, expect, it } from 'vitest';
import type { JotformSubmission } from '../src/jotform/client.js';
import {
  judgeSubmission,
  missingSignoffCheckSettings,
  parseSubmission,
  processSubmission,
  storeNewSubmissions,
  type SignoffForCheck,
} from '../src/sync/lesson-signoff-check.js';
import { fakePostgrest, type Row } from './helpers/fake-postgrest.js';

const K_BUSINESS = '111111';
const FORM_ID = '42';
const NOW = '2026-11-26T15:00:00.000Z';

// Two lessons that look IDENTICAL on the form: same student, day, teacher,
// class and FI; only the hidden lessonId tells them apart (the 30 Oct 2026 case).
const EARLY = 'aaaaaaaa-0000-4000-8000-000000000530';
const LATE = 'bbbbbbbb-0000-4000-8000-000000000730';

function lesson(id: string, time: string, over: Partial<Row> = {}): Row {
  return {
    id,
    k_business: K_BUSINESS,
    status: 'sent',
    student_name: 'Test Student',
    teacher_name: 'Test Teacher',
    course_code: 'MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 120 MINUTES',
    fi_title: 'ISS',
    dtl_start_local: `2026-10-30T${time}:00`,
    jotform_submission_id: null,
    signed_at: null,
    ...over,
  };
}

const VISIBLE = {
  student: 'Test Student',
  date: 'Friday, October 30, 2026',
  teacherName: 'Test Teacher',
  courseCode: 'MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 120 MINUTES',
  fi: 'ISS',
};

/** A Jotform API submission, shaped as the API returns it. */
function jotSub(
  id: string,
  lessonId: string | null,
  over: { visible?: Partial<typeof VISIBLE>; signature?: string; status?: string } = {},
): JotformSubmission {
  const v = { ...VISIBLE, ...over.visible };
  return {
    id,
    form_id: FORM_ID,
    status: over.status ?? 'ACTIVE',
    created_at: '2026-11-26 20:30:00',
    answers: {
      '5': {
        name: 'signature',
        type: 'control_signature',
        answer: over.signature ?? 'https://files.example.test/signature/abc.png',
      },
      '10': { name: 'courseCode', type: 'control_textbox', answer: v.courseCode },
      '12': { name: 'fi', type: 'control_textbox', answer: v.fi },
      '13': { name: 'student', type: 'control_textbox', answer: v.student },
      '14': { name: 'date', type: 'control_textbox', answer: v.date },
      '15': { name: 'teacherName', type: 'control_textbox', answer: v.teacherName },
      '16': { name: 'lessonId', type: 'control_textbox', answer: lessonId ?? '' },
    },
  };
}

/** The stored (unchecked) jotform_submission row for a Jotform submission. */
function stored(sub: JotformSubmission): Row {
  const p = parseSubmission(sub, FORM_ID);
  return {
    submission_id: p.submissionId,
    k_business: K_BUSINESS,
    lesson_id_received: p.lessonId,
    answers: p.answers,
    has_signature: p.hasSignature,
    outcome: null,
  };
}

describe('parseSubmission', () => {
  it('reads the visible fields and the hidden lessonId by unique name', () => {
    const p = parseSubmission(jotSub('9001', LATE), FORM_ID);
    expect(p.lessonId).toBe(LATE);
    expect(p.answers).toEqual(VISIBLE);
    expect(p.hasSignature).toBe(true);
  });

  // A signature answers with an image URL on Jotform's host; a host must never
  // reach a stored record, so only "present or not" survives parsing.
  it('reduces the signature to a boolean - its URL is not kept', () => {
    const p = parseSubmission(jotSub('9001', LATE), FORM_ID);
    expect(JSON.stringify(p)).not.toContain('files.example.test');
    expect(parseSubmission(jotSub('9002', LATE, { signature: '' }), FORM_ID).hasSignature).toBe(
      false,
    );
  });

  it('a blank lessonId is null, not ""', () => {
    expect(parseSubmission(jotSub('9001', null), FORM_ID).lessonId).toBeNull();
  });
});

describe('judgeSubmission', () => {
  const row = lesson(LATE, '19:30') as unknown as SignoffForCheck;
  const sub = (o: Parameters<typeof jotSub>[2] = {}) =>
    parseSubmission(jotSub('9001', LATE, o), FORM_ID);

  it('signs when every visible field equals what was sent', () => {
    expect(judgeSubmission(sub(), row)).toEqual({ outcome: 'signed', detail: null });
  });

  it('ignores whitespace differences only', () => {
    expect(judgeSubmission(sub({ visible: { student: '  Test   Student ' } }), row).outcome).toBe(
      'signed',
    );
  });

  // The fields are read-only on screen, but the link is a URL anyone can edit.
  it('refuses an edited field and names it', () => {
    const v = judgeSubmission(sub({ visible: { fi: 'Self Pay' } }), row);
    expect(v.outcome).toBe('mismatch');
    expect(v.detail).toContain('fi: sent "ISS", got "Self Pay"');
  });

  it('no lesson for the lessonId is unknown-lesson', () => {
    expect(judgeSubmission(sub(), null).outcome).toBe('unknown-lesson');
  });

  it('an empty signature does not sign', () => {
    expect(judgeSubmission(sub({ signature: '' }), row).outcome).toBe('no-signature');
  });

  it('a second submission for a signed lesson is a duplicate; the same one again is signed', () => {
    const signed = { ...row, status: 'signed', jotform_submission_id: '8000' } as SignoffForCheck;
    expect(judgeSubmission(sub(), signed).outcome).toBe('duplicate');
    expect(judgeSubmission(sub(), { ...signed, jotform_submission_id: '9001' }).outcome).toBe(
      'signed',
    );
  });

  it('a skipped lesson (no link was ever sent) is not signed', () => {
    expect(judgeSubmission(sub(), { ...row, status: 'skipped' }).outcome).toBe('mismatch');
  });
});

describe('processSubmission', () => {
  // THE CASE THE HIDDEN FIELD EXISTS FOR. Both lessons' forms show the same five
  // values; the submission names the 7:30 one, and only the 7:30 one is signed.
  it('two identical-looking lessons: signs exactly the one the lessonId names', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(EARLY, '17:30'), lesson(LATE, '19:30')],
      jotform_submission: [stored(jotSub('9001', LATE))],
    });

    expect(await processSubmission(f.db, '9001', NOW)).toBe('signed');

    const [early, late] = f.tables.lesson_signoff as Row[];
    expect(late).toMatchObject({ status: 'signed', signed_at: NOW, jotform_submission_id: '9001' });
    expect(early).toMatchObject({ status: 'sent', jotform_submission_id: null });
    expect(f.tables.jotform_submission?.[0]).toMatchObject({
      outcome: 'signed',
      lesson_signoff_id: LATE,
      checked_at: NOW,
    });
  });

  it('only flips a pending or sent lesson, and records the verdict only once', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(LATE, '19:30')],
      jotform_submission: [stored(jotSub('9001', LATE))],
    });
    await processSubmission(f.db, '9001', NOW);
    const signFlip = f.writes.find((w) => w.table === 'lesson_signoff');
    expect(signFlip?.query).toBe(`id=eq.${LATE}&status=in.(pending,sent)`);
    expect(await processSubmission(f.db, '9001', NOW)).toBe('already-checked');
  });

  it('a lessonId that is not a uuid never reaches the lesson query', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(LATE, '19:30')],
      jotform_submission: [stored(jotSub('9001', 'test-lesson-id-123'))],
    });
    expect(await processSubmission(f.db, '9001', NOW)).toBe('unknown-lesson');
    expect(f.tables.lesson_signoff?.[0]).toMatchObject({ status: 'sent' });
  });

  it('a mismatch leaves the lesson unsigned and links the submission to it', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(LATE, '19:30')],
      jotform_submission: [
        stored(jotSub('9001', LATE, { visible: { date: 'Saturday, October 31, 2026' } })),
      ],
    });
    expect(await processSubmission(f.db, '9001', NOW)).toBe('mismatch');
    expect(f.tables.lesson_signoff?.[0]).toMatchObject({ status: 'sent', signed_at: null });
    expect(f.tables.jotform_submission?.[0]).toMatchObject({
      outcome: 'mismatch',
      lesson_signoff_id: LATE,
    });
  });

  it('losing the race to another submission records a duplicate', async () => {
    const f = fakePostgrest(
      {
        lesson_signoff: [lesson(LATE, '19:30')],
        jotform_submission: [stored(jotSub('9001', LATE))],
      },
      { updateReturnsNothing: ['lesson_signoff'] },
    );
    expect(await processSubmission(f.db, '9001', NOW)).toBe('duplicate');
  });
});

describe('storeNewSubmissions', () => {
  function jotform(pages: JotformSubmission[][]) {
    const calls: number[] = [];
    return {
      calls,
      client: {
        listSubmissions: (_form: string, p: { offset: number; limit: number }) => {
          calls.push(p.offset);
          return Promise.resolve(pages[p.offset / p.limit] ?? []);
        },
      },
    };
  }

  it('stores new submissions unchecked and stops at the first page holding a known one', async () => {
    // A FULL page (so page size alone would read on) that ends in one already stored.
    const older = Array.from({ length: 97 }, (_, i) => ({ submission_id: String(8000 + i) }));
    const f = fakePostgrest({
      jotform_submission: [{ submission_id: '9000', k_business: K_BUSINESS }, ...older],
    });
    const page0 = [
      jotSub('9002', LATE),
      jotSub('9001', EARLY),
      jotSub('9000', EARLY),
      ...older.map((o) => jotSub(o.submission_id, EARLY)),
    ];
    expect(page0).toHaveLength(100);
    const j = jotform([page0, [jotSub('7999', EARLY)]]);

    expect(await storeNewSubmissions(f.db, j.client, { formId: FORM_ID }, K_BUSINESS)).toBe(2);
    expect(j.calls).toEqual([0]);
    const ids = (f.tables.jotform_submission ?? []).map((r) => r.submission_id);
    expect(ids.slice(0, 1).concat(ids.slice(-2))).toEqual(['9000', '9002', '9001']);
    const newest = (f.tables.jotform_submission ?? []).find((r) => r.submission_id === '9002');
    expect(newest).toMatchObject({ lesson_id_received: LATE, has_signature: true });
    expect(newest?.outcome).toBeUndefined();
  });

  it('pages on while every submission on a full page is new', async () => {
    const full = Array.from({ length: 100 }, (_, i) => jotSub(String(9100 + i), LATE));
    const f = fakePostgrest({ jotform_submission: [] });
    const j = jotform([full, [jotSub('9000', LATE)]]);
    expect(await storeNewSubmissions(f.db, j.client, { formId: FORM_ID }, K_BUSINESS)).toBe(101);
    expect(j.calls).toEqual([0, 100]);
  });

  it('does not store a deleted submission', async () => {
    const f = fakePostgrest({ jotform_submission: [] });
    const j = jotform([[jotSub('9001', LATE, { status: 'DELETED' })]]);
    expect(await storeNewSubmissions(f.db, j.client, { formId: FORM_ID }, K_BUSINESS)).toBe(0);
  });
});

describe('missingSignoffCheckSettings', () => {
  it('names the Jotform API settings when unset', () => {
    expect(
      missingSignoffCheckSettings({
        signoff: { apiHost: null, apiKey: null, formId: null } as never,
      }),
    ).toEqual(['JOTFORM_API_HOST', 'JOTFORM_API_KEY', 'JOTFORM_FORM_ID']);
  });
});
