import { NextRequest, NextResponse } from 'next/server';

import { getPRByUuid, setReviewedFile, unsetReviewedFilesForCommit } from '@/lib/database';
import { parseDiffFiles } from '@/lib/diff';
import { getBlobHash, getCommitDiff, listCommits } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/reviewed/commit - Mark every file this commit touches
// as reviewed, scoped to that commit.
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

    const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);
    if (!commits.some((c) => c.sha === commitSha)) {
      return NextResponse.json({ error: 'Unknown commit for this PR' }, { status: 400 });
    }

    const files = parseDiffFiles(getCommitDiff(pr.repo_path, commitSha));
    for (const file of files) {
      const contentHash = getBlobHash(pr.repo_path, commitSha, file.path) ?? 'deleted';
      setReviewedFile(id, file.path, commitSha, contentHash);
    }

    return NextResponse.json({ success: true, fileCount: files.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id]/reviewed/commit?commit=<sha> - Unmark every file
// reviewed under that commit's scope at once.
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
    return NextResponse.json({ success: true, fileCount: removed });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
