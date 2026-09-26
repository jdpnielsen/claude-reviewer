import { NextRequest, NextResponse } from 'next/server';

import { getPRByUuid, updatePRBaseRef, updatePRStatus } from '@/lib/database';
import { PullRequestStatus } from '@/lib/enum';
import { GitManager, isRepoAvailable } from '@/lib/git';
import { rediffKeepingReview } from '@/lib/pr-sync';
import { getChildren, getParent, isStale } from '@/lib/stack';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/merge - Merge an approved PR. Stacks merge bottom-up:
// refused while the PR sits on another open PR or while a PR stacked on it
// needs restacking. PRs stacked directly on it are retargeted at its base
// branch after the merge (before any branch delete), as the CLI does.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { push = true, deleteBranch = false } = body;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    if (pr.status !== PullRequestStatus.Approved) {
      return NextResponse.json(
        { error: `PR is not approved (current status: ${pr.status})` },
        { status: 400 },
      );
    }

    // Merging needs the actual checkout; without this the missing cwd would
    // surface as a bare `spawnSync git ENOENT`.
    if (!isRepoAvailable(pr.repo_path)) {
      return NextResponse.json(
        { error: `Repository is no longer available at ${pr.repo_path}` },
        { status: 409 },
      );
    }

    const parent = getParent(pr);
    if (parent) {
      return NextResponse.json(
        { error: `PR is stacked on PR #${parent.uuid} (${parent.head_ref}) - merge that first` },
        { status: 409 },
      );
    }

    const children = getChildren(pr);
    const stale = children.filter((c) => isStale(pr.repo_path, pr.head_ref, c.head_ref));
    if (stale.length > 0) {
      return NextResponse.json(
        {
          error:
            `PR${stale.length > 1 ? 's' : ''} ${stale.map((c) => `#${c.uuid}`).join(', ')} ` +
            `stacked on this one need restacking. Run \`claude-reviewer restack ${id}\` first`,
        },
        { status: 409 },
      );
    }

    const git = new GitManager(pr.repo_path);

    // Check for uncommitted changes
    const isDirty = await git.isDirty();
    if (isDirty) {
      return NextResponse.json(
        { error: 'Repository has uncommitted changes. Commit or stash them first.' },
        { status: 400 },
      );
    }

    // Perform merge
    const mergeResult = await git.merge(pr.head_ref, pr.base_ref);
    if (!mergeResult.success) {
      return NextResponse.json({ error: `Merge failed: ${mergeResult.message}` }, { status: 500 });
    }

    const results: string[] = [mergeResult.message];

    // Push if requested
    if (push) {
      const pushResult = await git.push();
      if (pushResult.success) {
        results.push(pushResult.message);
      } else {
        results.push(`Warning: Push failed: ${pushResult.message}`);
      }
    }

    // Retarget stacked PRs before their old base branch can be deleted.
    for (const child of children) {
      updatePRBaseRef(child.uuid, pr.base_ref);
      const reset = rediffKeepingReview({ ...child, base_ref: pr.base_ref });
      results.push(
        `Retargeted PR #${child.uuid} onto ${pr.base_ref}` +
          (reset ? ' (diff changed - reset to pending)' : ''),
      );
    }

    // Delete source branch if requested
    if (deleteBranch) {
      const deleteResult = await git.deleteBranch(pr.head_ref);
      if (deleteResult.success) {
        results.push(deleteResult.message);
      }
    }

    // Update PR status
    updatePRStatus(id, PullRequestStatus.Merged);

    return NextResponse.json({
      success: true,
      message: results.join('. '),
      status: PullRequestStatus.Merged,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
