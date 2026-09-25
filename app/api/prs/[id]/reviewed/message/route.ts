import { NextRequest, NextResponse } from 'next/server';

import { getPRByUuid, setReviewedCommitMessage, unsetReviewedCommitMessage } from '@/lib/database';
import { getCommitMessageHash, isPRCommit } from '@/lib/git';
import { cascadeGroups, unmarkMessageCascade } from '@/lib/reviewed-cascade';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/reviewed/message - Mark one commit's message reviewed.
// Independent of the files that commit touches: a reviewer can be happy with
// the wording and still have the diff to read, or the other way round.
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

    const contentHash = getCommitMessageHash(pr.repo_path, commitSha);
    if (contentHash === null) {
      return NextResponse.json({ error: 'Could not read that commit message' }, { status: 400 });
    }

    setReviewedCommitMessage(id, commitSha, contentHash);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id]/reviewed/message?commit=<sha> - Unmark it, along with
// whatever it was derived from across the autosquash preview (see
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

    const groups = cascadeGroups(pr.repo_path, pr.base_commit, pr.head_commit);
    const removed =
      (unsetReviewedCommitMessage(id, commitSha) ? 1 : 0) +
      unmarkMessageCascade(id, groups, commitSha);
    if (removed === 0) {
      return NextResponse.json({ error: 'Not marked reviewed' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
