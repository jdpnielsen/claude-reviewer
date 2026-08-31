'use client';

import {
  ArrowLeft,
  GitPullRequest,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import type { PullRequest } from '@/app/prs/[id]/types';
import { PullRequestStatus } from '@/lib/enum';

interface PRHeaderProps {
  pr: PullRequest;
  config: { icon: LucideIcon; color: string; label: string };
  requestingAI: boolean;
  statusChanging: boolean;
  syncing: boolean;
  // False when the PR's checkout is gone - Sync and AI Review both shell out
  // to git in it, so they're disabled rather than left to fail.
  repoAvailable: boolean;
  onRequestAIReview: () => void;
  onClose: () => void;
  onReopen: () => void;
  onSync: () => void;
}

export default function PRHeader({
  pr,
  config,
  requestingAI,
  statusChanging,
  syncing,
  repoAvailable,
  onRequestAIReview,
  onClose,
  onReopen,
  onSync,
}: PRHeaderProps) {
  const StatusIcon = config.icon;
  const repoGoneTitle = "This PR's repository path no longer exists";

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
          {pr.status !== PullRequestStatus.Merged &&
            (pr.status === PullRequestStatus.Closed ? (
              <button
                onClick={onReopen}
                disabled={statusChanging}
                title="Reopen this PR for review"
                style={{
                  padding: '0.25rem 0.75rem',
                  background: '#21262d',
                  color: '#3fb950',
                  fontSize: '0.75rem',
                  border: '1px solid #30363d',
                  borderRadius: '4px',
                  cursor: statusChanging ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  opacity: statusChanging ? 0.7 : 1,
                }}
              >
                {statusChanging ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Reopen
              </button>
            ) : (
              <>
                <button
                  onClick={onSync}
                  disabled={syncing || !repoAvailable}
                  title={
                    repoAvailable
                      ? 'Re-pull the branch diff (new commits, amend, rebase) and reset to pending for re-review'
                      : `Can't sync - ${repoGoneTitle}`
                  }
                  style={{
                    padding: '0.25rem 0.75rem',
                    background: '#21262d',
                    color: '#58a6ff',
                    fontSize: '0.75rem',
                    border: '1px solid #30363d',
                    borderRadius: '4px',
                    cursor: syncing ? 'wait' : repoAvailable ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    opacity: syncing || !repoAvailable ? 0.7 : 1,
                  }}
                >
                  {syncing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  {syncing ? 'Syncing...' : 'Sync'}
                </button>
                <button
                  onClick={onClose}
                  disabled={statusChanging}
                  title="Close this PR without merging"
                  style={{
                    padding: '0.25rem 0.75rem',
                    background: '#21262d',
                    color: '#f85149',
                    fontSize: '0.75rem',
                    border: '1px solid #30363d',
                    borderRadius: '4px',
                    cursor: statusChanging ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    opacity: statusChanging ? 0.7 : 1,
                  }}
                >
                  {statusChanging ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <XCircle size={12} />
                  )}
                  Close
                </button>
              </>
            ))}
          <button
            onClick={onRequestAIReview}
            disabled={requestingAI || !repoAvailable}
            title={
              repoAvailable
                ? 'Request AI Review (with full codebase context)'
                : `Can't review - ${repoGoneTitle}`
            }
            style={{
              padding: '0.25rem 0.75rem',
              background: requestingAI || !repoAvailable ? '#21262d' : '#238636',
              color: '#ffffff',
              fontSize: '0.75rem',
              border: '1px solid #238636',
              borderRadius: '4px',
              cursor: requestingAI ? 'wait' : repoAvailable ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              opacity: requestingAI || !repoAvailable ? 0.7 : 1,
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
