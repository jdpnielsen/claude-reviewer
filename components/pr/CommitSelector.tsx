'use client';

import { useClickOutside, useHotkeys } from '@mantine/hooks';
import { ChevronDown, ChevronLeft, ChevronRight, GitCommit, Layers } from 'lucide-react';
import { useState } from 'react';

import type { CommitInfo } from '@/app/prs/[id]/types';

interface CommitSelectorProps {
  commits: CommitInfo[];
  selectedCommit: string | null;
  selectCommit: (sha: string | null) => void;
}

export default function CommitSelector({ commits, selectedCommit, selectCommit }: CommitSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  useHotkeys([['Escape', () => setOpen(false)]]);

  if (commits.length === 0) return null;

  // `commits` is oldest-first (see lib/git.ts listCommits) so index order
  // matches authorship order - prev/next just walk the array.
  const selectedIndex = selectedCommit ? commits.findIndex((c) => c.sha === selectedCommit) : -1;
  const current = selectedIndex >= 0 ? commits[selectedIndex] : null;
  const canGoPrev = selectedIndex > 0;
  const canGoNext = selectedIndex >= 0 && selectedIndex < commits.length - 1;

  const goPrev = () => canGoPrev && selectCommit(commits[selectedIndex - 1].sha);
  const goNext = () => canGoNext && selectCommit(commits[selectedIndex + 1].sha);

  return (
    <div className="commit-selector" ref={ref}>
      {current && (
        <button
          className="commit-nav-btn"
          onClick={goPrev}
          disabled={!canGoPrev}
          title="Previous commit"
        >
          <ChevronLeft size={14} />
        </button>
      )}

      <button className="commit-selector-trigger" onClick={() => setOpen((o) => !o)}>
        {current ? (
          <>
            <GitCommit size={14} />
            <span className="commit-selector-label">{current.message}</span>
            <span className="commit-sha">{current.shortSha}</span>
          </>
        ) : (
          <>
            <Layers size={14} />
            <span className="commit-selector-label">All commits ({commits.length})</span>
          </>
        )}
        <ChevronDown size={14} />
      </button>

      {current && (
        <button
          className="commit-nav-btn"
          onClick={goNext}
          disabled={!canGoNext}
          title="Next commit"
        >
          <ChevronRight size={14} />
        </button>
      )}

      {open && (
        <div className="commit-selector-panel">
          <button
            className={`file-item commit-item ${selectedCommit === null ? 'active' : ''}`}
            onClick={() => {
              selectCommit(null);
              setOpen(false);
            }}
          >
            <Layers size={14} />
            <span className="file-name">All commits ({commits.length})</span>
          </button>
          {commits.map((commit) => (
            <button
              key={commit.sha}
              className={`file-item commit-item ${selectedCommit === commit.sha ? 'active' : ''}`}
              onClick={() => {
                selectCommit(commit.sha);
                setOpen(false);
              }}
              title={`${commit.shortSha} by ${commit.author}`}
            >
              <GitCommit size={14} />
              <span className="file-name">{commit.message}</span>
              <span className="commit-sha">{commit.shortSha}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
