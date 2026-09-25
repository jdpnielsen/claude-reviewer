import type { CommentAnchor } from './database';
import { getFileAtCommit } from './git';

// Captures the line's content plus 3 lines of context either side, at the
// blob the comment is actually being made against - the same anchor
// relocateComments() later searches for once a rebase/amend/force-push
// changes the underlying SHAs. Null if the file/line can't be read there
// (e.g. a line comment on a deleted file's old-side content that's since
// been pruned) - relocateComments() falls back to commit_sha-only
// relocation for comments with no anchor, same as it does for comments
// created before this existed.
export function captureAnchor(
  repoPath: string,
  blobSha: string,
  filePath: string,
  lineNumber: number,
): CommentAnchor | null {
  const fileContent = getFileAtCommit(repoPath, blobSha, filePath);
  if (fileContent === null) return null;

  const lines = fileContent.split('\n');
  const lineIdx = lineNumber - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  return {
    content: lines[lineIdx],
    contextBefore: lines.slice(Math.max(0, lineIdx - 3), lineIdx).join('\n'),
    contextAfter: lines.slice(lineIdx + 1, lineIdx + 4).join('\n'),
  };
}
