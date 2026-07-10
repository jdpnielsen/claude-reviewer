"""SQLite database operations for Claude Reviewer.

This module provides the data persistence layer for the Claude Reviewer application,
using SQLite with WAL mode for concurrent access. It handles:

- Pull Requests: Create, read, update, delete PRs with diff snapshots
- Comments: Line-level code review comments on PRs
- Reviews: Approval/changes-requested actions on PRs
- Comment Replies: Threaded discussions on comments
- Repo Conversations: Standalone code discussions independent of PRs

Database Schema:
    - pull_requests: Core PR metadata (title, refs, commits, status)
    - diff_snapshots: Versioned diff content for each PR revision
    - comments: Line-specific review comments
    - comment_replies: Replies to comments (threaded discussion)
    - reviews: Review decisions (approve/request changes)
    - repo_conversations: File-anchored discussions outside of PRs
    - repo_conversation_messages: Messages within repo conversations

Usage:
    from claude_reviewer.database import init_db, create_pr, get_pr_by_uuid

    init_db()  # Initialize schema (safe to call multiple times)
    pr_uuid = create_pr(repo_path, title, base_ref, head_ref, ...)
    pr = get_pr_by_uuid(pr_uuid)
"""

from __future__ import annotations

import sqlite3
import uuid as uuid_lib
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .git_ops import get_global_git_user
from .models import (
    Author,
    Comment,
    CommentReply,
    PRStatus,
    PullRequest,
    RepoConversation,
    RepoConversationMessage,
    RepoConversationStatus,
    ReviewAction,
)

# Re-export for CLI
__all__ = [
    "get_unanswered_pr_comments",
    "get_unanswered_conversations",
]

if TYPE_CHECKING:
    pass


# Default database path
DEFAULT_DB_DIR = Path.home() / ".claude-reviewer"
DEFAULT_DB_PATH = DEFAULT_DB_DIR / "data.db"

# Schema SQL
SCHEMA_SQL = """
-- Pull Requests table
CREATE TABLE IF NOT EXISTS pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    repo_path TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pr_uuid ON pull_requests(uuid);
CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo_path);
CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status);

-- Diff snapshots
CREATE TABLE IF NOT EXISTS diff_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1,
    diff_content TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pr_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_diff_pr ON diff_snapshots(pr_id);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    end_line_number INTEGER,
    commit_sha TEXT,
    line_type TEXT DEFAULT 'new',
    content TEXT NOT NULL,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(pr_id, file_path);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);

-- Authors table (human + agent identities)
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);

-- Settings table (default-author pointers only, not a generic KV store)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Comment replies table
CREATE TABLE IF NOT EXISTS comment_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_replies_comment ON comment_replies(comment_id);

-- Repo-level conversations (independent of PRs)
CREATE TABLE IF NOT EXISTS repo_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    anchor_content TEXT,
    anchor_context_before TEXT,
    anchor_context_after TEXT,
    anchor_commit TEXT,
    status TEXT DEFAULT 'active',
    file_exists BOOLEAN DEFAULT TRUE,
    current_line_number INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_repo_conv_uuid ON repo_conversations(uuid);
CREATE INDEX IF NOT EXISTS idx_repo_conv_repo ON repo_conversations(repo_path);
CREATE INDEX IF NOT EXISTS idx_repo_conv_file ON repo_conversations(repo_path, file_path);
CREATE INDEX IF NOT EXISTS idx_repo_conv_status ON repo_conversations(status);

-- Repo conversation messages
CREATE TABLE IF NOT EXISTS repo_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_repo_conv_msg_conv ON repo_conversation_messages(conversation_id);
"""


def get_db_path() -> Path:
    """Get the database path, creating directory if needed."""
    DEFAULT_DB_DIR.mkdir(parents=True, exist_ok=True)
    return DEFAULT_DB_PATH


def generate_uuid() -> str:
    """Generate a short UUID for URLs."""
    return str(uuid_lib.uuid4())[:8]


@contextmanager
def get_connection(db_path: Path | None = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager for database connections."""
    path = db_path or get_db_path()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")
    try:
        yield conn
        conn.commit()
        # Checkpoint WAL to ensure data is written to main db file
        # This prevents corruption when other processes read the database
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Path | None = None) -> None:
    """Initialize database schema and apply any pending migrations."""
    with get_connection(db_path) as conn:
        _rebuild_reply_tables_if_pre_authors(conn)
        conn.executescript(SCHEMA_SQL)
        _seed_authors(conn)
        _migrate_comments_end_line(conn)
        _migrate_comments_commit_sha(conn)


def _rebuild_reply_tables_if_pre_authors(conn: sqlite3.Connection) -> None:
    """A database created before the authors table existed has
    comment_replies/repo_conversation_messages in the old author-TEXT-column
    shape. Rather than backfill (existing reply data is not preserved - see
    the design spec), drop and let SCHEMA_SQL recreate both tables in the
    new author_id-based shape.
    """
    authors_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='authors'"
    ).fetchone()
    if not authors_exists:
        conn.execute("DROP TABLE IF EXISTS comment_replies")
        conn.execute("DROP TABLE IF EXISTS repo_conversation_messages")


def _seed_authors(conn: sqlite3.Connection) -> None:
    """Seeds the one-time default agent ('claude') and default human (from
    git config, if available) rows, plus the settings pointers to them.
    Guarded so it only inserts rows/pointers that don't exist yet - safe to
    call on every init_db() call.
    """
    agent_row = conn.execute("SELECT id FROM authors WHERE kind = 'agent'").fetchone()
    if agent_row:
        agent_id = agent_row["id"]
    else:
        cursor = conn.execute("INSERT INTO authors (kind, name) VALUES ('agent', 'claude')")
        agent_id = cursor.lastrowid

    human_row = conn.execute("SELECT id FROM authors WHERE kind = 'human'").fetchone()
    if human_row:
        human_id = human_row["id"]
    else:
        name, email = get_global_git_user()
        cursor = conn.execute(
            "INSERT INTO authors (kind, name, email) VALUES ('human', ?, ?)",
            (name or "reviewer", email),
        )
        human_id = cursor.lastrowid

    has_default_agent = conn.execute(
        "SELECT 1 FROM settings WHERE key = 'default_agent_author_id'"
    ).fetchone()
    if not has_default_agent:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_agent_author_id', ?)",
            (str(agent_id),),
        )

    has_default_human = conn.execute(
        "SELECT 1 FROM settings WHERE key = 'default_human_author_id'"
    ).fetchone()
    if not has_default_human:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_human_author_id', ?)",
            (str(human_id),),
        )


def _migrate_comments_end_line(conn: sqlite3.Connection) -> None:
    """Backfill end_line_number for databases created before multi-line comments existed."""
    columns = conn.execute("PRAGMA table_info(comments)").fetchall()
    if not any(col["name"] == "end_line_number" for col in columns):
        try:
            conn.execute("ALTER TABLE comments ADD COLUMN end_line_number INTEGER")
        except sqlite3.OperationalError as e:
            # A concurrent process may have added the column between the
            # check above and this ALTER.
            if "duplicate column" not in str(e).lower():
                raise
    conn.execute("UPDATE comments SET end_line_number = line_number WHERE end_line_number IS NULL")


def _migrate_comments_commit_sha(conn: sqlite3.Connection) -> None:
    """Add commit_sha for databases created before commit-by-commit review existed.

    NULL means "scoped to the cumulative view" - correct for every pre-existing
    comment, so unlike _migrate_comments_end_line, no backfill is needed.
    """
    columns = conn.execute("PRAGMA table_info(comments)").fetchall()
    if not any(col["name"] == "commit_sha" for col in columns):
        try:
            conn.execute("ALTER TABLE comments ADD COLUMN commit_sha TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise


def _row_to_pr(row: sqlite3.Row) -> PullRequest:
    """Convert a database row to a PullRequest object."""
    return PullRequest(
        id=row["id"],
        uuid=row["uuid"],
        repo_path=row["repo_path"],
        title=row["title"],
        description=row["description"] or "",
        base_ref=row["base_ref"],
        head_ref=row["head_ref"],
        base_commit=row["base_commit"],
        head_commit=row["head_commit"],
        status=PRStatus(row["status"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_comment(row: sqlite3.Row) -> Comment:
    """Convert a database row to a Comment object."""
    return Comment(
        id=row["id"],
        uuid=row["uuid"],
        pr_id=row["pr_id"],
        file_path=row["file_path"],
        line_number=row["line_number"],
        end_line_number=row["end_line_number"],
        commit_sha=row["commit_sha"],
        line_type=row["line_type"],
        content=row["content"],
        resolved=bool(row["resolved"]),
        created_at=row["created_at"],
    )


def _row_to_author(row: sqlite3.Row) -> Author:
    """Convert a database row to an Author object."""
    return Author(
        id=row["id"],
        kind=row["kind"],
        name=row["name"],
        email=row["email"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


# =============================================================================
# Pull Request Operations
# =============================================================================


def create_pr(
    repo_path: str,
    title: str,
    base_ref: str,
    head_ref: str,
    base_commit: str,
    head_commit: str,
    diff: str,
    description: str = "",
) -> str:
    """Create a new PR and return its UUID."""
    pr_uuid = generate_uuid()

    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO pull_requests
            (uuid, repo_path, title, description, base_ref, head_ref, base_commit, head_commit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (pr_uuid, repo_path, title, description, base_ref, head_ref, base_commit, head_commit),
        )
        pr_id = cursor.lastrowid

        # Store initial diff snapshot
        conn.execute(
            """
            INSERT INTO diff_snapshots (pr_id, revision, diff_content, head_commit)
            VALUES (?, 1, ?, ?)
            """,
            (pr_id, diff, head_commit),
        )

    return pr_uuid


def get_pr_by_uuid(pr_uuid: str) -> PullRequest | None:
    """Get a PR by its UUID."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if row:
            return _row_to_pr(row)
    return None


def get_pr_by_id(pr_id: int) -> PullRequest | None:
    """Get a PR by its ID."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM pull_requests WHERE id = ?",
            (pr_id,),
        ).fetchone()

        if row:
            return _row_to_pr(row)
    return None


def list_prs(
    repo_path: str | None = None,
    status: PRStatus | None = None,
    limit: int = 50,
) -> list[PullRequest]:
    """List PRs with optional filters."""
    query = "SELECT * FROM pull_requests WHERE 1=1"
    params: list[Any] = []

    if repo_path:
        query += " AND repo_path = ?"
        params.append(repo_path)

    if status:
        query += " AND status = ?"
        params.append(status.value)

    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)

    with get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_row_to_pr(row) for row in rows]


def update_pr_status(pr_uuid: str, status: PRStatus) -> bool:
    """Update PR status."""
    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE pull_requests
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE uuid = ?
            """,
            (status.value, pr_uuid),
        )
        return bool(cursor.rowcount > 0)


def delete_pr(pr_uuid: str) -> bool:
    """Delete a PR and all associated data."""
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        )
        return bool(cursor.rowcount > 0)


def update_pr_diff(pr_uuid: str, diff: str, head_commit: str) -> int:
    """Add a new diff snapshot and return the new revision number."""
    with get_connection() as conn:
        # Get PR ID and current max revision
        pr = conn.execute(
            "SELECT id FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            raise ValueError(f"PR {pr_uuid} not found")

        pr_id = pr["id"]

        # Get max revision
        max_rev = conn.execute(
            "SELECT MAX(revision) as max_rev FROM diff_snapshots WHERE pr_id = ?",
            (pr_id,),
        ).fetchone()

        new_revision = (max_rev["max_rev"] or 0) + 1

        # Insert new snapshot
        conn.execute(
            """
            INSERT INTO diff_snapshots (pr_id, revision, diff_content, head_commit)
            VALUES (?, ?, ?, ?)
            """,
            (pr_id, new_revision, diff, head_commit),
        )

        # Update PR head commit and timestamp
        conn.execute(
            """
            UPDATE pull_requests
            SET head_commit = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (head_commit, pr_id),
        )

        return new_revision


def get_latest_diff(pr_uuid: str) -> str | None:
    """Get the latest diff content for a PR."""
    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            return None

        row = conn.execute(
            """
            SELECT diff_content FROM diff_snapshots
            WHERE pr_id = ? ORDER BY revision DESC LIMIT 1
            """,
            (pr["id"],),
        ).fetchone()

        return row["diff_content"] if row else None


# =============================================================================
# Comment Operations
# =============================================================================


def add_comment(
    pr_uuid: str,
    file_path: str,
    line_number: int,
    content: str,
    line_type: str = "new",
    end_line_number: int | None = None,
    commit_sha: str | None = None,
) -> str:
    """Add a comment to a PR and return its UUID."""
    comment_uuid = generate_uuid()
    resolved_end_line = end_line_number if end_line_number is not None else line_number

    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id, status FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            raise ValueError(f"PR {pr_uuid} not found")

        conn.execute(
            """
            INSERT INTO comments (uuid, pr_id, file_path, line_number, end_line_number, commit_sha, line_type, content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                comment_uuid,
                pr["id"],
                file_path,
                line_number,
                resolved_end_line,
                commit_sha,
                line_type,
                content,
            ),
        )

        # Update PR timestamp
        conn.execute(
            "UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (pr["id"],),
        )

    return comment_uuid


def get_comments(
    pr_uuid: str,
    unresolved_only: bool = False,
    file_path: str | None = None,
) -> list[Comment]:
    """Get comments for a PR."""
    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            return []

        query = "SELECT * FROM comments WHERE pr_id = ?"
        params: list[Any] = [pr["id"]]

        if unresolved_only:
            query += " AND resolved = FALSE"

        if file_path:
            query += " AND file_path = ?"
            params.append(file_path)

        query += " ORDER BY file_path, line_number"

        rows = conn.execute(query, params).fetchall()
        return [_row_to_comment(row) for row in rows]


def resolve_comment(comment_uuid: str, resolved: bool = True) -> bool:
    """Mark a comment as resolved or unresolved."""
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE comments SET resolved = ? WHERE uuid = ?",
            (resolved, comment_uuid),
        )
        return bool(cursor.rowcount > 0)


# =============================================================================
# Review Operations
# =============================================================================


def submit_review(
    pr_uuid: str,
    action: ReviewAction,
    summary: str | None = None,
) -> bool:
    """Submit a review for a PR."""
    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            raise ValueError(f"PR {pr_uuid} not found")

        # Insert review record
        conn.execute(
            """
            INSERT INTO reviews (pr_id, action, summary)
            VALUES (?, ?, ?)
            """,
            (pr["id"], action.value, summary),
        )

        # Update PR status
        new_status = (
            PRStatus.APPROVED if action == ReviewAction.APPROVE else PRStatus.CHANGES_REQUESTED
        )
        conn.execute(
            """
            UPDATE pull_requests
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (new_status.value, pr["id"]),
        )

        return True


def get_reviews(pr_uuid: str) -> list[dict[str, Any]]:
    """Get all reviews for a PR."""
    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            return []

        rows = conn.execute(
            """
            SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC
            """,
            (pr["id"],),
        ).fetchall()

        return [dict(row) for row in rows]


# =============================================================================
# Comment Reply Operations
# =============================================================================


def _row_to_reply(row: sqlite3.Row) -> CommentReply:
    """Convert a database row to a CommentReply object."""
    return CommentReply(
        id=row["id"],
        uuid=row["uuid"],
        comment_id=row["comment_id"],
        author_id=row["author_id"],
        author=row["author"],
        author_kind=row["author_kind"],
        content=row["content"],
        created_at=row["created_at"],
    )


def _resolve_author_id(author: str) -> int:
    """Resolve a CLI --author value (or an internal call's literal) to an
    author_id. "me" and "claude" are pointer-based sentinels; anything else
    must be an exact (case-insensitive) registered author name."""
    if author == "me":
        return get_default_human_author().id
    if author == "claude":
        return get_default_agent_author().id
    found = get_author_by_name(author)
    if not found:
        raise ValueError(
            f"Unknown author '{author}'. Run 'claude-reviewer authors list' to see "
            "registered authors, or 'claude-reviewer authors add' to register a new one."
        )
    return found.id


def add_reply(
    comment_uuid: str,
    content: str,
    author: str = "claude",
) -> str:
    """Add a reply to a comment and return its UUID."""
    reply_uuid = generate_uuid()
    author_id = _resolve_author_id(author)

    with get_connection() as conn:
        comment = conn.execute(
            "SELECT id, pr_id FROM comments WHERE uuid = ?",
            (comment_uuid,),
        ).fetchone()

        if not comment:
            raise ValueError(f"Comment {comment_uuid} not found")

        conn.execute(
            """
            INSERT INTO comment_replies (uuid, comment_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (reply_uuid, comment["id"], author_id, content),
        )

        # Update PR timestamp
        conn.execute(
            "UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (comment["pr_id"],),
        )

    return reply_uuid


def get_replies(comment_uuid: str) -> list[CommentReply]:
    """Get all replies for a comment."""
    with get_connection() as conn:
        comment = conn.execute(
            "SELECT id FROM comments WHERE uuid = ?",
            (comment_uuid,),
        ).fetchone()

        if not comment:
            return []

        rows = conn.execute(
            """
            SELECT cr.id, cr.uuid, cr.comment_id, cr.author_id,
                   a.name AS author, a.kind AS author_kind, cr.content, cr.created_at
            FROM comment_replies cr
            JOIN authors a ON a.id = cr.author_id
            WHERE cr.comment_id = ? ORDER BY cr.created_at
            """,
            (comment["id"],),
        ).fetchall()

        return [_row_to_reply(row) for row in rows]


def get_comment_by_uuid(comment_uuid: str) -> Comment | None:
    """Get a comment by its UUID."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM comments WHERE uuid = ?",
            (comment_uuid,),
        ).fetchone()

        if row:
            return _row_to_comment(row)
    return None


def get_comments_with_replies(
    pr_uuid: str,
    unresolved_only: bool = False,
) -> list[tuple[Comment, list[CommentReply]]]:
    """Get comments for a PR with their replies."""
    comments_list = get_comments(pr_uuid, unresolved_only=unresolved_only)
    result = []
    for comment in comments_list:
        replies = get_replies(comment.uuid)
        result.append((comment, replies))
    return result


# =============================================================================
# Repo Conversation Operations
# =============================================================================


def _row_to_repo_conversation(row: sqlite3.Row) -> RepoConversation:
    """Convert a database row to a RepoConversation object."""
    return RepoConversation(
        id=row["id"],
        uuid=row["uuid"],
        repo_path=row["repo_path"],
        file_path=row["file_path"],
        line_number=row["line_number"],
        anchor_content=row["anchor_content"],
        anchor_context_before=row["anchor_context_before"],
        anchor_context_after=row["anchor_context_after"],
        anchor_commit=row["anchor_commit"],
        status=RepoConversationStatus(row["status"]),
        file_exists=bool(row["file_exists"]),
        current_line_number=row["current_line_number"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_repo_message(row: sqlite3.Row) -> RepoConversationMessage:
    """Convert a database row to a RepoConversationMessage object."""
    return RepoConversationMessage(
        id=row["id"],
        uuid=row["uuid"],
        conversation_id=row["conversation_id"],
        author_id=row["author_id"],
        author=row["author"],
        author_kind=row["author_kind"],
        content=row["content"],
        created_at=row["created_at"],
    )


def _resolve_message_author_id(author_hint: str) -> int:
    """Resolve the repo-conversation author hint: 'claude' attributes to the
    default agent, anything else (including the historical default 'user')
    attributes to the default human."""
    if author_hint == "claude":
        return get_default_agent_author().id
    return get_default_human_author().id


def create_repo_conversation(
    repo_path: str,
    file_path: str,
    line_number: int,
    content: str,
    author: str = "user",
    anchor_content: str | None = None,
    anchor_context_before: str | None = None,
    anchor_context_after: str | None = None,
    anchor_commit: str | None = None,
) -> str:
    """Create a new repo conversation with initial message and return its UUID."""
    conv_uuid = generate_uuid()
    msg_uuid = generate_uuid()
    author_id = _resolve_message_author_id(author)

    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO repo_conversations
            (uuid, repo_path, file_path, line_number, anchor_content,
             anchor_context_before, anchor_context_after, anchor_commit, current_line_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conv_uuid,
                repo_path,
                file_path,
                line_number,
                anchor_content,
                anchor_context_before,
                anchor_context_after,
                anchor_commit,
                line_number,
            ),
        )
        conv_id = cursor.lastrowid

        # Add initial message
        conn.execute(
            """
            INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (msg_uuid, conv_id, author_id, content),
        )

    return conv_uuid


def get_repo_conversation(conv_uuid: str) -> RepoConversation | None:
    """Get a repo conversation by its UUID."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        ).fetchone()

        if row:
            return _row_to_repo_conversation(row)
    return None


def list_repo_conversations(
    repo_path: str,
    file_path: str | None = None,
    status: RepoConversationStatus | None = None,
) -> list[RepoConversation]:
    """List repo conversations with optional filters."""
    query = "SELECT * FROM repo_conversations WHERE repo_path = ?"
    params: list[Any] = [repo_path]

    if file_path:
        query += " AND file_path = ?"
        params.append(file_path)

    if status:
        query += " AND status = ?"
        params.append(status.value)

    query += " ORDER BY file_path, line_number"

    with get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_row_to_repo_conversation(row) for row in rows]


def update_repo_conversation_status(
    conv_uuid: str,
    status: RepoConversationStatus,
) -> bool:
    """Update a repo conversation's status."""
    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE repo_conversations
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE uuid = ?
            """,
            (status.value, conv_uuid),
        )
        return bool(cursor.rowcount > 0)


def update_repo_conversation_anchor(
    conv_uuid: str,
    current_line_number: int | None,
    file_exists: bool = True,
) -> bool:
    """Update a repo conversation's current line number and file existence."""
    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE repo_conversations
            SET current_line_number = ?, file_exists = ?, updated_at = CURRENT_TIMESTAMP
            WHERE uuid = ?
            """,
            (current_line_number, file_exists, conv_uuid),
        )
        return bool(cursor.rowcount > 0)


def delete_repo_conversation(conv_uuid: str) -> bool:
    """Delete a repo conversation and all its messages."""
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        )
        return bool(cursor.rowcount > 0)


def add_repo_conversation_message(
    conv_uuid: str,
    content: str,
    author: str = "user",
) -> str:
    """Add a message to a repo conversation and return its UUID."""
    msg_uuid = generate_uuid()
    author_id = _resolve_message_author_id(author)

    with get_connection() as conn:
        conv = conn.execute(
            "SELECT id FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        ).fetchone()

        if not conv:
            raise ValueError(f"Conversation {conv_uuid} not found")

        conn.execute(
            """
            INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (msg_uuid, conv["id"], author_id, content),
        )

        # Update conversation timestamp
        conn.execute(
            "UPDATE repo_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (conv["id"],),
        )

    return msg_uuid


def get_repo_conversation_messages(conv_uuid: str) -> list[RepoConversationMessage]:
    """Get all messages for a repo conversation."""
    with get_connection() as conn:
        conv = conn.execute(
            "SELECT id FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        ).fetchone()

        if not conv:
            return []

        rows = conn.execute(
            """
            SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id,
                   a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
            FROM repo_conversation_messages rcm
            JOIN authors a ON a.id = rcm.author_id
            WHERE rcm.conversation_id = ? ORDER BY rcm.created_at
            """,
            (conv["id"],),
        ).fetchall()

        return [_row_to_repo_message(row) for row in rows]


def get_repo_conversation_with_messages(
    conv_uuid: str,
) -> tuple[RepoConversation, list[RepoConversationMessage]] | None:
    """Get a repo conversation with all its messages."""
    conv = get_repo_conversation(conv_uuid)
    if not conv:
        return None
    messages = get_repo_conversation_messages(conv_uuid)
    return (conv, messages)


def get_unanswered_conversations(
    repo_path: str,
) -> list[tuple[RepoConversation, list[RepoConversationMessage]]]:
    """Get active conversations where the last message is not from Claude."""
    conversations = list_repo_conversations(repo_path, status=RepoConversationStatus.ACTIVE)
    unanswered = []

    for conv in conversations:
        messages = get_repo_conversation_messages(conv.uuid)
        if messages and messages[-1].author_kind != "agent":
            unanswered.append((conv, messages))

    return unanswered


def get_unanswered_pr_comments(
    repo_path: str | None = None,
) -> list[tuple[PullRequest, Comment, list[CommentReply]]]:
    """Get PR comments where the last reply is not from Claude (or no replies yet).

    Returns tuples of (PR, Comment, Replies) for comments needing a response.
    Watches ALL PRs including merged ones (users may still leave comments).
    """
    unanswered = []

    # Get all PRs (including merged - users may still comment)
    prs = list_prs(repo_path=repo_path)

    for pr in prs:
        comments_with_replies = get_comments_with_replies(pr.uuid)
        for comment, replies in comments_with_replies:
            # Comment needs response if:
            # 1. No replies at all, OR
            # 2. Last reply is not from Claude
            if not replies or replies[-1].author_kind != "agent":
                unanswered.append((pr, comment, replies))

    return unanswered


# =============================================================================
# Author Operations
# =============================================================================


def get_setting(key: str) -> str | None:
    """Get a setting value by key, or None if unset."""
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    """Upsert a setting value."""
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (key, value),
        )


def list_authors() -> list[Author]:
    """List all registered authors, ordered by kind then name."""
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM authors ORDER BY kind, name").fetchall()
        return [_row_to_author(row) for row in rows]


def get_author_by_id(author_id: int) -> Author | None:
    """Get an author by id."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row) if row else None


def get_author_by_name(name: str) -> Author | None:
    """Get an author by name, case-insensitive."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM authors WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        return _row_to_author(row) if row else None


def get_default_human_author() -> Author:
    """Get the current default human author. Raises if none is configured."""
    author_id = get_setting("default_human_author_id")
    author = get_author_by_id(int(author_id)) if author_id else None
    if not author:
        raise ValueError("No default human author configured")
    return author


def get_default_agent_author() -> Author:
    """Get the current default agent author. Raises if none is configured."""
    author_id = get_setting("default_agent_author_id")
    author = get_author_by_id(int(author_id)) if author_id else None
    if not author:
        raise ValueError("No default agent author configured")
    return author


def create_author(kind: str, name: str, email: str | None = None) -> Author:
    """Create a new author. Raises ValueError on a duplicate (case-insensitive) name."""
    with get_connection() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO authors (kind, name, email) VALUES (?, ?, ?)",
                (kind, name, email),
            )
            author_id = cursor.lastrowid
        except sqlite3.IntegrityError as e:
            if "UNIQUE constraint failed" in str(e):
                raise ValueError(f'An author named "{name}" already exists') from e
            raise
        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row)


def update_author(author_id: int, name: str | None = None, email: str | None = None) -> Author:
    """Update an author's name/email. kind is never editable."""
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        if not existing:
            raise ValueError(f"Author {author_id} not found")

        new_name = name if name is not None else existing["name"]
        new_email = email if email is not None else existing["email"]

        try:
            conn.execute(
                "UPDATE authors SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_name, new_email, author_id),
            )
        except sqlite3.IntegrityError as e:
            if "UNIQUE constraint failed" in str(e):
                raise ValueError(f'An author named "{new_name}" already exists') from e
            raise

        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row)


def delete_author(author_id: int) -> None:
    """Delete an author. Raises ValueError if referenced by any reply/message
    or if it's the current default for its kind."""
    with get_connection() as conn:
        author_row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        if not author_row:
            raise ValueError(f"Author {author_id} not found")
        author = _row_to_author(author_row)

        reply_count = conn.execute(
            "SELECT COUNT(*) as count FROM comment_replies WHERE author_id = ?", (author_id,)
        ).fetchone()["count"]
        message_count = conn.execute(
            "SELECT COUNT(*) as count FROM repo_conversation_messages WHERE author_id = ?",
            (author_id,),
        ).fetchone()["count"]
        total_references = reply_count + message_count
        if total_references > 0:
            plural = "reply" if total_references == 1 else "replies"
            raise ValueError(f'Cannot delete "{author.name}" - referenced by {total_references} {plural}')

        default_key = "default_human_author_id" if author.kind == "human" else "default_agent_author_id"
        current_default = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (default_key,)
        ).fetchone()
        if current_default and current_default["value"] == str(author_id):
            raise ValueError(
                f'Cannot delete "{author.name}" - it\'s the current default {author.kind}. '
                "Set a different default first."
            )

        conn.execute("DELETE FROM authors WHERE id = ?", (author_id,))


def set_default_author(author_id: int) -> None:
    """Make this author the default for its kind."""
    author = get_author_by_id(author_id)
    if not author:
        raise ValueError(f"Author {author_id} not found")
    key = "default_human_author_id" if author.kind == "human" else "default_agent_author_id"
    set_setting(key, str(author_id))
