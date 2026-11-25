import { describe, expect, it, vi } from 'vitest';
import type { SignoffConfig } from '../src/config/schema.js';
import type { MailEnvelope, SmtpClient } from '../src/notify/smtp.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import {
  buildPrefillUrl,
  chooseFi,
  classFamily,
  courseCode,
  formatLessonDate,
  formatLessonTime,
  isSignoffClass,
  lessonSignoffCandidates,
  localDate,
  missingSignoffSettings,
  processLessonSignoff,
} from '../src/sync/lesson-signoff.js';

const K_BUSINESS = '111111';
const CLASSES = ['Music For Everyone', 'DJ For Everyone', 'Music Production For Everyone'];
const SIGNOFF: SignoffConfig = {
  to: 'admin@example.test',
  startDate: '2026-11-24',
  classes: CLASSES,
  eligibleGroup: 'SDC Clients',
  formHost: 'form.example.test',
  formId: '42',
};

describe('the form fields, in the studio sample format', () => {
  it('Course Code: upper case, " | " as " - " - exactly the signed sample', () => {
    expect(courseCode('Music For Everyone | Live Performance Instruction | 60 Minutes')).toBe(
      'MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 60 MINUTES',
    );
    expect(courseCode('Music For Everyone | 45 Minutes')).toBe('MUSIC FOR EVERYONE - 45 MINUTES');
  });

  it('Date: "Friday, October 30, 2026" from the LOCAL start, never shifted by a timezone', () => {
    expect(formatLessonDate('2026-10-30T21:30:00')).toBe('Friday, October 30, 2026');
    // 23:30 local is still the 30th: a UTC conversion would move it to the 31st.
    expect(formatLessonDate('2026-10-30 23:30:00')).toBe('Friday, October 30, 2026');
    expect(formatLessonDate('not a date')).toBeNull();
  });

  it('Time: 12-hour clock, noon and midnight handled', () => {
    expect(formatLessonTime('2026-10-30T17:30:00')).toBe('5:30 PM');
    expect(formatLessonTime('2026-10-30T12:00:00')).toBe('12:00 PM');
    expect(formatLessonTime('2026-10-30T00:05:00')).toBe('12:05 AM');
  });

  it('localDate reads the calendar date of a local timestamp', () => {
    expect(localDate('2026-11-24T09:00:00')).toBe('2026-11-24');
  });
});

describe('which classes get a sign-off', () => {
  it('matches on the part before the first "|", ignoring case', () => {
    expect(classFamily('DJ For Everyone | In-Home | 30 Minutes')).toBe('DJ For Everyone');
    expect(isSignoffClass('Music For Everyone | In-Home | 45 Minutes', CLASSES)).toBe(true);
    expect(isSignoffClass('music production for everyone | 30 Minutes', CLASSES)).toBe(true);
    // LPI is covered because every LPI title starts with Music or DJ For Everyone.
    expect(
      isSignoffClass('DJ For Everyone | Live Performance Instruction | 120 Minutes', CLASSES),
    ).toBe(true);
  });

  // The studio excluded these on 25 Nov 2026. "DJ Private" must not slip in on
  // a loose substring match against "DJ For Everyone".
  it('excludes Media, Podcasting, A Joyful Noise and DJ Private', () => {
    for (const title of [
      'Media For Everyone | 60 Minutes',
      'Podcasting For Everyone | 60 Minutes',
      'A Joyful Noise | 60 Minutes',
      'DJ Private | Virtual | 60 Minutes',
    ]) {
      expect(isSignoffClass(title, CLASSES), title).toBe(false);
    }
  });
});

describe('chooseFi', () => {
  const g = (k: string, title: string) => ({ k_member_group: k, title });

  it('is the one group other than the eligible group - Self Pay included', () => {
    expect(chooseFi([g('1', 'SDC Clients'), g('2', 'EEDA')], 'SDC Clients')).toEqual({
      fi: { k_member_group: '2', title: 'EEDA' },
    });
    expect(chooseFi([g('1', 'SDC Clients'), g('3', 'Self Pay')], 'sdc clients')).toEqual({
      fi: { k_member_group: '3', title: 'Self Pay' },
    });
  });

  it('skips with no FI, and never guesses between two', () => {
    expect(chooseFi([g('1', 'SDC Clients')], 'SDC Clients')).toEqual({ skip: 'no-fi' });
    expect(
      chooseFi([g('1', 'SDC Clients'), g('2', 'ISS'), g('3', 'Self Pay')], 'SDC Clients'),
    ).toEqual({ skip: 'multiple-fi' });
  });
});

describe('buildPrefillUrl', () => {
  const fields = {
    studentName: 'Test Student',
    lessonDate: 'Friday, October 30, 2026',
    teacherName: 'Test Teacher',
    courseCode: 'MUSIC FOR EVERYONE - 60 MINUTES',
    fiTitle: 'F.R.E.E. Services',
    lessonId: '0b6f2a1e-7c3d-4e5f-9a8b-1c2d3e4f5a6b',
  };

  it('uses the form unique names and %20 encoding, host and id from config', () => {
    const url = buildPrefillUrl(SIGNOFF, fields);
    expect(url).toBe(
      'https://form.example.test/42?student=Test%20Student' +
        '&date=Friday%2C%20October%2030%2C%202026&teacherName=Test%20Teacher' +
        '&courseCode=MUSIC%20FOR%20EVERYONE%20-%2060%20MINUTES&fi=F.R.E.E.%20Services' +
        '&lessonId=0b6f2a1e-7c3d-4e5f-9a8b-1c2d3e4f5a6b',
    );
  });

  // Two lessons on one day can have identical visible fields; the hidden
  // lessonId is the only thing that tells their submissions apart.
  it('refuses to build a link without a lessonId', () => {
    expect(() => buildPrefillUrl(SIGNOFF, { ...fields, lessonId: '' })).toThrow(/lessonId/);
    expect(() => buildPrefillUrl(SIGNOFF, { ...fields, lessonId: '  ' })).toThrow(/lessonId/);
  });

  it('refuses to build a link with no form configured', () => {
    expect(() => buildPrefillUrl({ formHost: null, formId: '42' }, fields)).toThrow();
  });
});

describe('missingSignoffSettings', () => {
  it('names every unset setting, SMTP included', () => {
    const none: SignoffConfig = {
      to: null,
      startDate: null,
      classes: [],
      eligibleGroup: 'SDC Clients',
      formHost: null,
      formId: null,
    };
    expect(missingSignoffSettings({ signoff: none, smtp: { host: null } as never })).toEqual([
      'SIGNOFF_TO',
      'SIGNOFF_START_DATE',
      'JOTFORM_FORM_HOST',
      'JOTFORM_FORM_ID',
      'SIGNOFF_CLASSES',
      'SMTP_HOST',
    ]);
    expect(
      missingSignoffSettings({ signoff: SIGNOFF, smtp: { host: 'smtp.test' } as never }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The database side, against a fake that answers by table and filter.
// ---------------------------------------------------------------------------

interface World {
  signoff: Array<{ k_visit: string; status: string }>;
  attendance: Array<{
    k_visit: string;
    uid: string;
    k_period: string;
    dt_start_utc: string;
    id_visit: string;
  }>;
  session: Array<{
    k_period: string;
    dt_start_utc: string;
    text_title: string;
    dtl_start_local: string;
  }>;
  staff: Array<{ k_staff: string; uid: string | null; is_substitute: boolean }>;
  person: Record<string, { first_name: string; last_name: string; k_staff?: string }>;
  groups: Array<{ k_member_group: string; title: string }>;
  members: Array<{ k_member_group: string; uid: string }>;
}

function world(over: Partial<World> = {}): World {
  return {
    signoff: [],
    attendance: [
      {
        k_visit: 'v1',
        uid: 'stu',
        k_period: 'p1',
        dt_start_utc: '2026-11-24T22:30:00+00:00',
        id_visit: '3',
      },
    ],
    session: [
      {
        k_period: 'p1',
        dt_start_utc: '2026-11-24T22:30:00+00:00',
        text_title: 'Music For Everyone | Live Performance Instruction | 60 Minutes',
        dtl_start_local: '2026-11-24T17:30:00',
      },
    ],
    staff: [{ k_staff: 'ks1', uid: 'tch', is_substitute: false }],
    person: {
      stu: { first_name: 'Test', last_name: 'Student' },
      tch: { first_name: 'Test', last_name: 'Teacher', k_staff: 'ks1' },
    },
    groups: [
      { k_member_group: 'g-sdc', title: 'SDC Clients' },
      { k_member_group: 'g-fi', title: 'ISS' },
    ],
    members: [
      { k_member_group: 'g-sdc', uid: 'stu' },
      { k_member_group: 'g-fi', uid: 'stu' },
    ],
    ...over,
  };
}

const eq = (q: string, col: string): string | undefined =>
  new RegExp(`(?:^|&)${col}=eq\\.([^&]*)`).exec(q)?.[1];

/** The UUID Postgres would generate for the sign-off row (gen_random_uuid()). */
const SIGNOFF_ID = '9d2b7c41-5e3a-4f60-8b1d-2c3e4f5a6b7c';

function fakeDb(w: World, opts: { returnId?: boolean } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ patch: Record<string, unknown>; query: string }> = [];
  const read = (table: string, q: string): unknown[] => {
    switch (table) {
      case 'lesson_signoff': {
        const k = eq(q, 'k_visit');
        if (k !== undefined) return w.signoff.filter((s) => s.k_visit === k);
        return w.signoff.filter((s) => s.status === 'sent' || s.status === 'signed');
      }
      case 'attendance': {
        const k = eq(q, 'k_visit');
        return k === undefined
          ? w.attendance.filter((a) => a.id_visit === '3')
          : w.attendance.filter((a) => a.k_visit === k);
      }
      case 'session':
        return w.session;
      case 'session_staff':
        return w.staff;
      case 'person': {
        const ks = eq(q, 'k_staff');
        if (ks !== undefined) return Object.values(w.person).filter((x) => x.k_staff === ks);
        const p = w.person[eq(q, 'uid') ?? ''];
        return p === undefined ? [] : [p];
      }
      case 'member_group': {
        const title = eq(q, 'title');
        if (title !== undefined) {
          return w.groups.filter((g) => g.title === decodeURIComponent(title));
        }
        const keys = /k_member_group=in\.\(([^)]*)\)/.exec(q)?.[1]?.split(',') ?? [];
        return w.groups.filter((g) => keys.includes(g.k_member_group));
      }
      case 'member_group_member': {
        const uid = eq(q, 'uid');
        if (uid !== undefined) return w.members.filter((m) => m.uid === uid);
        const key = eq(q, 'k_member_group');
        return w.members.filter((m) => m.k_member_group === key);
      }
      default:
        return [];
    }
  };
  const db = {
    select: vi.fn((t: string, q: string) => Promise.resolve(read(t, q))),
    selectAll: vi.fn((t: string, q: string) => Promise.resolve(read(t, q))),
    upsert: vi.fn((_t: string, rows: Array<Record<string, unknown>>) => {
      upserts.push(...rows);
      // PostgREST returns the written row, including the database-made id.
      return Promise.resolve(
        opts.returnId === false ? rows : rows.map((r) => ({ id: SIGNOFF_ID, ...r })),
      );
    }),
    update: vi.fn((_t: string, patch: Record<string, unknown>, query: string) => {
      updates.push({ patch, query });
      return Promise.resolve([patch]);
    }),
  };
  return { db: db as unknown as SupabaseClient, upserts, updates };
}

function fakeSmtp(ok = true) {
  const sent: MailEnvelope[] = [];
  const smtp: SmtpClient = {
    send: (e) => {
      sent.push(e);
      return Promise.resolve(ok ? { ok: true } : { ok: false, detail: 'ECONNREFUSED' });
    },
  };
  return { smtp, sent };
}

const run = (db: SupabaseClient, smtp: SmtpClient, kVisit = 'v1') =>
  processLessonSignoff(db, smtp, SIGNOFF, K_BUSINESS, kVisit, '2026-11-25T10:00:00.000Z');

describe('processLessonSignoff', () => {
  it('snapshots the form fields, emails the admin once, and marks it sent', async () => {
    const { db, upserts, updates } = fakeDb(world());
    const { smtp, sent } = fakeSmtp();

    expect(await run(db, smtp)).toEqual({ kind: 'sent' });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      k_visit: 'v1',
      student_name: 'Test Student',
      teacher_name: 'Test Teacher',
      course_code: 'MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 60 MINUTES',
      fi_title: 'ISS',
      status: 'pending',
      skip_reason: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('admin@example.test');
    expect(sent[0]?.text).toContain('Date: Tuesday, November 24, 2026');
    expect(sent[0]?.text).toContain('Time: 5:30 PM');
    expect(sent[0]?.text).toContain('https://form.example.test/42?student=Test%20Student');
    expect(sent[0]?.text).toContain(`&fi=ISS&lessonId=${SIGNOFF_ID}`);
    // Only a still-pending row is flipped: never overwrite a later state.
    expect(updates).toEqual([
      {
        patch: { status: 'sent', sent_at: '2026-11-25T10:00:00.000Z' },
        query: 'k_visit=eq.v1&status=eq.pending',
      },
    ]);
  });

  it('sends nothing when the write does not hand back the sign-off id', async () => {
    const { db, updates } = fakeDb(world(), { returnId: false });
    const { smtp, sent } = fakeSmtp();
    const result = await run(db, smtp);
    expect(result.kind).toBe('send-failed');
    expect(sent).toEqual([]);
    expect(updates).toEqual([]);
  });

  // The guarantee the whole design rests on: the hourly rerun must not email
  // the admin the same lesson again.
  it('never sends again once sent or signed', async () => {
    for (const status of ['sent', 'signed']) {
      const { db, upserts } = fakeDb(world({ signoff: [{ k_visit: 'v1', status }] }));
      const { smtp, sent } = fakeSmtp();
      expect(await run(db, smtp)).toEqual({ kind: 'already-done' });
      expect(sent).toEqual([]);
      expect(upserts).toEqual([]);
    }
  });

  it('records a skip and sends nothing when the student has no FI group', async () => {
    const { db, upserts } = fakeDb(world({ members: [{ k_member_group: 'g-sdc', uid: 'stu' }] }));
    const { smtp, sent } = fakeSmtp();
    expect(await run(db, smtp)).toEqual({ kind: 'skipped', reason: 'no-fi' });
    expect(upserts[0]).toMatchObject({ status: 'skipped', skip_reason: 'no-fi' });
    expect(sent).toEqual([]);
  });

  it('records a skip when the student has two FI groups - never guesses', async () => {
    const w = world();
    w.groups.push({ k_member_group: 'g-sp', title: 'Self Pay' });
    w.members.push({ k_member_group: 'g-sp', uid: 'stu' });
    const { db } = fakeDb(w);
    const { smtp, sent } = fakeSmtp();
    expect(await run(db, smtp)).toEqual({ kind: 'skipped', reason: 'multiple-fi' });
    expect(sent).toEqual([]);
  });

  // Appointments - nearly every SDC lesson - carry k_staff and a NULL uid on
  // session_staff (measured 25 Nov 2026: 6 of 6). Reading uid alone skipped them all.
  it('finds the teacher by k_staff when the staff row has no uid', async () => {
    const { db, upserts } = fakeDb(
      world({ staff: [{ k_staff: 'ks1', uid: null, is_substitute: false }] }),
    );
    const { smtp, sent } = fakeSmtp();
    expect(await run(db, smtp)).toEqual({ kind: 'sent' });
    expect(upserts[0]).toMatchObject({ teacher_name: 'Test Teacher' });
    expect(sent[0]?.text).toContain('Teacher: Test Teacher');
  });

  it('skips missing-detail rather than send a form with a blank teacher', async () => {
    const { db } = fakeDb(world({ staff: [] }));
    const { smtp, sent } = fakeSmtp();
    expect(await run(db, smtp)).toEqual({ kind: 'skipped', reason: 'missing-detail' });
    expect(sent).toEqual([]);
  });

  it('leaves the row pending when the email fails, so the next run retries it', async () => {
    const { db, upserts, updates } = fakeDb(world());
    const { smtp } = fakeSmtp(false);
    expect(await run(db, smtp)).toEqual({ kind: 'send-failed', detail: 'ECONNREFUSED' });
    expect(upserts[0]).toMatchObject({ status: 'pending' });
    expect(updates).toEqual([]);
  });

  it('does nothing for a visit WL no longer reports as attended', async () => {
    const w = world();
    (w.attendance[0] as { id_visit: string }).id_visit = '6';
    const { db, upserts } = fakeDb(w);
    const { smtp, sent } = fakeSmtp();
    expect(await run(db, smtp)).toEqual({ kind: 'gone' });
    expect(upserts).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('lessonSignoffCandidates', () => {
  it('returns an attended SDC lesson in a sign-off class on or after the start date', async () => {
    const { db } = fakeDb(world());
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual(['v1']);
  });

  it('leaves out a lesson already sent', async () => {
    const { db } = fakeDb(world({ signoff: [{ k_visit: 'v1', status: 'sent' }] }));
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual([]);
  });

  // A skip may have been fixed in WL (FI tagged since), so it is offered again.
  it('offers a skipped lesson again', async () => {
    const { db } = fakeDb(world({ signoff: [{ k_visit: 'v1', status: 'skipped' }] }));
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual(['v1']);
  });

  it('leaves out a student outside the eligible group', async () => {
    const { db } = fakeDb(world({ members: [{ k_member_group: 'g-fi', uid: 'stu' }] }));
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual([]);
  });

  it('leaves out an excluded class', async () => {
    const w = world();
    (w.session[0] as { text_title: string }).text_title = 'Media For Everyone | 60 Minutes';
    const { db } = fakeDb(w);
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual([]);
  });

  // The start date is a LOCAL date: 23 Nov 9 pm local is before 24 Nov even
  // though it is already the 24th in UTC.
  it('leaves out a lesson before the start date, judged by its local date', async () => {
    const w = world();
    (w.session[0] as { dtl_start_local: string }).dtl_start_local = '2026-11-23T21:00:00';
    const { db } = fakeDb(w);
    expect(await lessonSignoffCandidates(db, K_BUSINESS, SIGNOFF)).toEqual([]);
  });
});

describe('sign-off settings from the environment', () => {
  // GitHub Actions passes an unset secret as "". That must read as "use the
  // default", never as "no classes" (sign-offs silently off) and never as a
  // validation error (the whole sync down).
  it('treats empty values as unset and falls back to the defaults', async () => {
    const { runtimeOptionsSchema } = await import('../src/config/schema.js');
    const parsed = runtimeOptionsSchema.parse({
      SIGNOFF_TO: '',
      SIGNOFF_START_DATE: '',
      SIGNOFF_CLASSES: '',
      SIGNOFF_GROUP: '',
      JOTFORM_FORM_HOST: '',
      JOTFORM_FORM_ID: '',
    });
    expect(parsed.SIGNOFF_CLASSES).toEqual(CLASSES);
    expect(parsed.SIGNOFF_GROUP).toBe('SDC Clients');
    expect(parsed.SIGNOFF_TO).toBeUndefined();
    expect(parsed.JOTFORM_FORM_ID).toBeUndefined();
  });

  it('splits a configured class list and rejects a malformed start date', async () => {
    const { runtimeOptionsSchema } = await import('../src/config/schema.js');
    expect(
      runtimeOptionsSchema.parse({ SIGNOFF_CLASSES: ' DJ For Everyone , ,Media For Everyone' })
        .SIGNOFF_CLASSES,
    ).toEqual(['DJ For Everyone', 'Media For Everyone']);
    expect(runtimeOptionsSchema.safeParse({ SIGNOFF_START_DATE: '24/11/2026' }).success).toBe(
      false,
    );
  });
});
