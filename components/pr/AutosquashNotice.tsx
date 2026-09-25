'use client';

import type { AutosquashView } from '@/app/prs/[id]/types';

interface AutosquashNoticeProps {
  view: AutosquashView;
}

// The autosquash preview button's tooltip: what the preview is, and - while
// it's on (`view` set) - how much of the branch it folds, out of the PR's
// `originalCount` commits.
export function autosquashTooltip(view: AutosquashView | null, originalCount: number): string {
  const about =
    'Comments and reviewed marks on a rewritten commit follow it: onto the next preview as ' +
    'the branch changes, and onto the real commit once the author autosquashes. A reviewed ' +
    'mark there also counts for the commits folded in, and theirs for the squashed commit.';
  const back = 'Click to go back to the branch as it is.';
  if (!view || view.error !== null) {
    const intro =
      'Preview the branch with its fixup!/amend!/squash! commits folded in, as ' +
      'git rebase -i --autosquash --keep-base would leave it.';
    return view ? `${intro}\n\n${about}\n\n${back}` : `${intro}\n\n${about}`;
  }
  const folded = view.commits.reduce((n, c) => n + c.absorbed.length, 0);
  return (
    'Previewing the branch as git rebase -i --autosquash --keep-base would leave it: ' +
    `${folded} of the PR's ${originalCount} commits fold into earlier ones.\n\n${about}\n\n${back}`
  );
}

// Above the Files tab while the autosquash preview is on: anything about it
// the reviewer should know before trusting it - it couldn't be built, a
// marker matched nothing, it stops at a conflict, or the squashed branch
// doesn't end where the PR does. What the preview is lives in the button's
// tooltip (autosquashTooltip) instead of taking up room here.
export default function AutosquashNotice({ view }: AutosquashNoticeProps) {
  if (view.error !== null) {
    return (
      <div className="autosquash-notice">
        Can&apos;t preview the autosquashed history: {view.error}. Showing the branch as it is.
      </div>
    );
  }

  const unmatched = view.commits.filter((c) => c.unmatchedMarker).length;

  return (
    <>
      {unmatched > 0 && (
        <div className="autosquash-notice">
          {unmatched === 1
            ? '1 fixup!/amend!/squash! commit matches no earlier commit, so it stays as it is.'
            : `${unmatched} fixup!/amend!/squash! commits match no earlier commit, so they stay as they are.`}
        </div>
      )}
      {view.conflict && (
        <div className="autosquash-notice">
          <code>{view.conflict.message}</code> ({view.conflict.shortSha}) doesn&apos;t apply cleanly
          once moved - conflicts in {view.conflict.files.join(', ') || 'the tree'}. A real
          autosquash would stop there too; the commits from that point on aren&apos;t shown.
        </div>
      )}
      {!view.conflict && !view.matchesHead && (
        <div className="autosquash-notice">
          The squashed branch doesn&apos;t end with the same content as the PR&apos;s head - the
          reordering changed the end result, not just how it&apos;s split into commits.
        </div>
      )}
    </>
  );
}
