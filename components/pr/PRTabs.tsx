'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

export type PRViewTab = 'files' | 'conversation' | 'stack';

interface PRTabsProps {
  activeTab: PRViewTab;
  filesHref: string;
  conversationHref: string;
  filesCount: number;
  unresolvedCount: number;
  // Only for a stacked PR: its Stack tab, how many PRs the stack holds and
  // whether any of them needs restacking.
  stackTab?: { href: string; size: number; stale: boolean } | null;
}

export default function PRTabs({
  activeTab,
  filesHref,
  conversationHref,
  filesCount,
  unresolvedCount,
  stackTab,
}: PRTabsProps) {
  return (
    <div className="pr-tabs">
      <Link href={filesHref} className={`pr-tab ${activeTab === 'files' ? 'active' : ''}`}>
        Files changed
        <span className="count">{filesCount}</span>
      </Link>
      <Link
        href={conversationHref}
        className={`pr-tab ${activeTab === 'conversation' ? 'active' : ''}`}
      >
        Conversation
        {unresolvedCount > 0 && <span className="count">{unresolvedCount}</span>}
      </Link>
      {stackTab && (
        <Link
          href={stackTab.href}
          className={`pr-tab ${activeTab === 'stack' ? 'active' : ''}`}
          title={stackTab.stale ? 'A PR in this stack needs restacking' : undefined}
        >
          Stack
          <span className="count">{stackTab.size}</span>
          {stackTab.stale && (
            <AlertTriangle size={14} className="stack-stale-icon" aria-label="Needs restack" />
          )}
        </Link>
      )}
    </div>
  );
}
