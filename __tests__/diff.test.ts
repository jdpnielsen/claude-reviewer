import { describe, expect, it } from 'vitest';

import { parseDiffFiles } from '../lib/diff';
import { ChangeType } from '../lib/enum';

const fileDiff = (header: string[], hunk: string[]) => [...header, ...hunk].join('\n') + '\n';

describe('parseDiffFiles', () => {
  it("reads each change type from git's header", () => {
    const diff =
      fileDiff(
        [
          'diff --git a/new.ts b/new.ts',
          'new file mode 100644',
          'index 0000000..1111111',
          '--- /dev/null',
          '+++ b/new.ts',
        ],
        ['@@ -0,0 +1 @@', '+x'],
      ) +
      fileDiff(
        [
          'diff --git a/gone.ts b/gone.ts',
          'deleted file mode 100644',
          'index 1111111..0000000',
          '--- a/gone.ts',
          '+++ /dev/null',
        ],
        ['@@ -1 +0,0 @@', '-x'],
      ) +
      fileDiff(
        [
          'diff --git a/old.ts b/moved.ts',
          'similarity index 90%',
          'rename from old.ts',
          'rename to moved.ts',
          'index 1111111..2222222 100644',
          '--- a/old.ts',
          '+++ b/moved.ts',
        ],
        ['@@ -1 +1 @@', '-x', '+y'],
      ) +
      fileDiff(
        [
          'diff --git a/edit.ts b/edit.ts',
          'index 1111111..2222222 100644',
          '--- a/edit.ts',
          '+++ b/edit.ts',
        ],
        ['@@ -1 +1 @@', '-x', '+y'],
      );

    expect(parseDiffFiles(diff).map((f) => [f.path, f.changeType, f.oldPath])).toEqual([
      ['new.ts', ChangeType.Added, undefined],
      ['gone.ts', ChangeType.Deleted, undefined],
      ['moved.ts', ChangeType.Renamed, 'old.ts'],
      ['edit.ts', ChangeType.Modified, undefined],
    ]);
  });

  // A diff of a diff parser: its added lines quote git's header text.
  it("isn't fooled by content rows that read like header lines", () => {
    const diff = fileDiff(
      [
        'diff --git a/parse.test.ts b/parse.test.ts',
        'index 1111111..2222222 100644',
        '--- a/parse.test.ts',
        '+++ b/parse.test.ts',
      ],
      [
        '@@ -1,2 +1,4 @@',
        ' const a = 1;',
        "+  'new file mode 100644',",
        "+  'deleted file mode 100644',",
        '-old',
        '+++ not a header',
        '--- not one either',
      ],
    );

    const [file] = parseDiffFiles(diff);
    expect(file.changeType).toBe(ChangeType.Modified);
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(2);
  });

  it('takes a rename\'s paths from its rename lines, even with " b/" in a path', () => {
    const diff = fileDiff(
      [
        'diff --git a/a b/c.ts b/a b/d.ts',
        'similarity index 100%',
        'rename from a b/c.ts',
        'rename to a b/d.ts',
      ],
      [],
    );

    expect(parseDiffFiles(diff)).toEqual([
      {
        path: 'a b/d.ts',
        oldPath: 'a b/c.ts',
        changeType: ChangeType.Renamed,
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it('calls a mode-only change a modification', () => {
    const diff = fileDiff(
      ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'],
      [],
    );

    expect(parseDiffFiles(diff)[0].changeType).toBe(ChangeType.Modified);
  });
});
