import { describe, expect, it, vi } from 'vitest';
import type { SmtpConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { notifyDeadLetter } from '../src/notify/index.js';

/**
 * Which reads are time-bounded, and which are deliberately not.
 *
 * This distinction was got wrong in production and is easy to get wrong again,
 * because "scope everything the same way" looks like the tidy answer. It is not:
 *
 *   CONDITIONS - the parked backlog, jobs overdue, records waiting on a human -
 *   are still true the next time anybody looks, so the standing sweep reads them
 *   unbounded on purpose. Bounding them would mean a backlog that stopped
 *   growing silently stops being reported while it is still sitting there.
 *
 *   EVENTS - a crashed pass - happened once and stay in sync_run for ever.
 *   Reading them unbounded re-reports the same crash on every sweep. The first
 *   live sweep mailed 45 crashes from a loop that had already been stopped, and
 *   would have re-mailed those same 45 every six hours indefinitely.
 *
 * So `crashedSince` bounds the crash read alone, and falls back to `since` for
 * the caller that scopes everything together.
 */

// host: null is the whole point - SMTP off, so the digest builds and reports
// its verdict without anything being sent. These tests are about which reads
// happen, not about mail.
const SMTP_OFF: SmtpConfig = {
  host: null,
  port: 587,
  user: '',
  password: '',
  from: '',
  to: 'nobody@example.test',
};

/** Records the PostgREST query string each table was read with. */
function spyDb() {
  const queries: Record<string, string[]> = {};
  const db = {
    select: vi.fn((table: string, query: string) => {
      (queries[table] ??= []).push(query);
      return Promise.resolve([]);
    }),
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const CRASHED_SINCE = '2026-09-02T00:00:00.000Z';
const SINCE = '2026-09-01T00:00:00.000Z';

describe('what the digest bounds by time', () => {
  it('bounds the crashed-pass read by crashedSince', async () => {
    const { db, queries } = spyDb();
    await notifyDeadLetter(db, SMTP_OFF, { kBusiness: '1', crashedSince: CRASHED_SINCE });
    expect(queries['sync_run']?.[0]).toContain(`started_at=gte.${CRASHED_SINCE}`);
  });

  it('leaves the parked backlog UNBOUNDED when only crashedSince is given', async () => {
    // The whole point of the sweep: a queue item parked last week is still
    // parked today, and bounding this read would hide it.
    const { db, queries } = spyDb();
    await notifyDeadLetter(db, SMTP_OFF, { kBusiness: '1', crashedSince: CRASHED_SINCE });
    expect(queries['sync_queue']?.[0]).not.toContain('updated_at=gte.');
  });

  it('falls back to since when crashedSince is absent, so the sync call is unchanged', async () => {
    const { db, queries } = spyDb();
    await notifyDeadLetter(db, SMTP_OFF, { kBusiness: '1', since: SINCE });
    expect(queries['sync_run']?.[0]).toContain(`started_at=gte.${SINCE}`);
    expect(queries['sync_queue']?.[0]).toContain(`updated_at=gte.${SINCE}`);
  });

  it('prefers crashedSince over since when both are given', async () => {
    const { db, queries } = spyDb();
    await notifyDeadLetter(db, SMTP_OFF, {
      kBusiness: '1',
      since: SINCE,
      crashedSince: CRASHED_SINCE,
    });
    expect(queries['sync_run']?.[0]).toContain(`started_at=gte.${CRASHED_SINCE}`);
    expect(queries['sync_run']?.[0]).not.toContain(SINCE);
    // Dead items still follow `since` - only the crash read is special.
    expect(queries['sync_queue']?.[0]).toContain(`updated_at=gte.${SINCE}`);
  });

  it('bounds nothing at all when neither is given', async () => {
    const { db, queries } = spyDb();
    await notifyDeadLetter(db, SMTP_OFF, { kBusiness: '1' });
    expect(queries['sync_run']?.[0]).not.toContain('started_at=gte.');
    expect(queries['sync_queue']?.[0]).not.toContain('updated_at=gte.');
  });
});
