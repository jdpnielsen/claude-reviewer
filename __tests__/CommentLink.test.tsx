import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Comment, CommentWithReplies } from '../app/prs/[id]/types';
import CollapsibleCommentThread from '../components/pr/CollapsibleCommentThread';
import CommentLink from '../components/pr/CommentLink';
import { TargetedCommentContext } from '../components/pr/TargetedCommentContext';
import { AuthorKind, CommentResolutionMode, CommentTargetType, LineType } from '../lib/enum';

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    uuid: 'c1',
    file_path: 'a.ts',
    line_number: 1,
    end_line_number: 1,
    commit_sha: 'abc123',
    target_type: CommentTargetType.Line,
    line_type: LineType.New,
    content: 'rename this',
    resolved: false,
    resolution_mode: CommentResolutionMode.Fix,
    review_action: null,
    created_at: '2026-09-25T00:00:00Z',
    paired_line_number: null,
    paired_end_line_number: null,
    anchor_content: null,
    anchor_context_before: null,
    anchor_context_after: null,
    author: null,
    author_kind: AuthorKind.Human,
    ...overrides,
  };
}

describe('CommentLink', () => {
  // Stops jsdom/Next from attempting the navigation itself.
  const preventNavigation = (e: Event) => e.preventDefault();

  it("is a real link to the comment's commit and thread", () => {
    render(
      <CommentLink prId="pr1" comment={comment()} onJumpToComment={() => {}}>
        View in Files
      </CommentLink>,
    );
    expect(screen.getByRole('link', { name: 'View in Files' }).getAttribute('href')).toBe(
      '/prs/pr1?commit=abc123#comment-c1',
    );
  });

  it('jumps in-page on a plain click, but leaves a new-tab click to the browser', () => {
    const onJumpToComment = vi.fn<(comment: Comment) => void>();
    render(
      <CommentLink prId="pr1" comment={comment()} onJumpToComment={onJumpToComment}>
        View in Files
      </CommentLink>,
    );
    const link = screen.getByRole('link');
    link.addEventListener('click', preventNavigation);

    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    expect(onJumpToComment).not.toHaveBeenCalled();

    fireEvent.click(link);
    expect(onJumpToComment).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'c1' }));
  });
});

describe('CollapsibleCommentThread as a link target', () => {
  const noop = () => {};
  const renderThread = (item: CommentWithReplies, targeted: string | null) =>
    render(
      <TargetedCommentContext value={targeted}>
        <CollapsibleCommentThread
          item={item}
          editingComment={null}
          setEditingComment={noop}
          editComment={noop}
          resolveComment={noop}
          deleteComment={noop}
          replyingTo={null}
          setReplyingTo={noop}
          replyContent=""
          setReplyContent={noop}
          addReply={noop}
          insertReplySuggestion={noop}
        />
      </TargetedCommentContext>,
    );

  it('carries the id the link names', () => {
    const { container } = renderThread({ comment: comment(), replies: [] }, null);
    expect(container.querySelector('#comment-c1')).not.toBeNull();
  });

  it('opens a resolved thread when a link points at it', () => {
    const item = { comment: comment({ resolved: true }), replies: [] };
    const { container } = renderThread(item, 'c1');
    expect(container.querySelector('.inline-comment')).not.toBeNull();
    expect(container.querySelector('#comment-c1')?.classList).toContain('targeted');
  });

  it('leaves other resolved threads collapsed', () => {
    const item = { comment: comment({ resolved: true }), replies: [] };
    const { container } = renderThread(item, 'other');
    expect(container.querySelector('.inline-comment')).toBeNull();
  });
});
