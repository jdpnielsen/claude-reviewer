"""Tests for the cli module."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from click.testing import CliRunner
from rich.console import Console

import claude_reviewer.cli
from claude_reviewer import database as db
from claude_reviewer.cli import (
    SKILLS_DIR,
    _comment_json,
    get_diff_line_context,
    get_local_server_pid_file,
    main,
    print_comment,
    stop_local_server,
)
from claude_reviewer.models import (
    Comment,
    CommentRelocationStatus,
    CommentReply,
    CommentResolutionMode,
)


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect Path.home() so pid files land in a throwaway directory."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


class TestStopLocalServer:
    """Tests for stop_local_server."""

    def test_kills_process_tracked_by_pid_file(self, fake_home: Path) -> None:
        """A locally-running server tracked by a PID file is terminated and the file is removed."""
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
        )
        pid_file = get_local_server_pid_file(41729)
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text(str(process.pid))

        try:
            assert stop_local_server(41729) is True

            deadline = time.time() + 5
            while process.poll() is None and time.time() < deadline:
                time.sleep(0.1)

            assert process.poll() is not None
            assert not pid_file.exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_returns_false_when_nothing_is_running(self, fake_home: Path) -> None:
        """No PID file and nothing listening on the port means nothing to stop."""
        assert stop_local_server(41799) is False


class TestStopCommand:
    """Tests for the `stop` CLI command."""

    def test_reports_stopped_when_local_server_was_running(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`stop` reports success when a local (non-Docker) server was stopped."""
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, stdout="", stderr=""),
        )
        monkeypatch.setattr("claude_reviewer.cli.stop_local_server", lambda port: True)

        result = CliRunner().invoke(main, ["stop"])

        assert result.exit_code == 0
        assert "Stopped" in result.output


class TestServeCheck:
    """Tests for `serve --check`."""

    def test_reports_running_and_exits_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """--check exits 0 and says so when the web UI is reachable."""
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: True)

        result = CliRunner().invoke(main, ["serve", "--check"])

        assert result.exit_code == 0
        assert "running" in result.output.lower()

    def test_reports_not_running_and_exits_nonzero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """--check exits non-zero and says so when nothing is listening on the port."""
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: False)

        result = CliRunner().invoke(main, ["serve", "--check"])

        assert result.exit_code != 0
        assert "not running" in result.output.lower()

    def test_does_not_attempt_to_start_anything(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """--check never touches docker or pnpm, regardless of whether the UI is up."""
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: False)
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *args, **kwargs: pytest.fail("serve --check should not shell out"),
        )

        result = CliRunner().invoke(main, ["serve", "--check"])

        assert result.exit_code != 0


class TestOpenCommand:
    """Tests for the `open` CLI command."""

    def test_opens_the_dashboard_when_already_running(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If the web UI is already reachable, `open` opens the browser to it."""
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: True)
        opened_urls: list[str] = []
        monkeypatch.setattr("webbrowser.open", opened_urls.append)

        result = CliRunner().invoke(main, ["open"])

        assert result.exit_code == 0
        assert opened_urls == ["http://localhost:41729"]

    def test_opens_a_specific_pr_review_page(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A PR id argument opens that PR's review page instead of the dashboard."""
        monkeypatch.setattr("claude_reviewer.database.get_pr_by_uuid", lambda pr_id: object())
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: True)
        opened_urls: list[str] = []
        monkeypatch.setattr("webbrowser.open", opened_urls.append)

        result = CliRunner().invoke(main, ["open", "abc12345"])

        assert result.exit_code == 0
        assert opened_urls == ["http://localhost:41729/prs/abc12345"]

    def test_rejects_an_unknown_pr_id_without_opening_anything(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An invalid PR id fails loudly instead of falling back to the dashboard."""
        monkeypatch.setattr("claude_reviewer.database.get_pr_by_uuid", lambda pr_id: None)
        opened_urls: list[str] = []
        monkeypatch.setattr("webbrowser.open", opened_urls.append)

        result = CliRunner().invoke(main, ["open", "not-a-real-pr"])

        assert result.exit_code != 0
        assert opened_urls == []

    def test_suggests_serve_instead_of_starting_it_when_not_running(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If nothing is listening, `open` reports that and points at `serve` — it never starts anything."""
        monkeypatch.setattr("claude_reviewer.cli.is_web_ui_running", lambda port: False)
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *args, **kwargs: pytest.fail("open should not shell out to start anything"),
        )
        opened_urls: list[str] = []
        monkeypatch.setattr("webbrowser.open", opened_urls.append)

        result = CliRunner().invoke(main, ["open"])

        assert result.exit_code != 0
        assert "claude-reviewer serve" in result.output
        assert opened_urls == []


class TestSkillsCommand:
    """Tests for `skills list` and `skills install`."""

    def test_list_shows_every_bundled_skill(self) -> None:
        """`skills list` names each bundled skill and its description."""
        result = CliRunner().invoke(main, ["skills", "list"])

        assert result.exit_code == 0
        for name in ("claude-reviewer", "claude-reviewer-always"):
            assert name in result.output

    def test_install_copies_all_skills_to_the_user_scope_by_default(self, fake_home: Path) -> None:
        """With no names given, `skills install` installs every bundled skill under ~/.claude/skills."""
        result = CliRunner().invoke(main, ["skills", "install"])

        assert result.exit_code == 0
        installed = fake_home / ".claude" / "skills"
        assert (installed / "claude-reviewer" / "SKILL.md").read_text() == (
            SKILLS_DIR / "claude-reviewer" / "SKILL.md"
        ).read_text()
        assert (installed / "claude-reviewer-always" / "SKILL.md").exists()

    def test_install_with_a_name_installs_only_that_skill(self, fake_home: Path) -> None:
        """Naming a skill installs just that one, leaving the others out."""
        result = CliRunner().invoke(main, ["skills", "install", "claude-reviewer"])

        assert result.exit_code == 0
        installed = fake_home / ".claude" / "skills"
        assert (installed / "claude-reviewer" / "SKILL.md").exists()
        assert not (installed / "claude-reviewer-always").exists()

    def test_install_rejects_an_unknown_skill_name(self, fake_home: Path) -> None:
        """An unrecognized skill name fails loudly instead of installing nothing silently."""
        result = CliRunner().invoke(main, ["skills", "install", "not-a-real-skill"])

        assert result.exit_code != 0
        assert "unknown skill" in result.output.lower()

    def test_install_project_scope_uses_the_given_repo_path(self, tmp_path: Path) -> None:
        """--scope project installs under <repo>/.claude/skills instead of the home directory."""
        result = CliRunner().invoke(
            main,
            ["skills", "install", "claude-reviewer", "--scope", "project", "--repo", str(tmp_path)],
        )

        assert result.exit_code == 0
        assert (tmp_path / ".claude" / "skills" / "claude-reviewer" / "SKILL.md").exists()

    def test_reinstall_without_force_prompts_and_skips_on_no(self, fake_home: Path) -> None:
        """Re-installing an existing skill asks first, and declining leaves it untouched."""
        installed_dir = fake_home / ".claude" / "skills" / "claude-reviewer"
        CliRunner().invoke(main, ["skills", "install", "claude-reviewer"])
        marker = installed_dir / "marker.txt"
        marker.write_text("do not overwrite me")

        result = CliRunner().invoke(main, ["skills", "install", "claude-reviewer"], input="n\n")

        assert result.exit_code == 0
        assert "overwrite" in result.output.lower()
        assert marker.exists()

    def test_reinstall_with_force_overwrites_without_prompting(self, fake_home: Path) -> None:
        """--force re-installs an existing skill without asking."""
        installed_dir = fake_home / ".claude" / "skills" / "claude-reviewer"
        CliRunner().invoke(main, ["skills", "install", "claude-reviewer"])
        marker = installed_dir / "marker.txt"
        marker.write_text("should be removed")

        result = CliRunner().invoke(main, ["skills", "install", "claude-reviewer", "--force"])

        assert result.exit_code == 0
        assert not marker.exists()


class TestPrintComment:
    """Tests for print_comment's commit-scope display."""

    @pytest.fixture(autouse=True)
    def _disable_console_colors(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
        """Disable Rich console colors so literal-substring assertions on output are stable.

        Rich emits ANSI codes even under pytest's `capsys`, which would otherwise break
        assertions like `"a.py:1 [0123456]" in output`. Scoped to this class only, via
        `monkeypatch.setattr`, so pytest guarantees the revert and other test classes in
        this file are unaffected.
        """
        monkeypatch.setattr(claude_reviewer.cli, "console", Console(force_terminal=False))
        yield

    def test_shows_short_sha_for_a_commit_scoped_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A comment tagged with a commit shows that commit's short SHA."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
            commit_sha="0123456789abcdef",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1 [0123456]" in output

    def test_omits_commit_tag_for_a_cumulative_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A comment with no commit_sha (cumulative view) shows no commit tag."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1  ·" in output

    def test_shows_commit_message_location_for_a_commit_message_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A comment on a commit's message shows 'commit message' instead of file:line."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="",
            line_number=0,
            end_line_number=0,
            content="please explain why, not just what",
            commit_sha="0123456789abcdef",
            target_type="commit_message",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "commit message [0123456]" in output
        assert "a.py" not in output

    def test_shows_changes_requested_location_for_a_review_summary_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A 'Request Changes' review summary mirrored into a comment shows 'changes
        requested' instead of file:line - it has no file/line or commit of its own."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="",
            line_number=0,
            end_line_number=0,
            content="Please add tests for the new endpoint before merging.",
            target_type="review_summary",
            review_action="request_changes",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "changes requested" in output
        assert "a.py" not in output

    def test_shows_approved_location_for_an_approve_review_summary_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """An 'Approve' review summary mirrored into a comment shows 'approved',
        not 'changes requested' - the two share a target_type and are only
        told apart by review_action."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="",
            line_number=0,
            end_line_number=0,
            content="Nice cleanup.",
            target_type="review_summary",
            review_action="approve",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "approved" in output
        assert "changes requested" not in output

    def test_renders_a_suggestion_fence_distinctly(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A ```suggestion fence is rendered as a labeled code block, not raw markdown."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="Off by one.\n\n```suggestion\nreturn total - 1\n```",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "Off by one." in output
        assert "Suggested change:" in output
        assert "return total - 1" in output
        assert "```suggestion" not in output

    def test_renders_a_suggestion_in_a_reply(self, capsys: pytest.CaptureFixture[str]) -> None:
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="```suggestion\nreturn total - 1\n```",
        )
        reply = CommentReply(
            id=2,
            uuid="r1",
            comment_id=1,
            author_id=1,
            author="Claude",
            author_kind="agent",
            content="Or clamp it:\n\n```suggestion\nreturn max(total - 1, 0)\n```",
        )

        print_comment(comment, [reply])

        output = capsys.readouterr().out
        assert "↳ Claude:" in output
        assert "Or clamp it:" in output
        assert output.count("Suggested change:") == 2
        assert "return max(total - 1, 0)" in output
        assert "```" not in output

    def test_json_breaks_out_reply_suggestions(self) -> None:
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="off by one",
        )
        reply = CommentReply(
            id=2,
            uuid="r1",
            comment_id=1,
            author_id=1,
            author="Claude",
            author_kind="agent",
            content="```suggestion\nreturn total - 1\n```",
        )

        replies = _comment_json(comment, [reply])["replies"]

        assert replies == [
            {
                "author": "Claude",
                "text": "```suggestion\nreturn total - 1\n```",
                "suggestions": [["return total - 1"]],
            }
        ]

    def test_comment_without_a_suggestion_prints_content_as_is(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "looks good" in output
        assert "Suggested change:" not in output

    def test_omits_resolution_mode_tag_for_the_default_fix_mode(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """The common case (just fix it) stays uncluttered - no tag shown."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
            resolution_mode=CommentResolutionMode.FIX,
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "discuss" not in output
        assert "fix-if-agreed" not in output

    def test_shows_discuss_tag(self, capsys: pytest.CaptureFixture[str]) -> None:
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="what's the reasoning here?",
            resolution_mode=CommentResolutionMode.DISCUSS,
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "[discuss]" in output

    def test_shows_fix_if_agreed_tag(self, capsys: pytest.CaptureFixture[str]) -> None:
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="consider renaming this",
            resolution_mode=CommentResolutionMode.FIX_IF_AGREED,
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "[fix-if-agreed]" in output


class TestAuthorsCommands:
    """Tests for the `authors` command group."""

    def test_list_shows_seeded_authors(self, temp_db: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["authors", "list"])
        assert result.exit_code == 0
        assert "claude" in result.output

    def test_add_registers_a_new_author(self, temp_db: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["authors", "add", "Alice", "--kind", "human"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Alice" in list_result.output

    def test_add_rejects_duplicate_name(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Bob", "--kind", "human"])
        result = runner.invoke(main, ["authors", "add", "bob", "--kind", "human"])
        assert result.exit_code != 0

    def test_edit_updates_name(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Carol", "--kind", "human"])
        result = runner.invoke(main, ["authors", "edit", "Carol", "--name", "Caroline"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Caroline" in list_result.output

    def test_remove_deletes_unreferenced_author(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Dave", "--kind", "human"])
        result = runner.invoke(main, ["authors", "remove", "Dave"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Dave" not in list_result.output

    def test_set_default_repoints_default(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Erin", "--kind", "human"])
        result = runner.invoke(main, ["authors", "set-default", "Erin"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Erin" in list_result.output


class TestReplyAuthorResolution:
    """Tests for the `reply` command's --author resolution."""

    def test_reply_with_unknown_author_errors_clearly(self, temp_db: Path) -> None:
        runner = CliRunner()
        # `create` needs a real git repo, which this test doesn't need to set
        # up - seed the PR/comment directly via the db module instead.
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        result = runner.invoke(
            main, ["reply", pr_uuid, comment_uuid, "a reply", "--author", "Nobody"]
        )
        assert result.exit_code != 0
        assert "Unknown author" in result.output


def _run_git(cwd: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class TestUpdateCommand:
    """Tests for the `update` command's --title / --base / --head options."""

    @pytest.fixture
    def repo(self, tmp_path: Path) -> Path:
        """A repo with main, a diverged release branch, and feature off main."""
        repo_path = tmp_path / "repo"
        repo_path.mkdir()
        _run_git(repo_path, ["init", "-b", "main"])
        _run_git(repo_path, ["config", "user.email", "test@example.com"])
        _run_git(repo_path, ["config", "user.name", "Test User"])

        (repo_path / "base.txt").write_text("base\n")
        _run_git(repo_path, ["add", "base.txt"])
        _run_git(repo_path, ["commit", "-m", "base commit"])

        _run_git(repo_path, ["checkout", "-b", "release"])
        (repo_path / "release.txt").write_text("release only\n")
        _run_git(repo_path, ["add", "release.txt"])
        _run_git(repo_path, ["commit", "-m", "release commit"])

        _run_git(repo_path, ["checkout", "-b", "feature", "main"])
        (repo_path / "feature.txt").write_text("feature work\n")
        _run_git(repo_path, ["add", "feature.txt"])
        _run_git(repo_path, ["commit", "-m", "feature commit"])

        return repo_path

    def _create_pr(self, repo: Path) -> str:
        return db.create_pr(
            repo_path=str(repo),
            title="Original title",
            base_ref="main",
            head_ref="feature",
            base_commit=_run_git(repo, ["rev-parse", "main"]),
            head_commit=_run_git(repo, ["rev-parse", "feature"]),
            diff="original diff",
        )

    def test_title_renames_the_pr_without_touching_the_base(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--title", "Renamed title"])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.title == "Renamed title"
        assert pr.base_ref == "main"

    def test_description_rewrites_the_body_without_touching_the_title(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(
            main, ["update", pr_uuid, "--description", "## Why\n\nBecause of `reasons`."]
        )

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.description == "## Why\n\nBecause of `reasons`."
        assert pr.title == "Original title"

    def test_omitting_description_keeps_the_existing_one(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        db.update_pr_metadata(pr_uuid, description="Existing body")

        result = CliRunner().invoke(main, ["update", pr_uuid, "--title", "Renamed"])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.description == "Existing body"

    def test_empty_description_clears_the_body(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        db.update_pr_metadata(pr_uuid, description="Existing body")

        result = CliRunner().invoke(main, ["update", pr_uuid, "--description", ""])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.description == ""

    def test_base_retargets_the_pr_and_re_diffs_against_it(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--base", "release"])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.base_ref == "release"
        assert pr.base_commit == _run_git(repo, ["rev-parse", "release"])
        # Three-dot diff against the merge base, so the release-only commit
        # doesn't show up as the PR deleting it.
        diff = db.get_latest_diff(pr_uuid)
        assert diff is not None
        assert "feature.txt" in diff
        assert "release.txt" not in diff

    def test_title_and_base_can_change_in_one_call(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(
            main, ["update", pr_uuid, "--title", "Both", "--base", "release"]
        )

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.title == "Both"
        assert pr.base_ref == "release"

    def test_unknown_base_is_rejected_without_changing_the_pr(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--base", "no-such-branch"])

        assert result.exit_code != 0
        assert "not found" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.base_ref == "main"
        assert db.get_latest_diff(pr_uuid) == "original diff"

    def test_base_equal_to_head_is_rejected(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--base", "feature"])

        assert result.exit_code != 0
        assert "same as head branch" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.base_ref == "main"

    def test_plain_update_leaves_title_base_and_head_alone(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.title == "Original title"
        assert pr.base_ref == "main"
        assert pr.head_ref == "feature"
        assert "feature.txt" in (db.get_latest_diff(pr_uuid) or "")

    def _add_branch(self, repo: Path, name: str, filename: str) -> None:
        """Branch off main with a single distinguishing commit."""
        _run_git(repo, ["checkout", "-b", name, "main"])
        (repo / filename).write_text(f"{name} work\n")
        _run_git(repo, ["add", filename])
        _run_git(repo, ["commit", "-m", f"{name} commit"])
        _run_git(repo, ["checkout", "main"])

    def test_head_repoints_the_pr_and_re_diffs_from_it(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        self._add_branch(repo, "feature-v2", "rewrite.txt")

        result = CliRunner().invoke(main, ["update", pr_uuid, "--head", "feature-v2"])

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.head_ref == "feature-v2"
        assert pr.head_commit == _run_git(repo, ["rev-parse", "feature-v2"])
        # Base is untouched, and the diff is now the new head's work, not the
        # branch the PR was opened from.
        assert pr.base_ref == "main"
        diff = db.get_latest_diff(pr_uuid)
        assert diff is not None
        assert "rewrite.txt" in diff
        assert "feature.txt" not in diff

    def test_head_and_base_can_change_in_one_call(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        self._add_branch(repo, "feature-v2", "rewrite.txt")

        result = CliRunner().invoke(
            main, ["update", pr_uuid, "--base", "release", "--head", "feature-v2"]
        )

        assert result.exit_code == 0
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.base_ref == "release"
        assert pr.head_ref == "feature-v2"
        diff = db.get_latest_diff(pr_uuid)
        assert diff is not None
        assert "rewrite.txt" in diff
        # Three-dot diff against the merge base, so release's own commit isn't
        # reported as something this PR deletes.
        assert "release.txt" not in diff

    def test_unknown_head_is_rejected_without_changing_the_pr(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--head", "no-such-branch"])

        assert result.exit_code != 0
        assert "not found" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.head_ref == "feature"
        assert db.get_latest_diff(pr_uuid) == "original diff"

    def test_head_equal_to_base_is_rejected(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--head", "main"])

        assert result.exit_code != 0
        assert "same as head branch" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.head_ref == "feature"

    def test_head_colliding_with_a_new_base_in_the_same_call_is_rejected(
        self, temp_db: Path, repo: Path
    ) -> None:
        # Neither option is illegal on its own here - only the combination is,
        # so this has to be checked against the *new* base, not the stored one.
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(
            main, ["update", pr_uuid, "--base", "release", "--head", "release"]
        )

        assert result.exit_code != 0
        assert "same as head branch" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.base_ref == "main"
        assert pr.head_ref == "feature"
        assert db.get_latest_diff(pr_uuid) == "original diff"

    def test_repo_moves_the_pr_to_another_checkout(
        self, temp_db: Path, repo: Path, tmp_path: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)
        worktree = tmp_path / "worktree"
        _run_git(repo, ["worktree", "add", "--detach", str(worktree), "main"])

        result = CliRunner().invoke(main, ["update", pr_uuid, "--repo", str(worktree)])

        assert result.exit_code == 0, result.output
        assert "Repository:" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.repo_path == str(worktree.resolve())
        assert "feature.txt" in (db.get_latest_diff(pr_uuid) or "")

    def test_repo_pointing_at_the_current_checkout_changes_nothing(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid, "--repo", str(repo)])

        assert result.exit_code == 0, result.output
        assert "Repository:" not in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.repo_path == str(repo)

    def test_repo_missing_the_prs_branches_is_rejected_without_moving_it(
        self, temp_db: Path, repo: Path, tmp_path: Path
    ) -> None:
        # Base and head are unchanged here, but a different checkout still has
        # to have them - this one only has main.
        pr_uuid = self._create_pr(repo)
        other = tmp_path / "other"
        other.mkdir()
        _run_git(other, ["init", "-b", "main"])
        _run_git(other, ["config", "user.email", "test@example.com"])
        _run_git(other, ["config", "user.name", "Test User"])
        _run_git(other, ["commit", "--allow-empty", "-m", "unrelated"])

        result = CliRunner().invoke(main, ["update", pr_uuid, "--repo", str(other)])

        assert result.exit_code != 0
        assert "Head branch 'feature' not found" in result.output
        pr = db.get_pr_by_uuid(pr_uuid)
        assert pr is not None
        assert pr.repo_path == str(repo)
        assert db.get_latest_diff(pr_uuid) == "original diff"

    def test_gone_checkout_suggests_repo_instead_of_a_traceback(
        self, temp_db: Path, repo: Path, tmp_path: Path
    ) -> None:
        pr_uuid = db.create_pr(
            repo_path=str(tmp_path / "removed-worktree"),
            title="Orphaned",
            base_ref="main",
            head_ref="feature",
            base_commit="a",
            head_commit="b",
            diff="original diff",
        )

        result = CliRunner().invoke(main, ["update", pr_uuid])

        assert result.exit_code == 1
        assert "Not a git repository" in result.output
        assert "--repo" in result.output


class TestCommentCommand:
    """Tests for the `comment` command."""

    @pytest.fixture
    def repo(self, tmp_path: Path) -> Path:
        """main, plus a feature branch with two commits changing app.py."""
        repo_path = tmp_path / "repo"
        repo_path.mkdir()
        _run_git(repo_path, ["init", "-b", "main"])
        _run_git(repo_path, ["config", "user.email", "test@example.com"])
        _run_git(repo_path, ["config", "user.name", "Test User"])

        (repo_path / "app.py").write_text("one\ntwo\nthree\n")
        _run_git(repo_path, ["add", "app.py"])
        _run_git(repo_path, ["commit", "-m", "base commit"])

        _run_git(repo_path, ["checkout", "-b", "feature"])
        (repo_path / "app.py").write_text("one\nTWO\nthree\n")
        _run_git(repo_path, ["commit", "-am", "shout two"])
        (repo_path / "app.py").write_text("one\nTWO\nthree\nfour\n")
        _run_git(repo_path, ["commit", "-am", "add four"])
        return repo_path

    def _create_pr(self, repo: Path) -> str:
        return db.create_pr(
            repo_path=str(repo),
            title="PR",
            base_ref="main",
            head_ref="feature",
            base_commit=_run_git(repo, ["rev-parse", "main"]),
            head_commit=_run_git(repo, ["rev-parse", "feature"]),
            diff="d",
        )

    def test_line_comment_is_anchored_and_authored_by_the_agent(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["comment", pr_uuid, "Why shout?", "-l", "app.py:2-3"])

        assert result.exit_code == 0, result.output
        [c] = db.get_comments(pr_uuid)
        assert (c.file_path, c.line_number, c.end_line_number) == ("app.py", 2, 3)
        assert c.line_type == "new"
        assert c.commit_sha is None
        assert c.anchor_content == "TWO"
        assert c.anchor_context_before == "one"
        assert c.author_kind == "agent"
        assert c.author == "claude"

    def test_old_side_comment_anchors_to_the_base(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(
            main, ["comment", pr_uuid, "was fine", "-l", "app.py:2", "--old"]
        )

        assert result.exit_code == 0, result.output
        [c] = db.get_comments(pr_uuid)
        assert c.line_type == "old"
        assert c.anchor_content == "two"

    def test_commit_scoped_comment_reads_that_commits_blob(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        first = _run_git(repo, ["rev-parse", "feature~1"])

        result = CliRunner().invoke(
            main, ["comment", pr_uuid, "note", "-l", "app.py:3", "--commit", first[:7]]
        )

        assert result.exit_code == 0, result.output
        [c] = db.get_comments(pr_uuid)
        assert c.commit_sha == first
        assert c.anchor_context_after == ""

    def test_commit_message_comment(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(
            main,
            ["comment", pr_uuid, "say why", "--commit-message", "feature", "--mode", "discuss"],
        )

        assert result.exit_code == 0, result.output
        [c] = db.get_comments(pr_uuid)
        assert c.target_type == "commit_message"
        assert c.commit_sha == _run_git(repo, ["rev-parse", "feature"])
        assert c.resolution_mode == CommentResolutionMode.DISCUSS

    @pytest.mark.parametrize(
        ("args", "error"),
        [
            (["-l", "app.py:9"], "no line 9"),
            (["-l", "app.py:2-9"], "no line 9"),
            (["-l", "base.txt:1"], "isn't changed"),
            (["-l", "app.py"], "FILE:LINE"),
            (["-l", "app.py:3-2"], "Invalid line range"),
            (["-l", "app.py:1", "--commit", "main"], "not one of this PR's commits"),
            (["--commit-message", "nope"], "not one of this PR's commits"),
            ([], "exactly one of"),
            (["-l", "app.py:1", "--commit-message", "feature"], "exactly one of"),
        ],
    )
    def test_rejects_bad_locations(
        self, temp_db: Path, repo: Path, args: list[str], error: str
    ) -> None:
        pr_uuid = self._create_pr(repo)

        result = CliRunner().invoke(main, ["comment", pr_uuid, "msg", *args])

        assert result.exit_code != 0
        assert error in result.output
        assert db.get_comments(pr_uuid) == []

    def test_comments_lists_the_agent_as_author(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        CliRunner().invoke(main, ["comment", pr_uuid, "Why shout?", "-l", "app.py:2"])
        db.add_comment(pr_uuid, "app.py", 1, "human note")

        result = CliRunner().invoke(main, ["comments", pr_uuid, "-f", "json"])

        by_text = {c["text"]: c for c in json.loads(result.output)["comments"]}
        assert by_text["Why shout?"]["author_kind"] == "agent"
        assert by_text["human note"]["author_kind"] == "human"

    def test_an_agent_comment_awaits_the_reviewer_not_claude(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)
        CliRunner().invoke(main, ["comment", pr_uuid, "Why shout?", "-l", "app.py:2"])
        human_uuid = db.add_comment(pr_uuid, "app.py", 1, "human note")

        unanswered = db.get_unanswered_pr_comments(str(repo))

        assert [c.uuid for _, c, _ in unanswered] == [human_uuid]


class TestOrphanedThreads:
    """`update` reporting threads it couldn't re-anchor, and `move` re-homing them."""

    @pytest.fixture
    def repo(self, tmp_path: Path) -> Path:
        """main, plus a feature branch that shouts line two of app.py."""
        repo_path = tmp_path / "repo"
        repo_path.mkdir()
        _run_git(repo_path, ["init", "-b", "main"])
        _run_git(repo_path, ["config", "user.email", "test@example.com"])
        _run_git(repo_path, ["config", "user.name", "Test User"])

        (repo_path / "app.py").write_text("one\ntwo\nthree\n")
        _run_git(repo_path, ["add", "app.py"])
        _run_git(repo_path, ["commit", "-m", "base commit"])

        _run_git(repo_path, ["checkout", "-b", "feature"])
        (repo_path / "app.py").write_text("one\nTWO\nthree\n")
        _run_git(repo_path, ["commit", "-am", "shout two"])
        return repo_path

    def _create_pr(self, repo: Path) -> str:
        return db.create_pr(
            repo_path=str(repo),
            title="PR",
            base_ref="main",
            head_ref="feature",
            base_commit=_run_git(repo, ["rev-parse", "main"]),
            head_commit=_run_git(repo, ["rev-parse", "feature"]),
            diff="d",
        )

    def _comment(self, pr_uuid: str, text: str, location: str) -> str:
        CliRunner().invoke(main, ["comment", pr_uuid, text, "-l", location])
        return next(c.uuid for c in db.get_comments(pr_uuid) if c.content == text)

    def _rewrite_away_line_two(self, repo: Path) -> None:
        (repo / "app.py").write_text("one\nthree\nfour\n")
        _run_git(repo, ["commit", "-q", "--amend", "-am", "drop two, add four"])

    def test_update_lists_open_threads_it_orphaned(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        open_uuid = self._comment(pr_uuid, "Why shout?", "app.py:2")
        resolved_uuid = self._comment(pr_uuid, "Settled already", "app.py:2")
        db.resolve_comment(resolved_uuid)
        self._rewrite_away_line_two(repo)

        result = CliRunner().invoke(main, ["update", pr_uuid])

        assert result.exit_code == 0, result.output
        assert "1 open comment thread(s) couldn't be re-anchored" in result.output
        assert open_uuid in result.output
        assert resolved_uuid not in result.output
        assert f"claude-reviewer move {pr_uuid}" in result.output

    def test_update_does_not_repeat_threads_orphaned_earlier(
        self, temp_db: Path, repo: Path
    ) -> None:
        pr_uuid = self._create_pr(repo)
        self._comment(pr_uuid, "Why shout?", "app.py:2")
        self._rewrite_away_line_two(repo)
        CliRunner().invoke(main, ["update", pr_uuid])
        _run_git(repo, ["commit", "-q", "--amend", "-m", "reworded"])

        result = CliRunner().invoke(main, ["update", pr_uuid])

        assert result.exit_code == 0, result.output
        assert "couldn't be re-anchored" not in result.output

    def test_comments_tags_an_orphaned_thread(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        self._comment(pr_uuid, "Why shout?", "app.py:2")
        self._rewrite_away_line_two(repo)
        CliRunner().invoke(main, ["update", pr_uuid])

        text = CliRunner().invoke(main, ["comments", pr_uuid]).output
        [as_json] = json.loads(
            CliRunner().invoke(main, ["comments", pr_uuid, "-f", "json"]).output
        )["comments"]

        assert "[orphaned]" in text
        assert as_json["status"] == "orphaned"

    def test_move_reanchors_an_orphaned_thread(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        comment_uuid = self._comment(pr_uuid, "Why shout?", "app.py:2")
        self._rewrite_away_line_two(repo)
        CliRunner().invoke(main, ["update", pr_uuid])

        result = CliRunner().invoke(main, ["move", pr_uuid, comment_uuid, "-l", "app.py:3"])

        assert result.exit_code == 0, result.output
        c = db.get_comment_by_uuid(comment_uuid)
        assert c is not None
        assert (c.file_path, c.line_number, c.end_line_number) == ("app.py", 3, 3)
        assert c.status == CommentRelocationStatus.ACTIVE
        assert (c.anchor_content, c.anchor_context_before) == ("four", "one\nthree")

    def test_move_rejects_a_commit_message_comment(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        CliRunner().invoke(main, ["comment", pr_uuid, "reword", "--commit-message", "feature"])
        [c] = db.get_comments(pr_uuid)

        result = CliRunner().invoke(main, ["move", pr_uuid, c.uuid, "-l", "app.py:2"])

        assert result.exit_code != 0
        assert "Only line comments" in result.output

    def test_move_rejects_another_prs_comment(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        other_uuid = self._create_pr(repo)
        comment_uuid = self._comment(other_uuid, "Why shout?", "app.py:2")

        result = CliRunner().invoke(main, ["move", pr_uuid, comment_uuid, "-l", "app.py:1"])

        assert result.exit_code != 0
        assert "not found on PR" in result.output

    def test_move_validates_the_new_location(self, temp_db: Path, repo: Path) -> None:
        pr_uuid = self._create_pr(repo)
        comment_uuid = self._comment(pr_uuid, "Why shout?", "app.py:2")

        result = CliRunner().invoke(main, ["move", pr_uuid, comment_uuid, "-l", "app.py:9"])

        assert result.exit_code != 0
        assert "no line 9" in result.output
        c = db.get_comment_by_uuid(comment_uuid)
        assert c is not None and c.line_number == 2


class TestGetDiffLineContext:
    DIFF = (
        "diff --git a/parse.py b/parse.py\n"
        "index 1111111..2222222 100644\n"
        "--- a/parse.py\n"
        "+++ b/parse.py\n"
        "@@ -1,3 +1,4 @@\n"
        " keep = 1\n"
        "---- removed row\n"
        "++++ added row\n"
        "+new file mode 100644\n"
        " tail = 2\n"
        "\\ No newline at end of file\n"
    )

    def test_counts_content_rows_that_look_like_header_lines(self) -> None:
        # The added row after "+++ added row" is new-side line 3, so "tail"
        # is new 4 / old 3; skipping header-looking rows would shift both.
        context = get_diff_line_context(self.DIFF, "parse.py", 4, "new")
        assert context is not None
        assert ">>>    3    4 |  tail = 2" in context
        assert "--- removed row" in context
        assert "+++ added row" in context
        assert "new file mode 100644" in context

    def test_old_side_line_inside_hunk(self) -> None:
        context = get_diff_line_context(self.DIFF, "parse.py", 2, "old")
        assert context is not None
        assert ">>>    2      | ---- removed row" in context

    def test_excludes_header_and_no_newline_marker(self) -> None:
        context = get_diff_line_context(self.DIFF, "parse.py", 1, "new")
        assert context is not None
        assert "index 1111111" not in context
        assert "No newline" not in context
