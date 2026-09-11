"""Integration tests for relocate_comments() - a real temp git repo (so
compute_commit_correspondence/get_file_at_commit run against actual git
plumbing) plus an isolated test database (temp_db, from conftest.py).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from claude_reviewer import database as db
from claude_reviewer.comment_relocation import relocate_comments
from claude_reviewer.models import CommentRelocationStatus


def _run_git(cwd: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _commit_with_date(cwd: Path, message: str, date: str) -> str:
    """Explicit author/committer dates so two commits with identical tree +
    message + parent still get distinct SHAs - simulates "the same logical
    commit, replayed by a rebase" deterministically.
    """
    env = {**os.environ, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
    subprocess.run(
        ["git", "commit", "-m", message],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return _run_git(cwd, ["rev-parse", "HEAD"])


def _set_anchor(comment_uuid: str, content: str, before: str, after: str) -> None:
    """Only the web app's comments route captures an anchor at creation time
    (claude_reviewer.database.add_comment has no anchor parameter - the CLI
    never creates line comments). Since the sqlite file is shared between
    both, a comment the web app created can still be relocated by a
    CLI-triggered sync - set the anchor directly here to exercise that path.
    """
    with db.get_connection() as conn:
        conn.execute(
            """
            UPDATE comments
            SET anchor_content = ?, anchor_context_before = ?, anchor_context_after = ?
            WHERE uuid = ?
            """,
            (content, before, after, comment_uuid),
        )


def _set_paired_range(comment_uuid: str, paired_line: int, paired_end_line: int) -> None:
    """Only the web app creates a paired (cross-side) comment - set it
    directly here to exercise the CLI's relocation of one.
    """
    with db.get_connection() as conn:
        conn.execute(
            """
            UPDATE comments
            SET paired_line_number = ?, paired_end_line_number = ?
            WHERE uuid = ?
            """,
            (paired_line, paired_end_line, comment_uuid),
        )


def _blob_hash(repo_path: Path, sha: str, file_path: str) -> str:
    return _run_git(repo_path, ["rev-parse", "--verify", f"{sha}:{file_path}"])


def _mark_reviewed(pr_uuid: str, file_path: str, commit_sha: str | None, content_hash: str) -> None:
    """Only the web app marks files reviewed (there is no CLI command for
    it), but the sqlite file is shared - so a mark the web app made still
    has to survive a CLI-triggered sync. Insert directly, same reasoning as
    _set_anchor above.
    """
    with db.get_connection() as conn:
        pr = conn.execute("SELECT id FROM pull_requests WHERE uuid = ?", (pr_uuid,)).fetchone()
        conn.execute(
            """
            INSERT INTO reviewed_files (pr_id, file_path, commit_sha, content_hash)
            VALUES (?, ?, ?, ?)
            """,
            (pr["id"], file_path, commit_sha, content_hash),
        )


def _reviewed_marks(pr_uuid: str) -> dict[str, tuple[str | None, str]]:
    """file_path -> (commit_sha, content_hash) for every mark on a PR."""
    with db.get_connection() as conn:
        rows = conn.execute(
            """
            SELECT rf.file_path, rf.commit_sha, rf.content_hash
            FROM reviewed_files rf
            JOIN pull_requests pr ON pr.id = rf.pr_id
            WHERE pr.uuid = ?
            """,
            (pr_uuid,),
        ).fetchall()
    return {r["file_path"]: (r["commit_sha"], r["content_hash"]) for r in rows}


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    repo_path = tmp_path / "repo"
    repo_path.mkdir()
    _run_git(repo_path, ["init"])
    _run_git(repo_path, ["config", "user.email", "test@example.com"])
    _run_git(repo_path, ["config", "user.name", "Test User"])
    return repo_path


class TestRelocateComments:
    def test_relocates_commit_message_and_line_comment_across_pure_rebase(
        self, temp_db: Path, repo: Path
    ) -> None:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        (repo / "b.txt").write_text("content b\n")
        _run_git(repo, ["add", "b.txt"])
        old_b = _commit_with_date(repo, "add b", "2024-01-03T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Relocation PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_b,
            diff="diff",
        )

        commit_message_uuid = db.add_comment(
            pr_uuid, "", 0, "nice commit", commit_sha=old_a, target_type="commit_message"
        )
        line_uuid = db.add_comment(pr_uuid, "a.txt", 2, "about line two", commit_sha=old_a)
        _set_anchor(line_uuid, "line two", "line one", "line three")

        # Simulate a rebase: replay the same diffs/messages on top of the
        # same base, at a later date - same patch-id, different SHA.
        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        new_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        (repo / "b.txt").write_text("content b\n")
        _run_git(repo, ["add", "b.txt"])
        new_b = _commit_with_date(repo, "add b", "2024-02-02T00:00:00")

        assert new_a != old_a

        relocate_comments(pr_uuid, str(repo), base, old_b, base, new_b)

        commit_message_comment = db.get_comment_by_uuid(commit_message_uuid)
        line_comment = db.get_comment_by_uuid(line_uuid)
        assert commit_message_comment is not None
        assert line_comment is not None

        assert commit_message_comment.commit_sha == new_a
        assert commit_message_comment.status == CommentRelocationStatus.ACTIVE

        assert line_comment.commit_sha == new_a
        assert line_comment.line_number == 2
        assert line_comment.status == CommentRelocationStatus.ACTIVE

        # The mapping is durable, independent of any comment - a stale
        # `?commit=` link for old_a should resolve to new_a.
        assert db.lookup_commit_relocation(pr_uuid, old_a) == new_a

    def test_relocates_line_comment_within_same_commit_when_content_shifted(
        self, temp_db: Path, repo: Path
    ) -> None:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Amend PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_a,
            diff="diff",
        )

        line_uuid = db.add_comment(pr_uuid, "a.txt", 2, "about line two", commit_sha=old_a)
        _set_anchor(line_uuid, "line two", "line one", "line three")

        # Amend: same message, but a line inserted above shifts "line two"
        # down by one - patch-id can't match this (content changed), but the
        # message fallback should, and the anchor search should re-find it.
        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("inserted line\nline one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        amended_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        relocate_comments(pr_uuid, str(repo), base, old_a, base, amended_a)

        relocated = db.get_comment_by_uuid(line_uuid)
        assert relocated is not None
        assert relocated.commit_sha == amended_a
        assert relocated.line_number == 3  # shifted down by the inserted line
        assert relocated.status == CommentRelocationStatus.ACTIVE

    def test_relocates_a_comments_paired_range_by_the_same_delta(
        self, temp_db: Path, repo: Path
    ) -> None:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Paired Range PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_a,
            diff="diff",
        )

        line_uuid = db.add_comment(pr_uuid, "a.txt", 2, "a paired comment", commit_sha=old_a)
        _set_anchor(line_uuid, "line two", "line one", "line three")
        _set_paired_range(line_uuid, 1, 1)

        # Amend: insert a line above, shifting every line - primary and
        # paired alike - down by one.
        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("inserted line\nline one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        amended_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:02")

        relocate_comments(pr_uuid, str(repo), base, old_a, base, amended_a)

        relocated = db.get_comment_by_uuid(line_uuid)
        assert relocated is not None
        assert relocated.line_number == 3
        assert relocated.paired_line_number == 2
        assert relocated.paired_end_line_number == 2
        assert relocated.status == CommentRelocationStatus.ACTIVE

    def test_orphans_comment_whose_commit_was_dropped(self, temp_db: Path, repo: Path) -> None:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("content a\n")
        _run_git(repo, ["add", "a.txt"])
        _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        (repo / "b.txt").write_text("content b\n")
        _run_git(repo, ["add", "b.txt"])
        old_b = _commit_with_date(repo, "add b", "2024-01-03T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Drop PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_b,
            diff="diff",
        )

        commit_message_uuid = db.add_comment(
            pr_uuid,
            "",
            0,
            "comment on a commit about to be dropped",
            commit_sha=old_b,
            target_type="commit_message",
        )

        # Rebase that drops "add b" entirely - only "add a" survives.
        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("content a\n")
        _run_git(repo, ["add", "a.txt"])
        surviving_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        relocate_comments(pr_uuid, str(repo), base, old_b, base, surviving_a)

        orphaned = db.get_comment_by_uuid(commit_message_uuid)
        assert orphaned is not None
        assert orphaned.commit_sha == old_b  # frozen at the last-known (now-gone) SHA
        assert orphaned.status == CommentRelocationStatus.ORPHANED
        assert db.lookup_commit_relocation(pr_uuid, old_b) is None

    def test_cli_created_comment_has_no_anchor_so_only_commit_sha_relocates(
        self, temp_db: Path, repo: Path
    ) -> None:
        """A comment the CLI itself created never has an anchor (add_comment
        has no anchor parameter) - relocation should still follow the commit
        SHA, but must leave line_number untouched since there's no anchor to
        re-search with.
        """
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("content a\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="No anchor PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_a,
            diff="diff",
        )
        line_uuid = db.add_comment(pr_uuid, "a.txt", 1, "no anchor here", commit_sha=old_a)

        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("content a\n")
        _run_git(repo, ["add", "a.txt"])
        new_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        relocate_comments(pr_uuid, str(repo), base, old_a, base, new_a)

        relocated = db.get_comment_by_uuid(line_uuid)
        assert relocated is not None
        assert relocated.commit_sha == new_a
        assert relocated.line_number == 1  # untouched - no anchor to relocate by

    def test_is_a_noop_when_the_commit_range_has_not_changed(
        self, temp_db: Path, repo: Path
    ) -> None:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("content a\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="No-op PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_a,
            diff="diff",
        )
        line_uuid = db.add_comment(pr_uuid, "a.txt", 1, "a comment", commit_sha=old_a)
        _set_anchor(line_uuid, "content a", "", "")

        relocate_comments(pr_uuid, str(repo), base, old_a, base, old_a)

        unchanged = db.get_comment_by_uuid(line_uuid)
        assert unchanged is not None
        assert unchanged.commit_sha == old_a
        assert unchanged.line_number == 1
        assert unchanged.status == CommentRelocationStatus.ACTIVE


class TestRelocateReviewedFiles:
    """A reviewed mark scoped to one commit is keyed by SHA, so before
    relocation every `claude-reviewer update` over a rebase silently reset
    them - the stored content_hash alone couldn't rescue a mark whose commit
    no longer existed under that name.
    """

    def _three_commit_repo(self, repo: Path) -> tuple[str, str, str]:
        (repo / "base.txt").write_text("base\n")
        _run_git(repo, ["add", "base.txt"])
        base = _commit_with_date(repo, "base commit", "2024-01-01T00:00:00")

        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        old_a = _commit_with_date(repo, "add a", "2024-01-02T00:00:00")

        (repo / "b.txt").write_text("content b\n")
        _run_git(repo, ["add", "b.txt"])
        old_b = _commit_with_date(repo, "add b", "2024-01-03T00:00:00")
        return base, old_a, old_b

    def test_carries_a_per_commit_mark_onto_the_rewritten_sha(
        self, temp_db: Path, repo: Path
    ) -> None:
        base, old_a, old_b = self._three_commit_repo(repo)
        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Reviewed Rebase PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_b,
            diff="diff",
        )
        _mark_reviewed(pr_uuid, "a.txt", old_a, _blob_hash(repo, old_a, "a.txt"))

        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        new_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")
        (repo / "b.txt").write_text("content b\n")
        _run_git(repo, ["add", "b.txt"])
        new_b = _commit_with_date(repo, "add b", "2024-02-02T00:00:00")
        assert new_a != old_a

        relocate_comments(pr_uuid, str(repo), base, old_b, base, new_b)

        commit_sha, content_hash = _reviewed_marks(pr_uuid)["a.txt"]
        assert commit_sha == new_a
        # Still current: the rebase moved the SHA but not a byte of a.txt,
        # which is what the web app compares to decide whether it counts.
        assert content_hash == _blob_hash(repo, new_a, "a.txt")

    def test_moves_a_mark_the_amend_rewrote_but_leaves_it_content_stale(
        self, temp_db: Path, repo: Path
    ) -> None:
        base, old_a, _ = self._three_commit_repo(repo)
        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Reviewed Amend PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_a,
            diff="diff",
        )
        _mark_reviewed(pr_uuid, "a.txt", old_a, _blob_hash(repo, old_a, "a.txt"))

        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("line one\nline two CHANGED\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        amended_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        relocate_comments(pr_uuid, str(repo), base, old_a, base, amended_a)

        commit_sha, content_hash = _reviewed_marks(pr_uuid)["a.txt"]
        assert commit_sha == amended_a
        # Relocated but no longer current - the reviewer has to look again,
        # which is what should happen when the content really did change.
        assert content_hash != _blob_hash(repo, amended_a, "a.txt")

    def test_leaves_dropped_commit_and_cumulative_marks_alone(
        self, temp_db: Path, repo: Path
    ) -> None:
        base, old_a, old_b = self._three_commit_repo(repo)
        pr_uuid = db.create_pr(
            repo_path=str(repo),
            title="Reviewed Drop PR",
            base_ref="main",
            head_ref="feature",
            base_commit=base,
            head_commit=old_b,
            diff="diff",
        )
        _mark_reviewed(pr_uuid, "b.txt", old_b, _blob_hash(repo, old_b, "b.txt"))
        _mark_reviewed(pr_uuid, "a.txt", None, _blob_hash(repo, old_b, "a.txt"))

        # Rebase that drops "add b" entirely - nothing for b.txt's mark to
        # move to.
        _run_git(repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (repo / "a.txt").write_text("line one\nline two\nline three\n")
        _run_git(repo, ["add", "a.txt"])
        surviving_a = _commit_with_date(repo, "add a", "2024-02-01T00:00:00")

        relocate_comments(pr_uuid, str(repo), base, old_b, base, surviving_a)

        marks = _reviewed_marks(pr_uuid)
        assert marks["b.txt"][0] == old_b
        # Cumulative marks were never SHA-keyed, so relocation must not
        # touch them.
        assert marks["a.txt"][0] is None
