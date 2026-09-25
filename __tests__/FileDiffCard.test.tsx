/**
 * Tests for the diff card's "show 10 more lines" context expansion, which has
 * to stay tied to the commit whose diff is on screen. A single commit's diff
 * is `sha^..sha`, so its line numbers index the file at that commit - pulling
 * the surrounding lines from anywhere else (the PR head, or another commit's
 * already-expanded lines under a colliding cache key) splices in text that
 * commit never contained.
 */
import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CommitInfo, FileInfo } from '../app/prs/[id]/types';
import { contextCacheKey } from '../app/prs/[id]/utils';
import FileDiffCard from '../components/pr/FileDiffCard';
import { ChangeType, CommentResolutionMode } from '../lib/enum';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

const file: FileInfo = {
  path: 'lib/total.ts',
  changeType: ChangeType.Modified,
  additions: 1,
  deletions: 1,
};

// Wraps hunks (each a list of raw diff rows, starting with its @@ header) in
// the file header the card parses the diff out of. The trailing newline
// matters: git emits one, and splitting on it leaves an empty row that used to
// count as a context line and push the line walk one past the end of the hunk.
function buildDiff(hunks: string[][]): string {
  return (
    [
      `diff --git a/${file.path} b/${file.path}`,
      'index 1111111..2222222 100644',
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      ...hunks.flat(),
    ].join('\n') + '\n'
  );
}

// One hunk starting at line 20, so there are 19 lines above it to expand into.
const diff = buildDiff([
  [
    '@@ -20,3 +20,3 @@ function total(items) {',
    '   let sum = 0;',
    '-  return items.length;',
    '+  return sum;',
    ' }',
  ],
]);

const commits: CommitInfo[] = [
  {
    sha: OLD_SHA,
    shortSha: OLD_SHA.slice(0, 7),
    message: 'first',
    body: '',
    author: 'dev',
    date: '2026-09-01T00:00:00Z',
  },
  {
    sha: NEW_SHA,
    shortSha: NEW_SHA.slice(0, 7),
    message: 'second',
    body: '',
    author: 'dev',
    date: '2026-09-02T00:00:00Z',
  },
];

type FetchContext = (filePath: string, startLine: number, endLine: number, key: string) => void;

function renderCard(
  overrides: {
    file?: FileInfo;
    diff?: string;
    displayedCommitSha?: string | null;
    fileLineCount?: number | null;
    repoPath?: string | null;
    expandedContext?: Map<string, string[]>;
    fetchContext?: FetchContext;
  } = {},
) {
  const renderedFile = overrides.file ?? file;
  const noop = () => {};
  return render(
    <FileDiffCard
      file={renderedFile}
      diff={overrides.diff ?? diff}
      fileComments={[]}
      commitSpecificComments={[]}
      commits={commits}
      displayedCommitSha={overrides.displayedCommitSha ?? null}
      fileLineCount={overrides.fileLineCount ?? null}
      repoPath={overrides.repoPath ?? null}
      isReviewed={false}
      toggleReviewed={noop}
      prId="pr1"
      onJumpToComment={noop}
      isExpanded
      toggleFile={noop}
      isPreview={false}
      togglePreview={noop}
      showAllLines={new Set()}
      setShowAllLines={noop}
      expandedContext={overrides.expandedContext ?? new Map()}
      loadingContext={new Set()}
      fetchContext={overrides.fetchContext ?? noop}
      commentingAt={null}
      setCommentingAt={noop}
      openLineComment={noop}
      lastClickedLine={null}
      setLastClickedLine={noop}
      isSelectingComment={false}
      setIsSelectingComment={noop}
      newComment=""
      setNewComment={noop}
      resolutionMode={CommentResolutionMode.Fix}
      setResolutionMode={noop}
      addComment={noop}
      editingComment={null}
      setEditingComment={noop}
      editComment={noop}
      replyingTo={null}
      setReplyingTo={noop}
      replyContent=""
      setReplyContent={noop}
      addReply={noop}
      insertReplySuggestion={noop}
      resolveComment={noop}
      deleteComment={noop}
    />,
  );
}

function clickExpandUp(container: HTMLElement) {
  const btn = container.querySelector('.expand-up');
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

// The cache key the card itself uses for this file's only hunk while showing
// the given commit's diff - read back off the fetchContext call rather than
// recomputed, so the cross-view tests below compare what the component really
// stores under, not what they assume it does.
function expandUpKeyFor(displayedCommitSha: string | null): string {
  const fetchContext = vi.fn<FetchContext>();
  const { container, unmount } = renderCard({ displayedCommitSha, fetchContext });
  clickExpandUp(container);
  unmount();
  return fetchContext.mock.calls[0][3] as string;
}

describe('FileDiffCard context expansion', () => {
  it('requests context under a key scoped to the commit being viewed', () => {
    const fetchContext = vi.fn<FetchContext>();
    const { container } = renderCard({ displayedCommitSha: OLD_SHA, fetchContext });

    clickExpandUp(container);

    expect(fetchContext).toHaveBeenCalledWith(
      file.path,
      10,
      19,
      contextCacheKey(OLD_SHA, file.path, 0, 'up'),
    );
  });

  it('never reuses one hunk’s key across commit views', () => {
    const keys = [expandUpKeyFor(OLD_SHA), expandUpKeyFor(NEW_SHA), expandUpKeyFor(null)];
    expect(new Set(keys).size).toBe(3);
  });

  it('renders the lines expanded for the commit on screen', () => {
    const { container } = renderCard({
      displayedCommitSha: OLD_SHA,
      expandedContext: new Map([
        [contextCacheKey(OLD_SHA, file.path, 0, 'up'), ['  // as it was in first']],
      ]),
    });

    const expanded = container.querySelectorAll('.expanded-context');
    expect(expanded).toHaveLength(1);
    // Syntax highlighting splits the line across token spans, so read the row.
    expect(expanded[0].textContent).toContain('// as it was in first');
  });

  it('does not show lines that were expanded while viewing an earlier commit', () => {
    const { container } = renderCard({
      displayedCommitSha: NEW_SHA,
      expandedContext: new Map([[expandUpKeyFor(OLD_SHA), ['  // only exists in first']]]),
    });

    expect(container.querySelectorAll('.expanded-context')).toHaveLength(0);
    expect(container.textContent).not.toContain('only exists in first');
  });
});

// Two hunks well clear of each other (new-side 10-12 and 40-42) and of the top
// of the file, so both have a real gap to expand into in both directions.
const twoHunkDiff = buildDiff([
  [
    '@@ -10,3 +10,3 @@ function first() {',
    '   let a = 0;',
    '-  return a;',
    '+  return a + 1;',
    ' }',
  ],
  [
    '@@ -40,3 +40,3 @@ function second() {',
    '   let b = 0;',
    '-  return b;',
    '+  return b + 1;',
    ' }',
  ],
]);

function upButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.expand-up'));
}

function downButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.expand-down'));
}

describe('FileDiffCard expand control visibility', () => {
  it('offers no expansion above a hunk that starts at line 1', () => {
    const { container } = renderCard({
      diff: buildDiff([['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three']]),
    });
    expect(upButtons(container)).toHaveLength(0);
  });

  it('offers no expansion in the zero-length gap between adjacent hunks', () => {
    // Hunks 0 and 1 are adjacent (lines 1-2 then 3-4) so the gap between them
    // is empty; hunk 2 is far below, leaving a real gap of lines 5-19.
    const { container } = renderCard({
      diff: buildDiff([
        ['@@ -1,2 +1,2 @@', ' one', '-two', '+TWO'],
        ['@@ -3,2 +3,2 @@', ' three', '-four', '+FOUR'],
        ['@@ -20,2 +20,2 @@', ' twenty', '-x', '+X'],
      ]),
    });
    // The only surviving upward control is hunk 2's, reaching back to hunk 1;
    // hunk 0 sits at the top of the file and hunk 1 butts against hunk 0.
    expect(upButtons(container).map((b) => b.getAttribute('title'))).toEqual([
      'Show 10 more lines above',
    ]);
    // Likewise downward: hunk 0 butts against hunk 1, so its control is gone.
    // Hunk 1 can reach down towards hunk 2, and hunk 2 is last, with no known
    // end of file to stop it yet.
    expect(downButtons(container).map((b) => b.getAttribute('title'))).toEqual([
      'Show 10 more lines below',
      'Show 10 more lines below',
    ]);
  });

  it('offers only the lines that actually fit in a short gap', () => {
    const { container } = renderCard({
      diff: buildDiff([
        ['@@ -1,2 +1,2 @@', ' one', '-two', '+TWO'],
        ['@@ -6,2 +6,2 @@', ' six', '-seven', '+SEVEN'],
      ]),
    });
    // Lines 3-5 sit between the hunks: three lines, not the usual ten.
    expect(downButtons(container)[0]).toHaveAttribute('title', 'Show 3 more lines below');
    expect(upButtons(container)[0]).toHaveAttribute('title', 'Show 3 more lines above');
  });

  it('hides the downward control once the file length says the hunk ends it', () => {
    const atEnd = buildDiff([['@@ -20,3 +20,3 @@', ' twenty', '-x', '+X', ' twentytwo']]);
    const { container } = renderCard({ diff: atEnd, fileLineCount: 22 });
    expect(downButtons(container)).toHaveLength(0);

    const { container: withMore } = renderCard({ diff: atEnd, fileLineCount: 30 });
    expect(downButtons(withMore)[0]).toHaveAttribute('title', 'Show 8 more lines below');
  });

  it('keeps offering to expand down while the file length is unknown', () => {
    const { container } = renderCard({
      diff: buildDiff([['@@ -20,3 +20,3 @@', ' twenty', '-x', '+X', ' twentytwo']]),
      fileLineCount: null,
    });
    expect(downButtons(container)[0]).toHaveAttribute('title', 'Show 10 more lines below');
  });

  it('offers no expansion at all in a deleted file', () => {
    const { container } = renderCard({
      file: { ...file, changeType: ChangeType.Deleted, additions: 0, deletions: 3 },
      diff: buildDiff([['@@ -20,3 +20,0 @@', '-twenty', '-x', '-twentytwo']]),
    });
    expect(upButtons(container)).toHaveLength(0);
    expect(downButtons(container)).toHaveLength(0);
  });
});

describe('FileDiffCard expand range', () => {
  // hunkStartLine is one mutable binding reused by every row of the render
  // pass, so a click handler that read it directly saw the *last* hunk's start
  // line - clicking "more lines above" on the first hunk fetched the lines
  // above the last one instead.
  it('expands above the clicked hunk, not the last one in the file', () => {
    const fetchContext = vi.fn<FetchContext>();
    const { container } = renderCard({ diff: twoHunkDiff, fetchContext });

    fireEvent.click(upButtons(container)[0]);

    // Hunk 0 starts at line 10, so the nine lines above it are 1-9.
    expect(fetchContext.mock.calls[0].slice(0, 3)).toEqual([file.path, 1, 9]);
  });

  it('expands above a later hunk only as far as the previous one', () => {
    const fetchContext = vi.fn<FetchContext>();
    const { container } = renderCard({ diff: twoHunkDiff, fetchContext });

    fireEvent.click(upButtons(container)[1]);

    // Hunk 1 starts at line 40; hunk 0 already shows up to line 12.
    expect(fetchContext.mock.calls[0].slice(0, 3)).toEqual([file.path, 30, 39]);
  });

  it('stops an expansion at the next hunk instead of overlapping it', () => {
    const fetchContext = vi.fn<FetchContext>();
    const { container } = renderCard({
      diff: buildDiff([
        ['@@ -1,2 +1,2 @@', ' one', '-two', '+TWO'],
        ['@@ -6,2 +6,2 @@', ' six', '-seven', '+SEVEN'],
      ]),
      fetchContext,
    });

    fireEvent.click(downButtons(container)[0]);

    expect(fetchContext.mock.calls[0].slice(0, 3)).toEqual([file.path, 3, 5]);
  });

  it('stops an expansion at the end of the file', () => {
    const fetchContext = vi.fn<FetchContext>();
    const { container } = renderCard({
      diff: buildDiff([['@@ -20,3 +20,3 @@', ' twenty', '-x', '+X', ' twentytwo']]),
      fileLineCount: 25,
      fetchContext,
    });

    fireEvent.click(downButtons(container)[0]);

    expect(fetchContext.mock.calls[0].slice(0, 3)).toEqual([file.path, 23, 25]);
  });
});

// Drives the downward control the way the page does: each click's requested
// range is answered with only the lines that really exist, appended under the
// same cache key, and the card re-rendered - so the loop terminates only if
// what the control asks for and what it counts as expanded stay in step.
function expandDownToExhaustion(
  diff: string,
  fileLineCount: number,
  hunkIndex: number,
): { requested: Array<[number, number]>; exhausted: boolean } {
  const key = contextCacheKey(null, file.path, hunkIndex, 'down');
  const requested: Array<[number, number]> = [];
  let lines: string[] = [];

  for (let click = 0; click < 60; click++) {
    const fetchContext = vi.fn<FetchContext>();
    const { container, unmount } = renderCard({
      diff,
      fileLineCount,
      fetchContext,
      expandedContext: new Map([[key, lines]]),
    });
    // Clicking every control and picking out the one that reported our key
    // identifies this hunk's button specifically - the buttons carry no hunk
    // marker in the DOM, and "the last one on screen" stops being this hunk's
    // as soon as a later hunk's gap is exhausted.
    const buttons = downButtons(container);
    buttons.forEach((b) => fireEvent.click(b));
    unmount();
    const call = fetchContext.mock.calls.find((c) => c[3] === key);
    if (!call) return { requested, exhausted: true };

    const [, start, end] = call;
    requested.push([start, end]);
    const served: string[] = [];
    for (let n = start; n <= Math.min(end, fileLineCount); n++) served.push(`line ${n}`);
    // A request that lands entirely past the end of the file can never grow
    // the expanded count, so the control would sit there for ever.
    if (served.length === 0) return { requested, exhausted: false };
    lines = [...lines, ...served];
  }
  return { requested, exhausted: false };
}

describe('FileDiffCard expanding down to the end of a file', () => {
  const lastHunk = buildDiff([['@@ -20,3 +20,3 @@ fn', ' twenty', '-x', '+X', ' twentytwo']]);

  it('runs out of lines to offer instead of taking clicks for ever', () => {
    // The hunk covers lines 20-22 of a 40-line file, so lines 23-40 are left.
    const { requested, exhausted } = expandDownToExhaustion(lastHunk, 40, 0);

    expect(exhausted).toBe(true);
    // Ten, then the eight that remain - contiguous from the hunk's own last
    // line, with nothing skipped and nothing asked for twice.
    expect(requested).toEqual([
      [23, 32],
      [33, 40],
    ]);
  });

  it('asks for exactly one range when the gap is smaller than a full step', () => {
    const { requested, exhausted } = expandDownToExhaustion(lastHunk, 25, 0);

    expect(exhausted).toBe(true);
    expect(requested).toEqual([[23, 25]]);
  });

  it('tiles each hunk gap exactly once across a multi-hunk file', () => {
    // Hunks cover 10-12 and 40-42 of a 50-line file, so hunk 0 owns the gap
    // 13-39 (bounded by hunk 1) and hunk 1 owns 43-50 (bounded by the file).
    const first = expandDownToExhaustion(twoHunkDiff, 50, 0);
    expect(first.exhausted).toBe(true);
    expect(first.requested).toEqual([
      [13, 22],
      [23, 32],
      [33, 39],
    ]);

    const second = expandDownToExhaustion(twoHunkDiff, 50, 1);
    expect(second.exhausted).toBe(true);
    expect(second.requested).toEqual([[43, 50]]);
  });

  it('takes no clicks at all when the hunk already ends the file', () => {
    const { requested, exhausted } = expandDownToExhaustion(lastHunk, 22, 0);

    expect(exhausted).toBe(true);
    expect(requested).toEqual([]);
  });
});

describe('FileDiffCard git header noise', () => {
  it("doesn't render a new file's mode line as a diff row", () => {
    const added: FileInfo = {
      path: 'lib/new.ts',
      changeType: ChangeType.Added,
      additions: 1,
      deletions: 0,
    };
    const { container } = renderCard({
      file: added,
      diff:
        [
          'diff --git a/lib/new.ts b/lib/new.ts',
          'new file mode 100644',
          'index 0000000..1111111',
          '--- /dev/null',
          '+++ b/lib/new.ts',
          '@@ -0,0 +1 @@',
          '+export const x = 1;',
        ].join('\n') + '\n',
    });
    expect(container.textContent).not.toContain('new file mode');
    expect(container.textContent).toContain('export const x = 1;');
  });

  it('shows a mode change in the file header', () => {
    const { container } = renderCard({
      diff: buildDiff([]).replace(
        'index 1111111..2222222 100644',
        'old mode 100644\nnew mode 100755',
      ),
    });
    expect(container.querySelector('.file-mode-change')?.textContent).toBe('100644 → 100755');
  });
});

describe('open in editor link', () => {
  const link = (container: HTMLElement) => container.querySelector('a.open-in-editor');

  it('opens the file in VS Code at the first hunk', () => {
    const { container } = renderCard({ repoPath: '/work/repo' });

    const firstHunkStart = diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m)![1];
    expect(link(container)?.getAttribute('href')).toBe(
      `vscode://file/work/repo/lib/total.ts:${firstHunkStart}`,
    );
  });

  it('is hidden when the checkout is gone', () => {
    const { container } = renderCard({ repoPath: null });

    expect(link(container)).toBeNull();
  });

  it('is hidden for a deleted file, which the working tree no longer has', () => {
    const { container } = renderCard({
      repoPath: '/work/repo',
      file: { ...file, changeType: ChangeType.Deleted },
    });

    expect(link(container)).toBeNull();
  });
});
