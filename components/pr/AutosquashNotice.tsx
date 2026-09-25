'use client';

import type { AutosquashView } from '@/app/prs/[id]/types';

interface AutosquashNoticeProps {
  view: AutosquashView;
  // How many commits the PR itself has, to say how many the preview folds.
  originalCount: number;
}

// The standing explanation above the Files tab while the autosquash preview
// is on: what's being shown, and anything about it the reviewer should know
// before trusting it - it couldn't be built, it stops at a conflict, or the
// squashed branch doesn't end where the PR does.
export default function AutosquashNotice({ view, originalCount }: AutosquashNoticeProps) {
  if (view.error !== null) {
    return (
      <div className="autosquash-notice warning">
        Can&apos;t preview the autosquashed history: {view.error}. Showing the branch as it is.
      </div>
    );
  }

  const folded = view.commits.reduce((n, c) => n + c.absorbed.length, 0);
  const unmatched = view.commits.filter((c) => c.unmatchedMarker).length;

  return (
    <>
      <div className="autosquash-notice">
        <span>
          Previewing the branch as <code>git rebase -i --autosquash --keep-base</code> would leave
          it:{' '}
          {`${folded} of the PR's ${originalCount} commits fold into earlier ones. ` +
            'Comments and reviewed marks on a rewritten commit follow it: onto the next ' +
            'preview as the branch changes, and onto the real commit once the author ' +
            'autosquashes.'}
        </span>
        {unmatched > 0 && (
          <span>
            {unmatched === 1
              ? '1 fixup!/amend!/squash! commit matches no earlier commit, so it stays as it is.'
              : `${unmatched} fixup!/amend!/squash! commits match no earlier commit, so they stay as they are.`}
          </span>
        )}
      </div>
      {view.conflict && (
        <div className="autosquash-notice warning">
          <code>{view.conflict.message}</code> ({view.conflict.shortSha}) doesn&apos;t apply cleanly
          once moved - conflicts in {view.conflict.files.join(', ') || 'the tree'}. A real
          autosquash would stop there too; the commits from that point on aren&apos;t shown.
        </div>
      )}
      {!view.conflict && !view.matchesHead && (
        <div className="autosquash-notice warning">
          The squashed branch doesn&apos;t end with the same content as the PR&apos;s head - the
          reordering changed the end result, not just how it&apos;s split into commits.
        </div>
      )}
    </>
  );
}
