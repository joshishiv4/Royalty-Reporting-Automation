/**
 * The date window the transaction reports are asked for, and why it has to be
 * FROZEN rather than recomputed.
 *
 * `o_date` IS MANDATORY ON THESE REPORTS. Measured 17 Sep 2026: omitting it is
 * rejected outright with `end-date-not-set`, so there is no "give me everything"
 * mode. Unlike the client list (where the filter date is the CLIENT SINCE date
 * and a narrow window silently drops people), here it filters on the
 * TRANSACTION date - proven by a row whose purchase started 2024-04-18 and whose
 * payment, dated 2025-05-13, appeared in a 2025-only window. So a window is the
 * right tool and it means what it says.
 *
 * Unlike every other WL date in this project, these accept a BARE `YYYY-MM-DD`.
 * `dl_` is a local date. `dt_date` needing a time component is a different
 * parameter on different endpoints.
 *
 * =============================================================================
 * THE ONE THING THAT WILL BREAK THIS IF IT IS FORGOTTEN
 * =============================================================================
 * WL CACHES A REPORT BY ITS FILTER, and `is_refresh: 1` resets a build in flight
 * back to generating (WL Support, 31 Aug 2026). The build takes longer than one
 * Vercel invocation - 90 seconds for the full history, measured - so the pass
 * polls across invocations.
 *
 * Recompute "today minus seven days .. today" on each of those invocations and
 * the filter is a different filter every time the clock crosses a boundary, or
 * the moment `now` is a timestamp rather than a date. A different filter is a
 * different report: WL starts a new build, the poll never finds a finished one,
 * and the pass defers forever while reporting nothing wrong.
 *
 * So the window is computed ONCE, written to `sync_job_state.last_key`, and read
 * back from there for every poll and every page until the read completes. That
 * is what `frozen` is. The rule below is consulted only when nothing is frozen.
 *
 * =============================================================================
 * THE RULE, WHEN NOTHING IS FROZEN
 * =============================================================================
 *   a manual override        ->  exactly what was asked for (0031, one-shot)
 *   no clean completion yet  ->  INITIAL: historyStart .. today   (1980-01-01 ..)
 *   a clean completion       ->  DAILY:   today - lookback .. today
 *
 * Derived from the watermark rather than stored, for the reason 0031 spells out:
 * an interrupted backfill leaves `last_clean_completion_at` unmoved and so still
 * looks like a backfill next time. A stored, advancing cursor would move past
 * work it never did.
 *
 * THE MONTHLY RE-READ USES THE OVERRIDE, not a third mode. The monthly route
 * sets the last SYNC_MONTHLY_LOOKBACK_MONTHS calendar months as an override on
 * these jobs, exactly as it already widens the visit window - so a retroactive
 * edit inside those months is re-read once a month, and the override is consumed
 * by the clean drain.
 */

/** A `dl_start` / `dl_end` pair, in the format these reports accept. */
export interface TxWindow {
  /** `YYYY-MM-DD`. A bare date, which THIS endpoint accepts - see the header. */
  readonly dlStart: string;
  readonly dlEnd: string;
  /** True when nothing has ever drained cleanly, so this is a full backfill. */
  readonly isInitial: boolean;
  /** True when a manual override supplied this window rather than the rule. */
  readonly isOverride: boolean;
}

export interface TxWindowInput {
  /** Configured earliest date, e.g. `1980-01-01`. */
  readonly historyStart: string;
  readonly lookbackDays: number;
  /** `sync_job_state.last_clean_completion_at`, or null if never. */
  readonly lastCleanCompletionAt: string | null;
  /** One-shot manual window (0031). Set, it wins over the derived rule. */
  readonly startOverride?: string | null;
  readonly endOverride?: string | null;
  /** Milliseconds since epoch. */
  readonly now: number;
}

/** WL wants a local date here; a time component is neither needed nor sent. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function transactionWindow(input: TxWindowInput): TxWindow {
  const today = day(input.now);

  // A manual window wins outright, before the watermark branch: overriding what
  // the rule would have chosen is the entire point of setting one.
  const start = input.startOverride ?? null;
  const end = input.endOverride ?? null;
  if (start !== null || end !== null) {
    return {
      // An end with no start still reaches back to the floor. "Up to here" means
      // everything up to here, not an empty range.
      dlStart: start === null ? input.historyStart.slice(0, 10) : start.slice(0, 10),
      dlEnd: end === null ? today : end.slice(0, 10),
      isInitial: false,
      isOverride: true,
    };
  }

  if (input.lastCleanCompletionAt === null) {
    return {
      dlStart: input.historyStart.slice(0, 10),
      dlEnd: today,
      isInitial: true,
      isOverride: false,
    };
  }

  // Anchored on NOW, not on the watermark: a watermark weeks old (a job paused
  // and resumed) would silently widen the daily window into another backfill.
  const back = input.now - input.lookbackDays * 24 * 60 * 60 * 1000;
  return { dlStart: day(back), dlEnd: today, isInitial: false, isOverride: false };
}

/** How the frozen window is written to, and read back from, `last_key`. */
export function encodeWindow(window: Pick<TxWindow, 'dlStart' | 'dlEnd'>): string {
  return `${window.dlStart}|${window.dlEnd}`;
}

/**
 * Reads a frozen window back.
 *
 * REFUSES ANYTHING THAT IS NOT TWO PLAIN DATES. A malformed cursor must not
 * become a window: WL would accept `dl_start=undefined` shaped nonsense as a
 * filter that matches nothing, build it happily, and the pass would store zero
 * transactions and report success. Returning null sends the caller back to the
 * rule, which is the safe direction to fail in.
 */
export function decodeWindow(value: string | null): Pick<TxWindow, 'dlStart' | 'dlEnd'> | null {
  if (value === null) return null;
  const [start, end, ...rest] = value.split('|');
  if (rest.length > 0 || start === undefined || end === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (end < start) return null;
  return { dlStart: start, dlEnd: end };
}
