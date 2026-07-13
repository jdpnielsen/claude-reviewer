'use client';

import { MessageSquare } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';

import ThreadRow from './ThreadRow';
import type { Comment, CommentWithReplies, CommitInfo, EditingComment } from '@/app/prs/[id]/types';

interface ConversationTabProps {
  comments: CommentWithReplies[];
  commits: CommitInfo[];
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

function byCreatedAtAsc(a: CommentWithReplies, b: CommentWithReplies) {
  return a.comment.created_at.localeCompare(b.comment.created_at);
}

export default function ConversationTab({
  comments,
  commits,
  onJumpToFile,
  ...commentThreadProps
}: ConversationTabProps) {
  // Threads explicitly toggled away from their default state (expanded if
  // unresolved, collapsed if resolved). Local to this tab - nothing else
  // needs to read it.
  const [toggledThreads, setToggledThreads] = useState<Set<string>>(new Set());

  const isThreadExpanded = (comment: Comment) =>
    comment.resolved ? toggledThreads.has(comment.uuid) : !toggledThreads.has(comment.uuid);

  const toggleThread = (uuid: string) => {
    setToggledThreads((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  const unresolved = comments.filter((c) => !c.comment.resolved).sort(byCreatedAtAsc);
  const resolved = comments.filter((c) => c.comment.resolved).sort(byCreatedAtAsc);

  if (comments.length === 0) {
    return (
      <div className="conversation-tab">
        <div className="no-conversations">
          <MessageSquare size={32} />
          <p>No comments on this PR yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation-tab">
      {unresolved.length > 0 && (
        <div className="thread-group">
          <h3 className="thread-group-heading">Unresolved ({unresolved.length})</h3>
          {unresolved.map((item) => (
            <ThreadRow
              key={item.comment.uuid}
              item={item}
              commits={commits}
              isExpanded={isThreadExpanded(item.comment)}
              onToggle={() => toggleThread(item.comment.uuid)}
              onJumpToFile={onJumpToFile}
              {...commentThreadProps}
            />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="thread-group">
          <h3 className="thread-group-heading">Resolved ({resolved.length})</h3>
          {resolved.map((item) => (
            <ThreadRow
              key={item.comment.uuid}
              item={item}
              commits={commits}
              isExpanded={isThreadExpanded(item.comment)}
              onToggle={() => toggleThread(item.comment.uuid)}
              onJumpToFile={onJumpToFile}
              {...commentThreadProps}
            />
          ))}
        </div>
      )}
    </div>
  );
}
