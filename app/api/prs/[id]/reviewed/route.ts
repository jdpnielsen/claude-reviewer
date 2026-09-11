import { NextRequest, NextResponse } from 'next/server';

import { getPRByUuid, setReviewedFile, unsetReviewedFile } from '@/lib/database';
import { getBlobHash, listCommits } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/prs/[id]/reviewed - Mark a file reviewed, either for the
// cumulative/PR-wide diff (commitSha omitted/null) or scoped to one specific
// commit's own diff.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { filePath, commitSha } = body;

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ error: 'Missing required field: filePath' }, { status: 400 });
    }

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const resolvedCommitSha = typeof commitSha === 'string' && commitSha ? commitSha : null;
    if (resolvedCommitSha) {
      const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);
      if (!commits.some((c) => c.sha === resolvedCommitSha)) {
        return NextResponse.json({ error: 'Unknown commit for this PR' }, { status: 400 });
      }
    }

    const refSha = resolvedCommitSha ?? pr.head_commit;
    // 'deleted' is a stable sentinel, not a real blob hash - it only ever
    // matches itself, so a file that no longer exists here stays "reviewed"
    // until it's restored (a real, different blob hash) or removed again.
    const contentHash = getBlobHash(pr.repo_path, refSha, filePath) ?? 'deleted';

    setReviewedFile(id, filePath, resolvedCommitSha, contentHash);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id]/reviewed?file=<path>&commit=<sha> - Unmark a file.
// `commit` omitted means the cumulative/PR-wide mark.
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const filePath = searchParams.get('file');
    const commitSha = searchParams.get('commit');

    if (!filePath) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const success = unsetReviewedFile(id, filePath, commitSha || null);
    if (!success) {
      return NextResponse.json({ error: 'Not marked reviewed' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
