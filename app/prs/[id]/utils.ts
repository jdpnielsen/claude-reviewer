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
  // Every row of a unified diff carries a prefix character, even an empty
  // context line (a lone space), so a truly empty string can only be what
  // split() leaves behind after the chunk's final newline. Left in, it renders
  // as a blank row and - worse - counts as a context line in the old/new line
  // walk, putting every reader of those numbers one line past the truth.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
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

// Namespaces a hunk's expanded-context cache entry (in page.tsx's
// expandedContext/loadingContext) by the commit whose diff is on screen.
// Without the commit in the key, `path:hunk:direction` collides across views:
// a hunk expanded while viewing commit A would keep showing A's surrounding
// lines after switching to commit B, whose diff has an entirely different
// hunk 0. `null` is the cumulative (base...head) diff, which is its own view.
export const contextCacheKey = (
  commitSha: string | null,
  filePath: string,
  hunkIndex: number,
  direction: 'up' | 'down',
): string => `${commitSha ?? 'all'}:${filePath}:${hunkIndex}:${direction}`;

// Same scoping for a whole file's line count (page.tsx's fileLineCounts),
// which is likewise a fact about one revision of one file.
export const contextFileKey = (commitSha: string | null, filePath: string): string =>
  `${commitSha ?? 'all'}:${filePath}`;

// The new-side lines one hunk covers, inclusive. `newEnd` is one *below*
// `newStart` for a hunk that adds nothing on the new side (a pure deletion,
// `+n,0`), which reads correctly as "covers no new-side lines".
export interface HunkRange {
  newStart: number;
  newEnd: number;
}

// Every hunk's new-side extent, in order, so a hunk can be bounded by its
// neighbours: the gap above hunk i ends where hunk i-1 stops, and the gap
// below it starts where hunk i+1 begins. Without those bounds, expanding
// context runs straight through the adjacent hunk and re-renders lines the
// diff is already showing a few rows up. A missing count means 1 (`@@ -1 +1
// @@`); an explicit 0 means the hunk touches no lines on that side, and git
// reports the start as the line before the insertion point.
export const parseHunkRanges = (diffLines: string[]): HunkRange[] => {
  const ranges: HunkRange[] = [];
  for (const line of diffLines) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const newStart = parseInt(match[1], 10);
    const newCount = match[2] === undefined ? 1 : parseInt(match[2], 10);
    ranges.push({ newStart, newEnd: newStart + newCount - 1 });
  }
  return ranges;
};

// How many unseen lines sit between hunk `hunkIndex` and whatever is above it
// - the previous hunk, or the top of the file - discounting the ones already
// expanded into that gap. Zero means there is nothing left to show, so the
// expand-up control has no work to do and shouldn't be rendered.
export const linesAvailableAbove = (
  hunkRanges: HunkRange[],
  hunkIndex: number,
  expandedCount: number,
): number => {
  const hunk = hunkRanges[hunkIndex];
  if (!hunk) return 0;
  const floor = hunkIndex > 0 ? hunkRanges[hunkIndex - 1].newEnd : 0;
  return Math.max(0, hunk.newStart - 1 - expandedCount - floor);
};

// The mirror of linesAvailableAbove, bounded below by the next hunk or by the
// end of the file. `totalLines` is null until some context response has
// reported it (see fetchContext), and the last hunk's control stays visible
// while it's unknown rather than hiding something that may well be expandable.
export const linesAvailableBelow = (
  hunkRanges: HunkRange[],
  hunkIndex: number,
  expandedCount: number,
  totalLines: number | null,
): number => {
  const hunk = hunkRanges[hunkIndex];
  if (!hunk) return 0;
  const next = hunkRanges[hunkIndex + 1];
  const ceiling = next ? next.newStart - 1 : totalLines;
  if (ceiling === null) return Infinity;
  return Math.max(0, ceiling - hunk.newEnd - expandedCount);
};

// The diff on screen decides which revision of the file the surrounding
// context has to come from: a single commit's diff is `sha^..sha`, so its line
// numbers index the file at `sha`, and expanding from any later revision
// (which is what the API falls back to - see its `commit` param defaulting to
// head_commit) splices in text the commit never contained. `null` means the
// cumulative base...head view, whose line numbers do index head.
export const buildContextUrl = (
  prId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  commitSha: string | null,
): string => {
  const params = new URLSearchParams({
    file: filePath,
    start: String(startLine),
    end: String(endLine),
  });
  if (commitSha) params.set('commit', commitSha);
  return `/api/prs/${prId}/context?${params.toString()}`;
};
