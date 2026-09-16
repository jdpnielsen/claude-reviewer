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

// One hunk starting at line 20, so there are 19 lines above it to expand into.
const diff = [
  `diff --git a/${file.path} b/${file.path}`,
  'index 1111111..2222222 100644',
  `--- a/${file.path}`,
  `+++ b/${file.path}`,
  '@@ -20,3 +20,3 @@ function total(items) {',
  '   let sum = 0;',
  '-  return items.length;',
  '+  return sum;',
  ' }',
].join('\n');

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
    displayedCommitSha?: string | null;
    expandedContext?: Map<string, string[]>;
    fetchContext?: FetchContext;
  } = {},
) {
  const noop = () => {};
  return render(
    <FileDiffCard
      file={file}
      diff={diff}
      fileComments={[]}
      commitSpecificComments={[]}
      commits={commits}
      displayedCommitSha={overrides.displayedCommitSha ?? null}
      isReviewed={false}
      toggleReviewed={noop}
      onJumpToFile={noop}
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
