import type { DriveFile } from '../../src/google/drive.js';
import { FOLDER_MIME } from '../../src/google/drive.js';
import { LESSON_TAG } from '../../src/sync/lesson-signoff-file.js';

/**
 * An in-memory Drive for the lesson sign-off filing tests (phase 3 and the
 * task 039 webhook). Understands the two query shapes lesson-signoff-file.ts
 * sends: a folder lookup by parent and name, and the drop-folder-or-tag lookup.
 */

export interface FakeFile {
  id: string;
  name: string;
  mimeType?: string;
  parents: string[];
  appProperties?: Record<string, string>;
}
const unq = (s: string): string => s.replace(/\\(.)/g, '$1');

export function fakeDrive(initial: FakeFile[]) {
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
