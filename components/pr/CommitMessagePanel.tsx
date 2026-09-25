'use client';

import { Check, GitCommit, MessageSquarePlus } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import CollapsibleCommentThread from './CollapsibleCommentThread';
import ResolutionModeSelect from './ResolutionModeSelect';
import type {
  Comment,
  CommentWithReplies,
  CommitInfo,
  EditingComment,
  ReviewedVia,
} from '@/app/prs/[id]/types';
import { commitFullMessage, submitOnModEnter, VIA_TITLES } from '@/app/prs/[id]/utils';
import CopyableText from '@/components/CopyableText';
import { CommentResolutionMode } from '@/lib/enum';
import type { AbsorbedCommit } from '@/lib/git';
import { insertSuggestion } from '@/lib/suggestions';

interface CommitMessagePanelProps {
  commit: CommitInfo;
  comments: CommentWithReplies[];
  isMessageReviewed: boolean;
  // See ReviewedMark.via.
  messageReviewedVia?: ReviewedVia;
  toggleMessageReviewed: () => void;
  isCommenting: boolean;
  setIsCommenting: Dispatch<SetStateAction<boolean>>;
  openCommitMessageComment: () => void;
  newComment: string;
  setNewComment: Dispatch<SetStateAction<string>>;
  resolutionMode: CommentResolutionMode;
  setResolutionMode: Dispatch<SetStateAction<CommentResolutionMode>>;
  addComment: () => void;
  editingComment: EditingComment | null;
  setEditingComment: Dispatch<SetStateAction<EditingComment | null>>;
  editComment: () => void;
  replyingTo: string | null;
  setReplyingTo: Dispatch<SetStateAction<string | null>>;
  replyContent: string;
  setReplyContent: Dispatch<SetStateAction<string>>;
  addReply: (commentUuid: string) => void;
  insertReplySuggestion: (comment: Comment) => void;
  resolveComment: (commentUuid: string, resolved: boolean) => void;
  deleteComment: (commentUuid: string, replyCount: number) => void;
  // For a commit in the autosquash preview: the commits folded into it, and
  // whether git would stop to have this message edited (see SquashedCommit).
  absorbed?: AbsorbedCommit[];
  messageNeedsEdit?: boolean;
}

export default function CommitMessagePanel({
  commit,
  comments,
  isMessageReviewed,
  messageReviewedVia,
  toggleMessageReviewed,
  isCommenting,
  setIsCommenting,
  openCommitMessageComment,
  newComment,
  setNewComment,
  resolutionMode,
  setResolutionMode,
  addComment,
  absorbed = [],
  messageNeedsEdit = false,
  ...commentThreadProps
}: CommitMessagePanelProps) {
  const fullMessage = commitFullMessage(commit);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // See NewCommentForm's identical effect - grows the box to fit its
  // content instead of leaving an inserted suggestion scrolled inside a
  // fixed-height box.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [newComment]);

  return (
    <div className="commit-message-panel">
      <div className="commit-message-header">
        <div className="commit-message-meta">
          <GitCommit size={14} />
          <CopyableText text={commit.sha} className="commit-sha" title="Copy full SHA">
            {commit.shortSha}
          </CopyableText>
          <span>{commit.author}</span>
        </div>
        <button
          type="button"
          className={`reviewed-toggle ${isMessageReviewed ? 'active' : ''}`}
          onClick={toggleMessageReviewed}
          title={
            isMessageReviewed
              ? messageReviewedVia
                ? `${VIA_TITLES[messageReviewedVia]} - unmarking unmarks it there too`
                : 'Marked reviewed - this commit message, on its own'
              : "Mark this commit's message reviewed, without its files"
          }
        >
          <Check size={14} />
          {isMessageReviewed
            ? messageReviewedVia
              ? `Message reviewed (via ${messageReviewedVia})`
              : 'Message reviewed'
            : 'Mark message reviewed'}
        </button>
      </div>
      <pre className="commit-message-body">{fullMessage}</pre>

      {absorbed.length > 0 && (
        <div className="commit-absorbed">
          Folds in:
          <ul>
            {absorbed.map((a) => (
              <li key={a.sha}>
                <code>{a.kind}</code>
                <span className="commit-sha">{a.shortSha}</span>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
          {messageNeedsEdit && (
            <p>
              A squash! is folded in, so git would stop here for the message to be edited -
              it&apos;s shown as it would be saved unchanged.
            </p>
          )}
        </div>
      )}

      {comments.map((item) => (
        <CollapsibleCommentThread key={item.comment.uuid} item={item} {...commentThreadProps} />
      ))}

      {isCommenting ? (
        <div className="new-comment-form">
          <textarea
            ref={(el) => {
              textareaRef.current = el;
              el?.focus();
            }}
            placeholder="Comment on this commit message..."
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={submitOnModEnter(addComment)}
          />
          <div className="comment-actions">
            <button onClick={addComment}>Add Comment</button>
            <ResolutionModeSelect value={resolutionMode} onChange={setResolutionMode} />
            <button
              className="suggest-change-btn"
              onClick={() =>
                setNewComment((prev) => insertSuggestion(prev, fullMessage.split('\n')))
              }
            >
              Insert suggestion
            </button>
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
