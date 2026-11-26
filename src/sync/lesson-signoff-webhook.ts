import { randomUUID } from 'node:crypto';
import type { AppConfig, SignoffConfig, SignoffDriveConfig } from '../config/schema.js';
import { DriveClient } from '../google/drive.js';
import { JotformClient } from '../jotform/client.js';
import type { SupabaseClient } from '../supabase/client.js';
import { acquireJobLock, releaseJobLock } from './job-state.js';
import {
  missingSignoffCheckSettings,
  processSubmission,
  storeOneSubmission,
  type StoreOneResult,
  type SubmissionOutcome,
} from './lesson-signoff-check.js';
import {
  type FilingResult,
  FolderResolver,
  missingSignoffFileSettings,
  processFiling,
} from './lesson-signoff-file.js';

/**
 * Lesson sign-off, task 039: one Jotform submission, checked and filed the moment
 * Jotform's webhook announces it - instead of at the next hourly sync.
 *
 * NOTHING NEW IS DECIDED HERE. The submission is stored as the hourly check
 * stores it (storeOneSubmission), judged by the same processSubmission, and filed
 * by the same processFiling. This module only runs those three for one id, now.
 * Every rule - the hidden lessonId, the visible-field re-check, "only from
 * pending or sent", "only what phase 2 signed" - is the hourly path's own.
 *
 * THE ID IS ALL THAT IS TRUSTED FROM THE WEBHOOK. The submission itself is read
 * back from the Jotform API, so a forged POST can at most make this look again at
 * a real submission; it cannot sign anything.
 *
 * THE PDF IS USUALLY LATE. Jotform fires the webhook and its Google Drive upload
 * together, so the PDF is often not in the drop folder yet. This polls for it
 * within a budget (the route runs this AFTER answering Jotform, whose webhook
 * gives up after 5 s), and past the budget the hourly lesson_signoff_file pass
 * files it, exactly as it would have without the webhook.
 *
 * FILING TAKES THE lesson_signoff_file JOB LOCK, the same lease the hourly pass
 * takes. Without it, the hourly pass and a webhook - or two webhooks for the
 * first two lessons of a new FI - could each find "ISS - DECEMBER 2026" missing
 * and each create one, or both move the same PDF. FolderResolver only stops that
 * inside one process; the lock stops it across processes. It is held for one
 * filing attempt at a time, never across the wait for the PDF, so a webhook
 * waiting on Jotform never makes the hourly pass stand down.
 */

/** How long the webhook keeps trying to file, from its start. Vercel's cap is 60 s. */
export const WEBHOOK_BUDGET_MS = 45_000;
/** The wait between looks for the PDF (or for the lock). */
export const WEBHOOK_POLL_MS = 5_000;
/** The lease a webhook takes per filing attempt: one attempt is seconds. */
export const WEBHOOK_LOCK_MS = 60_000;

const FILE_JOB = 'lesson_signoff_file';

export interface FileLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** The lesson_signoff_file job lock, under a run id of this webhook's own. */
export function fileJobLock(db: SupabaseClient, kBusiness: string, now: () => number): FileLock {
  const runId = randomUUID();
  return {
    acquire: () =>
      acquireJobLock(
        db,
        FILE_JOB,
        kBusiness,
        runId,
        new Date(now()).toISOString(),
        WEBHOOK_LOCK_MS,
      ),
    release: () => releaseJobLock(db, FILE_JOB, kBusiness, runId),
  };
}

export interface WebhookDeps {
  readonly db: SupabaseClient;
  readonly jotform: Pick<JotformClient, 'getSubmission'>;
  readonly drive: Pick<DriveClient, 'listFiles' | 'createFolder' | 'moveFile'>;
  readonly signoff: Pick<SignoffConfig, 'formId'> & {
    readonly drive: Pick<SignoffDriveConfig, 'inboxFolderId' | 'rootFolderId'>;
  };
  readonly kBusiness: string;
  readonly lock: FileLock;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly budgetMs?: number;
  readonly pollMs?: number;
}

export type WebhookResult =
  /** Not stored: another form's submission, or one Jotform marks deleted. */
  | { readonly kind: 'ignored'; readonly reason: Exclude<StoreOneResult, 'stored' | 'known'> }
  /** Checked, and nothing to file: not signed, or already filed. */
  | { readonly kind: 'checked'; readonly outcome: SubmissionOutcome | 'already-checked' | 'gone' }
  /** A filing attempt ran to an end: filed, recovered, or nothing to do. */
  | { readonly kind: 'filing'; readonly filing: Exclude<FilingResult, { kind: 'waiting-for-pdf' }> }
  /** Signed, but the PDF or the lock did not come in time: the hourly pass files it. */
  | { readonly kind: 'left-for-hourly'; readonly reason: 'pdf-not-in-drive' | 'lock-busy' };

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * What the webhook needs set: detection's settings and filing's, each named once.
 * Filing's include phase 1's, as the hourly filing pass requires them too.
 */
export function missingWebhookSettings(config: Pick<AppConfig, 'signoff' | 'smtp'>): string[] {
  return [
    ...new Set([...missingSignoffCheckSettings(config), ...missingSignoffFileSettings(config)]),
  ];
}

/** The real clients and lock, built from config the way the hourly passes build theirs. */
export function webhookDepsFor(config: AppConfig, db: SupabaseClient): WebhookDeps {
  const s = config.signoff;
  const d = s.drive;
  const now = Date.now;
  return {
    db,
    jotform: new JotformClient(
      { apiHost: s.apiHost ?? '', apiKey: s.apiKey ?? '' },
      { timeoutMs: config.runtime.httpTimeoutMs },
    ),
    drive: new DriveClient(
      {
        oauthHost: d.oauthHost ?? '',
        apiHost: d.apiHost ?? '',
        clientId: d.clientId ?? '',
        clientSecret: d.clientSecret ?? '',
        refreshToken: d.refreshToken ?? '',
      },
      { timeoutMs: config.runtime.httpTimeoutMs },
    ),
    signoff: s,
    kBusiness: config.wl.kBusiness,
    lock: fileJobLock(db, config.wl.kBusiness, now),
    now,
  };
}

/**
 * Stores, checks and - if signed - files one submission. Throws only on an API
 * or database failure; the hourly passes then pick the submission up as usual.
 */
export async function processWebhookSubmission(
  deps: WebhookDeps,
  submissionId: string,
): Promise<WebhookResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const budgetMs = deps.budgetMs ?? WEBHOOK_BUDGET_MS;
  const pollMs = deps.pollMs ?? WEBHOOK_POLL_MS;
  const startedAt = now();
  const iso = (): string => new Date(now()).toISOString();
  const formId = deps.signoff.formId;
  if (formId === null) return { kind: 'ignored', reason: 'other-form' };

  const sub = await deps.jotform.getSubmission(submissionId);
  const stored = await storeOneSubmission(deps.db, sub, formId, deps.kBusiness);
  if (stored !== 'stored' && stored !== 'known') return { kind: 'ignored', reason: stored };

  // Read back by Jotform's own id, never the one in the URL: they are the same
  // for a real submission, and nothing else gets this far.
  const outcome = await processSubmission(deps.db, sub.id, iso());

  // 'already-checked' is the hourly pass getting there first - it may still be
  // unfiled, so the lesson is looked up either way rather than trusting `outcome`.
  const lessons = await deps.db.select<{ id: string }>(
    'lesson_signoff',
    `jotform_submission_id=eq.${sub.id}&status=eq.signed&filed_at=is.null&select=id&limit=1`,
  );
  const lessonId = lessons[0]?.id;
  if (lessonId === undefined) return { kind: 'checked', outcome };

  const folders = new FolderResolver(deps.drive);
  let reason: 'pdf-not-in-drive' | 'lock-busy' = 'lock-busy';
  for (;;) {
    if (await deps.lock.acquire()) {
      let filing: FilingResult;
      try {
        filing = await processFiling(
          deps.db,
          deps.drive,
          folders,
          deps.signoff.drive,
          lessonId,
          iso(),
        );
      } finally {
        await deps.lock.release();
      }
      if (filing.kind !== 'waiting-for-pdf') return { kind: 'filing', filing };
      reason = 'pdf-not-in-drive';
    } else {
      reason = 'lock-busy';
    }
    // Only start another wait if a look can still happen after it.
    if (now() - startedAt + pollMs > budgetMs) return { kind: 'left-for-hourly', reason };
    await sleep(pollMs);
  }
}
