import { describe, expect, it } from 'vitest';
import type { DriveFile } from '../src/google/drive.js';
import { FOLDER_MIME } from '../src/google/drive.js';
import type { SmtpClient } from '../src/notify/smtp.js';
import {
  filedPdfName,
  FolderResolver,
  folderPath,
  LESSON_TAG,
  missingSignoffFileSettings,
  monthFolderName,
  processFiling,
  reportMissingPdfs,
  unfiledSignedLessons,
} from '../src/sync/lesson-signoff-file.js';
import { fakePostgrest, type Row } from './helpers/fake-postgrest.js';

const K_BUSINESS = '111111';
const NOW = '2026-11-26T15:00:00.000Z';
const INBOX = 'inbox-folder';
const ROOT = 'root-folder';
const SETTINGS = { inboxFolderId: INBOX, rootFolderId: ROOT };

// Two lessons on one day, same student, teacher, class and FI (the 30 Oct case).
const EARLY = 'aaaaaaaa-0000-4000-8000-000000000530';
const LATE = 'bbbbbbbb-0000-4000-8000-000000000730';

function lesson(id: string, time: string, over: Partial<Row> = {}): Row {
  return {
    id,
    k_business: K_BUSINESS,
    status: 'signed',
    student_name: 'Test Student',
    fi_title: 'ISS',
    dtl_start_local: `2026-10-30T${time}:00`,
    jotform_submission_id: id === EARLY ? '9001' : '9002',
    signed_at: '2026-11-26T14:00:00.000Z',
    filed_at: null,
    drive_file_id: null,
    pdf_missing_reported_at: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// An in-memory Drive that understands the two query shapes the module sends.
// ---------------------------------------------------------------------------

interface FakeFile {
  id: string;
  name: string;
  mimeType?: string;
  parents: string[];
  appProperties?: Record<string, string>;
}

const unq = (s: string): string => s.replace(/\\(.)/g, '$1');

function fakeDrive(initial: FakeFile[]) {
  const files: FakeFile[] = initial.map((f) => ({ ...f, parents: [...f.parents] }));
  const calls = { list: 0, create: [] as string[], move: [] as string[] };
  let next = 1;
  const drive = {
    files,
    calls,
    listFiles(query: string): Promise<DriveFile[]> {
      calls.list += 1;
      const strings = [...query.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => unq(m[1] ?? ''));
      if (query.includes('mimeType')) {
        const [parent, name] = strings;
        return Promise.resolve(
          files.filter(
            (f) =>
              f.mimeType === FOLDER_MIME && f.parents.includes(parent ?? '') && f.name === name,
          ),
        );
      }
      const [inbox, name, , tagValue] = strings;
      return Promise.resolve(
        files.filter(
          (f) =>
            (f.parents.includes(inbox ?? '') && f.name === name) ||
            f.appProperties?.[LESSON_TAG] === tagValue,
        ),
      );
    },
    async createFolder(name: string, parentId: string): Promise<DriveFile> {
      calls.create.push(name);
      await Promise.resolve(); // let a concurrent caller interleave, as a real request would
      const f: FakeFile = {
        id: `folder-${String(next++)}`,
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      };
      files.push(f);
      return f;
    },
    moveFile(
      fileId: string,
      m: {
        fromParent: string;
        toParent: string;
        name: string;
        appProperties: Record<string, string>;
      },
    ): Promise<DriveFile> {
      calls.move.push(fileId);
      const f = files.find((x) => x.id === fileId);
      if (f === undefined) return Promise.reject(new Error('no such file'));
      f.parents = f.parents.filter((p) => p !== m.fromParent).concat(m.toParent);
      f.name = m.name;
      f.appProperties = { ...f.appProperties, ...m.appProperties };
      return Promise.resolve({ ...f });
    },
  };
  return drive;
}

const pdfInInbox = (id: string, submissionId: string): FakeFile => ({
  id,
  name: `${submissionId}.pdf`,
  parents: [INBOX],
});

/** The folder path a file now sits in, as names from the root down. */
function pathOf(drive: ReturnType<typeof fakeDrive>, fileId: string): string[] {
  const names: string[] = [];
  let at = drive.files.find((f) => f.id === fileId)?.parents[0];
  while (at !== undefined && at !== ROOT) {
    const folder = drive.files.find((f) => f.id === at);
    if (folder === undefined) break;
    names.unshift(folder.name);
    at = folder.parents[0];
  }
  return names;
}

// ---------------------------------------------------------------------------

describe('names, as the studio spells them', () => {
  it('folder path: month, month - UNMERGED, FI - month (FI upper-cased)', () => {
    expect(folderPath({ dtl_start_local: '2026-11-24T17:30:00', fi_title: 'Self Pay' })).toEqual([
      'NOVEMBER 2026',
      'NOVEMBER 2026 - UNMERGED',
      'SELF PAY - NOVEMBER 2026',
    ]);
    expect(folderPath({ dtl_start_local: '2026-11-24T17:30:00', fi_title: null })).toBeNull();
  });

  // Signed in December, it is still a November sign-off.
  it('the month is the LESSON month', () => {
    expect(monthFolderName('2026-11-30 19:00:00')).toBe('NOVEMBER 2026');
    expect(monthFolderName('2027-01-01T09:00:00')).toBe('JANUARY 2027');
  });

  it('file name: First-Last-MM-DD-YYYY-HHMMAM.pdf, the time telling same-day lessons apart', () => {
    const early = filedPdfName({
      dtl_start_local: '2026-10-30T17:30:00',
      student_name: 'Test Student',
    });
    const late = filedPdfName({
      dtl_start_local: '2026-10-30T19:30:00',
      student_name: 'Test Student',
    });
    expect(early).toBe('Test-Student-10-30-2026-0530PM.pdf');
    expect(late).toBe('Test-Student-10-30-2026-0730PM.pdf');
    expect(early).not.toBe(late);
  });

  it('noon, midnight, morning, and a three-part name', () => {
    const name = (t: string, s = 'Mary Ann  Test') =>
      filedPdfName({ dtl_start_local: `2026-11-02T${t}:00`, student_name: s });
    expect(name('12:00')).toBe('Mary-Ann-Test-11-02-2026-1200PM.pdf');
    expect(name('00:15')).toBe('Mary-Ann-Test-11-02-2026-1215AM.pdf');
    expect(name('09:05')).toBe('Mary-Ann-Test-11-02-2026-0905AM.pdf');
    expect(name('09:05', '  ')).toBeNull();
  });
});

describe('FolderResolver', () => {
  it('uses folders that exist and creates only the missing ones', async () => {
    const drive = fakeDrive([
      { id: 'm', name: 'NOVEMBER 2026', mimeType: FOLDER_MIME, parents: [ROOT] },
    ]);
    const id = await new FolderResolver(drive).resolve(ROOT, [
      'NOVEMBER 2026',
      'NOVEMBER 2026 - UNMERGED',
      'ISS - NOVEMBER 2026',
    ]);
    expect(drive.calls.create).toEqual(['NOVEMBER 2026 - UNMERGED', 'ISS - NOVEMBER 2026']);
    expect(drive.files.find((f) => f.id === id)?.name).toBe('ISS - NOVEMBER 2026');
  });

  // Two lessons of a new FI filed at once must not make two "ISS - …" folders.
  it('concurrent lookups of the same path create each folder once', async () => {
    const drive = fakeDrive([]);
    const resolver = new FolderResolver(drive);
    const path = ['NOVEMBER 2026', 'NOVEMBER 2026 - UNMERGED', 'ISS - NOVEMBER 2026'];
    const [a, b] = await Promise.all([resolver.resolve(ROOT, path), resolver.resolve(ROOT, path)]);
    expect(a).toBe(b);
    expect(drive.calls.create).toHaveLength(3);
  });
});

describe('processFiling', () => {
  it('moves the PDF from the drop folder into month/FI, renamed and tagged, and records it', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30')] });
    const drive = fakeDrive([pdfInInbox('pdf-2', '9002')]);

    const result = await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW);

    expect(result).toEqual({ kind: 'filed', name: 'Test-Student-10-30-2026-0730PM.pdf' });
    expect(pathOf(drive, 'pdf-2')).toEqual([
      'OCTOBER 2026',
      'OCTOBER 2026 - UNMERGED',
      'ISS - OCTOBER 2026',
    ]);
    const file = drive.files.find((x) => x.id === 'pdf-2');
    expect(file?.parents).not.toContain(INBOX);
    expect(file?.appProperties?.[LESSON_TAG]).toBe(LATE);
    expect(f.tables.lesson_signoff?.[0]).toMatchObject({
      drive_file_id: 'pdf-2',
      drive_file_name: 'Test-Student-10-30-2026-0730PM.pdf',
      drive_folder_id: file?.parents[0],
      filed_at: NOW,
    });
  });

  // THE CASE THE HIDDEN FIELD EXISTS FOR: each PDF goes to its own lesson's name.
  it('two identical-looking lessons get their own PDFs and their own names', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(EARLY, '17:30'), lesson(LATE, '19:30')] });
    const drive = fakeDrive([pdfInInbox('pdf-1', '9001'), pdfInInbox('pdf-2', '9002')]);
    const folders = new FolderResolver(drive);
    await Promise.all([
      processFiling(f.db, drive, folders, SETTINGS, EARLY, NOW),
      processFiling(f.db, drive, folders, SETTINGS, LATE, NOW),
    ]);
    expect(drive.files.find((x) => x.id === 'pdf-1')?.name).toBe(
      'Test-Student-10-30-2026-0530PM.pdf',
    );
    expect(drive.files.find((x) => x.id === 'pdf-2')?.name).toBe(
      'Test-Student-10-30-2026-0730PM.pdf',
    );
    expect(drive.calls.create).toHaveLength(3); // one folder path, made once
  });

  it('a lesson that is not signed is never filed - its PDF stays in the drop folder', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30', { status: 'sent' })] });
    const drive = fakeDrive([pdfInInbox('pdf-2', '9002')]);
    expect(
      await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW),
    ).toEqual({ kind: 'not-needed' });
    expect(drive.calls.list).toBe(0);
    expect(drive.files[0]?.parents).toEqual([INBOX]);
  });

  it('waits when the PDF has not arrived; nothing is recorded', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30')] });
    const drive = fakeDrive([pdfInInbox('pdf-other', '7777')]);
    expect(
      await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW),
    ).toEqual({ kind: 'waiting-for-pdf' });
    expect(f.tables.lesson_signoff?.[0]?.filed_at).toBeNull();
    expect(drive.calls.create).toEqual([]);
  });

  // The crash between "moved" and "recorded": the next run records, moves nothing.
  it('a file already moved and tagged by a run that died is recorded, not moved again', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30')] });
    const drive = fakeDrive([
      {
        id: 'pdf-2',
        name: 'Test-Student-10-30-2026-0730PM.pdf',
        parents: ['iss-folder'],
        appProperties: { [LESSON_TAG]: LATE },
      },
    ]);
    expect(
      await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW),
    ).toEqual({ kind: 'recovered' });
    expect(drive.calls.move).toEqual([]);
    expect(f.tables.lesson_signoff?.[0]).toMatchObject({
      drive_file_id: 'pdf-2',
      drive_folder_id: 'iss-folder',
      filed_at: NOW,
    });
  });

  // An edited submission makes Jotform upload a second PDF with the same name.
  it('two PDFs for one submission: the newest is filed, the older stays put', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30')] });
    const drive = fakeDrive([pdfInInbox('pdf-old', '9002'), pdfInInbox('pdf-new', '9002')]);
    await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW);
    expect(drive.calls.move).toEqual(['pdf-new']);
    expect(drive.files.find((x) => x.id === 'pdf-old')?.parents).toEqual([INBOX]);
  });

  it('a lesson already filed is not looked up again', async () => {
    const f = fakePostgrest({ lesson_signoff: [lesson(LATE, '19:30', { filed_at: NOW })] });
    const drive = fakeDrive([pdfInInbox('pdf-2', '9002')]);
    await processFiling(f.db, drive, new FolderResolver(drive), SETTINGS, LATE, NOW);
    expect(drive.calls.list).toBe(0);
  });
});

describe('unfiledSignedLessons', () => {
  it('is signed, unfiled lessons only', async () => {
    const f = fakePostgrest({
      lesson_signoff: [
        lesson(EARLY, '17:30'),
        lesson(LATE, '19:30', { filed_at: NOW }),
        lesson('cccccccc-0000-4000-8000-000000000001', '09:00', { status: 'sent' }),
      ],
    });
    expect(await unfiledSignedLessons(f.db, K_BUSINESS)).toEqual([EARLY]);
  });
});

describe('reportMissingPdfs', () => {
  function smtp(ok = true) {
    const sent: Array<{ subject: string; text: string }> = [];
    const client: SmtpClient = {
      send: (m) => {
        sent.push({ subject: m.subject, text: m.text });
        return Promise.resolve(ok ? { ok: true } : { ok: false, detail: 'refused' });
      },
    };
    return { sent, client };
  }
  const nowMs = Date.parse(NOW);
  const hoursAgo = (h: number) => new Date(nowMs - h * 3_600_000).toISOString();

  it('reports signed lessons unfiled after 24 hours, once each', async () => {
    const f = fakePostgrest({
      lesson_signoff: [
        lesson(EARLY, '17:30', { signed_at: hoursAgo(25) }),
        lesson(LATE, '19:30', { signed_at: hoursAgo(23) }), // not yet overdue
      ],
    });
    const mail = smtp();

    expect(
      await reportMissingPdfs(f.db, mail.client, { to: 'admin@example.test' }, K_BUSINESS, nowMs),
    ).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toBe('Signed lessons with no PDF in Drive: 1');
    expect(mail.sent[0]?.text).toContain('Jotform submission 9001');
    expect(mail.sent[0]?.text).not.toContain('9002');

    // Next hour: already reported, nothing sent.
    expect(
      await reportMissingPdfs(f.db, mail.client, { to: 'admin@example.test' }, K_BUSINESS, nowMs),
    ).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it('a failed send throws and records nothing, so the next hour tries again', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(EARLY, '17:30', { signed_at: hoursAgo(30) })],
    });
    await expect(
      reportMissingPdfs(f.db, smtp(false).client, { to: 'a@example.test' }, K_BUSINESS, nowMs),
    ).rejects.toThrow('missing-PDF alert not sent: refused');
    expect(f.tables.lesson_signoff?.[0]?.pdf_missing_reported_at).toBeNull();
  });

  it('a filed lesson is never reported', async () => {
    const f = fakePostgrest({
      lesson_signoff: [lesson(EARLY, '17:30', { signed_at: hoursAgo(30), filed_at: NOW })],
    });
    const mail = smtp();
    expect(
      await reportMissingPdfs(f.db, mail.client, { to: 'a@example.test' }, K_BUSINESS, nowMs),
    ).toBe(0);
    expect(mail.sent).toEqual([]);
  });
});

describe('missingSignoffFileSettings', () => {
  it('names every unset Google setting after phase 1 ones', () => {
    const signoff = {
      to: 'a@example.test',
      startDate: '2026-11-24',
      formHost: 'form.example.test',
      formId: '42',
      classes: ['Music For Everyone'],
      drive: {
        oauthHost: null,
        apiHost: null,
        clientId: null,
        clientSecret: null,
        refreshToken: null,
        inboxFolderId: null,
        rootFolderId: null,
      },
    };
    expect(
      missingSignoffFileSettings({ signoff: signoff as never, smtp: { host: 'smtp' } as never }),
    ).toEqual([
      'GOOGLE_OAUTH_HOST',
      'GOOGLE_DRIVE_API_HOST',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
      'GOOGLE_DRIVE_INBOX_FOLDER_ID',
      'GOOGLE_DRIVE_ROOT_FOLDER_ID',
    ]);
  });
});
