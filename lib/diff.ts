import { ChangeType } from './enum';

export interface DiffFileInfo {
  path: string;
  oldPath?: string;
  changeType: ChangeType;
  additions: number;
  deletions: number;
}

// Parses a unified diff (as produced by getCommitDiff/getRefDiff/getLatestDiff)
// into per-file info - shared by anything that needs to know which files a
// diff touches, rather than each caller re-deriving its own `diff --git a/X
// b/Y` header regex.
export function parseDiffFiles(diff: string): DiffFileInfo[] {
  const files: DiffFileInfo[] = [];

  // Split by diff headers
  const diffParts = diff.split(/^diff --git /m).filter(Boolean);

  for (const part of diffParts) {
    const lines = part.split('\n');
    const headerLine = lines[0];

    // Git's extended header - mode, rename, index lines - is everything above
    // the first hunk. Only that part says what happened to the file; below
    // it, a content row can contain any text at all, including a line that
    // reads "new file mode" or starts with "+++".
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    const header = firstHunk < 0 ? lines.slice(1) : lines.slice(1, firstHunk);
    const hunkLines = firstHunk < 0 ? [] : lines.slice(firstHunk);
    const headerValue = (prefix: string) =>
      header.find((l) => l.startsWith(prefix))?.slice(prefix.length);

    // `rename from`/`rename to` are unambiguous; the `a/X b/Y` line can't be
    // split reliably when a path itself contains " b/".
    const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/);
    const renameFrom = headerValue('rename from ');
    const renameTo = headerValue('rename to ');
    if (!pathMatch && !(renameFrom && renameTo)) continue;

    const oldPath = renameFrom ?? pathMatch![1];
    const newPath = renameTo ?? pathMatch![2];

    let changeType: ChangeType = ChangeType.Modified;
    if (headerValue('new file mode ') !== undefined) {
      changeType = ChangeType.Added;
    } else if (headerValue('deleted file mode ') !== undefined) {
      changeType = ChangeType.Deleted;
    } else if (oldPath !== newPath) {
      changeType = ChangeType.Renamed;
    }

    // Inside a hunk every row is exactly one of context/+/-, so a row that
    // starts "+++" is an added line whose text starts "++".
    let additions = 0;
    let deletions = 0;
    for (const line of hunkLines) {
      if (line.startsWith('+')) {
        additions++;
      } else if (line.startsWith('-')) {
        deletions++;
      }
    }

    files.push({
      path: newPath,
      oldPath: changeType === ChangeType.Renamed ? oldPath : undefined,
      changeType,
      additions,
      deletions,
    });
  }

  return files;
}
