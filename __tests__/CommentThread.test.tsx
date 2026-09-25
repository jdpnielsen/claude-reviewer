import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { Comment, CommentReply } from '../app/prs/[id]/types';
import CommentThread from '../components/pr/CommentThread';
import { AuthorKind, CommentResolutionMode, CommentTargetType, LineType } from '../lib/enum';

type WriteText = (text: string) => Promise<void>;

function comment(uuid: string): Comment {
  return {
    id: 1,
    uuid,
    file_path: 'a.ts',
    line_number: 1,
    end_line_number: 1,
    commit_sha: null,
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
  };
}

function renderThread(uuid: string) {
  const noop = () => {};
  return render(
    <CommentThread
      item={{ comment: comment(uuid), replies: [] }}
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
    />,
  );
}

describe('CommentThread comment id', () => {
  it('shows the id the CLI uses and copies it', () => {
    const writeText: Mock<WriteText> = vi.fn<WriteText>().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderThread('b24ad24a');
    fireEvent.click(screen.getByTitle('Copy comment ID'));

    expect(screen.getByTitle('Copy comment ID').textContent).toContain('b24ad24a');
    expect(writeText).toHaveBeenCalledWith('b24ad24a');
  });

  it("hides an optimistic comment's temporary id", () => {
    renderThread('temp-1727222400000');
    expect(screen.queryByTitle('Copy comment ID')).toBeNull();
  });
});

describe('CommentThread suggestions in replies', () => {
  const reply = (content: string): CommentReply => ({
    id: 2,
    uuid: 'r1',
    author: 'Claude',
    author_kind: AuthorKind.Agent,
    content,
    created_at: '2026-09-25T00:01:00Z',
  });

  function renderReplying(overrides: Partial<Comment>, onInsert = vi.fn<(c: Comment) => void>()) {
    const noop = () => {};
    render(
      <CommentThread
        item={{ comment: { ...comment('c1'), ...overrides }, replies: [] }}
        editingComment={null}
        setEditingComment={noop}
        editComment={noop}
        resolveComment={noop}
        deleteComment={noop}
        replyingTo="c1"
        setReplyingTo={noop}
        replyContent=""
        setReplyContent={noop}
        addReply={noop}
        insertReplySuggestion={onInsert}
      />,
    );
    return onInsert;
  }

  it('offers Insert suggestion on an added-side line comment', () => {
    const onInsert = renderReplying({});
    fireEvent.click(screen.getByRole('button', { name: 'Insert suggestion' }));
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'c1' }));
  });

  it('offers it on a commit message comment', () => {
    renderReplying({ target_type: CommentTargetType.CommitMessage, file_path: '' });
    expect(screen.getByRole('button', { name: 'Insert suggestion' })).toBeTruthy();
  });

  it('has nothing to suggest against on a removed line', () => {
    renderReplying({ line_type: LineType.Old });
    expect(screen.queryByRole('button', { name: 'Insert suggestion' })).toBeNull();
  });

  it("renders a reply's suggestion as a block, not raw fence text", () => {
    const noop = () => {};
    const { container } = render(
      <CommentThread
        item={{
          comment: comment('c1'),
          replies: [reply('How about this?\n\n```suggestion\nconst total = 2;\n```')],
        }}
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
      />,
    );
    const replyEl = container.querySelector('.comment-reply')!;
    expect(replyEl.querySelector('.reply-content')?.textContent).toBe('How about this?');
    expect(replyEl.querySelector('.suggestion-block')?.textContent).toContain('const total = 2;');
    expect(replyEl.textContent).not.toContain('```');
  });
});
