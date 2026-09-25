import { Bot } from 'lucide-react';

import type { Comment } from '@/app/prs/[id]/types';
import { AuthorKind } from '@/lib/enum';

// Marks a comment an agent wrote (an AI review, or `claude-reviewer
// comment`), so it isn't mistaken for the reviewer's own. Renders nothing for
// a human's comment - that's the default, and labelling every one would be noise.
export default function AuthorBadge({
  comment,
}: {
  comment: Pick<Comment, 'author' | 'author_kind'>;
}) {
  if (comment.author_kind !== AuthorKind.Agent) return null;
  return (
    <span className="author-badge" title="Written by an AI agent">
      <Bot size={12} />
      {comment.author ?? 'AI'} · AI review
    </span>
  );
}
