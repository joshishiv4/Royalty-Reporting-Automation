import type { AppConfig, SignoffConfig, SignoffDriveConfig } from '../config/schema.js';
import {
  driveQueryString as q,
  FOLDER_MIME,
  type DriveClient,
  type DriveFile,
} from '../google/drive.js';
import type { SmtpClient } from '../notify/smtp.js';
import type { SupabaseClient } from '../supabase/client.js';
import { formatLessonDate, formatLessonTime, missingSignoffSettings } from './lesson-signoff.js';

/**
 * Lesson sign-off, phase 3: file each signed lesson's PDF where the studio keeps it.
 *
 *   <root> / NOVEMBER 2026 / NOVEMBER 2026 - UNMERGED / ISS - NOVEMBER 2026 /
 *            Test-Student-11-24-2026-0530PM.pdf
 *
 * JOTFORM MAKES THE PDF, THIS ONLY FILES IT. Jotform's Google Drive integration
 * drops one PDF per submission into a single flat folder (GOOGLE_DRIVE_INBOX_FOLDER_ID),
 * named "<submission id>.pdf". Jotform cannot build the folder tree itself and files
 * every submission, tests included (checked with the user, 25 Nov 2026 - see 0072).
 *
 * ONLY WHAT PHASE 2 SIGNED. A lesson is filed once lesson_signoff.status is
 * 'signed', which phase 2 sets only when the submission's visible fields match
 * what was sent. A test, an edited link or a duplicate never signs a lesson, so
 * its PDF stays in the drop folder for the admin to look at.
 *
 * THE MONTH IS THE LESSON'S, in studio time (dtl_start_local) - a lesson on 30
 * November signed on 2 December is a November sign-off.
 *
 * ONE DRIVE CALL MOVES, RENAMES AND TAGS. The tag (appProperties lessonSignoffId)
 * is how a run that died after the move but before writing the row is finished:
 * the next run's lookup finds the tagged file and only records it.
 *
 * FOLDERS ARE FOUND BEFORE THEY ARE MADE, and each one is resolved once per run,
 * even with items running concurrently - two lessons of a new FI must not create
 * two "ISS - NOVEMBER 2026" folders. If duplicates exist anyway (made by hand),
 * the oldest wins, every time.
 */

/** A signed lesson whose PDF has not arrived this long after signing is reported. */
export const PDF_MISSING_AFTER_MS = 24 * 60 * 60 * 1000;

/** The appProperties key that ties a filed PDF to its lesson. */
export const LESSON_TAG = 'lessonSignoffId';

/** Phase 1's settings, plus the Google ones. */
export function missingSignoffFileSettings(config: Pick<AppConfig, 'signoff' | 'smtp'>): string[] {
  const d = config.signoff.drive;
  const missing = missingSignoffSettings(config);
  if (d.oauthHost === null) missing.push('GOOGLE_OAUTH_HOST');
  if (d.apiHost === null) missing.push('GOOGLE_DRIVE_API_HOST');
  if (d.clientId === null) missing.push('GOOGLE_CLIENT_ID');
  if (d.clientSecret === null) missing.push('GOOGLE_CLIENT_SECRET');
  if (d.refreshToken === null) missing.push('GOOGLE_REFRESH_TOKEN');
  if (d.inboxFolderId === null) missing.push('GOOGLE_DRIVE_INBOX_FOLDER_ID');
  if (d.rootFolderId === null) missing.push('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  return missing;
}

const MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
] as const;

interface Local {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function local(dtlLocal: string): Local | null {
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

const pad = (n: number): string => String(n).padStart(2, '0');

/** "NOVEMBER 2026" - the month of the LESSON, as the studio's folders spell it. */
export function monthFolderName(dtlLocal: string): string | null {
  const p = local(dtlLocal);
  if (p === null) return null;
  const name = MONTHS[p.month - 1];
  return name === undefined ? null : `${name} ${String(p.year)}`;
}

/**
 * The three folder names under the root, outermost first:
 * ["NOVEMBER 2026", "NOVEMBER 2026 - UNMERGED", "ISS - NOVEMBER 2026"].
 *
 * The FI is upper-cased, as the studio's merged files spell it ("… - SELF PAY")
 * and as its short FI names already are (ISS, AIM).
 */
export function folderPath(row: {
  readonly dtl_start_local: string;
  readonly fi_title: string | null;
}): string[] | null {
  const month = monthFolderName(row.dtl_start_local);
  const fi = row.fi_title?.trim() ?? '';
  if (month === null || fi === '') return null;
  return [month, `${month} - UNMERGED`, `${fi.toUpperCase()} - ${month}`];
}

/**
 * "Test-Student-11-24-2026-0530PM.pdf". The studio's own pattern is
 * First-Last-MM-DD-YYYY.pdf; the start time is added because two lessons on one
 * day produced identical names (three files called the same thing, seen Oct 2026).
 */
export function filedPdfName(row: {
  readonly dtl_start_local: string;
  readonly student_name: string | null;
}): string | null {
  const p = local(row.dtl_start_local);
  const student = (row.student_name ?? '').trim().replace(/[/\\]/g, '').replace(/\s+/g, '-');
  if (p === null || student === '') return null;
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return (
    `${student}-${pad(p.month)}-${pad(p.day)}-${String(p.year)}` +
    `-${pad(hour12)}${pad(p.minute)}${ampm}.pdf`
  );
}

/** The name Jotform's Drive integration gives a submission's PDF. */
export function inboxPdfName(submissionId: string): string {
  return `${submissionId}.pdf`;
}

type Drive = Pick<DriveClient, 'listFiles' | 'createFolder' | 'moveFile'>;

/**
 * Finds-or-creates folders, each (parent, name) once per instance - the promise
 * is shared, so concurrent lessons wait on one lookup instead of racing to create.
 * A failed lookup is forgotten, so the next item tries again.
 */
export class FolderResolver {
  private readonly known = new Map<string, Promise<string>>();

  constructor(private readonly drive: Drive) {}

  async resolve(rootId: string, path: readonly string[]): Promise<string> {
    let parent = rootId;
    for (const name of path) parent = await this.child(parent, name);
    return parent;
  }

  private child(parentId: string, name: string): Promise<string> {
    const key = `${parentId}\u0000${name}`;
    let pending = this.known.get(key);
    if (pending === undefined) {
      pending = this.findOrCreate(parentId, name);
      this.known.set(key, pending);
      pending.catch(() => this.known.delete(key));
    }
    return pending;
  }

  private async findOrCreate(parentId: string, name: string): Promise<string> {
    const found = await this.drive.listFiles(
      `${q(parentId)} in parents and name = ${q(name)} and mimeType = ${q(FOLDER_MIME)} and trashed = false`,
    );
    // Oldest first (the client orders by createdTime): a duplicate made by hand never wins.
    const first = found[0];
    if (first !== undefined) return first.id;
    return (await this.drive.createFolder(name, parentId)).id;
  }
}

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

/** Signed lessons not yet filed - the queue seed. */
export async function unfiledSignedLessons(
  db: SupabaseClient,
  kBusiness: string,
): Promise<string[]> {
  const rows = await db.selectAll<{ id: string }>(
    'lesson_signoff',
    `k_business=eq.${kBusiness}&status=eq.signed&filed_at=is.null` +
      `&jotform_submission_id=not.is.null&select=id&order=id.asc`,
  );
  return rows.map((r) => r.id);
}

interface FilingRow {
  readonly id: string;
  readonly status: string;
  readonly student_name: string | null;
  readonly fi_title: string | null;
  readonly dtl_start_local: string;
  readonly jotform_submission_id: string | null;
  readonly filed_at: string | null;
}

const FILING_COLUMNS =
  'id,status,student_name,fi_title,dtl_start_local,jotform_submission_id,filed_at';

export type FilingResult =
  | { readonly kind: 'filed'; readonly name: string }
  | { readonly kind: 'recovered' }
  | { readonly kind: 'waiting-for-pdf' }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'missing-detail' };

/**
 * Files one signed lesson's PDF. Looks for the file it may already have moved
 * (by tag) and for Jotform's PDF in the drop folder, in ONE listing.
 */
export async function processFiling(
  db: SupabaseClient,
  drive: Drive,
  folders: FolderResolver,
  settings: Pick<SignoffDriveConfig, 'inboxFolderId' | 'rootFolderId'>,
  lessonId: string,
  nowIso: string,
): Promise<FilingResult> {
  const rows = await db.select<FilingRow>(
    'lesson_signoff',
    `id=eq.${lessonId}&select=${FILING_COLUMNS}&limit=1`,
  );
  const row = rows[0];
  const inbox = settings.inboxFolderId;
  const root = settings.rootFolderId;
  if (
    row === undefined ||
    row.status !== 'signed' ||
    row.filed_at !== null ||
    row.jotform_submission_id === null ||
    inbox === null ||
    root === null
  ) {
    return { kind: 'not-needed' };
  }
  const name = filedPdfName(row);
  const path = folderPath(row);
  if (name === null || path === null) return { kind: 'missing-detail' };

  const submissionId = row.jotform_submission_id;
  const files = await drive.listFiles(
    `trashed = false and ((${q(inbox)} in parents and name = ${q(inboxPdfName(submissionId))})` +
      ` or appProperties has { key=${q(LESSON_TAG)} and value=${q(row.id)} })`,
  );

  // Moved by an earlier run that died before recording it: record, move nothing.
  const tagged = files.find((f) => f.appProperties?.[LESSON_TAG] === row.id);
  if (tagged !== undefined) {
    await record(db, row.id, tagged, tagged.parents?.[0] ?? null, nowIso);
    return { kind: 'recovered' };
  }

  // Newest, if Jotform uploaded twice (an edited submission): it is the latest
  // version. Any older copy stays in the drop folder.
  const inInbox = files.filter((f) => f.name === inboxPdfName(submissionId));
  const pdf = inInbox[inInbox.length - 1];
  if (pdf === undefined) return { kind: 'waiting-for-pdf' };

  const folderId = await folders.resolve(root, path);
  const moved = await drive.moveFile(pdf.id, {
    fromParent: inbox,
    toParent: folderId,
    name,
    appProperties: { [LESSON_TAG]: row.id, jotformSubmissionId: submissionId },
  });
  await record(db, row.id, moved, folderId, nowIso);
  return { kind: 'filed', name };
}

async function record(
  db: SupabaseClient,
  lessonId: string,
  file: DriveFile,
  folderId: string | null,
  nowIso: string,
): Promise<void> {
  await db.update(
    'lesson_signoff',
    {
      drive_file_id: file.id,
      drive_folder_id: folderId,
      drive_file_name: file.name,
      filed_at: nowIso,
    },
    `id=eq.${lessonId}&filed_at=is.null`,
  );
}

// ---------------------------------------------------------------------------
// The missing-PDF alert
// ---------------------------------------------------------------------------

interface MissingRow {
  readonly id: string;
  readonly student_name: string | null;
  readonly fi_title: string | null;
  readonly dtl_start_local: string;
  readonly jotform_submission_id: string | null;
}

/** The alert email for signed lessons whose PDF never reached Drive. Pure. */
export function missingPdfEmail(rows: readonly MissingRow[]): { subject: string; text: string } {
  const lines = [
    `${String(rows.length)} signed lesson(s) have no PDF in the Google Drive drop folder ` +
      '24 hours after signing.',
    '',
    "Check that the Jotform form's Google Drive integration is still on and still sends",
    'to the drop folder. These lessons are filed automatically as soon as their PDF',
    'arrives; nothing else needs doing once the integration works.',
    '',
  ];
  for (const r of rows) {
    lines.push(
      `- ${formatLessonDate(r.dtl_start_local) ?? r.dtl_start_local}, ` +
        `${formatLessonTime(r.dtl_start_local) ?? ''} - ${r.student_name ?? '?'} - ` +
        `${r.fi_title ?? '?'} - Jotform submission ${r.jotform_submission_id ?? '?'}`,
    );
  }
  lines.push('', 'Sent automatically by the lesson sign-off sync. Each lesson is reported once.');
  return {
    subject: `Signed lessons with no PDF in Drive: ${String(rows.length)}`,
    text: lines.join('\n'),
  };
}

/**
 * Emails the admin, once per lesson, about signed lessons still unfiled 24 hours
 * after signing. Recorded only after the email went out, so a failed send is
 * retried next hour. Returns how many lessons were reported; throws on a failed send.
 */
export async function reportMissingPdfs(
  db: SupabaseClient,
  smtp: SmtpClient,
  signoff: Pick<SignoffConfig, 'to'>,
  kBusiness: string,
  nowMs: number,
): Promise<number> {
  const cutoff = new Date(nowMs - PDF_MISSING_AFTER_MS).toISOString();
  const rows = await db.selectAll<MissingRow>(
    'lesson_signoff',
    `k_business=eq.${kBusiness}&status=eq.signed&filed_at=is.null` +
      `&pdf_missing_reported_at=is.null&signed_at=lt.${cutoff}` +
      `&select=id,student_name,fi_title,dtl_start_local,jotform_submission_id` +
      `&order=dtl_start_local.asc,id.asc`,
  );
  if (rows.length === 0) return 0;
  const mail = missingPdfEmail(rows);
  const result = await smtp.send({ to: signoff.to ?? '', subject: mail.subject, text: mail.text });
  if (!result.ok) {
    throw new Error(`missing-PDF alert not sent: ${result.detail ?? 'unknown error'}`);
  }
  await db.update(
    'lesson_signoff',
    { pdf_missing_reported_at: new Date(nowMs).toISOString() },
    `id=in.(${rows.map((r) => r.id).join(',')})&pdf_missing_reported_at=is.null`,
  );
  return rows.length;
}
