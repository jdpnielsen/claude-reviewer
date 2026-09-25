'use client';

import { File } from 'lucide-react';
import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';

import type { Comment } from '@/app/prs/[id]/types';
import { commentHref } from '@/app/prs/[id]/utils';

interface CommentLinkProps {
  prId: string;
  comment: Comment;
  // Runs only when the click navigates this tab - a new-tab or new-window
  // click loads the page fresh, which finds the comment from the URL itself.
  onJumpToComment: (comment: Comment) => void;
  children: ReactNode;
}

const isPlainLeftClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export default function CommentLink({
  prId,
  comment,
  onJumpToComment,
  children,
}: CommentLinkProps) {
  return (
    <Link
      href={commentHref(prId, comment.uuid, comment.commit_sha)}
      className="view-file-btn"
      onClick={(e) => {
        // Rendered inside clickable/keyboard-toggled rows (ThreadRow's header).
        e.stopPropagation();
        if (isPlainLeftClick(e)) onJumpToComment(comment);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <File size={14} />
      {children}
    </Link>
  );
}
