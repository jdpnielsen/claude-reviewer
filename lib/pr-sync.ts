import { relocateComments } from './comment-relocation';
import { getLatestDiff, updatePRDiff, updatePRStatus, type PullRequest } from './database';
import { PullRequestStatus } from './enum';
import { getRefDiff, resolveRefSha } from './git';

export interface RediffResult {
  revision: number;
  headCommit: string;
  baseCommit: string;
}

// Re-pull a PR's base...head diff into a new snapshot, refresh its commits and
// re-anchor its comments. Leaves the status alone - callers decide. The web
// counterpart of the CLI's `_rediff_pr`.
export function rediffPR(pr: PullRequest): RediffResult {
  const diff = getRefDiff(pr.repo_path, pr.base_ref, pr.head_ref);
  const headCommit = resolveRefSha(pr.repo_path, pr.head_ref);
  const baseCommit = resolveRefSha(pr.repo_path, pr.base_ref);

  const { revision, oldBaseCommit, oldHeadCommit } = updatePRDiff(
    pr.uuid,
    diff,
    headCommit,
    baseCommit,
  );
  relocateComments(pr.uuid, pr.repo_path, oldBaseCommit, oldHeadCommit, baseCommit, headCommit);
  return { revision, headCommit, baseCommit };
}

// Re-diff `pr` and keep its review status only if the diff came out
// unchanged - after a retarget onto the branch its parent merged into, a
// --no-ff merge normally leaves it identical. Returns whether it was reset
// to pending. Mirrors the CLI's `_rediff_keeping_review`.
export function rediffKeepingReview(pr: PullRequest): boolean {
  const before = getLatestDiff(pr.uuid) ?? '';
  rediffPR(pr);
  const after = getLatestDiff(pr.uuid) ?? '';
  // Trailing whitespace is ignored: these diffs keep git's final newline and
  // the CLI's don't, and either side may have taken the last snapshot.
  if (before.trimEnd() === after.trimEnd() || pr.status === PullRequestStatus.Pending) {
    return false;
  }
  updatePRStatus(pr.uuid, PullRequestStatus.Pending);
  return true;
}
