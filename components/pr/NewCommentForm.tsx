'use client';

import { useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { CommentingAt, LastClickedLine } from '@/app/prs/[id]/types';
import { LineType } from '@/lib/enum';
import { insertSuggestion } from '@/lib/suggestions';

interface NewCommentFormProps {
  commentingAt: CommentingAt;
  newComment: string;
  setNewComment: Dispatch<SetStateAction<string>>;
  addComment: () => void;
  setCommentingAt: Dispatch<SetStateAction<CommentingAt | null>>;
  setLastClickedLine: Dispatch<SetStateAction<LastClickedLine | null>>;
  seedSuggestionLines: string[];
}

export default function NewCommentForm({
  commentingAt,
  newComment,
  setNewComment,
  addComment,
  setCommentingAt,
  setLastClickedLine,
  seedSuggestionLines,
}: NewCommentFormProps) {
  const hasPairedRange =
    commentingAt.pairedStartLine !== undefined && commentingAt.pairedEndLine !== undefined;
  // A suggestion replaces the current file's content, so it can only ever
  // apply to the added side - for a cross-side (paired) comment that's just
  // its New-side range, exactly what seedSuggestionLines already extracts,
  // so no special-casing is needed there. An Old-side-only comment (a plain
  // removed line, no pairing) has no added side to seed at all.
  const canSuggestLines = commentingAt.lineType !== LineType.Old;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Grows the textarea to fit its content - typed or inserted via "Insert
  // suggestion" alike - instead of leaving a multi-line suggestion scrolled
  // inside a fixed-height box. useLayoutEffect (not useEffect) so the resize
  // happens before paint, with no visible flash at the old height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [newComment]);

  return (
    <div className="new-comment-form">
      {hasPairedRange ? (
        <div className="comment-range-label">
          Commenting on lines {commentingAt.pairedStartLine}–{commentingAt.pairedEndLine} (removed)
          and {commentingAt.startLine}–{commentingAt.endLine} (added)
        </div>
      ) : (
        commentingAt.startLine !== commentingAt.endLine && (
          <div className="comment-range-label">
            Commenting on lines {commentingAt.startLine}–{commentingAt.endLine}
          </div>
        )
      )}
      <textarea
        ref={(el) => {
          textareaRef.current = el;
          el?.focus();
        }}
        placeholder="Write a comment..."
        value={newComment}
        onChange={(e) => setNewComment(e.target.value)}
      />
      <div className="comment-actions">
        <button onClick={addComment}>Add Comment</button>
        {canSuggestLines ? (
          <button
            className="suggest-change-btn"
            onClick={() => setNewComment((prev) => insertSuggestion(prev, seedSuggestionLines))}
          >
            Insert suggestion
          </button>
        ) : (
          // Wrapped in a span rather than putting title directly on the
          // disabled button - disabled elements don't reliably fire the
          // hover needed to show a native tooltip in every browser.
          <span title="Only added lines can have suggestions.">
            <button className="suggest-change-btn" disabled>
              Insert suggestion
            </button>
          </span>
        )}
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
