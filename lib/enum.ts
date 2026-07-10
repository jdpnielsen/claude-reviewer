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
