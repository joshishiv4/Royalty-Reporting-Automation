import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SupabaseClient, SupabaseError } from '../src/supabase/client.js';

/**
 * Makes PostgREST's 1,000-row cap impossible to walk into again.
 *
 * WHY THIS TEST EXISTS, WITH THE RECEIPTS. PostgREST answers a query with no
 * explicit limit by returning at most 1,000 rows - HTTP 200, no warning, no
 * indication anything was left behind. A read that believes it got everything
 * therefore fails while reporting success, which is the worst shape a failure can
 * take. It has already cost this project twice on live dev:
 *
 *   - receipt_sync seeded 1,000 of 14,148 unpriced purchases. The pass reported
 *     'ok' with nothing left to do and pricing coverage sat near 30%.
 *   - once the client list began storing every status (0027) `person` reached
 *     1,285 rows, and four seeds read 1,000 of them. 285 clients were invisible
 *     to profile, purchase, visit and GoHighLevel-match seeding while
 *     sync_queue_progress showed every work type at 100% done.
 *
 * Both were found by measuring row counts by hand, months apart, after the data
 * was already wrong. Neither would have reached live if this test had existed, so
 * the rule is mechanical now:
 *
 *   EVERY db.select MUST either carry an explicit `limit=` in its query, or be
 *   db.selectAll.
 *
 * A `limit=` says "I know this is bounded, and by how much". selectAll says "I
 * want all of it and I have paged for it". What is banned is the third case -
 * the read that wanted everything and quietly took the first thousand.
 *
 * FIXING A FAILURE. If the read is bounded by a key equality, add `&limit=1` (or
 * the real bound) and it is self-documenting. If it genuinely wants every row,
 * switch to selectAll and give it an `order=` on a unique column.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every .ts file under a directory, forward-slashed and repo-relative. */
function sourceFiles(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((entry) => {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  return walk(join(ROOT, dir))
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .sort();
}

/**
 * Call sites of `db.select<...>` / `db.selectAll<...>`, with the nine lines that
 * follow so a query split across template literals is still seen.
 *
 * Nine because the widest real call site - the client-visit attendance read -
 * spans eight. A window that is too short would silently stop finding the query
 * and report a false pass, which is the same class of bug this file is about.
 */
const WINDOW = 9;

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly isSelectAll: boolean;
  readonly block: string;
}

function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of [...sourceFiles('src'), ...sourceFiles('api')]) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const match = /\bdb\.select(All)?</.exec(line);
      if (match === null) return;
      found.push({
        file,
        line: i + 1,
        isSelectAll: match[1] === 'All',
        block: lines.slice(i, i + WINDOW).join('\n'),
      });
    });
  }
  return found;
}

describe('no read can silently take the first 1,000 rows', () => {
  // Guards the scanner itself. An empty list would make every assertion below
  // pass forever, for the wrong reason - the exact failure mode the rule is
  // about.
  it('finds the select call sites at all', () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThan(15);
    expect(sites.some((s) => s.isSelectAll)).toBe(true);
    expect(sites.some((s) => !s.isSelectAll)).toBe(true);
  });

  it('every db.select carries an explicit limit, or is db.selectAll', () => {
    const unbounded = callSites()
      .filter((s) => !s.isSelectAll && !s.block.includes('limit='))
      .map((s) => `${s.file}:${s.line}`);

    expect(
      unbounded,
      "These reads would take PostgREST's first 1,000 rows and report success.\n" +
        'Add an explicit &limit= if the read is bounded, or use db.selectAll with\n' +
        'an order= if it wants every row:\n  ' +
        unbounded.join('\n  '),
    ).toEqual([]);
  });

  it('every db.selectAll orders its paging, because offset without order can skip rows', () => {
    const unordered = callSites()
      .filter((s) => s.isSelectAll && !s.block.includes('order='))
      .map((s) => `${s.file}:${s.line}`);

    expect(
      unordered,
      'Offset paging over an unordered result may repeat or skip rows.\n  ' +
        unordered.join('\n  '),
    ).toEqual([]);
  });

  /**
   * The seeds are the reads that decide how much work exists, so a truncated one
   * does not merely return less - it makes the queue lie about being finished.
   * Asserted POSITIVELY, by counting selectAll seeds, rather than by pattern-
   * matching for a bad shape: pass.ts also holds a legitimate
   * `db.select<{ uid: string }>('person', ...&limit=1)` probe, and a
   * "does this bad pattern appear" test flagged that correct call as a failure.
   */
  it('all four person seeds and the session seed page', () => {
    const pass = readFileSync(join(ROOT, 'src/sync/pass.ts'), 'utf8');
    const personSeeds = pass.match(/db\.selectAll<\{ uid: string \}>\(\s*'person',/g) ?? [];
    expect(personSeeds).toHaveLength(4);
    expect(pass).toMatch(/db\.selectAll<[^>]*>\(\s*'session',/);
  });
});

describe('selectAll refuses the arguments that would make it wrong', () => {
  const client = (): SupabaseClient =>
    new SupabaseClient(
      { url: 'https://example.invalid', serviceRoleKey: 'k' },
      {
        fetch: () => {
          throw new Error('selectAll must reject before it reaches the network');
        },
      },
    );

  /**
   * Asserted on NOT REACHING THE NETWORK, not merely on rejecting. A fetch
   * failure is also a SupabaseError, so `rejects.toBeInstanceOf` alone passed
   * even with the guard deleted - confirmed by mutation. What must be true is
   * that the call is refused before a request is made.
   */
  it('refuses a query with no order before it reaches the network', async () => {
    const reached: string[] = [];
    const c = new SupabaseClient(
      { url: 'https://example.invalid', serviceRoleKey: 'k' },
      {
        fetch: (url) => {
          reached.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
          return Promise.resolve(new Response('[]'));
        },
      },
    );

    await expect(c.selectAll('person', 'select=uid')).rejects.toBeInstanceOf(SupabaseError);
    expect(reached).toEqual([]);
  });

  it('names the reason, so the fix does not need this file to be read', async () => {
    await expect(client().selectAll('person', 'select=uid')).rejects.toThrow(/order=/);
  });

  // A caller's own limit would fight the pager: the first page would come back
  // short and selectAll would stop, having read the caller's limit rather than
  // every row - a truncation wearing the name of the fix for truncation.
  it("rejects a caller's own limit, which would end the paging early", async () => {
    await expect(client().selectAll('person', 'order=uid.asc&limit=10&select=uid')).rejects.toThrow(
      /limit/,
    );
  });

  // Proves the guards let a well-formed query THROUGH rather than rejecting
  // everything - without this, both assertions above would still pass if
  // selectAll simply always threw.
  it('lets a well-formed query reach the network', async () => {
    const reached: string[] = [];
    const c = new SupabaseClient(
      { url: 'https://example.invalid', serviceRoleKey: 'k' },
      {
        fetch: (url) => {
          // RequestInfo is Request | string | URL; each has its own way to the
          // href, and String() on a Request yields "[object Request]".
          reached.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
          throw new Error('stop here');
        },
      },
    );

    await expect(c.selectAll('person', 'order=uid.asc&select=uid')).rejects.toBeInstanceOf(
      SupabaseError,
    );
    expect(reached).toHaveLength(1);
    // And it added its own paging rather than passing the query through raw.
    expect(reached[0]).toContain('limit=1000');
    expect(reached[0]).toContain('offset=0');
  });
});
