import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import {
  createRepoConversation,
  listRepoConversations,
  updateRepoConversationStatus,
  deleteRepoConversation
} from '@/lib/database';

// GET /api/browse/conversations - List conversations
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const repoPath = searchParams.get('repo');
    const filePath = searchParams.get('file') || undefined;
    const status = (searchParams.get('status') || 'all') as 'active' | 'orphaned' | 'resolved' | 'all';
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    if (!repoPath) {
      return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
    }

    const conversations = listRepoConversations({
      repoPath,
      filePath,
      status,
      limit
    });

    return NextResponse.json({ conversations });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/browse/conversations - Create a new conversation
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { repo, filePath, lineNumber, content } = body;

    if (!repo || !filePath || lineNumber === undefined || !content) {
      return NextResponse.json(
        { error: 'repo, filePath, lineNumber, and content are required' },
        { status: 400 }
      );
    }

    // Get anchor context (3 lines before and after)
    let anchor: {
      content: string;
      contextBefore: string;
      contextAfter: string;
      commit: string;
    } | undefined;

    try {
      // Read file content
      let fileContent: string;
      const fullPath = `${repo}/${filePath}`;

      try {
        fileContent = execSync(`git show HEAD:${filePath}`, {
          cwd: repo,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024
        });
      } catch {
        // Fallback to filesystem
        if (fs.existsSync(fullPath)) {
          fileContent = fs.readFileSync(fullPath, 'utf-8');
        } else {
          fileContent = '';
        }
      }

      if (fileContent) {
        const lines = fileContent.split('\n');
        const lineIdx = lineNumber - 1;

        if (lineIdx >= 0 && lineIdx < lines.length) {
          const anchorContent = lines[lineIdx];
          const contextBefore = lines.slice(Math.max(0, lineIdx - 3), lineIdx).join('\n');
          const contextAfter = lines.slice(lineIdx + 1, lineIdx + 4).join('\n');

          let commit = 'unknown';
          try {
            commit = execSync('git rev-parse HEAD', {
              cwd: repo,
              encoding: 'utf-8'
            }).trim();
          } catch {
            // Ignore
          }

          anchor = {
            content: anchorContent,
            contextBefore,
            contextAfter,
            commit
          };
        }
      }
    } catch {
      // Continue without anchor if we can't read the file
    }

    const uuid = createRepoConversation(
      repo,
      filePath,
      lineNumber,
      content,
      'human',
      anchor
    );

    return NextResponse.json({ uuid, success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/browse/conversations - Update conversation status
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { uuid, status } = body;

    if (!uuid || !status) {
      return NextResponse.json({ error: 'uuid and status are required' }, { status: 400 });
    }

    if (!['active', 'orphaned', 'resolved'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const success = updateRepoConversationStatus(uuid, status);
    return NextResponse.json({ success });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/browse/conversations - Delete a conversation
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const uuid = searchParams.get('uuid');

    if (!uuid) {
      return NextResponse.json({ error: 'uuid parameter required' }, { status: 400 });
    }

    const success = deleteRepoConversation(uuid);
    return NextResponse.json({ success });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
