'use client';

import type { Dispatch, SetStateAction } from 'react';

import type { CommentingAt, LastClickedLine } from '@/app/prs/[id]/types';

interface NewCommentFormProps {
  commentingAt: CommentingAt;
  newComment: string;
  setNewComment: Dispatch<SetStateAction<string>>;
  addComment: () => void;
  setCommentingAt: Dispatch<SetStateAction<CommentingAt | null>>;
  setLastClickedLine: Dispatch<SetStateAction<LastClickedLine | null>>;
}

export default function NewCommentForm({
  commentingAt,
  newComment,
  setNewComment,
  addComment,
  setCommentingAt,
  setLastClickedLine,
}: NewCommentFormProps) {
  return (
    <div className="new-comment-form">
      {commentingAt.startLine !== commentingAt.endLine && (
        <div className="comment-range-label">
          Commenting on lines {commentingAt.startLine}–{commentingAt.endLine}
        </div>
      )}
      <textarea
        ref={(el) => el?.focus()}
        placeholder="Write a comment..."
        value={newComment}
        onChange={(e) => setNewComment(e.target.value)}
        rows={3}
      />
      <div className="comment-actions">
        <button onClick={addComment}>Add Comment</button>
        <button
          className="cancel"
          onClick={() => {
            setCommentingAt(null);
            setLastClickedLine(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
