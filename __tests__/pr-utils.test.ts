import { describe, expect, it } from 'vitest';

import type { FileInfo } from '../app/prs/[id]/types';
import {
  buildContextUrl,
  commentHref,
  commentUuidFromHash,
  contextCacheKey,
  findAnchorMatchInDiff,
  getCrossSideRange,
  getFileContentFromDiff,
  getRangeTextFromDiff,
  linesAvailableAbove,
  linesAvailableBelow,
  MAX_LINES_DEFAULT,
  parseFileDiff,
  parseFileDiffMeta,
  parseHunkRanges,
  shouldCollapseByDefault,
  vscodeFileUrl,
} from '../app/prs/[id]/utils';
import { ChangeType, LineType } from '../lib/enum';

describe('getRangeTextFromDiff', () => {
  const diffLines = [
    '@@ -1,4 +1,5 @@',
    ' function total(items) {',
    '-  return items.length;',
    '+  let sum = 0;',
    '+  return sum;',
    ' }',
  ];

  it('extracts new-side added lines within the range', () => {
    expect(getRangeTextFromDiff(diffLines, 2, 3, LineType.New)).toEqual([
      '  let sum = 0;',
      '  return sum;',
    ]);
  });

  it('extracts an old-side deleted line', () => {
    expect(getRangeTextFromDiff(diffLines, 2, 2, LineType.Old)).toEqual(['  return items.length;']);
  });

  it('includes unchanged context lines on the new side', () => {
    expect(getRangeTextFromDiff(diffLines, 1, 1, LineType.New)).toEqual([
      'function total(items) {',
    ]);
  });

  it('only matches deleted lines on the old side, not context lines', () => {
    // Old-side line 3 is the trailing context line " }", which only counts
    // as "new side" for matching purposes - it must not appear here.
    expect(getRangeTextFromDiff(diffLines, 2, 3, LineType.Old)).toEqual(['  return items.length;']);
  });

  it('handles multiple hunks, resetting line counters at each header', () => {
    const multiHunk = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      '@@ -10,2 +10,2 @@',
      '-old bottom',
      '+new bottom',
    ];
    expect(getRangeTextFromDiff(multiHunk, 10, 10, LineType.New)).toEqual(['new bottom']);
  });

  it('returns an empty array when the range is out of bounds', () => {
    expect(getRangeTextFromDiff(diffLines, 100, 101, LineType.New)).toEqual([]);
  });
});

describe('getCrossSideRange', () => {
  // idx: 0='@@ -1,4 +1,5 @@', 1=' function total(items) {',
  //      2='-  return items.length;' (old line 2), 3='+  let sum = 0;' (new line 2),
  //      4='+  return sum;' (new line 3), 5=' }'
  const diffLines = [
    '@@ -1,4 +1,5 @@',
    ' function total(items) {',
    '-  return items.length;',
    '+  let sum = 0;',
    '+  return sum;',
    ' }',
  ];

  it('pairs a single deleted line with a single added line', () => {
    expect(getCrossSideRange(diffLines, 2, 3)).toEqual({
      oldStart: 2,
      oldEnd: 2,
      newStart: 2,
      newEnd: 2,
    });
  });

  it('is bounded by the two clicked rows, not the whole block', () => {
    // Clicking the LAST added line (row 4, new line 3) and shift-clicking the
    // deleted line (row 2, old line 2) spans both added rows (2-3) but only
    // the one deleted row - it must not expand to include rows outside [2,4].
    expect(getCrossSideRange(diffLines, 4, 2)).toEqual({
      oldStart: 2,
      oldEnd: 2,
      newStart: 2,
      newEnd: 3,
    });
  });

  it('is symmetric in argument order', () => {
    expect(getCrossSideRange(diffLines, 3, 2)).toEqual(getCrossSideRange(diffLines, 2, 3));
  });

  it('returns null when a context line falls inside the span', () => {
    // Row 1 is a context line - it can't be unambiguously "old" or "new".
    expect(getCrossSideRange(diffLines, 1, 2)).toBeNull();
  });

  it('returns null when the span has no deleted line at all', () => {
    expect(getCrossSideRange(diffLines, 3, 4)).toBeNull();
  });

  it('returns null across a hunk boundary', () => {
    const multiHunk = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      '@@ -10,2 +10,2 @@',
      '-old bottom',
      '+new bottom',
    ];
    // The hunk header itself (row 3) breaks the pure +/- span.
    expect(getCrossSideRange(multiHunk, 1, 4)).toBeNull();
  });
});

describe('findAnchorMatchInDiff', () => {
  const diffLines = [
    '@@ -1,5 +1,6 @@',
    ' function total(items) {',
    '-  return items.length;',
    '+  let sum = 0;',
    '+  return sum;',
    ' }',
    ' export default total;',
  ];

  it('returns null with no anchor content to match on', () => {
    expect(findAnchorMatchInDiff(diffLines, null, null, null, LineType.New)).toBeNull();
  });

  it('finds the unique matching new-side line', () => {
    expect(findAnchorMatchInDiff(diffLines, 'return sum;', null, null, LineType.New)).toEqual({
      anchorLine: 3,
      lineType: LineType.New,
    });
  });

  it('only matches an old-type comment against the removed line, not the new side', () => {
    expect(
      findAnchorMatchInDiff(diffLines, 'return items.length;', null, null, LineType.Old),
    ).toEqual({ anchorLine: 2, lineType: LineType.Old });
    expect(
      findAnchorMatchInDiff(diffLines, 'return items.length;', null, null, LineType.New),
    ).toBeNull();
  });

  it('matches a new-type comment against an unchanged context line too', () => {
    expect(findAnchorMatchInDiff(diffLines, '}', null, null, LineType.New)).toEqual({
      anchorLine: 4,
      lineType: LineType.New,
    });
  });

  const ambiguousDiffLines = [
    '@@ -1,7 +1,8 @@',
    ' function a() {',
    '   doA();',
    '+  extra();',
    ' }',
    ' function b() {',
    '   doB();',
    ' }',
  ];

  it('disambiguates multiple exact-content matches using the captured context', () => {
    expect(
      findAnchorMatchInDiff(ambiguousDiffLines, '}', 'doB();', null, LineType.New),
    ).toEqual({ anchorLine: 7, lineType: LineType.New });
  });

  it('returns null when multiple matches stay ambiguous with no context to narrow them', () => {
    expect(findAnchorMatchInDiff(ambiguousDiffLines, '}', null, null, LineType.New)).toBeNull();
  });

  it('returns null when context narrows to zero candidates (stale anchor)', () => {
    expect(
      findAnchorMatchInDiff(ambiguousDiffLines, '}', 'nonexistent context', null, LineType.New),
    ).toBeNull();
  });
});

describe('shouldCollapseByDefault', () => {
  const file = (overrides: Partial<FileInfo>): FileInfo => ({
    path: 'src/index.ts',
    changeType: ChangeType.Modified,
    additions: 5,
    deletions: 5,
    ...overrides,
  });

  it('leaves an ordinary small diff expanded', () => {
    expect(shouldCollapseByDefault(file({}), false)).toBe(false);
  });

  it('collapses a diff whose line count exceeds the render cap', () => {
    expect(
      shouldCollapseByDefault(file({ additions: MAX_LINES_DEFAULT, deletions: 1 }), false),
    ).toBe(true);
  });

  it('does not collapse a diff exactly at the render cap', () => {
    const half = MAX_LINES_DEFAULT / 2;
    expect(shouldCollapseByDefault(file({ additions: half, deletions: half }), false)).toBe(false);
  });

  it('collapses an otherwise-ordinary small diff once marked reviewed', () => {
    expect(shouldCollapseByDefault(file({}), true)).toBe(true);
  });

  it.each([
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'composer.lock',
    'Gemfile.lock',
    'go.sum',
    'mix.lock',
    'flake.lock',
  ])('collapses known lockfile %s even when tiny', (filename) => {
    expect(
      shouldCollapseByDefault(file({ path: filename, additions: 1, deletions: 0 }), false),
    ).toBe(true);
  });

  it('matches lockfiles nested in a subdirectory', () => {
    expect(
      shouldCollapseByDefault(file({ path: 'packages/web/package-lock.json', additions: 1 }), false),
    ).toBe(true);
  });

  it('does not treat an unrelated file with a similar name as noisy', () => {
    expect(shouldCollapseByDefault(file({ path: 'src/yarn.lock.md', additions: 1 }), false)).toBe(
      false,
    );
  });
});

describe('contextCacheKey', () => {
  it('gives the same hunk a different key in each commit view', () => {
    const inCommitA = contextCacheKey('a'.repeat(40), 'lib/git.ts', 0, 'up');
    const inCommitB = contextCacheKey('b'.repeat(40), 'lib/git.ts', 0, 'up');
    const inCumulative = contextCacheKey(null, 'lib/git.ts', 0, 'up');
    expect(new Set([inCommitA, inCommitB, inCumulative]).size).toBe(3);
  });

  it('still separates hunks, directions and files within one commit view', () => {
    const sha = 'c'.repeat(40);
    const keys = [
      contextCacheKey(sha, 'lib/git.ts', 0, 'up'),
      contextCacheKey(sha, 'lib/git.ts', 0, 'down'),
      contextCacheKey(sha, 'lib/git.ts', 1, 'up'),
      contextCacheKey(sha, 'lib/database.ts', 0, 'up'),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('reuses one key for repeated expansions of the same hunk', () => {
    const sha = 'd'.repeat(40);
    expect(contextCacheKey(sha, 'lib/git.ts', 2, 'down')).toBe(
      contextCacheKey(sha, 'lib/git.ts', 2, 'down'),
    );
  });
});

describe('buildContextUrl', () => {
  it('pins the request to the commit whose diff is on screen', () => {
    const sha = 'e'.repeat(40);
    const url = buildContextUrl('pr-1', 'lib/git.ts', 90, 99, sha);
    const params = new URL(url, 'http://x').searchParams;
    expect(url.startsWith('/api/prs/pr-1/context?')).toBe(true);
    expect(params.get('commit')).toBe(sha);
    expect(params.get('file')).toBe('lib/git.ts');
    expect(params.get('start')).toBe('90');
    expect(params.get('end')).toBe('99');
  });

  it('omits commit for the cumulative diff, letting the API use the PR head', () => {
    const params = new URL(buildContextUrl('pr-1', 'lib/git.ts', 1, 10, null), 'http://x')
      .searchParams;
    expect(params.has('commit')).toBe(false);
  });

  it('escapes a path that would otherwise break out of the query string', () => {
    const params = new URL(
      buildContextUrl('pr-1', 'app/prs/[id]/a b&start=1.ts', 1, 10, null),
      'http://x',
    ).searchParams;
    expect(params.get('file')).toBe('app/prs/[id]/a b&start=1.ts');
    expect(params.get('start')).toBe('1');
  });
});

describe('parseHunkRanges', () => {
  it('reads each hunk new-side extent in order', () => {
    expect(
      parseHunkRanges(['@@ -10,3 +10,4 @@ fn a', ' ctx', '@@ -40,2 +41,2 @@ fn b', ' ctx']),
    ).toEqual([
      { newStart: 10, newEnd: 13 },
      { newStart: 41, newEnd: 42 },
    ]);
  });

  it('treats an omitted count as one line', () => {
    expect(parseHunkRanges(['@@ -1 +1 @@'])).toEqual([{ newStart: 1, newEnd: 1 }]);
  });

  it('gives a pure deletion an empty new-side range', () => {
    const [range] = parseHunkRanges(['@@ -5,3 +4,0 @@']);
    expect(range).toEqual({ newStart: 4, newEnd: 3 });
    expect(range.newEnd - range.newStart + 1).toBe(0);
  });

  it('ignores diff body lines that merely start with @', () => {
    expect(parseHunkRanges(['+@@ not a header', ' @@ -1,1 +1,1 @@'])).toEqual([]);
  });
});

describe('linesAvailableAbove', () => {
  // Hunks covering new-side 10-12 and 40-42: 9 lines above the first, and 27
  // between them (13-39).
  const ranges = parseHunkRanges(['@@ -10,3 +10,3 @@', '@@ -40,3 +40,3 @@']);

  it('counts up to the top of the file for the first hunk', () => {
    expect(linesAvailableAbove(ranges, 0, 0)).toBe(9);
  });

  it('stops at the previous hunk rather than running through it', () => {
    expect(linesAvailableAbove(ranges, 1, 0)).toBe(27);
  });

  it('discounts what has already been expanded', () => {
    expect(linesAvailableAbove(ranges, 0, 4)).toBe(5);
    expect(linesAvailableAbove(ranges, 0, 9)).toBe(0);
  });

  it('never goes negative once the gap is exhausted', () => {
    expect(linesAvailableAbove(ranges, 0, 20)).toBe(0);
  });

  it('reports nothing above a hunk that starts at line 1', () => {
    expect(linesAvailableAbove(parseHunkRanges(['@@ -1,3 +1,3 @@']), 0, 0)).toBe(0);
  });

  it('reports nothing for a hunk index that does not exist', () => {
    expect(linesAvailableAbove(ranges, 5, 0)).toBe(0);
  });
});

describe('linesAvailableBelow', () => {
  // Adjacent hunks - 1-2 then 3-4 - leave no gap between them at all.
  const adjacent = parseHunkRanges(['@@ -1,2 +1,2 @@', '@@ -3,2 +3,2 @@']);
  // 1-2 then 6-7 leaves lines 3-5.
  const gapped = parseHunkRanges(['@@ -1,2 +1,2 @@', '@@ -6,2 +6,2 @@']);

  it('stops at the next hunk', () => {
    expect(linesAvailableBelow(gapped, 0, 0, null)).toBe(3);
  });

  it('reports nothing between two adjacent hunks', () => {
    expect(linesAvailableBelow(adjacent, 0, 0, null)).toBe(0);
  });

  it('stops at the end of the file for the last hunk', () => {
    expect(linesAvailableBelow(gapped, 1, 0, 10)).toBe(3);
    expect(linesAvailableBelow(gapped, 1, 0, 7)).toBe(0);
  });

  it('discounts what has already been expanded', () => {
    expect(linesAvailableBelow(gapped, 0, 2, null)).toBe(1);
    expect(linesAvailableBelow(gapped, 0, 3, null)).toBe(0);
  });

  // Nothing but a context response can say where a file ends, so until one
  // has, the last hunk keeps offering to expand rather than hiding a control
  // that probably does have lines behind it.
  it('treats an unknown file length as unbounded for the last hunk', () => {
    expect(linesAvailableBelow(gapped, 1, 0, null)).toBe(Infinity);
  });

  it('reports nothing for a hunk index that does not exist', () => {
    expect(linesAvailableBelow(gapped, 5, 0, 100)).toBe(0);
  });
});

// Real `git diff` output: a file renamed and made executable with one line
// changed, a new binary file, and a new text file whose content row happens
// to look like a header.
const extendedHeaderDiff =
  [
    'diff --git a/bin/old.sh b/bin/run.sh',
    'old mode 100644',
    'new mode 100755',
    'similarity index 80%',
    'rename from bin/old.sh',
    'rename to bin/run.sh',
    'index 1111111..2222222',
    '--- a/bin/old.sh',
    '+++ b/bin/run.sh',
    '@@ -1,2 +1,2 @@',
    ' #!/bin/sh',
    '-echo old',
    '+echo new',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..3333333',
    'Binary files /dev/null and b/logo.png differ',
    'diff --git a/notes.md b/notes.md',
    'new file mode 100644',
    'index 0000000..4444444',
    '--- /dev/null',
    '+++ b/notes.md',
    '@@ -0,0 +1,2 @@',
    '+++ not a header',
    '+diff --git a/x b/x',
  ].join('\n') + '\n';

describe('parseFileDiff', () => {
  it("drops git's extended header lines, keeping only the hunks", () => {
    expect(parseFileDiff(extendedHeaderDiff, 'bin/run.sh')).toEqual([
      '@@ -1,2 +1,2 @@',
      ' #!/bin/sh',
      '-echo old',
      '+echo new',
    ]);
  });

  it('finds a renamed file by its new path', () => {
    expect(parseFileDiff(extendedHeaderDiff, 'bin/run.sh')).not.toEqual([]);
    expect(parseFileDiff(extendedHeaderDiff, 'bin/old.sh')).toEqual([]);
  });

  it('keeps content rows that look like headers', () => {
    expect(parseFileDiff(extendedHeaderDiff, 'notes.md')).toEqual([
      '@@ -0,0 +1,2 @@',
      '+++ not a header',
      '+diff --git a/x b/x',
    ]);
    expect(getFileContentFromDiff(extendedHeaderDiff, 'notes.md')).toBe(
      '++ not a header\ndiff --git a/x b/x',
    );
  });

  it('has no rows for a binary file', () => {
    expect(parseFileDiff(extendedHeaderDiff, 'logo.png')).toEqual([]);
  });
});

describe('parseFileDiffMeta', () => {
  it('reports a mode change on an existing file', () => {
    expect(parseFileDiffMeta(extendedHeaderDiff, 'bin/run.sh')).toEqual({
      modeChange: { from: '100644', to: '100755' },
      binary: false,
    });
  });

  it("leaves out a new file's mode", () => {
    expect(parseFileDiffMeta(extendedHeaderDiff, 'notes.md')).toEqual({
      modeChange: null,
      binary: false,
    });
  });

  it('flags a binary file', () => {
    expect(parseFileDiffMeta(extendedHeaderDiff, 'logo.png').binary).toBe(true);
  });
});

describe('vscodeFileUrl', () => {
  it('joins the checkout and file path, ending at the line', () => {
    expect(vscodeFileUrl('/work/repo/', 'src/a.ts', 12)).toBe(
      'vscode://file/work/repo/src/a.ts:12',
    );
  });

  it('encodes each path segment, so # and ? stay part of the name', () => {
    expect(vscodeFileUrl('/my repo', 'app/[id]/a#b?.ts', 1)).toBe(
      'vscode://file/my%20repo/app/%5Bid%5D/a%23b%3F.ts:1',
    );
  });
});

describe('commentHref', () => {
  it("links to the comment's commit, naming the thread in the fragment", () => {
    expect(commentHref('2ff9044b', 'c1', 'abc123')).toBe('/prs/2ff9044b?commit=abc123#comment-c1');
  });

  it('links to the cumulative diff for a comment made there', () => {
    expect(commentHref('2ff9044b', 'c1', null)).toBe('/prs/2ff9044b#comment-c1');
  });

  it('round-trips through commentUuidFromHash', () => {
    const href = commentHref('p', 'b24ad24a-9f', null);
    expect(commentUuidFromHash(href.slice(href.indexOf('#')))).toBe('b24ad24a-9f');
  });
});

describe('commentUuidFromHash', () => {
  it('ignores fragments that name no comment', () => {
    expect(commentUuidFromHash('')).toBeNull();
    expect(commentUuidFromHash('#comment-')).toBeNull();
    expect(commentUuidFromHash('#file-a-ts')).toBeNull();
  });
});
