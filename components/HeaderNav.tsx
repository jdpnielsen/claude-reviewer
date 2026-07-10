'use client';

import { GitPullRequest, FolderTree, MessageSquare, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function HeaderNav() {
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/' || pathname.startsWith('/prs');
    }
    if (path === '/browse') {
      return pathname === '/browse';
    }
    if (path === '/settings') {
      return pathname.startsWith('/settings');
    }
    return pathname.startsWith(path);
  };

  return (
    <nav className="header-nav">
      <Link href="/" className={`nav-tab ${isActive('/') ? 'active' : ''}`}>
        <GitPullRequest size={16} />
        PRs
      </Link>
      <Link href="/browse" className={`nav-tab ${isActive('/browse') ? 'active' : ''}`}>
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
      <Link href="/settings" className={`nav-tab ${isActive('/settings') ? 'active' : ''}`}>
        <Settings size={16} />
        Settings
      </Link>
    </nav>
  );
}
