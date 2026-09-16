import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { getPRByUuid } from '@/lib/database';
import { resolveRepoPath } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

function sliceResponse(content: string, startLine: number, endLine: number) {
  const lines = content.split('\n');
  // A file's final newline terminates its last line rather than starting an
  // empty one, so drop what split() leaves behind. The client bounds
  // expand-down on totalLines, and counting the phantom would leave the
  // control offering one blank row past the end of the file.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return NextResponse.json({
    lines: lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)),
    startLine: Math.max(1, startLine),
    endLine: Math.min(lines.length, endLine),
    totalLines: lines.length,
  });
}

// GET /api/prs/[id]/context - Get additional context lines for a file
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const pr = getPRByUuid(id);

    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const filePath = url.searchParams.get('file');
    const startLine = parseInt(url.searchParams.get('start') || '1', 10);
    const endLine = parseInt(url.searchParams.get('end') || '20', 10);
    // The commit the caller's line numbers are relative to. The client sends
    // this whenever a single commit's diff (`sha^..sha`) is on screen; without
    // it the line numbers are the PR's cumulative base...head diff, which
    // indexes the head commit.
    const requestedCommit = url.searchParams.get('commit');
    const commit = requestedCommit || pr.head_commit;

    if (!filePath) {
      return NextResponse.json({ error: 'file parameter required' }, { status: 400 });
    }

    const repoPath = resolveRepoPath(pr.repo_path);

    // Use git show to get file content at the specific commit
    try {
      const content = execFileSync('git', ['show', `${commit}:${filePath}`], {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return sliceResponse(content, startLine, endLine);
    } catch {
      // The head fallback may legitimately miss: a PR can be created from
      // uncommitted work, so its diff mentions files no commit contains yet -
      // for those the working tree is the only source. An explicit ?commit=
      // gets no such fallback, because the working tree is a *different*
      // revision: serving it would silently answer "what's around line 20 in
      // this commit?" with text from a later one.
      if (requestedCommit) {
        return NextResponse.json({ error: 'File not found in commit' }, { status: 404 });
      }
      try {
        const content = fs.readFileSync(path.join(repoPath, filePath), 'utf-8');
        return sliceResponse(content, startLine, endLine);
      } catch {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
