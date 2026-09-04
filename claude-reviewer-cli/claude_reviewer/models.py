"""Data models for Claude Reviewer."""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional


class PRStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    MERGED = "merged"
    CLOSED = "closed"


class ReviewAction(str, Enum):
    APPROVE = "approve"
    REQUEST_CHANGES = "request_changes"
    COMMENT = "comment"


class CommentRelocationStatus(str, Enum):
    """Whether a comment's commit/line coordinates still resolve after a
    rebase/amend/force-push, distinct from the reviewer-facing `resolved`
    (thread addressed) flag on the same table."""

    ACTIVE = "active"
    ORPHANED = "orphaned"


class CommentResolutionMode(str, Enum):
    """How the commenter expects their feedback to be handled - set once
    when the comment is written (from the web UI; the CLI never creates
    comments itself), and surfaced via `comments`/`comments -f json` so
    Claude doesn't always treat a comment as a mandate to change code."""

    FIX = "fix"
    DISCUSS = "discuss"
    FIX_IF_AGREED = "fix_if_agreed"


@dataclass
class PullRequest:
    id: int
    uuid: str
    repo_path: str
    title: str
    base_ref: str
    head_ref: str
    status: PRStatus = PRStatus.PENDING
    description: str = ""
    base_commit: str = ""
    head_commit: str = ""
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class Comment:
    id: int
    uuid: str
    pr_id: int
    file_path: str
    line_number: int
    end_line_number: int
    content: str
    commit_sha: Optional[str] = None
    target_type: str = "line"
    resolved: bool = False
    resolution_mode: CommentResolutionMode = CommentResolutionMode.FIX
    line_type: str = "new"
    anchor_content: Optional[str] = None
    anchor_context_before: Optional[str] = None
    anchor_context_after: Optional[str] = None
    status: CommentRelocationStatus = CommentRelocationStatus.ACTIVE
    created_at: Optional[datetime] = None
    # Old-side range, when this comment spans an adjacent deleted+added line
    # pair created in the web UI (shift-click across the gutter). NULL for an
    # ordinary single-side comment. The CLI never creates one of these itself.
    paired_line_number: Optional[int] = None
    paired_end_line_number: Optional[int] = None
    # Which review action produced this comment, for a target_type
    # "review_summary" comment - "approve" or "request_changes". None for
    # every other comment. The CLI never creates one of these itself; reviews
    # are only submitted from the web UI.
    review_action: Optional[str] = None


@dataclass
class CommitRelocation:
    """Durable "this SHA used to mean that SHA" mapping for a PR, built up by
    relocate_comments() on every sync. Lets a stale `?commit=<old sha>` link
    (and any comment's commit_sha) resolve to where that commit ended up after
    a rebase/amend/force-push, without walking a chain of intermediate syncs -
    see upsert_commit_relocation, which collapses chains eagerly on write."""

    id: int
    pr_id: int
    old_sha: str
    new_sha: str
    created_at: Optional[datetime] = None


@dataclass
class UpdatePRDiffResult:
    """Return value of update_pr_diff(): the new revision number, plus the
    base/head commits pull_requests held just before this call overwrote
    them - callers pass these into relocate_comments() alongside the new
    commits to re-anchor anything keyed to the old SHAs."""

    revision: int
    old_base_commit: str
    old_head_commit: str


@dataclass
class CommentRelocationUpdate:
    """A relocated comment's new coordinates, computed by
    relocate_comments() and applied in one shot. Always the full set of
    fields (not a partial update) - the caller always resolves a definite
    value (even "unchanged") for each, so there's no ambiguity about which
    fields a given call touches."""

    comment_id: int
    commit_sha: Optional[str]
    file_path: str
    line_number: int
    end_line_number: int
    status: CommentRelocationStatus
    paired_line_number: Optional[int] = None
    paired_end_line_number: Optional[int] = None


@dataclass
class Review:
    id: int
    pr_id: int
    action: ReviewAction
    summary: Optional[str] = None
    created_at: Optional[datetime] = None


@dataclass
class DiffSnapshot:
    id: int
    pr_id: int
    revision: int
    diff_content: str
    head_commit: str
    created_at: Optional[datetime] = None


@dataclass
class CommentReply:
    id: int
    uuid: str
    comment_id: int
    author_id: int
    author: str
    author_kind: str  # "human" | "agent"
    content: str
    created_at: Optional[datetime] = None


@dataclass
class Author:
    id: int
    kind: str  # "human" | "agent"
    name: str
    email: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class RepoConversationStatus(str, Enum):
    ACTIVE = "active"
    ORPHANED = "orphaned"
    RESOLVED = "resolved"


@dataclass
class RepoConversation:
    """A conversation thread attached to a specific line in a file."""

    id: int
    uuid: str
    repo_path: str
    file_path: str
    line_number: int
    anchor_content: Optional[str] = None
    anchor_context_before: Optional[str] = None
    anchor_context_after: Optional[str] = None
    anchor_commit: Optional[str] = None
    status: RepoConversationStatus = RepoConversationStatus.ACTIVE
    file_exists: bool = True
    current_line_number: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class RepoConversationMessage:
    """A message within a repo conversation thread."""

    id: int
    uuid: str
    conversation_id: int
    author_id: int
    author: str
    author_kind: str  # "human" | "agent"
    content: str
    created_at: Optional[datetime] = None
