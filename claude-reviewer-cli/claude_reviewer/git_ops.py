"""Git operations for Claude Reviewer."""

from __future__ import annotations

import contextlib
import subprocess
from pathlib import Path
from typing import TypedDict

from git import GitCommandError, Repo
from git.exc import BadName, BadObject


def get_global_git_user() -> tuple[str | None, str | None]:
    """Read the machine's global git user.name/user.email, if configured.

    Not tied to any specific repository - reflects whatever `git config
    --global` resolves to, independent of GitOps' repo-scoped operations.
    """
    return (_try_global_git_config("user.name"), _try_global_git_config("user.email"))


def _try_global_git_config(key: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--get", key],
            capture_output=True,
            text=True,
            check=True,
        )
        value = result.stdout.strip()
        return value or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def get_file_at_commit(repo_path: str | Path, sha: str, file_path: str) -> str | None:
    """Read a file's content as of a specific commit (`git show sha:path`)."""
    try:
        result = subprocess.run(
            ["git", "show", f"{sha}:{file_path}"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    except subprocess.CalledProcessError:
        # The file doesn't exist at this commit (added later, deleted,
        # renamed, or the commit itself no longer exists) - None means
        # "nothing to anchor against here" (mirrors lib/git.ts's
        # getFileAtCommit convention).
        return None


class CommitCorrespondence(TypedDict):
    """matched: old sha -> new sha. unmatched: old shas nothing could be
    matched to (dropped, squashed away, or a split this couldn't safely
    attribute to one side)."""

    matched: dict[str, str]
    unmatched: list[str]


_FIELD_SEP = "\x1f"


def _list_commit_shas(repo_path: str | Path, range_: str) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "log", "--reverse", "--format=%H", range_],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError:
        return []
    return [line for line in result.stdout.splitlines() if line]


def _compute_patch_ids(repo_path: str | Path, range_: str) -> dict[str, str]:
    """`git log -p <range> | git patch-id --stable`, piped through Python
    instead of a shell. Each output line is `<patch-id> <commit-sha>` -
    patch-id hashes a commit's diff content only, so it survives being
    replayed onto a different base (a pure rebase), unlike the commit's own
    SHA. Returns sha -> patch-id.
    """
    try:
        log = subprocess.run(
            ["git", "log", "-p", "--no-color", "--reverse", range_],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except subprocess.CalledProcessError:
        return {}
    if not log.strip():
        return {}

    patch_id_output = subprocess.run(
        ["git", "patch-id", "--stable"],
        cwd=repo_path,
        input=log,
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    by_sha: dict[str, str] = {}
    for line in patch_id_output.strip().splitlines():
        parts = line.split()
        if len(parts) >= 2:
            patch_id, sha = parts[0], parts[1]
            by_sha[sha] = patch_id
    return by_sha


def _compute_messages(repo_path: str | Path, range_: str) -> dict[str, str]:
    """sha -> subject+body, for commit-message-based fallback matching."""
    try:
        result = subprocess.run(
            ["git", "log", "-z", "--reverse", f"--format=%H{_FIELD_SEP}%s{_FIELD_SEP}%b", range_],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError:
        return {}
    messages: dict[str, str] = {}
    for record in result.stdout.split("\0"):
        if not record:
            continue
        parts = record.split(_FIELD_SEP)
        if len(parts) >= 3:
            sha, subject, body = parts[0], parts[1], parts[2]
            messages[sha] = f"{subject}\n{body}"
    return messages


def compute_commit_correspondence(
    repo_path: str | Path,
    old_base: str,
    old_head: str,
    new_base: str,
    new_head: str,
) -> CommitCorrespondence:
    """Match commits from an old `old_base..old_head` range to their
    counterparts in a new `new_base..new_head` range after a
    rebase/amend/force-push, so callers can relocate anything keyed to the
    old SHAs (comments, `commit_relocations` rows). Two-tier, in order,
    greedy and deterministic (oldest-first, per each range's own commit
    order) - no positional/index-based fallback, so a commit split into
    several (or dropped outright) is left unmatched rather than guessed at:

    1. Patch-id: survives a pure rebase/reorder (diff content unchanged).
    2. Commit message: catches an amend that changed the diff but kept the
       message.

    `old_shas` (from a plain commit listing, not the patch-id/message passes)
    is the ground truth for which old commits need an answer - if patch-id
    computation fails outright for the old range (e.g. its objects were
    garbage-collected before this ran), every old commit still comes back
    unmatched rather than silently vanishing from both `matched` and
    `unmatched`.
    """
    old_range = f"{old_base}..{old_head}"
    new_range = f"{new_base}..{new_head}"

    old_shas = _list_commit_shas(repo_path, old_range)
    if not old_shas:
        return {"matched": {}, "unmatched": []}

    old_patch_ids = _compute_patch_ids(repo_path, old_range)
    new_patch_ids = _compute_patch_ids(repo_path, new_range)

    new_by_patch_id: dict[str, list[str]] = {}
    for sha, patch_id in new_patch_ids.items():
        new_by_patch_id.setdefault(patch_id, []).append(sha)

    matched: dict[str, str] = {}
    claimed_new_shas: set[str] = set()
    after_patch_id: list[str] = []

    for sha in old_shas:
        old_patch_id = old_patch_ids.get(sha)
        candidates = new_by_patch_id.get(old_patch_id) if old_patch_id else None
        if candidates:
            next_sha = candidates.pop(0)
            matched[sha] = next_sha
            claimed_new_shas.add(next_sha)
        else:
            after_patch_id.append(sha)

    if not after_patch_id:
        return {"matched": matched, "unmatched": []}

    # Message fallback for anything patch-id couldn't match - join on
    # identical subject+body among commits not already claimed on the new
    # side.
    old_messages = _compute_messages(repo_path, old_range)
    new_messages = _compute_messages(repo_path, new_range)

    new_by_message: dict[str, list[str]] = {}
    for sha, message in new_messages.items():
        if sha in claimed_new_shas:
            continue
        new_by_message.setdefault(message, []).append(sha)

    unmatched: list[str] = []
    for sha in after_patch_id:
        old_message = old_messages.get(sha)
        candidates = new_by_message.get(old_message) if old_message else None
        if candidates:
            next_sha = candidates.pop(0)
            matched[sha] = next_sha
            claimed_new_shas.add(next_sha)
        else:
            unmatched.append(sha)

    return {"matched": matched, "unmatched": unmatched}


class GitResult(TypedDict, total=False):
    """Result of a git operation."""

    success: bool
    message: str
    previous_branch: str


class FileStats(TypedDict):
    """Statistics for a file in a diff."""

    path: str
    additions: int
    deletions: int


class DiffStats(TypedDict):
    """Statistics for a diff."""

    files: list[FileStats]
    stat: str


class CommitInfo(TypedDict):
    """Information about a commit."""

    sha: str
    short_sha: str
    message: str
    author: str
    date: str


class GitOps:
    """Git operations wrapper using GitPython."""

    def __init__(self, repo_path: str) -> None:
        """Initialize with a repository path."""
        self.repo_path = Path(repo_path).resolve()
        if not (self.repo_path / ".git").exists():
            raise ValueError(f"Not a git repository: {self.repo_path}")
        self.repo = Repo(self.repo_path)

    def get_current_branch(self) -> str:
        """Get the current branch name."""
        return str(self.repo.active_branch.name)

    def get_current_commit(self) -> str:
        """Get the current commit SHA."""
        return str(self.repo.head.commit.hexsha)

    def get_commit_sha(self, ref: str) -> str:
        """Get the SHA for a reference (branch, tag, or commit)."""
        return str(self.repo.commit(ref).hexsha)

    def resolve_ref(self, ref: str) -> str | None:
        """Get the SHA for a reference, or None if it doesn't resolve."""
        try:
            return str(self.repo.commit(ref).hexsha)
        except (BadName, BadObject, ValueError):
            return None

    def get_diff(self, base: str, head: str) -> str:
        """Get unified diff between two refs."""
        result: str = self.repo.git.diff(f"{base}...{head}")
        return result

    def get_diff_stat(self, base: str, head: str) -> DiffStats:
        """Get diff statistics between two refs."""
        stat: str = self.repo.git.diff(f"{base}...{head}", "--stat")
        numstat: str = self.repo.git.diff(f"{base}...{head}", "--numstat")

        files: list[FileStats] = []
        for line in numstat.strip().split("\n"):
            if line:
                parts = line.split("\t")
                if len(parts) >= 3:
                    additions = int(parts[0]) if parts[0] != "-" else 0
                    deletions = int(parts[1]) if parts[1] != "-" else 0
                    filepath = parts[2]
                    files.append(
                        {
                            "path": filepath,
                            "additions": additions,
                            "deletions": deletions,
                        }
                    )

        return {"files": files, "stat": stat}

    def get_branches(self) -> list[str]:
        """Get list of all local branches."""
        return [str(b.name) for b in self.repo.heads]

    def get_remote_branches(self, remote: str = "origin") -> list[str]:
        """Get list of remote branches."""
        try:
            remote_obj = self.repo.remote(remote)
            return [ref.name.replace(f"{remote}/", "") for ref in remote_obj.refs]
        except ValueError:
            return []

    def branch_exists(self, branch: str) -> bool:
        """Check if a branch exists."""
        return branch in [str(b.name) for b in self.repo.heads]

    def merge(
        self,
        head_branch: str,
        base_branch: str = "main",
        message: str | None = None,
    ) -> GitResult:
        """Merge head branch into base branch."""
        try:
            original_branch = self.get_current_branch()

            # Checkout base branch
            self.repo.git.checkout(base_branch)

            # Merge with no-ff
            merge_msg = message or f"Merge branch '{head_branch}' into {base_branch}"
            self.repo.git.merge(head_branch, "--no-ff", "-m", merge_msg)

            return {
                "success": True,
                "message": f"Merged {head_branch} into {base_branch}",
                "previous_branch": original_branch,
            }
        except GitCommandError as e:
            # Try to abort merge if it failed
            # Try to abort merge if it failed
            with contextlib.suppress(GitCommandError):
                self.repo.git.merge("--abort")
            return {
                "success": False,
                "message": str(e),
            }

    def push(
        self,
        remote: str = "origin",
        branch: str | None = None,
        set_upstream: bool = False,
    ) -> GitResult:
        """Push to remote."""
        try:
            target_branch = branch or self.get_current_branch()
            args: list[str] = [remote, target_branch]
            if set_upstream:
                args = ["-u", *args]
            self.repo.git.push(*args)
            return {
                "success": True,
                "message": f"Pushed {target_branch} to {remote}",
            }
        except GitCommandError as e:
            return {
                "success": False,
                "message": str(e),
            }

    def delete_branch(self, branch: str, force: bool = False) -> GitResult:
        """Delete a local branch."""
        try:
            flag = "-D" if force else "-d"
            self.repo.git.branch(flag, branch)
            return {
                "success": True,
                "message": f"Deleted branch {branch}",
            }
        except GitCommandError as e:
            return {
                "success": False,
                "message": str(e),
            }

    def checkout(self, ref: str) -> GitResult:
        """Checkout a branch or commit."""
        try:
            self.repo.git.checkout(ref)
            return {
                "success": True,
                "message": f"Checked out {ref}",
            }
        except GitCommandError as e:
            return {
                "success": False,
                "message": str(e),
            }

    def has_uncommitted_changes(self) -> bool:
        """Check if there are uncommitted changes."""
        return bool(self.repo.is_dirty(untracked_files=True))

    def get_remote_url(self, remote: str = "origin") -> str | None:
        """Get the URL of a remote."""
        try:
            remote_obj = self.repo.remote(remote)
            urls = list(remote_obj.urls)
            return urls[0] if urls else None
        except ValueError:
            return None

    def get_commits_between(self, base: str, head: str) -> list[CommitInfo]:
        """Get list of commits between two refs."""
        commits = list(self.repo.iter_commits(f"{base}..{head}"))
        return [
            {
                "sha": str(c.hexsha),
                "short_sha": str(c.hexsha)[:7],
                "message": str(c.message).strip(),
                "author": str(c.author.name) if c.author.name else "",
                "date": c.committed_datetime.isoformat(),
            }
            for c in commits
        ]

    def commit_all(self, message: str) -> GitResult:
        """Stage all changes and commit them.

        Args:
            message: Commit message

        Returns:
            GitResult with success status and the commit SHA on success
        """
        try:
            # Stage all changes (including untracked)
            self.repo.git.add("-A")

            # Check if there's anything to commit
            if not self.repo.is_dirty(index=True):
                return {
                    "success": False,
                    "message": "Nothing to commit",
                }

            # Commit
            self.repo.git.commit("-m", message)
            commit_sha = str(self.repo.head.commit.hexsha)[:7]

            return {
                "success": True,
                "message": f"Committed changes ({commit_sha})",
            }
        except GitCommandError as e:
            return {
                "success": False,
                "message": str(e),
            }
