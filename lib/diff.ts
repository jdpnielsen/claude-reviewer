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

    // Extract file paths from header: a/path b/path
    const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/);
    if (!pathMatch) continue;

    const oldPath = pathMatch[1];
    const newPath = pathMatch[2];

    // Determine change type
    let changeType: ChangeType = ChangeType.Modified;
    if (part.includes('new file mode')) {
      changeType = ChangeType.Added;
    } else if (part.includes('deleted file mode')) {
      changeType = ChangeType.Deleted;
    } else if (oldPath !== newPath) {
      changeType = ChangeType.Renamed;
    }

    // Count additions and deletions
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
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
