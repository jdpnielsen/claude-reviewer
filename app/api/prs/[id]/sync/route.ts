import { NextRequest, NextResponse } from 'next/server';

import { relocateComments } from '@/lib/comment-relocation';
import { getPRByUuid, updatePRDiff, updatePRStatus } from '@/lib/database';
import { PullRequestStatus } from '@/lib/enum';
import { getRefDiff, isRepoAvailable, resolveRefSha } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/sync - Re-pull the branch diff after the head or base
// branch changed (new commits, amend, rebase, or the base branch advancing).
// Web-UI equivalent of the CLI's `claude-reviewer update`: append a fresh diff
// snapshot, refresh head_commit and base_commit, and reset status to pending
// for re-review.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    // A merged PR is terminal - its history is already merged, so there is
    // nothing to re-sync into. (Matches the PATCH status guard.)
    if (pr.status === PullRequestStatus.Merged) {
      return NextResponse.json({ error: 'Cannot sync a merged PR' }, { status: 409 });
    }

    // There is nothing to re-pull from a checkout that isn't there any more.
    // Caught up front so the caller gets this instead of the bare
    // `spawnSync git ENOENT` a missing cwd would otherwise produce.
    if (!isRepoAvailable(pr.repo_path)) {
      return NextResponse.json(
        { error: `Repository is no longer available at ${pr.repo_path}` },
        { status: 409 },
      );
    }

    const diff = getRefDiff(pr.repo_path, pr.base_ref, pr.head_ref);
    const headCommit = resolveRefSha(pr.repo_path, pr.head_ref);
    const baseCommit = resolveRefSha(pr.repo_path, pr.base_ref);

    const { revision, oldBaseCommit, oldHeadCommit } = updatePRDiff(
      id,
      diff,
      headCommit,
      baseCommit,
    );
    relocateComments(id, pr.repo_path, oldBaseCommit, oldHeadCommit, baseCommit, headCommit);
    updatePRStatus(id, PullRequestStatus.Pending);

    return NextResponse.json({
      success: true,
      revision,
      headCommit,
      status: PullRequestStatus.Pending,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
