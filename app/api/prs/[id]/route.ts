import { NextRequest, NextResponse } from 'next/server';

import {
  deletePR,
  getPRByUuid,
  getLatestDiff,
  updatePRStatus,
  getCommentsWithReplies,
  getReviewedFiles,
  lookupCommitRelocation,
  toPublicPR,
} from '@/lib/database';
import { parseDiffFiles } from '@/lib/diff';
import { PullRequestStatus } from '@/lib/enum';
import { listCommits, getCommitDiff, getBlobHash, isRepoAvailable } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/prs/[id] - Get PR details
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const pr = getPRByUuid(id);

    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    // Every git-backed part of this response needs the PR's checkout to still
    // be there. When it isn't (throwaway worktree removed, clone moved), serve
    // what the database alone can answer - metadata, the stored diff, comments
    // - instead of letting the failed git call 500 the whole PR out of reach,
    // which also took the UI's only route to deleting it. `repoAvailable` lets
    // the client say so and offer that removal.
    const repoAvailable = isRepoAvailable(pr.repo_path);
    const commits = repoAvailable ? listCommits(pr.repo_path, pr.base_commit, pr.head_commit) : [];

    const url = new URL(req.url);
    // A per-commit diff has to be read out of the repo, so with the repo gone
    // the only thing left to show is the cumulative stored diff.
    const commitParam = repoAvailable ? url.searchParams.get('commit') : null;

    let diff: string | null;
    if (commitParam) {
      if (!commits.some((c) => c.sha === commitParam)) {
        // The commit may have been rewritten (rebase/amend/force-push) since
        // this link was generated - relocatedTo tells the client where it
        // ended up, if relocateComments() has ever recorded that mapping for
        // this PR. Null means either it's genuinely unknown or was never
        // part of this PR - the client can't tell those apart from this.
        const relocatedTo = lookupCommitRelocation(id, commitParam);
        return NextResponse.json(
          { error: 'Unknown commit for this PR', relocatedTo },
          { status: 400 },
        );
      }
      diff = getCommitDiff(pr.repo_path, commitParam);
    } else {
      diff = getLatestDiff(id);
    }

    const comments = getCommentsWithReplies(id);

    // Parse diff to get file list
    const files = parseDiffFiles(diff || '');

    // A mark's `current` flag says whether the file's content still matches
    // what it was when marked - see getBlobHash and setReviewedFile. Without
    // the repo (repoAvailable false), there's no way to recompute this, so
    // marks are passed through trusted as-is rather than guessed at.
    const rawReviewedFiles = getReviewedFiles(id);
    const reviewedFiles = rawReviewedFiles.map((r) => ({
      file_path: r.file_path,
      commit_sha: r.commit_sha,
      marked_at: r.marked_at,
      current: repoAvailable
        ? (getBlobHash(pr.repo_path, r.commit_sha ?? pr.head_commit, r.file_path) ?? 'deleted') ===
          r.content_hash
        : true,
    }));

    // A commit is "reviewed" (shown green in the commit selector) once every
    // file its own diff touches has a current mark scoped to it - the same
    // bar CommitMessagePanel's "mark commit reviewed" button clears in one
    // shot, but also true if every file in it happened to be marked one at a
    // time. Only worth a getCommitDiff call for a commit that has at least
    // one current mark to begin with - most commits in a fresh PR have none,
    // so this stays cheap regardless of how many commits the PR has.
    const candidateCommitShas = [
      ...new Set(
        reviewedFiles
          .filter((r) => r.commit_sha !== null && r.current)
          .map((r) => r.commit_sha as string),
      ),
    ];
    const reviewedCommits = repoAvailable
      ? candidateCommitShas.filter((sha) => {
          if (!commits.some((c) => c.sha === sha)) return false;
          const commitFiles = parseDiffFiles(getCommitDiff(pr.repo_path, sha));
          if (commitFiles.length === 0) return false;
          return commitFiles.every((f) =>
            reviewedFiles.some((r) => r.file_path === f.path && r.commit_sha === sha && r.current),
          );
        })
      : [];

    return NextResponse.json({
      pr: toPublicPR(pr),
      diff,
      files,
      comments,
      commits,
      reviewedFiles,
      reviewedCommits,
      repoAvailable,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/prs/[id] - Update PR (status, etc)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    if (body.status !== undefined) {
      const validStatuses = Object.values(PullRequestStatus) as string[];
      if (!validStatuses.includes(body.status)) {
        return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
      }
      // A merged PR is terminal - its history is already merged, so there is
      // nothing to reopen/close into.
      if (pr.status === PullRequestStatus.Merged) {
        return NextResponse.json(
          { error: 'Cannot change the status of a merged PR' },
          { status: 409 },
        );
      }
      updatePRStatus(id, body.status);
    }

    const updatedPR = getPRByUuid(id);
    return NextResponse.json({ pr: updatedPR ? toPublicPR(updatedPR) : updatedPR });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id] - Permanently remove a PR and all its review data
// (web-UI equivalent of the CLI's `delete`). Allowed in any status, including
// merged: unlike PATCH, this isn't a state transition, it's discarding the
// record. Runs no git at all, so a PR whose repo path is gone can still be
// removed - see the GET handler's repoAvailable.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    deletePR(id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
