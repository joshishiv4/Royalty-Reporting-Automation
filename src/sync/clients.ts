import { createHash } from 'node:crypto';
import type { SupabaseClient } from '../supabase/client.js';
import type { ReportPage } from '../wl/report.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The client list, from the reporting endpoint (PRD M07).
 *
 * THIS IS WHAT UNBLOCKS CLIENT ENUMERATION. Every other WL endpoint answers
 * about one client you already know the uid of; none of them lists clients. The
 * "Client List" report does, and it agrees with the portal exactly - 517
 * activated clients, and all twelve client-type totals matching tile for tile,
 * measured 26 Aug 2026.
 *
 * ROWS ARE POSITIONAL, AND THE POSITIONS ARE NOT OURS TO ASSUME.
 * `a_row` holds bare arrays; the column ids live separately in `a_field`. Worse,
 * several ids are business configuration - the `field-custom-*` columns are keyed
 * by ids meaningless outside this business, and the ORDER comes from how the
 * report is configured in the portal. (The observed ids are in
 * docs/WL-API-NOTES.md, not here: a business id sitting in source is exactly what
 * tests/no-hardcoded-config.test.ts exists to stop.)
 *
 * So every value is looked up by field NAME. Reading `row[5]` because
 * email is at index 5 today would silently write phone numbers into the email
 * column the first time somebody adds a column in the WL UI.
 *
 * WE DEPEND ON NO CUSTOM FIELD. Every column below is either top-level (`uid`,
 * `k_login_type`, `text_client_type`) or `field-general-*`, which are WL's own.
 * The business-specific `field-custom-*` columns are read by nothing here, so
 * reconfiguring them cannot break the sync.
 */

/**
 * Field id -> person column.
 *
 * The names look arbitrary because they are WL's, not ours. Each was confirmed
 * by joining 25 API rows against the portal's own CSV export of the same 25
 * clients and checking the values matched on all 25 - not by reading the name
 * and assuming.
 */
const FIELD_TO_COLUMN: Readonly<Record<string, string>> = {
  uid: 'uid',
  k_login_type: 'k_login_type',
  // The portal's "Client" column is these two joined, in this order.
  'field-general-2.text_name': 'first_name',
  'field-general-1': 'last_name',
  'field-general-3': 'email',
  'field-general-4': 'phone',
  'field-general-5': 'phone_home',
  'field-general-6': 'phone_work',
  'field-general-7.dl_date': 'date_of_birth',
  // The portal calls this "Member ID". It is NOT the uid - see DATA-MODEL.
  'field-general-11': 'text_member',
  text_client_type: 'text_login_type',
};

/** Columns that must never be overwritten with an absent value. */
const REQUIRED = 'uid';

/**
 * The two columns WL splits the profile note into (migration 0064).
 *
 * Not in FIELD_TO_COLUMN because they do not go to `person`: person is readable
 * by the client it describes, and these are the studio's notes about them. They
 * go to `wl_client_note`, which nobody but the service role reads.
 *
 * Measured live 19 Oct 2026: both present on the report, `has_note` a boolean,
 * `text_note_list` a whole HTML document as one string - 260 of 524 activated
 * clients have one. `/v1/report/data`'s `s_note` was "" on all 256 of its rows,
 * including a client with a note, so it is not read.
 */
const NOTE_FLAG = 'o_note.has_note';
const NOTE_BODY = 'o_note.text_note_list';

/** Every field id this sync reads. A page missing any of them is refused. */
const READ_FIELDS: readonly string[] = [...Object.keys(FIELD_TO_COLUMN), NOTE_FLAG, NOTE_BODY];

/**
 * Refuses a page whose field list has stopped carrying something we map.
 *
 * WHY THIS HAS TO THROW. `mapClientRow` looks every value up by field id and
 * skips an id it does not recognise, which is right for the six
 * `field-custom-*` columns we deliberately ignore - but it means the reverse
 * failure is silent. If WL renames a field id, or a studio admin removes a
 * column from the report in the portal (the report IS portal-configured - see
 * the header), that column simply stops being written. Every client keeps its
 * stale value, the pass reports `ok`, and nothing anywhere says a field went
 * missing.
 *
 * Worse for `uid`: `mapClientRow` returns null without one, and `mapClientRows`
 * drops those rows - so losing the uid field id writes ZERO clients and still
 * reports success. That is the same shape as the queued-report bug in
 * wl/report.ts and the 1,000-row PostgREST cap in supabase/client.ts: the run
 * looks clean while the data is wrong. Both of those are defended against; this
 * was not.
 *
 * Measured before adding it, so this is a no-op today rather than a new
 * blocker: all 11 mapped ids are present on 20 of 20 stored report payloads
 * (31 Aug 2026), out of 37 ids the report returns. The two note ids joined the
 * list with 0064, measured present on the live report (19 Oct 2026, 38 ids).
 * The note gets the same strictness for the same reason: a removed Notes column
 * would otherwise freeze every stored note at its last value, silently.
 *
 * Deliberately strict. Phone is the PRIMARY GoHighLevel match key, so a
 * quietly-absent phone column degrades matching rather than breaking it, which
 * is far harder to notice than a failed run. Whoever reconfigured the report
 * should decide - not this parser.
 */
export function assertReportFields(fields: readonly string[]): void {
  const present = new Set(fields);
  const missing = READ_FIELDS.filter((id) => !present.has(id));
  if (missing.length === 0) return;
  throw new Error(
    `WL client-list report is missing ${String(missing.length)} field id(s) this ` +
      `sync maps: ${missing.join(', ')}. The report is configured in the WL portal, ` +
      `so a removed or renamed column stops that column being written ` +
      `without any other error. Refusing the page rather than storing clients ` +
      `with silently absent fields.`,
  );
}

export interface ClientRow {
  readonly uid: string;
  readonly [column: string]: unknown;
}

/**
 * Turns one positional row into a person patch.
 *
 * MERGE, NEVER CLOBBER. WL sends `""` for a field the client has not filled in,
 * and an empty string is not evidence that the value was deleted - it is the
 * absence of evidence. Anything empty is dropped from the patch entirely, so an
 * upsert leaves whatever another endpoint already established. This is why the
 * return type is sparse rather than a full person.
 *
 * Returns null when the row carries no uid: without one there is nobody to be.
 */
export function mapClientRow(fields: readonly string[], row: readonly unknown[]): ClientRow | null {
  const patch: Record<string, unknown> = {};

  for (let i = 0; i < fields.length; i += 1) {
    const column = FIELD_TO_COLUMN[fields[i] ?? ''];
    if (column === undefined) continue;
    const value = readText(row[i]);
    if (value === null) continue;
    patch[column] = value;
  }

  const uid = patch[REQUIRED];
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return patch as ClientRow;
}

/** Every mappable row, with the unusable ones dropped rather than guessed at. */
export function mapClientRows(
  fields: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): readonly ClientRow[] {
  const seen = new Set<string>();
  const out: ClientRow[] = [];
  for (const row of rows) {
    const mapped = mapClientRow(fields, row);
    if (mapped === null) continue;
    // One human is one person row. A uid appearing twice in one report would
    // make the upsert fight itself; the first wins and the duplicate is dropped.
    if (seen.has(mapped.uid)) continue;
    seen.add(mapped.uid);
    out.push(mapped);
  }
  return out;
}

/** One of a client's WL notes. A client with three notes is three of these (0068). */
export interface ClientNote {
  readonly uid: string;
  /** Which note: a hash of its HTML, "#n" for a repeat - see noteKey. */
  readonly note_key: string;
  /** Display order: 0 is the note WL lists first (its newest). */
  readonly position: number;
  readonly note_html: string;
  readonly note_text: string | null;
}

/** What one page says about notes. */
export interface ClientNotes {
  /** Every note on the page. */
  readonly keep: readonly ClientNote[];
  /**
   * Every client the page makes a statement about (`has_note` true OR false).
   * Each of them keeps exactly its notes in `keep` and loses the rest - so a
   * `has_note: false` client, having none in `keep`, loses all of theirs.
   */
  readonly replace: readonly string[];
}

/**
 * WL's one string of notes, as the notes it holds.
 *
 * WL joins a profile's notes with ", " (measured 28 Oct 2026: 164 of 339 clients
 * have several). Every HTML note is a whole document, so a note ends at
 * `</html>` and the next begins after the ", " that follows - the only split
 * made. Older plain-text notes come after the HTML ones, and 29 such tails
 * contain ", " themselves: two notes, or one note with a comma, cannot be told
 * apart, so a plain-text tail stays one note rather than being cut on a guess.
 */
export function splitNotes(body: string): string[] {
  return body.split(/(?<=<\/html>), /i).filter((piece) => piece.trim().length > 0);
}

/**
 * Which of a client's notes this is: the first 32 hex of sha256 over its HTML as
 * WL sent it, with "#n" on the nth repeat of the same text on one profile.
 *
 * A hash, not the position: WL lists the newest note first, so one new note
 * would shift every position and every note would look edited. Migration 0068
 * computes the same hash in SQL for the rows it carries over - change one, change
 * both, or every note churns on the next pass.
 */
export function noteKey(html: string, occurrence: number): string {
  const hash = createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 32);
  return occurrence === 0 ? hash : `${hash}#${String(occurrence)}`;
}

/**
 * Reads the note columns of every row.
 *
 * THE ONE PLACE THIS SYNC MAY DELETE. Everywhere else, merge never clobbers -
 * WL's `""` is the absence of evidence. `has_note: false` is not absence: it is
 * WL stating there is no note, so a note removed in the portal is removed here.
 * Anything that is neither true nor false (null, missing) says nothing, and the
 * stored notes are left alone. A `has_note: true` with an empty body (WL's "Note
 * with no text") has nothing to keep, so it clears like false.
 *
 * Rows without a uid are dropped, and a repeated uid keeps its first row, both
 * exactly as mapClientRows does - so a note is never written for a person that
 * page did not write.
 */
export function mapClientNotes(
  fields: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): ClientNotes {
  const uidAt = fields.indexOf('uid');
  const flagAt = fields.indexOf(NOTE_FLAG);
  const bodyAt = fields.indexOf(NOTE_BODY);
  const seen = new Set<string>();
  const keep: ClientNote[] = [];
  const replace: string[] = [];

  for (const row of rows) {
    const uid = readText(row[uidAt]);
    if (uid === null || seen.has(uid)) continue;
    seen.add(uid);

    const flag = row[flagAt];
    if (flag === true || flag === 1 || flag === '1') {
      replace.push(uid);
      const body = row[bodyAt];
      if (typeof body !== 'string') continue;
      const repeats = new Map<string, number>();
      splitNotes(body).forEach((html, position) => {
        const occurrence = repeats.get(html) ?? 0;
        repeats.set(html, occurrence + 1);
        keep.push({
          uid,
          note_key: noteKey(html, occurrence),
          position,
          note_html: html,
          note_text: noteText(html),
        });
      });
    } else if (flag === false || flag === 0 || flag === '0') {
      replace.push(uid);
    }
  }
  return { keep, replace };
}

/** Named entities WL notes were seen to carry, plus the XML five. */
const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * WL's note HTML reduced to readable plain lines.
 *
 * WL sends every note as a whole document (`<!DOCTYPE html><html><head>...`),
 * and 81 of 260 live notes are rich - lists, `<br />`, `&nbsp;`, Gmail `<div>`s
 * from a pasted email. Block ends become line breaks, list items become `- `
 * lines, tags go, entities are decoded AFTER the tags are stripped (so a note
 * that literally says `&lt;b&gt;` keeps the text `<b>`), and blank runs collapse.
 *
 * Deliberately small rather than a full HTML parser: the stored note_html is the
 * record, this is a convenience copy recomputable from it.
 */
export function noteText(html: string): string | null {
  const text = html
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    // Not </li>: the next <li> already starts a line, and both would leave a
    // blank line between every item.
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith('#')) {
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length === 0 ? null : text;
}

export interface WriteClientListInput {
  readonly kBusiness: string;
  readonly runId: string;
  readonly page: ReportPage;
  readonly fields: readonly string[];
  readonly syncedAt: string;
  /**
   * The uids WL lists as ACTIVATED (o_member_status 3). Every client in this
   * page whose uid is in the set is stored `is_active = true`, the rest false.
   * The report row carries no status field (only a type label), so activation is
   * known only by membership of the activated result - see migration 0027.
   */
  readonly activatedUids: ReadonlySet<string>;
}

/**
 * Stores one page: the payload verbatim, then the people, then the link, then
 * the notes - kept, replaced, or deleted where WL says there is none (0064).
 *
 * `field_group` is 'identity' rather than 'all': this report establishes who
 * somebody is, and nothing about their money or their bookings. A person row
 * assembled from this report and a purchase payload can then trace each half to
 * where it came from.
 */
export async function writeClientList(
  db: SupabaseClient,
  input: WriteClientListInput,
): Promise<{ rawWlId: string; clients: readonly ClientRow[]; notes: ClientNotes }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: WL_PATHS.reportQuery,
    targetKind: 'page',
    runId: input.runId,
    response: input.page.response,
  });

  // AFTER the raw store, deliberately: if the shape has changed, the payload
  // that proves it is already in raw_wl to be read without another WL call.
  assertReportFields(input.fields);

  const clients = mapClientRows(input.fields, input.page.rows);
  if (clients.length > 0) {
    const rows = clients.map((c) => ({
      ...c,
      k_business: input.kBusiness,
      // Always known from the report split (true/false), never absent - so it is
      // safe against merge-never-clobber and every row carries it.
      is_active: input.activatedUids.has(c.uid),
      synced_at: input.syncedAt,
    }));
    for (const batch of groupByShape(rows)) {
      await db.upsert('person', batch, { onConflict: 'uid' });
    }
    await linkRows(
      db,
      rawWlId,
      'person',
      clients.map((c) => c.uid),
      'identity',
    );
  }

  // AFTER person, deliberately: wl_client_note.uid references person.uid, and
  // the person rows this page carries are written just above. One call for the
  // page (0068): each client the page speaks for keeps exactly these notes.
  const notes = mapClientNotes(input.fields, input.page.rows);
  if (notes.replace.length > 0) {
    await db.rpc('replace_wl_client_notes', {
      p_uids: notes.replace,
      p_notes: notes.keep.map((n) => ({
        ...n,
        k_business: input.kBusiness,
        raw_wl_id: rawWlId,
        synced_at: input.syncedAt,
      })),
    });
    await linkRows(
      db,
      rawWlId,
      'wl_client_note',
      [...new Set(notes.keep.map((n) => n.uid))],
      'note',
    );
  }

  return { rawWlId, clients, notes };
}

/**
 * WL's absent value is `""`, sometimes `null`, and for a few fields `0`.
 *
 * Only empty string and null are treated as absent here. A `0` is left alone
 * because none of the columns above is numeric - turning "0" into null would be
 * inventing a rule this report does not need.
 */
function readText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Splits rows into batches that share exactly the same set of keys.
 *
 * PostgREST rejects a bulk write whose objects differ in shape - `PGRST102: All
 * object keys must match` - because it builds one INSERT from the first object's
 * columns. That collides head-on with merge-never-clobber, which produces
 * deliberately sparse rows: a client with no work phone simply has no
 * `phone_work` key.
 *
 * The two obvious ways out are both wrong. Filling the gaps with null is exactly
 * the clobber the sparseness exists to prevent - it would erase values other
 * endpoints established. Writing one row per request turns 517 clients into 517
 * round trips.
 *
 * Grouping by shape keeps both properties. Measured on the live business, 517
 * activated clients fall into a manageable number of shapes, so the whole list
 * still goes in a handful of calls.
 */
export function groupByShape<T extends Record<string, unknown>>(
  rows: readonly T[],
): ReadonlyArray<readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(',');
    const existing = groups.get(shape);
    if (existing === undefined) groups.set(shape, [row]);
    else existing.push(row);
  }
  return [...groups.values()];
}
