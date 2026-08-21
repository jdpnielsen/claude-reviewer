import { CheckCircle, Clock, GitMerge, XCircle } from 'lucide-react';

import type { FileInfo, FolderNode } from './types';
import { LineType } from '@/lib/enum';

// Limit lines rendered per file for performance on large diffs.
export const MAX_LINES_DEFAULT = 300;

// Map file extensions to Prism language identifiers
export const getLanguage = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'markup',
    xml: 'markup',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    toml: 'toml',
    dockerfile: 'docker',
  };
  return langMap[ext] || 'plaintext';
};

export function buildFolderTree(files: FileInfo[]): FolderNode {
  const root: FolderNode = { name: '', path: '', files: [], children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    // Navigate/create folder structure
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join('/');

      if (!current.children.has(folderName)) {
        current.children.set(folderName, {
          name: folderName,
          path: folderPath,
          files: [],
          children: new Map(),
        });
      }
      current = current.children.get(folderName)!;
    }

    // Add file to current folder
    current.files.push(file);
  }

  return root;
}

// GitHub-style status colors
export const statusConfig = {
  pending: { icon: Clock, color: '#d29922', label: 'Pending Review' },
  approved: { icon: CheckCircle, color: '#238636', label: 'Approved' },
  changes_requested: { icon: XCircle, color: '#da3633', label: 'Changes Requested' },
  merged: { icon: GitMerge, color: '#8250df', label: 'Merged' },
  closed: { icon: XCircle, color: '#6e7681', label: 'Closed' },
};

// GitHub-like dark theme for syntax highlighting
export const githubDarkTheme = {
  plain: {
    color: '#e6edf3',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e' } },
    { types: ['punctuation'], style: { color: '#e6edf3' } },
    { types: ['namespace'], style: { opacity: 0.7 } },
    {
      types: ['property', 'tag', 'boolean', 'number', 'constant', 'symbol', 'deleted'],
      style: { color: '#79c0ff' },
    },
    {
      types: ['selector', 'attr-name', 'char', 'builtin', 'inserted'],
      style: { color: '#a5d6ff' },
    },
    { types: ['operator', 'entity', 'url'], style: { color: '#e6edf3' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: '#ff7b72' } },
    { types: ['function', 'class-name'], style: { color: '#d2a8ff' } },
    { types: ['regex', 'important', 'variable'], style: { color: '#ffa657' } },
    { types: ['string'], style: { color: '#a5d6ff' } },
  ],
};

export const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parse diff into file chunks
export const parseFileDiff = (diff: string, filePath: string): string[] => {
  const fileMatch = diff.match(
    new RegExp(
      `diff --git a/${escapeRegex(filePath)} b/${escapeRegex(filePath)}[\\s\\S]*?(?=diff --git|$)`,
    ),
  );
  if (!fileMatch) return [];

  const lines = fileMatch[0].split('\n');
  return lines.filter(
    (l) =>
      !l.startsWith('diff --git') &&
      !l.startsWith('index ') &&
      !l.startsWith('---') &&
      !l.startsWith('+++'),
  );
};

// Extracts the current text of a line range on a given side of the diff,
// for seeding a suggestion's fenced block with the code it would replace.
// Replays the same hunk-relative old/new line-counting walk FileDiffCard
// uses to compute anchorLine while rendering, so the line numbers here mean
// the same thing they do everywhere else in the diff viewer.
export const getRangeTextFromDiff = (
  diffLines: string[],
  startLine: number,
  endLine: number,
  lineType: LineType,
): string[] => {
  let oldLineNum = 0;
  let newLineNum = 0;
  const result: string[] = [];

  for (const line of diffLines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        oldLineNum = parseInt(match[1]) - 1;
        newLineNum = parseInt(match[2]) - 1;
      }
      continue;
    }

    let anchorLine: number;
    if (line.startsWith('+')) {
      anchorLine = ++newLineNum;
    } else if (line.startsWith('-')) {
      anchorLine = ++oldLineNum;
    } else {
      oldLineNum++;
      anchorLine = ++newLineNum;
    }

    const sideMatches = line.startsWith('-')
      ? lineType === LineType.Old
      : lineType !== LineType.Old;
    if (sideMatches && anchorLine >= startLine && anchorLine <= endLine) {
      result.push(line.slice(1));
    }
  }

  return result;
};

export const isMarkdownFile = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown';
};

// Extract full file content from diff for markdown preview
export const getFileContentFromDiff = (diffContent: string, filePath: string): string => {
  const fileMatch = diffContent.match(
    new RegExp(
      `diff --git a/${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} b/${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=diff --git|$)`,
    ),
  );
  if (!fileMatch) return '';

  const lines = fileMatch[0].split('\n');
  const contentLines: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@')
    ) {
      continue;
    }
    if (line.startsWith('-')) continue; // Skip deleted lines
    if (line.startsWith('+')) {
      contentLines.push(line.slice(1)); // Add new lines without +
    } else if (line.startsWith(' ')) {
      contentLines.push(line.slice(1)); // Context lines have leading space
    } else {
      contentLines.push(line); // Empty lines or other
    }
  }
  return contentLines.join('\n');
};
