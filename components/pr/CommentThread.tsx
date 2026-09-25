'use client';

import { useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import AuthorBadge from './AuthorBadge';
import { CodeHighlight } from './CodeBlock';
import { RESOLUTION_MODE_LABELS } from './ResolutionModeSelect';
import type { Comment, CommentWithReplies, EditingComment } from '@/app/prs/[id]/types';
import { canSuggestOn, getLanguage, submitOnModEnter } from '@/app/prs/[id]/utils';
import CopyableText from '@/components/CopyableText';
import { AuthorKind, CommentResolutionMode } from '@/lib/enum';
import { parseComment } from '@/lib/suggestions';

export interface CommentThreadProps {
  item: CommentWithReplies;
  editingComment: EditingComment | null;
  setEditingComment: Dispatch<SetStateAction<EditingComment | null>>;
  editComment: () => void;
  resolveComment: (commentUuid: string, resolved: boolean) => void;
  deleteComment: (commentUuid: string, replyCount: number) => void;
  replyingTo: string | null;
  setReplyingTo: Dispatch<SetStateAction<string | null>>;
  replyContent: string;
  setReplyContent: Dispatch<SetStateAction<string>>;
  addReply: (commentUuid: string) => void;
  insertReplySuggestion: (comment: Comment) => void;
}

function SuggestionBlock({ lines, filePath }: { lines: string[]; filePath: string }) {
  return (
    <div className="suggestion-block">
      <div className="suggestion-block-label">Suggested change</div>
      <CodeHighlight code={lines.join('\n')} language={getLanguage(filePath)} />
    </div>
  );
}

export default function CommentThread({
  item: { comment: c, replies },
  editingComment,
  setEditingComment,
  editComment,
  resolveComment,
  deleteComment,
  replyingTo,
  setReplyingTo,
  replyContent,
  setReplyContent,
  addReply,
  insertReplySuggestion,
}: CommentThreadProps) {
  const segments = parseComment(c.content);
  const isReplying = replyingTo === c.uuid;

  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  // See NewCommentForm's identical effect - grows the reply box to fit an
  // inserted suggestion instead of scrolling it inside two rows.
  useLayoutEffect(() => {
    const el = replyRef.current;
    if (!isReplying || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [isReplying, replyContent]);

  return (
    <div className={`inline-comment ${c.resolved ? 'resolved' : ''}`}>
      {editingComment?.uuid === c.uuid ? (
        <div className="edit-comment-form">
          <textarea
            ref={(el) => el?.focus()}
            value={editingComment.content}
            onChange={(e) =>
              setEditingComment({
                ...editingComment,
                content: e.target.value,
              })
            }
            onKeyDown={submitOnModEnter(editComment)}
            rows={3}
          />
          <div className="comment-actions">
            <button onClick={editComment}>Save</button>
            <button className="cancel" onClick={() => setEditingComment(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {c.author_kind === AuthorKind.Agent && (
            <div className="comment-author">
              <AuthorBadge comment={c} />
            </div>
          )}
          {c.resolution_mode !== CommentResolutionMode.Fix && (
            <div className={`resolution-mode-badge resolution-mode-${c.resolution_mode}`}>
              {RESOLUTION_MODE_LABELS[c.resolution_mode]}
            </div>
          )}
          {segments.map((segment, i) =>
            segment.type === 'prose' ? (
              <div key={i} className="comment-content">
                {segment.text}
              </div>
            ) : (
              <SuggestionBlock key={i} lines={segment.lines} filePath={c.file_path} />
            ),
          )}
          <div className="comment-buttons">
            {replies.length === 0 && (
              <button
                className="edit-btn"
                onClick={() =>
                  setEditingComment({
                    uuid: c.uuid,
                    content: c.content,
                  })
                }
              >
                Edit
              </button>
            )}
            <button className="resolve-btn" onClick={() => resolveComment(c.uuid, !c.resolved)}>
              {c.resolved ? 'Unresolve' : 'Resolve'}
            </button>
            <button className="delete-btn" onClick={() => deleteComment(c.uuid, replies.length)}>
              Delete
            </button>
            {/* The id `claude-reviewer comments` prints, so the reviewer can
                point Claude at this thread without quoting it. An optimistic
                comment's temporary id means nothing to the CLI yet. */}
            {!c.uuid.startsWith('temp-') && (
              <CopyableText text={c.uuid} className="comment-id" title="Copy comment ID">
                {c.uuid}
              </CopyableText>
            )}
          </div>
          {/* Replies */}
          {replies.length > 0 && (
            <div className="comment-replies">
              {replies.map((r) => (
                <div
                  key={r.uuid}
                  className={`comment-reply ${r.author_kind === AuthorKind.Agent ? 'reply-claude' : 'reply-human'}`}
                >
                  <span className="reply-author">{r.author}:</span>
                  {/* A reply can carry a suggestion too - usually a revised
                      take on one earlier in the thread. */}
                  {parseComment(r.content).map((segment, i) =>
                    segment.type === 'prose' ? (
                      <span key={i} className="reply-content">
                        {segment.text}
                      </span>
                    ) : (
                      <SuggestionBlock key={i} lines={segment.lines} filePath={c.file_path} />
                    ),
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Reply form */}
          {isReplying ? (
            <div className="reply-form">
              <textarea
                ref={(el) => {
                  replyRef.current = el;
                  el?.focus();
                }}
                placeholder="Write a reply..."
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                onKeyDown={submitOnModEnter(() => addReply(c.uuid))}
                rows={2}
              />
              <div className="comment-actions">
                <button onClick={() => addReply(c.uuid)}>Reply</button>
                {canSuggestOn(c) && (
                  <button className="suggest-change-btn" onClick={() => insertReplySuggestion(c)}>
                    Insert suggestion
                  </button>
                )}
                <button
                  className="cancel"
                  onClick={() => {
                    setReplyingTo(null);
                    setReplyContent('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="reply-btn" onClick={() => setReplyingTo(c.uuid)}>
              Reply
            </button>
          )}
        </>
      )}
    </div>
  );
}
