import { NextRequest, NextResponse } from 'next/server';

import { previewKeyedShas, reconcilePreviewComments } from '@/lib/comment-relocation';
import {
  deletePR,
  getPRByUuid,
  getLatestDiff,
  updatePRStatus,
  getCommentsWithReplies,
  getReviewedCommitMessages,
  getReviewedFiles,
  lookupCommitRelocation,
  toPublicPR,
} from '@/lib/database';
import { parseDiffFiles } from '@/lib/diff';
import { PullRequestStatus } from '@/lib/enum';
import {
  getAutosquashPreview,
  listCommits,
  getCommitDiff,
  getBlobHash,
  getCommitMessageHash,
  isRepoAvailable,
  type AutosquashPreview,
} from '@/lib/git';

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

    // `?view=autosquash` previews the branch as `rebase -i --autosquash`
    // would leave it (see autosquashCommits). `commits` stays the PR's own
    // list either way, and the squashed commits come alongside, as the ones
    // `?commit=` may name. A failure (merge commits, a git too old for
    // merge-tree --merge-base) is reported rather than 500ing, so the page
    // can fall back to the normal view with the reason.
    //
    // The preview's commits can be commented on and marked reviewed too, and
    // whatever is keyed to one is carried over to its successor - the next
    // preview, or the real commit once the author autosquashes for real (see
    // reconcilePreviewComments). That runs here, before anything is read, so
    // the preview is also built whenever something is keyed to one of its
    // commits (cached per head, so the poll doesn't rebuild it).
    const autosquashView = repoAvailable && url.searchParams.get('view') === 'autosquash';
    const keyed = repoAvailable
      ? previewKeyedShas(
          id,
          commits.map((c) => c.sha),
        )
      : [];
    let preview: AutosquashPreview | null = null;
    if (autosquashView || keyed.length > 0) {
      preview = getAutosquashPreview(pr.repo_path, pr.base_commit, pr.head_commit);
      reconcilePreviewComments(id, pr.repo_path, pr.base_commit, pr.head_commit, keyed, preview);
    }
    const autosquash = autosquashView ? preview : null;
    const viewableCommits = autosquash && autosquash.error === null ? autosquash.commits : commits;
    // The preview's own commits - not the PR commits it reuses unchanged -
    // for labelling what's keyed to them outside the preview.
    const previewCommits =
      preview && preview.error === null ? preview.commits.filter((c) => c.rewritten) : [];

    let diff: string | null;
    if (commitParam) {
      if (!viewableCommits.some((c) => c.sha === commitParam)) {
        // The commit may have been rewritten (rebase/amend/force-push) since
        // this link was generated - relocatedTo tells the client where it
        // ended up, if relocateComments() has ever recorded that mapping for
        // this PR. Null means either it's genuinely unknown or was never
        // part of this PR - the client can't tell those apart from this.
        //
        // In the autosquash preview, a PR commit that was folded or rebased
        // lives on as the squashed commit built from it - relocatedTo points
        // there, so turning the preview on keeps the same change on screen.
        const squashedFrom =
          autosquash && autosquash.error === null
            ? autosquash.commits.find(
                (c) =>
                  c.originalSha === commitParam || c.absorbed.some((a) => a.sha === commitParam),
              )
            : undefined;
        const relocatedTo = squashedFrom?.sha ?? lookupCommitRelocation(id, commitParam);
        // Outside the preview, a link to one of its commits (a comment made
        // there) can't be shown here - inAutosquashPreview says to turn the
        // preview on and try again.
        let inAutosquashPreview = false;
        if (!autosquash) {
          const current =
            preview ?? getAutosquashPreview(pr.repo_path, pr.base_commit, pr.head_commit);
          inAutosquashPreview =
            current.error === null && current.commits.some((c) => c.sha === commitParam);
        }
        return NextResponse.json(
          { error: 'Unknown commit for this PR', relocatedTo, inAutosquashPreview },
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

    // The same content-addressed staleness check, for commit messages: the
    // mark holds a hash of the message text, so a reword drops it while a
    // rebase that only re-SHA'd the commit keeps it.
    const reviewedMessages = getReviewedCommitMessages(id).map((r) => ({
      commit_sha: r.commit_sha,
      marked_at: r.marked_at,
      current: repoAvailable
        ? getCommitMessageHash(pr.repo_path, r.commit_sha) === r.content_hash
        : true,
    }));

    // A commit is "reviewed" (shown green in the commit selector) once both
    // halves of it have current marks: its message, and every file its own
    // diff touches. That's the bar CommitMessagePanel's "mark commit
    // reviewed" button clears in one shot, but it's equally true of a commit
    // signed off a piece at a time. The message mark is the cheap gate here -
    // a commit without one can't qualify however its files are marked, so
    // most commits in a fresh PR cost no getCommitDiff call at all.
    const candidateCommitShas = reviewedMessages.filter((r) => r.current).map((r) => r.commit_sha);
    const reviewedCommits = repoAvailable
      ? candidateCommitShas.filter((sha) => {
          if (!commits.some((c) => c.sha === sha) && !previewCommits.some((c) => c.sha === sha)) {
            return false;
          }
          // A commit touching no files (an empty commit) is fully reviewed
          // once its message is - there is nothing else to look at.
          const commitFiles = parseDiffFiles(getCommitDiff(pr.repo_path, sha));
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
      reviewedMessages,
      reviewedCommits,
      repoAvailable,
      autosquash,
      previewCommits,
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
