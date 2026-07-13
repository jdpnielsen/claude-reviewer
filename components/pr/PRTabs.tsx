'use client';

export type PRViewTab = 'files' | 'conversation';

interface PRTabsProps {
  activeTab: PRViewTab;
  onChange: (tab: PRViewTab) => void;
  filesCount: number;
  unresolvedCount: number;
}

export default function PRTabs({ activeTab, onChange, filesCount, unresolvedCount }: PRTabsProps) {
  return (
    <div className="pr-tabs">
      <button
        className={`pr-tab ${activeTab === 'files' ? 'active' : ''}`}
        onClick={() => onChange('files')}
      >
        Files changed
        <span className="count">{filesCount}</span>
      </button>
      <button
        className={`pr-tab ${activeTab === 'conversation' ? 'active' : ''}`}
        onClick={() => onChange('conversation')}
      >
        Conversation
        {unresolvedCount > 0 && <span className="count">{unresolvedCount}</span>}
      </button>
    </div>
  );
}
