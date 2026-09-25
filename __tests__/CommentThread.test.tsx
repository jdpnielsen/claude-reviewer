import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { Comment } from '../app/prs/[id]/types';
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
