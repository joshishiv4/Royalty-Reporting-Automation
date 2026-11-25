import { describe, expect, it } from 'vitest';
import type { SignoffConfig } from '../src/config/schema.js';
import type { MailEnvelope, SmtpClient } from '../src/notify/smtp.js';
import {
  missingSignoffRemindSettings,
  processReminder,
  reminderSchedule,
  remindersDueNow,
  reportMonthsDue,
  sendDueMonthReports,
  wallClockMs,
} from '../src/sync/lesson-signoff-remind.js';
import { fakePostgrest, type Row } from './helpers/fake-postgrest.js';

const K_BUSINESS = '111111';
const TZ = 'America/New_York';
const SIGNOFF: SignoffConfig = {
  to: 'admin@example.test',
  startDate: '2026-11-24',
  classes: ['Music For Everyone'],
  eligibleGroup: 'SDC Clients',
  formHost: 'form.example.test',
  formId: '42',
  apiHost: 'api.example.test',
  apiKey: 'test-jotform-key',
  timeZone: TZ,
};
const ID = 'cccccccc-0000-4000-8000-000000000001';

/** Studio wall clock (encoded as UTC epoch), for readable expectations. */
const wall = (m: number, d: number, h: number, min = 0) => Date.UTC(2026, m - 1, d, h, min);

function sentLesson(over: Partial<Row> = {}): Row {
  return {
    id: ID,
    k_business: K_BUSINESS,
    k_visit: '700000001',
    status: 'sent',
    // 10:00 in New York (EST, UTC-5, in November).
    sent_at: '2026-11-01T15:00:00+00:00',
    reminder_count: 0,
    dtl_start_local: '2026-11-01T09:00:00',
    student_name: 'Test Student',
    teacher_name: 'Test Teacher',
    course_code: 'MUSIC FOR EVERYONE - 60 MINUTES',
    fi_title: 'ISS',
    skip_reason: null,
    ...over,
  };
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

describe('the studio wall clock', () => {
  it('converts an instant to New York time', () => {
    expect(wallClockMs(Date.parse('2026-11-24T22:30:00Z'), TZ)).toBe(wall(11, 24, 17, 30));
  });

  // 03:00 UTC on 1 Dec is still 30 Nov in the studio: month end is the studio's.
  it('keeps the studio month across the UTC midnight', () => {
    expect(wallClockMs(Date.parse('2026-12-01T03:00:00Z'), TZ)).toBe(wall(11, 30, 22));
  });
});

describe('reminderSchedule', () => {
  it('+3 days, +7 days, then 09:00 three days before month end', () => {
    expect(reminderSchedule(wall(11, 1, 10), 2026, 11)).toEqual([
      wall(11, 4, 10),
      wall(11, 8, 10),
      wall(11, 27, 9),
    ]);
  });

  // Emailed on the 25th: "3 days before month end" would fall the next morning
  // and "+3 days" a day after - two reminders inside two days. The close one goes.
  it('drops a step that would come within two days of the previous one', () => {
    expect(reminderSchedule(wall(11, 25, 10), 2026, 11)).toEqual([
      wall(11, 28, 10),
      wall(12, 2, 10),
    ]);
  });

  it('handles December into January', () => {
    expect(reminderSchedule(wall(12, 1, 10), 2026, 12)).toEqual([
      wall(12, 4, 10),
      wall(12, 8, 10),
      wall(12, 28, 9),
    ]);
  });
});

describe('remindersDueNow', () => {
  it('returns only lessons with a step due and not yet sent', async () => {
    const f = fakePostgrest({
      lesson_signoff: [
        sentLesson(),
        sentLesson({ id: 'due-but-sent', reminder_count: 1 }),
        sentLesson({ id: 'signed', status: 'signed' }),
        sentLesson({ id: 'too-new', sent_at: '2026-11-03T15:00:00+00:00' }),
      ],
    });
    // 4 Nov, 11:00 New York: the +3 day step of a 1 Nov email is due.
    const ids = await remindersDueNow(f.db, K_BUSINESS, TZ, Date.parse('2026-11-04T16:00:00Z'));
    expect(ids).toEqual([ID]);
  });
});

describe('processReminder', () => {
  const at = (iso: string) => Date.parse(iso);

  it('re-sends the SAME link (same lessonId) and counts the step', async () => {
    const f = fakePostgrest({ lesson_signoff: [sentLesson()], jotform_submission: [] });
    const { smtp, sent } = fakeSmtp();

    const r = await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-04T16:00:00Z'));

    expect(r).toEqual({ kind: 'sent', step: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('admin@example.test');
    expect(sent[0]?.subject).toMatch(/^Reminder 1 of 3: Lesson sign-off: Test Student/);
    expect(sent[0]?.text).toContain(`&lessonId=${ID}`);
    const update = f.writes.find((w) => w.op === 'update');
    expect(update?.query).toBe(`id=eq.${ID}&status=eq.sent&reminder_count=eq.0`);
    expect(update?.rows[0]).toMatchObject({ reminder_count: 1 });
  });

  // The sync was down for a week: one reminder, not a burst of three.
  it('sends overdue steps as ONE reminder and counts them all', async () => {
    const f = fakePostgrest({ lesson_signoff: [sentLesson()], jotform_submission: [] });
    const { smtp, sent } = fakeSmtp();
    const r = await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-09T16:00:00Z'));
    expect(r).toEqual({ kind: 'sent', step: 2 });
    expect(sent).toHaveLength(1);
    expect(f.tables.lesson_signoff?.[0]).toMatchObject({ reminder_count: 2 });
  });

  it('sends nothing for a step already sent', async () => {
    const f = fakePostgrest({
      lesson_signoff: [sentLesson({ reminder_count: 1 })],
      jotform_submission: [],
    });
    const { smtp, sent } = fakeSmtp();
    expect(await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-04T16:00:00Z'))).toEqual({
      kind: 'not-needed',
    });
    expect(sent).toEqual([]);
  });

  it('stops once signed', async () => {
    const f = fakePostgrest({
      lesson_signoff: [sentLesson({ status: 'signed' })],
      jotform_submission: [],
    });
    const { smtp, sent } = fakeSmtp();
    expect((await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-09T16:00:00Z'))).kind).toBe(
      'not-needed',
    );
    expect(sent).toEqual([]);
  });

  // The check and the reminder run in the same hourly wave. A submission naming
  // this lesson that is not checked yet may be the signature: do not remind.
  it('waits while a submission for this lesson is unchecked', async () => {
    const f = fakePostgrest({
      lesson_signoff: [sentLesson()],
      jotform_submission: [{ submission_id: '9001', lesson_id_received: ID, outcome: null }],
    });
    const { smtp, sent } = fakeSmtp();
    expect((await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-04T16:00:00Z'))).kind).toBe(
      'wait-for-check',
    );
    expect(sent).toEqual([]);
  });

  it('a failed send records nothing, so it is retried', async () => {
    const f = fakePostgrest({ lesson_signoff: [sentLesson()], jotform_submission: [] });
    const { smtp } = fakeSmtp(false);
    expect((await processReminder(f.db, smtp, SIGNOFF, ID, at('2026-11-04T16:00:00Z'))).kind).toBe(
      'send-failed',
    );
    expect(f.writes.filter((w) => w.op === 'update')).toEqual([]);
  });
});

describe('reportMonthsDue', () => {
  it('nothing before 09:00 on the day before month end', () => {
    expect(reportMonthsDue(wall(11, 29, 8, 59), '2026-11-24')).toEqual([]);
  });
  it('the current month from 09:00 the day before its last day', () => {
    expect(reportMonthsDue(wall(11, 29, 9), '2026-11-24')).toEqual(['2026-11-01']);
  });
  it('the previous month stays due, so a missed list still goes out', () => {
    expect(reportMonthsDue(wall(12, 3, 10), '2026-11-24')).toEqual(['2026-11-01']);
    expect(reportMonthsDue(Date.UTC(2027, 0, 5, 10), '2026-11-24')).toEqual(['2026-12-01']);
  });
  it('never a month before the start date', () => {
    expect(reportMonthsDue(wall(11, 5, 10), '2026-11-24')).toEqual([]);
  });
});

describe('sendDueMonthReports', () => {
  // 29 Nov, 10:00 New York: November's list is due.
  const NOW = Date.parse('2026-11-29T15:00:00Z');
  const lessons = () => [
    sentLesson({ dtl_start_local: '2026-11-24T17:30:00' }),
    sentLesson({ id: 'signed-one', status: 'signed', dtl_start_local: '2026-11-25T17:30:00' }),
    sentLesson({
      id: 'skipped-one',
      status: 'skipped',
      skip_reason: 'no-fi',
      fi_title: null,
      dtl_start_local: '2026-11-26T17:30:00',
    }),
    sentLesson({ id: 'december', dtl_start_local: '2026-12-02T10:00:00' }),
  ];

  it('sends the month list once: unsigned with links, skipped with reasons', async () => {
    const f = fakePostgrest({
      lesson_signoff: lessons(),
      jotform_submission: [],
      lesson_signoff_report: [],
    });
    const { smtp, sent } = fakeSmtp();

    expect(await sendDueMonthReports(f.db, smtp, SIGNOFF, K_BUSINESS, NOW)).toEqual({
      sent: ['2026-11-01'],
      failed: [],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Unsigned lessons - November 2026: 1 unsigned, 1 not sent');
    expect(sent[0]?.text).toContain('Tuesday, November 24, 2026, 5:30 PM - Test Student');
    expect(sent[0]?.text).toContain(`&lessonId=${ID}`);
    expect(sent[0]?.text).toContain('no FI group in WellnessLiving');
    expect(sent[0]?.text).not.toContain('December');
    expect(f.tables.lesson_signoff_report?.[0]).toMatchObject({
      month: '2026-11-01',
      unsigned_count: 1,
      skipped_count: 1,
    });

    // Next hour: already recorded, nothing sent.
    await sendDueMonthReports(f.db, smtp, SIGNOFF, K_BUSINESS, NOW + 3_600_000);
    expect(sent).toHaveLength(1);
  });

  it('a failed send is not recorded, so next hour tries again', async () => {
    const f = fakePostgrest({
      lesson_signoff: lessons(),
      jotform_submission: [],
      lesson_signoff_report: [],
    });
    const { smtp } = fakeSmtp(false);
    expect(await sendDueMonthReports(f.db, smtp, SIGNOFF, K_BUSINESS, NOW)).toEqual({
      sent: [],
      failed: ['2026-11-01'],
    });
    expect(f.tables.lesson_signoff_report).toEqual([]);
  });
});

describe('missingSignoffRemindSettings', () => {
  // Reminding without detection would remind for lessons already signed.
  it('needs the Jotform API settings as well as phase 1 ones', () => {
    expect(
      missingSignoffRemindSettings({
        signoff: { ...SIGNOFF, apiKey: null },
        smtp: { host: 'smtp.example.test' } as never,
      }),
    ).toEqual(['JOTFORM_API_KEY']);
  });
});
