'use client';

import { ConversationStatus } from '@/lib/enum';

interface ConversationsHeaderProps {
  repoPath: string;
  filter: ConversationStatus | 'all';
  conversationsCount: number;
  onChangeRepo: () => void;
  onFilterChange: (filter: ConversationStatus | 'all') => void;
}

export default function ConversationsHeader({
  repoPath,
  filter,
  conversationsCount,
  onChangeRepo,
  onFilterChange,
}: ConversationsHeaderProps) {
  return (
    <div className="conversations-header">
      <div className="header-left">
        <h1>Conversations</h1>
        <span className="repo-name">{repoPath.split('/').pop()}</span>
        <button className="change-repo-btn" onClick={onChangeRepo}>
          Change
        </button>
      </div>
      <div className="filter-tabs">
        {(['all', ...Object.values(ConversationStatus)] as const).map((f) => (
          <button
            key={f}
            className={`filter-tab ${filter === f ? 'active' : ''}`}
            onClick={() => onFilterChange(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f === 'all' && conversationsCount > 0 && (
              <span className="count">{conversationsCount}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
