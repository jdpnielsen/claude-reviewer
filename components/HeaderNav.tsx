'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GitPullRequest, FolderTree, MessageSquare } from 'lucide-react';

export function HeaderNav() {
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/' || pathname.startsWith('/prs');
    }
    if (path === '/browse') {
      return pathname === '/browse';
    }
    return pathname.startsWith(path);
  };

  return (
    <nav className="header-nav">
      <Link
        href="/"
        className={`nav-tab ${isActive('/') ? 'active' : ''}`}
      >
        <GitPullRequest size={16} />
        PRs
      </Link>
      <Link
        href="/browse"
        className={`nav-tab ${isActive('/browse') ? 'active' : ''}`}
      >
        <FolderTree size={16} />
        Browse
      </Link>
      <Link
        href="/browse/conversations"
        className={`nav-tab ${isActive('/browse/conversations') ? 'active' : ''}`}
      >
        <MessageSquare size={16} />
        Conversations
      </Link>
    </nav>
  );
}
