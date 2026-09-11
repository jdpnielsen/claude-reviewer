import { CheckCircle, Clock, GitMerge, XCircle } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import type { FileInfo, FolderNode, ReviewedMark } from './types';
import { LineType } from '@/lib/enum';

// Cmd+Enter (macOS) or Ctrl+Enter (elsewhere) submits a comment form from its
// textarea, mirroring GitHub's convention, without swallowing a plain Enter
// (which should still just insert a newline).
export const submitOnModEnter =
  (submit: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

// Limit lines rendered per file for performance on large diffs.
export const MAX_LINES_DEFAULT = 300;

// Generated/vendored lockfiles whose diffs are rarely worth reading
// line-by-line - collapsed by default regardless of size. Matched on
// basename so they're caught in any subdirectory (e.g. a monorepo package).
const NOISY_DEFAULT_COLLAPSE_FILENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'mix.lock',
  'flake.lock',
]);

// A file starts collapsed if it's already been marked reviewed, it's a
// known-noisy lockfile, or its diff is large enough to hit the
// MAX_LINES_DEFAULT render cap anyway - in all three cases expanding it by
// default just adds scroll weight nobody's about to read. Everything else
// opens expanded so reviewers see the change without extra clicks.
export const shouldCollapseByDefault = (file: FileInfo, isReviewed: boolean): boolean => {
  if (isReviewed) return true;
  const basename = file.path.split('/').pop() ?? file.path;
  if (NOISY_DEFAULT_COLLAPSE_FILENAMES.has(basename)) return true;
  return file.additions + file.deletions > MAX_LINES_DEFAULT;
};

// The reviewed mark for `filePath` in a given commit context (null = the
// cumulative/PR-wide diff), if any - a stale (non-current) mark is treated
// the same as no mark at all, so callers don't each need to remember to
// check `current` themselves.
export const findReviewedMark = (
  marks: ReviewedMark[],
  filePath: string,
  commitSha: string | null,
): ReviewedMark | undefined =>
  marks.find((m) => m.file_path === filePath && m.commit_sha === commitSha && m.current);

// Map file extensions to Prism language identifiers
export const getLanguage = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
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

// Tries to place a comment made against one specific commit's diff at its
// corresponding line in a DIFFERENT diff (the cumulative one) - so it can
// render inline there instead of only in a separate commit-tagged list. Matches
// on the comment's captured anchor_content (exact, trimmed) among diffLines on
// the requested side, using the same side-matching rule FileDiffCard's own
// inline-comment lookup uses (an Old-side comment only matches a removed
// line; a New-side comment matches an added OR an unchanged context line).
// A single match is trusted outright; multiple exact-content matches (e.g. a
// bare "}") are narrowed using the captured 3-line context, mirroring
// lib/comment-relocation.ts's same tiered approach. Returns null - meaning
// "don't guess" - when there's no anchor_content to match on, or the match
// stays ambiguous even after narrowing.
export const findAnchorMatchInDiff = (
  diffLines: string[],
  anchorContent: string | null,
  anchorContextBefore: string | null,
  anchorContextAfter: string | null,
  lineType: LineType,
): { anchorLine: number; lineType: LineType } | null => {
  if (!anchorContent) return null;
  const trimmedAnchor = anchorContent.trim();

  let oldLineNum = 0;
  let newLineNum = 0;
  // Every line on the requested side, in diff order, so context lookups can
  // walk immediately before/after a candidate.
  const sideLines: { text: string; anchorLine: number }[] = [];
  const candidateIdxs: number[] = [];

  for (const line of diffLines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        oldLineNum = parseInt(match[1], 10) - 1;
        newLineNum = parseInt(match[2], 10) - 1;
      }
      continue;
    }

    let anchorLine: number;
    let sideMatches: boolean;
    if (line.startsWith('+')) {
      newLineNum++;
      anchorLine = newLineNum;
      sideMatches = lineType !== LineType.Old;
    } else if (line.startsWith('-')) {
      oldLineNum++;
      anchorLine = oldLineNum;
      sideMatches = lineType === LineType.Old;
    } else {
      oldLineNum++;
      newLineNum++;
      anchorLine = newLineNum;
      sideMatches = lineType !== LineType.Old;
    }

    if (!sideMatches) continue;
    const text = line.slice(1).trim();
    if (text === trimmedAnchor) candidateIdxs.push(sideLines.length);
    sideLines.push({ text, anchorLine });
  }

  if (candidateIdxs.length === 0) return null;
  if (candidateIdxs.length === 1) {
    return { anchorLine: sideLines[candidateIdxs[0]].anchorLine, lineType };
  }

  const beforeLines = anchorContextBefore
    ? anchorContextBefore.split('\n').map((l) => l.trim())
    : [];
  const afterLines = anchorContextAfter ? anchorContextAfter.split('\n').map((l) => l.trim()) : [];
  if (beforeLines.length === 0 && afterLines.length === 0) return null;

  const narrowed = candidateIdxs.filter((idx) => {
    for (let j = 0; j < beforeLines.length; j++) {
      const checkIdx = idx - beforeLines.length + j;
      if (sideLines[checkIdx]?.text !== beforeLines[j]) return false;
    }
    for (let j = 0; j < afterLines.length; j++) {
      const checkIdx = idx + 1 + j;
      if (sideLines[checkIdx]?.text !== afterLines[j]) return false;
    }
    return true;
  });

  return narrowed.length === 1
    ? { anchorLine: sideLines[narrowed[0]].anchorLine, lineType }
    : null;
};

// A shift-click range whose two ends fall on opposite sides (an added line
// and a removed line) can only become one comment when the rows between
// them, inclusive, are ALL '+'/'-' lines - i.e. one contiguous "replace"
// block in the hunk, with no context line or hunk header in between. That's
// the only shape where "the deleted line" and "the added line" are
// unambiguously the same change. Bounded strictly by the two clicked rows
// (not expanded to the block's full extent), mirroring the same-side
// shift-click behavior in FileDiffCard.
export const getCrossSideRange = (
  diffLines: string[],
  rowIdxA: number,
  rowIdxB: number,
): { oldStart: number; oldEnd: number; newStart: number; newEnd: number } | null => {
  const lo = Math.min(rowIdxA, rowIdxB);
  const hi = Math.max(rowIdxA, rowIdxB);

  for (let i = lo; i <= hi; i++) {
    if (!diffLines[i].startsWith('+') && !diffLines[i].startsWith('-')) return null;
  }

  let oldLineNum = 0;
  let newLineNum = 0;
  let oldStart: number | null = null;
  let oldEnd = 0;
  let newStart: number | null = null;
  let newEnd = 0;

  for (let i = 0; i <= hi; i++) {
    const line = diffLines[i];
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        oldLineNum = parseInt(match[1]) - 1;
        newLineNum = parseInt(match[2]) - 1;
      }
      continue;
    }

    if (line.startsWith('+')) {
      newLineNum++;
      if (i >= lo) {
        if (newStart === null) newStart = newLineNum;
        newEnd = newLineNum;
      }
    } else if (line.startsWith('-')) {
      oldLineNum++;
      if (i >= lo) {
        if (oldStart === null) oldStart = oldLineNum;
        oldEnd = oldLineNum;
      }
    } else {
      oldLineNum++;
      newLineNum++;
    }
  }

  if (oldStart === null || newStart === null) return null;
  return { oldStart, oldEnd, newStart, newEnd };
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
