'use client';

import Link from 'next/link';

export type PRViewTab = 'files' | 'conversation';

interface PRTabsProps {
  activeTab: PRViewTab;
  filesHref: string;
  conversationHref: string;
  filesCount: number;
  unresolvedCount: number;
}

export default function PRTabs({
  activeTab,
  filesHref,
  conversationHref,
  filesCount,
  unresolvedCount,
}: PRTabsProps) {
  return (
    <div className="pr-tabs">
      <Link
        href={filesHref}
        replace
        className={`pr-tab ${activeTab === 'files' ? 'active' : ''}`}
      >
        Files changed
        <span className="count">{filesCount}</span>
      </Link>
      <Link
        href={conversationHref}
        replace
        className={`pr-tab ${activeTab === 'conversation' ? 'active' : ''}`}
      >
        Conversation
        {unresolvedCount > 0 && <span className="count">{unresolvedCount}</span>}
      </Link>
    </div>
  );
}
