import { NextRequest, NextResponse } from 'next/server';

import {
  getPRByUuid,
  setReviewedCommitMessage,
  setReviewedFile,
  unsetReviewedCommitMessage,
  unsetReviewedFilesForCommit,
} from '@/lib/database';
import { parseDiffFiles } from '@/lib/diff';
import { getBlobHash, getCommitDiff, getCommitMessageHash, isPRCommit } from '@/lib/git';
import {
  cascadeGroups,
  commitFilePaths,
  unmarkFileCascade,
  unmarkMessageCascade,
} from '@/lib/reviewed-cascade';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/reviewed/commit - Mark the whole commit reviewed: its
// message plus every file its own diff touches. The "review all of it in one
// click" shortcut over the two finer-grained routes next to this one
// (../reviewed for a single file, ../reviewed/message for the message alone),
// which stay available for a reviewer who only wants to sign off on part of
// it.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { commitSha } = await req.json();

    if (!commitSha || typeof commitSha !== 'string') {
      return NextResponse.json({ error: 'Missing required field: commitSha' }, { status: 400 });
    }

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    // One of the PR's commits, or one its autosquash preview built.
    if (!isPRCommit(pr.repo_path, pr.base_commit, pr.head_commit, commitSha)) {
      return NextResponse.json({ error: 'Unknown commit for this PR' }, { status: 400 });
    }

    const files = parseDiffFiles(getCommitDiff(pr.repo_path, commitSha));
    for (const file of files) {
      const contentHash = getBlobHash(pr.repo_path, commitSha, file.path) ?? 'deleted';
      setReviewedFile(id, file.path, commitSha, contentHash);
    }

    const messageHash = getCommitMessageHash(pr.repo_path, commitSha);
    if (messageHash !== null) setReviewedCommitMessage(id, commitSha, messageHash);

    return NextResponse.json({ success: true, fileCount: files.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id]/reviewed/commit?commit=<sha> - The mirror of POST:
// drop the commit's message mark and every file mark scoped to it at once,
// plus the marks across the autosquash preview they were derived from (see
// lib/reviewed-cascade.ts).
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const commitSha = searchParams.get('commit');

    if (!commitSha) {
      return NextResponse.json({ error: 'Missing commit' }, { status: 400 });
    }

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const removed = unsetReviewedFilesForCommit(id, commitSha);
    unsetReviewedCommitMessage(id, commitSha);
    const groups = cascadeGroups(pr.repo_path, pr.base_commit, pr.head_commit);
    if (groups.length > 0) {
      const filesOf = (sha: string) => commitFilePaths(pr.repo_path, sha);
      for (const path of filesOf(commitSha)) {
        unmarkFileCascade(id, groups, path, commitSha, filesOf);
      }
      unmarkMessageCascade(id, groups, commitSha);
    }
    return NextResponse.json({ success: true, fileCount: removed });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
