import { AuthorKind, ChangeType, CommentTargetType, LineType, PullRequestStatus } from '@/lib/enum';

export interface PullRequest {
  uuid: string;
  repo_path: string;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  status: PullRequestStatus;
  created_at: string;
  updated_at: string;
}

export interface CommentReply {
  id: number;
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

export interface Comment {
  id: number;
  uuid: string;
  file_path: string;
  line_number: number;
  end_line_number: number;
  commit_sha: string | null;
  target_type: CommentTargetType;
  line_type: LineType;
  content: string;
  resolved: boolean;
  created_at: string;
  // Old-side range, when this comment spans an adjacent deleted+added line
  // pair. NULL for an ordinary single-side comment.
  paired_line_number: number | null;
  paired_end_line_number: number | null;
  // Captured at creation time against the blob the comment was actually made
  // on (see captureAnchor in the comments API route) - the same fields
  // relocateComments() searches for after a rebase/amend/force-push. Used to
  // try to place a commit-specific comment inline in the cumulative diff too
  // - see findAnchorMatchInDiff.
  anchor_content: string | null;
  anchor_context_before: string | null;
  anchor_context_after: string | null;
}

export interface CommentWithReplies {
  comment: Comment;
  replies: CommentReply[];
}

export interface FileInfo {
  path: string;
  changeType: ChangeType;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  body: string;
  author: string;
  date: string;
}

export interface PRData {
  pr: PullRequest;
  diff: string;
  files: FileInfo[];
  comments: CommentWithReplies[];
  commits: CommitInfo[];
  // False when the PR's repo_path no longer exists (throwaway worktree
  // removed, clone moved), in which case `diff` is the stored snapshot and
  // `commits` is empty - nothing git-backed can be recomputed. The page
  // degrades to a read-and-delete view rather than erroring out.
  repoAvailable: boolean;
}

// Folder tree structure for sidebar
export interface FolderNode {
  name: string;
  path: string;
  files: FileInfo[];
  children: Map<string, FolderNode>;
}

// In-progress line-range selection for a not-yet-submitted comment.
// `pairedStartLine`/`pairedEndLine` (always Old-side, since `lineType` is
// always New whenever they're set) are populated by a shift-click across an
// adjacent deleted+added line pair - see getCrossSideRange.
export interface CommentingAt {
  file: string;
  startLine: number;
  endLine: number;
  lineType: LineType;
  pairedStartLine?: number;
  pairedEndLine?: number;
}

// Anchor for shift-click range selection, tracked separately from
// `CommentingAt` because it must survive across repeated shift-clicks.
// `rowIdx` is this line's position in the file's parsed diffLines array,
// used to detect whether a cross-side shift-click lands in the same
// contiguous change block as the anchor (see getCrossSideRange).
export interface LastClickedLine {
  file: string;
  hunkIndex: number;
  line: number;
  lineType: LineType;
  rowIdx: number;
}

// In-progress edit of an existing comment's content.
export interface EditingComment {
  uuid: string;
  content: string;
}
