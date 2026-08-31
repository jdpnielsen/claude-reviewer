import { NextRequest, NextResponse } from 'next/server';

import {
  getPRByUuid,
  getLatestDiff,
  updatePRStatus,
  getCommentsWithReplies,
  lookupCommitRelocation,
} from '@/lib/database';
import { ChangeType, PullRequestStatus } from '@/lib/enum';
import { listCommits, getCommitDiff, isRepoAvailable } from '@/lib/git';

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

    return NextResponse.json({
      pr,
      diff,
      files,
      comments,
      commits,
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
    return NextResponse.json({ pr: updatedPR });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Parse diff to extract file information
function parseDiffFiles(diff: string): Array<{
  path: string;
  oldPath?: string;
  changeType: ChangeType;
  additions: number;
  deletions: number;
}> {
  const files: Array<{
    path: string;
    oldPath?: string;
    changeType: ChangeType;
    additions: number;
    deletions: number;
  }> = [];

  // Split by diff headers
  const diffParts = diff.split(/^diff --git /m).filter(Boolean);

  for (const part of diffParts) {
    const lines = part.split('\n');
    const headerLine = lines[0];

    // Extract file paths from header: a/path b/path
    const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/);
    if (!pathMatch) continue;

    const oldPath = pathMatch[1];
    const newPath = pathMatch[2];

    // Determine change type
    let changeType: ChangeType = ChangeType.Modified;
    if (part.includes('new file mode')) {
      changeType = ChangeType.Added;
    } else if (part.includes('deleted file mode')) {
      changeType = ChangeType.Deleted;
    } else if (oldPath !== newPath) {
      changeType = ChangeType.Renamed;
    }

    // Count additions and deletions
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    files.push({
      path: newPath,
      oldPath: changeType === ChangeType.Renamed ? oldPath : undefined,
      changeType,
      additions,
      deletions,
    });
  }

  return files;
}
