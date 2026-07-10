import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { getConversationCountsByFile } from '@/lib/database';

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  conversationCount?: number;
}

// GET /api/browse/tree - Get folder structure
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const repoPath = searchParams.get('repo');
    const subPath = searchParams.get('path') || '';
    const depth = parseInt(searchParams.get('depth') || '1', 10);

    if (!repoPath) {
      return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
    }

    // Validate repo path exists
    if (!fs.existsSync(repoPath)) {
      return NextResponse.json({ error: 'Repository path not found' }, { status: 404 });
    }

    const fullPath = subPath ? path.join(repoPath, subPath) : repoPath;

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    // Get conversation counts for badges
    const conversationCounts = getConversationCountsByFile(repoPath);

    // Build tree using git ls-tree for tracked files, supplemented with fs for untracked
    const tree = buildTree(repoPath, fullPath, subPath, depth, conversationCounts);

    return NextResponse.json({
      tree,
      repoPath,
      currentPath: subPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildTree(
  repoPath: string,
  fullPath: string,
  relativePath: string,
  depth: number,
  conversationCounts: Record<string, number>,
): TreeNode {
  const stats = fs.statSync(fullPath);
  const name = path.basename(fullPath) || path.basename(repoPath);

  if (!stats.isDirectory()) {
    return {
      name,
      path: relativePath,
      type: 'file',
      conversationCount: conversationCounts[relativePath] || 0,
    };
  }

  const node: TreeNode = {
    name,
    path: relativePath,
    type: 'directory',
  };

  if (depth > 0) {
    const children: TreeNode[] = [];

    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });

      // Sort: directories first, then files, both alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        // Skip hidden files and common ignore patterns
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === '__pycache__' ||
          entry.name === '.next' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) {
          continue;
        }

        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const childFullPath = path.join(fullPath, entry.name);

        children.push(
          buildTree(repoPath, childFullPath, childRelativePath, depth - 1, conversationCounts),
        );
      }
    } catch {
      // Permission denied or other error reading directory
    }

    node.children = children;
  }

  return node;
}
