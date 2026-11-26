#!/usr/bin/env node
import { SWEEP_CRASH_WINDOW_MS, notifyDeadLetter } from '../notify/index.js';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FRESH_DONE_WINDOW_MS,
  DEFAULT_QUEUE_ROW_CAP,
  DEFAULT_RETENTION_MS,
  pruneDoneItems,
  pruneQueue,
  recordQueuePruneRun,
} from '../sync/queue.js';
import { SupabaseClient } from '../supabase/client.js';
import { loadConfig } from '../config/index.js';
import { ConfigValidationError } from '../config/schema.js';
import { createDefaultFileSinks } from '../logging/file-sink.js';
import { createLogger } from '../logging/logger.js';
import { credentialValues, describeConfig, redact } from '../logging/redact.js';
import { MissingSecretsError, SecretsProviderError } from '../secrets/types.js';
import { checkAll } from '../health/index.js';
import { runFullSyncPassParallel, runHistoricalScheduleSyncPass } from '../sync/pass.js';
import { setWindowOverride } from '../sync/job-state.js';
import { readWindowRequest } from '../sync/visit-window.js';
import { runWellnessSync } from '../wl/sync.js';

const USAGE = `royalty-sync <command>

Commands:
  healthcheck        Resolve config, then probe every dependency. Exit 1 on failure.
  alert:test         Send the alert digest now, even when nothing is wrong, to prove
                     the channel reaches a real inbox. Exit 1 if nothing was sent.
  alert:sweep        The scheduled watchdog sweep. Mails ONLY when something is
                     wrong - a quiet inbox is the healthy signal. Exit 0 either way.
  sync:historical    Re-read the schedule over a date range, so a session edited
                     weeks after it ran is picked up. With no range it uses
                     SYNC_MONTHLY_LOOKBACK_MONTHS.
                       --start=YYYY-MM-DD  --end=YYYY-MM-DD   (both, or neither)
  sync:wellness      Authenticate against WellnessLiving, then run one read-only pass.
  sync:full-parallel Run every sync pass in dependency waves, in parallel within each
                     wave. Aimed at a local backfill: each pass seeds ONCE and drains
                     within its own budget (default 90 min per pass).
  queue:prune        Keep sync_queue bounded: delete done rows past the retention
                     window (3 days), dead rows over 2 days old whose target has
                     since been done, then the oldest done rows while the table is
                     over the cap (300,000), never inside the last 24 hours.
                     DRY RUN unless --apply is given. Exit 1 if over the cap.
                       --apply  --days=N  --cap=N  --batch=N  --max-batches=N
  config:check       Resolve and validate config only. Makes no network calls.
  config:show        Print the resolved config with credentials fingerprinted.
  help               Show this message.

Environment:
  APP_ENV           dev | prod                       (required)
  SECRETS_PROVIDER  env | aws-secrets-manager        (default: env)

See .env.example and docs/RUNBOOK.md.`;

/**
 * Every command this CLI accepts.
 *
 * ONE list, checked in main() and switched on below. It used to be an inline
 * array that the switch could - and did - drift from: a case added to the
 * switch without a matching entry here is rejected as "Unknown command" while
 * looking perfectly present in the code.
 */
const COMMANDS: readonly string[] = [
  'healthcheck',
  'config:check',
  'config:show',
  'sync:wellness',
  'sync:full-parallel',
  'sync:historical',
  'alert:test',
  'alert:sweep',
  'queue:prune',
];

/**
 * Reads `--name=value` out of the tail of argv.
 *
 * Deliberately tiny and deliberately not a flag library. Two commands take two
 * options between them; a parser would be more code than the thing it parses.
 */
function readOption(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  // ONE list, checked here and switched on below. Kept as a named constant
  // because it used to be an inline array that the switch could - and did -
  // drift from: a case added to the switch without a matching entry here is
  // rejected as "Unknown command" while looking perfectly present in the code.
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const config = await loadConfig();
  // Files are opt-in (LOG_TO_FILE). Lines are redacted before any sink sees
  // them, so a log file cannot hold a credential the console did not show.
  const logger = createLogger({
    level: config.runtime.logLevel,
    secrets: credentialValues(config),
    ...(config.runtime.logToFile ? { sinks: createDefaultFileSinks(config.runtime.logDir) } : {}),
  });

  switch (command) {
    case 'config:check': {
      logger.info('configuration resolved', {
        env: config.env,
        secretsProvider: config.secretsProviderName,
      });
      console.log('OK');
      return 0;
    }

    case 'config:show': {
      console.log(JSON.stringify(describeConfig(config), null, 2));
      return 0;
    }

    case 'sync:wellness': {
      const summary = await runWellnessSync(config);
      // One line naming the run, so a support request can quote the prefix that
      // every trace id below shares.
      logger.info('sync pass', { runId: summary.runId, env: summary.env });
      if (summary.authError !== undefined) {
        logger.error('sync authentication FAILED', {
          endpoint: '/oauth2/token',
          outcome: 'failed',
          runId: summary.runId,
          detail: summary.authError,
        });
      }
      for (const step of summary.steps) {
        // endpoint + duration + outcome + trace id: everything needed to trace a
        // call without reproducing it. kLog is WL's own, present only on the
        // endpoints that send one; traceId is ours and always there.
        const fields = {
          step: step.name,
          endpoint: step.path,
          latencyMs: step.latencyMs,
          outcome: step.ok ? 'ok' : 'failed',
          traceId: step.traceId,
          kLog: step.kLog,
        };
        if (step.ok) logger.info('sync step ok', fields);
        else logger.error('sync step FAILED', { ...fields, detail: step.detail });
      }
      console.log(JSON.stringify(summary, null, 2));
      return summary.ok ? 0 : 1;
    }

    case 'sync:full-parallel': {
      logger.info('parallel full sync starting', { env: config.env });
      const summary = await runFullSyncPassParallel(config);
      logger.info('parallel full sync finished', {
        runId: summary.runId,
        state: summary.state,
        durationMs: summary.durationMs,
      });
      for (const p of summary.passes) {
        if (!p.ran || p.summary === null) {
          logger.warn('pass skipped', { job: p.job });
          continue;
        }
        const s = p.summary;
        const fields = {
          job: p.job,
          state: s.state,
          claimed: s.claimed,
          done: s.done,
          requeued: s.requeued,
          dead: s.dead,
          itemsRemaining: s.itemsRemaining,
        };
        if (s.state === 'ok') logger.info('pass ok', fields);
        else if (s.state === 'partial') logger.warn('pass partial', fields);
        else logger.error('pass failed', { ...fields, error: s.error ?? 'unknown' });
      }
      console.log(JSON.stringify(summary, null, 2));
      return summary.state === 'failed' ? 1 : 0;
    }

    case 'sync:historical': {
      /**
       * The monthly re-read, and any range a human asks for.
       *
       * WHY THIS IS A COMMAND AND NOT ONLY A ROUTE. It used to exist solely as
       * `/api/wellness-sync-historical`, which meant the monthly workflow had to
       * curl Vercel - and a Vercel function is killed at 60 seconds. So the ONE
       * pass that re-reads two whole calendar months was the one pass held to
       * the tightest clock in the system, stopping early and leaving the rest
       * queued for a later invocation. Running it here removes that cap; a
       * runner job may take hours.
       *
       * THE RANGE RULE IS NOT REIMPLEMENTED HERE. An explicit range is persisted
       * as a window override and the pass reads it back, exactly as the route
       * does - so a killed run resumes on what was asked for rather than losing
       * the ask. With no range the pass derives its own from
       * SYNC_MONTHLY_LOOKBACK_MONTHS. Validation comes from readWindowRequest,
       * so "start must be before end" has one definition, not two.
       */
      const options = argv.slice(1);
      const window = readWindowRequest({
        start: readOption(options, 'start'),
        end: readOption(options, 'end'),
      });

      // Both or neither. A lone boundary would be honoured by the route as
      // "from there to now", but as a typed command line it is far more likely
      // to be a forgotten second flag than an intention - and re-reading from a
      // date to now can be months of work nobody asked for.
      if ((window.start === null) !== (window.end === null)) {
        console.error('sync:historical needs --start and --end together, or neither.');
        return 2;
      }

      const db = new SupabaseClient(config.supabase);
      if (window.requested) {
        await setWindowOverride(
          db,
          'historical_schedule_sync',
          config.wl.kBusiness,
          window.start,
          window.end,
          new Date().toISOString(),
        );
      }

      logger.info('historical sync starting', {
        env: config.env,
        window: window.requested ? `${window.start} .. ${window.end}` : 'derived',
      });

      // NO BUDGET. It runs until the queue drains, however long that is.
      //
      // A first draft passed one, because runPass used to fall back to 50
      // seconds - the Vercel cap, inherited by anything that did not argue. That
      // default is gone: guessing a deadline for work whose size nobody knows is
      // how a half-finished run reports success. The only real bound now is the
      // workflow's own job timeout, which is where a platform limit belongs.
      const summary = await runHistoricalScheduleSyncPass(config);

      logger.info('historical sync finished', {
        runId: summary.runId,
        state: summary.state,
        done: summary.done,
        itemsRemaining: summary.itemsRemaining,
      });
      console.log(
        JSON.stringify(
          {
            ...summary,
            window_applied: window.requested ? { start: window.start, end: window.end } : null,
          },
          null,
          2,
        ),
      );
      return summary.state === 'failed' ? 1 : 0;
    }

    case 'queue:prune': {
      /**
       * Enforces the retention window on sync_queue's 'done' rows.
       *
       * DRY RUN BY DEFAULT, like requeue.mjs and window.mjs. This deletes, and a
       * command that deletes on the strength of a typo'd --days is not one you
       * want on a runner. --apply is the opt-in.
       *
       * THE WINDOW HAS A FLOOR OF 24 HOURS and the command refuses to go under
       * it. enqueue() reads today's 'done' rows to decide whether a target was
       * already refreshed; prune into that window and the dedupe goes blind and
       * re-queues the same work the same day. Checked here rather than left to
       * the caller, because the caller is a cron line somebody edits at 2am.
       *
       * EXIT 0 WHEN THE BACKLOG IS NOT YET CLEAR. The first runs meet a backlog
       * and stop at maxBatches by design; 'partial' is progress, not failure -
       * the next hourly run carries on.
       *
       * EXIT 1, AND A 'failed' RUN ROW, when the prune throws or the table is
       * over the cap with nothing older than 24 hours left to remove. The row is
       * what the morning alert sweep reads (it reports failed sync_run rows); the
       * exit code turns the Actions run red, which is the signal left when the
       * database itself is what failed. The prune failed silently on 18, 20 and
       * 24 Nov 2026 - that is what this closes.
       */
      const days = Number(readOption(argv, 'days') ?? String(DEFAULT_RETENTION_MS / 86_400_000));
      if (!Number.isFinite(days) || days <= 1) {
        console.error(
          `--days must be greater than 1: anything inside the ${String(
            DEFAULT_FRESH_DONE_WINDOW_MS / 3_600_000,
          )}h fresh-done window blinds enqueue's dedupe.`,
        );
        return 1;
      }
      const cap = Number(readOption(argv, 'cap') ?? String(DEFAULT_QUEUE_ROW_CAP));
      if (!Number.isFinite(cap) || cap <= 0) {
        console.error('--cap must be a positive number of rows.');
        return 1;
      }
      const batch = readOption(argv, 'batch');
      const maxBatches = readOption(argv, 'max-batches');
      const applied = argv.includes('--apply');
      const db = new SupabaseClient(config.supabase);

      if (!applied) {
        // The dry run stays what it was: a count of what the AGE rule would take.
        const result = await pruneDoneItems(db, {
          before: new Date(Date.now() - days * 86_400_000).toISOString(),
          ...(batch === null ? {} : { batch: Number(batch) }),
          dryRun: true,
        });
        logger.info('queue prune', { days, applied, ...result });
        console.log(
          JSON.stringify(
            {
              env: config.env,
              days,
              applied,
              ...result,
              note: 'dry run - re-run with --apply to delete',
            },
            null,
            2,
          ),
        );
        return 0;
      }

      const runId = randomUUID().replace(/-/g, '').slice(0, 8);
      const startedAt = new Date().toISOString();
      let summary: Awaited<ReturnType<typeof pruneQueue>> | null = null;
      let error: string | null = null;
      try {
        summary = await pruneQueue(db, {
          retentionMs: days * 86_400_000,
          cap,
          ...(batch === null ? {} : { batch: Number(batch) }),
          ...(maxBatches === null ? {} : { maxBatches: Number(maxBatches) }),
        });
        if (summary.state === 'failed') {
          error =
            `sync_queue is over the ${String(cap)}-row cap (estimated ` +
            `${String(summary.cap.estimatedRows)}) with no done rows older than 24h left to remove`;
        }
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
      }
      const state = error === null ? (summary?.state ?? 'failed') : 'failed';

      try {
        await recordQueuePruneRun(db, {
          runId,
          kBusiness: config.wl.kBusiness,
          startedAt,
          finishedAt: new Date().toISOString(),
          state,
          error,
        });
      } catch {
        // The database is likely what failed; the exit code below still says so.
      }

      logger.info('queue prune', { days, cap, applied, runId, state, ...(summary ?? {}) });
      console.log(
        JSON.stringify(
          { env: config.env, days, cap, applied, runId, state, error, summary },
          null,
          2,
        ),
      );
      return state === 'failed' ? 1 : 0;
    }

    case 'alert:sweep': {
      /**
       * The scheduled watchdog sweep - what /api/alerts does, on a runner.
       *
       * IT SENDS NOTHING WHEN THERE IS NOTHING, and that is the point. `force`
       * belongs to `alert:test` alone. A channel that mails on healthy days
       * stops being read, which is the same "looks fine, is not" failure the
       * alerts were built to catch, one level up.
       *
       * EXIT 0 WHETHER OR NOT MAIL WENT. "Nothing to report" is the healthy
       * answer to a sweep. Returning non-zero on a quiet night would paint the
       * workflow red every day until nobody looks at it - and then the one red
       * run that meant something would look like all the others.
       *
       * A sweep that cannot reach the database DOES fail, via the throw: that is
       * not a quiet night, it is the watchdog being blind, and it has to be
       * visible as a failed run.
       */
      const db = new SupabaseClient(config.supabase);
      const crashedSince = new Date(Date.now() - SWEEP_CRASH_WINDOW_MS).toISOString();
      const result = await notifyDeadLetter(db, config.smtp, {
        kBusiness: config.wl.kBusiness,
        crashedSince,
      });
      logger.info('alert sweep', { ...result });
      console.log(JSON.stringify({ env: config.env, ...result }, null, 2));
      return 0;
    }

    case 'alert:test': {
      /**
       * Proves the alert channel actually reaches somebody.
       *
       * WHY THIS EXISTS AS A COMMAND. Every other alert in this system fires
       * only when something is wrong, which means the FIRST time anyone learns
       * whether the mail is configured correctly is the night it matters. A
       * silent alerting path is worse than none: it is the same "looks fine, is
       * not" failure the alerts were built to catch, one level up.
       *
       * It sends the real digest built from the real database, so it exercises
       * the whole path - reads, wording, SMTP - not a hardcoded "hello".
       */
      const db = new SupabaseClient(config.supabase);
      const result = await notifyDeadLetter(db, config.smtp, {
        kBusiness: config.wl.kBusiness,
        force: true,
      });
      logger.info('alert test', { ...result });
      console.log(JSON.stringify({ env: config.env, ...result }, null, 2));
      // Non-zero when nothing was sent: a test that cannot fail proves nothing,
      // and "SMTP is unconfigured" must not read as success in CI or a script.
      return result.sent ? 0 : 1;
    }

    case 'healthcheck': {
      const results = await checkAll(config);
      for (const result of results) {
        const fields = {
          target: result.target,
          detail: result.detail,
          latencyMs: result.latencyMs,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        };
        if (result.ok) logger.info('health ok', fields);
        else logger.error('health FAILED', fields);
      }
      const allOk = results.every((r) => r.ok);
      console.log(
        JSON.stringify(
          { env: config.env, secretsProvider: config.secretsProviderName, ok: allOk, results },
          null,
          2,
        ),
      );
      return allOk ? 0 : 1;
    }
  }

  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Startup failures print a bare message: at this point there is no logger,
    // and a stack trace from a secrets backend can echo request context.
    if (
      error instanceof MissingSecretsError ||
      error instanceof SecretsProviderError ||
      error instanceof ConfigValidationError
    ) {
      console.error(`startup failed: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`startup failed: ${redact(error.message, [])}`);
    } else {
      console.error('startup failed: unknown error');
    }
    process.exitCode = 1;
  });
