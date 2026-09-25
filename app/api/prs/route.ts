import { NextRequest, NextResponse } from 'next/server';

import {
  listPRs,
  createPR,
  getPRByUuid,
  getUnresolvedCommentCounts,
  toPublicPR,
} from '@/lib/database';
import type { PullRequest } from '@/lib/database';
import { GitManager, countCommits, isRepoAvailable } from '@/lib/git';

// null when it can't be answered - the checkout is gone, or a commit the PR
// was stored against no longer exists in it - so the list shows nothing
// rather than a wrong number, and one broken PR can't fail the whole listing.
function commitCountOrNull(pr: PullRequest): number | null {
  if (!isRepoAvailable(pr.repo_path)) return null;
  try {
    return countCommits(pr.repo_path, pr.base_commit, pr.head_commit);
  } catch {
    return null;
  }
}

// GET /api/prs - List all PRs
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const repoPath = searchParams.get('repo') || undefined;
    const status = searchParams.get('status') || undefined;
    const excludeClosed = searchParams.get('excludeClosed') === 'true';
    const limitStr = searchParams.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    const prs = listPRs({ repoPath, status, limit, excludeClosed });

    const unresolved = getUnresolvedCommentCounts(prs.map((pr) => pr.id));

    return NextResponse.json({
      prs: prs.map((pr) => ({
        ...toPublicPR(pr),
        commit_count: commitCountOrNull(pr),
        unresolved_count: unresolved.get(pr.id) ?? 0,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/prs - Create a new PR
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { repoPath, title, description, baseRef, headRef } = body;

    if (!repoPath || !title || !baseRef || !headRef) {
      return NextResponse.json(
        { error: 'Missing required fields: repoPath, title, baseRef, headRef' },
        { status: 400 },
      );
    }

    // Get git info
    const git = new GitManager(repoPath);
    const baseCommit = await git.getCommitSha(baseRef);
    const headCommit = await git.getCommitSha(headRef);
    const diff = await git.getDiff(baseRef, headRef);

    // Create PR in database
    const uuid = createPR(
      repoPath,
      title,
      baseRef,
      headRef,
      baseCommit,
      headCommit,
      diff,
      description || '',
    );

    const pr = getPRByUuid(uuid);

    return NextResponse.json(
      {
        uuid,
        pr: pr ? toPublicPR(pr) : pr,
        reviewUrl: `/prs/${uuid}`,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
