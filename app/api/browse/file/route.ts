import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import {
  listRepoConversations,
  updateRepoConversationAnchor,
  updateRepoConversationStatus,
  RepoConversationWithMessages,
} from '@/lib/database';
import { ConversationStatus } from '@/lib/enum';

// Relocate a conversation's anchor in the current file content
// Returns the new line number or null if not found
function relocateAnchor(
  conv: RepoConversationWithMessages,
  lines: string[],
  searchRadius: number = 50,
): number | null {
  const anchorContent = conv.conversation.anchor_content;
  if (!anchorContent) return null;

  const originalLine = conv.conversation.line_number;
  const anchorTrimmed = anchorContent.trim();

  // 1. First, check if the content is still at the original line
  if (originalLine > 0 && originalLine <= lines.length) {
    if (lines[originalLine - 1].trim() === anchorTrimmed) {
      return originalLine;
    }
  }

  // 2. Search nearby lines for exact match
  const startSearch = Math.max(0, originalLine - searchRadius);
  const endSearch = Math.min(lines.length, originalLine + searchRadius);

  for (let i = startSearch; i < endSearch; i++) {
    if (lines[i].trim() === anchorTrimmed) {
      return i + 1; // Convert to 1-indexed
    }
  }

  // 3. Try context-based matching if we have context
  const contextBefore = conv.conversation.anchor_context_before;
  const contextAfter = conv.conversation.anchor_context_after;

  if (contextBefore || contextAfter) {
    const beforeLines = contextBefore ? contextBefore.split('\n').map((l) => l.trim()) : [];
    const afterLines = contextAfter ? contextAfter.split('\n').map((l) => l.trim()) : [];

    // Search for context pattern
    for (let i = startSearch; i < endSearch; i++) {
      let matches = true;

      // Check lines before
      for (let j = 0; j < beforeLines.length && matches; j++) {
        const checkIdx = i - beforeLines.length + j;
        if (checkIdx < 0 || checkIdx >= lines.length) {
          matches = false;
        } else if (lines[checkIdx].trim() !== beforeLines[j]) {
          matches = false;
        }
      }

      // Check lines after
      for (let j = 0; j < afterLines.length && matches; j++) {
        const checkIdx = i + 1 + j;
        if (checkIdx >= lines.length) {
          matches = false;
        } else if (lines[checkIdx].trim() !== afterLines[j]) {
          matches = false;
        }
      }

      if (matches) {
        return i + 1; // Found by context
      }
    }
  }

  // 4. Not found anywhere
  return null;
}

// GET /api/browse/file - Get file content with conversations
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const repoPath = searchParams.get('repo');
    const filePath = searchParams.get('path');
    const commit = searchParams.get('commit') || 'HEAD';
    const start = parseInt(searchParams.get('start') || '1', 10);
    const end = parseInt(searchParams.get('end') || '0', 10); // 0 means all lines

    if (!repoPath || !filePath) {
      return NextResponse.json({ error: 'repo and path parameters required' }, { status: 400 });
    }

    // Validate repo path exists
    if (!fs.existsSync(repoPath)) {
      return NextResponse.json({ error: 'Repository path not found' }, { status: 404 });
    }

    let content: string;

    try {
      // Try to get file from git
      const hostPathPrefix = process.env.HOST_PATH_PREFIX;
      let gitPath = repoPath;
      if (hostPathPrefix && repoPath.startsWith('/app/repo')) {
        gitPath = repoPath.replace('/app/repo', hostPathPrefix);
      }

      content = execSync(`git show ${commit}:${filePath}`, {
        cwd: gitPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
    } catch {
      // Fallback to filesystem for new/untracked files
      const fullPath = path.join(repoPath, filePath);
      if (!fs.existsSync(fullPath)) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      content = fs.readFileSync(fullPath, 'utf-8');
    }

    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // Apply line range
    const startIdx = Math.max(0, start - 1);
    const endIdx = end > 0 ? Math.min(end, totalLines) : totalLines;
    const lines = allLines.slice(startIdx, endIdx);

    // Get conversations for this file
    const conversationsData = listRepoConversations({
      repoPath,
      filePath,
      status: 'all',
    });

    // Relocate anchors and update conversation positions
    const conversations = conversationsData.map((c) => {
      // Only try to relocate active/orphaned conversations that have anchors
      if (c.conversation.status !== ConversationStatus.Resolved && c.conversation.anchor_content) {
        const newLineNumber = relocateAnchor(c, allLines);

        if (newLineNumber !== null) {
          // Found the anchor - update position if changed
          if (newLineNumber !== c.conversation.current_line_number) {
            updateRepoConversationAnchor(c.conversation.uuid, newLineNumber, true);
          }
          // If it was orphaned but now found, restore to active
          if (c.conversation.status === ConversationStatus.Orphaned) {
            updateRepoConversationStatus(c.conversation.uuid, ConversationStatus.Active);
          }
          return {
            uuid: c.conversation.uuid,
            line_number: c.conversation.line_number,
            current_line_number: newLineNumber,
            status: ConversationStatus.Active,
            message_count: c.message_count,
            latest_message: c.messages.length > 0 ? c.messages[c.messages.length - 1] : null,
          };
        } else {
          // Anchor not found - mark as orphaned
          if (c.conversation.status !== ConversationStatus.Orphaned) {
            updateRepoConversationStatus(c.conversation.uuid, ConversationStatus.Orphaned);
          }
          return {
            uuid: c.conversation.uuid,
            line_number: c.conversation.line_number,
            current_line_number: c.conversation.current_line_number || c.conversation.line_number,
            status: ConversationStatus.Orphaned,
            message_count: c.message_count,
            latest_message: c.messages.length > 0 ? c.messages[c.messages.length - 1] : null,
          };
        }
      }

      // For resolved conversations or those without anchors, return as-is
      return {
        uuid: c.conversation.uuid,
        line_number: c.conversation.line_number,
        current_line_number: c.conversation.current_line_number || c.conversation.line_number,
        status: c.conversation.status,
        message_count: c.message_count,
        latest_message: c.messages.length > 0 ? c.messages[c.messages.length - 1] : null,
      };
    });

    // Get current commit SHA
    let currentCommit = commit;
    if (commit === 'HEAD') {
      try {
        currentCommit = execSync('git rev-parse HEAD', {
          cwd: repoPath,
          encoding: 'utf-8',
        }).trim();
      } catch {
        currentCommit = 'unknown';
      }
    }

    return NextResponse.json({
      content: lines.join('\n'),
      lines,
      totalLines,
      startLine: start,
      endLine: endIdx,
      conversations,
      commit: currentCommit,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
