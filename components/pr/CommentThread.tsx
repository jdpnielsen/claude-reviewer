'use client';

import type { Dispatch, SetStateAction } from 'react';

import { CodeHighlight } from './CodeBlock';
import type { CommentWithReplies, EditingComment } from '@/app/prs/[id]/types';
import { getLanguage } from '@/app/prs/[id]/utils';
import { AuthorKind } from '@/lib/enum';
import { parseSuggestion } from '@/lib/suggestions';

interface CommentThreadProps {
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
}: CommentThreadProps) {
  const suggestion = parseSuggestion(c.content);

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
          {suggestion ? (
            <>
              {suggestion.prose && <div className="comment-content">{suggestion.prose}</div>}
              <div className="suggestion-block">
                <div className="suggestion-block-label">Suggested change</div>
                <CodeHighlight code={suggestion.lines.join('\n')} language={getLanguage(c.file_path)} />
              </div>
            </>
          ) : (
            <div className="comment-content">{c.content}</div>
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
                  <span className="reply-content">{r.content}</span>
                </div>
              ))}
            </div>
          )}
          {/* Reply form */}
          {replyingTo === c.uuid ? (
            <div className="reply-form">
              <textarea
                ref={(el) => el?.focus()}
                placeholder="Write a reply..."
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={2}
              />
              <div className="comment-actions">
                <button onClick={() => addReply(c.uuid)}>Reply</button>
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
