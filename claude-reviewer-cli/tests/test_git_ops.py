"""Tests for the git_ops module."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest
from git import Repo

from claude_reviewer.git_ops import (
    GitOps,
    compute_commit_correspondence,
    get_file_at_commit,
    get_global_git_user,
)


def _run_git(cwd: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _commit_with_date(cwd: Path, message: str, date: str) -> str:
    """Explicit author/committer dates so two commits with identical tree +
    message + parent still get distinct SHAs (git hashes the dates too) -
    needed to simulate "the same logical commit, replayed by a rebase"
    without relying on wall-clock granularity, which real rebases bump
    anyway."""
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


@pytest.fixture
def temp_git_repo() -> Path:
    """Create a temporary git repository for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        repo_path = Path(tmpdir)
        repo = Repo.init(repo_path)

        # Configure git user for this repo
        repo.config_writer().set_value("user", "name", "Test User").release()
        repo.config_writer().set_value("user", "email", "test@example.com").release()

        # Create an initial commit
        test_file = repo_path / "test.txt"
        test_file.write_text("initial content")
        repo.index.add(["test.txt"])
        repo.index.commit("Initial commit")

        yield repo_path


@pytest.fixture
def git_ops(temp_git_repo: Path) -> GitOps:
    """Create a GitOps instance for testing."""
    return GitOps(str(temp_git_repo))


class TestGitOpsInit:
    """Tests for GitOps initialization."""

    def test_init_valid_repo(self, temp_git_repo: Path) -> None:
        """Test initializing with a valid repository."""
        git = GitOps(str(temp_git_repo))
        # Compare resolved paths due to macOS symlinks (/var -> /private/var)
        assert git.repo_path.resolve() == temp_git_repo.resolve()

    def test_init_invalid_repo(self) -> None:
        """Test initializing with an invalid repository."""
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            pytest.raises(ValueError, match="Not a git repository"),
        ):
            GitOps(tmpdir)


class TestBranchOperations:
    """Tests for branch-related operations."""

    def test_get_current_branch(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test getting current branch."""
        branch = git_ops.get_current_branch()
        # Default branch could be 'main' or 'master' depending on git config
        assert branch in ["main", "master"]

    def test_get_current_commit(self, git_ops: GitOps) -> None:
        """Test getting current commit SHA."""
        commit = git_ops.get_current_commit()
        assert len(commit) == 40  # Full SHA length
        assert all(c in "0123456789abcdef" for c in commit)

    def test_get_commit_sha(self, git_ops: GitOps) -> None:
        """Test getting commit SHA for a ref."""
        sha = git_ops.get_commit_sha("HEAD")
        assert len(sha) == 40

    def test_get_branches(self, git_ops: GitOps) -> None:
        """Test listing branches."""
        branches = git_ops.get_branches()
        assert len(branches) >= 1
        assert any(b in ["main", "master"] for b in branches)

    def test_branch_exists(self, git_ops: GitOps) -> None:
        """Test checking if branch exists."""
        current = git_ops.get_current_branch()
        assert git_ops.branch_exists(current) is True
        assert git_ops.branch_exists("nonexistent-branch") is False


class TestDiffOperations:
    """Tests for diff-related operations."""

    def test_get_diff(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test getting diff between refs."""
        # Create a new branch with changes
        repo = git_ops.repo
        original_branch = git_ops.get_current_branch()
        repo.git.checkout("-b", "feature")

        # Make a change
        test_file = temp_git_repo / "test.txt"
        test_file.write_text("modified content")
        repo.index.add(["test.txt"])
        repo.index.commit("Feature commit")

        # Get diff
        diff = git_ops.get_diff(original_branch, "feature")
        assert "modified content" in diff or "-initial content" in diff

    def test_get_diff_stat(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test getting diff statistics."""
        repo = git_ops.repo
        original_branch = git_ops.get_current_branch()
        repo.git.checkout("-b", "feature-stats")

        # Make changes
        new_file = temp_git_repo / "new_file.txt"
        new_file.write_text("new content\n")
        repo.index.add(["new_file.txt"])
        repo.index.commit("Add new file")

        stats = git_ops.get_diff_stat(original_branch, "feature-stats")
        assert "files" in stats
        assert "stat" in stats


class TestMergeOperations:
    """Tests for merge operations."""

    def test_merge_success(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test successful merge."""
        repo = git_ops.repo
        original_branch = git_ops.get_current_branch()

        # Create feature branch
        repo.git.checkout("-b", "feature-merge")
        new_file = temp_git_repo / "feature.txt"
        new_file.write_text("feature content")
        repo.index.add(["feature.txt"])
        repo.index.commit("Feature commit")

        # Go back to main and merge
        repo.git.checkout(original_branch)
        result = git_ops.merge("feature-merge", original_branch)

        assert result["success"] is True
        assert "Merged" in result["message"]

    def test_has_uncommitted_changes(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test detecting uncommitted changes."""
        assert git_ops.has_uncommitted_changes() is False

        # Make uncommitted change
        test_file = temp_git_repo / "test.txt"
        test_file.write_text("uncommitted change")

        assert git_ops.has_uncommitted_changes() is True


class TestRemoteOperations:
    """Tests for remote operations."""

    def test_get_remote_branches_no_remote(self, git_ops: GitOps) -> None:
        """Test getting remote branches when no remote exists."""
        branches = git_ops.get_remote_branches()
        assert branches == []

    def test_get_remote_url_no_remote(self, git_ops: GitOps) -> None:
        """Test getting remote URL when no remote exists."""
        url = git_ops.get_remote_url()
        assert url is None


class TestCommitHistory:
    """Tests for commit history operations."""

    def test_get_commits_between(self, git_ops: GitOps, temp_git_repo: Path) -> None:
        """Test getting commits between refs."""
        repo = git_ops.repo
        original_branch = git_ops.get_current_branch()

        # Create branch with commits
        repo.git.checkout("-b", "feature-commits")

        for i in range(3):
            file_path = temp_git_repo / f"file{i}.txt"
            file_path.write_text(f"content {i}")
            repo.index.add([f"file{i}.txt"])
            repo.index.commit(f"Commit {i}")

        commits = git_ops.get_commits_between(original_branch, "feature-commits")
        assert len(commits) == 3

        for commit in commits:
            assert "sha" in commit
            assert "short_sha" in commit
            assert "message" in commit
            assert "author" in commit
            assert "date" in commit


class TestGetGlobalGitUser:
    """Tests for get_global_git_user."""

    def test_reads_name_and_email_from_global_gitconfig(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_home:
            gitconfig = Path(tmp_home) / ".gitconfig"
            gitconfig.write_text("[user]\n\tname = Test User\n\temail = test@example.com\n")
            monkeypatch.setenv("HOME", tmp_home)

            name, email = get_global_git_user()
            assert name == "Test User"
            assert email == "test@example.com"

    def test_returns_none_when_no_global_config_exists(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_home:
            monkeypatch.setenv("HOME", tmp_home)

            name, email = get_global_git_user()
            assert name is None
            assert email is None


class TestGetFileAtCommit:
    """Tests for get_file_at_commit."""

    def test_reads_a_file_as_of_a_specific_commit(self, temp_git_repo: Path) -> None:
        sha = _run_git(temp_git_repo, ["rev-parse", "HEAD"])
        assert get_file_at_commit(temp_git_repo, sha, "test.txt") == "initial content"

    def test_returns_none_for_a_file_that_does_not_exist_at_that_commit(
        self, temp_git_repo: Path
    ) -> None:
        sha = _run_git(temp_git_repo, ["rev-parse", "HEAD"])
        assert get_file_at_commit(temp_git_repo, sha, "nope.txt") is None

    def test_returns_none_for_a_commit_that_does_not_exist(self, temp_git_repo: Path) -> None:
        assert get_file_at_commit(temp_git_repo, "0" * 40, "test.txt") is None


class TestComputeCommitCorrespondence:
    """Tests for compute_commit_correspondence."""

    def test_matches_a_pure_rebase_by_patch_id(self, temp_git_repo: Path) -> None:
        base = _run_git(temp_git_repo, ["rev-parse", "HEAD"])

        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        old_a = _commit_with_date(temp_git_repo, "add a", "2024-01-02T00:00:00")

        (temp_git_repo / "b.txt").write_text("content b\n")
        _run_git(temp_git_repo, ["add", "b.txt"])
        old_b = _commit_with_date(temp_git_repo, "add b", "2024-01-03T00:00:00")

        # Simulate a rebase: replay the same diffs/messages on top of the
        # same base, at a later date - same patch-id, different SHA.
        _run_git(temp_git_repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        new_a = _commit_with_date(temp_git_repo, "add a", "2024-02-01T00:00:00")

        (temp_git_repo / "b.txt").write_text("content b\n")
        _run_git(temp_git_repo, ["add", "b.txt"])
        new_b = _commit_with_date(temp_git_repo, "add b", "2024-02-02T00:00:00")

        assert new_a != old_a
        assert new_b != old_b

        result = compute_commit_correspondence(temp_git_repo, base, old_b, base, new_b)
        assert result["matched"] == {old_a: new_a, old_b: new_b}
        assert result["unmatched"] == []

    def test_falls_back_to_message_when_content_changed(self, temp_git_repo: Path) -> None:
        base = _run_git(temp_git_repo, ["rev-parse", "HEAD"])

        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        old_a = _commit_with_date(temp_git_repo, "add a", "2024-01-02T00:00:00")

        # Same message, different content - patch-id can't match this, only
        # the message fallback can.
        _run_git(temp_git_repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (temp_git_repo / "a.txt").write_text("content a, amended\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        new_a = _commit_with_date(temp_git_repo, "add a", "2024-02-01T00:00:00")

        result = compute_commit_correspondence(temp_git_repo, base, old_a, base, new_a)
        assert result["matched"] == {old_a: new_a}
        assert result["unmatched"] == []

    def test_leaves_a_dropped_commit_unmatched(self, temp_git_repo: Path) -> None:
        base = _run_git(temp_git_repo, ["rev-parse", "HEAD"])

        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        old_a = _commit_with_date(temp_git_repo, "add a", "2024-01-02T00:00:00")

        (temp_git_repo / "b.txt").write_text("content b\n")
        _run_git(temp_git_repo, ["add", "b.txt"])
        old_b = _commit_with_date(temp_git_repo, "add b", "2024-01-03T00:00:00")

        # Rebase that drops "add b" entirely (e.g. `rebase -i` with `drop`).
        _run_git(temp_git_repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        new_a = _commit_with_date(temp_git_repo, "add a", "2024-02-01T00:00:00")

        result = compute_commit_correspondence(temp_git_repo, base, old_b, base, new_a)
        assert result["matched"] == {old_a: new_a}
        assert result["unmatched"] == [old_b]

    def test_leaves_everything_unmatched_after_unrelated_force_push(
        self, temp_git_repo: Path
    ) -> None:
        base = _run_git(temp_git_repo, ["rev-parse", "HEAD"])

        (temp_git_repo / "a.txt").write_text("content a\n")
        _run_git(temp_git_repo, ["add", "a.txt"])
        old_a = _commit_with_date(temp_git_repo, "add a", "2024-01-02T00:00:00")

        (temp_git_repo / "b.txt").write_text("content b\n")
        _run_git(temp_git_repo, ["add", "b.txt"])
        old_b = _commit_with_date(temp_git_repo, "add b", "2024-01-03T00:00:00")

        # A completely unrelated new history on top of the same base.
        _run_git(temp_git_repo, ["-c", "advice.detachedHead=false", "checkout", base])
        (temp_git_repo / "unrelated.txt").write_text("unrelated content\n")
        _run_git(temp_git_repo, ["add", "unrelated.txt"])
        new_commit = _commit_with_date(temp_git_repo, "unrelated change", "2024-03-01T00:00:00")

        result = compute_commit_correspondence(temp_git_repo, base, old_b, base, new_commit)
        assert result["matched"] == {}
        assert sorted(result["unmatched"]) == sorted([old_a, old_b])

    def test_returns_nothing_to_do_when_old_range_has_no_commits(self, temp_git_repo: Path) -> None:
        base = _run_git(temp_git_repo, ["rev-parse", "HEAD"])
        result = compute_commit_correspondence(temp_git_repo, base, base, base, base)
        assert result["matched"] == {}
        assert result["unmatched"] == []
