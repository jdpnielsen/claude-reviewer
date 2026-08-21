import { execFileSync } from 'child_process';

import {
  applyCommentRelocations,
  getComments,
  upsertCommitRelocation,
  type Comment,
  type CommentRelocationUpdate,
} from './database';
import { CommentRelocationStatus, CommentTargetType, LineType } from './enum';
import {
  computeCommitCorrespondence,
  getFileAtCommit,
  resolveRepoPath,
  type CommitCorrespondence,
} from './git';

const SEARCH_RADIUS = 50;

// Mirrors relocateAnchor in app/api/browse/file/route.ts (same three-tier
// search: exact original line, then a +/- searchRadius exact match, then a
// context-window match), generalized to a plain line array instead of a
// RepoConversationWithMessages - this is a different domain (a git blob at a
// specific commit, not a live working-tree file) so the code isn't shared,
// but the algorithm and radius are kept identical for consistency.
function relocateLine(
  anchorContent: string,
  originalLine: number,
  contextBefore: string | null,
  contextAfter: string | null,
  lines: string[],
): number | null {
  const anchorTrimmed = anchorContent.trim();

  if (originalLine > 0 && originalLine <= lines.length) {
    if (lines[originalLine - 1].trim() === anchorTrimmed) return originalLine;
  }

  const startSearch = Math.max(0, originalLine - SEARCH_RADIUS);
  const endSearch = Math.min(lines.length, originalLine + SEARCH_RADIUS);

  for (let i = startSearch; i < endSearch; i++) {
    if (lines[i].trim() === anchorTrimmed) return i + 1;
  }

  const beforeLines = contextBefore ? contextBefore.split('\n').map((l) => l.trim()) : [];
  const afterLines = contextAfter ? contextAfter.split('\n').map((l) => l.trim()) : [];

  if (beforeLines.length > 0 || afterLines.length > 0) {
    for (let i = startSearch; i < endSearch; i++) {
      let matches = true;

      for (let j = 0; j < beforeLines.length && matches; j++) {
        const checkIdx = i - beforeLines.length + j;
        if (checkIdx < 0 || checkIdx >= lines.length || lines[checkIdx].trim() !== beforeLines[j]) {
          matches = false;
        }
      }

      for (let j = 0; j < afterLines.length && matches; j++) {
        const checkIdx = i + 1 + j;
        if (checkIdx >= lines.length || lines[checkIdx].trim() !== afterLines[j]) {
          matches = false;
        }
      }

      if (matches) return i + 1;
    }
  }

  return null;
}

// The commit reference a comment's line_number is measured against: the
// "old" side of a diff is the parent tree (base, or commitSha^ when scoped
// to a single commit); everything else (line_type 'new', or the legacy
// 'context' value - see FileDiffCard, which only ever writes 'old'/'new')
// is the "new" side.
function blobRef(commitSha: string | null, base: string, head: string, lineType: LineType): string {
  if (commitSha) return lineType === LineType.Old ? `${commitSha}^` : commitSha;
  return lineType === LineType.Old ? base : head;
}

// Best-effort rename detection when the file isn't found at its stored path
// in the new blob - `git diff -M` between the two blob references, scoped to
// this path so unrelated changes elsewhere in the tree don't matter.
function resolveRenamedPath(
  repoPath: string,
  oldRef: string,
  newRef: string,
  filePath: string,
): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    const output = execFileSync(
      'git',
      ['diff', '--no-color', '-M', '--name-status', oldRef, newRef, '--', filePath],
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    for (const line of output.trim().split('\n')) {
      if (!line.startsWith('R')) continue;
      const parts = line.split('\t');
      if (parts.length === 3 && parts[1] === filePath) return parts[2];
    }
  } catch {
    // Not a rename (or the ref pair doesn't resolve) - caller treats null as
    // "couldn't find where this path went."
  }
  return null;
}

function orphanUpdate(comment: Comment, commitSha: string | null): CommentRelocationUpdate | null {
  if (comment.status === CommentRelocationStatus.Orphaned && commitSha === comment.commit_sha) {
    return null;
  }
  return {
    commentId: comment.id,
    commitSha,
    filePath: comment.file_path,
    lineNumber: comment.line_number,
    endLineNumber: comment.end_line_number,
    status: CommentRelocationStatus.Orphaned,
    pairedLineNumber: comment.paired_line_number,
    pairedEndLineNumber: comment.paired_end_line_number,
  };
}

function planRelocation(
  comment: Comment,
  repoPath: string,
  correspondence: CommitCorrespondence,
  oldBase: string,
  oldHead: string,
  newBase: string,
  newHead: string,
): CommentRelocationUpdate | null {
  const { matched, unmatched } = correspondence;

  // Commit-message comments: SHA-only relocation, no file/line involved.
  if (comment.target_type === CommentTargetType.CommitMessage) {
    if (!comment.commit_sha) return null; // shouldn't happen, nothing to relocate
    const newSha = matched.get(comment.commit_sha);
    if (newSha) {
      if (newSha === comment.commit_sha && comment.status === CommentRelocationStatus.Active)
        return null;
      return {
        commentId: comment.id,
        commitSha: newSha,
        filePath: comment.file_path,
        lineNumber: comment.line_number,
        endLineNumber: comment.end_line_number,
        status: CommentRelocationStatus.Active,
        pairedLineNumber: comment.paired_line_number,
        pairedEndLineNumber: comment.paired_end_line_number,
      };
    }
    if (unmatched.includes(comment.commit_sha)) return orphanUpdate(comment, comment.commit_sha);
    return null; // this comment's commit wasn't part of the range just synced - leave as-is
  }

  // Line comment. Resolve the commit_sha side first, if it's scoped to one.
  let targetCommitSha: string | null = comment.commit_sha;
  if (comment.commit_sha) {
    const newSha = matched.get(comment.commit_sha);
    if (newSha) {
      targetCommitSha = newSha;
    } else if (unmatched.includes(comment.commit_sha)) {
      return orphanUpdate(comment, comment.commit_sha);
    } else {
      return null; // outside this sync's range - leave as-is
    }
  }

  // No stored anchor (a comment from before this feature existed) - only the
  // commit_sha move (if any) applies; line_number is left untouched.
  if (!comment.anchor_content) {
    if (targetCommitSha === comment.commit_sha) return null;
    return {
      commentId: comment.id,
      commitSha: targetCommitSha,
      filePath: comment.file_path,
      lineNumber: comment.line_number,
      endLineNumber: comment.end_line_number,
      status: comment.status,
      pairedLineNumber: comment.paired_line_number,
      pairedEndLineNumber: comment.paired_end_line_number,
    };
  }

  const oldRef = blobRef(comment.commit_sha, oldBase, oldHead, comment.line_type);
  const newRef = blobRef(targetCommitSha, newBase, newHead, comment.line_type);

  let effectiveFilePath = comment.file_path;
  let fileContent = getFileAtCommit(repoPath, newRef, comment.file_path);
  if (fileContent === null) {
    const renamedPath = resolveRenamedPath(repoPath, oldRef, newRef, comment.file_path);
    if (renamedPath) {
      const renamedContent = getFileAtCommit(repoPath, newRef, renamedPath);
      if (renamedContent !== null) {
        fileContent = renamedContent;
        effectiveFilePath = renamedPath;
      }
    }
  }

  if (fileContent === null) return orphanUpdate(comment, targetCommitSha);

  const newLineNumber = relocateLine(
    comment.anchor_content,
    comment.line_number,
    comment.anchor_context_before,
    comment.anchor_context_after,
    fileContent.split('\n'),
  );

  if (newLineNumber === null) return orphanUpdate(comment, targetCommitSha);

  if (
    newLineNumber === comment.line_number &&
    effectiveFilePath === comment.file_path &&
    targetCommitSha === comment.commit_sha &&
    comment.status === CommentRelocationStatus.Active
  ) {
    return null; // nothing actually moved
  }

  const delta = newLineNumber - comment.line_number;
  return {
    commentId: comment.id,
    commitSha: targetCommitSha,
    filePath: effectiveFilePath,
    lineNumber: newLineNumber,
    endLineNumber: comment.end_line_number + delta,
    status: CommentRelocationStatus.Active,
    // Not independently re-anchored (see the Comment.paired_line_number
    // doc comment) - shifted by the same delta as the primary range, which
    // is correct as long as the whole adjacent pair moved together.
    pairedLineNumber:
      comment.paired_line_number === null ? null : comment.paired_line_number + delta,
    pairedEndLineNumber:
      comment.paired_end_line_number === null ? null : comment.paired_end_line_number + delta,
  };
}

/**
 * Re-anchors a PR's comments after a sync (rebase/amend/force-push) changed
 * commit SHAs and/or shifted line content. Called from every place that
 * rewrites `pull_requests.head_commit`/`base_commit` (the web sync route,
 * the CLI's `update` command, and its two AI-auto-sync call sites) with the
 * OLD commit range (captured just before the overwrite) and the NEW one.
 *
 * No-op sync (nothing actually changed) is skipped entirely - this runs on
 * every poll-triggered auto-sync, most of which find no new commits.
 */
export function relocateComments(
  prUuid: string,
  repoPath: string,
  oldBase: string,
  oldHead: string,
  newBase: string,
  newHead: string,
): void {
  if (oldBase === newBase && oldHead === newHead) return;

  const correspondence = computeCommitCorrespondence(repoPath, oldBase, oldHead, newBase, newHead);

  for (const [oldSha, newSha] of correspondence.matched) {
    if (oldSha !== newSha) upsertCommitRelocation(prUuid, oldSha, newSha);
  }

  const comments = getComments(prUuid);
  if (comments.length === 0) return;

  const updates: CommentRelocationUpdate[] = [];
  for (const comment of comments) {
    const update = planRelocation(
      comment,
      repoPath,
      correspondence,
      oldBase,
      oldHead,
      newBase,
      newHead,
    );
    if (update) updates.push(update);
  }

  applyCommentRelocations(updates);
}
