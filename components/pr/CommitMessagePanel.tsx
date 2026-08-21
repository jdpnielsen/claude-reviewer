'use client';

import { GitCommit, MessageSquarePlus } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import CommentThread from './CommentThread';
import type { CommentWithReplies, CommitInfo, EditingComment } from '@/app/prs/[id]/types';
import { insertSuggestion, parseSuggestion } from '@/lib/suggestions';

interface CommitMessagePanelProps {
  commit: CommitInfo;
  comments: CommentWithReplies[];
  isCommenting: boolean;
  setIsCommenting: Dispatch<SetStateAction<boolean>>;
  openCommitMessageComment: () => void;
  newComment: string;
  setNewComment: Dispatch<SetStateAction<string>>;
  addComment: () => void;
  editingComment: EditingComment | null;
  setEditingComment: Dispatch<SetStateAction<EditingComment | null>>;
  editComment: () => void;
  replyingTo: string | null;
  setReplyingTo: Dispatch<SetStateAction<string | null>>;
  replyContent: string;
  setReplyContent: Dispatch<SetStateAction<string>>;
  addReply: (commentUuid: string) => void;
  resolveComment: (commentUuid: string, resolved: boolean) => void;
  deleteComment: (commentUuid: string, replyCount: number) => void;
}

export default function CommitMessagePanel({
  commit,
  comments,
  isCommenting,
  setIsCommenting,
  openCommitMessageComment,
  newComment,
  setNewComment,
  addComment,
  ...commentThreadProps
}: CommitMessagePanelProps) {
  const fullMessage = commit.body.trim()
    ? `${commit.message}\n\n${commit.body.trim()}`
    : commit.message;
  const canSuggest = parseSuggestion(newComment) === null;

  return (
    <div className="commit-message-panel">
      <div className="commit-message-header">
        <GitCommit size={14} />
        <span className="commit-sha">{commit.shortSha}</span>
        <span className="commit-message-author">{commit.author}</span>
      </div>
      <pre className="commit-message-body">{fullMessage}</pre>

      {comments.map((item) => (
        <CommentThread key={item.comment.uuid} item={item} {...commentThreadProps} />
      ))}

      {isCommenting ? (
        <div className="new-comment-form">
          <textarea
            ref={(el) => el?.focus()}
            placeholder="Comment on this commit message..."
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            rows={3}
          />
          <div className="comment-actions">
            <button onClick={addComment}>Add Comment</button>
            {canSuggest && (
              <button
                className="suggest-change-btn"
                onClick={() =>
                  setNewComment((prev) => insertSuggestion(prev, fullMessage.split('\n')))
                }
              >
                Suggest change
              </button>
            )}
            <button
              className="cancel"
              onClick={() => {
                setIsCommenting(false);
                setNewComment('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="commit-message-comment-btn" onClick={openCommitMessageComment}>
          <MessageSquarePlus size={14} />
          Comment on commit message
        </button>
      )}
    </div>
  );
}
