'use client';

import { useClickOutside, useHotkeys } from '@mantine/hooks';
import { ChevronDown, ChevronLeft, ChevronRight, GitCommit, Layers } from 'lucide-react';
import { useState } from 'react';

import type { CommitInfo } from '@/app/prs/[id]/types';
import type { AbsorbedCommit } from '@/lib/git';

// Green tint for a commit's icon once every file it touches has a current
// reviewed mark (see reviewedCommits on PRData / the GET /api/prs/[id]
// route) - the same color the file-level "Reviewed" badge uses.
const REVIEWED_COLOR = '#3fb950';
// Amber once the review has started on it - a file or the message marked,
// or a comment made - but it isn't reviewed in full.
const PARTIALLY_REVIEWED_COLOR = '#d29922';

interface CommitSelectorProps {
  // `absorbed` is set on the autosquash preview's commits - the ones folded
  // into each, counted on its row.
  commits: (CommitInfo & { absorbed?: AbsorbedCommit[] })[];
  selectedCommit: string | null;
  selectCommit: (sha: string | null) => void;
  reviewedCommits: string[];
  partiallyReviewedCommits: string[];
}

export default function CommitSelector({
  commits,
  selectedCommit,
  selectCommit,
  reviewedCommits,
  partiallyReviewedCommits,
}: CommitSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  useHotkeys([['Escape', () => setOpen(false)]]);

  if (commits.length === 0) return null;

  // `commits` is oldest-first (see lib/git.ts listCommits) so index order
  // matches authorship order - prev/next just walk the array.
  // A one-commit PR has no real "All commits" view distinct from that
  // commit's own diff (see page.tsx's soleCommit) - so it's treated as
  // selected here too, even before the user has ever picked it explicitly.
  const selectedIndex = selectedCommit
    ? commits.findIndex((c) => c.sha === selectedCommit)
    : commits.length === 1
      ? 0
      : -1;
  const current = selectedIndex >= 0 ? commits[selectedIndex] : null;
  const canGoPrev = selectedIndex > 0;
  const canGoNext = selectedIndex >= 0 && selectedIndex < commits.length - 1;

  const reviewColor = (sha: string) =>
    reviewedCommits.includes(sha)
      ? REVIEWED_COLOR
      : partiallyReviewedCommits.includes(sha)
        ? PARTIALLY_REVIEWED_COLOR
        : undefined;
  const reviewTitle = (sha: string) =>
    reviewedCommits.includes(sha)
      ? ' - reviewed'
      : partiallyReviewedCommits.includes(sha)
        ? ' - partially reviewed'
        : '';

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
            <GitCommit size={14} color={reviewColor(current.sha)} />
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
          {commits.length > 1 && (
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
          )}
          {commits.map((commit) => (
            <button
              key={commit.sha}
              className={`file-item commit-item ${current?.sha === commit.sha ? 'active' : ''}`}
              onClick={() => {
                selectCommit(commit.sha);
                setOpen(false);
              }}
              title={`${commit.shortSha} by ${commit.author}${reviewTitle(commit.sha)}`}
            >
              <GitCommit size={14} color={reviewColor(commit.sha)} />
              <span className="file-name">{commit.message}</span>
              {commit.absorbed && commit.absorbed.length > 0 && (
                <span
                  className="commit-absorbed-badge"
                  title={`Folds in:\n${commit.absorbed.map((a) => a.message).join('\n')}`}
                >
                  +{commit.absorbed.length}
                </span>
              )}
              <span className="commit-sha">{commit.shortSha}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
