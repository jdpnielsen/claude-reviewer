'use client';

import { CheckCircle, ChevronDown, ChevronRight, File } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import CommentThread from './CommentThread';
import type { CommentWithReplies, EditingComment } from '@/app/prs/[id]/types';

interface ThreadRowProps {
  item: CommentWithReplies;
  isExpanded: boolean;
  onToggle: () => void;
  onJumpToFile: (filePath: string) => void;
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
  isExpanded,
  onToggle,
  onJumpToFile,
  ...commentThreadProps
}: ThreadRowProps) {
  const { comment } = item;

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
            onJumpToFile(comment.file_path);
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
