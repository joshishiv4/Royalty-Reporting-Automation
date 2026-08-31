/**
 * How far back the visit sync reaches, and why it is two different answers.
 *
 * THE ENDPOINT HAS TWO MODES, NOT ONE. `/v1/schedule/page/list` answers with
 * UPCOMING visits when sent only `{ uid }`. `is_past=1` switches it to the
 * client's previous visits, and only then do `dtu_start` / `dtu_end` narrow it -
 * note `dtu_`, not `dt_`, which is why an earlier probe concluded the dates were
 * ignored. So covering a client completely takes TWO list calls, not one.
 *
 * WHY A WINDOW AT ALL, WHEN is_past ALONE IS COMPLETE. For the first run it adds
 * nothing: measured 31 Aug 2026 over 20 clients, `is_past` alone and
 * `is_past` + 1980..now both returned exactly 323 visits. It earns its place on
 * the DAILY run, where the window is what stops 39,000 historical visits being
 * re-listed every night to find the handful that changed.
 *
 * WHICH MODE, DECIDED BY EVIDENCE RATHER THAN A FLAG. `sync_job_state`
 * .last_clean_completion_at moves ONLY when a pass drains with nothing
 * outstanding (0007). So:
 *
 *   no clean completion yet  ->  INITIAL: historyStart .. now
 *   a clean completion       ->  DAILY:   now - lookback .. now
 *
 * That is deliberately not a manual switch. A half-finished backfill leaves the
 * watermark unmoved, so the next run is still an initial one and picks up what it
 * missed - which is the whole reason the watermark exists.
 *
 * THE LOOKBACK IS DELIBERATELY LONGER THAN A DAY. A session's outcome is settled
 * after it runs, not when it is booked, and WellnessLiving may leave it PENDING
 * for staff for a while. Two days of overlap costs almost nothing (every write is
 * an upsert on a WL key, so re-reading is free of consequence) and covers a
 * missed night.
 */

/** A `dtu_start` / `dtu_end` pair, in the format WL accepts. */
export interface VisitWindow {
  /** `YYYY-MM-DD HH:MM:SS`. WL rejects a bare date - see WL-API-NOTES. */
  readonly dtuStart: string;
  readonly dtuEnd: string;
  /** True when nothing has ever drained cleanly, so this is a full backfill. */
  readonly isInitial: boolean;
  /** True when a manual override supplied this window rather than the rule. */
  readonly isOverride: boolean;
}

export interface VisitWindowInput {
  /** Configured earliest date, e.g. `1980-01-01`. */
  readonly historyStart: string;
  readonly lookbackDays: number;
  /** `sync_job_state.last_clean_completion_at`, or null if never. */
  readonly lastCleanCompletionAt: string | null;
  /**
   * A one-shot manual window (0031). Set, it WINS over the derived rule; a start
   * with no end means "from there to now". It is cleared by the next clean drain,
   * not on read - see the migration for why a standing override is a footgun.
   */
  readonly startOverride?: string | null;
  readonly endOverride?: string | null;
  /** Milliseconds since epoch. */
  readonly now: number;
}

/**
 * WL wants `YYYY-MM-DD HH:MM:SS`. A bare date is rejected outright
 * (`dt-date-invalid`), which is the silent trap documented in WL-API-NOTES.
 */
export function wlDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Accepts `1980-01-01` or a full timestamp; always returns WL's format. */
function startOfDay(date: string): string {
  const day = date.trim().slice(0, 10);
  return `${day} 00:00:00`;
}

export function visitWindow(input: VisitWindowInput): VisitWindow {
  const dtuEnd = wlDateTime(input.now);

  // A manual window wins outright. Deliberately BEFORE the watermark branch: the
  // whole point of setting one is to override what the rule would have chosen,
  // including on a job that has already drained cleanly.
  const start = input.startOverride ?? null;
  const end = input.endOverride ?? null;
  if (start !== null || end !== null) {
    return {
      // An end with no start still reaches back to the configured floor - "up to
      // here" means everything up to here, not an empty range.
      dtuStart: start === null ? startOfDay(input.historyStart) : wlDateTime(Date.parse(start)),
      dtuEnd: end === null ? dtuEnd : wlDateTime(Date.parse(end)),
      isInitial: false,
      isOverride: true,
    };
  }

  if (input.lastCleanCompletionAt === null) {
    return { dtuStart: startOfDay(input.historyStart), dtuEnd, isInitial: true, isOverride: false };
  }
  // Anchored on NOW, not on the watermark. A watermark that is weeks old (a job
  // paused and resumed) would otherwise silently widen the daily window into
  // another accidental backfill; the lookback is a fixed overlap, by design.
  const back = input.now - input.lookbackDays * 24 * 60 * 60 * 1000;
  return { dtuStart: wlDateTime(back), dtuEnd, isInitial: false, isOverride: false };
}
