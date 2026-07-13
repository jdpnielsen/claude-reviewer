'use client';

import { ArrowLeft, GitPullRequest, Loader2, Maximize2, Minimize2, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import type { PullRequest } from '@/app/prs/[id]/types';

interface PRHeaderProps {
  pr: PullRequest;
  config: { icon: LucideIcon; color: string; label: string };
  requestingAI: boolean;
  showFileControls: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onRequestAIReview: () => void;
}

export default function PRHeader({
  pr,
  config,
  requestingAI,
  showFileControls,
  onExpandAll,
  onCollapseAll,
  onRequestAIReview,
}: PRHeaderProps) {
  const StatusIcon = config.icon;

  return (
    <div className="pr-header">
      <Link href="/" className="back-link">
        <ArrowLeft size={16} />
        Back
      </Link>

      <div className="pr-title-row">
        <GitPullRequest size={24} className="pr-icon" />
        <h1>{pr.title}</h1>
        <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
          {showFileControls && (
            <>
              <button
                onClick={onExpandAll}
                title="Expand All"
                style={{
                  padding: '0.25rem 0.5rem',
                  background: '#21262d',
                  color: '#58a6ff',
                  fontSize: '0.75rem',
                  border: '1px solid #30363d',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <Maximize2 size={12} />
                Expand All
              </button>
              <button
                onClick={onCollapseAll}
                title="Collapse All"
                style={{
                  padding: '0.25rem 0.5rem',
                  background: '#21262d',
                  color: '#8b949e',
                  fontSize: '0.75rem',
                  border: '1px solid #30363d',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <Minimize2 size={12} />
                Collapse All
              </button>
            </>
          )}
          <button
            onClick={onRequestAIReview}
            disabled={requestingAI}
            title="Request AI Review (with full codebase context)"
            style={{
              padding: '0.25rem 0.75rem',
              background: requestingAI ? '#21262d' : '#238636',
              color: '#ffffff',
              fontSize: '0.75rem',
              border: '1px solid #238636',
              borderRadius: '4px',
              cursor: requestingAI ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              opacity: requestingAI ? 0.7 : 1,
            }}
          >
            {requestingAI ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {requestingAI ? 'Reviewing...' : 'AI Review'}
          </button>
        </div>
        <span className="status-badge" style={{ backgroundColor: config.color }}>
          <StatusIcon size={14} />
          {config.label}
        </span>
      </div>

      <div className="pr-meta">
        <span>#{pr.uuid}</span>
        <span className="branch-info">
          {pr.head_ref} → {pr.base_ref}
        </span>
      </div>

      {pr.description && <p className="pr-description">{pr.description}</p>}
    </div>
  );
}
