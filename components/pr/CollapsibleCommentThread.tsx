'use client';

import { CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';

import CommentThread from './CommentThread';
import type { CommentThreadProps } from './CommentThread';
import { TargetedCommentContext } from './TargetedCommentContext';
import { commentAnchorId } from '@/app/prs/[id]/utils';

function firstLineOf(content: string) {
  return content.split('\n')[0].slice(0, 120);
}

// Wraps CommentThread for the two inline contexts (a diff line, a commit
// message) that render it directly rather than through ConversationTab's own
// ThreadRow. Every comment gets the same toggle affordance ThreadRow already
// has - resolved starts collapsed, unresolved starts expanded - so a long
// active discussion can still be tucked away without losing the ability to
// come back to it, not just resolved ones.
export default function CollapsibleCommentThread({ item, ...rest }: CommentThreadProps) {
  const [toggled, setToggled] = useState(false);
  const { comment } = item;
  const isExpanded = comment.resolved ? toggled : !toggled;
  const isTargeted = useContext(TargetedCommentContext) === comment.uuid;

  // A link to this thread should land on the discussion, not a one-line
  // preview - open it even if it's resolved or was tucked away.
  useEffect(() => {
    if (isTargeted) setToggled(Boolean(comment.resolved));
  }, [isTargeted, comment.resolved]);

  return (
    <div
      id={commentAnchorId(comment.uuid)}
      className={`inline-comment-collapsed ${isTargeted ? 'targeted' : ''}`}
    >
      <button
        type="button"
        className="inline-comment-toggle"
        onClick={() => setToggled((t) => !t)}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {comment.resolved && <CheckCircle size={12} className="inline-comment-toggle-resolved" />}
        <span className="inline-comment-toggle-preview">{firstLineOf(comment.content)}</span>
      </button>
      {isExpanded && <CommentThread item={item} {...rest} />}
    </div>
  );
}
