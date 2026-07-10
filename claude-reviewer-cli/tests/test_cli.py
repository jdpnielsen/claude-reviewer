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
