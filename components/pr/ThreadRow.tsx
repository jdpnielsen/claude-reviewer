'use client';

import { CheckCircle, ChevronDown, ChevronRight, File, GitCommit, Layers } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import CommentThread from './CommentThread';
import type { CommentWithReplies, CommitInfo, EditingComment } from '@/app/prs/[id]/types';

interface ThreadRowProps {
  item: CommentWithReplies;
  commits: CommitInfo[];
  isExpanded: boolean;
  onToggle: () => void;
  onJumpToFile: (filePath: string, commitSha: string | null) => void;
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

function firstLineOf(content: string) {
  return content.split('\n')[0].slice(0, 120);
}

export default function ThreadRow({
  item,
  commits,
  isExpanded,
  onToggle,
  onJumpToFile,
  ...commentThreadProps
}: ThreadRowProps) {
  const { comment } = item;
  const commitAt = comment.commit_sha ? commits.find((c) => c.sha === comment.commit_sha) : null;

  return (
    <div className={`thread-row ${comment.resolved ? 'resolved' : ''}`}>
      <div
        className="thread-location"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="thread-file">{comment.file_path}</span>
        <span className="thread-line">:{comment.line_number}</span>
        <span
          className="thread-commit-badge"
          title={
            comment.commit_sha
              ? `Commented while viewing ${commitAt?.message ?? comment.commit_sha}`
              : 'Commented while viewing the cumulative diff (all commits)'
          }
        >
          {comment.commit_sha ? <GitCommit size={12} /> : <Layers size={12} />}
          {comment.commit_sha ? (
            <>
              <span className="commit-sha">
                {commitAt?.shortSha ?? comment.commit_sha.slice(0, 7)}
              </span>
              <span className="thread-commit-message">{commitAt?.message ?? 'unknown commit'}</span>
            </>
          ) : (
            'Cumulative diff'
          )}
        </span>
        {Boolean(comment.resolved) && (
          <span className="thread-resolved-badge">
            <CheckCircle size={12} />
            Resolved
          </span>
        )}
        <button
          className="view-file-btn"
          onClick={(e) => {
            e.stopPropagation();
            onJumpToFile(comment.file_path, comment.commit_sha);
          }}
        >
          <File size={14} />
          View in Files
        </button>
      </div>

      {isExpanded ? (
        <CommentThread item={item} {...commentThreadProps} />
      ) : (
        <div className="thread-preview">{firstLineOf(comment.content)}</div>
      )}
    </div>
  );
}
