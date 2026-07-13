import { AuthorKind, ChangeType, CommentTargetType, LineType, PullRequestStatus } from '@/lib/enum';

export interface PullRequest {
  id: number;
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
}

// Folder tree structure for sidebar
export interface FolderNode {
  name: string;
  path: string;
  files: FileInfo[];
  children: Map<string, FolderNode>;
}

// In-progress line-range selection for a not-yet-submitted comment.
export interface CommentingAt {
  file: string;
  startLine: number;
  endLine: number;
  lineType: LineType;
}

// Anchor for shift-click range selection, tracked separately from
// `CommentingAt` because it must survive across repeated shift-clicks.
export interface LastClickedLine {
  file: string;
  hunkIndex: number;
  line: number;
  lineType: LineType;
}

// In-progress edit of an existing comment's content.
export interface EditingComment {
  uuid: string;
  content: string;
}
