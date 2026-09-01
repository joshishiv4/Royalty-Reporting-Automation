/**
 * Turns dead-letter queue rows into an email a non-technical reader can act on.
 *
 * The rule the writing follows: no sids, no HTTP status codes, no trace ids in
 * the BODY. Those live on the queue row and are useful when someone opens the
 * database, but they mean nothing to somebody reading their inbox. The email
 * says WHAT stage failed, HOW MANY records were affected, and a plain-English
 * reason. If a human wants to dig deeper, the health view is one click away.
 *
 * WHEN NOTHING IS SENT. A run that produced zero dead-letter items does not
 * mail anyone: the whole point of the notification is "something needs a look",
 * and a healthy run does not.
 */

export interface DeadItem {
  readonly work_type: string;
  readonly target_key: string;
  readonly last_error: string | null;
  readonly last_error_sid: string | null;
  readonly last_http_status: number | null;
  readonly attempt_count: number;
}

export interface DeadDigest {
  /** True when there is something to send. */
  readonly hasIssues: boolean;
  readonly subject: string;
  readonly body: string;
}

/**
 * A short human name for each stage, so the email reads "purchases could not
 * be updated" rather than "purchase_list failed". Anything not in this map is
 * printed as-is - a new work_type will read technically but never crash.
 */
const STAGE_NAMES: Record<string, string> = {
  client_list: 'the client roster',
  staff_list: 'the staff list',
  location_list: 'the location list',
  shop_category_list: 'the shop-category list',
  promotion_list: 'promotions',
  service_category_list: 'service categories',
  login_type_list: 'the login-type list',
  purchase_list: 'purchase records',
  purchase_receipt: 'purchase receipts (the money side)',
  purchase_item_element: 'purchase item details',
  user_profile: 'client profiles',
  schedule_window: 'the class schedule',
  client_visits: 'private appointments',
  session_attendance: 'session attendance',
  ghl_contact_match: 'GoHighLevel contact matching',
  service_list: 'the service catalogue',
  historical_month_window: 'historical class schedule (one month)',
};

/**
 * Non-technical explanation for the common WL and internal failure shapes we
 * see. Order matters: the first pattern that matches wins.
 */
interface ReasonRule {
  readonly match: (item: DeadItem) => boolean;
  readonly plain: string;
}

const REASON_RULES: readonly ReasonRule[] = [
  {
    match: (i) => i.last_error_sid === 'id-nx',
    plain:
      'WellnessLiving reported the record does not exist. It may have been deleted after it was first seen. No further retry will help.',
  },
  {
    match: (i) => i.last_error_sid?.includes('rate-limit') === true,
    plain:
      'WellnessLiving asked us to slow down. The retries were spent before the throttle lifted. Running the sync again later should catch these up.',
  },
  {
    match: (i) => i.last_http_status === 401 || i.last_http_status === 403,
    plain:
      'Authentication was rejected. This usually means the API credentials need to be checked or rotated.',
  },
  {
    match: (i) => i.last_http_status === 504 || i.last_http_status === 502,
    plain:
      'WellnessLiving was slow to respond and the request timed out after several retries. Running the sync again later should catch these up.',
  },
  {
    match: (i) => i.last_error_sid?.includes('date') === true,
    plain:
      'WellnessLiving rejected the date parameter. This is a bug on our side. Please forward this email to the engineering team.',
  },
  {
    match: (i) => i.last_error?.includes('gone before') === true,
    plain:
      'The record was removed from our database between when it was queued and when we tried to fetch it. This is unusual but self-correcting - the next run will not try it again.',
  },
];

const DEFAULT_REASON =
  'An error was recorded but its cause is not one we recognise. Please forward this email to the engineering team so they can investigate.';

function stageLabel(workType: string): string {
  return STAGE_NAMES[workType] ?? workType;
}

function reasonFor(item: DeadItem): string {
  for (const rule of REASON_RULES) {
    if (rule.match(item)) return rule.plain;
  }
  return DEFAULT_REASON;
}

/** Groups items by (stage, reason) so the email reads once per pattern. */
interface Group {
  stage: string;
  reason: string;
  count: number;
  samples: string[];
}

function groupItems(items: readonly DeadItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const item of items) {
    const stage = stageLabel(item.work_type);
    const reason = reasonFor(item);
    const key = `${stage}||${reason}`;
    let g = map.get(key);
    if (g === undefined) {
      g = { stage, reason, count: 0, samples: [] };
      map.set(key, g);
    }
    g.count += 1;
    if (g.samples.length < 3) g.samples.push(item.target_key);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export interface CrashedPass {
  readonly job_name: string;
  readonly error: string | null;
}

export function buildDigest(
  deadItems: readonly DeadItem[],
  crashedPasses: readonly CrashedPass[] = [],
): DeadDigest {
  if (deadItems.length === 0 && crashedPasses.length === 0) {
    return {
      hasIssues: false,
      subject: '',
      body: '',
    };
  }

  const groups = groupItems(deadItems);
  const totalStages = new Set(groups.map((g) => g.stage)).size + crashedPasses.length;
  const totalItems = deadItems.length;

  const subjectParts: string[] = [];
  if (totalItems > 0) subjectParts.push(`${String(totalItems)} record(s) could not be updated`);
  if (crashedPasses.length > 0)
    subjectParts.push(`${String(crashedPasses.length)} stage(s) crashed`);
  const subject = `Royalty sync: ${subjectParts.join(' and ')}`;

  const lines: string[] = [];
  const summaryParts: string[] = [];
  if (totalItems > 0)
    summaryParts.push(
      `${String(totalItems)} record(s) across ${String(new Set(groups.map((g) => g.stage)).size)} area(s) could not be updated after several attempts`,
    );
  if (crashedPasses.length > 0)
    summaryParts.push(
      `${String(crashedPasses.length)} stage(s) stopped before finishing because of an unexpected error`,
    );
  lines.push(`The most recent royalty sync finished, but ${summaryParts.join(', and ')}.`);
  lines.push('');
  lines.push('Here is what happened, grouped by what needs the same next step:');
  lines.push('');

  for (const g of groups) {
    lines.push(`• ${String(g.count)} record(s) in ${g.stage}.`);
    lines.push(`  Reason: ${g.reason}`);
    lines.push(
      `  Example record(s): ${g.samples.slice(0, 3).join(', ')}${g.count > g.samples.length ? ' (and more)' : ''}`,
    );
    lines.push('');
  }

  for (const c of crashedPasses) {
    lines.push(
      `• The stage "${stageLabel(c.job_name.replace(/_sync$/, ''))}" stopped unexpectedly.`,
    );
    lines.push(
      `  Reason: An error was recorded from the database or an internal component. This is not a WellnessLiving problem.`,
    );
    if (c.error !== null && c.error.length > 0)
      lines.push(`  Additional detail (for engineering): ${c.error}`);
    lines.push('');
  }

  lines.push(
    'You do not need to do anything with this email if the numbers are small and the reasons say a later run will catch them up.',
  );
  lines.push(
    'If the same message repeats for several runs in a row, please forward it to the engineering team.',
  );
  // Suppress noUnusedLocals when totalStages is only used in subject variants.
  void totalStages;

  return {
    hasIssues: true,
    subject,
    body: lines.join('\n'),
  };
}
