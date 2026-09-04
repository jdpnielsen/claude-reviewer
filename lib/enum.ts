export const AuthorKind = {
  Human: 'human',
  Agent: 'agent',
} as const;
export type AuthorKind = (typeof AuthorKind)[keyof typeof AuthorKind];

export const PullRequestStatus = {
  Pending: 'pending',
  Approved: 'approved',
  ChangesRequested: 'changes_requested',
  Merged: 'merged',
  Closed: 'closed',
} as const;
export type PullRequestStatus = (typeof PullRequestStatus)[keyof typeof PullRequestStatus];

export const ConversationStatus = {
  Active: 'active',
  Orphaned: 'orphaned',
  Resolved: 'resolved',
} as const;
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const LineType = {
  Old: 'old',
  New: 'new',
  Context: 'context',
} as const;
export type LineType = (typeof LineType)[keyof typeof LineType];

export const CommentTargetType = {
  Line: 'line',
  CommitMessage: 'commit_message',
} as const;
export type CommentTargetType = (typeof CommentTargetType)[keyof typeof CommentTargetType];

// How the commenter expects their feedback to be handled - set once when the
// comment is written, since that's when the reviewer actually knows which of
// these they mean. Surfaced to Claude via `claude-reviewer comments` so it
// doesn't always treat a comment as a mandate to change code.
export const CommentResolutionMode = {
  // Just implement it.
  Fix: 'fix',
  // Don't change code yet - reply with a question/counterpoint first.
  Discuss: 'discuss',
  // Implement it if you agree; otherwise reply with why not and leave it
  // unresolved for the reviewer.
  FixIfAgreed: 'fix_if_agreed',
} as const;
export type CommentResolutionMode =
  (typeof CommentResolutionMode)[keyof typeof CommentResolutionMode];

// Whether a comment's commit/line coordinates still resolve after a
// rebase/amend/force-push, distinct from the reviewer-facing `resolved`
// (thread addressed) flag on the same table.
export const CommentRelocationStatus = {
  Active: 'active',
  Orphaned: 'orphaned',
} as const;
export type CommentRelocationStatus =
  (typeof CommentRelocationStatus)[keyof typeof CommentRelocationStatus];

export const ChangeType = {
  Added: 'added',
  Modified: 'modified',
  Deleted: 'deleted',
  Renamed: 'renamed',
} as const;
export type ChangeType = (typeof ChangeType)[keyof typeof ChangeType];

export const ReviewAction = {
  Approve: 'approve',
  RequestChanges: 'request_changes',
  Comment: 'comment',
} as const;
export type ReviewAction = (typeof ReviewAction)[keyof typeof ReviewAction];
