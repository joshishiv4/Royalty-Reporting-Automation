#!/usr/bin/env node
import { notifyDeadLetter } from '../notify/index.js';
import { SupabaseClient } from '../supabase/client.js';
import { loadConfig } from '../config/index.js';
import { ConfigValidationError } from '../config/schema.js';
import { createDefaultFileSinks } from '../logging/file-sink.js';
import { createLogger } from '../logging/logger.js';
import { credentialValues, describeConfig, redact } from '../logging/redact.js';
import { MissingSecretsError, SecretsProviderError } from '../secrets/types.js';
import { checkAll } from '../health/index.js';
import { runFullSyncPassParallel } from '../sync/pass.js';
import { runWellnessSync } from '../wl/sync.js';

const USAGE = `royalty-sync <command>

Commands:
  healthcheck        Resolve config, then probe every dependency. Exit 1 on failure.
  alert:test         Send the alert digest now, even when nothing is wrong, to prove
                     the channel reaches a real inbox. Exit 1 if nothing was sent.
  sync:wellness      Authenticate against WellnessLiving, then run one read-only pass.
  sync:full-parallel Run every sync pass in dependency waves, in parallel within each
                     wave. Aimed at a local backfill: each pass seeds ONCE and drains
                     within its own budget (default 90 min per pass).
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
  'alert:test',
];

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
