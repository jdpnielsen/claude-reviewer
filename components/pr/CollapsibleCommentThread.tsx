'use client';

import { CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import CommentThread from './CommentThread';
import type { CommentThreadProps } from './CommentThread';

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

  return (
    <div className="inline-comment-collapsed">
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
