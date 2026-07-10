"""Tests for the cli module."""

from __future__ import annotations

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
    get_local_server_pid_file,
    main,
    print_comment,
    stop_local_server,
)
from claude_reviewer.models import Comment


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
        """--check never touches docker or npm, regardless of whether the UI is up."""
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
