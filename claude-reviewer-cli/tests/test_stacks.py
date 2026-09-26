"""Tests for stacked PRs: deriving stacks, and create/list/show/update/merge/
restack treating them as one."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner

from claude_reviewer import database as db
from claude_reviewer.cli import _order_by_stack, main
from claude_reviewer.models import CommentRelocationStatus, PRStatus, PullRequest


def _run_git(cwd: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _add_pr(repo: str, base_ref: str, head_ref: str) -> PullRequest:
    """A PR row with placeholder commits - enough for stack derivation, which
    only looks at branch names and status."""
    pr_uuid = db.create_pr(
        repo_path=repo,
        title=head_ref,
        base_ref=base_ref,
        head_ref=head_ref,
        base_commit="0" * 40,
        head_commit="1" * 40,
        diff="d",
    )
    pr = db.get_pr_by_uuid(pr_uuid)
    assert pr is not None
    return pr


class TestStackDerivation:
    def test_chain_is_flattened_depth_first_from_any_member(self, temp_db: Path) -> None:
        a = _add_pr("/r", "main", "a")
        b = _add_pr("/r", "a", "b")
        c = _add_pr("/r", "b", "c")

        for member in (a, b, c):
            stack = db.get_stack(member)
            assert [(e.pr.uuid, e.depth) for e in stack] == [(a.uuid, 0), (b.uuid, 1), (c.uuid, 2)]

    def test_branching_stack_keeps_each_subtree_together(self, temp_db: Path) -> None:
        a = _add_pr("/r", "main", "a")
        b1 = _add_pr("/r", "a", "b1")
        b2 = _add_pr("/r", "a", "b2")
        c = _add_pr("/r", "b1", "c")

        assert [(e.pr.uuid, e.depth) for e in db.get_stack(b2)] == [
            (a.uuid, 0),
            (b1.uuid, 1),
            (c.uuid, 2),
            (b2.uuid, 1),
        ]

    def test_parent_and_children(self, temp_db: Path) -> None:
        a = _add_pr("/r", "main", "a")
        b = _add_pr("/r", "a", "b")

        assert db.get_parent_pr(a) is None
        parent = db.get_parent_pr(b)
        assert parent is not None and parent.uuid == a.uuid
        assert [c.uuid for c in db.get_child_prs(a)] == [b.uuid]
        assert db.get_child_prs(b) == []

    def test_closed_parent_makes_the_child_a_root(self, temp_db: Path) -> None:
        a = _add_pr("/r", "main", "a")
        b = _add_pr("/r", "a", "b")
        db.update_pr_status(a.uuid, PRStatus.CLOSED)

        assert db.get_parent_pr(b) is None
        assert [e.pr.uuid for e in db.get_stack(b)] == [b.uuid]

    def test_other_repos_branches_dont_count(self, temp_db: Path) -> None:
        _add_pr("/other", "main", "a")
        b = _add_pr("/r", "a", "b")

        assert db.get_parent_pr(b) is None

    def test_branch_cycle_terminates(self, temp_db: Path) -> None:
        a = _add_pr("/r", "b", "a")
        b = _add_pr("/r", "a", "b")

        assert {e.pr.uuid for e in db.get_stack(a)} == {a.uuid, b.uuid}
        assert {p.uuid for p, _ in _order_by_stack([a, b])} == {a.uuid, b.uuid}

    def test_order_by_stack_nests_children_under_parents_in_the_listing(
        self, temp_db: Path
    ) -> None:
        a = _add_pr("/r", "main", "a")
        other = _add_pr("/r", "main", "other")
        b = _add_pr("/r", "a", "b")

        # Newest-first, as `list` gets them: b, other, a.
        ordered = _order_by_stack([b, other, a])
        assert [(p.uuid, d) for p, d in ordered] == [(other.uuid, 0), (a.uuid, 0), (b.uuid, 1)]


class TestStackCommands:
    @pytest.fixture
    def repo(self, tmp_path: Path) -> Path:
        """main <- a <- b <- c, each branch adding its own file."""
        repo_path = tmp_path / "repo"
        repo_path.mkdir()
        _run_git(repo_path, ["init", "-b", "main"])
        _run_git(repo_path, ["config", "user.email", "test@example.com"])
        _run_git(repo_path, ["config", "user.name", "Test User"])
        (repo_path / "base.txt").write_text("base\n")
        _run_git(repo_path, ["add", "base.txt"])
        _run_git(repo_path, ["commit", "-m", "base commit"])

        parent = "main"
        for name in ("a", "b", "c"):
            _run_git(repo_path, ["checkout", "-q", "-b", name, parent])
            (repo_path / f"{name}.txt").write_text(f"{name} one\n{name} two\n")
            _run_git(repo_path, ["add", f"{name}.txt"])
            _run_git(repo_path, ["commit", "-q", "-m", f"add {name}"])
            parent = name
        _run_git(repo_path, ["checkout", "-q", "main"])
        return repo_path

    def _create(self, repo: Path, head: str, *extra: str) -> PullRequest:
        result = CliRunner().invoke(
            main, ["create", "-t", f"PR {head}", "--head", head, "--repo", str(repo), *extra]
        )
        assert result.exit_code == 0, result.output
        return next(p for p in db.list_prs(repo_path=str(repo)) if p.head_ref == head)

    def _create_stack(self, repo: Path) -> tuple[PullRequest, PullRequest, PullRequest]:
        return self._create(repo, "a"), self._create(repo, "b"), self._create(repo, "c")

    def _amend_a(self, repo: Path) -> None:
        _run_git(repo, ["checkout", "-q", "a"])
        (repo / "a.txt").write_text("a one\na two\na three\n")
        _run_git(repo, ["commit", "-q", "--amend", "-am", "add a (amended)"])
        _run_git(repo, ["checkout", "-q", "main"])

    def _approve(self, pr: PullRequest) -> None:
        db.update_pr_status(pr.uuid, PRStatus.APPROVED)

    def _is_ancestor(self, repo: Path, a: str, b: str) -> bool:
        return (
            subprocess.run(["git", "merge-base", "--is-ancestor", a, b], cwd=repo).returncode == 0
        )

    def _pr(self, uuid: str) -> PullRequest:
        pr = db.get_pr_by_uuid(uuid)
        assert pr is not None
        return pr

    def test_create_stacks_on_the_nearest_open_pr_branch(self, temp_db: Path, repo: Path) -> None:
        a, b, c = self._create_stack(repo)

        assert a.base_ref == "main"
        assert b.base_ref == "a"
        assert c.base_ref == "b"
        # Only c's own change, not a's and b's too.
        diff = db.get_latest_diff(c.uuid) or ""
        assert "c.txt" in diff and "a.txt" not in diff and "b.txt" not in diff

    def test_create_base_flag_opts_out_of_stacking(self, temp_db: Path, repo: Path) -> None:
        self._create(repo, "a")
        b = self._create(repo, "b", "--base", "main")

        assert b.base_ref == "main"

    def test_create_ignores_closed_prs(self, temp_db: Path, repo: Path) -> None:
        a = self._create(repo, "a")
        db.update_pr_status(a.uuid, PRStatus.CLOSED)

        assert self._create(repo, "b").base_ref == "main"

    def test_list_nests_stacked_prs(self, temp_db: Path, repo: Path) -> None:
        self._create_stack(repo)

        result = CliRunner().invoke(main, ["list", "--repo", str(repo)])

        assert result.exit_code == 0, result.output
        lines = result.output.splitlines()
        a_line = next(i for i, line in enumerate(lines) if "PR a" in line)
        assert "└─ PR b" in lines[a_line + 1]
        assert "└─ PR c" in lines[a_line + 2]

    def test_show_prints_the_stack_and_flags_stale_prs(self, temp_db: Path, repo: Path) -> None:
        _, b, _ = self._create_stack(repo)
        self._amend_a(repo)

        result = CliRunner().invoke(main, ["show", b.uuid])

        assert result.exit_code == 0, result.output
        stack_block = result.output.split("Stack", 1)[1]
        b_line = next(line for line in stack_block.splitlines() if f"#{b.uuid}" in line)
        assert "→" in b_line
        assert "needs restack" in b_line
        a_line = next(line for line in stack_block.splitlines() if "PR a" in line)
        assert "needs restack" not in a_line

    def test_update_warns_about_stale_children(self, temp_db: Path, repo: Path) -> None:
        a, b, _ = self._create_stack(repo)
        self._amend_a(repo)

        result = CliRunner().invoke(main, ["update", a.uuid])

        assert result.exit_code == 0, result.output
        assert b.uuid in result.output
        assert f"restack {a.uuid}" in result.output

    def test_restack_rebases_the_whole_stack_top_down(self, temp_db: Path, repo: Path) -> None:
        a, b, c = self._create_stack(repo)
        for pr in (b, c):
            self._approve(pr)
        comment_result = CliRunner().invoke(main, ["comment", c.uuid, "Nice", "-l", "c.txt:2"])
        assert comment_result.exit_code == 0, comment_result.output
        self._amend_a(repo)

        result = CliRunner().invoke(main, ["restack", a.uuid])

        assert result.exit_code == 0, result.output
        assert self._is_ancestor(repo, "a", "b")
        assert self._is_ancestor(repo, "b", "c")
        # The pre-amend a commit didn't get replayed alongside b's own.
        assert _run_git(repo, ["rev-list", "--count", "a..b"]) == "1"
        assert _run_git(repo, ["rev-list", "--count", "b..c"]) == "1"
        # Diffs are unchanged, so the approvals stand.
        assert self._pr(b.uuid).status == PRStatus.APPROVED
        assert self._pr(c.uuid).status == PRStatus.APPROVED
        assert self._pr(c.uuid).base_commit == _run_git(repo, ["rev-parse", "b"])
        (comment,) = db.get_comments(c.uuid)
        assert comment.status == CommentRelocationStatus.ACTIVE
        assert comment.line_number == 2
        # Back where it started.
        assert _run_git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) == "main"

    def test_restack_with_nothing_stale_is_a_no_op(self, temp_db: Path, repo: Path) -> None:
        a, _, _ = self._create_stack(repo)
        before = _run_git(repo, ["rev-parse", "b", "c"])

        result = CliRunner().invoke(main, ["restack", a.uuid])

        assert result.exit_code == 0, result.output
        assert "Nothing to restack" in result.output
        assert _run_git(repo, ["rev-parse", "b", "c"]) == before

    def test_restack_conflict_aborts_and_leaves_the_branch_alone(
        self, temp_db: Path, repo: Path
    ) -> None:
        a, b, _ = self._create_stack(repo)
        # a now also creates b.txt, clashing with b's commit.
        _run_git(repo, ["checkout", "-q", "a"])
        (repo / "b.txt").write_text("clash\n")
        _run_git(repo, ["add", "b.txt"])
        _run_git(repo, ["commit", "-q", "--amend", "-m", "add a and b.txt"])
        _run_git(repo, ["checkout", "-q", "main"])
        b_before = _run_git(repo, ["rev-parse", "b"])

        result = CliRunner().invoke(main, ["restack", a.uuid])

        assert result.exit_code == 1
        assert b.uuid in result.output
        assert _run_git(repo, ["rev-parse", "b"]) == b_before
        assert _run_git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) == "main"
        assert _run_git(repo, ["status", "--porcelain"]) == ""

    def test_restack_refuses_a_dirty_tree(self, temp_db: Path, repo: Path) -> None:
        a, _, _ = self._create_stack(repo)
        (repo / "base.txt").write_text("dirty\n")

        result = CliRunner().invoke(main, ["restack", a.uuid])

        assert result.exit_code == 1
        assert "uncommitted changes" in result.output

    def test_merge_refuses_a_pr_whose_parent_is_open(self, temp_db: Path, repo: Path) -> None:
        a, b, _ = self._create_stack(repo)
        self._approve(b)

        result = CliRunner().invoke(main, ["merge", b.uuid, "--no-push"])

        assert result.exit_code == 1
        assert a.uuid in result.output
        assert self._pr(b.uuid).status == PRStatus.APPROVED

    def test_merge_refuses_while_children_are_stale(self, temp_db: Path, repo: Path) -> None:
        a, _, _ = self._create_stack(repo)
        self._amend_a(repo)
        CliRunner().invoke(main, ["update", a.uuid])
        self._approve(a)

        result = CliRunner().invoke(main, ["merge", a.uuid, "--no-push"])

        assert result.exit_code == 1
        assert f"restack {a.uuid}" in result.output
        assert self._pr(a.uuid).status == PRStatus.APPROVED

    def test_merge_retargets_children_keeping_their_review(self, temp_db: Path, repo: Path) -> None:
        a, b, c = self._create_stack(repo)
        self._approve(a)
        self._approve(b)
        b_diff = db.get_latest_diff(b.uuid)

        result = CliRunner().invoke(main, ["merge", a.uuid, "--no-push", "--delete-branch"])

        assert result.exit_code == 0, result.output
        assert self._pr(a.uuid).status == PRStatus.MERGED
        retargeted = self._pr(b.uuid)
        assert retargeted.base_ref == "main"
        assert retargeted.status == PRStatus.APPROVED
        assert db.get_latest_diff(b.uuid) == b_diff
        # Only direct children move; c still sits on b.
        assert self._pr(c.uuid).base_ref == "b"
        assert db.get_parent_pr(retargeted) is None
        assert _run_git(repo, ["branch", "--list", "a"]) == ""

        # And b can now merge in turn.
        result = CliRunner().invoke(main, ["merge", b.uuid, "--no-push"])
        assert result.exit_code == 0, result.output
        assert self._pr(c.uuid).base_ref == "main"

    def test_merge_retarget_keeps_review_across_a_web_ui_snapshot(
        self, temp_db: Path, repo: Path
    ) -> None:
        # The web UI's diffs keep git's final newline; the CLI's don't. A child
        # last synced from the web must still count as unchanged.
        a, b, _ = self._create_stack(repo)
        b_diff = db.get_latest_diff(b.uuid) or ""
        db.update_pr_diff(b.uuid, b_diff + "\n", b.head_commit, b.base_commit)
        self._approve(a)
        self._approve(b)

        result = CliRunner().invoke(main, ["merge", a.uuid, "--no-push"])

        assert result.exit_code == 0, result.output
        assert self._pr(b.uuid).status == PRStatus.APPROVED
